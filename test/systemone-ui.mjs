import { chromium, firefox } from 'playwright';
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import assert from 'node:assert/strict';
const root = resolve('.');
const { version } = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
const server = createServer(async (req, res) => {
  try { const file = resolve(root, '.' + new URL(req.url, 'http://localhost').pathname); if (!file.startsWith(root + sep)) throw Error();
    res.setHeader('Content-Type', ({ '.js': 'text/javascript', '.mjs': 'text/javascript', '.html': 'text/html', '.css': 'text/css', '.svg': 'image/svg+xml' })[extname(file)] || 'text/plain'); res.end(await readFile(file));
  } catch { res.statusCode = 404; res.end(); }
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${server.address().port}`;
const output = process.env.JEV_UI_OUTPUT || '/tmp/jev-ui-review'; await mkdir(output, { recursive: true });
// Settings is split across settings.html, providers.html and permissions.html.
// JEV_DOC_SCREENSHOTS=<dir> refreshes the screenshots the docs use, from the
// synthetic profile below (no real keys).
async function captureDocScreenshots(browser, build, directory) {
  await mkdir(directory, { recursive: true });
  const open = async (target) => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
    await page.addInitScript(installStub, { lang: 'en', build, version, seed: DOC_SEED });
    await page.goto(`${origin}/src/${build}/src/ui/${target}`);
    await page.waitForFunction(() => document.documentElement.dataset.settingsReady === 'true');
    await page.evaluate(() => { document.activeElement?.blur(); scrollTo(0, 0); });
    await page.mouse.move(0, 0);
    return page;
  };
  for (const [target, name] of [
    ['settings.html#display', 'settings-general'],
    ['settings.html#budgets', 'settings-budgets'],
    ['settings.html#memory', 'settings-memory'],
    ['settings.html#captcha', 'settings-captcha'],
    ['settings.html#advanced', 'settings-advanced'],
    ['providers.html#llm', 'settings-providers'],
    ['providers.html#vision', 'providers-vision'],
    ['permissions.html', 'settings-permissions'],
  ]) {
    const page = await open(target);
    await page.screenshot({ animations: 'disabled', caret: 'hide', path: resolve(directory, `${name}.jpg`), type: 'jpeg', quality: 85 });
    await page.close();
  }
  const page = await open('providers.html#decision');
  await page.locator('#system-one-heading').scrollIntoViewIfNeeded();
  const clip = await page.evaluate(() => {
    const heading = document.querySelector('#system-one-heading').getBoundingClientRect();
    const card = document.querySelector('#system-one-card').getBoundingClientRect();
    return { x: card.x + scrollX, y: heading.y + scrollY, width: card.width, height: card.bottom - heading.y };
  });
  await page.screenshot({ animations: 'disabled', caret: 'hide', path: resolve(directory, 'settings-decision-models.jpg'), type: 'jpeg', quality: 85, fullPage: true, clip });
  await page.close();
}

// Made-up permission choices for the docs screenshot of the Permissions page.
const DOC_SEED = {
  wb_permissions: [
    { host: 'docs.example.com', capability: 'click', action: 'allow' },
    { host: 'mail.example.com', capability: 'type', action: 'deny' },
  ],
};

function installStub({ lang, build, version, seed = {} }) {
  localStorage.setItem('wbLocale', lang);
  const data = { wbLocale: lang, typesafeApiKey: '', systemOneEnabled: false, systemOneWatchEnabled: true, systemOneCompletionEnabled: true,
    ...seed, ...JSON.parse(sessionStorage.getItem('decision-profile') || '{}') };
  window.testStore = data; window.testRequests = [];
  const listeners = [];
  const storage = {
    async get(keys) { return keys == null ? { ...data } : Object.fromEntries((Array.isArray(keys) ? keys : typeof keys === 'string' ? [keys] : Object.keys(keys)).map(k => [k, data[k]])); },
    async set(values) { Object.assign(data, values); listeners.forEach(fn => fn(Object.fromEntries(Object.entries(values).map(([k, v]) => [k, { newValue: v }])), 'local')); },
    async remove(keys) { for (const key of Array.isArray(keys) ? keys : [keys]) delete data[key]; },
  };
  window.chrome = window.browser = {
    storage: { local: storage, onChanged: { addListener: fn => listeners.push(fn) } },
    runtime: { getURL: path => `${location.origin}/src/${build}/${path}`, getManifest: () => ({ version }), onMessage: { addListener() {} }, sendMessage(msg, callback) {
      window.testRequests.push(msg);
      const result = msg.action === 'get_providers' ? { providers: { llamacpp: { label: 'llama.cpp', category: 'local', baseUrl: 'http://localhost:8080/v1', model: 'local-model', configured: true }, openai: { label: 'OpenAI', category: 'cloud', apiKey: '', model: 'gpt-4o-mini' },
        webbrain_cloud: { label: 'WebBrain Cloud', category: 'cloud', providerName: 'webbrain-cloud', configured: true } }, active: sessionStorage.getItem('active-provider') || 'llamacpp' }
        : msg.action === 'test_system_one' ? { success: true, model: msg.settings?.decisionModel || 'jev-1.13.0', visionVerified: msg.settings?.decisionProvider === 'openrouter' }
          : msg.action === 'list_decision_models' ? { success: true, models: [{ id: 'cloudflare/clef-flash', name: 'Decider', supportsVision: true, inputRate: .02, outputRate: 0 }, { id: 'another/publisher', name: 'Another decision model', supportsVision: false, inputRate: .1, outputRate: 0 }] }
            : msg.action === 'get_user_memory' ? { ok: true, enabled: true, records: [] }
              : msg.action === 'get_in_browser_models' ? { ok: true, models: window.testInBrowserModels || [] } : {};
      callback?.(result); return Promise.resolve(result);
    } },
    commands: { getAll: async () => [] }, tabs: { create: async () => ({}) },
  };
}
try {
  for (const [build, engine] of [['chrome', chromium], ['firefox', firefox]]) {
    const browser = await engine.launch();
    try {
      for (const lang of ['en', 'tr']) for (const width of [390, 1280]) {
        const page = await browser.newPage({ viewport: { width, height: 1000 } });
        const errors = []; page.on('pageerror', error => errors.push(error.message));
        await page.addInitScript(installStub, { lang, build, version });
        await page.goto(`${origin}/src/${build}/src/ui/providers.html#decision`);
        await page.waitForFunction(() => document.querySelector('#system-one-heading')?.textContent.trim() === (localStorage.getItem('wbLocale') === 'tr' ? 'Karar modelleri' : 'Decision models'));
        assert.equal(await page.locator('[data-tab="decision"]').textContent(), lang === 'tr' ? 'Karar' : 'Decision');
        assert.equal(await page.locator('[data-panel="decision"]').isVisible(), true, 'providers.html#decision opens the Decision tab');
        assert.equal(await page.locator('.tab-btn').evaluateAll(buttons => buttons.every(button => {
          const range = document.createRange();
          range.selectNodeContents(button);
          const lines = [...range.getClientRects()].filter(rect => rect.width > 0);
          return lines.length > 0 && lines.every(rect => Math.abs(rect.top - lines[0].top) < 1)
            && button.scrollWidth <= button.clientWidth + 1;
        })), true, 'every tab label fits on one line without clipping');
        await page.screenshot({ animations: 'disabled', path: `${output}/${build}-${lang}-${width}-tabs.png` });
        assert.deepEqual(await page.locator('.tab-panel > .provider-card').evaluateAll(cards => cards.map(card => [card.closest('.tab-panel').dataset.panel, card.id])), [
          ['vision', 'vision-card'], ['speech', 'transcription-card'], ['generative', 'image-gen-card'], ['decision', 'system-one-card'], ['safesocial', 'safesocial-card'],
        ], 'each assistive model has its own Providers tab');
        // Providers remembers its last tab across reloads.
        await page.evaluate(() => history.replaceState(null, '', location.pathname));
        await page.locator('[data-tab="llm"]').click();
        await page.reload();
        assert.equal(await page.locator('[data-panel="llm"]').isVisible(), true);
        await page.locator('[data-tab="decision"]').click();
        await page.reload();
        await page.waitForFunction(() => document.querySelector('#system-one-heading')?.textContent.trim() === (localStorage.getItem('wbLocale') === 'tr' ? 'Karar modelleri' : 'Decision models'));
        assert.equal(await page.locator('[data-panel="decision"]').isVisible(), true);
        assert.equal(await page.evaluate(() => testRequests.filter(r => r.action === 'test_system_one').length), 0);
        const statusText = () => page.locator('#decision-auto-status').textContent();
        const tr = lang === 'tr';
        // Auto is the default: nothing to configure, and it says what it uses.
        assert.equal(await page.locator('input[name="decision-mode"][value="auto"]').isChecked(), true);
        assert.equal(await page.locator('#decision-configured').isVisible(), false);
        assert.equal(await page.locator('#btn-save-system-one').isVisible(), false);
        await page.waitForFunction(() => !document.querySelector('#decision-auto-status').hidden);
        assert.match(await statusText(), tr ? /Açık’ı seçin/ : /Choose On to set up/);
        assert.equal(await page.locator('#btn-test-system-one').isVisible(), false, 'nothing to test while Auto uses nothing');
        await page.locator('#system-one-card').screenshot({ animations: 'disabled', caret: 'hide', path: `${output}/${build}-${lang}-${width}-auto.png` });
        if (build === 'chrome') {
          // A finished Ternary Bonsai 2 2B Vision download leaves the worker's
          // ready marker in Cache Storage; that chat model does not answer decisions.
          await page.evaluate(async () => {
            const { webgpuTextReadyMarkerUrl } = await import('/src/chrome/src/providers/webgpu-model-cache.js');
            const { WEBGPU_BONSAI2_VL_2B_MODEL_ID } = await import('/src/chrome/src/providers/webgpu.js');
            await (await caches.open('transformers-cache')).put(webgpuTextReadyMarkerUrl(WEBGPU_BONSAI2_VL_2B_MODEL_ID), new Response('{}'));
            dispatchEvent(new Event('focus'));
          });
          await page.waitForFunction(() => document.querySelector('#decision-auto-status').dataset.state === 'inactive');
          assert.doesNotMatch(await statusText(), /Ternary Bonsai/);
          assert.equal(await page.locator('#btn-test-system-one').isVisible(), false);
          // A finished Compass VLD download is what Auto uses.
          await page.evaluate(async () => {
            const { webgpuTextReadyMarkerUrl, WEBGPU_LOCAL_ASSIST_MODEL_ID } = await import('/src/chrome/src/providers/webgpu-model-cache.js');
            await (await caches.open('transformers-cache')).put(webgpuTextReadyMarkerUrl(WEBGPU_LOCAL_ASSIST_MODEL_ID), new Response('{}'));
            dispatchEvent(new Event('focus'));
          });
          await page.waitForFunction(() => document.querySelector('#decision-auto-status').dataset.state === 'active');
          assert.match(await statusText(), tr ? /Kullanılıyor: bu cihazda Compass VLD\./ : /In use: Compass VLD, on this device\./);
          assert.equal(await page.locator('#btn-test-system-one').isVisible(), true, 'the chat model runs here, so Auto can test it');
          await page.locator('#system-one-card').screenshot({ animations: 'disabled', caret: 'hide', path: `${output}/${build}-${lang}-${width}-auto-chat-model.png` });
          assert.equal(await page.evaluate(() => testRequests.filter(r => r.action === 'test_system_one').length), 0);
          // While the active provider keeps another in-browser model loaded, a
          // check would unload it, so Auto does not use the chat model.
          await page.evaluate(() => { window.testInBrowserModels = ['webbrain-one/webbrain-compass-tiny-v2.1']; dispatchEvent(new Event('focus')); });
          await page.waitForFunction(() => document.querySelector('#decision-auto-status').dataset.state === 'inactive');
          assert.doesNotMatch(await statusText(), /Compass VLD/);
          assert.equal(await page.locator('#btn-test-system-one').isVisible(), false);
          await page.evaluate(() => { window.testInBrowserModels = ['webbrain-one/webbrain-compass-vld-v6-2b-onnx']; dispatchEvent(new Event('focus')); });
          await page.waitForFunction(() => document.querySelector('#decision-auto-status').dataset.state === 'active');
          assert.match(await statusText(), /Compass VLD/, 'a provider chatting on the chat decision model shares it');
          await page.evaluate(() => { delete window.testInBrowserModels; });
          await page.evaluate(async () => { await caches.delete('transformers-cache'); dispatchEvent(new Event('focus')); });
          await page.waitForFunction(() => document.querySelector('#decision-auto-status').dataset.state === 'inactive');
        }
        // A finished D1 download (its consent, Load request and ready marker) is what Auto uses.
        await page.evaluate(async build => {
          const { D1_CACHE_NAME, D1_RELEASE, D1_CONSENT_KEY, D1_CONSENT_VERSION, D1_KEEP_LOADED_KEY } = await import(`/src/${build}/src/providers/d1-config.js`);
          const directory = await (await navigator.storage.getDirectory()).getDirectoryHandle(`${D1_CACHE_NAME}-${D1_RELEASE.revision}`, { create: true });
          const writer = await (await directory.getFileHandle('ready.json', { create: true })).createWritable();
          await writer.write(JSON.stringify({ revision: D1_RELEASE.revision, manifestSha256: D1_RELEASE.manifestSha256 }));
          await writer.close();
          Object.assign(testStore, { [D1_CONSENT_KEY]: D1_CONSENT_VERSION, [D1_KEEP_LOADED_KEY]: true });
          dispatchEvent(new Event('focus'));
        }, build);
        await page.waitForFunction(() => document.querySelector('#decision-auto-status').dataset.state === 'active');
        assert.match(await statusText(), tr ? /Kullanılıyor: bu cihazda D1\./ : /In use: D1, on this device\./);
        assert.equal(await page.locator('#btn-test-system-one').isVisible(), true, 'D1 runs here, so Auto can test it');
        await page.locator('#system-one-card').screenshot({ animations: 'disabled', caret: 'hide', path: `${output}/${build}-${lang}-${width}-auto-d1.png` });
        await page.locator('#btn-test-system-one').click();
        await page.waitForFunction(() => testRequests.filter(r => r.action === 'test_system_one').length === 1);
        assert.equal(await page.evaluate(() => testRequests.at(-1).settings.decisionMode), 'auto');
        // Unload ends what Auto uses.
        await page.evaluate(async build => {
          const { D1_CACHE_NAME, D1_RELEASE, D1_CONSENT_KEY, D1_KEEP_LOADED_KEY } = await import(`/src/${build}/src/providers/d1-config.js`);
          testStore[D1_KEEP_LOADED_KEY] = false;
          dispatchEvent(new Event('focus'));
          await new Promise(resolve => setTimeout(resolve, 50));
          await (await navigator.storage.getDirectory()).removeEntry(`${D1_CACHE_NAME}-${D1_RELEASE.revision}`, { recursive: true });
          delete testStore[D1_CONSENT_KEY]; delete testStore[D1_KEEP_LOADED_KEY];
        }, build);
        await page.waitForFunction(() => document.querySelector('#decision-auto-status').dataset.state === 'inactive');
        assert.equal(await page.locator('#btn-test-system-one').isVisible(), false);
        const tests = 1;
        // On applies at once and shows the provider fields; switches stay folded.
        await page.locator('input[name="decision-mode"][value="on"]').locator('..').click();
        await page.waitForFunction(() => testStore.decisionMode === 'on' && testStore.systemOneEnabled === true);
        assert.equal(await page.locator('#decision-configured').isVisible(), true);
        assert.equal(await page.locator('#decision-auto-status').isVisible(), false);
        assert.equal(await page.locator('#decision-features').evaluate(el => el.open), false);
        assert.equal(await page.locator('#toggle-system-one-browser').isVisible(), false);
        await page.locator('#system-one-card').screenshot({ animations: 'disabled', caret: 'hide', path: `${output}/${build}-${lang}-${width}-on.png` });
        await page.locator('#decision-features summary').click();
        for (const id of ['toggle-decision-done', 'toggle-system-one-watch', 'toggle-system-one-completion', 'toggle-system-one-classifications', 'toggle-system-one-browser']) {
          assert.equal(await page.locator(`#${id}`).isChecked(), true, `${id} is on by default in On`);
        }
        await page.locator('#toggle-system-one-classifications').locator('..').click();
        await page.locator('#decision-provider').selectOption('typesafe');
        await page.locator('#system-one-api-key').fill('synthetic-test-key');
        await page.locator('[data-tab="llm"]').click();
        const search = page.locator('#providers .provider-search input');
        if (await search.count()) await search.fill('No matching provider');
        assert.equal(await page.locator('#providers .provider-filter-bar').count(), 1);
        await page.locator('[data-tab="decision"]').click();
        assert.equal(await page.locator('#system-one-api-key').inputValue(), 'synthetic-test-key');
        await page.locator('#btn-save-system-one').click();
        await page.waitForFunction(() => testStore.typesafeApiKey === 'synthetic-test-key');
        assert.equal(await page.evaluate(() => testStore.decisionMode), 'on');
        assert.equal(await page.evaluate(() => testStore.systemOneEnabled), true);
        assert.equal(await page.evaluate(() => testStore.systemOneWatchEnabled), true);
        assert.equal(await page.evaluate(() => testStore.systemOneCompletionEnabled), true);
        assert.equal(await page.evaluate(() => testStore.systemOneFastClassifications), false);
        assert.equal(await page.evaluate(() => testStore.systemOneFastBrowser), true);
        await page.locator('#btn-test-system-one').click();
        await page.waitForFunction(count => testRequests.filter(r => r.action === 'test_system_one').length === count, tests + 1);
        assert.equal(await page.evaluate(() => testRequests.at(-1).settings.decisionMode), 'on');
        await page.locator('#decision-provider').selectOption('openrouter');
        assert.equal(await page.locator('#decision-model').inputValue(), 'cloudflare/clef-flash');
        assert.equal(await page.locator('#system-one-api-key').inputValue(), '', 'TypeSafe key must not be copied into OpenRouter');
        assert.equal(await page.locator('#toggle-decision-done').isChecked(), true);
        await page.locator('#system-one-api-key').fill('synthetic-openrouter-key');
        await page.locator('#btn-decision-models').click();
        await page.waitForFunction(() => document.querySelectorAll('#decision-models option').length === 2);
        await page.locator('#btn-save-system-one').click();
        await page.waitForFunction(() => testStore.decisionProvider === 'openrouter' && testStore.decisionApiKey === 'synthetic-openrouter-key');
        assert.equal(await page.evaluate(() => testStore.typesafeApiKey), 'synthetic-test-key');
        assert.equal(await page.evaluate(() => testStore.decisionVisionSupported), true);
        assert.equal(await page.evaluate(() => testStore.systemOneDoneThreshold), .9);
        await page.locator('#decision-provider').selectOption('local');
        assert.equal(await page.locator('#decision-model').inputValue(), 'kev-latest');
        assert.equal(await page.locator('#system-one-api-key').inputValue(), '');
        assert.equal(await page.locator('#decision-endpoint-field').isVisible(), true);
        await page.locator('#btn-save-system-one').click();
        await page.waitForFunction(() => testStore.decisionProvider === 'local' && testStore.systemOneEnabled === true);
        assert.equal(await page.evaluate(() => testStore.decisionLocalApiKey), '', 'local key remains optional');
        await page.locator('#btn-test-system-one').click();
        await page.waitForFunction(count => testRequests.filter(r => r.action === 'test_system_one').length === count, tests + 2);
        assert.equal(await page.evaluate(() => testRequests.filter(r => r.action === 'test_system_one').at(-1).settings.decisionModel), 'kev-latest');
        await page.locator('#decision-provider').selectOption('typesafe');
        assert.equal(await page.locator('#system-one-api-key').inputValue(), 'synthetic-test-key');
        await page.locator('#decision-provider').selectOption('openrouter');
        assert.equal(await page.locator('#system-one-api-key').inputValue(), 'synthetic-openrouter-key');
        await page.screenshot({ animations: 'disabled', caret: 'hide', path: `${output}/${build}-${lang}-${width}.png`, fullPage: true });
        await page.locator('#system-one-card').screenshot({ animations: 'disabled', caret: 'hide', path: `${output}/${build}-${lang}-${width}-decision-card.png` });
        // Off applies at once and hides everything but the explanation.
        const resets = () => page.evaluate(() => testRequests.filter(r => r.action === 'd1_control' && r.command === 'reset').length);
        const resetsBeforeOff = await resets();
        await page.locator('input[name="decision-mode"][value="off"]').locator('..').click();
        await page.waitForFunction(() => testStore.decisionMode === 'off' && testStore.systemOneEnabled === false);
        await page.waitForFunction(count => testRequests.filter(r => r.action === 'd1_control' && r.command === 'reset').length === count, resetsBeforeOff + 1);
        assert.equal(await page.locator('#decision-configured').isVisible(), false);
        assert.equal(await page.locator('#btn-test-system-one').isVisible(), false);
        assert.equal(await page.locator('#btn-save-system-one').isVisible(), false);
        assert.equal(await page.locator('#decision-auto-status').isVisible(), false);
        await page.locator('#system-one-card').screenshot({ animations: 'disabled', caret: 'hide', path: `${output}/${build}-${lang}-${width}-off.png` });
        // Off ended D1's Load; Auto keeps it, since Auto uses a downloaded D1.
        await page.locator('input[name="decision-mode"][value="auto"]').locator('..').click();
        await page.waitForFunction(() => testStore.decisionMode === 'auto' && testStore.systemOneEnabled === false);
        assert.equal(await resets(), resetsBeforeOff + 1);
        // Reset returns to Auto with On's defaults and deletes the keys.
        await page.locator('#btn-clear-system-one').click();
        await page.waitForFunction(() => testStore.decisionMode === undefined && testStore.typesafeApiKey === undefined);
        assert.equal(await page.locator('input[name="decision-mode"][value="auto"]').isChecked(), true);
        assert.equal(await page.locator('#range-system-one-watch-threshold').inputValue(), '70');
        assert.equal(await page.locator('#range-system-one-completion-threshold').inputValue(), '70');
        for (const id of ['toggle-decision-done', 'toggle-system-one-watch', 'toggle-system-one-completion', 'toggle-system-one-classifications', 'toggle-system-one-browser']) {
          assert.equal(await page.locator(`#${id}`).isChecked(), true, `${id} back to On's default`);
        }
        assert.equal(await page.locator('#decision-configured').isVisible(), false);
        if (build === 'chrome' && lang === 'en' && width === 1280 && process.env.JEV_DOC_SCREENSHOTS) {
          await captureDocScreenshots(browser, build, process.env.JEV_DOC_SCREENSHOTS);
        }
        if (build === 'chrome') {
          const switches = { systemOneDoneEnabled: true, systemOneWatchEnabled: false, systemOneCompletionEnabled: true,
            systemOneFastClassifications: false, systemOneFastBrowser: true };
          await page.evaluate(switches => sessionStorage.setItem('decision-profile', JSON.stringify({
            decisionMode: 'on', systemOneEnabled: true, decisionProvider: 'webgpu_chat', ...switches,
          })), switches);
          await page.reload();
          await page.waitForFunction(() => document.querySelector('#decision-provider').value === 'webgpu_chat');
          assert.equal(await page.locator('#btn-test-system-one').isVisible(), true, 'the in-browser chat model runs here, so it can be tested');
          assert.equal(await page.locator('#decision-model').inputValue(), 'webbrain-one/webbrain-compass-vld-v6-2b-onnx', 'its model is fixed');
          const ids = ['toggle-decision-done', 'toggle-system-one-watch', 'toggle-system-one-completion', 'toggle-system-one-classifications', 'toggle-system-one-browser'];
          for (const [i, value] of Object.values(switches).entries()) assert.equal(await page.locator(`#${ids[i]}`).isChecked(), value, 'the saved selection retains its switches');
          for (const provider of ['openrouter', 'typesafe', 'local']) {
            await page.locator('#decision-provider').selectOption(provider);
            assert.equal(await page.locator('#btn-test-system-one').isVisible(), true, `${provider} can be tested immediately`);
            await page.locator('#system-one-api-key').fill('synthetic-replacement-key');
            await page.locator('#btn-test-system-one').click();
            await page.waitForFunction(provider => testRequests.some(r => r.action === 'test_system_one' && r.settings?.decisionProvider === provider), provider);
            await page.locator('#btn-save-system-one').click();
            await page.waitForFunction(provider => testStore.decisionProvider === provider, provider);
            assert.deepEqual(await page.evaluate(keys => Object.fromEntries(keys.map(key => [key, testStore[key]])), Object.keys(switches)), switches);
          }
        }
        if (lang === 'en' && width === 1280) {
          // While Compass is the chat provider, a downloaded D1 is still what Auto uses.
          await page.evaluate(() => { sessionStorage.setItem('active-provider', 'webbrain_cloud'); sessionStorage.setItem('decision-profile', '{}'); });
          await page.reload();
          await page.waitForFunction(() => !document.querySelector('#decision-auto-status').hidden);
          assert.match(await statusText(), /In use: WebBrain Cloud’s decision model/);
          assert.equal(await page.locator('#btn-test-system-one').isVisible(), false, "Compass's managed model cannot be tested here");
          await page.evaluate(async build => {
            const { D1_CACHE_NAME, D1_RELEASE, D1_CONSENT_KEY, D1_CONSENT_VERSION, D1_KEEP_LOADED_KEY } = await import(`/src/${build}/src/providers/d1-config.js`);
            const directory = await (await navigator.storage.getDirectory()).getDirectoryHandle(`${D1_CACHE_NAME}-${D1_RELEASE.revision}`, { create: true });
            const writer = await (await directory.getFileHandle('ready.json', { create: true })).createWritable();
            await writer.write(JSON.stringify({ revision: D1_RELEASE.revision, manifestSha256: D1_RELEASE.manifestSha256 }));
            await writer.close();
            Object.assign(testStore, { [D1_CONSENT_KEY]: D1_CONSENT_VERSION, [D1_KEEP_LOADED_KEY]: true });
            dispatchEvent(new Event('focus'));
          }, build);
          await page.waitForFunction(() => /D1/.test(document.querySelector('#decision-auto-status').textContent));
          assert.match(await statusText(), /In use: D1, on this device\./);
          assert.equal(await page.locator('#btn-test-system-one').isVisible(), true, 'D1 runs here, so Auto can test it');
          await page.evaluate(async build => {
            const { D1_CACHE_NAME, D1_RELEASE } = await import(`/src/${build}/src/providers/d1-config.js`);
            await (await navigator.storage.getDirectory()).removeEntry(`${D1_CACHE_NAME}-${D1_RELEASE.revision}`, { recursive: true });
            sessionStorage.removeItem('active-provider');
          }, build);
        }
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'settings fit viewport');
        assert.deepEqual(errors, []);
        await page.close(); console.log(`${build} ${lang} ${width}: settings save/test/clear passed`);
      }
    } finally { await browser.close(); }
  }
} finally { server.close(); }
