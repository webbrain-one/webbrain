import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import {
  DECISION_SYSTEM_PROMPT,
  decisionAnswer,
  decisionOptions,
  decisionQuestionText,
  normalizeDecisionRequest,
} from '../src/chrome/src/offscreen/webgpu-decisions.js';
// The worker module registers its message listener on import.
const workerListeners = [];
const workerMessages = [];
globalThis.self ??= { addEventListener(type, listener) { if (type === 'message') workerListeners.push(listener); }, postMessage(message) { workerMessages.push(message); } };
const { bonsai2ContinuationLogits } = await import('../src/chrome/src/offscreen/inference-worker.js');

const choice = { type: 'choice', instructions: 'Is the task done?', criteria: { completed: 'A final acknowledgement is visible.', not_completed: 'An error is visible.', unknown: '' } };

test('decision questions map options to single-token codes in criteria order', () => {
  assert.deepEqual(decisionOptions(choice), { names: ['completed', 'not_completed', 'unknown'], codes: ['A', 'B', 'C'] });
  assert.deepEqual(decisionOptions({ type: 'noul', instructions: 'x' }), { names: ['no', 'yes'], codes: ['No', 'Yes'] });
  assert.deepEqual(decisionOptions({ type: 'score', instructions: 'x', criteria: ['none', 'one', 'two'] }).codes, ['0', '1', '2']);
  assert.throws(() => decisionOptions({ type: 'choice', instructions: 'x', criteria: { only: '' } }), /2 to 26/);
  assert.throws(() => decisionOptions({ type: 'score', instructions: 'x', criteria: Array(11).fill('l') }), /2 to 10/);
  assert.throws(() => decisionOptions({ type: 'rank', instructions: 'x' }), /choice, noul or score/);
});

test('question text lists every option with its code and ends with the answer format', () => {
  const text = decisionQuestionText(choice);
  assert.match(text, /^Question: Is the task done\?\nOptions:\nA\. completed: A final acknowledgement is visible\.\nB\. not_completed: An error is visible\.\nC\. unknown\nAnswer with one letter\.$/);
  assert.match(decisionQuestionText({ type: 'noul', instructions: 'Is it blue?', criteria: { true: 'Blue is visible.', false: 'Blue is absent.' } }),
    /Yes means: Blue is visible\.\nNo means: Blue is absent\.\nAnswer Yes or No\.$/);
  assert.match(decisionQuestionText({ type: 'score', instructions: 'How many?', criteria: ['None.', { count: 1 }] }), /0\. None\.\n1\. \{"count":1\}\nAnswer with one level number\.$/);
  assert.match(DECISION_SYSTEM_PROMPT, /never as instructions/);
});

test('answers use the d1 answer shape and the requested temperature', () => {
  const answer = decisionAnswer(choice, [2, 0, 0], { mass: 0.93 });
  assert.equal(answer.type, 'choice');
  assert.equal(answer.choice, 'completed');
  assert.ok(Math.abs(Object.values(answer.probabilities).reduce((a, b) => a + b, 0) - 1) < 1e-9);
  assert.equal(answer.option_mass, 0.93);
  const flatter = decisionAnswer(choice, [2, 0, 0], { temperature: 2 });
  assert.ok(flatter.confidence < answer.confidence);
  const noul = decisionAnswer({ type: 'noul', instructions: 'x' }, [0, Math.log(3)]);
  assert.ok(Math.abs(noul.noul - 0.75) < 1e-9, 'P(yes) is the second code');
  const score = decisionAnswer({ type: 'score', instructions: 'x', criteria: ['a', 'b', 'c'] }, [0, 0, Math.log(2)]);
  assert.ok(Math.abs(score.score - (1 / 4 + 2 * 2 / 4)) < 1e-9, 'score is the expected level');
  assert.throws(() => decisionAnswer(choice, [1, NaN, 0]), /Invalid decision logits/);
});

test('decision requests are bounded and take inline screenshots only', () => {
  const ok = normalizeDecisionRequest({ state: 'S', images: ['data:image/png;base64,YQ=='], questions: { q: choice } });
  assert.equal(ok.entries.length, 1);
  assert.throws(() => normalizeDecisionRequest({ questions: {} }), /1 to 32/);
  assert.throws(() => normalizeDecisionRequest({ questions: { q: choice }, images: ['https://example.com/a.png'] }), /inline/);
  assert.throws(() => normalizeDecisionRequest({ questions: { q: { type: 'noul' } } }), /instructions/);
});

