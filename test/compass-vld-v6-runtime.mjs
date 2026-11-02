// Compass VLD v6 2B in the offscreen worker (src/chrome/src/offscreen/compass-vld-v6-runtime.js):
// the pinned files, the Lfm3VlImageProcessor port, the chat template and the decoder
// loop, checked without a GPU. The processor reference (test/fixtures/compass-vld-v6-processor.json)
// was written by test/fixtures/compass-vld-v6-processor.py from the model's own processing code.
//
// With a local copy of the ONNX bundle (WEBBRAIN_COMPASS_VLD_V6_DIR, the q4f16 decoder)
// and onnxruntime-node (WEBBRAIN_ORT_NODE, a path to the package), the last test also runs
// the runtime end to end on CPU: one screenshot from the vision suite, scored like the suite.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import * as shared from '../src/chrome/src/offscreen/compass-vld-runtime.js';
import * as v6 from '../src/chrome/src/offscreen/compass-vld-v6-runtime.js';
import * as files from '../src/chrome/src/offscreen/compass-vld-v6-files.js';
import * as webgpu from '../src/chrome/src/providers/webgpu.js';

const MODEL = v6.COMPASS_VLD_V6_MODEL_ID;
const fixture = JSON.parse(await readFile(new URL('./fixtures/compass-vld-v6-processor.json', import.meta.url), 'utf8'));

test('v6 is the default in-browser model, decision model and screenshot reader, and Tiny v5 stays selectable', () => {
  assert.equal(MODEL, 'webbrain-one/webbrain-compass-vld-v6-2b-onnx');
  assert.equal(webgpu.WEBGPU_COMPASS_VLD_V6_MODEL_ID, MODEL);
  assert.equal(webgpu.WEBGPU_DEFAULT_MODEL_ID, MODEL);
  assert.equal(webgpu.WEBGPU_DECISION_MODEL_ID, MODEL);
  assert.equal(webgpu.WEBGPU_VISION_COMPASS_VLD_MODEL_ID, MODEL);
  assert.deepEqual(webgpu.WEBGPU_COMPASS_VLD_MODEL_IDS, [MODEL, webgpu.WEBGPU_COMPASS_VLD_TINY_V5_MODEL_ID]);
  assert.deepEqual(webgpu.WEBGPU_PICKER_MODEL_IDS.slice(0, 2), [MODEL, webgpu.WEBGPU_COMPASS_VLD_TINY_V5_MODEL_ID]);
  assert.ok(webgpu.WEBGPU_SELECTABLE_MODEL_PRESETS.some(preset => preset.id === webgpu.WEBGPU_COMPASS_VLD_TINY_V5_MODEL_ID));
  for (const id of webgpu.WEBGPU_COMPASS_VLD_MODEL_IDS) assert.ok(webgpu.WEBGPU_DECISION_MODEL_IDS.has(id), `${id} answers decisions`);
  assert.equal(shared.isCompassVldModel(` ${MODEL} `), true);
  assert.equal(shared.isCompassVldV6Model(MODEL), true);
  assert.equal(shared.isCompassVldV6Model(webgpu.WEBGPU_COMPASS_VLD_TINY_V5_MODEL_ID), false);
  // The newest downloaded build reads screenshots; v6 when neither is (a download fetches it).
  assert.equal(webgpu.webgpuCompassVldModelFor([]), MODEL);
  assert.equal(webgpu.webgpuCompassVldModelFor([webgpu.WEBGPU_COMPASS_VLD_TINY_V5_MODEL_ID]), webgpu.WEBGPU_COMPASS_VLD_TINY_V5_MODEL_ID);
  assert.equal(webgpu.webgpuCompassVldModelFor([webgpu.WEBGPU_COMPASS_VLD_TINY_V5_MODEL_ID, MODEL]), MODEL);
});

