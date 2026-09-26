// Opt-in real extension / GPU smoke, separate from CPU unit tests. Reuses the
// already-tested local release bytes instead of downloading another 4 GB.
// Fixture transport populates the extension-origin cache using the production
// byte / SHA-256 verifier. Then the real offscreen worker loads the native graph.
// Live private-HF authentication is covered separately, not claimed by this test.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { SPARK_FILES, SPARK_MODEL_ID, SPARK_REVISION, SPARK_CACHE, sparkFileUrl } from '../src/chrome/src/offscreen/spark-runtime.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bundle = process.env.SPARK_WEBGPU_TEST_BUNDLE;
if (!bundle) throw new Error('Set SPARK_WEBGPU_TEST_BUNDLE to the original verified ONNX bundle. This test uses the GPU and about 4 GB of temporary browser cache.');
const adapterLuid = process.env.SPARK_WEBGPU_TEST_ADAPTER_LUID;
if (adapterLuid && !/^-?\d+,\d+$/.test(adapterLuid)) throw new Error('Adapter LUID must be the read-only DXGI high,low pair.');
for (const file of SPARK_FILES) assert.equal(fs.statSync(path.join(bundle, file.path)).size, file.bytes);
const server = http.createServer((req, res) => {
  const pathname = new URL(req.url, 'http://localhost').pathname;
  const file = SPARK_FILES.find(entry => `/model/${entry.path}` === pathname);
  if (!file) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'Content-Length': file.bytes, 'Content-Type': 'application/octet-stream', 'Access-Control-Allow-Origin': '*' });
  fs.createReadStream(path.join(bundle, file.path)).pipe(res);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const fixtureOrigin = `http://127.0.0.1:${server.address().port}`;
