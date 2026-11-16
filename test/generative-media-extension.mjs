import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright';

// Exercise Settings -> the installed MV3 background, where dynamic import fails.
// Synthetic fetch responses keep the probe free and independent of credentials.
const profile = await mkdtemp(join(tmpdir(), 'wb-media-profile-'));
let context;
try {
  const extension = resolve('src/chrome');
  context = await chromium.launchPersistentContext(profile, {
    headless: true, channel: 'chromium',
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  });
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  await worker.evaluate(() => {
    globalThis.mediaProbeCalls = [];
    globalThis.fetch = async (url, init) => {
      if (init.method && init.method !== 'GET') throw new Error('Connection test must not generate media.');
      if (init.headers?.Authorization !== 'Bearer synthetic-or-key') throw new Error('Missing authentication.');
      mediaProbeCalls.push(url);
      const body = url.endsWith('/key') ? { data: {} }
        : url.endsWith('/images/models') ? { data: [{ id: 'image-model' }, { id: 'google/gemini-2.5-flash-image' }] }
        : url.endsWith('/videos/models') ? { data: [{ id: 'minimax/hailuo-3-max' }, { id: 'x-ai/grok-imagine-video-1.5-lite' }] } : null;
      if (!body) throw new Error(`Unexpected probe URL: ${url}`);
      return new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } });
    };
  });
  const page = await context.newPage();
  const extensionId = new URL(worker.url()).host;
  await page.goto(`chrome-extension://${extensionId}/src/ui/settings.html#generative`);
  await page.waitForFunction(() => document.documentElement.dataset.settingsReady === 'true');
  await page.locator('#image-gen-provider').selectOption('openrouter');
  await page.locator('#image-gen-api-key').fill('synthetic-or-key');
  // The empty video model field shows the default it stands for.
  assert.equal(await page.locator('#image-gen-video-model').getAttribute('placeholder'), 'x-ai/grok-imagine-video-1.5-lite');
  for (const model of ['minimax/hailuo-3-max', 'image-model', 'text-only']) {
    await page.locator('#image-gen-model').fill(model);
    await page.locator('#btn-save-image-gen').click();
    await page.waitForFunction(model => document.querySelector('#test-image-gen').classList.contains('ok')
      && document.querySelector('#image-gen-model').value === model, model);
    await page.locator('#btn-test-image-gen').click();
    await page.waitForFunction(() => {
      const result = document.querySelector('#test-image-gen');
      return result.classList.contains('ok') || result.classList.contains('fail');
    });
    const status = await page.locator('#test-image-gen').textContent();
    const ok = await page.locator('#test-image-gen').evaluate(el => el.classList.contains('ok'));
    assert.equal(ok, model !== 'text-only', status);
    assert.ok(!status.includes('import()'), status);
    // A video model saved as the image model makes the videos; images use the default.
    if (model === 'minimax/hailuo-3-max') assert.match(status, /Image: google\/gemini-2\.5-flash-image · Video: minimax\/hailuo-3-max/);
    if (model === 'image-model') assert.match(status, /Image: image-model · Video: x-ai\/grok-imagine-video-1\.5-lite/);
    console.log(`${model}: ${status}`);
  }
  // Both models saved: each is checked in its own catalog.
  await page.locator('#image-gen-model').fill('image-model');
  await page.locator('#image-gen-video-model').fill('minimax/hailuo-3-max');
  await page.locator('#btn-test-image-gen').click();
  await page.waitForFunction(() => /Video: minimax/.test(document.querySelector('#test-image-gen').textContent));
  assert.deepEqual((await worker.evaluate(() => chrome.storage.local.get('imageGenModel'))).imageGenModel,
    { provider: 'openrouter', apiKey: 'synthetic-or-key', model: 'image-model', videoModel: 'minimax/hailuo-3-max' });
  const calls = await worker.evaluate(() => mediaProbeCalls);
  const probe = ['https://openrouter.ai/api/v1/key', 'https://openrouter.ai/api/v1/images/models', 'https://openrouter.ai/api/v1/videos/models'];
  assert.deepEqual(calls, [...probe, ...probe, ...probe, ...probe]);
} finally {
  await context?.close();
  await rm(profile, { recursive: true, force: true });
}
