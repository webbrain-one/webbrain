import { chromium, firefox } from 'playwright';
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import assert from 'node:assert/strict';

const root = resolve('.');
const output = process.env.MEDIA_UI_OUTPUT || '/tmp/webbrain-generative-media-ui';
await mkdir(output, { recursive: true });
const server = createServer(async (req, res) => {
  try {
    const file = resolve(root, '.' + new URL(req.url, 'http://localhost').pathname);
    if (!file.startsWith(root + sep)) throw new Error('outside root');
    res.setHeader('Content-Type', ({ '.js': 'text/javascript', '.mjs': 'text/javascript', '.html': 'text/html', '.css': 'text/css', '.svg': 'image/svg+xml' })[extname(file)] || 'text/plain');
    res.end(await readFile(file));
  } catch { res.statusCode = 404; res.end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const workflow = JSON.stringify({ '6': { class_type: 'CLIPTextEncode', inputs: { text: '{{prompt}}' } }, '9': { class_type: 'SaveImage', inputs: { images: ['6', 0] } } }, null, 2);
try {
  for (const [build, engine] of [['chrome', chromium], ['firefox', firefox]]) {
    const backgroundSource = await readFile(`src/${build}/src/background.js`, 'utf8');
    const sendStart = backgroundSource.indexOf('function sendAgentUpdate(');
    const sendSource = backgroundSource.slice(sendStart, backgroundSource.indexOf('\nfunction ', sendStart + 1));
    const panelSource = await readFile(`src/${build}/src/ui/sidepanel.js`, 'utf8');
    const handleStart = panelSource.indexOf('function handleAgentUpdateMessage(');
    const handleEnd = panelSource.slice(handleStart).search(/\n(?:chrome|browser)\.runtime\.onMessage\.addListener/);
    assert.ok(handleStart >= 0 && handleEnd > 0);
    const handleSource = panelSource.slice(handleStart, handleStart + handleEnd);
    const browser = await engine.launch();
    try {
      for (const lang of ['en', 'tr']) for (const width of [390, 1280]) {
        const page = await browser.newPage({ viewport: { width, height: 1100 } });
        const errors = []; page.on('pageerror', error => errors.push(error.message));
        await page.addInitScript(({ build, lang }) => {
          localStorage.setItem('wbLocale', lang);
          const data = JSON.parse(localStorage.getItem('media-test-store') || 'null') || { wbLocale: lang, imageGenModel: { apiKey: 'legacy-key', model: 'fal-ai/flux/schnell' } };
          window.testStore = data; window.testRequests = [];
          const storage = {
            async get(keys) { return keys == null ? { ...data } : Object.fromEntries((Array.isArray(keys) ? keys : typeof keys === 'string' ? [keys] : Object.keys(keys)).map(key => [key, data[key]])); },
            async set(values) { Object.assign(data, values); localStorage.setItem('media-test-store', JSON.stringify(data)); },
            async remove(keys) { for (const key of Array.isArray(keys) ? keys : [keys]) delete data[key]; localStorage.setItem('media-test-store', JSON.stringify(data)); },
          };
          window.chrome = window.browser = {
            storage: { local: storage, onChanged: { addListener() {} } },
            runtime: { getURL: path => `${location.origin}/src/${build}/${path}`, getManifest: () => ({ version: '39.1.1' }), onMessage: { addListener() {} }, sendMessage(msg, callback) {
              testRequests.push(msg);
              const result = msg.action === 'get_providers' ? { providers: {}, active: '' }
                : msg.action === 'test_image_gen_provider' ? { ok: true, model: data.imageGenModel.model || 'ComfyUI workflow' } : {};
              callback?.(result); return Promise.resolve(result);
            } },
            commands: { getAll: async () => [] }, tabs: { create: async () => ({}) },
          };
        }, { build, lang });
        await page.goto(`${origin}/src/${build}/src/ui/providers.html#generative`);
        await page.waitForFunction(() => document.querySelector('#image-gen-api-key').value === 'legacy-key');
        assert.equal(await page.locator('#image-gen-heading').innerText(), lang === 'en' ? 'Generative Media' : 'Üretken medya');
        const provider = page.locator('#image-gen-provider');
        assert.equal(await provider.inputValue(), 'fal', 'legacy config defaults to fal.ai');
        // fal.ai videos default to 480p; 720p is a saved choice.
        const resolution = page.locator('#image-gen-video-resolution');
        assert.equal(await resolution.isVisible(), true);
        assert.deepEqual(await resolution.locator('option').evaluateAll(options => options.map(option => option.value)), ['480p', '720p']);
        assert.equal(await resolution.inputValue(), '480p', 'a legacy config uses the 480p default');
        await resolution.selectOption('720p');
        await page.locator('#btn-save-image-gen').click();
        await page.waitForFunction(() => testStore.imageGenModel?.videoResolution === '720p');
        await page.reload();
        await page.waitForFunction(() => document.querySelector('#image-gen-video-resolution').value === '720p');
        await resolution.selectOption('480p');
        await page.locator('#btn-save-image-gen').click();
        await page.waitForFunction(() => testStore.imageGenModel?.videoResolution === '480p');
        assert.deepEqual(await provider.locator('option').evaluateAll(options => options.map(option => option.value)), ['fal', 'openrouter', 'comfyrouter', 'comfyui']);
        await provider.selectOption('openrouter');
        assert.equal(await page.locator('#image-gen-video-resolution-field').isVisible(), false, 'resolution is a fal.ai setting');
        assert.equal(await page.locator('#image-gen-api-key').inputValue(), '', 'keys do not cross providers');
        await page.locator('#image-gen-api-key').fill('synthetic-or-key');
        await page.locator('#image-gen-model').fill('google/gemini-2.5-flash-image');
        await page.locator('#btn-save-image-gen').click();
        await page.waitForFunction(() => testStore.imageGenModel?.provider === 'openrouter');
        await page.reload();
        await page.waitForFunction(() => document.querySelector('#image-gen-provider').value === 'openrouter');
        assert.equal(await page.locator('#image-gen-api-key').inputValue(), 'synthetic-or-key');
        await page.locator('#btn-test-image-gen').click();
        await page.waitForFunction(() => testRequests.some(request => request.action === 'test_image_gen_provider'));
        await provider.selectOption('comfyrouter');
        assert.equal(await page.locator('#image-gen-parameters-field').isVisible(), true);
        await page.locator('#image-gen-api-key').fill('synthetic-comfy-key');
        await page.locator('#image-gen-model').fill('bfl/flux-2-pro');
        await page.locator('#image-gen-parameters').fill('{bad json');
        await page.locator('#btn-save-image-gen').click();
        await page.waitForFunction(() => document.querySelector('#test-image-gen').classList.contains('fail'));
        assert.equal(await page.evaluate(() => testStore.imageGenModel.provider), 'openrouter', 'invalid input preserves the saved configuration');
        await page.locator('#image-gen-parameters').fill('{"prompt":"{{prompt}}","width":1024}');
        await page.locator('#btn-save-image-gen').click();
        await page.waitForFunction(() => testStore.imageGenModel?.provider === 'comfyrouter');
        await provider.selectOption('openrouter');
        assert.equal(await page.locator('#image-gen-api-key').inputValue(), 'synthetic-or-key', 'unsaved draft retained');
        await provider.selectOption('comfyui');
        assert.equal(await page.locator('#image-gen-key-field').isVisible(), false);
        assert.equal(await page.locator('#image-gen-model-field').isVisible(), false);
        assert.equal(await page.locator('#image-gen-url-field').isVisible(), true);
        assert.equal(await page.locator('#image-gen-parameters-field').isVisible(), false);
        assert.equal(await page.locator('#image-gen-video-resolution-field').isVisible(), false);
        assert.equal(await page.locator('#image-gen-base-url').inputValue(), 'http://127.0.0.1:8188');
        await page.locator('#image-gen-workflow').fill(workflow);
        await page.locator('#btn-save-image-gen').click();
        await page.waitForFunction(() => testStore.imageGenModel?.provider === 'comfyui');
        assert.equal(await page.evaluate(() => testStore.imageGenModel.apiKey), undefined);
        await page.reload();
        await page.waitForFunction(() => document.querySelector('#image-gen-provider').value === 'comfyui');
        assert.equal(await page.locator('#image-gen-workflow').inputValue(), workflow);
        await page.locator('#image-gen-heading').scrollIntoViewIfNeeded();
        await page.screenshot({ animations: 'disabled', path: `${output}/${build}-${lang}-${width}-comfyui-configured.png` });
        await page.locator('#btn-test-image-gen').click();
        await page.waitForFunction(() => document.querySelector('#test-image-gen').classList.contains('ok'));
        await page.locator('#btn-clear-image-gen').click();
        await page.waitForFunction(() => testStore.imageGenModel == null);
        assert.equal(await page.locator('#image-gen-workflow').inputValue(), '');
        for (const value of ['fal', 'openrouter', 'comfyrouter', 'comfyui']) {
          await provider.selectOption(value);
          assert.equal(await page.locator('#image-gen-api-key').inputValue(), '');
          if (value === 'fal') assert.equal(await page.locator('#image-gen-video-resolution').inputValue(), '480p', 'Clear returns to the default');
          await page.locator('#image-gen-heading').scrollIntoViewIfNeeded();
          await page.screenshot({ animations: 'disabled', path: `${output}/${build}-${lang}-${width}-${value}.png` });
          assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `${value}: fits viewport`);
        }
        // Exercise the real journal/broadcast/panel handler rather than handing
        // a raw result straight to the renderer (which hid the original bug).
        const transport = await page.evaluate(async ({ build, sendSource, handleSource }) => {
          const { generateImage } = await import(`/src/${build}/src/agent/generative-media.js`);
          const { appendGeneratedMedia } = await import(`/src/${build}/src/ui/generated-media-view.js`);
          const { RunUiJournal, compactRunUiSnapshotForPersist, RUN_UI_PERSIST_RETRY_BUDGET } = await import(`/src/${build}/src/run-ui-journal.js`);
          const { loadGeneratedMedia } = await import(`/src/${build}/src/generated-media-store.js`);
          const canvas = document.createElement('canvas'); canvas.width = canvas.height = 512;
          const context = canvas.getContext('2d'); const pixels = context.createImageData(512, 512);
          for (let i = 0; i < pixels.data.length; i += 65536) crypto.getRandomValues(pixels.data.subarray(i, i + 65536));
          context.putImageData(pixels, 0, 0);
          const dataUrl = canvas.toDataURL('image/png');
          const result = await generateImage({ prompt: 'test image' }, {
            config: { provider: 'openrouter', apiKey: 'synthetic-key', model: 'image-model' },
            fetchImpl: async url => new Response(JSON.stringify({ data: url.endsWith('/models')
              ? [{ id: 'image-model' }] : [{ b64_json: dataUrl.split(',')[1], media_type: 'image/png' }] }), { headers: { 'Content-Type': 'application/json' } }),
          });
          if (!result.success) throw new Error(result.error);
          const div = document.createElement('div'); div.id = 'media-test-preview'; document.querySelector('#image-gen-card').appendChild(div);
          div.innerHTML = '<div class="message assistant" data-run-request-id="media-run"><div class="message-content"></div></div>';
          const handler = new Function('appendGeneratedMedia', 'context', `
            const { currentAssistantEl, messagesEl, currentTabId, verboseMode } = context;
            const t = key => key;
            const clearedConversationRunRequestIds = new Set();
            const localRunRequestIds = new Map();
            const ensureCurrentRunAssistant = () => currentAssistantEl;
            const markLastStepDone = () => {};
            const appendVerboseToolResult = () => {};
            const scrollToBottom = () => {};
            const schedulePersist = () => context.persistCalls++;
            return (${handleSource});
          `)(appendGeneratedMedia, { messagesEl: div, currentAssistantEl: div.firstElementChild, currentTabId: 11, verboseMode: false, persistCalls: 0 });
          const journal = new RunUiJournal(); journal.begin(11, 'media-run');
          const sent = [];
          const api = { runtime: { sendMessage: async message => { sent.push(message); handler(message); } } };
          const send = new Function('recordRunUiEvent', 'agent', 'chrome', 'browser', `return (${sendSource});`)(
            (...args) => journal.record(...args), { currentRunId: new Map() }, api, api,
          );
          send(11, 'media-run', 'tool_result', { name: 'generate_image', result });
          // Hosted videos must also reach the media element, not their thumbnail.
          send(11, 'media-run', 'tool_result', { name: 'generate_image', result: { success: true, provider: 'comfyrouter', url: 'https://cdn.example/final.mp4' } });
          appendGeneratedMedia(div, { success: true, url: 'javascript:alert(1)' }, key => key);
          const snapshot = compactRunUiSnapshotForPersist(journal.get(11), { tight: true });
          localStorage.setItem('media-replay-snapshot', JSON.stringify(snapshot));
          localStorage.setItem('media-asset-id', result.mediaId);
          const blob = await loadGeneratedMedia(result.mediaId);
          return { sentHandle: sent[0].data.result.mediaId, mediaId: result.mediaId, url: result.url, blobSize: blob.size, snapshotSize: JSON.stringify(snapshot).length, budget: RUN_UI_PERSIST_RETRY_BUDGET, discarded: snapshot.discardedBeforeSeq };
        }, { build, sendSource, handleSource });
        assert.equal(transport.sentHandle, transport.mediaId);
        assert.equal(transport.url, undefined, 'inline bytes travel as an asset handle');
        assert.ok(transport.blobSize > 512 * 1024, 'real inline image exceeds journal budget');
        assert.ok(transport.snapshotSize < transport.budget);
        assert.equal(transport.discarded, 0);
        await page.waitForFunction(() => document.querySelector('#media-test-preview img')?.naturalWidth === 512);
        assert.equal(await page.locator('#media-test-preview a[download]').getAttribute('download'), 'webbrain-media.png');
        assert.equal(await page.locator('#media-test-preview video').getAttribute('src'), 'https://cdn.example/final.mp4');
        await page.evaluate(() => localStorage.setItem('media-chat-html', document.querySelector('#media-test-preview').innerHTML));
        await page.reload();
        await page.evaluate(async build => {
          const { appendGeneratedMedia, restoreGeneratedMedia } = await import(`/src/${build}/src/ui/generated-media-view.js`);
          const { RunUiJournal } = await import(`/src/${build}/src/run-ui-journal.js`);
          const restored = new RunUiJournal(); restored.restore(11, JSON.parse(localStorage.getItem('media-replay-snapshot')));
          const div = document.createElement('div'); div.id = 'media-replay-preview'; document.querySelector('#image-gen-card').appendChild(div);
          for (const event of restored.get(11).events) await appendGeneratedMedia(div, event.data.result, key => key);
          const chat = document.createElement('div'); chat.id = 'media-restored-chat'; document.querySelector('#image-gen-card').appendChild(chat);
          chat.innerHTML = localStorage.getItem('media-chat-html');
          await restoreGeneratedMedia(chat, key => key);
        }, build);
        await page.waitForFunction(() => document.querySelector('#media-replay-preview img')?.naturalWidth === 512 && document.querySelector('#media-restored-chat img')?.naturalWidth === 512);
        assert.equal(await page.locator('#media-restored-chat .generated-media[data-media-id]').getAttribute('data-media-id'), transport.mediaId);
        assert.equal(await page.locator('#media-replay-preview a[download]').getAttribute('download'), 'webbrain-media.png');
        assert.equal(await page.locator('#media-replay-preview video').count(), 1);
        assert.deepEqual(errors, []);
        console.log(`${build} ${lang} ${width}: settings, live journal delivery, large inline media, replay and restored chat passed`);
        await page.close();
      }
    } finally { await browser.close(); }
  }
} finally { await new Promise(resolve => server.close(resolve)); }
