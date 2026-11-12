import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { WEBGPU_SELECTABLE_MODEL_PRESETS } from '../../src/chrome/src/providers/webgpu.js';

// Exercise installed Settings, Apocalypse and provider-menu wiring. Only cache
// readiness is a fixture; this test neither downloads nor runs model weights.
const temporaryRoot = path.resolve(os.tmpdir());
const profile = await fs.mkdtemp(path.join(temporaryRoot, 'webbrain-bonsai-ui-'));
const extension = path.resolve('src/chrome');
let context;
try {
  context = await chromium.launchPersistentContext(profile, {
    headless: true,
    channel: 'chromium',
    viewport: { width: 1280, height: 1000 },
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  });
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker', { timeout: 30000 });
  const origin = `chrome-extension://${new URL(worker.url()).host}`;
  await worker.evaluate(async () => {
    await chrome.storage.local.set({ onboardingComplete: true, wbLocale: 'en', helpImproveWebBrain: false });
    const send = chrome.runtime.sendMessage.bind(chrome.runtime);
    chrome.runtime.sendMessage = (message, callback) => {
      if (message?.type !== 'webgpu-download-status') return send(message, callback);
      const state = { modelId: message.model, dtype: message.dtype, status: 'ready', ready: true };
      callback?.(state);
      return Promise.resolve(state);
    };
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`${origin}/src/ui/settings.html#llm`);
  await page.locator('.provider-card[data-provider-id="webgpu"] .provider-header').click();
  const picker = page.locator('.model-select[data-model-for="webgpu"]');
  await picker.waitFor({ state: 'attached' });
  const ids = WEBGPU_SELECTABLE_MODEL_PRESETS.map(preset => preset.id);
  assert.deepEqual(await picker.locator('option').evaluateAll(options => options.map(option => option.value).filter(value => value !== '__custom__')), ids);
  const message = (action, data = {}) => page.evaluate(({ action, data }) => chrome.runtime.sendMessage({ target: 'background', action, ...data }), { action, data });
  for (const preset of WEBGPU_SELECTABLE_MODEL_PRESETS) {
    await picker.selectOption(preset.id, { force: true });
    assert.equal(await page.locator('input[data-provider="webgpu"][data-key="contextWindow"]').inputValue(), String(preset.contextWindow));
    await page.locator('.btn-save[data-provider="webgpu"]').click({ force: true });
    await page.waitForFunction(async id => {
      const state = await chrome.runtime.sendMessage({ target: 'background', action: 'get_providers' });
      return state.providers?.webgpu?.model === id;
    }, preset.id);
    const state = await message('get_providers');
    assert.equal(state.providers.webgpu.supportsVision, preset.supportsVision);
    assert.deepEqual(state.providers.webgpu.dtype, preset.dtype);
  }
  assert.equal((await message('set_active_provider', { providerId: 'webgpu' })).ok, true);
  const panel = await context.newPage();
  await panel.goto(`${origin}/src/ui/sidepanel.html`);
  await panel.waitForFunction(() => document.querySelector('#provider-select')?.value === 'webgpu');
  assert.ok((await panel.locator('#provider-select option[value="webgpu"]').textContent()).includes('WebGPU'));

  await message('update_provider', { providerId: 'webgpu', config: { contextWindow: 8192, promptTier: 'mid' } });
  await page.goto(`${origin}/src/ui/apocalypse-mode.html`);
  await page.waitForFunction(id => document.querySelector('[data-webgpu-text-preset]:checked')?.value === id, ids.at(-1));
  await page.waitForFunction(() => document.querySelector('[data-webgpu-download-panel]')?.dataset.state === 'ready');
  const hydrated = await message('get_providers');
  assert.equal(hydrated.providers.webgpu.contextWindow, 8192, 'opening Apocalypse must preserve a saved context budget');
  assert.equal(hydrated.providers.webgpu.promptTier, 'mid', 'opening Apocalypse must preserve a saved prompt tier');
  assert.deepEqual(await page.locator('[data-webgpu-text-preset]').evaluateAll(inputs => inputs.map(input => input.value)), ids);
  for (const preset of WEBGPU_SELECTABLE_MODEL_PRESETS) {
    await page.locator(`[data-webgpu-text-preset][value="${preset.id}"]`).check();
    await page.waitForFunction(async id => {
      const state = await chrome.runtime.sendMessage({ target: 'background', action: 'get_providers' });
      return state.providers?.webgpu?.model === id;
    }, preset.id);
    assert.ok((await page.locator('[data-webgpu-text-copy]').textContent()).includes(preset.label));
  }
  // The loop above left the last preset selected; adopt a different one.
  await message('update_provider', { providerId: 'webgpu', config: { model: ids[0], contextWindow: 4096 } });
  await page.waitForFunction(id => document.querySelector('[data-webgpu-text-preset]:checked')?.value === id, ids[0]);
  assert.equal((await message('get_providers')).providers.webgpu.contextWindow, 4096,
    'polling must adopt an external Settings selection without overwriting its context budget');
  await page.setViewportSize({ width: 390, height: 900 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  assert.deepEqual(errors, []);
  console.log('PASS: installed MV3 Settings and Apocalypse offer only the visible presets (hidden ones stay out of both pickers); saved capabilities/context/tier, external selection changes, normal provider selection, and mobile layout verified. Cache readiness was mocked; no inference performed.');
} finally {
  await context?.close();
  const resolvedProfile = path.resolve(profile);
  if (path.dirname(resolvedProfile) !== temporaryRoot || !path.basename(resolvedProfile).startsWith('webbrain-bonsai-ui-')) {
    throw new Error('Refusing to remove a profile outside the test temporary directory.');
  }
  await fs.rm(resolvedProfile, { recursive: true, force: true });
}
