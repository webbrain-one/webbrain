import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import vm from 'node:vm';

// One top-level function of a source file, by name.
function topLevelFunction(source, name) {
  const start = source.search(new RegExp(`^(?:async )?function ${name}\\(`, 'm'));
  assert.ok(start >= 0, name);
  const end = source.indexOf('\n}\n', start);
  assert.ok(end > start, name);
  return source.slice(start, end + 2);
}

// D1 as its Worker leaves a finished download: the stored Load request and the
// package's ready marker in its OPFS directory. `marker`: 'current', another
// marker object, 'missing' (no ready.json) or 'no-directory'.
async function withD1Download(pin, { stored = {}, marker = 'current' } = {}, fn) {
  const saved = { navigator: Object.getOwnPropertyDescriptor(globalThis, 'navigator'), chrome: globalThis.chrome, browser: globalThis.browser };
  const reads = [];
  const area = { ...stored };
  const local = {
    get: async keys => Object.fromEntries((keys == null ? Object.keys(area) : Array.isArray(keys) ? keys : [keys]).filter(key => key in area).map(key => [key, area[key]])),
    set: async values => { Object.assign(area, values); },
  };
  const api = { storage: { local } };
  const directory = {
    async getFileHandle(name, options) {
      reads.push(['file', name, options]);
      if (marker === 'missing') throw Object.assign(new Error('missing'), { name: 'NotFoundError' });
      const value = marker === 'current' ? { revision: pin.D1_RELEASE.revision, manifestSha256: pin.D1_RELEASE.manifestSha256 } : marker;
      return { getFile: async () => ({ text: async () => JSON.stringify(value) }) };
    },
  };
  const root = {
    async getDirectoryHandle(name, options) {
      reads.push(['directory', name, options]);
      if (marker === 'no-directory') throw Object.assign(new Error('missing'), { name: 'NotFoundError' });
      return directory;
    },
  };
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { storage: { getDirectory: async () => root } } });
  globalThis.chrome = api; globalThis.browser = api;
  try { return await fn({ api, area, reads }); } finally {
    if (saved.navigator) Object.defineProperty(globalThis, 'navigator', saved.navigator); else delete globalThis.navigator;
    globalThis.chrome = saved.chrome; globalThis.browser = saved.browser;
  }
}