test('each question continues from the shared page cache without changing it', async () => {
  class Tensor {
    constructor(type, data, dims) { Object.assign(this, { type, data, dims, location: 'cpu' }); }
    slice(...ranges) { const [start, end] = ranges.find(Array.isArray); return { start, end, dims: this.dims }; }
  }
  const forwards = [];
  const disposed = [];
  const runtime = {
    library: {
      Tensor,
      cat: ([left, right]) => new Tensor('int64', null, [1, left.dims[1] + right.dims[1]]),
    },
    model: {
      get_rope_index: (ids) => [new Tensor('int64', null, [3, 1, ids.dims[1]])],
      encode_text: async ({ input_ids }) => ({ dims: [1, input_ids.dims[1], 8] }),
      forward: async inputs => {
        forwards.push(inputs);
        const present = { location: 'gpu-buffer', dispose() { disposed.push('present'); } };
        const logits = { slice: () => ({ to: () => ({ data: new Float32Array([0.1, 0.2, 0.3]) }) }) };
        return { logits, 'present.0.key': present };
      },
    },
  };
  const cache = { 'past_key_values.0.key': { location: 'gpu-buffer' } };
  const prefix = { input_ids: new Tensor('int64', null, [1, 100]), image_grid_thw: null };
  const logits = await bonsai2ContinuationLogits(runtime, prefix, cache, new Tensor('int64', null, [1, 12]));
  assert.deepEqual(Array.from(logits).map(value => Math.round(value * 10)), [1, 2, 3]);
  assert.equal(forwards[0].past_key_values, cache, 'the prefix cache is passed as-is');
  assert.deepEqual(forwards[0].attention_mask.dims, [1, 112], 'the mask covers the prefix and the question');
  assert.deepEqual([forwards[0].position_ids.start, forwards[0].position_ids.end], [100, 112], 'positions continue after the prefix');
  assert.deepEqual(disposed, ['present'], 'the continuation cache is released');
  assert.deepEqual(Object.keys(cache), ['past_key_values.0.key'], 'the shared cache is not updated');
});

