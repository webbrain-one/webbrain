// Reference run of the extension's Compass VLD v6 decision path on
// onnxruntime-node (CPU), for checking the Companion's Go port against it:
// the extension's own modules (compass-vld-v6-runtime.js, webgpu-decisions.js,
// compass-vld-decision-probe.js, d1-runtime.js splitD1State, the vendored
// Transformers.js tokenizer and chat template), with runCompassVldDecision's
// "probe" orchestration copied from inference-worker.js. Images are the
// pixels Chromium decoded (parity-fixtures.mjs), as the offscreen worker's
// load_image returns them. Writes the same trace as
// `go run ./tools/d1check -engine compass -trace` (in webbrain-systray/).
//
//   npm install --no-save onnxruntime-node@1.31.1   (outside the repo is fine)
//   node scripts/models/compass-vld/parity-cpu.mjs --model <bundle dir> --fixtures <dir> \
//     --modules <dir with node_modules> --out ref.json [--threads 8]
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const args = process.argv.slice(2);
const option = (name, fallback) => { const i = args.indexOf(name); return i < 0 ? fallback : args[i + 1]; };
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
// onnxruntime-node's binding rejects Float16Array data; without it, fp16
// tensors stay Uint16Array (the runtime's read() converts either exactly).
delete globalThis.Float16Array;
const ort = createRequire(path.join(path.resolve(option('--modules', '.')), 'node_modules', 'x.js'))('onnxruntime-node');
const modelDir = path.resolve(option('--model'));
const fixtures = path.resolve(option('--fixtures'));
const threads = Number(option('--threads', 0));
const only = option('--only', '');
const mod = rel => import(pathToFileURL(path.join(repo, rel)).href);

const { PreTrainedTokenizer } = await mod('src/chrome/vendor/transformers/transformers.web.js');
const { CompassVldV6Runtime } = await mod('src/chrome/src/offscreen/compass-vld-v6-runtime.js');
const { CompassVldRuntime, jinjaForTransformersJs, toRGB } = await mod('src/chrome/src/offscreen/compass-vld-runtime.js');
const { decisionSystemPrompt, decisionStateText, decisionVerifyText, decisionOptions, decisionAnswer, normalizeDecisionRequest } = await mod('src/chrome/src/offscreen/webgpu-decisions.js');
const { compassVldDecisionProbe, compassVldProbeScores } = await mod('src/chrome/src/offscreen/compass-vld-decision-probe.js');
const { splitD1State } = await mod('src/chrome/src/providers/d1-runtime.js');
const workerSource = await fs.readFile(path.join(repo, 'src/chrome/src/offscreen/inference-worker.js'), 'utf8');
const SLICE = Number(/BONSAI2_DEFAULT_PREFILL_SLICE_TOKENS = (\d+)/.exec(workerSource)[1]);
const MODEL_ID = 'webbrain-one/webbrain-compass-vld-v6-2b-onnx';

const sha = values => crypto.createHash('sha256').update(Buffer.from(values.buffer, values.byteOffset, values.byteLength)).digest('hex');

// Tokenizer as createCompassVldTokenizer builds it.
const json = async name => JSON.parse(await fs.readFile(path.join(modelDir, name), 'utf8'));
const tokenizer = new PreTrainedTokenizer(await json('tokenizer.json'), await json('tokenizer_config.json'));
tokenizer.chat_template = jinjaForTransformersJs(await fs.readFile(path.join(modelDir, 'chat_template.jinja'), 'utf8'));

const sessionOptions = { graphOptimizationLevel: 'all', ...(threads ? { intraOpNumThreads: threads } : {}) };
const sessions = {
  vision_encoder: await ort.InferenceSession.create(path.join(modelDir, 'onnx/vision_encoder_fp16.onnx'), sessionOptions),
  decoder: await ort.InferenceSession.create(path.join(modelDir, 'onnx/decoder_q8f16.onnx'), sessionOptions),
};
const engine = new CompassVldV6Runtime(ort, tokenizer, sessions);

// Images by data URL -> Chromium's RGBA.
const meta = JSON.parse(await fs.readFile(path.join(fixtures, 'images/meta.json'), 'utf8'));
const imageFiles = Object.keys(meta);
const urlToFile = new Map();
for (const file of imageFiles) {
  const bytes = await fs.readFile(path.join(fixtures, 'images', file));
  const type = file.endsWith('.png') ? 'png' : file.endsWith('.jpg') ? 'jpeg' : 'webp';
  urlToFile.set(`data:image/${type};base64,${bytes.toString('base64')}`, file);
}
async function loadImage(url) {
  const file = urlToFile.get(url);
  if (!file) throw new Error('unknown fixture image');
  const data = new Uint8Array(await fs.readFile(path.join(fixtures, 'images', `${file}.rgba`)));
  return { data, width: meta[file].width, height: meta[file].height, channels: 4 };
}