test('the preset, the pins and the runtime agree on the files, the dtype and the download size', () => {
  const preset = webgpu.webgpuModelPreset(MODEL);
  assert.deepEqual(preset.dtype, files.COMPASS_VLD_V6_DTYPE);
  assert.deepEqual(webgpu.WEBGPU_COMPASS_VLD_V6_DTYPE, files.COMPASS_VLD_V6_DTYPE);
  assert.deepEqual(shared.compassVldDtype(MODEL), files.COMPASS_VLD_V6_DTYPE);
  assert.equal(preset.runtime, webgpu.WEBGPU_RUNTIME_ONNX_VL);
  assert.equal(preset.supportsVision, true);
  assert.match(files.COMPASS_VLD_V6_REVISION, /^[0-9a-f]{40}$/);
  const list = shared.compassVldFiles(undefined, MODEL);
  assert.deepEqual(list.map(file => file.path), [
    'config.json', 'generation_config.json', 'processor_config.json', 'tokenizer_config.json', 'chat_template.jinja', 'tokenizer.json',
    'onnx/vision_encoder_fp16.onnx', 'onnx/vision_encoder_fp16.onnx_data',
    'onnx/decoder_q8f16.onnx', 'onnx/decoder_q8f16.onnx_data',
  ]);
  for (const file of list) {
    assert.ok(Number.isInteger(file.bytes) && file.bytes > 0, file.path);
    assert.match(file.sha256, /^[0-9a-f]{64}$/, file.path);
  }
  const total = list.reduce((sum, file) => sum + file.bytes, 0);
  assert.equal(`${(total / 1e9).toFixed(1)} GB`, preset.size, 'the preset quotes the download size');
  const lite = shared.compassVldFiles({ vision_encoder: 'fp16', decoder: 'q4f16' }, MODEL);
  assert.ok(lite.reduce((sum, file) => sum + file.bytes, 0) < total, 'the lighter q4f16 decoder is pinned too');
  assert.throws(() => shared.compassVldFiles({ vision_encoder: 'fp16', decoder: 'fp32' }, MODEL), /Compass VLD v6 2B has no onnx\/decoder_fp32\.onnx/);
  // Files are read at v6's own pinned commit; calls that name no model still mean Tiny v5.
  assert.equal(shared.compassVldFileUrl(MODEL, 'onnx/a.onnx'), `https://huggingface.co/${MODEL}/resolve/${files.COMPASS_VLD_V6_REVISION}/onnx/a.onnx`);
  assert.equal(shared.compassVldFiles().length, 12);
});

test('smart_resize keeps both sides multiples of 32 within the pixel budget, rounding like Python', () => {
  for (const [h, w, rh, rw] of fixture.smartResize) {
    assert.deepEqual(v6.smartResize(h, w), [rh, rw], `${h}x${w}`);
  }
  // 720 / 32 = 22.5 rounds to even (22), as Python's round() does.
  assert.deepEqual(v6.smartResize(720, 1280), [704, 1280]);
  assert.throws(() => v6.smartResize(10, 2500), /aspect ratio/);
});

// The test images, built exactly as test/fixtures/compass-vld-v6-processor.py builds them.
function synthetic(width, height, seed) {
  const out = new Uint8Array(width * height * 3);
  let state = seed;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      state = Number((BigInt(state) * 1103515245n + 12345n) & 0x7fffffffn);
      const n = state % 37;
      const o = (y * width + x) * 3;
      out[o] = (Math.floor((x * 255) / Math.max(1, width - 1)) + n) % 256;
      out[o + 1] = (Math.floor((y * 255) / Math.max(1, height - 1)) + 2 * n) % 256;
      out[o + 2] = ((((Math.floor(x / 7) + Math.floor(y / 5)) % 2) * 200) + n) % 256;
    }
  }
  return out;
}

test('the processor port reproduces Lfm3VlImageProcessor: size, patch order and pixel values', () => {
  for (const c of fixture.cases) {
    const image = v6.preprocessImage(synthetic(c.width, c.height, c.seed), c.width, c.height);
    const label = `${c.width}x${c.height}`;
    assert.deepEqual([image.height, image.width], c.resized, `${label}: resized size`);
    assert.deepEqual([image.gridH, image.gridW], c.grid, `${label}: patch grid`);
    assert.equal(image.tokens, c.tokens, `${label}: image tokens`);
    assert.equal(image.pixels.length, c.values, `${label}: values`);
    for (const [index, value] of c.sample) assert.equal(image.pixels[index], Math.fround(value), `${label}: value ${index}`);
    const digest = createHash('sha256').update(Buffer.from(image.pixels.buffer, image.pixels.byteOffset, image.pixels.byteLength)).digest('hex');
    assert.equal(digest, c.sha256, `${label}: every value matches`);
  }
});