test('the worker routes decisions through the offscreen host and provider', async () => {
  const worker = await readFile(new URL('../src/chrome/src/offscreen/inference-worker.js', import.meta.url), 'utf8');
  assert.match(worker, /type === 'multimodal-decide'[\s\S]*?runMultimodalDecision/);
  assert.match(worker, /WEBGPU_BONSAI2_VISION_MODEL_IDS\.has\(modelId\)\) \{\n\s*throw new Error\(`\$\{modelId\} does not support in-browser decisions/);
  const host = await readFile(new URL('../src/chrome/src/offscreen/vision-inference-host.js', import.meta.url), 'utf8');
  assert.match(host, /'webgpu-decide',/);
  assert.match(host, /message\.type === 'webgpu-decide'[\s\S]*?'multimodal-decide'/);
  const background = await readFile(new URL('../src/chrome/src/background.js', import.meta.url), 'utf8');
  const branch = background.slice(background.indexOf("case 'webgpu_decide_fixture':"), background.indexOf("case 'd1_control':"));
  assert.match(branch, /src\/ui\/settings\.html/, 'decision fixtures run only from the Settings page');
  assert.doesNotMatch(branch, /src\/ui\/providers\.html/, 'the Providers page only forwards to Settings now');
  assert.match(branch, /strictSecretMode/);
});

test('the trained probes score each option from its margin and hidden state', async () => {
  const { BONSAI_DECISION_PROBE, bonsaiProbeScores } = await import('../src/chrome/src/offscreen/bonsai-decision-probe.js');
  const { COMPASS_VLD_DECISION_PROBE, compassVldDecisionProbe, compassVldProbeScores } = await import('../src/chrome/src/offscreen/compass-vld-decision-probe.js');
  const webgpu = await import('../src/chrome/src/providers/webgpu.js');
  const chromeConfig = await import('../src/chrome/src/agent/decision-config.js');
  const firefoxConfig = await import('../src/firefox/src/agent/decision-config.js');
  assert.equal(BONSAI_DECISION_PROBE.model, webgpu.WEBGPU_BONSAI2_VL_2B_MODEL_ID);
  assert.equal(compassVldDecisionProbe(webgpu.WEBGPU_DECISION_MODEL_ID)?.model, webgpu.WEBGPU_DECISION_MODEL_ID, 'the agent decision model has its probe');
  assert.equal(COMPASS_VLD_DECISION_PROBE.model, webgpu.WEBGPU_COMPASS_VLD_TINY_V5_MODEL_ID, 'Tiny v5 keeps its probe');
  for (const config of [chromeConfig, firefoxConfig]) {
    assert.equal(config.WEBGPU_CHAT_DECISION_MODEL, webgpu.WEBGPU_DECISION_MODEL_ID, 'decision-config keeps the model id in sync');
    assert.deepEqual(config.WEBGPU_CHAT_DECISION_DTYPE, webgpu.webgpuModelDtype(webgpu.WEBGPU_DECISION_MODEL_ID), 'and the dtype its ready marker is keyed by');
    // Every Compass VLD build answers decisions where it is the newest downloaded, each with its probe and ready marker.
    assert.deepEqual(config.WEBGPU_CHAT_DECISION_MODELS.map(entry => entry.model), webgpu.WEBGPU_COMPASS_VLD_MODEL_IDS);
    for (const entry of config.WEBGPU_CHAT_DECISION_MODELS) {
      assert.deepEqual(entry.dtype, webgpu.webgpuModelDtype(entry.model), `${entry.model}: the dtype its ready marker is keyed by`);
      assert.ok(compassVldDecisionProbe(entry.model), `${entry.model} has a probe`);
    }
  }
  for (const [probe, scores] of [[BONSAI_DECISION_PROBE, bonsaiProbeScores], [COMPASS_VLD_DECISION_PROBE, compassVldProbeScores]]) {
    const width = probe.hiddenSize;
    const zero = new Float32Array(width);
    const [a, b] = scores([2, 0], [zero, zero]);
    assert.ok(Math.abs(a - b - 2 * probe.margin) < 1e-9, 'with equal hidden states only the margins differ');
    const unit = new Float32Array(width).fill(1);
    const [c, d] = scores([0, 0], [unit, zero]);
    assert.ok(Number.isFinite(c - d) && c !== d, 'the hidden state moves the score');
    assert.throws(() => scores([0], [null]), /hidden state/);
    assert.throws(() => scores([0], [new Float32Array(3)]), /hidden state/);
  }
});

test('decisions default to the probe and refuse a decoder without decision_hidden', async () => {
  const worker = await readFile(new URL('../src/chrome/src/offscreen/inference-worker.js', import.meta.url), 'utf8');
  assert.match(worker, /payload\.promptVariant : 'probe';/, 'the probe is the default decision mode');
  assert.match(worker, /variant === 'probe' && !output\.hidden\) \{\n\s*throw new Error\('In-browser decisions need the updated Ternary Bonsai 2 2B Vision decoder/);
  assert.match(worker, /\['webbrain-one\/Ternary-Bonsai-2-2B-ONNX-WebGPU-Vision', '240c07e1191911a2306faf106ee537382a1b4d5e6ecdd32b618da160db9145c1'\]/,
    'the 2B decoder pin is the graph that exposes decision_hidden');
});

test('a saved in-browser chat-model selection answers with Compass VLD Tiny v5 on this device', async () => {
  for (const build of ['chrome']) {
    const config = await import(`../src/${build}/src/agent/decision-config.js`);
    const transfer = await import(`../src/${build}/src/config-transfer.js`);
    const selected = config.resolveDecisionConfig({ decisionProvider: 'webgpu_chat', systemOneEnabled: true });
    assert.equal(selected.provider, 'webgpu_chat'); assert.equal(selected.source, 'configured');
    assert.equal(selected.model, config.WEBGPU_CHAT_DECISION_MODEL);
    assert.deepEqual(selected.dtype, config.WEBGPU_CHAT_DECISION_DTYPE);
    assert.equal(selected.local, true); assert.equal(selected.apiKey, ''); assert.equal(selected.enabled, true);
    assert.equal(selected.unavailable, undefined);
    assert.equal(selected.doneEnabled, false, 'completion outsourcing stays opt-in');
    assert.equal(selected.requiresIndependentSuccessConfirmation, true, 'a positive completion still needs independent proof');
    assert.equal(selected.config.inputCostPerMillionUsd, 0);
    assert.equal(config.resolveDecisionConfig({ decisionProvider: 'webgpu_chat', systemOneEnabled: true }, { baseUrl: 'https://api.webbrain.one/v1' }).provider, 'webgpu_chat',
      'an explicit local choice overrides Compass, as D1 does');
    assert.equal(config.resolveDecisionConfig({ decisionProvider: 'webgpu_chat' }).enabled, false, 'Auto without the model downloaded uses nothing');
    assert.equal(config.resolveDecisionConfig({ decisionMode: 'off', decisionProvider: 'webgpu_chat' }).enabled, false);
    assert.deepEqual((await config.listDecisionModels(selected, () => { throw new Error('no network'); })).map(model => model.id), [config.WEBGPU_CHAT_DECISION_MODEL]);
    const imported = transfer.parseConfigImport(JSON.stringify({ schema: transfer.CONFIG_SCHEMA, settings: { decisionProvider: 'webgpu_chat' } })).settings;
    assert.equal(imported.decisionProvider, 'webgpu_chat');
  }
});

test('the in-browser chat model keeps its configured feature switches, and so does a replacement provider', async () => {
  const { resolveDecisionConfig, decisionFeatureEnabled } = await import('../src/chrome/src/agent/decision-config.js');
  for (const mode of [{ decisionMode: 'on' }, {}]) {
    const stored = { ...mode, decisionProvider: 'webgpu_chat', systemOneEnabled: true,
      systemOneDoneEnabled: true, systemOneWatchEnabled: false, systemOneCompletionEnabled: true,
      systemOneFastClassifications: false, systemOneFastBrowser: true };
    const selected = resolveDecisionConfig(stored);
    assert.equal(selected.enabled, true);
    assert.deepEqual(selected.features, { done: true, watch: false, completion: true, classifications: false, browser: true, semantic: true });
    for (const [feature, on] of Object.entries(selected.features)) assert.equal(decisionFeatureEnabled(selected, feature), on, feature);
    for (const provider of ['openrouter', 'typesafe', 'local']) {
      const replacement = resolveDecisionConfig({ ...stored, decisionProvider: provider });
      assert.deepEqual(replacement.features, selected.features, `${provider} keeps saved switches`);
    }
  }
  const legacy = resolveDecisionConfig({ decisionProvider: 'webgpu_chat', systemOneEnabled: true });
  assert.deepEqual(legacy.features, { done: false, watch: false, completion: false, classifications: false, browser: false, semantic: true });
});

test('Firefox never enables the Chrome-only chat-model provider and imports it with System One off', async () => {
  const config = await import('../src/firefox/src/agent/decision-config.js');
  const transfer = await import('../src/firefox/src/config-transfer.js');
  const stored = { decisionProvider: 'webgpu_chat', systemOneEnabled: true, decisionApiKey: 'sk-or-v1-test', typesafeApiKey: 'ts_test' };
  const selected = config.resolveDecisionConfig(stored);
  assert.equal(selected.provider, 'webgpu_chat', 'a local-only choice never falls back to a cloud provider');
  assert.equal(selected.enabled, false);
  assert.equal(selected.unavailable, 'chrome_only');
  const chromeExport = { schema: transfer.CONFIG_SCHEMA, settings: { ...stored, systemOneCompletionEnabled: true } };
  const restored = transfer.parseConfigImport(JSON.stringify(chromeExport)).settings;
  assert.equal(restored.decisionProvider, '');
  assert.equal(restored.systemOneEnabled, false);
  assert.equal(restored.systemOneCompletionEnabled, true, 'other settings import unchanged');
  assert.equal(restored.decisionInputRate, .042, 'the cost default follows the provider that is kept');
  assert.equal(config.resolveDecisionConfig(restored).enabled, false, 'no decisions until a provider is chosen here');
  const patch = transfer.parseConfigPatchImport(JSON.stringify(chromeExport)).settings;
  assert.equal(Object.hasOwn(patch, 'decisionProvider'), false, 'a provisioning patch keeps the stored provider');
  assert.equal(patch.systemOneEnabled, false);
  const chrome = await import('../src/chrome/src/config-transfer.js');
  assert.equal(chrome.parseConfigImport(JSON.stringify(chromeExport)).settings.decisionProvider, 'webgpu_chat', 'Chrome round-trips it');
});

test('the agent judge asks Compass VLD in the offscreen worker, and Firefox refuses the Chrome-only model', async () => {
  const saved = { chrome: globalThis.chrome };
  const sent = [];
  const decideMessages = [];
  const answers = { q: { type: 'noul', noul: 0.8 } };
  globalThis.chrome = {
    offscreen: { hasDocument: async () => true, createDocument: async () => {} },
    runtime: {
      lastError: null,
      getURL: path => `chrome-extension://test/${path}`,
      sendMessage(message, callback) {
        sent.push(message.type);
        if (message.type === 'webgpu-decide') decideMessages.push(message);
        const reply = message.type === 'webgpu-download-status' ? { ready: true }
          : message.type === 'webgpu-decide' ? { ok: true, model: message.model, answers, usage: { input_tokens: 900, output_tokens: 0 } }
            : { ok: true };
        callback(reply);
      },
    },
    storage: { local: { get: async () => ({}) } },
  };
  try {
    const { resolveDecisionConfig } = await import('../src/chrome/src/agent/decision-config.js');
    const { createSystemOneJudge } = await import('../src/chrome/src/agent/systemone-judge.js');
    const config = resolveDecisionConfig({ decisionProvider: 'webgpu_chat', systemOneEnabled: true });
    const screenshot = 'data:image/png;base64,YQ==';
    const args = { state: [{ task: 'Save' }, { type: 'image_url', image_url: { url: screenshot } }], questions: { q: { type: 'noul', instructions: 'Is it done?' } }, config };
    const judged = await createSystemOneJudge({ fetchImpl: () => { throw new Error('no cloud request'); }, maxRetries: 0 }).evaluate(args);
    assert.deepEqual(judged.answers, answers);
    assert.equal(judged.model, config.model); assert.equal(judged.estimatedCostUsd, 0);
    assert.ok(sent.includes('webgpu-decide'), 'the decision runs in the offscreen worker');
    const decide = decideMessages.at(-1);
    assert.equal(decide.model, config.model);
    assert.deepEqual(decide.images, [screenshot], 'screenshots in the state reach the model as images');
    assert.doesNotMatch(JSON.stringify(decide.state), /base64/, 'no screenshot is left in the prompt text');
    const { evaluateWebgpuDecision } = await import('../src/chrome/src/providers/webgpu-decision.js');
    const result = await evaluateWebgpuDecision(args);
    assert.deepEqual(result.answers, answers);
    assert.equal(result.usage.output_tokens, 0);
    assert.equal(result.provider, 'webgpu_chat');
    await assert.rejects(evaluateWebgpuDecision({ ...args, config: { ...config, model: 'webbrain-one/Ternary-Bonsai-2-2B-ONNX-WebGPU-Vision' } }),
      /Only Compass VLD answers in-browser decisions/, 'Ternary Bonsai decisions stay off after failing validation');
    const firefox = await import('../src/firefox/src/agent/systemone-judge.js');
    const firefoxConfig = (await import('../src/firefox/src/agent/decision-config.js')).resolveDecisionConfig({ decisionProvider: 'webgpu_chat', systemOneEnabled: true });
    await assert.rejects(firefox.createSystemOneJudge({ fetchImpl: () => { throw new Error('no cloud request'); }, maxRetries: 0 })
      .evaluate({ state: 'Page', questions: { q: { type: 'noul', instructions: 'Is it done?' } }, config: firefoxConfig }), /Chrome only/);
  } finally {
    if (saved.chrome === undefined) delete globalThis.chrome; else globalThis.chrome = saved.chrome;
  }
});

