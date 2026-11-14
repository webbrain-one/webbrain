// Settings is one page, settings.html, with a sidebar of sections: General,
// the models (LLM and the assistive models), Permissions & privacy, Budgets,
// Memory, Skills, the integrations (CAPTCHA, Bridge), Offline and Advanced.
// providers.html and permissions.html only forward old links into it. This
// drives the page in both builds with a stubbed extension API: the sections,
// deep links from the old tabs and pages, the search across every section,
// the single Record traces switch, the moved controls, the combined switches
// in General (settings-presets.js) with the Advanced controls they stand for,
// the provider refresh after a profile sync in another Settings tab, the
// Permissions & privacy switches while the other sections are still loading,
// and an unsaved Vision endpoint surviving a refocus (Chrome).
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

const SETTINGS_TABS = [
  'display', 'llm', 'vision', 'speech', 'generative', 'decision', 'safesocial', 'permissions',
  'budgets', 'memory', 'skills', 'captcha', 'cloudbridge', 'offline', 'advanced',
];
// The sections that came over from the Providers page, and their main cards.
const MODEL_CARDS = [['vision', '#vision-card'], ['speech', '#transcription-card'], ['generative', '#image-gen-card'], ['decision', '#system-one-card'], ['safesocial', '#safesocial-card']];
// Privacy switches that moved from Advanced to Permissions & privacy.
const PRIVACY_CONTROLS = ['toggle-screenshot-redaction', 'toggle-strict-secret', 'toggle-allow-local-network'];
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
  // window.testHold (see holdUntilReleased) can keep a reply or a read
  // waiting, as a slow background would. A held read still returns what
  // storage held when it was made.
  const hold = (kind, what) => window.testHold?.(kind, what);
  const storage = {
    async get(keys) { const result = structuredClone(pick(keys)); await hold('get', keys); return result; },
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
    await hold('message', msg);
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
    if (msg.action === 'apocalypse_mode') {
      if (msg.command === 'enable') { data.testApocalypseEnabled = msg.enabled === true; save(); }
      return { enabled: data.testApocalypseEnabled === true, archives: [], installedCount: 0, totalBytes: 0, storage: { usage: 0 } };
    }
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

// Keeps the background reply to `action`, or the storage read of the single
// key `key`, waiting until window.testRelease() is called.
function holdUntilReleased({ action, key }) {
  const waiting = [];
  window.testHeld = 0;
  window.testRelease = () => { window.testHold = null; waiting.splice(0).forEach(resolve => resolve()); };
  window.testHold = (kind, what) => ((kind === 'message' && what.action === action) || (kind === 'get' && what === key))
    ? new Promise(resolve => { window.testHeld += 1; waiting.push(resolve); })
    : null;
}

async function open(browser, build, path, { lang = 'en', seed = {}, width = 1280, hold = null } = {}) {
  const page = await browser.newPage({ viewport: { width, height: 1000 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.setDefaultTimeout(10_000);
  await page.addInitScript(stub, { build, lang, seed });
  if (hold) await page.addInitScript(holdUntilReleased, hold);
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
        assert.equal(await page.locator('#select-language, #settings-ui-scale-value, #toggle-lossless-tracing, #toggle-screenshot-fallback, [data-tab="providers"], [data-tab="multimodal"], #providers-page-link, #settings-page-link').count(), 0,
          `${build} ${lang}: removed controls, tabs and page links are gone`);
        assert.ok((await page.locator('.settings-nav .tab-group-label').allTextContents()).every(text => text.trim() && !/^st\./.test(text.trim())),
          `${build} ${lang}: sidebar group labels are translated`);
        assert.equal(await page.locator('.tab-btn[aria-current="page"]').getAttribute('data-tab'), 'display', `${build} ${lang}: the current section is marked`);
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
      for (const id of ['toggle-tracing', 'toggle-help-improve', ...FINE_TUNE_CONTROLS]) {
        assert.equal(await page.locator(`[data-panel="advanced"] #${id}`).count(), 1, `${build}: Advanced has #${id}`);
      }
      for (const id of ['permissions-card', 'toggle-permission-gate', ...PRIVACY_CONTROLS]) {
        assert.equal(await page.locator(`[data-panel="permissions"] #${id}`).count(), 1, `${build}: Permissions & privacy has #${id}`);
      }
      for (const [tab, card] of MODEL_CARDS) {
        assert.equal(await page.locator(`[data-panel="${tab}"] ${card}`).count(), 1, `${build}: the ${tab} section holds ${card}`);
      }
      assert.equal(await page.locator('[data-panel="llm"] #providers').count(), 1, `${build}: the LLM section holds the provider list`);
      assert.equal(await page.locator('[data-panel="vision"] #webgpu-vision-choice').count(), build === 'chrome' ? 1 : 0, `${build}: in-browser vision only in Chrome`);
      assert.equal(await page.locator('[data-panel="advanced"] #image-budget-card').count(), 1, `${build}: the image budget is in Advanced`);
      assert.equal(await page.locator('[data-panel="offline"] #apocalypse-mode-link').getAttribute('href'), 'apocalypse-mode.html', `${build}: Offline opens Apocalypse Mode`);
      assert.equal(await page.locator('[data-panel="captcha"] #captcha-card').count(), 1, `${build}: CAPTCHA has its own section`);
      assert.deepEqual(await page.locator('[data-panel="display"] select[id^="select-preset-"]').evaluateAll(els => els.map(el => el.id)),
        PRESET_SWITCHES, `${build}: General holds the combined switches`);
      assert.equal(await page.locator('#toggle-screenshot-fallback').count(), 0, `${build}: the dead Screenshot Fallback switch is gone`);
      assert.equal(await page.locator('details.advanced-settings > summary[data-i18n="st.display.advanced"]').count(), 0, `${build}: General has no Advanced drawer`);
      if (build === 'firefox') assert.equal(await page.locator('[data-panel="cloudbridge"] #firefox-bidi-card').count(), 1, 'firefox: the BiDi card is with Bridge');

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
      await page.locator('[data-tab="permissions"]').click();
      assert.equal(await page.locator('.tab-btn[aria-current="page"]').getAttribute('data-tab'), 'permissions', `${build}: picking a section marks it current`);
      await page.locator('#toggle-screenshot-redaction').locator('..').click();
      assert.equal(await store(page, 'screenshotRedaction'), true, `${build}: redaction toggle saves from Permissions & privacy`);

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
      assert.equal(await store(page, 'enforceActionGuards'), true, `${build}: Fast keeps action guards on`);
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
      // Unsupervised is Fast with action guards off.
      await page.locator('#select-preset-supervision').selectOption('unsupervised');
      assert.equal(await store(page, 'enforceActionGuards'), false, `${build}: Unsupervised turns action guards off`);
      assert.equal(await store(page, 'leanMode'), 'on', `${build}: Unsupervised keeps Fast's lean mode`);
      assert.equal(await store(page, 'planReviewMode'), 'never', `${build}: Unsupervised keeps Fast's plan review`);
      assert.equal(await page.locator('#toggle-enforce-action-guards').isChecked(), false, `${build}: the Advanced control follows Unsupervised`);
      assert.equal(await page.locator('#preset-supervision-note').getAttribute('data-tone'), 'warning', `${build}: Unsupervised flags guards off`);
      await page.locator('#select-preset-supervision').selectOption('balanced');
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

      // The search covers every section at once.
      await page.locator('[data-tab="display"]').click();
      await page.locator('#input-general-search').fill('timeout');
      assert.ok(await page.evaluate(() => document.body.classList.contains('settings-searching')), `${build}: search mode`);
      for (const id of ['range-clarify-timeout', 'select-clarify-timeout-policy', 'range-request-timeout']) {
        assert.ok(await visible(page, `#${id}`), `${build}: search shows #${id} from Budgets`);
      }
      assert.equal(await visible(page, '#select-theme'), false, `${build}: search hides non-matching General rows`);
      assert.equal(await visible(page, '[data-panel="memory"]'), false, `${build}: search hides a section without matches`);
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
      assert.ok(await visible(page, '#screenshot-redaction-setting'), `${build}: search finds Permissions & privacy settings`);
      await page.locator('#input-general-search').fill('transcription');
      assert.ok(await visible(page, '#transcription-card'), `${build}: search finds the model sections`);
      assert.equal(await visible(page, '[data-panel="budgets"]'), false, `${build}: a tab without matches is hidden`);
      await page.locator('#input-general-search').fill('zzzz-no-such-setting');
      assert.ok(await visible(page, '#general-search-empty'), `${build}: empty search result notice`);
      await page.locator('[data-tab="memory"]').click();
      assert.equal(await page.locator('#input-general-search').inputValue(), '', `${build}: picking a tab ends the search`);
      assert.equal(await page.evaluate(() => document.body.classList.contains('settings-searching')), false, `${build}: search mode ends`);
      assert.equal(await activeTab(page), 'memory');
      assert.ok(await visible(page, '#settings-search'), `${build}: the search box stays in every section`);

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
      assert.deepEqual(await skills.locator('[data-panel="skills"] > [data-search-scope] > .provider-card').evaluateAll(cards => cards.map(card => card.id)),
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

      // Old Settings deep links name sections of this page now.
      for (const [hash, tab] of [['providers', 'llm'], ['multimodal', 'vision'], ['vision', 'vision'], ['permissions', 'permissions'], ['apocalypse', 'offline']]) {
        const { page: linked, errors: linkErrors } = await open(browser, build, `settings.html#${hash}`);
        await linked.waitForFunction(name => document.querySelector('.tab-btn.active')?.dataset.tab === name, tab)
          .catch(() => assert.fail(`${build}: settings.html#${hash} opens ${tab}`));
        assert.ok(linked.url().endsWith(`/src/${build}/src/ui/settings.html#${hash}`), `${build}: settings.html#${hash} stays on Settings`);
        assert.deepEqual(linkErrors, [], `${build}: #${hash} deep link errors`);
        await linked.close();
      }

      // The old Providers and Permissions pages forward into Settings, with
      // their #section.
      for (const [path, target, tab] of [
        ['providers.html', 'settings.html#llm', 'llm'],
        ['providers.html#decision', 'settings.html#decision', 'decision'],
        ['providers.html#multimodal', 'settings.html#multimodal', 'vision'],
        ['permissions.html', 'settings.html#permissions', 'permissions'],
      ]) {
        const { page: forwarded, errors: forwardErrors } = await open(browser, build, path);
        await forwarded.waitForURL(url => String(url).endsWith(`/src/${build}/src/ui/${target}`));
        await forwarded.waitForFunction(name => document.querySelector('.tab-btn.active')?.dataset.tab === name, tab)
          .catch(() => assert.fail(`${build}: ${path} opens ${tab}`));
        assert.deepEqual(forwardErrors, [], `${build}: ${path} forwarding errors`);
        await forwarded.close();
      }

      // --- the model sections (the Providers page until 48.x) ---
      const { page: providers, errors: providerErrors } = await open(browser, build, 'settings.html#llm');
      await providers.locator('.provider-card[data-provider-id="llamacpp"]').first().waitFor();
      assert.equal(await activeTab(providers), 'llm', `${build}: #llm opens the LLM section`);
      await providers.locator('[data-tab="decision"]').click();
      assert.ok(await visible(providers, '#decision-mode'), `${build}: decision modes in the Decision section`);
      assert.deepEqual(providerErrors, [], `${build}: model sections page errors`);
      await providers.close();

      // A profile sync in one Settings tab refreshes the model sections of
      // another, so a Save there cannot write stale values over what was pulled.
      const context = await browser.newContext({ viewport: { width: 1280, height: 1000 } });
      try {
        await context.addInitScript(stub, { build, lang: 'en', seed: {} });
        await context.addInitScript(() => { window.testProfileSyncState = { authenticated: true, enabled: true, unlocked: true, status: 'ready' }; });
        const syncErrors = [];
        const synced = await context.newPage();
        synced.on('pageerror', error => syncErrors.push(error.message));
        await synced.goto(`${origin}/src/${build}/src/ui/settings.html#vision`);
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
        assert.ok(await loads() > loadsBefore, `${build}: the other Settings tab reloads its providers after a sync`);
        assert.deepEqual(syncErrors, [], `${build}: profile sync refresh errors`);
      } finally {
        await context.close();
      }

      // --- Permissions & privacy (the Permissions page until 48.x) ---
      const grant = { host: 'example.com', capability: 'click', action: 'allow' };
      const { page: permissions, errors: permissionErrors } = await open(browser, build, 'settings.html#permissions', { seed: { wb_permissions: [grant] } });
      await permissions.locator('#permissions-list button[data-host="example.com"]').waitFor();
      await permissions.locator('#toggle-permission-gate').locator('..').click();
      assert.equal(await store(permissions, 'askBeforeConsequentialActions'), false, `${build}: master switch saves`);
      assert.ok(await visible(permissions, '#permission-gate-warning'), `${build}: master switch warning`);
      await permissions.locator('#permissions-list button[data-host="example.com"]').click();
      await permissions.waitForFunction(() => window.testStore.wb_permissions.length === 0);
      assert.deepEqual(permissionErrors, [], `${build}: Permissions & privacy page errors`);
      await permissions.close();

      // --- Offline opens Apocalypse Mode, and its Enabled switch works ---
      // Firefox's copy of the page imported a module only Chrome ships until
      // 48.1.x: the import failed the whole script, so the page looked right
      // but nothing on it ran and the switch never reached the background.
      const { page: apocalypse, errors: apocalypseErrors } = await open(browser, build, 'apocalypse-mode.html');
      const ran = await apocalypse.waitForFunction(() => window.testRequests.some(msg => msg.action === 'apocalypse_mode' && msg.command === 'status')
        && document.getElementById('storage-usage').textContent.trim() !== '').then(() => true, () => false);
      assert.ok(ran, `${build}: apocalypse-mode.js runs and shows the background's status`);
      assert.equal(await apocalypse.locator('#enabled').isChecked(), false, `${build}: Apocalypse Mode starts off`);
      await apocalypse.locator('#enabled').check();
      await apocalypse.waitForFunction(() => window.testStore.testApocalypseEnabled === true
        && document.getElementById('notice').dataset.kind === 'success');
      assert.equal(await apocalypse.locator('#enabled').isChecked(), true, `${build}: the switch stays on once the background turns it on`);
      await apocalypse.locator('#enabled').uncheck();
      await apocalypse.waitForFunction(() => window.testStore.testApocalypseEnabled === false);
      assert.deepEqual(apocalypseErrors, [], `${build}: Apocalypse Mode page errors`);
      await apocalypse.close();
      // The side panel opens this section while the rest of Settings can
      // still be waiting on the background (held here at the memory list).
      // Its switches already show what is stored and save from the first click.
      const quick = { timeout: 3000 };
      const { page: early, errors: earlyErrors } = await open(browser, build, 'settings.html#permissions', {
        seed: { askBeforeConsequentialActions: false, wb_permissions: [grant] },
        hold: { action: 'get_user_memory' },
      });
      await early.waitForFunction(() => window.testHeld > 0);
      await early.waitForFunction(() => document.getElementById('toggle-permission-gate').checked === false
        && document.getElementById('permission-gate-warning').style.display === '', null, quick)
        .catch(() => assert.fail(`${build}: the stored master switch shows while other sections load`));
      await early.locator('#permissions-list button[data-host="example.com"]').waitFor(quick)
        .catch(() => assert.fail(`${build}: the grants show while other sections load`));
      await early.locator('#toggle-screenshot-redaction').locator('..').click();
      await early.waitForFunction(() => window.testStore.screenshotRedaction === true, null, quick)
        .catch(() => assert.fail(`${build}: the redaction switch saves while other sections load`));
      await early.locator('#toggle-permission-gate').locator('..').click();
      await early.waitForFunction(() => window.testStore.askBeforeConsequentialActions === true, null, quick)
        .catch(() => assert.fail(`${build}: the master switch saves while other sections load`));
      assert.notEqual(await early.evaluate(() => document.documentElement.dataset.settingsReady), 'true', `${build}: the other sections were still loading`);
      await early.evaluate(() => window.testRelease());
      await early.waitForFunction(() => document.documentElement.dataset.settingsReady === 'true');
      assert.equal(await early.locator('#toggle-screenshot-redaction').isChecked(), true, `${build}: the redaction click stands once Settings has loaded`);
      assert.equal(await early.locator('#toggle-permission-gate').isChecked(), true, `${build}: the master switch click stands once Settings has loaded`);
      assert.equal(await visible(early, '#permission-gate-warning'), false, `${build}: the warning goes with prompts back on`);
      assert.deepEqual(earlyErrors, [], `${build}: early Permissions & privacy errors`);
      await early.close();

      // A click made before the stored value has been read is not undone by it.
      const { page: unread, errors: unreadErrors } = await open(browser, build, 'settings.html#permissions', { hold: { key: 'screenshotRedaction' } });
      await unread.waitForFunction(() => window.testHeld > 0);
      await unread.locator('#toggle-screenshot-redaction').locator('..').click();
      await unread.waitForFunction(() => window.testStore.screenshotRedaction === true, null, quick)
        .catch(() => assert.fail(`${build}: the redaction switch saves before its stored value is read`));
      await unread.evaluate(() => window.testRelease());
      await unread.waitForFunction(() => document.documentElement.dataset.settingsReady === 'true');
      assert.equal(await unread.locator('#toggle-screenshot-redaction').isChecked(), true, `${build}: reading the stored value keeps the click`);
      assert.deepEqual(unreadErrors, [], `${build}: unread redaction errors`);
      await unread.close();

      // Chrome rereads the Vision endpoint each time the Settings tab gets
      // focus again. That must not put the stored values back over an edit
      // that has not been saved, or Save stores the old endpoint.
      if (build === 'chrome') {
        const stored = { type: 'openai', baseUrl: 'https://vision.example/v1', apiKey: 'sk-test-a', model: 'vision-a' };
        const { page: vision, errors: visionErrors } = await open(browser, build, 'settings.html#vision', { seed: { visionModel: stored } });
        await vision.waitForFunction(() => document.documentElement.dataset.settingsReady === 'true');
        assert.equal(await vision.locator('#vision-model').inputValue(), 'vision-a');
        // The reload asks for the in-browser choice once it has decided what the fields show.
        const refocus = async () => {
          const before = await vision.evaluate(() => window.testRequests.filter(msg => msg.action === 'get_webgpu_vision_choice').length);
          await vision.evaluate(() => window.dispatchEvent(new Event('focus')));
          await vision.waitForFunction(n => window.testRequests.filter(msg => msg.action === 'get_webgpu_vision_choice').length > n, before);
        };
        await vision.locator('#vision-model').fill('vision-b');
        await vision.locator('#vision-api-key').fill('sk-test-b');
        await refocus();
        assert.equal(await vision.locator('#vision-model').inputValue(), 'vision-b', 'chrome: a refocus keeps the unsaved model');
        assert.equal(await vision.locator('#vision-api-key').inputValue(), 'sk-test-b', 'chrome: a refocus keeps the unsaved key');
        await vision.locator('#btn-save-vision').click();
        await vision.waitForFunction(() => window.testStore.visionModel?.model === 'vision-b')
          .catch(() => assert.fail('chrome: Save stores the edit made before the refocus'));
        assert.equal(await store(vision, 'visionModel').then(config => config.apiKey), 'sk-test-b');
        // With nothing unsaved, a refocus still shows a change made elsewhere.
        await vision.evaluate(() => { window.testStore.visionModel = { type: 'openai', baseUrl: 'https://vision.example/v1', apiKey: 'sk-test-b', model: 'vision-c' }; });
        await refocus();
        assert.equal(await vision.locator('#vision-model').inputValue(), 'vision-c', 'chrome: a refocus shows a change made elsewhere');
        assert.deepEqual(visionErrors, [], 'chrome: Vision refocus errors');
        await vision.close();
      }
      console.log(`PASS ${build}: settings page, its sections and the forwarded pages`);
    } finally {
      await browser.close();
    }
  }
} finally {
  server.close();
}