test("each <|image|> the template writes becomes one token per merged 2x2 patch block", () => {
  const images = [{ tokens: 3 }, { tokens: 2 }];
  assert.equal(v6.expandImagePlaceholders('a<|vision_start|><|image|><|vision_end|>b<|image|>c', images),
    'a<|vision_start|><|image|><|image|><|image|><|vision_end|>b<|image|><|image|>c');
  assert.throws(() => v6.expandImagePlaceholders('<|image|>', images), /1 image slots for 2 images/);
});

test("the chat template's {% generation %} markers render in Transformers.js as they do in Python", async () => {
  const { Template } = await import('../src/chrome/vendor/transformers/transformers.web.js').then(async library => ({
    Template: (source, vars) => {
      const tokenizer = new library.PreTrainedTokenizer({
        version: '1.0', truncation: null, padding: null, normalizer: null, post_processor: null, added_tokens: [],
        pre_tokenizer: null, decoder: null, model: { type: 'WordLevel', vocab: { a: 0 }, unk_token: 'a' },
      }, {});
      tokenizer.chat_template = source;
      return tokenizer.apply_chat_template(vars.messages, { tokenize: false, add_generation_prompt: false });
    },
  }));
  const raw = "{%- for m in messages -%}{{- '<' + m.role + '>' -}}\n  {%- generation -%}\n    {{- m.content -}}\n  {%- endgeneration -%}\n{{- '</>' -}}{%- endfor -%}";
  assert.throws(() => Template(raw, { messages: [] }), /generation/, 'Transformers.js has no generation tag');
  const fixed = shared.jinjaForTransformersJs(raw);
  assert.equal(Template(fixed, { messages: [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'ok' }] }), '<user>hi</><assistant>ok</>');
  assert.equal(shared.jinjaForTransformersJs('{% generation %}x{% endgeneration %}'), '{% if true %}x{% endif %}');
});

// An ORT stand-in that records each decoder call and returns its own tensors.
function fakeOrt() {
  class Tensor {
    constructor(type, data, dims) { this.type = type; this.data = data; this.dims = dims; this.disposed = false; }
    dispose() { this.disposed = true; }
  }
  return { Tensor };
}

function fakeDecoder(ort, { vocab = 8, hidden = 4, script = [] } = {}) {
  const calls = [];
  const names = v6.COMPASS_VLD_V6.layerTypes.flatMap((type, i) => (type === 'conv' ? [`past_conv.${i}`] : [`past_key_values.${i}.key`, `past_key_values.${i}.value`]));
  return {
    calls,
    inputNames: ['input_ids', 'attention_mask', 'position_ids', 'image_features', 'video_features', 'logits_to_keep', ...names],
    async run(feeds) {
      calls.push(feeds);
      const step = calls.length - 1;
      const logits = new Float32Array(vocab);
      logits[script[step] ?? 0] = 1;
      const out = { logits: new ort.Tensor('float32', logits, [1, 1, vocab]), decision_hidden: new ort.Tensor('float32', new Float32Array(hidden).fill(step), [1, 1, hidden]) };
      for (const name of names) {
        const present = name.replace('past_conv.', 'present_conv.').replace('past_key_values.', 'present.');
        out[present] = new ort.Tensor('float16', new Uint16Array(1), [1]);
      }
      return out;
    },
  };
}