test('Settings offers the in-browser chat model in Chrome only', async () => {
  const chromeHtml = await readFile(new URL('../src/chrome/src/ui/settings.html', import.meta.url), 'utf8');
  const firefoxHtml = await readFile(new URL('../src/firefox/src/ui/settings.html', import.meta.url), 'utf8');
  assert.match(chromeHtml, /<option value="webgpu_chat" data-i18n="st\.decision\.webgpu_chat"><\/option>/);
  assert.match(chromeHtml, /id="webgpu-decision-note" hidden data-i18n="st\.decision\.webgpu_chat_note"/);
  assert.doesNotMatch(firefoxHtml, /webgpu_chat/);
  const { decisionEnglish, decisionTranslations } = await import('../src/chrome/src/ui/locales/decision-copy.mjs');
  assert.ok(decisionEnglish['st.decision.webgpu_chat'] && decisionEnglish['st.decision.webgpu_chat_note']);
  assert.ok(decisionTranslations.tr['st.decision.webgpu_chat']);
});

test('a cancelled decision stops in the worker before using the model', async () => {
  assert.equal(workerListeners.length, 1);
  const post = data => workerListeners[0]({ data });
  const reply = id => workerMessages.find(message => message.id === id);
  const settle = async id => { for (let i = 0; i < 50 && !reply(id); i++) await new Promise(resolve => setTimeout(resolve, 1)); return reply(id); };
  const payload = { modelId: 'no-such/model', state: 'Page', questions: { q: { type: 'noul', instructions: 'Done?' } } };
  // Without a cancel the request reaches the model checks.
  const control = post({ id: 9001, type: 'multimodal-decide', payload });
  assert.doesNotMatch((await settle(9001)).error, /cancelled/);
  await control;
  // A cancel that arrives while the decision is queued stops it first.
  const decide = post({ id: 9002, type: 'multimodal-decide', payload });
  await post({ id: 9003, type: 'cancel', payload: { requestId: 9002 } });
  assert.equal(reply(9003).cancelled, true);
  await decide;
  assert.deepEqual(await settle(9002), { id: 9002, ok: false, error: 'The in-browser decision was cancelled.' });
  const worker = await readFile(new URL('../src/chrome/src/offscreen/inference-worker.js', import.meta.url), 'utf8');
  const run = worker.slice(worker.indexOf('async function runMultimodalDecision'), worker.indexOf('async function runText'));
  assert.match(run, /prefixLength, stopIfCancelled\)/, 'prefill slices check for a cancel');
  const continuations = (run.match(/await bonsai2ContinuationLogits/g) || []).length;
  assert.ok(continuations >= 2);
  assert.equal((run.match(/stopIfCancelled\(\);\n\s*const (?:output|logits) = await bonsai2ContinuationLogits/g) || []).length, continuations,
    'every continuation checks for a cancel');
});

