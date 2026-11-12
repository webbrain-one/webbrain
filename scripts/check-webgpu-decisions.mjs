// Hardware eval for on-device decisions through the real extension: the d1
// decision model (Settings fixture path, d1 worker) and the in-browser chat
// models' decision readouts (Compass VLD Tiny v5 or Ternary Bonsai 2 2B
// Vision, offscreen WebGPU worker). They answer the same labelled questions,
// so accuracy, calibration and latency are comparable. See
// docs/webgpu-models.md.
//
//   node scripts/check-webgpu-decisions.mjs --test <final_test.json> --images <dir> \
//     --engines d1,compass-vld --profile .build/decisions/profile --download \
//     --adapter-luid 0,82094 --output .build/decisions/result.json
//
// --extension DIR   unpacked extension (default src/chrome). Use a fresh
//                   --profile per build: a persistent profile keeps the old
//                   service worker (docs/webgpu-models.md).
// --engines LIST    any of d1, compass-vld (Compass VLD Tiny v5) and bonsai
//                   (Ternary Bonsai 2 2B Vision); default d1,compass-vld
// --model ID        another in-browser chat model for a single chat engine
// --stress          also run long text states with many questions through d1,
//                   the case where dense attention memory used to grow
// --limit N         first N test requests only
// --temperature T   chat-model readout temperature (default 1)
// --prompt NAME     chat-model decision mode: probe (default, what Settings
//                   uses), readout, strict or verify
// --decoder-graph F install a replacement Bonsai decoder graph in the cache first
// --refresh         download a cached model again first, the Settings path
//                   that replaces a stale decoder graph by hash
// --cancel-check    after the run, cancel decisions in the offscreen worker
//                   (mid-run and before dispatch) and time the next one
// --return-hidden   with --prompt verify, record each option's hidden state
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { scoreAnswers, questionsOf } from './models/d1/decision-metrics.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const option = (name, fallback) => { const i = args.indexOf(name); return i < 0 ? fallback : args[i + 1]; };
const extension = path.resolve(option('--extension', path.join(root, 'src/chrome')));
const profile = path.resolve(option('--profile', '.build/decisions/profile'));
const output = path.resolve(option('--output', '.build/decisions/result.json'));
const engines = option('--engines', 'd1,compass-vld').split(',');
const CHAT_ENGINES = {
  'compass-vld': 'webbrain-one/webbrain-compass-vld-tiny-v5-onnx',
  bonsai: 'webbrain-one/Ternary-Bonsai-2-2B-ONNX-WebGPU-Vision',
};
const chatEngines = engines.filter(name => Object.hasOwn(CHAT_ENGINES, name));
if (option('--model', '') && chatEngines.length !== 1) throw new Error('--model replaces the model of a single chat engine');
const test = JSON.parse(await fs.readFile(option('--test'), 'utf8'));
const requests = test.requests.slice(0, Number(option('--limit', test.requests.length)));
const imageDir = option('--images');

const percentile = (values, p) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] : null;
};
const timing = values => ({ n: values.length, p50: percentile(values, 0.5), p95: percentile(values, 0.95), max: Math.max(...values) });
const dataUrl = async file => `data:image/png;base64,${(await fs.readFile(path.join(imageDir, path.basename(file)))).toString('base64')}`;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