test('the decoder loop feeds 1-D positions, each slice its own image features, and hands the cache on', async () => {
  const ort = fakeOrt();
  const decoder = fakeDecoder(ort, { script: [5, 6, 3] });
  const tokenizer = { encode: text => Array.from(text, ch => ch.charCodeAt(0)), _tokenizer: null, all_special_tokens: [] };
  const cfg = { ...v6.COMPASS_VLD_V6, hidden: 2, imageTokenId: 9, eosTokenIds: [3] };
  const engine = new v6.CompassVldV6Runtime(ort, tokenizer, { vision_encoder: null, decoder }, cfg);
  // Tokens 1 9 9 2 9 4: three image tokens, prefilled in slices of 3 tokens.
  const inputs = { ids: [1, 9, 9, 2, 9, 4], features: Float32Array.from([10, 11, 20, 21, 30, 31]) };
  const { logits, cache } = await engine.prefill(inputs, { sliceTokens: 3 });
  assert.equal(decoder.calls.length, 2);
  const [first, second] = decoder.calls;
  assert.deepEqual(Array.from(first.position_ids.data, Number), [0, 1, 2]);
  assert.deepEqual(Array.from(second.position_ids.data, Number), [3, 4, 5]);
  assert.deepEqual(first.attention_mask.dims, [1, 3]);
  assert.deepEqual(second.attention_mask.dims, [1, 6]);
  assert.deepEqual(Array.from(first.image_features.data), [10, 11, 20, 21], 'the first slice gets the features of its two image tokens');
  assert.deepEqual(Array.from(second.image_features.data), [30, 31]);
  assert.deepEqual(second.video_features.dims, [0, 2]);
  assert.deepEqual(Array.from(first.logits_to_keep.data, Number), [1]);
  // An empty start: zero conv states and empty KV caches for every layer.
  assert.deepEqual(first['past_conv.0'].dims, [1, 2048, 7]);
  assert.deepEqual(first['past_key_values.2.key'].dims, [1, 4, 0, 128]);
  assert.equal(first['past_key_values.2.key'].disposed, true, 'the empty cache is released after the first slice');
  // The second slice continues from the first slice's present states.
  assert.equal(Object.keys(second).filter(name => name.startsWith('past_')).length, 13 + 22);
  assert.equal(cache.length, 6);
  assert.ok(cache.feeds['past_conv.23'] && cache.feeds['past_key_values.22.value']);
  assert.equal(logits[6], 1);
  // A continuation reads the prefix cache without consuming it.
  decoder.calls.length = 0;
  const branch = await engine.continuation(inputs, cache, 'Y');
  assert.deepEqual(Array.from(decoder.calls[0].position_ids.data, Number), [6]);
  assert.deepEqual(decoder.calls[0].image_features.dims, [0, 2]);
  assert.equal(branch.tokens, 1);
  assert.deepEqual(Array.from(branch.hidden), [0, 0, 0, 0]);
  assert.equal(cache.feeds['past_conv.0'].disposed, false, 'the prefix cache stays usable');
  v6.CompassVldV6Runtime.disposeCache(cache);
  await assert.rejects(engine.continuation(inputs, engine.emptyCache(), String.fromCharCode(9)), /image token/);
});

test('generation is greedy, stops at <|im_end|>, and checks for a stop before every step', async () => {
  const ort = fakeOrt();
  const decoder = fakeDecoder(ort, { script: [5, 6, 3] });
  const tokenizer = { encode: text => Array.from(text, ch => ch.charCodeAt(0)), _tokenizer: null, all_special_tokens: [] };
  const cfg = { ...v6.COMPASS_VLD_V6, hidden: 2, imageTokenId: 9, eosTokenIds: [3] };
  const engine = new v6.CompassVldV6Runtime(ort, tokenizer, { vision_encoder: null, decoder }, cfg);
  let checks = 0;
  const result = await engine.generate('ab', [], { maxNewTokens: 10, shouldStop: () => { checks += 1; } });
  assert.deepEqual(result.ids, [5, 6]);
  assert.equal(result.finished, true);
  assert.equal(result.promptTokens, 2);
  assert.ok(checks >= 2);
  assert.deepEqual(Array.from(decoder.calls[1].input_ids.data, Number), [5]);
  assert.deepEqual(Array.from(decoder.calls[2].position_ids.data, Number), [3]);
  await assert.rejects(engine.buildInputs('x<|image|>', [{ tokens: 2, pixels: new Float32Array(0), gridH: 2, gridW: 4 }]), /image tokens for 2 image patches|1 image tokens/);
});

test("v6's decision probe scores options by their Yes margin; Tiny v5 keeps its own", async () => {
  const probes = await import('../src/chrome/src/offscreen/compass-vld-decision-probe.js');
  assert.equal(probes.compassVldDecisionProbe(MODEL)?.hiddenSize, 2048);
  assert.equal(probes.compassVldDecisionProbe(webgpu.WEBGPU_COMPASS_VLD_TINY_V5_MODEL_ID)?.hiddenSize, 1024);
  assert.equal(probes.compassVldDecisionProbe('webbrain-one/other'), null);
  const hidden = new Float32Array(2048).fill(0.5);
  assert.deepEqual(probes.compassVldProbeScores([2.5, -1.25], [hidden, hidden], MODEL), [2.5, -1.25]);
  assert.throws(() => probes.compassVldProbeScores([1], [new Float32Array(1024)], MODEL), /needs the decoder hidden state/);
  assert.throws(() => probes.compassVldProbeScores([1], [hidden], 'webbrain-one/other'), /No decision probe/);
});

