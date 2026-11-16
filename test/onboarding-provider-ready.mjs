import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { after, before, describe, test } from 'node:test';
import { chromium, firefox } from 'playwright';

const read = async (build, file) => (await fs.readFile(new URL(`../src/${build}/${file}`, import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
const configured = (id = 'openrouter') => ({ active: id, providers: {
  ollama: { category: 'local', enabled: false, label: 'Ollama' },
  [id]: { configured: true, enabled: true, category: 'router', label: 'OpenRouter QA', model: 'openai/gpt-5.4-mini', apiKey: 'private-fixture-key-must-not-render' },
} });
const unconfigured = () => ({ active: 'openrouter', providers: {
  openrouter: { configured: false, enabled: true, category: 'router', label: 'Unconfigured provider' },
  ollama: { category: 'local', enabled: false, label: 'Ollama' },
} });

// Run the complete production onboarding IIFE, real sidepanel markup/styles,
// actual translations and provider icons. Only browser/background transport is
// an owned fixture; it deliberately supports delayed/out-of-order responses.
for (const [build, engine] of [['chrome', chromium], ['firefox', firefox]]) {
  describe(`${build}: configured-provider onboarding`, () => {
    let browser, wizard, html;
    before(async () => {
      browser = await engine.launch({ headless: true });
      const source = await read(build, 'src/ui/sidepanel.js');
      const start = source.indexOf('(async function initOnboarding() {');
      const end = source.indexOf('\n})();', start);
      assert.ok(start >= 0 && end > start, 'Use the entire actual wizard, including its listeners and async transitions.');
      wizard = source.slice(start, end + 6);
      html = (await read(build, 'src/ui/sidepanel.html')).replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
    });
    after(async () => { await browser?.close(); });

    async function fixture(run, options = {}) {
      const context = await browser.newContext({ viewport: { width: 420, height: 800 } });
      const errors = [];
      try {
        await context.route('**/*', async route => {
          const pathname = new URL(route.request().url()).pathname;
          if (pathname === '/wizard') return route.fulfill({ contentType: 'text/html', body: html });
          if (!pathname.startsWith(`/src/${build}/`) || pathname.includes('..')) return route.fulfill({ status: 404, body: '' });
          const relative = pathname.slice(`/src/${build}/`.length);
          try {
            const body = await fs.readFile(new URL(`../src/${build}/${relative}`, import.meta.url));
            return route.fulfill({ contentType: pathname.endsWith('.css') ? 'text/css' : 'text/javascript', body });
          } catch { return route.fulfill({ status: 404, body: '' }); }
        });
        await context.addInitScript(({ snapshot, stored, hold, models }) => {
          localStorage.setItem('wbLocale', 'en');
          const listeners = new Set(), calls = [], opened = [], writes = [], pending = [];
          let providers = snapshot;
          const storage = { wbLocale: 'en', helpImproveWebBrain: false, ...stored };
          const deferred = (type, value) => new Promise((resolve, reject) => pending.push({ type, value, resolve, reject }));
          const notify = (changes, area = 'local') => { for (const listener of [...listeners]) listener(changes, area); };
          const api = {
            storage: {
              local: {
                async get(keys) { return Object.fromEntries(Object.entries(storage).filter(([key]) => typeof keys === 'object' && !Array.isArray(keys) ? key in keys : [].concat(keys).includes(key))); },
                async set(values) {
                  if (values.onboardingComplete && hold.persist_onboarding) await deferred('persist_onboarding', values);
                  writes.push(structuredClone(values)); Object.assign(storage, values);
                  notify(Object.fromEntries(Object.entries(values).map(([key, newValue]) => [key, { newValue }])));
                },
              },
              onChanged: { addListener(fn) { listeners.add(fn); }, removeListener(fn) { listeners.delete(fn); } },
            },
            tabs: { create(value) { opened.push(value); } },
            runtime: { getURL(path) { return `https://owned-onboarding.invalid/${path}`; }, openOptionsPage() { opened.push({ options: true }); } },
          };
          window.chrome = window.browser = api;
          window.__fixture = {
            calls, opened, writes, pending, storage,
            snapshot: () => structuredClone(providers),
            hold,
            setProvider(value, emit = true) {
              providers = structuredClone(value);
              if (emit) notify({ activeProvider: { newValue: value.active }, providers: { newValue: value.providers } });
            },
            notify,
            release(type, value, index = 0, error = null) {
              const entry = pending.filter(item => item.type === type)[index];
              if (!entry) throw new Error(`No delayed ${type} at ${index}`);
              pending.splice(pending.indexOf(entry), 1);
              if (error) entry.reject(new Error(error)); else entry.resolve(value === undefined ? entry.value : value);
            },
            async send(type, params) {
              calls.push({ type, params });
              if (type === 'get_providers') {
                const value = structuredClone(providers);
                return hold[type] ? deferred(type, value) : value;
              }
              if (type === 'list_provider_models') {
                const value = { ok: true, models };
                return hold[type] ? deferred(type, value) : value;
              }
              if (type === 'set_help_improve_preference') {
                if (hold[type]) await deferred(type, {});
                storage.helpImproveWebBrain = params.enabled; return {};
              }
              if (type === 'update_provider') {
                Object.assign(providers.providers[params.providerId], params.config, { configured: true });
                notify({ providers: { newValue: structuredClone(providers.providers) }, activeProvider: { newValue: providers.active } });
                return {};
              }
              if (type === 'set_active_provider') {
                providers.active = params.providerId;
                notify({ providers: { newValue: structuredClone(providers.providers) }, activeProvider: { newValue: providers.active } });
                return {};
              }
              throw new Error(`Unexpected fixture transport ${type}`);
            },
          };
        }, { snapshot: options.snapshot || configured(), stored: options.stored || {}, hold: options.hold || {}, models: options.models || [] });
        const page = await context.newPage();
        page.setDefaultTimeout(2500);
        page.on('pageerror', error => errors.push(error.message));
        await page.goto('https://owned-onboarding.invalid/wizard');
        await page.addStyleTag({ content: await read(build, 'styles/sidepanel.css') });
        await page.addScriptTag({ type: 'module', content: `
          import {t, applyDOMTranslations} from '/src/${build}/src/ui/i18n.js';
          import {providerIconUrl} from '/src/${build}/src/ui/provider-icons.js';
          const pinCoachmarkDismissed = Promise.resolve();
          const inputEl = document.getElementById('user-input');
          const providerSelect = document.getElementById('provider-select');
          const sendToBackground = (type, params) => window.__fixture.send(type, params);
          const loadProviders = async () => {};
          const syncProviderPickerButton = () => {};
          const testConnection = async params => { window.__fixture.calls.push({type: 'test_connection', params}); };
          ${wizard}
        ` });
        if (!options.stored?.onboardingComplete) await page.locator('#onboarding:not(.hidden)').waitFor();
        const enter = async () => { await page.locator('#ob-next').click(); await page.locator('#ob-next').click(); };
        const waitCalls = async (type, count = 1) => page.waitForFunction(({ type, count }) => __fixture.calls.filter(c => c.type === type).length >= count, { type, count });
        const snapshot = async () => page.evaluate(() => ({ calls: __fixture.calls, opened: __fixture.opened, writes: __fixture.writes, storage: __fixture.storage, phase: document.querySelector('.ob-step.active')?.dataset.step, status: document.querySelector('#ob-provider-status').textContent, text: document.querySelector('#onboarding').textContent }));
        await run({ page, enter, waitCalls, snapshot });
        assert.deepEqual(errors, [], 'Actual wizard must not throw in the browser.');
      } finally { await context.close(); }
    }

    test('already selected configured OpenRouter starts directly without scanning, switching or exposing credentials', async () => {
      await fixture(async ({ page, enter, snapshot }) => {
        await enter();
        await page.waitForFunction(() => document.querySelector('#ob-open-settings').textContent === 'Start');
        const state = await snapshot();
        assert.match(state.status, /OpenRouter QA/); assert.match(state.status, /gpt-5\.4-mini/);
        assert.doesNotMatch(state.text, /private-fixture-key|Using WebBrain Compass|No local model/);
        assert.equal(state.calls.filter(c => c.type === 'list_provider_models').length, 0);
        assert.equal(await page.locator('#ob-help-improve').isVisible(), false);
        await page.locator('#ob-open-settings').click();
        await page.locator('#onboarding').waitFor({ state: 'hidden' });
        const finished = await snapshot();
        assert.equal(finished.storage.onboardingComplete, true); assert.equal(finished.storage.helpImproveWebBrain, false);
        assert.deepEqual(finished.opened, []);
        assert.equal(finished.calls.filter(c => ['set_active_provider', 'update_provider'].includes(c.type)).length, 0);
        assert.equal(await page.locator('#user-input').evaluate(el => el === document.activeElement), true);
      });
    });

    test('configured duplicate and local providers use their selected public metadata', async () => {
      for (const id of ['openrouter__duplicate', 'ollama']) {
        const state = configured(id); state.providers[id].category = id === 'ollama' ? 'local' : 'router';
        if (id === 'ollama') state.providers[id].model = '';
        await fixture(async ({ page, enter, snapshot }) => {
          await enter(); await page.waitForFunction(() => document.querySelector('#ob-open-settings').textContent === 'Start');
          assert.equal((await snapshot()).calls.filter(c => c.type === 'list_provider_models').length, 0);
          await page.locator('#ob-open-settings').click(); await page.locator('#onboarding').waitFor({ state: 'hidden' });
        }, { snapshot: state });
      }
    });

    test('a selected provider arriving during a local scan wins over stale models without changing phase or preference', async () => {
      await fixture(async ({ page, enter, waitCalls, snapshot }) => {
        await enter(); await waitCalls('list_provider_models');
        await page.evaluate(value => __fixture.setProvider(value), configured());
        await page.waitForFunction(() => document.querySelector('#ob-open-settings').textContent === 'Start');
        await page.evaluate(() => __fixture.release('list_provider_models', { ok: true, models: ['stale-local-model'] }));
        await page.waitForTimeout(30);
        const state = await snapshot(); assert.equal(state.phase, '2'); assert.match(state.status, /OpenRouter QA/);
        assert.equal(await page.locator('#ob-local-models').isVisible(), false);
        assert.equal(state.storage.helpImproveWebBrain, false); assert.deepEqual(state.opened, []);
      }, { snapshot: unconfigured(), hold: { list_provider_models: true } });
    });

    test('out-of-order provider reads cannot replace a newer selected provider', async () => {
      await fixture(async ({ page, enter, waitCalls, snapshot }) => {
        await enter(); await waitCalls('get_providers');
        await page.evaluate(value => __fixture.setProvider(value), configured());
        await waitCalls('get_providers', 2);
        await page.evaluate(() => __fixture.release('get_providers', undefined, 1));
        await page.waitForFunction(() => document.querySelector('#ob-open-settings').textContent === 'Start');
        await page.evaluate(() => __fixture.release('get_providers'));
        await page.waitForTimeout(30);
        assert.match((await snapshot()).status, /OpenRouter QA/);
        assert.equal((await snapshot()).calls.filter(c => c.type === 'list_provider_models').length, 0);
      }, { snapshot: unconfigured(), hold: { get_providers: true } });
    });

    test('going back cancels stale scans and reentering checks the current provider', async () => {
      await fixture(async ({ page, enter, waitCalls, snapshot }) => {
        await enter(); await waitCalls('list_provider_models'); await page.locator('#ob-back').click();
        await page.evaluate(value => __fixture.setProvider(value), configured());
        await page.evaluate(() => __fixture.release('list_provider_models', { ok: true, models: ['old'] }));
        assert.equal((await snapshot()).phase, '1');
        await page.locator('#ob-next').click();
        await page.waitForFunction(() => document.querySelector('#ob-open-settings').textContent === 'Start');
        assert.match((await snapshot()).status, /OpenRouter QA/);
      }, { snapshot: unconfigured(), hold: { list_provider_models: true } });
    });

    test('Start rechecks selection and cannot complete after the selected provider becomes unconfigured', async () => {
      await fixture(async ({ page, enter, snapshot }) => {
        await enter(); await page.waitForFunction(() => document.querySelector('#ob-open-settings').textContent === 'Start');
        await page.evaluate(value => __fixture.setProvider(value, false), unconfigured());
        await page.locator('#ob-open-settings').click();
        await page.waitForFunction(() => document.querySelector('#ob-open-settings').textContent === 'Open Settings');
        assert.equal(await page.locator('#onboarding').isVisible(), true);
        assert.equal((await snapshot()).storage.onboardingComplete, undefined);
        assert.deepEqual((await snapshot()).opened, []);
      });
    });

    test('disabled or unsaved active providers retain the real Providers route', async () => {
      for (const state of [unconfigured(), (() => { const s = configured(); s.providers.openrouter.enabled = false; return s; })()]) {
        await fixture(async ({ page, enter, snapshot }) => {
          await enter(); await page.waitForFunction(() => document.querySelector('#ob-open-settings').textContent === 'Open Settings');
          await page.locator('#ob-open-settings').click(); await page.locator('#onboarding').waitFor({ state: 'hidden' });
          assert.deepEqual((await snapshot()).opened, [{ url: 'https://owned-onboarding.invalid/src/ui/settings.html#llm' }]);
        }, { snapshot: state });
      }
    });

    test('Skip for now remains actionable when the local scan found no configured model', async () => {
      await fixture(async ({ page, enter, snapshot }) => {
        await enter(); await page.waitForFunction(() => document.querySelector('#ob-open-settings').textContent === 'Open Settings');
        assert.equal(await page.locator('#ob-skip').isEnabled(), true);
        await page.locator('#ob-skip').click(); await page.locator('#onboarding').waitFor({ state: 'hidden' });
        assert.equal((await snapshot()).storage.onboardingComplete, true);
        assert.deepEqual((await snapshot()).opened, []);
      }, { snapshot: unconfigured() });
    });

    test('detected local models retain explicit enable, select and connection-test behavior', async () => {
      await fixture(async ({ page, enter, snapshot }) => {
        await enter(); await page.waitForFunction(() => document.querySelector('#ob-open-settings').textContent === 'Use Local Model');
        await page.locator('.ob-local-model-option').nth(1).click();
        await page.locator('#ob-open-settings').click(); await page.locator('#onboarding').waitFor({ state: 'hidden' });
        const state = await snapshot();
        assert.deepEqual(state.calls.filter(c => ['update_provider', 'set_active_provider', 'test_connection'].includes(c.type)), [
          { type: 'update_provider', params: { providerId: 'ollama', config: { enabled: true, model: 'second-local-model' } } },
          { type: 'set_active_provider', params: { providerId: 'ollama' } },
          { type: 'test_connection', params: { providerId: 'ollama' } },
        ]);
        assert.equal(state.storage.onboardingComplete, true); assert.deepEqual(state.opened, []);
      }, { snapshot: unconfigured(), models: ['first-local-model', 'second-local-model'] });
    });

    test('local setup keeps the wizard and composer focus until completion persistence resolves', async () => {
      await fixture(async ({ page, enter, waitCalls, snapshot }) => {
        await enter(); await page.waitForFunction(() => document.querySelector('#ob-open-settings').textContent === 'Use Local Model');
        await page.locator('#ob-open-settings').click(); await waitCalls('test_connection');
        await page.waitForFunction(() => __fixture.pending.some(entry => entry.type === 'persist_onboarding'));
        assert.equal(await page.locator('#onboarding').isVisible(), true);
        assert.equal((await snapshot()).storage.onboardingComplete, undefined);
        assert.equal(await page.locator('#user-input').evaluate(el => el === document.activeElement), false, 'Composer focus must wait for the completion write.');
        await page.evaluate(() => __fixture.release('persist_onboarding'));
        await page.locator('#onboarding').waitFor({ state: 'hidden' });
        assert.equal((await snapshot()).storage.onboardingComplete, true);
        assert.equal(await page.locator('#user-input').evaluate(el => el === document.activeElement), true);
      }, { snapshot: unconfigured(), models: ['local-model'], hold: { persist_onboarding: true } });
    });

    test('Compass Start waits for explicit preference persistence and keeps that choice', async () => {
      const cloud = { active: 'webbrain_cloud', providers: { webbrain_cloud: { enabled: true, label: 'WebBrain Compass' } } };
      await fixture(async ({ page, enter, waitCalls, snapshot }) => {
        await enter(); await page.waitForFunction(() => document.querySelector('#ob-open-settings').textContent === 'Start');
        assert.equal(await page.locator('#ob-help-improve').isVisible(), true);
        await page.locator('#ob-help-improve-checkbox').check(); await waitCalls('set_help_improve_preference');
        await page.locator('#ob-open-settings').click();
        assert.equal(await page.locator('#onboarding').isVisible(), true);
        assert.equal((await snapshot()).storage.onboardingComplete, undefined);
        await page.evaluate(() => __fixture.release('set_help_improve_preference'));
        await page.locator('#onboarding').waitFor({ state: 'hidden' });
        assert.equal((await snapshot()).storage.helpImproveWebBrain, true);
        assert.equal((await snapshot()).storage.onboardingComplete, true);
        assert.deepEqual((await snapshot()).opened, []);
      }, { snapshot: cloud, hold: { set_help_improve_preference: true } });
    });

    test('Compass preference failure remains visible and does not dismiss or restore an old provider', async () => {
      const cloud = { active: 'webbrain_cloud', providers: { webbrain_cloud: { enabled: true, label: 'WebBrain Compass' } } };
      await fixture(async ({ page, enter, waitCalls, snapshot }) => {
        await enter(); await page.waitForFunction(() => document.querySelector('#ob-open-settings').textContent === 'Start');
        await page.locator('#ob-help-improve-checkbox').check(); await waitCalls('set_help_improve_preference');
        await page.evaluate(value => __fixture.setProvider(value), configured());
        await page.waitForFunction(() => document.querySelector('#ob-provider-status').textContent.includes('OpenRouter QA'));
        await page.locator('#ob-open-settings').click();
        assert.equal(await page.locator('#onboarding').isVisible(), true);
        await page.evaluate(() => __fixture.release('set_help_improve_preference', undefined, 0, 'Preference storage unavailable'));
        await page.waitForFunction(() => document.querySelector('#ob-provider-status').textContent.includes('Preference storage unavailable'));
        assert.equal((await snapshot()).storage.onboardingComplete, undefined);
        assert.equal((await snapshot()).storage.helpImproveWebBrain, false);
        assert.equal(await page.locator('#ob-help-improve-checkbox').isChecked(), false);
        assert.doesNotMatch((await snapshot()).text, /Using WebBrain Compass/);
      }, { snapshot: cloud, hold: { set_help_improve_preference: true } });
    });

    test('finishing unsubscribes provider changes and does not revive the wizard', async () => {
      await fixture(async ({ page, enter, snapshot }) => {
        await enter(); await page.waitForFunction(() => document.querySelector('#ob-open-settings').textContent === 'Start');
        await page.locator('#ob-skip').click(); await page.locator('#onboarding').waitFor({ state: 'hidden' });
        const reads = (await snapshot()).calls.filter(c => c.type === 'get_providers').length;
        await page.evaluate(value => __fixture.setProvider(value), unconfigured()); await page.waitForTimeout(30);
        assert.equal(await page.locator('#onboarding').isVisible(), false);
        assert.equal((await snapshot()).calls.filter(c => c.type === 'get_providers').length, reads);
        assert.equal((await snapshot()).writes.filter(w => w.onboardingComplete).length, 1);
      });
    });
  });
}
