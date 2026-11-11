// Settings is split across settings.html (General, Budgets, Memory, Skills,
// CAPTCHA, Bridge, Advanced), providers.html (LLM and the assistive models)
// and permissions.html. This drives all three pages in both builds with a
// stubbed extension API: tab layout, deep links from the old tabs, the
// cross-tab search, the single Record traces switch, the moved controls, the
// combined switches in General (settings-presets.js) with the Advanced
// controls they stand for, and the Providers page refresh after a profile
// sync on Settings.
import { chromium, firefox } from 'playwright';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import assert from 'node:assert/strict';

const root = resolve('.');
const mime = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.html': 'text/html', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.wasm': 'application/wasm' };
const server = createServer(async (req, res) => {
  try {
    const path = new URL(req.url, 'http://localhost').pathname;
    const file = resolve(root, '.' + decodeURIComponent(path));
    if (!file.startsWith(root + sep)) throw Error('outside root');
    res.setHeader('Content-Type', mime[extname(file)] || 'text/plain');
    res.end(await readFile(file));
  } catch { res.statusCode = 404; res.end(); }
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${server.address().port}`;

const SETTINGS_TABS = ['display', 'budgets', 'memory', 'skills', 'captcha', 'cloudbridge', 'advanced'];
const PROVIDER_TABS = ['llm', 'vision', 'speech', 'generative', 'decision', 'safesocial'];
const BUDGET_CONTROLS = [
  'input-cost-session-limit', 'input-cost-total-limit', 'range-clarify-timeout', 'select-clarify-timeout-policy',
  'range-max-steps', 'range-request-timeout',
];
// General's combined switches, and the Advanced controls for what they write.
const PRESET_SWITCHES = ['select-preset-supervision', 'select-preset-image', 'select-preset-alerts'];
const FINE_TUNE_CONTROLS = [
  'toggle-enforce-action-guards', 'toggle-strict-guards', 'select-lean-mode', 'select-plan-before-act-mode', 'select-plan-review-mode',
  'range-plan-review-confidence', 'select-vision-quality', 'select-auto-screenshot', 'select-image-detail', 'select-max-screenshots',
  'select-max-image-dimension', 'toggle-notify-sound', 'toggle-completion-confetti', 'toggle-completion-flash-tab',
];

function stub({ build, lang, seed }) {
  localStorage.setItem('wbLocale', lang);
  const key = 'settings-pages-store';
  const data = JSON.parse(sessionStorage.getItem(key) || 'null') || { wbLocale: lang, ...seed };
  const listeners = [];
  const save = () => sessionStorage.setItem(key, JSON.stringify(data));
  save();
  window.testStore = data;
  window.testRequests = [];
  const pick = keys => keys == null ? { ...data }
    : Object.fromEntries((Array.isArray(keys) ? keys : typeof keys === 'string' ? [keys] : Object.keys(keys))
      .map(k => [k, data[k] ?? (keys && typeof keys === 'object' && !Array.isArray(keys) ? keys[k] : undefined)]));
  const storage = {
    async get(keys) { return structuredClone(pick(keys)); },
    async set(values) {
      const changes = {};
      for (const [k, v] of Object.entries(values)) { changes[k] = { oldValue: data[k], newValue: v }; data[k] = structuredClone(v); }
      save();
      listeners.forEach(fn => fn(changes, 'local'));
    },
    async remove(keys) { for (const k of Array.isArray(keys) ? keys : [keys]) delete data[k]; save(); },
  };
  let managerPromise;
  const reply = async msg => {
    window.testRequests.push(msg);
    if (msg.action === 'get_providers') {
      managerPromise ||= import(`/src/${build}/src/providers/manager.js`).then(async ({ ProviderManager }) => {
        const manager = new ProviderManager();
        if (!data.providers) {
          const defaults = manager._defaultConfigs();
          data.providers = { llamacpp: { ...defaults.llamacpp, configured: true, model: 'qwen' } };
          data.activeProvider = 'llamacpp';
          save();
        }
        await manager.load();
        return manager;
      });
      const manager = await managerPromise;
      return { providers: manager.getAll(), active: manager.activeProviderId };
    }
    if (msg.action === 'get_user_memory') return { ok: true, enabled: true, records: [] };
    if (msg.action === 'get_webgpu_vision_choice') return { ok: true, choice: 'auto', bonsaiReady: false };
    if (msg.action === 'profile_sync_state') return window.testProfileSyncState || {};
    return {};
  };
  window.chrome = window.browser = {
    storage: { local: storage, onChanged: { addListener: fn => listeners.push(fn) } },
    runtime: {
      id: 'settings-pages-test',
      getURL: path => `${location.origin}/src/${build}/${path}`,
      getManifest: () => ({ version: '42.0.6' }),
      getPlatformInfo: async () => ({ os: 'test', arch: 'x64' }),
      onMessage: { addListener() {} },
      sendMessage(msg, callback) {
        const pending = reply(msg).catch(error => ({ error: error.message }));
        pending.then(result => callback?.(result));
        return pending;
      },
    },
    commands: { getAll: async () => [] },
    tabs: { create: async () => ({}) },
  };
}

async function open(browser, build, path, { lang = 'en', seed = {}, width = 1280 } = {}) {
  const page = await browser.newPage({ viewport: { width, height: 1000 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.setDefaultTimeout(10_000);
  await page.addInitScript(stub, { build, lang, seed });
  await page.goto(`${origin}/src/${build}/src/ui/${path}`);
  return { page, errors };
}

const tabsOf = page => page.locator('.tab-btn').evaluateAll(buttons => buttons.map(b => b.dataset.tab));
const activeTab = page => page.locator('.tab-btn.active').getAttribute('data-tab');
const store = (page, key) => page.evaluate(k => window.testStore[k], key);
const visible = (page, selector) => page.locator(selector).isVisible();
// Keys that resolved to nothing: i18n.js renders a missing key as the key itself.
const untranslated = page => page.evaluate(() => {
  const missing = [];
  for (const [attribute, read] of [
    ['i18n', el => el.textContent], ['i18nHtml', el => el.innerHTML], ['i18nTitle', el => el.title],
    ['i18nPlaceholder', el => el.placeholder], ['i18nAriaLabel', el => el.getAttribute('aria-label')],
  ]) {
    const selector = `[data-${attribute.replace(/[A-Z]/g, c => `-${c.toLowerCase()}`)}]`;
    for (const el of document.querySelectorAll(selector)) {
      if ((read(el) || '').trim() === el.dataset[attribute]) missing.push(el.dataset[attribute]);
    }
  }
  return missing;
});

try {
  for (const [build, engine] of [['chrome', chromium], ['firefox', firefox]]) {
    if (process.env.SETTINGS_PAGES_BROWSER && process.env.SETTINGS_PAGES_BROWSER !== build) continue;
    const browser = await engine.launch();
    try {
      // --- settings.html: tabs, moved controls, defaults ---
      for (const lang of ['en', 'tr', 'ar']) {
        const { page, errors } = await open(browser, build, 'settings.html', { lang });
        await page.waitForFunction(() => document.getElementById('select-auto-screenshot')?.value === 'navigation');
        assert.equal(await page.locator('#select-agent-indicator-style').inputValue(), 'random', `${build} ${lang}: activity effect defaults to random`);
        assert.deepEqual(await tabsOf(page), SETTINGS_TABS, `${build} ${lang}: settings tabs`);
        assert.equal(await activeTab(page), 'display', `${build} ${lang}: Settings opens on General`);
        for (const label of await page.locator('.tab-btn').allTextContents()) {
          assert.ok(label.trim() && !/^st\./.test(label.trim()), `${build} ${lang}: untranslated tab label ${label}`);
        }
        assert.equal(await page.locator('#select-language, #settings-ui-scale-value, #toggle-lossless-tracing, [data-tab="providers"], [data-tab="multimodal"], [data-tab="permissions"]').count(), 0,
          `${build} ${lang}: removed controls and tabs are gone`);
        assert.ok(await page.locator('#providers-page-link').getAttribute('href') === 'providers.html', `${build} ${lang}: header links to Providers`);
        assert.deepEqual(await untranslated(page), [], `${build} ${lang}: every settings.html string resolves`);
        assert.deepEqual(errors, [], `${build} ${lang}: settings.html page errors`);
        await page.close();
      }

      const { page, errors } = await open(browser, build, 'settings.html');
      await page.waitForFunction(() => document.getElementById('select-auto-screenshot')?.value === 'navigation');
      await page.locator('#select-agent-indicator-style').selectOption('gears');
      assert.equal(await store(page, 'agentIndicatorStyle'), 'gears', `${build}: a fixed effect is saved`);
      await page.reload();
      await page.waitForFunction(() => document.getElementById('select-agent-indicator-style')?.value === 'gears');
      await page.locator('#select-agent-indicator-style').selectOption('random');
      assert.equal(await store(page, 'agentIndicatorStyle'), 'random', `${build}: random can be restored`);
      assert.deepEqual(
        await page.locator('[data-panel="budgets"] [id]').evaluateAll((els, ids) => els.map(el => el.id).filter(id => ids.includes(id)), BUDGET_CONTROLS),
        BUDGET_CONTROLS, `${build}: Budgets holds the moved limits in order`);
      for (const id of ['toggle-tracing', 'toggle-screenshot-redaction', 'toggle-help-improve', 'toggle-strict-secret', ...FINE_TUNE_CONTROLS]) {
        assert.equal(await page.locator(`[data-panel="advanced"] #${id}`).count(), 1, `${build}: Advanced has #${id}`);
      }
      assert.equal(await page.locator('[data-panel="captcha"] #captcha-card').count(), 1, `${build}: CAPTCHA has its own tab`);
      assert.deepEqual(await page.locator('[data-panel="display"] select[id^="select-preset-"]').evaluateAll(els => els.map(el => el.id)),
        PRESET_SWITCHES, `${build}: General holds the combined switches`);
      assert.equal(await page.locator('#toggle-screenshot-fallback').count(), 0, `${build}: the dead Screenshot Fallback switch is gone`);
      assert.equal(await page.locator('details.advanced-settings > summary[data-i18n="st.display.advanced"]').count(), 0, `${build}: General has no Advanced drawer`);
      if (build === 'firefox') assert.equal(await page.locator('[data-panel="advanced"] #firefox-bidi-card').count(), 1, 'firefox: BiDi card stays in Advanced');

      // One switch records traces with full request details, or neither.
      await page.locator('[data-tab="advanced"]').click();
      const actionGuards = page.locator('#toggle-enforce-action-guards');
      assert.equal(await actionGuards.isChecked(), true);
      const leanBefore = await page.locator('#select-lean-mode').inputValue();
      await actionGuards.locator('..').click();
      assert.equal(await store(page, 'enforceActionGuards'), false);
      await page.reload();
      await page.waitForFunction(() => document.getElementById('toggle-enforce-action-guards')?.checked === false);
      assert.equal(await page.locator('#select-lean-mode').inputValue(), leanBefore);
      await page.locator('[data-tab="advanced"]').click();
      await actionGuards.locator('..').click();
      assert.equal(await store(page, 'enforceActionGuards'), true);
      await page.locator('#toggle-tracing').locator('..').click();
      assert.equal(await store(page, 'tracingEnabled'), true, `${build}: Record traces on`);
      assert.equal(await store(page, 'losslessTrace'), true, `${build}: full details follow Record traces`);
      await page.locator('#toggle-tracing').locator('..').click();
      assert.equal(await store(page, 'tracingEnabled'), false, `${build}: Record traces off`);
      assert.equal(await store(page, 'losslessTrace'), false, `${build}: full details off with Record traces`);
      await page.locator('#toggle-screenshot-redaction').locator('..').click();
      assert.equal(await store(page, 'screenshotRedaction'), true, `${build}: redaction toggle saves from Advanced`);

      // The combined switches in General write the settings they stand for
      // and follow those settings when something else changes them.
      const preset = group => page.locator(`#select-preset-${group}`).inputValue();
      await page.locator('[data-tab="display"]').click();
      assert.deepEqual([await preset('supervision'), await preset('image'), await preset('alerts')], ['balanced', 'balanced', 'all'],
        `${build}: untouched settings read as the default presets`);
      assert.equal(await store(page, 'leanMode'), undefined, `${build}: reading a preset writes nothing`);
      await page.locator('#select-preset-supervision').selectOption('fast');
      assert.equal(await store(page, 'leanMode'), 'on', `${build}: Fast turns lean mode on`);
      assert.equal(await store(page, 'planReviewMode'), 'never', `${build}: Fast runs plans without a review stop`);
      assert.equal(await store(page, 'enforceActionGuards'), true, `${build}: no preset turns action guards off`);
      assert.equal(await store(page, 'askBeforeConsequentialActions'), undefined, `${build}: no preset touches the permission gate`);
      assert.equal(await page.locator('#select-lean-mode').inputValue(), 'on', `${build}: the Advanced control follows the preset`);
      assert.equal(await page.locator('#range-plan-review-confidence').isDisabled(), true, `${build}: the threshold row follows the preset's review mode`);
      await page.locator('#select-preset-supervision').selectOption('thorough');
      assert.equal(await store(page, 'planBeforeActMode'), 'strict', `${build}: Thorough plans every turn`);
      assert.equal(await store(page, 'planBeforeAct'), true, `${build}: the planner's legacy key stays in step`);
      assert.equal(await store(page, 'strictGuards'), true, `${build}: Thorough turns strict checks on`);
      assert.equal(await page.locator('#toggle-strict-guards').isChecked(), true);
      // Fine-tuning one of those settings leaves no preset matching.
      await page.locator('[data-preset-group="supervision"] .preset-fine-tune').click();
      assert.equal(await activeTab(page), 'advanced', `${build}: Fine-tune opens Advanced`);
      assert.equal(await page.evaluate(() => document.activeElement?.id), 'adv-group-supervision', `${build}: Fine-tune lands on the group`);
      await page.locator('#select-lean-mode').selectOption('auto');
      assert.equal(await preset('supervision'), 'custom', `${build}: a fine-tuned group reads as Custom`);
      await page.locator('[data-tab="display"]').click();
      assert.ok(await visible(page, '#preset-supervision-note'), `${build}: Custom explains itself`);
      await page.reload();
      await page.waitForFunction(() => document.getElementById('select-preset-supervision')?.value === 'custom')
        .catch(() => assert.fail(`${build}: Custom survives a reload`));
      await page.locator('#select-preset-supervision').selectOption('balanced');
      assert.equal(await store(page, 'leanMode'), 'auto');
      assert.equal(await store(page, 'strictGuards'), false);
      assert.equal(await visible(page, '#preset-supervision-note'), false, `${build}: picking a preset clears the Custom note`);
      // Guards turned off elsewhere are called out, and a preset turns them back on.
      await page.evaluate(() => chrome.storage.local.set({ enforceActionGuards: false }));
      assert.equal(await preset('supervision'), 'custom');
      assert.equal(await page.locator('#preset-supervision-note').getAttribute('data-tone'), 'warning', `${build}: guards off is flagged on the switch`);
      assert.equal(await page.locator('#toggle-enforce-action-guards').isChecked(), false, `${build}: a storage change reaches the Advanced control`);
      await page.locator('#select-preset-supervision').selectOption('balanced');
      assert.equal(await store(page, 'enforceActionGuards'), true, `${build}: a preset turns guards back on`);
      await page.locator('#select-preset-image').selectOption('sharp');
      assert.deepEqual([await store(page, 'visionQuality'), await store(page, 'imageDetail'), await store(page, 'maxImageDimension'), await store(page, 'autoScreenshot')],
        ['sharp', 'high', 2048, 'state_change'], `${build}: Sharp raises every image setting`);
      assert.equal(await page.locator('#select-max-image-dimension').inputValue(), '2048');
      await page.locator('#select-preset-image').selectOption('balanced');
      assert.equal(await store(page, 'maxImageDimension'), 1568);
      await page.locator('#select-preset-alerts').selectOption('quiet');
      assert.deepEqual([await store(page, 'notifySound'), await store(page, 'completionConfetti'), await store(page, 'completionFlashTab')],
        [false, false, true], `${build}: Quiet only flashes the tab`);
      assert.equal(await page.locator('#toggle-notify-sound').isChecked(), false);
      await page.locator('#select-preset-alerts').selectOption('all');
      // A row that only matters while its parent switch is on is greyed out with it.
      await page.locator('[data-tab="advanced"]').click();
      assert.equal(await page.locator('#toggle-scheduled-confirm').isDisabled(), false);
      await page.locator('#toggle-scheduled-tasks').locator('..').click();
      assert.equal(await page.locator('#toggle-scheduled-confirm').isDisabled(), true, `${build}: scheduled confirmation needs scheduled tasks`);
      await page.locator('#toggle-scheduled-tasks').locator('..').click();
      assert.equal(await page.locator('#toggle-scheduled-confirm').isDisabled(), false);

      // The search covers General, Budgets, CAPTCHA and Advanced at once.
      await page.locator('[data-tab="display"]').click();
      await page.locator('#input-general-search').fill('timeout');
      assert.ok(await page.evaluate(() => document.body.classList.contains('settings-searching')), `${build}: search mode`);
      for (const id of ['range-clarify-timeout', 'select-clarify-timeout-policy', 'range-request-timeout']) {
        assert.ok(await visible(page, `#${id}`), `${build}: search shows #${id} from Budgets`);
      }
      assert.equal(await visible(page, '#select-theme'), false, `${build}: search hides non-matching General rows`);
      assert.equal(await visible(page, '[data-panel="memory"]'), false, `${build}: search leaves Memory out`);
      assert.ok(await visible(page, '[data-panel="budgets"] .search-panel-heading'), `${build}: matches sit under their tab name`);
      // The results span tabs, so no tab is marked as the current one. The
      // tab background fades (a 0.15 s transition), so wait for it to settle.
      await page.waitForFunction(() => getComputedStyle(document.querySelector('.tab-btn.active')).backgroundColor === 'rgba(0, 0, 0, 0)')
        .catch(() => assert.fail(`${build}: no tab looks current during a search`));
      // A tab name opens that tab and ends the search.
      await page.locator('[data-panel="budgets"] [data-search-tab="budgets"]').click();
      assert.equal(await page.locator('#input-general-search').inputValue(), '', `${build}: a tab name ends the search`);
      assert.equal(await activeTab(page), 'budgets', `${build}: a tab name opens its tab`);
      assert.equal(await page.evaluate(() => document.activeElement?.dataset?.tab), 'budgets', `${build}: focus moves to that tab`);
      await page.waitForFunction(() => getComputedStyle(document.querySelector('.tab-btn.active')).backgroundColor !== 'rgba(0, 0, 0, 0)')
        .catch(() => assert.fail(`${build}: the picked tab is marked current again`));
      await page.locator('#input-general-search').fill('redact');
      assert.ok(await visible(page, '#screenshot-redaction-setting'), `${build}: search finds Advanced settings`);
      assert.equal(await visible(page, '[data-panel="budgets"]'), false, `${build}: a tab without matches is hidden`);
      await page.locator('#input-general-search').fill('zzzz-no-such-setting');
      assert.ok(await visible(page, '#general-search-empty'), `${build}: empty search result notice`);
      await page.locator('[data-tab="memory"]').click();
      assert.equal(await page.locator('#input-general-search').inputValue(), '', `${build}: picking a tab ends the search`);
      assert.equal(await page.evaluate(() => document.body.classList.contains('settings-searching')), false, `${build}: search mode ends`);
      assert.equal(await activeTab(page), 'memory');
      assert.equal(await visible(page, '#settings-search'), false, `${build}: no search box on Memory`);
      await page.locator('[data-tab="captcha"]').click();
      assert.ok(await visible(page, '#settings-search'), `${build}: search box on CAPTCHA`);

      // The language is picked in the side panel; an open Settings page follows it.
      await page.evaluate(() => chrome.storage.local.set({ wbLocale: 'tr' }));
      await page.waitForFunction(() => document.querySelector('[data-tab="budgets"]').textContent === 'Bütçeler');
      assert.match(await page.locator('#subtitle').textContent(), /WebBrain/, `${build}: subtitle re-rendered`);
      assert.deepEqual(await untranslated(page), [], `${build}: every string resolves after a language change`);
      await page.evaluate(() => chrome.storage.local.set({ wbLocale: 'en' }));
      await page.waitForFunction(() => document.querySelector('[data-tab="budgets"]').textContent === 'Budgets');
      assert.deepEqual(errors, [], `${build}: settings.html interaction errors`);
      await page.close();

      // An upgrade changes nothing: settings from before the switches existed
      // are read as they are and never rewritten.
      const { page: upgraded, errors: upgradeErrors } = await open(browser, build, 'settings.html', {
        seed: { leanMode: 'off', planBeforeAct: false, notifySound: false, completionConfetti: false },
      });
      await upgraded.waitForFunction(() => document.documentElement.dataset.settingsReady === 'true');
      assert.equal(await upgraded.locator('#select-preset-supervision').inputValue(), 'custom', `${build}: settings no preset matches read as Custom`);
      assert.equal(await upgraded.locator('#select-preset-alerts').inputValue(), 'quiet', `${build}: settings that add up to a preset show it`);
      assert.equal(await upgraded.locator('#select-preset-image').inputValue(), 'balanced');
      assert.equal(await upgraded.locator('#select-plan-before-act-mode').inputValue(), 'off', `${build}: the planner's legacy key still reads as Off`);
      for (const key of ['planBeforeActMode', 'planReviewMode', 'strictGuards', 'enforceActionGuards', 'completionFlashTab', 'visionQuality', 'imageDetail']) {
        assert.equal(await store(upgraded, key), undefined, `${build}: opening Settings does not write ${key}`);
      }
      // Memory: auto-learn needs user memory, and learning from forms needs both.
      await upgraded.locator('[data-tab="memory"]').click();
      assert.equal(await upgraded.locator('#toggle-user-memory-auto').isDisabled(), false, `${build}: auto-learn is available while user memory is on`);
      assert.equal(await upgraded.locator('#toggle-user-memory-form').isDisabled(), true, `${build}: learning from forms needs auto-learn`);
      await upgraded.locator('#toggle-user-memory-auto').locator('..').click();
      assert.equal(await upgraded.locator('#toggle-user-memory-form').isDisabled(), false);
      await upgraded.locator('#toggle-user-memory-enabled').locator('..').click();
      assert.equal(await upgraded.locator('#toggle-user-memory-auto').isDisabled(), true, `${build}: auto-learn needs user memory`);
      assert.equal(await upgraded.locator('#input-user-memory-max-chars').isDisabled(), true, `${build}: the prompt size needs user memory`);
      assert.deepEqual(upgradeErrors, [], `${build}: upgraded settings errors`);
      await upgraded.close();

      // Skills: the enabled and available lists come first; the add form
      // opens from Add skill or Edit and closes after a save or Cancel.
      const customSkills = [{ id: 'skill_owned_1', name: 'Owned triage style', sourceType: 'text', content: '# Triage\nLabel issues.', createdAt: 1 }];
      const { page: skills, errors: skillErrors } = await open(browser, build, 'settings.html#skills', { seed: { customSkills } });
      await skills.locator('#skills-list button[data-skill-edit-id="skill_owned_1"]').waitFor();
      assert.deepEqual(await skills.locator('[data-panel="skills"] > .provider-card').evaluateAll(cards => cards.map(card => card.id)),
        ['skills-card', 'skills-list-card', 'packaged-skills-card'], `${build}: enabled skills, then available ones`);
      assert.equal(await visible(skills, '#skill-add-form'), false, `${build}: the add form starts closed`);
      await skills.locator('#btn-show-skill-form').click();
      assert.ok(await visible(skills, '#skill-add-form'), `${build}: Add skill opens the form`);
      assert.equal(await visible(skills, '#btn-show-skill-form'), false, `${build}: Add skill hides while the form is open`);
      assert.equal(await skills.evaluate(() => document.activeElement?.id), 'skill-name', `${build}: the form takes focus`);
      await skills.locator('#skill-name').fill('Draft name');
      await skills.locator('#btn-cancel-skill-form').click();
      assert.equal(await visible(skills, '#skill-add-form'), false, `${build}: Cancel closes the form`);
      assert.equal(await skills.evaluate(() => document.activeElement?.id), 'btn-show-skill-form', `${build}: focus returns to Add skill`);
      assert.equal(await skills.locator('#skill-name').inputValue(), '', `${build}: Cancel discards the draft`);
      await skills.locator('#skills-list button[data-skill-edit-id="skill_owned_1"]').click();
      assert.ok(await visible(skills, '#skill-add-form'), `${build}: Edit opens the form`);
      assert.equal(await skills.locator('#skill-name').inputValue(), 'Owned triage style', `${build}: Edit loads the skill`);
      await skills.locator('#skill-text').fill('# Triage\nLabel issues by area.');
      await skills.locator('#btn-add-skill-text').click();
      await skills.waitForFunction(() => window.testStore.customSkills?.[0]?.content === '# Triage\nLabel issues by area.');
      assert.equal(await visible(skills, '#skill-add-form'), false, `${build}: saving closes the form`);
      assert.ok(await visible(skills, '#skills-result'), `${build}: the result shows with the form closed`);
      await skills.locator('#packaged-skills-list button[data-packaged-skill-id]').first().click();
      await skills.waitForFunction(() => window.testStore.customSkills?.length === 2);
      assert.ok(await visible(skills, '#skills-result'), `${build}: enabling a packaged skill is confirmed with the form closed`);
      // Cancel stops a URL import still in flight: it adds no skill and
      // leaves a draft started afterwards alone.
      let releaseImport;
      const importHeld = new Promise(resolve => { releaseImport = resolve; });
      await skills.route('https://skills.example/slow.md', async route => {
        await importHeld;
        await route.fulfill({ status: 200, contentType: 'text/markdown', body: '# Slow skill\nDo the slow thing.' }).catch(() => {});
      });
      const skillCount = await skills.evaluate(() => window.testStore.customSkills.length);
      await skills.locator('#btn-show-skill-form').click();
      await skills.locator('#skill-name').fill('Slow import');
      await skills.locator('#skill-url').fill('https://skills.example/slow.md');
      await skills.locator('#btn-add-skill-url').click();
      await skills.waitForFunction(() => document.getElementById('btn-add-skill-url').disabled);
      await skills.locator('#btn-cancel-skill-form').click();
      assert.equal(await skills.locator('#btn-add-skill-url').isDisabled(), false, `${build}: Cancel resets the import button`);
      await skills.locator('#btn-show-skill-form').click();
      await skills.locator('#skill-name').fill('New draft');
      releaseImport();
      await skills.waitForTimeout(300);
      assert.equal(await skills.evaluate(() => window.testStore.customSkills.length), skillCount, `${build}: a cancelled import adds no skill`);
      assert.equal(await skills.locator('#skill-name').inputValue(), 'New draft', `${build}: a cancelled import leaves the new draft alone`);
      assert.ok(await visible(skills, '#skill-add-form'), `${build}: a cancelled import does not close the reopened form`);
      assert.deepEqual(skillErrors, [], `${build}: skills tab errors`);
      await skills.close();

      // Old Settings deep links land where those tabs live now.
      for (const [hash, target, tab] of [['providers', 'providers.html#llm', 'llm'], ['multimodal', 'providers.html#vision', 'vision'], ['permissions', 'permissions.html', null]]) {
        const { page: redirected, errors: redirectErrors } = await open(browser, build, `settings.html#${hash}`);
        await redirected.waitForURL(url => String(url).endsWith(`/src/${build}/src/ui/${target}`));
        if (tab) await redirected.waitForFunction(name => document.querySelector('.tab-btn.active')?.dataset.tab === name, tab);
        else await redirected.locator('#permissions-card').waitFor();
        assert.deepEqual(redirectErrors, [], `${build}: #${hash} redirect errors`);
        await redirected.close();
      }

      // --- providers.html ---
      const { page: providers, errors: providerErrors } = await open(browser, build, 'providers.html');
      await providers.locator('.provider-card[data-provider-id="llamacpp"]').first().waitFor();
      assert.deepEqual(await tabsOf(providers), PROVIDER_TABS, `${build}: provider tabs`);
      assert.equal(await activeTab(providers), 'llm', `${build}: Providers opens on LLM`);
      for (const [tab, card] of [['vision', '#vision-card'], ['speech', '#transcription-card'], ['generative', '#image-gen-card'], ['decision', '#system-one-card'], ['safesocial', '#safesocial-card']]) {
        assert.equal(await providers.locator(`[data-panel="${tab}"] ${card}`).count(), 1, `${build}: ${tab} tab holds ${card}`);
      }
      assert.equal(await providers.locator('#image-budget-card, #toggle-screenshot-redaction').count(), 0, `${build}: image budget and redaction left Vision`);
      assert.equal(await providers.locator('[data-panel="vision"] #webgpu-vision-choice').count(), build === 'chrome' ? 1 : 0, `${build}: in-browser vision only in Chrome`);
      assert.equal(await providers.locator('#settings-page-link').getAttribute('href'), 'settings.html', `${build}: header links back to Settings`);
      assert.deepEqual(await untranslated(providers), [], `${build}: every providers.html string resolves`);
      await providers.locator('[data-tab="decision"]').click();
      assert.ok(await visible(providers, '#decision-mode'), `${build}: decision modes on the Decision tab`);
      assert.deepEqual(providerErrors, [], `${build}: providers.html page errors`);
      await providers.close();

      // A profile sync on Settings refreshes a Providers page open in another
      // tab, so a Save there cannot write stale values over what was pulled.
      const context = await browser.newContext({ viewport: { width: 1280, height: 1000 } });
      try {
        await context.addInitScript(stub, { build, lang: 'en', seed: {} });
        await context.addInitScript(() => { window.testProfileSyncState = { authenticated: true, enabled: true, unlocked: true, status: 'ready' }; });
        const syncErrors = [];
        const synced = await context.newPage();
        synced.on('pageerror', error => syncErrors.push(error.message));
        await synced.goto(`${origin}/src/${build}/src/ui/providers.html#vision`);
        await synced.waitForFunction(() => document.documentElement.dataset.settingsReady === 'true');
        assert.equal(await synced.locator('#vision-model').inputValue(), '', `${build}: no vision model before the sync`);
        // Stands in for what the sync writes to storage.
        await synced.evaluate(() => { window.testStore.visionModel = { baseUrl: 'https://vision.example/v1', apiKey: 'sk-test-synced', model: 'synced-vision' }; });
        const loads = () => synced.evaluate(() => window.testRequests.filter(msg => msg.action === 'get_providers').length);
        const loadsBefore = await loads();
        const syncing = await context.newPage();
        syncing.on('pageerror', error => syncErrors.push(error.message));
        await syncing.goto(`${origin}/src/${build}/src/ui/settings.html#memory`);
        await syncing.waitForFunction(() => document.documentElement.dataset.settingsReady === 'true');
        await syncing.locator('#btn-profile-sync-now').click();
        await synced.waitForFunction(() => document.getElementById('vision-model').value === 'synced-vision');
        assert.ok(await loads() > loadsBefore, `${build}: the Providers page reloads its providers after a sync`);
        assert.deepEqual(syncErrors, [], `${build}: profile sync refresh errors`);
      } finally {
        await context.close();
      }

      const { page: aliased, errors: aliasErrors } = await open(browser, build, 'providers.html#multimodal');
      await aliased.waitForFunction(() => document.querySelector('.tab-btn.active')?.dataset.tab === 'vision');
      assert.deepEqual(aliasErrors, [], `${build}: providers.html alias errors`);
      await aliased.close();

      // --- permissions.html ---
      const grant = { host: 'example.com', capability: 'click', action: 'allow' };
      const { page: permissions, errors: permissionErrors } = await open(browser, build, 'permissions.html', { seed: { wb_permissions: [grant] } });
      await permissions.locator('#permissions-list button[data-host="example.com"]').waitFor();
      await permissions.locator('#toggle-permission-gate').locator('..').click();
      assert.equal(await store(permissions, 'askBeforeConsequentialActions'), false, `${build}: master switch saves`);
      assert.ok(await visible(permissions, '#permission-gate-warning'), `${build}: master switch warning`);
      await permissions.locator('#permissions-list button[data-host="example.com"]').click();
      await permissions.waitForFunction(() => window.testStore.wb_permissions.length === 0);
      assert.equal(await permissions.locator('#settings-page-link').getAttribute('href'), 'settings.html', `${build}: permissions links back to Settings`);
      assert.deepEqual(await untranslated(permissions), [], `${build}: every permissions.html string resolves`);
      assert.deepEqual(permissionErrors, [], `${build}: permissions.html page errors`);
      await permissions.close();
      console.log(`PASS ${build}: settings, providers and permissions pages`);
    } finally {
      await browser.close();
    }
  }
} finally {
  server.close();
}