await fs.mkdir(path.dirname(output), { recursive: true });
const result = { extension, startedAt: new Date().toISOString(), requests: requests.length, engines: {} };
let context;
try {
  context = await chromium.launchPersistentContext(profile, {
    headless: true,
    channel: 'chromium',
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`,
      '--enable-unsafe-webgpu', '--force-high-performance-gpu',
      ...(option('--adapter-luid', '') ? [`--use-adapter-luid=${option('--adapter-luid')}`] : [])],
  });
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker', { timeout: 30000 });
  const id = new URL(worker.url()).host;
  const harness = await context.newPage();
  // Decision fixtures and D1 controls answer only the Settings page.
  await harness.goto(`chrome-extension://${id}/src/ui/settings.html#decision`);
  const message = (action, data = {}) => harness.evaluate(({ action, data }) => chrome.runtime.sendMessage({ target: 'background', action, ...data }), { action, data });
  await harness.evaluate(() => chrome.storage.local.set({ onboardingComplete: true, wbLocale: 'en', helpImproveWebBrain: false }));
  result.extensionVersion = await harness.evaluate(() => chrome.runtime.getManifest().version);
  result.adapter = await harness.evaluate(async () => {
    const adapter = await navigator.gpu?.requestAdapter({ powerPreference: 'high-performance' });
    return adapter ? { vendor: adapter.info.vendor, architecture: adapter.info.architecture, description: adapter.info.description, maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize } : null;
  });
  console.log('adapter', JSON.stringify(result.adapter));

  const run = async (name, ask) => {
    const answers = {}, seconds = [], errors = [], diagnostics = [];
    for (const [index, request] of requests.entries()) {
      const images = await Promise.all(request.images.map(dataUrl));
      const started = Date.now();
      try {
        const reply = await ask({ state: request.state, images, questions: questionsOf(request) });
        if (!reply?.success) throw new Error(reply?.error || 'no reply');
        Object.assign(answers, reply.result.answers);
        if (reply.result.diagnostics) diagnostics.push({ id: request.id, ...reply.result.diagnostics });
        if (index > 0) seconds.push((Date.now() - started) / 1000);
        else result.engines[name] = { coldSeconds: (Date.now() - started) / 1000 };
      } catch (error) {
        errors.push({ id: request.id, error: String(error?.message || error) });
      }
      if (index % 12 === 0) console.log(name, index, request.id, `${(Date.now() - started) / 1000}s`, errors.at(-1)?.error || '');
    }
    const summary = { ...(result.engines[name] || {}), ...scoreAnswers(requests, answers), latencySecondsPerRequest: timing(seconds), errors, answers, diagnostics };
    result.engines[name] = summary;
    console.log(name, JSON.stringify({ categorical: summary.categorical, completion: summary.completion, unknown: summary.unknown, scoreMae: summary.scoreMae, meanTruthProbability: summary.meanTruthProbability, latency: summary.latencySecondsPerRequest, errors: errors.length }));
    return summary;
  };

  if (engines.includes('d1')) {
    await harness.evaluate(() => chrome.storage.local.set({ decisionProvider: 'webgpu_d1', systemOneEnabled: true, decisionVisionMode: 'on', systemOneDoneEnabled: false }));
    const control = (command) => message('d1_control', { command, consent: true, consentVersion: 1 });
    let status = (await control('status')).result;
    if (!status?.ready) {
      const started = Date.now();
      const first = await control(status?.status === 'cached' ? 'load' : 'download');
      if (!first.success) throw new Error(`d1 ${status?.status === 'cached' ? 'load' : 'download'} failed: ${first.error}`);
      while (!status?.ready) {
        await sleep(5000);
        status = (await control('status')).result;
        console.log('d1', JSON.stringify(status).slice(0, 200));
        if (status?.status === 'error') throw new Error(`d1 failed: ${status.error}`);
        if (status?.status === 'cached') { const loaded = await control('load'); if (!loaded.success) throw new Error(loaded.error); }
        if (Date.now() - started > 60 * 60_000) throw new Error('d1 did not become ready within an hour');
      }
      result.d1LoadSeconds = (Date.now() - started) / 1000;
    }
    result.d1Status = status;
    await run('d1', fixture => message('test_system_one', { localFixture: fixture }));
    if (args.includes('--stress')) {
      const stress = [];
      const sentence = index => `Row ${index}: order ${1000 + index} for customer C-${index % 97} is ${index % 5 ? 'shipped' : 'pending review'} with total ${index * 3}.17 EUR. `;
      for (const tokensWanted of [1000, 2000, 4000, 8000]) {
        const state = Array.from({ length: Math.ceil(tokensWanted / 30) }, (_, index) => sentence(index)).join('');
        const questions = Object.fromEntries(Array.from({ length: 16 }, (_, index) => [`q${index}`, { type: 'noul', instructions: `Is order ${1000 + index * 7} pending review?` }]));
        const started = Date.now();
        const reply = await message('test_system_one', { localFixture: { state, questions } });
        const entry = { approxTokens: tokensWanted, questions: 16, seconds: (Date.now() - started) / 1000, ok: !!reply?.success, error: reply?.success ? undefined : reply?.error };
        stress.push(entry);
        console.log('stress', JSON.stringify(entry));
      }
      result.engines.d1.stress = stress;
    }
    await control('reset');
  }

  for (const engine of chatEngines) {
    const chatModel = option('--model', CHAT_ENGINES[engine]);
    const webgpu = await import('../src/chrome/src/providers/webgpu.js');
    const preset = webgpu.webgpuModelPreset(chatModel);
    await message('update_provider', { providerId: 'webgpu', config: { model: chatModel, dtype: preset.dtype } });
    let status = await message('get_webgpu_download_status', { model: chatModel });
    if (!status?.ready) {
      if (!args.includes('--download')) throw new Error(`${chatModel} is not cached in this profile; rerun with --download`);
      await message('start_webgpu_download', { model: chatModel });
      const started = Date.now();
      while (!status?.ready) {
        await sleep(5000);
        status = await message('get_webgpu_download_status', { model: chatModel });
        if (status?.error) throw new Error(`Download failed: ${status.error}`);
        if (Date.now() - started > 60 * 60_000) throw new Error('Download did not finish within an hour');
      }
    }
    if (status?.ready && args.includes('--refresh')) {
      const started = Date.now();
      const refreshed = await message('start_webgpu_download', { model: chatModel });
      if (!refreshed || refreshed.error || refreshed.success === false) throw new Error(`Refresh failed: ${refreshed?.error}`);
      do {
        await sleep(2000);
        status = await message('get_webgpu_download_status', { model: chatModel });
        if (status?.error) throw new Error(`Refresh failed: ${status.error}`);
        if (Date.now() - started > 10 * 60_000) throw new Error('Refresh did not finish within ten minutes');
      } while (!status?.ready || status?.status === 'downloading');
      result.refreshSeconds = (Date.now() - started) / 1000;
    }
    const graphFile = engine === 'bonsai' ? option('--decoder-graph', '') : '';
    if (graphFile) {
      // Replace the cached decoder graph (same external weights) before the
      // worker first loads the model, e.g. one that exposes decision_hidden.
      const data = (await fs.readFile(graphFile)).toString('base64');
      await harness.evaluate(async ({ url, data }) => {
        const bytes = Uint8Array.from(atob(data), c => c.charCodeAt(0));
        const cache = await caches.open('transformers-cache');
        await cache.put(url, new Response(bytes, { headers: { 'content-type': 'application/octet-stream', 'content-length': String(bytes.length) } }));
      }, { url: `https://huggingface.co/${chatModel}/resolve/main/onnx/decoder_model_merged_q2f16.onnx`, data });
      result.decoderGraph = graphFile;
    }
    if (engine === 'bonsai') result.cachedDecoderGraphSha256 = await harness.evaluate(async url => {
      const cached = await (await caches.open('transformers-cache')).match(url);
      if (!cached) return null;
      const digest = await crypto.subtle.digest('SHA-256', await cached.arrayBuffer());
      return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
    }, `https://huggingface.co/${chatModel}/resolve/main/onnx/decoder_model_merged_q2f16.onnx`);
    if (engine === 'bonsai') console.log('cached decoder graph', result.cachedDecoderGraphSha256);
    const temperature = Number(option('--temperature', 1));
    const promptVariant = option('--prompt', 'probe');
    const returnHidden = args.includes('--return-hidden');
    await run(engine, fixture => message('webgpu_decide_fixture', { fixture: { ...fixture, temperature, promptVariant, returnHidden } }));
    if (args.includes('--cancel-check')) {
      // Cancellation in the offscreen host and worker: a decision cancelled
      // while it runs should end early and free the queue for the next one.
      const request = requests.at(-1);
      const base = { model: chatModel, runtime: 'onnx-vl', device: 'webgpu', dtype: preset.dtype, state: request.state, images: await Promise.all(request.images.map(dataUrl)), questions: questionsOf(request), promptVariant };
      result.engines[engine].cancelCheck = await harness.evaluate(async ({ base, delayMs }) => {
        const send = message => new Promise(resolve => chrome.runtime.sendMessage(message, resolve));
        const timed = async run => { const started = performance.now(); const reply = await run(); return { ok: reply?.ok !== false && !reply?.error, error: reply?.error || null, ms: Math.round(performance.now() - started) }; };
        const full = await timed(() => send({ ...base, type: 'webgpu-decide', decisionId: 'cancel-check-full' }));
        const cancelled = await timed(async () => {
          const reply = send({ ...base, type: 'webgpu-decide', decisionId: 'cancel-check-mid' });
          await new Promise(resolve => setTimeout(resolve, delayMs));
          send({ type: 'webgpu-decide-cancel', decisionId: 'cancel-check-mid' });
          return reply;
        });
        const next = await timed(() => send({ ...base, type: 'webgpu-decide', decisionId: 'cancel-check-next' }));
        await send({ type: 'webgpu-decide-cancel', decisionId: 'cancel-check-early' });
        const early = await timed(() => send({ ...base, type: 'webgpu-decide', decisionId: 'cancel-check-early' }));
        return { delayMs, full, cancelled, next, early };
      }, { base, delayMs: 300 });
      console.log('cancel check', JSON.stringify(result.engines[engine].cancelCheck));
    }
    if (promptVariant === 'probe' && chatModel === webgpu.WEBGPU_DECISION_MODEL_ID) {
      // The decision provider path Settings uses: judge -> provider -> worker.
      const started = Date.now();
      const tested = await message('test_system_one', { settings: { decisionMode: 'on', decisionProvider: 'webgpu_chat', systemOneEnabled: true, decisionVisionMode: 'on' } });
      result.engines[engine].settingsTest = { ...tested, seconds: (Date.now() - started) / 1000 };
      console.log('settings test', JSON.stringify(result.engines[engine].settingsTest));
    }
  }
} catch (error) {
  result.error = String(error?.stack || error);
  console.error(error);
  process.exitCode = 1;
} finally {
  result.finishedAt = new Date().toISOString();
  await fs.writeFile(output, JSON.stringify(result, null, 2));
  await context?.close().catch(() => {});
}
console.log(`wrote ${output}`);
process.exit(process.exitCode ?? 0);