test('the worker runs v6 on its own runtime, with its dtype and probe', async () => {
  const worker = await readFile(new URL('../src/chrome/src/offscreen/inference-worker.js', import.meta.url), 'utf8');
  assert.match(worker, /const engine = isCompassVldV6Model\(modelId\)\s*\? new CompassVldV6Runtime\(ort, tokenizer, sessions\)\s*: new CompassVldRuntime\(ort, tokenizer, sessions\);/);
  assert.match(worker, /runtime\.compassVld\.preprocess\(toRGB\(/);
  assert.equal((worker.match(/payload\?\.dtype \|\| compassVldDtype\(modelId\)/g) || []).length, 2);
  assert.match(worker, /variant === 'probe' && !compassVldDecisionProbe\(modelId\)/);
  assert.match(worker, /compassVldProbeScores\(margins, hidden, modelId\)/);
});

// End to end on CPU, when a local copy of the bundle and onnxruntime-node are given.
const LOCAL = process.env.WEBBRAIN_COMPASS_VLD_V6_DIR;
const ORT_NODE = process.env.WEBBRAIN_ORT_NODE;
test('end to end on CPU: a vision-suite screenshot gets a six-section answer', { skip: !(LOCAL && ORT_NODE && existsSync(`${LOCAL}/onnx/decoder_q4f16.onnx`)) && 'set WEBBRAIN_COMPASS_VLD_V6_DIR and WEBBRAIN_ORT_NODE', timeout: 30 * 60 * 1000 }, async () => {
  const require = createRequire(import.meta.url);
  const ort = require(ORT_NODE);
  const library = await import('../src/chrome/vendor/transformers/transformers.web.js');
  const cacheFiles = new Map();
  for (const path of ['tokenizer.json', 'tokenizer_config.json', 'chat_template.jinja']) cacheFiles.set(shared.compassVldFileUrl(MODEL, path), await readFile(`${LOCAL}/${path}`));
  const cache = { async match(url) { const bytes = cacheFiles.get(url); return bytes ? new Response(bytes) : undefined; } };
  const tokenizer = await shared.createCompassVldTokenizer(library, cache, MODEL);
  const options = { executionProviders: ['cpu'], graphOptimizationLevel: 'all' };
  const engine = new v6.CompassVldV6Runtime(ort, tokenizer, {
    vision_encoder: await ort.InferenceSession.create(`${LOCAL}/onnx/vision_encoder_fp16.onnx`, options),
    decoder: await ort.InferenceSession.create(`${LOCAL}/onnx/decoder_q4f16.onnx`, options),
  });
  const { PNG } = require(require.resolve('pngjs', { paths: [ORT_NODE] }));
  const png = PNG.sync.read(await readFile(new URL('./vision/images/001.png', import.meta.url)));
  const image = engine.preprocess(shared.toRGB(png.data, png.width, png.height, 4), png.width, png.height);
  const { VISION_SYSTEM_PROMPT, PRODUCTION_USER_TEXT } = await import('./vision/prompt.mjs');
  const prompt = tokenizer.apply_chat_template(engine.plainStrings([
    { role: 'system', content: VISION_SYSTEM_PROMPT },
    { role: 'user', content: [{ type: 'image' }, { type: 'text', text: PRODUCTION_USER_TEXT }] },
  ]), { add_generation_prompt: true, tokenize: false, enable_thinking: false });
  assert.ok(prompt.endsWith('<|im_start|>assistant\n<think></think>'), 'thinking is off');
  const output = await engine.generate(prompt, [image], { maxNewTokens: 400 });
  const text = tokenizer.decode(output.ids, { skip_special_tokens: true });
  assert.equal(output.finished, true);
  for (const section of ['Page purpose', 'Visible text', 'Inputs', 'State signals', 'Blockers', 'Unknowns']) assert.match(text, new RegExp(section));
  const { scoreVisionResponse } = await import('./vision/lib/score.mjs');
  const expected = JSON.parse(await readFile(new URL('./vision/expected/001.json', import.meta.url), 'utf8'));
  const score = scoreVisionResponse({ content: text, expected });
  // The published BF16 run scored this case 0.7 (test/vision/results/2026-10-31-compass-vld-v6-2b-full_*).
  assert.equal(score.sectionCount, 6);
  assert.ok(score.ratio >= 0.6, `vision rubric: ${score.ratio}`);
});