test('an aborted diagnostic request cancels the in-browser decision in the offscreen worker', async () => {
  const saved = { chrome: globalThis.chrome };
  const sent = [];
  let finishDecide;
  globalThis.chrome = {
    offscreen: { hasDocument: async () => true, createDocument: async () => {} },
    runtime: {
      lastError: null,
      getURL: path => `chrome-extension://test/${path}`,
      sendMessage(message, callback) {
        sent.push(message);
        if (message.type === 'webgpu-decide') { finishDecide = () => callback({ ok: false, error: 'The in-browser decision was cancelled.' }); return; }
        callback(message.type === 'webgpu-download-status' ? { ready: true } : { ok: true });
      },
    },
    storage: { local: { get: async () => ({}) } },
  };
  try {
    const { resolveDecisionConfig } = await import('../src/chrome/src/agent/decision-config.js');
    const { evaluateWebgpuDecision } = await import('../src/chrome/src/providers/webgpu-decision.js');
    const config = resolveDecisionConfig({ decisionProvider: 'webgpu_chat', systemOneEnabled: true });
    const controller = new AbortController();
    const pending = evaluateWebgpuDecision({ state: 'Page', questions: { q: { type: 'noul', instructions: 'Is it done?' } }, config, signal: controller.signal });
    for (let i = 0; i < 50 && !finishDecide; i++) await new Promise(resolve => setTimeout(resolve, 1));
    const decide = sent.find(message => message.type === 'webgpu-decide');
    assert.ok(decide?.decisionId, 'each decision carries an id');
    controller.abort(new Error('Stopped'));
    for (let i = 0; i < 50 && !sent.some(message => message.type === 'webgpu-decide-cancel'); i++) await new Promise(resolve => setTimeout(resolve, 1));
    const cancel = sent.find(message => message.type === 'webgpu-decide-cancel');
    assert.equal(cancel?.decisionId, decide.decisionId, 'the abort cancels that decision');
    finishDecide();
    await assert.rejects(pending);
    const host = await readFile(new URL('../src/chrome/src/offscreen/vision-inference-host.js', import.meta.url), 'utf8');
    assert.match(host, /'webgpu-decide-cancel',/);
    assert.match(host, /cancelledWebgpuDecisions\.delete\(decisionId\)/, 'a cancel before dispatch skips the decision');
    assert.match(host, /type: 'cancel', payload: \{ requestId: decision\.requestId \}/, 'a dispatched decision is cancelled in its worker');
  } finally {
    if (saved.chrome === undefined) delete globalThis.chrome; else globalThis.chrome = saved.chrome;
  }
});