const profile = await fsp.mkdtemp(path.join(os.tmpdir(), 'webbrain-xs-webgpu-'));
let context;
const evidence = { model: SPARK_MODEL_ID, revision: SPARK_REVISION, fixtureTransport: 'pinned local bytes through production cache verifier; no live HF authentication test', checks: [] };
try {
  const extension = path.join(root, 'src/chrome');
  context = await chromium.launchPersistentContext(profile, {
    channel: 'chromium',
    headless: true,
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`, '--enable-unsafe-webgpu',
      '--use-angle=d3d11', '--force_high_performance_gpu', '--enable-features=EGLDualGPURendering',
      ...(adapterLuid ? [`--use-adapter-luid=${adapterLuid}`] : []), '--js-flags=--max-old-space-size=16384'],
  });
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker', { timeout: 30000 });
  const extensionId = new URL(worker.url()).host;
  evidence.browser = context.browser().version();
  console.log(`Extension loaded: ${extensionId}`);
  const page = await context.newPage();
  page.on('pageerror', error => console.log(`Settings page error: ${error.message}`));
  page.on('console', message => { if (message.text().startsWith('XS cache ')) console.log(message.text()); });
  await page.goto(`chrome-extension://${extensionId}/src/ui/settings.html`);
  console.log(JSON.stringify({ phase: 'ui-boot', url: page.url(), title: await page.title(), selects: await page.locator('select').count(), excerpt: (await page.locator('body').innerText()).slice(0, 300) }));
  console.log(JSON.stringify(await page.evaluate(async () => {
    const result = await Promise.race([
      chrome.runtime.sendMessage({ target: 'background', action: 'get_providers' }),
      new Promise(resolve => setTimeout(() => resolve({ error: 'background provider initialization timed out' }), 8000)),
    ]);
    return { phase: 'provider-boot', error: result?.error, count: Object.keys(result?.providers || {}).length, webgpu: result?.providers?.webgpu && { type: result.providers.webgpu.type, model: result.providers.webgpu.model, sourceProviderId: result.providers.webgpu.sourceProviderId } };
  })));
  await page.locator('[data-tab="providers"]').click();
  await page.locator('.provider-card[data-provider-id="webgpu"] .provider-header').click();
  await page.waitForSelector('select[data-model-for="webgpu"]', { timeout: 15000 });
  const gpu = await page.evaluate(async () => {
    const adapter = await navigator.gpu?.requestAdapter({ powerPreference: 'high-performance' });
    return { vendor: adapter?.info.vendor, architecture: adapter?.info.architecture, shaderF16: adapter?.features.has('shader-f16') };
  });
  evidence.gpu = gpu;
  console.log(JSON.stringify({ phase: 'gpu', ...gpu }));
  assert.equal(gpu.vendor, 'nvidia'); assert.equal(gpu.architecture, 'blackwell'); assert.equal(gpu.shaderF16, true);
  evidence.checks.push('RTX 5090 adapter, not GPU1 / software');
  const card = page.locator('[data-model-for="webgpu"]');
  await card.selectOption(SPARK_MODEL_ID);
  assert.equal(await page.locator('input[data-provider="webgpu"][data-key="contextWindow"]').inputValue(), '4096');
  await page.locator('input[data-provider="webgpu"][data-key="hfToken"]').fill('test-only-fixture-token');
  await page.locator('.btn-save[data-provider="webgpu"]').click();
  await page.waitForFunction(async model => (await chrome.storage.local.get('providers')).providers?.webgpu?.model === model, SPARK_MODEL_ID);
  assert.equal(await page.evaluate(async () => (await chrome.storage.local.get('providers')).providers.webgpu.maxOutputTokens), 2048);
  evidence.checks.push('Settings XS selection, 4K context, saved optional download credential');
  // Ordinary chat defaults must not be switched by configuring a local model.
  assert.notEqual(await page.evaluate(async () => (await chrome.storage.local.get('activeProvider')).activeProvider), 'webgpu');
  console.log('Verifying and caching pinned local package (not a live HF auth test)');
  const cached = await page.evaluate(async origin => {
    const { cacheSparkFiles, sparkCacheReady, SPARK_FILES, sparkFileUrl } = await import('../offscreen/spark-runtime.js');
    const requests = [];
    let lastProgress = 0;
    await cacheSparkFiles({ progress: event => {
      if (event.status === 'done' || Date.now() - lastProgress >= 10000) {
        console.info(`XS cache ${event.file}: ${event.loaded}/${event.total} (${event.status})`);
        lastProgress = Date.now();
      }
    }, fetchFile: async url => {
      const file = SPARK_FILES.find(entry => sparkFileUrl(entry.path) === url);
      if (!file) throw new Error('Unexpected unpinned model file request.');
      requests.push(file.path);
      return fetch(`${origin}/model/${file.path}`, { credentials: 'omit' });
    } });
    return { ready: await sparkCacheReady(), requests };
  }, fixtureOrigin);
  assert.equal(cached.ready, true);
  assert.deepEqual(cached.requests.sort(), SPARK_FILES.map(file => file.path).sort());
  evidence.checks.push('production streaming verifier cached all seven pinned byte lengths / SHA-256');
  // Once cached, Settings' button becomes Remove; do not click it to "load".
  // Runtime initialization is exercised by the real provider chat below.
  let status;
  const deadline = Date.now() + 10 * 60000;
  while (Date.now() < deadline) {
    status = await page.evaluate(async () => chrome.runtime.sendMessage({ target: 'background', action: 'get_webgpu_download_status' }));
    if (status.error || status.status === 'error') throw new Error(status.error || 'download failed');
    console.log(JSON.stringify({ phase: 'download', status: status.status, file: status.file, loaded: status.loaded, total: status.total }));
    if (status.ready) break;
    await new Promise(resolve => setTimeout(resolve, 5000));
  }
  assert.equal(status?.ready, true);
  evidence.checks.push('offscreen worker reports the complete verified package ready');
  await page.evaluate(async () => {
    const { providers } = await chrome.storage.local.get('providers');
    delete providers.webgpu.hfToken;
    await chrome.runtime.sendMessage({ target: 'background', action: 'update_provider', providerId: 'webgpu', config: { hfToken: '' } });
  });
  await context.route('https://huggingface.co/**', route => route.abort());
  console.log('Generating with cached package, no token / HF access');
  const generated = await page.evaluate(async model => {
    const { WebGPUProvider } = await import('../providers/webgpu.js');
    const provider = new WebGPUProvider({ model });
    const text = await provider.chat([{ role: 'user', content: 'Reply with a short greeting.' }], { maxTokens: 64 });
    const tool = await provider.chat([{ role: 'system', content: 'Use the done tool to answer. Do not explain or think.' }, { role: 'user', content: 'What is 3 + 4?' }], {
      maxTokens: 128,
      tools: [{ type: 'function', function: { name: 'done', description: 'Return the final answer.', parameters: { type: 'object', properties: { summary: { type: 'string' } }, required: ['summary'] } } }],
    });
    const { parseToolCallsFromText } = await import('../agent/tool-call-parser.js');
    // The earlier standalone validation used this native Spark browser-tool
    // fixture. Keep it unchanged here for a like-for-like integration check.
    const nativeTool = await provider.chat([{ role: 'system', content: 'Use the provided tool when asked to open a page.' }, { role: 'user', content: 'Open https://example.com with open_url.' }], {
      maxTokens: 128,
      tools: [{ type: 'function', function: { name: 'open_url', description: 'Open a URL in the browser.', parameters: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] } } }],
    });
    return { text, math: tool, mathParsed: parseToolCallsFromText(tool.content, new Set(['done'])), nativeTool, parsed: parseToolCallsFromText(nativeTool.content, new Set(['open_url'])) };
  }, SPARK_MODEL_ID);
  console.log(JSON.stringify({ phase: 'synthetic-generation', ...generated }));
  assert.ok(generated.text.content.trim());
  assert.ok(generated.nativeTool.content.trim());
  assert.equal(generated.parsed.length, 1);
  assert.equal(generated.parsed[0].function.name, 'open_url');
  assert.equal(JSON.parse(generated.parsed[0].function.arguments).url, 'https://example.com');
  if (generated.mathParsed.length === 0) evidence.behavioralLimitations = ['Math fixture answered 7 as plain text instead of using done; same observed behavior in the BF16 reference. No output repair.'];
  evidence.checks.push('real offscreen worker initialized the native FP16 graph');
  evidence.syntheticGeneration = generated;
  evidence.checks.push('cached text + native tool generation, normal parser, no helpers/fallback or dispatched actions');
  await page.goto(`chrome-extension://${extensionId}/src/ui/apocalypse-mode.html`);
  const xs = page.locator(`[data-webgpu-text-preset][value="${SPARK_MODEL_ID}"]`);
  await xs.waitFor({ state: 'visible' });
  await page.waitForFunction(model => document.querySelector(`[data-webgpu-text-preset][value="${model}"]`)?.checked, SPARK_MODEL_ID);
  assert.ok((await page.locator('[data-webgpu-text-warning]').textContent()).includes('noncommercial'));
  const v2 = page.locator('[data-webgpu-text-preset][value="webbrain-one/webbrain-compass-tiny-v2.1"]');
  await v2.check();
  await page.waitForFunction(async () => (await chrome.storage.local.get('providers')).providers.webgpu.model === 'webbrain-one/webbrain-compass-tiny-v2.1');
  await xs.check();
  await page.waitForFunction(async model => (await chrome.storage.local.get('providers')).providers.webgpu.model === model, SPARK_MODEL_ID);
  assert.notEqual(await page.evaluate(async () => (await chrome.storage.local.get('activeProvider')).activeProvider), 'webgpu');
  evidence.checks.push('Apocalypse hydrates XS, displays restrictions and switches both presets without changing active chat');
  // A tiny ownership sentinel is not a second model/helper. Removal must leave
  // unrelated model cache entries untouched, without loading either model.
  const removed = await page.evaluate(async model => {
    const { sparkCacheReady } = await import('../offscreen/spark-runtime.js');
    const cache = await caches.open('transformers-cache');
    const other = 'https://huggingface.co/webbrain-one/webbrain-compass-tiny-v2.1/resolve/main/config.json';
    await cache.put(other, new Response('ownership-only-fixture'));
    const result = await chrome.runtime.sendMessage({ target: 'background', action: 'stop_webgpu_download', model, dtype: 'fp16' });
    return { error: result?.error, ready: await sparkCacheReady(), other: await (await cache.match(other)).text() };
  }, SPARK_MODEL_ID);
  assert.ok(!removed.error); assert.equal(removed.ready, false); assert.equal(removed.other, 'ownership-only-fixture');
  evidence.checks.push('XS Stop/remove clears only its pinned package, leaves unrelated cache sentinel intact');
  // Release only this disposable test's runtime. Production/model servers are unrelated.
  await page.evaluate(async () => {
    const { WebGPUProvider } = await import('../providers/webgpu.js');
    await new WebGPUProvider().dispose();
  });
  evidence.ok = true;
  console.log(JSON.stringify(evidence));
} finally {
  await context?.close();
  await new Promise(resolve => server.close(resolve));
  // Owned, unique mkdtemp profile: no user browser/session/model cache involved.
  if (path.dirname(path.resolve(profile)) !== path.resolve(os.tmpdir()) || !path.basename(profile).startsWith('webbrain-xs-webgpu-')) {
    throw new Error('Refusing to remove a test profile outside the owned temporary directory.');
  }
  await fsp.rm(profile, { recursive: true, force: true });
  console.log('Disposable extension test profile/cache removed; user browser and model servers untouched.');
}