for (const build of ['chrome', 'firefox']) {
  const config = await import(`../src/${build}/src/agent/decision-config.js`);
  const availability = await import(`../src/${build}/src/agent/decision-availability.js`);
  const pin = await import(`../src/${build}/src/providers/d1-config.js`);
  const runtime = await import(`../src/${build}/src/providers/d1-runtime.js`);
  const preprocess = await import(`../src/${build}/src/providers/d1-preprocess.js`);
  const cache = await import(`../src/${build}/src/providers/d1-cache.js`);
  const completion = await import(`../src/${build}/src/agent/completion-verifier.js`);
  const transfer = await import(`../src/${build}/src/config-transfer.js`);
  const diagnostic = await import(`../src/${build}/src/providers/d1-diagnostic.js`);
  const judge = await import(`../src/${build}/src/agent/systemone-judge.js`);
  test(`${build}: isolated ORT loader uses its native asyncify ABI with checksum-exact assets`, async () => {
    const worker = await readFile(new URL(`../src/${build}/src/providers/d1-worker.js`, import.meta.url), 'utf8');
    const bundle = await readFile(new URL(`../src/${build}/vendor/d1/ort.webgpu.bundle.min.mjs`, import.meta.url), 'utf8');
    const factory = await readFile(new URL(`../src/${build}/vendor/d1/ort-wasm-simd-threaded.asyncify.mjs`, import.meta.url), 'utf8');
    const oldFactory = await readFile(new URL(`../src/${build}/vendor/d1/ort-wasm-simd-threaded.jsep.mjs`, import.meta.url), 'utf8');
    const manifest = JSON.parse(await readFile(new URL(`../src/${build}/vendor/d1/vendor-manifest.json`, import.meta.url), 'utf8'));
    assert.match(bundle, /webgpuInit/); assert.match(bundle, /ort-wasm-simd-threaded\.asyncify\.mjs/);
    assert.match(factory, /webgpuInit/); assert.doesNotMatch(factory, /jsepInit/);
    assert.match(oldFactory, /jsepInit/); assert.doesNotMatch(oldFactory, /webgpuInit/);
    assert.match(worker, /mjs: new URL\('\.\.\/\.\.\/vendor\/d1\/ort-wasm-simd-threaded\.asyncify\.mjs'/);
    assert.match(worker, /wasm: new URL\('\.\.\/\.\.\/vendor\/d1\/ort-wasm-simd-threaded\.asyncify\.wasm'/);
    assert.doesNotMatch(worker, /ort-wasm-simd-threaded\.jsep/);
    assert.equal(manifest.loader_abi.required_factory_api, 'webgpuInit');
    for (const entry of manifest.files) {
      const bytes = await readFile(new URL(`../src/${build}/vendor/d1/${entry.file}`, import.meta.url));
      assert.equal(bytes.length, entry.copied_bytes); assert.equal(createHash('sha256').update(bytes).digest('hex'), entry.copied_sha256);
      if (entry.byte_exact) assert.equal(entry.source.sha256, entry.copied_sha256);
    }
  });
  test(`${build}: worker preserves a load error rather than claiming a cached model is ready`, async () => {
    const oldNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
    const oldSelf = Object.getOwnPropertyDescriptor(globalThis, 'self');
    const messages = [];
    let cacheReads = 0;
    const directory = { getFileHandle: async () => ({ getFile: async () => ({ text: async () => JSON.stringify({ revision: pin.D1_RELEASE.revision, manifestSha256: pin.D1_RELEASE.manifestSha256 }) }) }) };
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { storage: { getDirectory: async () => { cacheReads++; return { getDirectoryHandle: async () => directory }; } } } });
    Object.defineProperty(globalThis, 'self', { configurable: true, value: { postMessage: message => messages.push(message) } });
    try {
      await import(`../src/${build}/src/providers/d1-worker.js?cpu-error-status`);
      self.onmessage({ data: { id: 1, type: 'download', payload: { consentVersion: pin.D1_CONSENT_VERSION } } });
      await new Promise(resolve => setTimeout(resolve, 0));
      assert.ok(messages.some(message => message.state?.status === 'error'));
      self.onmessage({ data: { id: 2, type: 'status' } });
      await new Promise(resolve => setTimeout(resolve, 0));
      const result = messages.find(message => message.id === 2).result;
      assert.equal(result.status, 'error'); assert.equal(result.ready, false); assert.equal(result.loaded, false);
      assert.match(result.error, /Hardware WebGPU/);
      // The error stays, but the verified cache is reported so the Providers page can retry with Load.
      assert.equal(result.cached, true); assert.equal(cacheReads, 1);
    } finally {
      if (oldNavigator) Object.defineProperty(globalThis, 'navigator', oldNavigator); else delete globalThis.navigator;
      if (oldSelf) Object.defineProperty(globalThis, 'self', oldSelf); else delete globalThis.self;
    }
  });
  test(`${build}: fixture diagnostics require the Settings page, stored selected consent and normal typed evaluation`, async () => {
    const settings = { decisionProvider: 'webgpu_d1', systemOneEnabled: true, [pin.D1_CONSENT_KEY]: pin.D1_CONSENT_VERSION };
    const api = { runtime: { id: 'extension-id', getURL: path => 'chrome-extension://extension-id/' + path }, storage: { local: { get: async () => settings } } };
    const sender = { id: api.runtime.id, url: api.runtime.getURL('src/ui/settings.html') + '#decision' };
    const fixture = { state: 'Exact original state', images: ['data:image/png;base64,YQ=='], questions: { q: { type: 'noul', instructions: 'Is blue visible?' } } };
    const client = {};
    const response = { model: pin.D1_MODEL_ID, provider: 'webgpu_d1', answers: { q: { type: 'noul', noul: .75 } }, usage: { input_tokens: 12, output_tokens: 0 } };
    let calls = 0;
    const agent = { evaluateSystemOne: async (tabId, actualClient, args) => { calls++; assert.equal(tabId, null); assert.equal(actualClient, client); assert.equal(args.state, fixture.state); assert.equal(args.images, fixture.images); assert.equal(args.questions, fixture.questions); assert.equal(args.config.provider, 'webgpu_d1'); return response; } };
    const args = { fixture, sender, api, strictSecretMode: false, agent, client };
    assert.equal(await diagnostic.evaluateD1LocalFixture(args), response);
    assert.equal(calls, 1);
    for (const badSender of [{ ...sender, id: 'other-id' }, { ...sender, url: 'https://example.com/' }, { ...sender, url: api.runtime.getURL('src/ui/popup.html') }, { ...sender, url: api.runtime.getURL('src/ui/providers.html') }]) await assert.rejects(diagnostic.evaluateD1LocalFixture({ ...args, sender: badSender }), /only from the extension Settings page/);
    await assert.rejects(diagnostic.evaluateD1LocalFixture({ ...args, strictSecretMode: true }), /Strict Secret/);
    for (const stored of [{ ...settings, decisionProvider: 'compass' }, { ...settings, systemOneEnabled: false }, { ...settings, [pin.D1_CONSENT_KEY]: 0 }]) await assert.rejects(diagnostic.evaluateD1LocalFixture({ ...args, api: { ...api, storage: { local: { get: async () => stored } } } }), /Select, enable/);
    assert.equal(calls, 1);
    await assert.rejects(diagnostic.evaluateD1LocalFixture({ ...args, api: { ...api, storage: { local: { get: async () => ({ ...settings, decisionVisionMode: 'off' }) } } } }), /Enable local D1 vision/);
    await assert.rejects(diagnostic.evaluateD1LocalFixture({ ...args, agent: { evaluateSystemOne: async () => ({ ...response, usage: { input_tokens: 12, output_tokens: 1 } }) } }), /Invalid local D1 fixture response/);
    await assert.rejects(diagnostic.evaluateD1LocalFixture({ ...args, agent: { evaluateSystemOne: async () => ({ ...response, answers: { q: { type: 'noul', noul: 1.5 } } }) } }), /probability/);
  });
  test(`${build}: SW-reachable D1 modules use static imports and diagnostic branch leaves normal connection test intact`, async () => {
    for (const path of ['providers/d1.js', 'providers/d1-diagnostic.js', 'providers/d1-host.js', 'agent/systemone-judge.js']) {
      const source = await readFile(new URL(`../src/${build}/src/${path}`, import.meta.url), 'utf8');
      assert.doesNotMatch(source, /\bimport\s*\(/, path);
    }
    const background = await readFile(new URL(`../src/${build}/src/background.js`, import.meta.url), 'utf8');
    const branch = background.slice(background.indexOf("case 'test_system_one':"), background.indexOf("case 'test_captcha_provider_balance':"));
    assert.match(branch, /await strictSecretModeReady/);
    assert.match(branch, /Object\.hasOwn\(msg, 'localFixture'\)/);
    assert.match(branch, /return \{ success: true, result \}/);
    assert.ok(branch.indexOf('evaluateD1LocalFixture') < branch.indexOf('let config = msg.settings'));
    assert.match(branch, /Decision connection test was inconclusive/);
  });
  test(`${build}: actual typed Judge dispatches a local text/image fixture without HTTP or dynamic imports`, async () => {
    const saved = { chrome: globalThis.chrome, browser: globalThis.browser, Worker: globalThis.Worker };
    const questions = { q: { type: 'noul', instructions: 'Is blue visible?' } };
    const state = 'Original source state', images = ['data:image/png;base64,YQ=='];
    const result = { model: pin.D1_MODEL_ID, provider: 'webgpu_d1', answers: { q: { type: 'noul', noul: .75 } }, usage: { input_tokens: 12, output_tokens: 0 } };
    let sends = 0, usages = 0;
    const receive = message => { sends++; assert.equal(message.command || message.type, 'evaluate'); assert.equal(message.payload.state, state); assert.deepEqual(message.payload.images, images); assert.deepEqual(message.payload.questions, questions); return result; };
    const api = { storage: { local: { get: async () => ({ [pin.D1_CONSENT_KEY]: pin.D1_CONSENT_VERSION }) } }, runtime: { getURL: path => 'chrome-extension://test/' + path, sendMessage: async message => ({ ok: true, result: receive(message) }) } };
    if (build === 'chrome') api.offscreen = { createDocument: async () => { throw new Error('Existing host must be reused'); }, hasDocument: async () => true };
    globalThis.chrome = api; globalThis.browser = build === 'firefox' ? api : undefined;
    globalThis.Worker = class { postMessage(message) { const response = receive(message); queueMicrotask(() => this.onmessage({ data: { id: message.id, ok: true, result: response } })); } terminate() {} };
    try {
      const selected = config.resolveDecisionConfig({ decisionProvider: 'webgpu_d1', systemOneEnabled: true, [pin.D1_CONSENT_KEY]: pin.D1_CONSENT_VERSION });
      const response = await judge.createSystemOneJudge({ fetchImpl: () => { throw new Error('No cloud request'); }, maxRetries: 0 }).evaluate({ state, images, questions, config: selected, onUsage: metadata => { usages++; assert.equal(Object.hasOwn(metadata, 'answers'), false); } });
      assert.deepEqual(response.answers, result.answers); assert.equal(response.usage.output_tokens, 0); assert.equal(sends, 1); assert.equal(usages, 1);
    } finally {
      const host = await import(`../src/${build}/src/providers/d1-host.js`); host.resetD1Worker();
      globalThis.chrome = saved.chrome; globalThis.browser = saved.browser; globalThis.Worker = saved.Worker;
    }
  });
  test(`${build}: a judge timeout cancels its D1 evaluation and keeps the loaded model`, async () => {
    const saved = { chrome: globalThis.chrome, browser: globalThis.browser, Worker: globalThis.Worker };
    const sent = [], workers = [];
    let release = null;
    const command = message => message.command || message.type;
    // Chrome reaches the Worker through the offscreen host; Firefox owns it.
    const deliver = message => { sent.push(message); if (command(message) === 'cancel') release?.(message.payload.requestId); return command(message) === 'cancel'; };
    const cancelled = { ok: false, error: 'D1 request cancelled.', code: 'D1_REQUEST_CANCELLED' };
    const api = { storage: { local: { get: async () => ({ [pin.D1_CONSENT_KEY]: pin.D1_CONSENT_VERSION, [pin.D1_KEEP_LOADED_KEY]: true }) } }, runtime: { getURL: path => 'chrome-extension://test/' + path } };
    if (build === 'chrome') {
      api.offscreen = { createDocument: async () => { throw new Error('Existing host must be reused'); }, hasDocument: async () => true };
      api.runtime.sendMessage = async message => deliver(message) ? { ok: true, result: { cancelled: true } } : new Promise(resolve => { release = requestId => { if (requestId === message.payload.requestId) resolve(cancelled); }; });
    }
    globalThis.chrome = api; globalThis.browser = build === 'firefox' ? api : undefined;
    globalThis.Worker = class {
      constructor() { workers.push(this); this.terminated = false; }
      postMessage(message) { if (!deliver(message)) release = requestId => { if (requestId === message.payload.requestId) queueMicrotask(() => this.onmessage({ data: { id: message.id, ...cancelled } })); }; }
      terminate() { this.terminated = true; }
    };
    try {
      const selected = config.resolveDecisionConfig({ decisionProvider: 'webgpu_d1', systemOneEnabled: true, [pin.D1_CONSENT_KEY]: pin.D1_CONSENT_VERSION });
      const client = judge.createSystemOneJudge({ fetchImpl: () => { throw new Error('No cloud request'); }, timeoutMs: 30, maxRetries: 0 });
      await assert.rejects(client.evaluate({ state: 'Page', questions: { q: { type: 'noul', instructions: 'Is blue visible?' } }, config: selected }), error => judge.systemOneFailureReason(error) === 'timeout');
      await new Promise(resolve => setTimeout(resolve, 20));
      const evaluate = sent.find(message => command(message) === 'evaluate');
      assert.equal(typeof evaluate.payload.requestId, 'string'); assert.equal(evaluate.payload.keepLoaded, true); assert.equal(evaluate.payload.consentVersion, pin.D1_CONSENT_VERSION);
      assert.equal(sent.find(message => command(message) === 'cancel')?.payload.requestId, evaluate.payload.requestId);
      assert.equal(sent.some(message => command(message) === 'reset'), false, 'a timeout must not discard the loaded model');
      assert.ok(workers.every(worker => !worker.terminated));
    } finally {
      const host = await import(`../src/${build}/src/providers/d1-host.js`); host.resetD1Worker();
      globalThis.chrome = saved.chrome; globalThis.browser = saved.browser; globalThis.Worker = saved.Worker;
    }
  });
  test(`${build}: the D1 host forwards Worker error codes and cancels without terminating`, async () => {
    const saved = { chrome: globalThis.chrome, browser: globalThis.browser, Worker: globalThis.Worker };
    const posted = [];
    let terminated = 0;
    globalThis.chrome = { runtime: { getURL: path => 'chrome-extension://test/' + path } }; globalThis.browser = build === 'firefox' ? globalThis.chrome : undefined;
    globalThis.Worker = class {
      postMessage(message) { posted.push(message); if (message.type === 'evaluate') queueMicrotask(() => this.onmessage({ data: { id: message.id, ok: false, error: 'D1 is loading its cached model.', code: 'D1_MODEL_LOADING' } })); }
      terminate() { terminated++; }
    };
    const host = await import(`../src/${build}/src/providers/d1-host.js`);
    try {
      await assert.rejects(host.dispatchD1Worker('evaluate', { requestId: 'x' }, 1000), error => error.code === 'D1_MODEL_LOADING' && judge.systemOneFailureReason(error) === 'model_loading');
      host.cancelD1Request('x');
      assert.equal(posted.at(-1).type, 'cancel'); assert.equal(posted.at(-1).payload.requestId, 'x'); assert.equal(terminated, 0);
      assert.equal(judge.systemOneFailureReason(Object.assign(new Error('x'), { code: 'D1_MODEL_NOT_LOADED' })), 'model_not_loaded');
      assert.equal(judge.systemOneFailureReason(Object.assign(new Error('x'), { code: 'D1_REQUEST_CANCELLED' })), 'cancelled');
    } finally {
      host.resetD1Worker();
      globalThis.chrome = saved.chrome; globalThis.browser = saved.browser; globalThis.Worker = saved.Worker;
    }
  });
  test(`${build}: worker skips a cancelled evaluation and reloads a kept model once, answering meanwhile`, async () => {
    const oldNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
    const oldSelf = Object.getOwnPropertyDescriptor(globalThis, 'self');
    const messages = [];
    let gpuReads = 0, markerReads = 0;
    const marker = { revision: pin.D1_RELEASE.revision, manifestSha256: pin.D1_RELEASE.manifestSha256 };
    const directory = { getFileHandle: async name => { assert.equal(name, 'ready.json'); markerReads++; return { getFile: async () => ({ text: async () => JSON.stringify(marker) }) }; } };
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { storage: { getDirectory: async () => ({ getDirectoryHandle: async () => directory }) }, get gpu() { gpuReads++; return undefined; } } });
    Object.defineProperty(globalThis, 'self', { configurable: true, value: { postMessage: message => messages.push(message) } });
    const settle = () => new Promise(resolve => setTimeout(resolve, 5));
    const response = id => messages.find(message => message.id === id);
    const send = data => self.onmessage({ data });
    const evaluate = (id, extra) => send({ id, type: 'evaluate', payload: { requestId: 'r' + id, state: 'Page', questions: { q: { type: 'noul', instructions: 'Is it blue?' } }, consentVersion: pin.D1_CONSENT_VERSION, ...extra } });
    try {
      await import(`../src/${build}/src/providers/d1-worker.js?cancel-and-reload`);
      // Cancelled while queued, and cancelled before its request arrived.
      evaluate(1, { keepLoaded: true }); send({ id: 2, type: 'cancel', payload: { requestId: 'r1' } });
      send({ id: 3, type: 'cancel', payload: { requestId: 'r4' } }); evaluate(4, { keepLoaded: true });
      await settle();
      assert.equal(response(1).code, 'D1_REQUEST_CANCELLED'); assert.equal(response(4).code, 'D1_REQUEST_CANCELLED'); assert.equal(response(2).ok, true);
      assert.equal(markerReads, 0, 'a cancelled evaluation starts nothing');
      // Without Settings' Load request (or without consent) nothing is read or loaded.
      evaluate(5, { keepLoaded: false }); evaluate(6, { keepLoaded: true, consentVersion: 0 }); await settle();
      assert.equal(response(5).code, 'D1_MODEL_NOT_LOADED'); assert.equal(response(6).code, 'D1_MODEL_NOT_LOADED'); assert.equal(markerReads, 0); assert.equal(gpuReads, 0);
      // A kept model is reloaded from the verified cache; this decision falls back meanwhile.
      evaluate(7, { keepLoaded: true }); await settle();
      assert.equal(response(7).ok, false); assert.equal(response(7).code, 'D1_MODEL_LOADING');
      assert.equal(markerReads, 1); assert.equal(gpuReads, 1, 'the reload reached the GPU probe');
      assert.ok(messages.some(message => message.state?.status === 'error' && /Hardware WebGPU/.test(message.state.error)), 'Settings sees why the reload failed');
      // A failed reload is not repeated on every decision.
      evaluate(8, { keepLoaded: true }); await settle();
      assert.equal(response(8).code, 'D1_MODEL_NOT_LOADED'); assert.equal(gpuReads, 1);
    } finally {
      if (oldNavigator) Object.defineProperty(globalThis, 'navigator', oldNavigator); else delete globalThis.navigator;
      if (oldSelf) Object.defineProperty(globalThis, 'self', oldSelf); else delete globalThis.self;
    }
  });
  test(`${build}: an aborted D1 evaluation stops between graph runs`, async () => {
    class Tensor { constructor(type, data, dims) { Object.assign(this, { type, data, dims }); } dispose() {} }
    const tokenizer = { bos_token_id: 1, pad_token_id: 0, convert_tokens_to_ids: () => 5, encode: text => Array.from(text, c => c.charCodeAt(0) % 200) };
    const controller = new AbortController();
    let runs = 0;
    const sessions = { vision: {}, projector: {}, decision: { async run(feeds) { runs++; controller.abort(new Error('caller stopped waiting')); const batch = feeds.input_ids.dims[0]; return { probabilities: { getData: async () => Float32Array.from({ length: batch * 2 }, (_, i) => i % 2 ? .75 : .25), dispose() {} } }; } } };
    const model = runtime.createD1Runtime({ ort: { Tensor }, tokenizer, config: { max_length: 16384, image_text_length: 896, temperatures: {} }, ratios: [], sessions, model: pin.D1_MODEL_ID });
    const questions = Object.fromEntries(Array.from({ length: 3 }, (_, i) => [`q${i}`, { type: 'noul', instructions: `Question ${i}?` }]));
    // Three capped rows need three batches (see the batching test above).
    await assert.rejects(model.evaluate({ state: 'x'.repeat(9000), questions, signal: controller.signal }), /caller stopped waiting/);
    assert.equal(runs, 1, 'the remaining batches never ran');
  });
  test(`${build}: Settings' Download and Load keep D1 loaded until Unload, Remove or switching it off`, async () => {
    const background = await readFile(new URL(`../src/${build}/src/background.js`, import.meta.url), 'utf8');
    const branch = background.slice(background.indexOf("case 'd1_control':"), background.indexOf("case 'list_decision_models':"));
    assert.match(branch, /msg\.command === 'consent' \? \{\} : \{ \[D1_KEEP_LOADED_KEY\]: true \}/);
    assert.match(branch, /\['reset', 'dispose', 'clear'\]\.includes\(msg\.command\)\) \{[^}]*\[D1_KEEP_LOADED_KEY\]: false/);
  });
  test(`${build}: D1's ready marker says whether its package is downloaded, and reading it creates nothing`, async () => {
    const directoryName = `${pin.D1_CACHE_NAME}-${pin.D1_RELEASE.revision}`;
    await withD1Download(pin, {}, async ({ reads }) => {
      assert.equal(await cache.d1PackageReady(), true);
      assert.deepEqual(reads, [['directory', directoryName, undefined], ['file', 'ready.json', undefined]], 'no create option anywhere');
    });
    for (const marker of ['missing', 'no-directory', { revision: 'older', manifestSha256: pin.D1_RELEASE.manifestSha256 }, { revision: pin.D1_RELEASE.revision, manifestSha256: 'f'.repeat(64) }]) {
      await withD1Download(pin, { marker }, async () => assert.equal(await cache.d1PackageReady(), false, JSON.stringify(marker)));
    }
    assert.equal(await cache.d1PackageReady({}), false, 'a browser without OPFS');
  });
  test(`${build}: the install guide may read, check, start and stop D1's download and leaves decision settings alone`, async () => {
    const background = await readFile(new URL(`../src/${build}/src/background.js`, import.meta.url), 'utf8');
    const branch = background.slice(background.indexOf("case 'd1_control':"), background.indexOf("case 'list_decision_models':"));
    // From the guide: status, probe, download and stop only. Load, Unload,
    // Remove and consent stay in Settings, and consent still gates a download.
    assert.match(branch, /page === api\.runtime\.getURL\('src\/ui\/install\.html'\)\s*&& \['status', 'probe', 'download', 'stop'\]\.includes\(msg\.command\)/);
    assert.match(branch, /const page = sender\.id === api\.runtime\.id \? String\(sender\.url \|\| ''\)\.split\(\/\[\?#\]\/\)\[0\] : '';/);
    assert.match(branch, /if \(page !== api\.runtime\.getURL\('src\/ui\/settings\.html'\) && !fromInstall\) return \{ success: false/);
    assert.match(branch, /if \(msg\.consent !== true \|\| msg\.consentVersion !== D1_CONSENT_VERSION\) throw/);
    if (build === 'chrome') {
      // The guide's download queues its chat model behind D1 in the
      // background (install-download-queue.js): only a shipped, selectable
      // WebGPU chat model, only from the guide's download; its Pause holds
      // the queue and its status reads move it along.
      assert.match(branch, /const chatModel = fromInstall && msg\.command === 'download' && msg\.chatModel != null \? String\(msg\.chatModel\) : '';/);
      assert.match(branch, /if \(chatModel && !isSelectableWebgpuPreset\(chatModel\)\) throw new Error\('Unknown local chat model\.'\);/);
      assert.match(branch, /if \(!fromInstall\) return \{ success: true, result \};/);
      assert.match(branch, /if \(chatModel\) await chatModelAfterD1\.queue\(chatModel\);/);
      // The Pause is recorded before D1 stops, so no check sees the stop alone.
      assert.ok(branch.indexOf("if (fromInstall && msg.command === 'stop') await chatModelAfterD1.pause();")
        < branch.indexOf('await d1Request(msg.command'), 'the Pause is recorded before D1 is stopped');
      assert.match(branch, /msg\.command === 'status'\s*\? await chatModelAfterD1\.advance\(\)/);
      assert.match(branch, /result: \{ \.\.\.result, usedForDecisions: await d1UsedForDecisions\(api\), chatModelQueued \}/);
      assert.match(background, /chrome\.alarms\.onAlarm\.addListener\(\(alarm\) => \{\s*if \(alarm\?\.name !== CHAT_AFTER_D1_ALARM\) return;\s*chatModelAfterD1\.advance\(\)/);
      assert.match(background, /onStartError: \(error\) => \{\s*console\.warn\(/, 'a failed start is reported and retried');
    } else {
      // Firefox has no in-browser chat model to queue.
      assert.match(branch, /result: fromInstall \? \{ \.\.\.result, usedForDecisions: await d1UsedForDecisions\(api\) \} : result/);
    }
    assert.doesNotMatch(background, /adoptForDecisions|adoptD1ForDecisions/, 'the guide never writes decision settings');
    // The guide says whether D1 answers this profile's decisions now.
    const source = topLevelFunction(background, 'd1UsedForDecisions');
    const compassProvider = { config: { providerName: 'webbrain-cloud', baseUrl: 'https://api.webbrain.one/v1' } };
    const otherProvider = { config: { providerName: 'openai' } };
    const consent = { [pin.D1_CONSENT_KEY]: pin.D1_CONSENT_VERSION };
    const loaded = { [pin.D1_KEEP_LOADED_KEY]: true };
    for (const [label, stored, options, expected] of [
      ['Auto with D1 downloaded', { ...consent, ...loaded }, {}, true],
      ['Auto while Compass chats', { ...consent, ...loaded }, { provider: compassProvider }, true],
      ['Auto after Unload', { ...consent, [pin.D1_KEEP_LOADED_KEY]: false }, {}, false],
      ['Auto before the download finished', { ...consent, ...loaded }, { marker: 'missing' }, false],
      ['Strict Secret Mode', { ...consent, ...loaded }, { strict: true }, false],
      ['On with D1', { ...consent, ...loaded, decisionMode: 'on', decisionProvider: 'webgpu_d1' }, { provider: compassProvider }, true],
      ['On with another provider', { ...consent, ...loaded, decisionMode: 'on', decisionProvider: 'openrouter', decisionApiKey: 'owned-key' }, {}, false],
      ['Off', { ...consent, ...loaded, decisionMode: 'off' }, {}, false],
    ]) {
      await withD1Download(pin, { stored, marker: options.marker }, async ({ api, area }) => {
        const before = JSON.stringify(area);
        const providerManager = { providers: new Map([['active', {}]]), load: async () => {}, getActive: () => options.provider || otherProvider };
        const context = vm.createContext({ api, agent: { strictSecretMode: options.strict === true }, providerManager,
          DECISION_SETTINGS_KEYS: config.DECISION_SETTINGS_KEYS, resolveCurrentDecisionConfig: availability.resolveCurrentDecisionConfig });
        vm.runInContext(source, context);
        assert.equal(await vm.runInContext('d1UsedForDecisions(api)', context), expected, label);
        assert.equal(JSON.stringify(area), before, `${label}: nothing is written`);
      });
    }
  });
  test(`${build}: leaving On for Auto keeps D1 while its Download or Load stands; Off and other changes release it`, async () => {
    const background = await readFile(new URL(`../src/${build}/src/background.js`, import.meta.url), 'utf8');
    assert.match(background, new RegExp(`${build === 'chrome' ? 'chrome' : 'browser'}\\.storage\\.onChanged\\.addListener\\(releaseD1OnDecisionChange\\);`));
    const source = topLevelFunction(background, 'releaseD1OnDecisionChange');
    const consent = pin.D1_CONSENT_KEY;
    // `loadRequested`: the user's Download or Load still stands (d1KeepLoaded).
    for (const [label, changes, loadRequested, expected, area = 'local'] of [
      ['decisions Off', { decisionMode: { newValue: 'off' }, systemOneEnabled: { newValue: false } }, true, 1],
      ['another provider saved', { decisionProvider: { newValue: 'openrouter' } }, true, 1],
      ['consent removed', { [consent]: { newValue: undefined } }, true, 1],
      ['Strict Secret Mode', { strictSecretMode: { newValue: true } }, true, 1],
      ['Auto, with D1 loaded or still downloading', { decisionMode: { newValue: 'auto' }, systemOneEnabled: { newValue: false } }, true, 0],
      ['Auto, after Unload', { decisionMode: { newValue: 'auto' }, systemOneEnabled: { newValue: false } }, false, 1],
      ['On', { decisionMode: { newValue: 'on' }, systemOneEnabled: { newValue: true } }, false, 0],
      ['consent given', { [consent]: { newValue: pin.D1_CONSENT_VERSION } }, false, 0],
      ['an unrelated setting', { theme: { newValue: 'dark' } }, false, 0],
      ['another storage area', { decisionMode: { newValue: 'off' } }, false, 0, 'sync'],
    ]) {
      const resets = [];
      const storage = { storage: { local: { get: async key => (key === pin.D1_KEEP_LOADED_KEY ? { [key]: loadRequested } : {}) } } };
      const context = vm.createContext({ D1_CONSENT_KEY: consent, D1_CONSENT_VERSION: pin.D1_CONSENT_VERSION, D1_KEEP_LOADED_KEY: pin.D1_KEEP_LOADED_KEY,
        chrome: storage, browser: storage, d1Request: async command => { resets.push(command); return {}; } });
      vm.runInContext(source, context);
      context.releaseD1OnDecisionChange(changes, area);
      await new Promise(resolve => setTimeout(resolve, 0));
      assert.deepEqual(resets, expected ? ['reset'] : [], label);
    }
  });
  test(`${build}: D1 is opt-in, endpoint/key-free, zero-cost and overrides Compass only with explicit local consent`, async () => {
    const stored = { decisionProvider: 'webgpu_d1', systemOneEnabled: true };
    assert.equal(config.resolveDecisionConfig(stored).enabled, false);
    const selected = config.resolveDecisionConfig({ ...stored, [pin.D1_CONSENT_KEY]: pin.D1_CONSENT_VERSION });
    assert.equal(selected.enabled, true); assert.equal(selected.local, true); assert.equal(selected.apiKey, ''); assert.equal(selected.url, ''); assert.equal(selected.doneEnabled, false);
    assert.equal(selected.config.inputCostPerMillionUsd, 0); assert.equal(selected.requiresIndependentSuccessConfirmation, true);
    assert.equal(config.resolveDecisionConfig(stored, { baseUrl: 'https://api.webbrain.one/v1' }).provider, 'compass');
    assert.equal(config.resolveDecisionConfig({ ...stored, [pin.D1_CONSENT_KEY]: pin.D1_CONSENT_VERSION }, { baseUrl: 'https://api.webbrain.one/v1' }).provider, 'webgpu_d1');
    let fetched = false;
    assert.equal((await config.listDecisionModels(selected, () => { fetched = true; })).length, 1); assert.equal(fetched, false);
    const imported = transfer.parseConfigImport(JSON.stringify({ schema: transfer.CONFIG_SCHEMA, settings: stored })).settings;
    assert.equal(imported.decisionProvider, 'webgpu_d1'); assert.equal(config.resolveDecisionConfig(imported).enabled, false);
  });
  test(`${build}: hardware guards reject software and inadequate buffers, not other capable GPUs`, () => {
    // The WebGPU default limits (128 MiB) now hold the FP16 embedding.
    const adapter = { info: { description: 'Some capable GPU', isFallbackAdapter: false }, limits: { maxBufferSize: 134217728, maxStorageBufferBindingSize: 134217728 } };
    assert.doesNotThrow(() => pin.assertD1Adapter(adapter));
    assert.throws(() => pin.assertD1Adapter({ ...adapter, info: { description: 'SwiftShader' } }), /software/);
    assert.throws(() => pin.assertD1Adapter({ ...adapter, limits: { maxBufferSize: 64 } }), /buffer/);
    assert.throws(() => pin.assertD1Adapter({ ...adapter, limits: { ...adapter.limits, maxStorageBufferBindingSize: 67108864 } }), /storage-binding/);
    assert.equal(pin.D1_MODEL_ID, 'webbrain-one/d1-browser-decision-fp16');
  });
  test(`${build}: media remains inline data and separate from state, remote network media is rejected`, () => {
    const url = 'data:image/png;base64,YQ==';
    assert.deepEqual(runtime.splitD1State([{ task: 'Observe' }, { type: 'image_url', image_url: { url } }]), { state: [{ task: 'Observe' }], images: [url] });
    assert.throws(() => runtime.splitD1State('', ['https://example.com/private.png']), /remote/);
    assert.throws(() => runtime.splitD1State('', Array(5).fill(url)), /four/);
    assert.equal(runtime.splitD1State(null).state, '');
    assert.equal(preprocess.pyJSON({ small: 1e-7, decimal: 1e-5, regular: .0001, negative: -.0000012, count: 2 }), '{"small": 1e-07, "decimal": 1e-05, "regular": 0.0001, "negative": -1.2e-06, "count": 2}');
    assert.throws(() => preprocess.pyJSON({ invalid: Infinity }), /finite/);
  });
  test(`${build}: public noul yes/no, choice names and score expectation preserve source ordering`, () => {
    const questions = { n: { type: 'noul' }, c: { type: 'choice', criteria: { second: 'B', first: 'A' } }, s: { type: 'score', criteria: ['Zero', 'One'] } };
    const answers = runtime.d1Answers(questions, new Float32Array([.25, .75, .8, .2, .6, .4]), 2);
    assert.equal(answers.n.noul, .75); assert.equal(answers.c.choice, 'second'); assert.ok(Math.abs(answers.s.score - .4) < 1e-6); assert.equal(answers.s.legend['0'], 'Zero');
    assert.throws(() => runtime.d1Answers({ n: { type: 'noul' } }, [NaN, 1], 2), /probability/);
    assert.equal(runtime.d1Answers({ s: { type: 'score', criteria: [{ n: 0 }, ['high']] } }, [.25, .75], 2).s.legend['0'], '{"n": 0}');
    assert.deepEqual(preprocess.renderOptions({ type: 'noul', criteria: { false: null, no: 'Do not use', true: null, yes: 'Do not use' } }), ['false: no, the statement does not hold', 'true: yes, the statement holds']);
    const numericNames = runtime.d1Answers([['1', { type: 'noul' }], ['0', { type: 'noul' }]], [.2, .8, .6, .4], 2);
    assert.equal(numericNames['1'].noul, .8); assert.equal(numericNames['0'].noul, .4);
  });
  test(`${build}: positive D1 alone cannot authorize completion, negative and independent policies remain`, async () => {
    const base = { capture: async () => ({ identity: 'fresh', key: 'pixel' }), isCurrent: () => true };
    const decision = { name: 'webgpu_d1', supportsVision: true, requiresIndependentSuccessConfirmation: true, evaluate: async () => ({ outcome: 'succeeded', probability: .999 }) };
    let verdict = await completion.verifyCompletion({ ...base, decision });
    assert.equal(verdict.outcome, 'uncertain'); assert.equal(verdict.engine, 'legacy');
    verdict = await completion.verifyCompletion({ ...base, decision, llm: { name: 'llm', evaluate: async () => ({ outcome: 'failed' }) } });
    assert.equal(verdict.outcome, 'failed'); assert.equal(verdict.engine, 'llm');
    verdict = await completion.verifyCompletion({ ...base, decision: { ...decision, evaluate: async () => ({ outcome: 'pending' }) } });
    assert.equal(verdict.outcome, 'pending');
  });
  test(`${build}: bounded checksum chunks cover each large file without gaps`, () => {
    const files = pin.D1_REQUIRED_FILES.map(path => ({ path, bytes: 2, sha256: 'a'.repeat(64) }));
    assert.doesNotThrow(() => cache.validateD1Manifest({ dtype: 'float32', audio_included: false, files }));
    files.at(-1).bytes = 10 * 1024 * 1024;
    assert.throws(() => cache.validateD1Manifest({ dtype: 'float32', audio_included: false, files }), /chunks/);
    assert.throws(() => cache.validateD1Manifest({ dtype: 'bfloat16', audio_included: false, files }), /FP32 or FP16/);
    files.at(-1).bytes = 2;
    assert.doesNotThrow(() => cache.validateD1Manifest({ dtype: 'float16', audio_included: false, files }), 'the FP16-weight package is valid');
    files.at(-1).chunks = [];
    assert.throws(() => cache.validateD1Manifest({ dtype: 'float32', audio_included: false, files }), /coverage/);
  });
  test(`${build}: batches are bounded by dense attention memory and keep original question indices`, () => {
    const rows = lengths => lengths.map(length => ({ input_ids: Array(length) }));
    // A 2048-token row's 16 × 2048² FP32 score tensor alone fills the 256 MiB budget.
    assert.equal(runtime.d1AttentionBytes(1, runtime.D1_WEBGPU_MAX_TEXT_TOKENS), runtime.D1_ATTENTION_BUDGET_BYTES);
    assert.deepEqual(runtime.d1RowBatches(rows([80, 2048, 2048, 2048]), 0), [[1], [2], [3], [0]]);
    // Short rows still share one batch, longest first.
    assert.deepEqual(runtime.d1RowBatches(rows([100, 512, 300, 512]), 0), [[1, 3, 2, 0]]);
    // The media prefix counts toward every row's length.
    assert.deepEqual(runtime.d1RowBatches(rows([400, 400, 400]), 1700), [[0], [1], [2]]);
    assert.deepEqual(runtime.d1RowBatches(rows([400, 400, 400]), 1700, { budgetBytes: 2 ** 31 }), [[0, 1, 2]]);
  });
  test(`${build}: WebGPU rows are capped and rows too large for the adapter fail before inference`, async () => {
    class Tensor { constructor(type, data, dims) { Object.assign(this, { type, data, dims }); } dispose() {} }
    const tokenizer = { bos_token_id: 1, pad_token_id: 0, convert_tokens_to_ids: () => 5, encode: text => Array.from(text, c => c.charCodeAt(0) % 200) };
    const seen = [];
    const sessions = { vision: {}, projector: {}, decision: { async run(feeds) { seen.push(feeds); const batch = feeds.input_ids.dims[0]; return { probabilities: { getData: async () => Float32Array.from({ length: batch * 2 }, (_, i) => i % 2 ? .75 : .25), dispose() {} } }; } } };
    const config = { max_length: 16384, image_text_length: 896, temperatures: {} };
    const questions = Object.fromEntries(Array.from({ length: 3 }, (_, i) => [`q${i}`, { type: 'noul', instructions: `Question ${i}?` }]));
    const model = runtime.createD1Runtime({ ort: { Tensor }, tokenizer, config, ratios: [], sessions, model: pin.D1_MODEL_ID });
    const longState = 'x'.repeat(9000);
    const result = await model.evaluate({ state: longState, questions });
    assert.ok(seen.every(feeds => feeds.input_ids.dims[1] <= runtime.D1_WEBGPU_MAX_TEXT_TOKENS), 'text rows must be capped on WebGPU');
    assert.equal(seen.length, 3, 'three capped rows cannot share one 256 MiB score tensor');
    assert.equal(result.diagnostics.attention_budget_bytes, runtime.D1_ATTENTION_BUDGET_BYTES);
    // A 128 MiB binding limit shortens rows instead of failing on the GPU.
    seen.length = 0;
    const small = runtime.createD1Runtime({ ort: { Tensor }, tokenizer, config, ratios: [], sessions, model: pin.D1_MODEL_ID, device: { limits: { maxStorageBufferBindingSize: 134217728 }, queue: { onSubmittedWorkDone: async () => {} } } });
    await small.evaluate({ state: longState, questions });
    assert.ok(seen.every(feeds => runtime.d1AttentionBytes(1, feeds.input_ids.dims[1]) <= 134217728));
    const tiny = runtime.createD1Runtime({ ort: { Tensor }, tokenizer, config, ratios: [], sessions, model: pin.D1_MODEL_ID, device: { limits: { maxStorageBufferBindingSize: 65536 }, queue: { onSubmittedWorkDone: async () => {} } } });
    await assert.rejects(tiny.evaluate({ state: longState, questions }), /too large for this GPU/);
  });
  test(`${build}: screenshot features stay on the GPU between the vision, projector and decision graphs`, async () => {
    const saved = { createImageBitmap: globalThis.createImageBitmap, OffscreenCanvas: globalThis.OffscreenCanvas, GPUBufferUsage: globalThis.GPUBufferUsage };
    globalThis.createImageBitmap = async () => ({ width: 64, height: 64, data: new Uint8ClampedArray(64 * 64 * 4).fill(128), close() {} });
    globalThis.OffscreenCanvas = class { getContext() { let bitmap; return { drawImage: image => { bitmap = image; }, getImageData: () => ({ data: bitmap.data }) }; } };
    globalThis.GPUBufferUsage = { STORAGE: 128, COPY_SRC: 4, COPY_DST: 8 };
    try {
      const copies = [], created = [], writes = [];
      class Tensor {
        constructor(type, data, dims) { Object.assign(this, { type, data, dims, location: 'cpu' }); }
        static fromGpuBuffer(buffer, { dims, dispose }) { const tensor = new Tensor('float32', null, dims); Object.assign(tensor, { location: 'gpu-buffer', gpuBuffer: buffer, disposer: dispose }); return tensor; }
        async getData() { if (this.location === 'gpu-buffer') throw new Error('GPU features must not be read back'); return this.data; }
        dispose() { this.disposer?.(); }
      }
      const gpuOut = (name, dims) => { const tensor = Tensor.fromGpuBuffer({ name }, { dims }); return tensor; };
      let decisionFeeds;
      const sessions = {
        vision: { async run(feeds) { return { hidden: gpuOut('hidden', [feeds.pixel_values.dims[0], 1024, 768]) }; } },
        projector: { async run({ hidden }) { assert.equal(hidden.location, 'gpu-buffer'); const [, h, w] = hidden.dims; return { prefix: gpuOut('prefix', [1, (h / 2) * (w / 2), 1024]) }; } },
        decision: { async run(feeds) { decisionFeeds = feeds; return { probabilities: { getData: async () => new Float32Array([.4, .6, .3, .7]), dispose() {} } }; } },
      };
      const device = {
        limits: { maxStorageBufferBindingSize: 2 ** 31 },
        createBuffer: ({ size, usage }) => { const buffer = { size, usage, destroyed: false, destroy() { this.destroyed = true; } }; created.push(buffer); return buffer; },
        createCommandEncoder: () => ({ copyBufferToBuffer: (...args) => copies.push(args), finish: () => ({}) }),
        queue: { submit() {}, writeBuffer: (...args) => writes.push(args), onSubmittedWorkDone: async () => {} },
      };
      const tokenizer = { bos_token_id: 1, pad_token_id: 0, convert_tokens_to_ids: () => 5, encode: text => Array.from(text, c => c.charCodeAt(0) % 200) };
      const model = runtime.createD1Runtime({ ort: { Tensor }, tokenizer, config: { max_length: 16384, image_text_length: 896, temperatures: {} }, ratios: [], sessions, device, model: pin.D1_MODEL_ID });
      const questions = { a: { type: 'noul', instructions: 'Is it grey?' }, b: { type: 'noul', instructions: 'Is it white?' } };
      const result = await model.evaluate({ state: 'Grey page', images: ['data:image/png;base64,YQ=='], questions });
      assert.equal(result.diagnostics.media_on_gpu, true);
      const media = decisionFeeds.media_prefix;
      assert.equal(media.location, 'gpu-buffer');
      const rows = media.dims[1], rowBytes = rows * 1024 * 4;
      assert.deepEqual(media.dims, [2, rows, 1024]);
      const toMedia = copies.filter(([, , target]) => target === media.gpuBuffer);
      assert.deepEqual(toMedia.map(([, , , offset, bytes]) => [offset, bytes]), [[0, rowBytes], [rowBytes, rowBytes]], 'each row receives the projected prefix by a GPU copy');
      assert.equal(writes.length, 0, 'no screenshot features were uploaded from the CPU');
      assert.ok(created.every(buffer => buffer.usage & 128), 'feature buffers must be storage buffers');
    } finally {
      for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete globalThis[key]; else globalThis[key] = value; }
    }
  });
  test(`${build}: encoder/head feeds are FP32, bidirectional and generate no tokens`, async () => {
    const seen = [];
    class Tensor { constructor(type, data, dims) { Object.assign(this, { type, data, dims }); } dispose() {} }
    const tokenizer = { bos_token_id: 1, pad_token_id: 0, convert_tokens_to_ids: token => ({ '<|mask|>': 99 }[token] || 5), encode: text => text.split('').map(c => c.charCodeAt(0)) };
    const sessions = { vision: {}, projector: {}, decision: { async run(feeds) { seen.push(feeds); return { probabilities: { getData: async () => new Float32Array([.25, .75, .8, .2]), dispose() {} } }; } } };
    const model = runtime.createD1Runtime({ ort: { Tensor }, tokenizer, config: { dtype: 'float16', max_length: 16384, image_text_length: 896, temperatures: { 'noul:2': 1.666, 'choice:2': 1.746 } }, ratios: [], sessions, model: pin.D1_MODEL_ID });
    const result = await model.evaluate({ state: { color: 'blue' }, questions: { n: { type: 'noul', instructions: 'Is it blue?' }, c: { type: 'choice', instructions: 'Pick a color', criteria: { blue: 'Blue', red: 'Red' } } } });
    assert.equal(result.usage.output_tokens, 0); assert.equal(result.answers.n.noul, .75);
    assert.deepEqual(seen[0].media_prefix.dims, [2, 0, 1024]); assert.equal(seen[0].media_prefix.type, 'float32'); assert.equal(seen[0].temperature.type, 'float32'); assert.equal(seen[0].qtype.type, 'int64');
    assert.equal(Object.hasOwn(seen[0], 'past_key_values'), false); assert.equal(Object.hasOwn(seen[0], 'causal_mask'), false);
  });
}

test('chrome: the install guide queues its chat model behind D1, and the background starts it once D1 is done', async () => {
  const queue = await import('../src/chrome/src/providers/install-download-queue.js');
  const model = 'webbrain-one/Ternary-Bonsai-2-2B-ONNX-WebGPU-Vision';
  const make = ({ d1 = { status: 'downloading' }, chat = { status: 'not-downloaded' } } = {}) => {
    const env = { d1, chat, now: 1_000_000, area: {}, alarms: [], cleared: [], starts: [], reads: 0 };
    const api = {
      storage: { local: {
        get: async (key) => (key in env.area ? { [key]: structuredClone(env.area[key]) } : {}),
        set: async (values) => { Object.assign(env.area, structuredClone(values)); },
        remove: async (key) => { delete env.area[key]; },
      } },
      alarms: { create: async (name, info) => { env.alarms.push([name, info]); }, clear: async (name) => { env.cleared.push(name); return true; } },
    };
    env.queue = queue.createChatModelAfterD1({
      api,
      d1Status: async () => { env.reads += 1; if (env.d1 instanceof Error) throw env.d1; return env.d1; },
      chatStatus: async () => env.chat,
      startChat: async (name) => { env.starts.push(name); env.chat = { status: 'downloading' }; },
      now: () => env.now,
    });
    return env;
  };

  {
    // Nothing queued: nothing starts, and a left-over alarm is cleared.
    const env = make({ d1: { status: 'ready', loaded: true } });
    assert.equal(await env.queue.advance(), false);
    assert.deepEqual(env.starts, []);
    assert.deepEqual(env.cleared, [queue.CHAT_AFTER_D1_ALARM]);
  }
  {
    // Queued while D1 downloads: the alarm checks again; D1 first.
    const env = make();
    await env.queue.queue(model);
    assert.deepEqual(env.area[queue.CHAT_AFTER_D1_KEY], { model, queuedAt: env.now, paused: false });
    assert.deepEqual(env.alarms, [[queue.CHAT_AFTER_D1_ALARM, { periodInMinutes: 0.5 }]]);
    assert.equal(await env.queue.queued(), true);
    for (const status of ['checking', 'downloading', 'loading']) {
      env.d1 = { status };
      assert.equal(await env.queue.advance(), true, status);
    }
    assert.deepEqual(env.starts, []);
    // D1 is ready: the chat model starts once, and the queue is gone.
    env.d1 = { status: 'ready', loaded: true };
    assert.equal(await env.queue.advance(), false);
    assert.deepEqual(env.starts, [model]);
    assert.equal(env.area[queue.CHAT_AFTER_D1_KEY], undefined);
    assert.ok(env.cleared.includes(queue.CHAT_AFTER_D1_ALARM));
    assert.equal(await env.queue.advance(), false);
    assert.deepEqual(env.starts, [model], 'started once');
    assert.equal(await env.queue.queued(), false);
  }
  {
    // D1's status is read inside each check, after any Pause ahead of it: a
    // Pause and a check at the same moment never start the chat model.
    const env = make({ d1: { status: 'downloading' } });
    await env.queue.queue(model);
    const pause = env.queue.pause();
    env.d1 = { status: 'stopped', progress: 50 };
    assert.equal(await env.queue.advance(), true, 'the Pause is seen with the stop');
    await pause;
    assert.deepEqual(env.starts, []);
    assert.ok(env.reads >= 1);
    // A status a caller read earlier (just before a Resume, say) is not used.
    env.d1 = { status: 'downloading' };
    await env.queue.queue(model);
    assert.equal(await env.queue.advance({ status: 'stopped' }), true);
    assert.deepEqual(env.starts, []);
  }
  {
    // A Pause on the guide holds the chat model until Resume queues it again;
    // a D1 transfer stopped any other way does not.
    const env = make();
    await env.queue.queue(model);
    await env.queue.pause();
    env.d1 = { status: 'stopped', progress: 40 };
    assert.equal(await env.queue.advance(), true, 'paused on the guide');
    assert.deepEqual(env.starts, []);
    await env.queue.queue(model);
    assert.equal(env.area[queue.CHAT_AFTER_D1_KEY].paused, false, 'Resume');
    assert.equal(await env.queue.advance(), false, 'stopped by a stall, its time limit or the Providers page');
    assert.deepEqual(env.starts, [model]);
  }
  {
    // Paused on the guide, but the package was already saved: nothing to wait for.
    const env = make();
    await env.queue.queue(model);
    await env.queue.pause();
    env.d1 = { status: 'stopped', cached: true };
    assert.equal(await env.queue.advance(), false);
    assert.deepEqual(env.starts, [model]);
  }
  for (const d1 of [{ status: 'error', error: 'no bytes' }, { status: 'idle' }, { status: 'cached' }]) {
    // Failed, reset or saved: the chat model does not wait any longer.
    const env = make();
    await env.queue.queue(model);
    env.d1 = d1;
    assert.equal(await env.queue.advance(), false, d1.status);
    assert.deepEqual(env.starts, [model], d1.status);
  }
  for (const chat of [{ status: 'downloading' }, { status: 'paused' }, { status: 'ready', ready: true }, { status: 'loading' }]) {
    // A chat model started, paused elsewhere or downloaded since the guide
    // queued it is left alone.
    const env = make();
    await env.queue.queue(model);
    env.chat = chat;
    env.d1 = { status: 'ready', loaded: true };
    assert.equal(await env.queue.advance(), false, chat.status);
    assert.deepEqual(env.starts, [], chat.status);
    assert.equal(env.area[queue.CHAT_AFTER_D1_KEY], undefined, chat.status);
  }
  {
    // A chat download already paused when the guide's Resume queued it
    // resumes after D1.
    const env = make({ chat: { status: 'paused', progress: 40 } });
    await env.queue.queue(model);
    assert.equal(env.area[queue.CHAT_AFTER_D1_KEY].resumeChat, true);
    assert.equal(await env.queue.advance(), true, 'D1 first');
    env.d1 = { status: 'ready', loaded: true };
    assert.equal(await env.queue.advance(), false);
    assert.deepEqual(env.starts, [model]);
  }
  {
    // Another model holds the WebGPU download slot: start when it is free.
    const env = make({ chat: { status: 'not-downloaded', activeTransfer: { modelId: 'other/model', status: 'downloading' } } });
    await env.queue.queue(model);
    env.d1 = { status: 'ready', loaded: true };
    assert.equal(await env.queue.advance(), true);
    assert.deepEqual(env.starts, []);
    env.chat = { status: 'not-downloaded' };
    assert.equal(await env.queue.advance(), false);
    assert.deepEqual(env.starts, [model]);
  }
  {
    // A start that fails keeps the queue for the next check, until it starts.
    const env = make();
    const errors = [];
    let failures = 1;
    env.queue = queue.createChatModelAfterD1({
      api: { storage: { local: {
        get: async (key) => (key in env.area ? { [key]: structuredClone(env.area[key]) } : {}),
        set: async (values) => { Object.assign(env.area, structuredClone(values)); },
        remove: async (key) => { delete env.area[key]; },
      } }, alarms: { create: async () => {}, clear: async (name) => { env.cleared.push(name); return true; } } },
      d1Status: async () => env.d1,
      chatStatus: async () => env.chat,
      startChat: async (name) => {
        if (failures-- > 0) throw new Error('Offscreen document is starting.');
        env.starts.push(name); env.chat = { status: 'downloading' };
      },
      onStartError: (error) => errors.push(error.message),
      now: () => env.now,
    });
    await env.queue.queue(model);
    env.d1 = { status: 'ready', loaded: true };
    assert.equal(await env.queue.advance(), true, 'still queued after a failed start');
    assert.deepEqual(errors, ['Offscreen document is starting.']);
    assert.equal(env.area[queue.CHAT_AFTER_D1_KEY].model, model);
    assert.deepEqual(env.cleared, [], 'the alarm keeps checking');
    assert.equal(await env.queue.advance(), false);
    assert.deepEqual(env.starts, [model]);
    assert.equal(env.area[queue.CHAT_AFTER_D1_KEY], undefined);
  }
  {
    // D1's status cannot be read: try again later.
    const env = make({ d1: new Error('offscreen document closed') });
    await env.queue.queue(model);
    assert.equal(await env.queue.advance(), true);
    assert.deepEqual(env.starts, []);
  }
  {
    // A queue older than D1's own time limit allows is dropped, unstarted.
    const env = make();
    await env.queue.queue(model);
    env.now += queue.CHAT_AFTER_D1_MAX_AGE_MS + 1;
    env.d1 = { status: 'ready', loaded: true };
    assert.equal(await env.queue.advance(), false);
    assert.deepEqual(env.starts, []);
    assert.equal(env.area[queue.CHAT_AFTER_D1_KEY], undefined);
  }
  {
    // The guide's read and the alarm at the same moment start it once.
    const env = make();
    await env.queue.queue(model);
    env.d1 = { status: 'ready', loaded: true };
    assert.deepEqual(await Promise.all([env.queue.advance(), env.queue.advance(), env.queue.advance()]), [false, false, false]);
    assert.deepEqual(env.starts, [model]);
  }
  {
    // A stored entry without a model is removed.
    const env = make();
    env.area[queue.CHAT_AFTER_D1_KEY] = { queuedAt: env.now };
    assert.equal(await env.queue.advance(), false);
    assert.equal(env.area[queue.CHAT_AFTER_D1_KEY], undefined);
  }
});

test('new shared decision runtime modules are byte-identical across Chrome and Firefox', async () => {
  for (const name of ['d1-config.js', 'd1-runtime.js', 'd1-preprocess.js', 'd1-cache.js', 'd1-worker.js', 'd1-host.js', 'd1-diagnostic.js']) assert.deepEqual(await readFile(new URL(`../src/chrome/src/providers/${name}`, import.meta.url)), await readFile(new URL(`../src/firefox/src/providers/${name}`, import.meta.url)), name);
});