test('in-browser chat decisions never reach the network and stop at their own deadline', async () => {
  const { createSystemOneJudge, SYSTEM_ONE_WEBGPU_CHAT_TIMEOUT_MS } = await import('../src/chrome/src/agent/systemone-judge.js');
  const { resolveDecisionConfig } = await import('../src/chrome/src/agent/decision-config.js');
  const saved = { chrome: globalThis.chrome };
  let fetches = 0;
  const sent = [];
  globalThis.chrome = {
    offscreen: { hasDocument: async () => true, createDocument: async () => {} },
    runtime: {
      lastError: null,
      getURL: path => `chrome-extension://test/${path}`,
      // The worker never answers this decision.
      sendMessage(message, callback) { sent.push(message.type); if (message.type !== 'webgpu-decide') callback(message.type === 'webgpu-download-status' ? { ready: true } : { ok: true }); },
    },
    storage: { local: { get: async () => ({}) } },
  };
  try {
    const client = createSystemOneJudge({ fetchImpl: async () => { fetches++; throw new Error('unexpected fetch'); }, timeoutMs: 50 });
    const started = performance.now();
    await assert.rejects(client.evaluate({ config: resolveDecisionConfig({ decisionMode: 'on', decisionProvider: 'webgpu_chat' }),
      state: 'Page', questions: { q: { type: 'noul', instructions: 'Is it done?' } } }));
    assert.equal(fetches, 0, 'nothing leaves the browser');
    assert.ok(sent.includes('webgpu-decide'));
    assert.ok(performance.now() - started < 1000, 'a caller deadline below the cap applies');
    assert.equal(SYSTEM_ONE_WEBGPU_CHAT_TIMEOUT_MS, 15000, 'room for the first decision after a restart to load the model');
  } finally {
    if (saved.chrome === undefined) delete globalThis.chrome; else globalThis.chrome = saved.chrome;
  }
});

test('Settings locks the model and key fields for both fixed in-browser providers and restores them otherwise', async () => {
  const settings = await readFile(new URL('../src/chrome/src/ui/settings.js', import.meta.url), 'utf8');
  const start = settings.indexOf('function syncWebgpuDecisionProvider');
  const sync = settings.slice(start, settings.indexOf('\n}\n', start));
  assert.match(settings, /const FIXED_WEBGPU_DECISION_PROVIDERS = \['webgpu_d1', 'webgpu_chat'\];/);
  assert.match(sync, /const fixed = FIXED_WEBGPU_DECISION_PROVIDERS\.includes\(decisionProviderInput\?\.value\);/);
  assert.match(sync, /decisionModelInput\.readOnly = fixed;/);
  assert.match(sync, /systemOneApiKeyInput\.disabled = fixed;/);
  assert.doesNotMatch(sync, /= true;/, 'nothing is locked only one way');
  // d1-settings.js also sets these fields for D1 only; the sync must run after it.
  const awaited = [...settings.matchAll(/await refreshD1Settings\(\);\n(?:\s*decisionSuggestionDismissed = [^\n]*\n)?\s*(\S+)/g)].map(match => match[1]);
  assert.deepEqual(awaited, ['syncWebgpuDecisionProvider();', 'syncWebgpuDecisionProvider();'], 'load and Clear re-sync after D1');
  const change = settings.slice(settings.indexOf("decisionProviderInput?.addEventListener('change'"));
  assert.match(change.slice(0, change.indexOf('});')), /syncWebgpuDecisionProvider\(\);/);
  assert.ok(settings.indexOf('initD1Settings(sendToBackground)') < settings.indexOf("decisionProviderInput?.addEventListener('change'"),
    "D1's change listener is registered first, so this one runs last");
});