const DECISION_QUESTION_MARKER = '⁣WEBBRAIN_DECISION_QUESTION⁣';

// runCompassVldDecision (inference-worker.js), variant 'probe', recording a trace.
async function decide(payload) {
  const modelId = MODEL_ID;
  const request = normalizeDecisionRequest(payload);
  const temperature = 1;
  const variant = 'probe';
  if (!compassVldDecisionProbe(modelId)) throw new Error('no probe');
  const plain = text => engine.plainText(text);
  const messages = [
    { role: 'system', content: [{ type: 'text', text: decisionSystemPrompt(payload?.promptVariant) }] },
    { role: 'user', content: [
      ...request.images.map(() => ({ type: 'image' })),
      { type: 'text', text: `${plain(decisionStateText(request.state))}\n\n${DECISION_QUESTION_MARKER}` },
    ] },
  ];
  const rendered = tokenizer.apply_chat_template(messages, { add_generation_prompt: true, enable_thinking: false, tokenize: false });
  const split = rendered.indexOf(DECISION_QUESTION_MARKER);
  if (split < 0 || rendered.indexOf(DECISION_QUESTION_MARKER, split + 1) >= 0) throw new Error('The decision prompt did not render as expected.');
  const prefixText = rendered.slice(0, split);
  const tailText = rendered.slice(split + DECISION_QUESTION_MARKER.length);
  const codeId = code => { const ids = engine.encode(code); if (ids.length !== 1) throw new Error(code); return ids[0]; };
  const started = performance.now();
  const trace = { prefix: prefixText, tail: tailText, images: [], pixel_sha256: [], feature_sha256: [], continuations: [] };
  let prefill = null;
  const answers = {};
  let suffixTokens = 0;
  try {
    const images = [];
    for (const url of request.images) {
      const image = await loadImage(url);
      images.push(engine.preprocess(toRGB(image.data, image.width, image.height, image.channels), image.width, image.height));
    }
    const prefix = await engine.buildInputs(prefixText, images);
    trace.prefix_ids = prefix.ids;
    let offset = 0;
    for (const image of images) {
      trace.images.push({ width: image.width, height: image.height, grid_h: image.gridH, grid_w: image.gridW, tokens: image.tokens });
      trace.pixel_sha256.push(sha(image.pixels));
      trace.feature_sha256.push(sha(prefix.features.subarray(offset, offset + image.tokens * 2048)));
      offset += image.tokens * 2048;
    }
    prefill = await engine.prefill(prefix, { sliceTokens: SLICE });
    const yesId = codeId('Yes'), noId = codeId('No');
    for (const [id, question] of request.entries) {
      const margins = [], hidden = [];
      const count = decisionOptions(question).names.length;
      for (let index = 0; index < count; index++) {
        const text = `${plain(decisionVerifyText(question, index))}${tailText}`;
        const output = await engine.continuation(prefix, prefill.cache, text);
        suffixTokens += output.tokens;
        margins.push(output.logits[yesId] - output.logits[noId]);
        hidden.push(output.hidden);
        trace.continuations.push({ question: id, index, text, ids: engine.encode(text), yes: output.logits[yesId], no: output.logits[noId],
          margin: output.logits[yesId] - output.logits[noId], logits_sha256: sha(output.logits), hidden_sha256: sha(output.hidden) });
      }
      const scores = compassVldProbeScores(margins, hidden, modelId);
      answers[id] = decisionAnswer(question, scores, { temperature });
    }
    return { result: { model: modelId, answers, usage: { input_tokens: prefix.ids.length + suffixTokens, output_tokens: 0 }, total_ms: Math.round(performance.now() - started) }, trace };
  } finally {
    if (prefill) CompassVldRuntime.disposeCache(prefill.cache);
  }
}

const cases = JSON.parse(await fs.readFile(path.join(fixtures, 'cases.json'), 'utf8'));
const results = [];
for (const [i, body] of cases.entries()) {
  if (only && !only.split(',').map(Number).includes(i)) { results.push(null); continue; }
  const t = performance.now();
  try {
    // The extension's evaluateWebgpuDecision splits screenshots out of the state first.
    const input = splitD1State(body.state, body.images || []);
    const { result, trace } = await decide({ state: input.state, images: input.images, questions: body.questions });
    results.push({ ok: true, result, trace, ms: performance.now() - t });
  } catch (error) {
    results.push({ ok: false, error: String(error?.message || error), ms: performance.now() - t });
  }
  console.error(`case ${i}: ${Math.round(performance.now() - t)} ms`);
}
await fs.writeFile(option('--out', 'ref.json'), JSON.stringify(results, null, 1));
// onnxruntime-node can deadlock in its thread-pool teardown at exit on Windows.
process.kill(process.pid, 'SIGKILL');