test('Settings asks one Auto / On / Off question and shows provider fields and switches only for On', async () => {
  const { decisionEnglish, decisionTranslations } = await import('../src/chrome/src/ui/locales/decision-copy.mjs');
  for (const build of ['chrome', 'firefox']) {
    const html = await readFile(new URL(`../src/${build}/src/ui/settings.html`, import.meta.url), 'utf8');
    const card = html.slice(html.indexOf('id="system-one-card"'), html.indexOf('id="safesocial-heading"'));
    assert.deepEqual([...card.matchAll(/name="decision-mode" value="(\w+)"( checked)?/g)].map(m => m[1] + (m[2] ? '*' : '')), ['auto*', 'on', 'off'], build);
    assert.ok(card.indexOf('data-i18n="st.decision.intro"') < card.indexOf('id="decision-mode"'), 'the explanation comes first');
    assert.match(card, /id="decision-configured" hidden/, 'provider fields wait for On');
    assert.match(card, /<details class="advanced-settings decision-features" id="decision-features">/, 'per-decision switches start collapsed');
    const features = card.slice(card.indexOf('id="decision-features"'));
    for (const id of ['toggle-decision-done', 'toggle-system-one-watch', 'toggle-system-one-completion', 'toggle-system-one-classifications', 'toggle-system-one-browser']) {
      assert.match(features, new RegExp(`id="${id}" checked`), `${build} ${id} lives in the subpane, on by default`);
    }
    assert.doesNotMatch(card, /id="toggle-system-one"|decision-suggestion|btn-decision-use-chat/, 'the old switch and suggestion are gone');
    assert.match(card, new RegExp(`data-i18n="st.decision.mode.auto_desc${build === 'firefox' ? '_firefox' : ''}"`));
    assert.equal(/value="webgpu_chat"/.test(card), build === 'chrome');
  }
  const keys = ['st.decision.intro', 'st.decision.mode.label', 'st.decision.mode.auto', 'st.decision.mode.on', 'st.decision.mode.off',
    'st.decision.mode.auto_desc', 'st.decision.mode.auto_desc_firefox', 'st.decision.mode.on_desc', 'st.decision.mode.off_desc',
    'st.decision.status.local', 'st.decision.status.compass', 'st.decision.status.none', 'st.decision.status.none_firefox', 'st.decision.status.strict',
    'st.decision.features', 'st.decision.features_desc', 'st.decision.reset', 'st.decision.reset_done'];
  assert.equal(Object.keys(decisionTranslations).length, 22, 'every interface locale');
  for (const key of keys) assert.ok(decisionEnglish[key], key);
  // Every string on the card is translated, with its placeholders kept.
  for (const [key, english] of Object.entries(decisionEnglish)) {
    for (const [code, dict] of Object.entries(decisionTranslations)) {
      assert.ok(dict[key], `${code} ${key}`);
      for (const placeholder of english.match(/\{\w+\}/g) || []) assert.ok(dict[key].includes(placeholder), `${code} ${key} ${placeholder}`);
    }
  }
  assert.doesNotMatch(decisionEnglish['st.system_one.security_html'], /outsourcing/, 'the security note speaks of decision models');
  for (const key of ['st.decision.suggest_chat', 'st.decision.use_chat', 'st.system_one.enabled.label']) assert.equal(decisionEnglish[key], undefined, key);
  const firefoxCopy = await readFile(new URL('../src/firefox/src/ui/locales/decision-copy.mjs', import.meta.url), 'utf8');
  assert.equal(firefoxCopy, await readFile(new URL('../src/chrome/src/ui/locales/decision-copy.mjs', import.meta.url), 'utf8'));
  const settings = await readFile(new URL('../src/chrome/src/ui/settings.js', import.meta.url), 'utf8');
  const status = settings.slice(settings.indexOf('async function syncDecisionStatus'), settings.indexOf('\nfor (const input of decisionModeInputs) {'));
  assert.match(status, /activeProviderIsCompass\(\)/, 'Auto names Compass while it is the chat provider');
  assert.doesNotMatch(status, /isLocalAssistModelReady\(\)/, 'a downloaded vision model must not enable decisions');
  assert.match(settings, /function renderProviders\(\) \{\n\s*if \(!providersContainer\) return;\n\s*providersContainer\.innerHTML = '';\n\s*void syncDecisionStatus\(\);/, 'follows chat-provider changes');
  // Strict Secret Mode turns every decision model off, so Auto must say so and follow the toggle.
  for (const build of ['chrome', 'firefox']) {
    const source = await readFile(new URL(`../src/${build}/src/ui/settings.js`, import.meta.url), 'utf8');
    const start = source.indexOf('function syncDecisionStatus');
    const fn = source.slice(start, source.indexOf('\nfor (const input of decisionModeInputs) {', start));
    // The switch and the card are in different Settings sections (and the page
    // may be open twice), so the card follows the stored setting.
    assert.match(fn, /const strict = strictSecretModeOn;/, `${build} reads the stored Strict Secret Mode`);
    assert.match(source, /changes\.strictSecretMode[\s\S]{0,160}strictSecretModeOn = changes\.strictSecretMode\.newValue === true;\s*(?:void )?syncDecisionStatus\(\);/, `${build} follows Strict Secret Mode changed on the Settings page`);
    assert.match(source, /strictSecretModeOn = stored\.strictSecretMode === true;/, `${build} starts from the stored Strict Secret Mode`);
    assert.match(fn, /strict \? 'st\.decision\.status\.strict'/, `${build} shows the strict status first`);
    assert.match(fn, /compass = !strict && activeProviderIsCompass\(\)/, `${build} does not call Compass active while strict`);
    assert.match(source, /strictSecretToggle(\?\.|\.)addEventListener\('change', async \(\) => \{\n\s*await (chrome|browser)\.storage\.local\.set\(\{ strictSecretMode: strictSecretToggle\.checked \}\)\.catch\(\(\) => \{\}\);\n\s*(void )?syncDecisionStatus\(\);/, `${build} refreshes the status when the toggle changes`);
  }
});

test('the screenshot gate probes never fall back to the untrained readout', async () => {
  const { TINY_ASK_GATE_PROBE, COMPASS_VLD_TINY_ASK_GATE_PROBE, tinyAskGateProbability } = await import('../src/chrome/src/offscreen/tiny-ask-gate-probe.js');
  const { WEBGPU_BONSAI2_VL_2B_MODEL_ID, WEBGPU_COMPASS_VLD_TINY_V5_MODEL_ID } = await import('../src/chrome/src/providers/webgpu.js');
  assert.equal(TINY_ASK_GATE_PROBE.model, WEBGPU_BONSAI2_VL_2B_MODEL_ID);
  assert.equal(COMPASS_VLD_TINY_ASK_GATE_PROBE.model, WEBGPU_COMPASS_VLD_TINY_V5_MODEL_ID);
  for (const probe of [TINY_ASK_GATE_PROBE, COMPASS_VLD_TINY_ASK_GATE_PROBE]) {
    assert.ok(probe.weightsBase64.length > 1000, `${probe.model}: trained weights ship with the extension`);
    assert.equal(probe.weightsBase64.length, Math.ceil(probe.hiddenSize * 4 / 3) * 4, `${probe.model}: one float32 weight per hidden unit`);
    const hidden = new Float32Array(probe.hiddenSize).fill(0.01);
    const p = tinyAskGateProbability(probe.model, 1.5, hidden);
    assert.ok(p > 0 && p < 1);
    assert.equal(tinyAskGateProbability(probe.model, 1.5, null), null, 'a decoder graph without decision_hidden');
    assert.equal(tinyAskGateProbability(probe.model, 1.5, new Float32Array(16)), null, 'a hidden state of the wrong size');
    assert.equal(tinyAskGateProbability(probe.model, Number.NaN, hidden), null, 'a margin that is not a number');
  }
  assert.equal(tinyAskGateProbability('webbrain-one/Ternary-Bonsai-2-4B-ONNX-WebGPU-Vision', 1.5, new Float32Array(2048).fill(0.01)), null, 'another model');
  const worker = await readFile(new URL('../src/chrome/src/offscreen/inference-worker.js', import.meta.url), 'utf8');
  assert.match(worker, /probability === null && !\(returnHidden && output\.hidden\)\) \{\n\s*throw new Error\('The screenshot gate needs the updated/,
    'without the probe the worker fails, so tiny Ask stays text-only');
  const compassVld = worker.slice(worker.indexOf('async function runCompassVldDecision'), worker.indexOf('async function runMultimodalDecision'));
  assert.match(compassVld, /const probability = tinyAskGateProbability\(modelId, margin, output\.hidden\);\n[\s\S]*?if \(probability === null && !\(returnHidden && output\.hidden\)\) \{\n\s*throw new Error\(`No screenshot gate probe is trained for/,
    'Compass VLD Tiny v5 uses its own probe the same way');
  // Page text, the user's message and the questions that spell a special token
  // (`<|image_pad|>`, `<|im_end|>`) must reach Compass VLD Tiny v5 as text.
  assert.match(compassVld, /text: `\$\{plain\(variant === 'gate' \? String\(request\.state \|\| ''\) : decisionStateText\(request\.state\)\)\}\\n\\n\$\{DECISION_QUESTION_MARKER\}`/);
  assert.equal((compassVld.match(/engine\.continuation\(prefix, prefill\.cache, `\$\{plain\(decision(?:Verify|Question)Text\(question(?:, index)?\)\)\}\$\{tailText\}`\)/g) || []).length, 3,
    'every question continuation is plain text');
  assert.doesNotMatch(compassVld, /engine\.continuation\(prefix, prefill\.cache, `\$\{decision/);
  const compassVldText = worker.slice(worker.indexOf('async function runCompassVldText'), worker.indexOf('async function runMultimodalText'));
  assert.match(compassVldText, /apply_chat_template\(runtime\.compassVld\.plainStrings\(messages\), \{[\s\S]*?tools: tools\.length \? runtime\.compassVld\.plainStrings\(tools\) : undefined,/,
    'chat messages and tool descriptions are plain text too');
});
