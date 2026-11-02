/**
 * WebBrain Compass VLD Tiny v5 in the offscreen WebGPU worker: one model for
 * chat and tool calls, screenshots and decisions.
 *
 * The published ONNX bundle (webbrain-one/webbrain-compass-vld-tiny-v5-onnx,
 * a fine-tune of openbmb/MiniCPM-V-4.7-1B) has three graphs:
 *   embed_tokens          input_ids int64[1,S] -> inputs_embeds float32[1,S,1024]
 *   vision_encoder        pixel_values float32[n,3,H,W] -> image_features float32[n,T,1024]
 *                         (SigLIP and the fine-tuned merger, 16x downsampling)
 *   decoder_model_merged  Qwen3.5-0.8B topology (18 GatedDeltaNet + 6 attention
 *                         layers, canvas M-RoPE). Chunked GatedDeltaNet prefill,
 *                         so no ONNX Scan; outputs last-position `logits` and
 *                         `decision_hidden`.
 * Transformers.js has no MiniCPM-V processor, so this module ports it exactly:
 * slicing, Pillow-compatible bicubic resampling, normalization, the image
 * placeholders and the canvas M-RoPE positions (MiniCPMV4_7Model.get_rope_index).
 * Token ids and positions match the PyTorch processor; pixels differ by at most
 * 2/255 on about 0.01% of values.
 *
 * Model files are fetched only by an explicit download, into the same Cache
 * Storage the Transformers.js presets use (one file at a time, each checked
 * against its pinned size and SHA-256). Inference reads them from the cache
 * and never downloads.
 *
 * The download, cache and tokenizer code here serves every Compass VLD build:
 * each model ID has its own pinned files (compassVldSpec). Compass VLD v6 2B,
 * an LFM3-VL model, has its own processor and decoder loop in
 * compass-vld-v6-runtime.js; calls that name no model mean Tiny v5.
 */

import {
  COMPASS_VLD_V6_DTYPE, COMPASS_VLD_V6_FILE_PINS, COMPASS_VLD_V6_GRAPHS, COMPASS_VLD_V6_METADATA_FILES,
  COMPASS_VLD_V6_MODEL_ID, COMPASS_VLD_V6_REVISION,
} from './compass-vld-v6-files.js';

export const COMPASS_VLD_TINY_V5_MODEL_ID = 'webbrain-one/webbrain-compass-vld-tiny-v5-onnx';
export { COMPASS_VLD_V6_MODEL_ID };
export const COMPASS_VLD_MODEL_IDS = new Set([COMPASS_VLD_TINY_V5_MODEL_ID, COMPASS_VLD_V6_MODEL_ID]);
// Files are read at this commit: a later commit (a model card edit, a new
// graph) cannot change what an install downloads. A new graph needs a new
// revision here and new pins below.
export const COMPASS_VLD_REVISION = '1938a9126de7a7eb3fa33021bc4a3f32c7d30a71';
export const COMPASS_VLD_DTYPE = Object.freeze({
  embed_tokens: 'q8f16',
  vision_encoder: 'fp16',
  decoder_model_merged: 'q8f16',
});

// Sizes and SHA-256 of every file the runtime reads, from the bundle's manifest.json.
const COMPASS_VLD_FILE_PINS = Object.freeze({
  'config.json': [4441, '2d97cdb960777dba301f90f74029cfa0d66d98a501da81a4e49a61dea878fbe4'],
  'generation_config.json': [132, '4dc190baaab3bc4bccb796ee73deb2c3dd776cd4feae3587b29bc22083e03415'],
  'preprocessor_config.json': [148, 'c64289d04f36e48d9d059e3a0069f54062b2ef6044a807adb448b98449cb54de'],
  'tokenizer.json': [19992481, '33861e37bb955af1e3f3061182b820f347eba2b9c2c1011c82794bf0d6e77b54'],
  'tokenizer_config.json': [1436, '900ecc6ba690a07270dc23935d17bbb7d2ed69a073a90a9cf731e5313e86ebba'],
  'chat_template.jinja': [7249, '49c37bcc86c7f7f20ed2ebf79e9f872be41ba2b5f9d0d51e6712cc038ef51d6c'],
  'onnx/embed_tokens_q8f16.onnx': [1064, '605d1d2d6f65c2ae15de05f05d59624bf41e633e93c895159d233282d46ce759'],
  'onnx/embed_tokens_q8f16.onnx_data': [277865280, 'd06adf7bb93e83082b847e1a256f4b49ebb93e814d340872b3e4e52f7466446d'],
  'onnx/vision_encoder_fp16.onnx': [1529020, '0e0f9d302d7d259abcd2de4694fe72ebe67b68913a0b292acf7887e47fb00cdc'],
  'onnx/vision_encoder_fp16.onnx_data': [1102774272, '68e1509f942a5f962660297972b1ce8bd535cc5d63427ea4553c2f54ea9e8be3'],
  'onnx/decoder_model_merged_q8f16.onnx': [2879432, 'e468fdee1f20e04bef3ae67d369638f63b9b31d98d39893c6341c068b1b06e11'],
  'onnx/decoder_model_merged_q8f16.onnx_data': [824095552, '45f1d46badc2ce79a1bdcbc475c2bb9ebcb848b2d7ec92298f01a2e9ba85af48'],
  'onnx/embed_tokens_q4f16.onnx': [1064, '59eac222a8ffe689406113bba0ded116ed49382d5d81971256eea5091d0883a4'],
  'onnx/embed_tokens_q4f16.onnx_data': [146871648, 'e66afca277d4748bbe06fb54ff1fa6aad47d42528602b922c961a8c087f9800c'],
  'onnx/decoder_model_merged_q4f16.onnx': [2869977, '00b375f8feee6438ca0d7a50e8f0df54da9af1a45dc53c4a5107d528d82ccda9'],
  'onnx/decoder_model_merged_q4f16.onnx_data': [436528480, '6f202044cf1b3774d76e806d9863ee8990364ea34be11f979d6dac00762c7ccc'],
});
const COMPASS_VLD_METADATA_FILES = Object.freeze([
  'config.json', 'generation_config.json', 'preprocessor_config.json',
  'tokenizer_config.json', 'chat_template.jinja', 'tokenizer.json',
]);
const COMPASS_VLD_GRAPHS = Object.freeze(['embed_tokens', 'vision_encoder', 'decoder_model_merged']);

const COMPASS_VLD_SPECS = Object.freeze({
  [COMPASS_VLD_TINY_V5_MODEL_ID]: Object.freeze({
    label: 'Compass VLD Tiny v5',
    revision: COMPASS_VLD_REVISION,
    dtype: COMPASS_VLD_DTYPE,
    graphs: COMPASS_VLD_GRAPHS,
    metadataFiles: COMPASS_VLD_METADATA_FILES,
    pins: COMPASS_VLD_FILE_PINS,
  }),
  [COMPASS_VLD_V6_MODEL_ID]: Object.freeze({
    label: 'Compass VLD v6 2B',
    revision: COMPASS_VLD_V6_REVISION,
    dtype: COMPASS_VLD_V6_DTYPE,
    graphs: COMPASS_VLD_V6_GRAPHS,
    metadataFiles: COMPASS_VLD_V6_METADATA_FILES,
    pins: COMPASS_VLD_V6_FILE_PINS,
  }),
});

export function isCompassVldModel(modelId) {
  return COMPASS_VLD_MODEL_IDS.has(String(modelId || '').trim());
}

export function isCompassVldV6Model(modelId) {
  return String(modelId || '').trim() === COMPASS_VLD_V6_MODEL_ID;
}

/** A Compass VLD build's pinned revision, graphs, default dtype and files (Tiny v5 when unnamed). */
export function compassVldSpec(modelId = COMPASS_VLD_TINY_V5_MODEL_ID) {
  return COMPASS_VLD_SPECS[String(modelId || '').trim()] || COMPASS_VLD_SPECS[COMPASS_VLD_TINY_V5_MODEL_ID];
}

/** The dtype a Compass VLD build loads by default. */
export function compassVldDtype(modelId) {
  return compassVldSpec(modelId).dtype;
}

function graphDtype(dtype, graph, spec) {
  const value = dtype && typeof dtype === 'object' ? dtype[graph] : dtype;
  return String(value || spec.dtype[graph]);
}

/** The files one dtype choice reads, each with its pinned size and SHA-256. */
export function compassVldFiles(dtype, modelId = COMPASS_VLD_TINY_V5_MODEL_ID) {
  const spec = compassVldSpec(modelId);
  const choice = dtype || spec.dtype;
  const graphFiles = spec.graphs.flatMap(graph => {
    const name = `onnx/${graph}_${graphDtype(choice, graph, spec)}.onnx`;
    return [name, `${name}_data`];
  });
  return [...spec.metadataFiles, ...graphFiles].map(path => {
    const pin = spec.pins[path];
    if (!pin) throw new Error(`${spec.label} has no ${path}.`);
    return { path, bytes: pin[0], sha256: pin[1] };
  });
}

/** The file's Hugging Face URL at the pinned revision, which is also its Cache Storage key. */
export function compassVldFileUrl(modelId, path, revision = compassVldSpec(modelId).revision) {
  return `https://huggingface.co/${modelId}/resolve/${encodeURIComponent(revision)}/${path}`;
}

/**
 * The Cache Storage key of the entry that records a file passed its SHA-256
 * check, beside the file under the same revision (so removing the model or
 * an earlier revision removes it too). Its body is the hash the file matched.
 * A file's own headers are written before its body arrives, so they cannot
 * say whether it was checked: a worker that stops between storing a file and
 * checking it leaves the file unchecked.
 */
export function compassVldVerifiedUrl(modelId, path, revision = compassVldSpec(modelId).revision) {
  return `${compassVldFileUrl(modelId, path, revision)}?webbrain-verified`;
}

async function sha256Hex(buffer) {
  const digest = await crypto.subtle.digest('SHA-256', buffer);
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

async function fileVerified(cache, modelId, file) {
  const [stored, verified] = await Promise.all([
    cache.match(compassVldFileUrl(modelId, file.path)),
    cache.match(compassVldVerifiedUrl(modelId, file.path)),
  ]);
  return !!stored && !!verified && await verified.text() === file.sha256;
}

/** Whether every file is in the cache and passed its SHA-256 check (no hashing). */
export async function compassVldFilesCached(cache, modelId, dtype = compassVldDtype(modelId), files = compassVldFiles(dtype, modelId)) {
  for (const file of files) {
    if (!await fileVerified(cache, modelId, file)) return false;
  }
  return true;
}

// Whether the file stored at `url` has its pinned size and SHA-256; one that
// does not is removed.
async function storedFileMatches(cache, url, file) {
  const stored = await cache.match(url);
  if (!stored) return false;
  const bytes = await stored.arrayBuffer();
  if (bytes.byteLength === file.bytes && await sha256Hex(bytes) === file.sha256) return true;
  await cache.delete(url);
  return false;
}

// A dropped connection or a server error fails a file's transfer; it is tried
// again from the start, twice, before the download fails. A missing file, a
// hash mismatch, a pause or a stop is not retried.
const NETWORK_RETRIES = 2;
const RETRY_DELAY_MS = 2000;
const cancelledError = () => Object.assign(new Error('The download was cancelled.'), { name: 'AbortError' });
const transient = error => error?.name !== 'AbortError' && (error instanceof TypeError || error?.transient === true);

/**
 * Fetch the missing files into `cache`, one at a time. A file is stored only
 * once its whole body arrived (Cache.put is atomic), then read back and
 * checked against its pinned SHA-256; a mismatch removes it and fails the
 * download, and a match is recorded (compassVldVerifiedUrl). A file an earlier
 * download stored but never checked is checked now instead of fetched again.
 * `onProgress` gets Transformers.js-shaped events.
 */
export async function downloadCompassVld({
  cache, fetchImpl, modelId, dtype = compassVldDtype(modelId), files = compassVldFiles(dtype, modelId), onProgress = () => {}, isCancelled = () => false,
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
}) {
  for (const file of files) {
    onProgress({ status: 'progress', file: file.path, loaded: 0, total: file.bytes });
  }
  for (const file of files) {
    if (isCancelled()) throw cancelledError();
    const url = compassVldFileUrl(modelId, file.path);
    const verifiedUrl = compassVldVerifiedUrl(modelId, file.path);
    if (await fileVerified(cache, modelId, file)) {
      onProgress({ status: 'done', file: file.path, loaded: file.bytes, total: file.bytes });
      continue;
    }
    // Whatever is stored now has not been checked.
    await cache.delete(verifiedUrl);
    if (!await storedFileMatches(cache, url, file)) {
      for (let attempt = 0; ; attempt += 1) {
        try {
          await fetchIntoCache(cache, fetchImpl, url, file, onProgress);
          break;
        } catch (error) {
          if (isCancelled()) throw cancelledError();
          if (!transient(error) || attempt >= NETWORK_RETRIES) throw error;
          await cache.delete(url).catch(() => {});
          onProgress({ status: 'progress', file: file.path, loaded: 0, total: file.bytes });
          await sleep(RETRY_DELAY_MS * (attempt + 1));
          if (isCancelled()) throw cancelledError();
        }
      }
      if (!await storedFileMatches(cache, url, file)) {
        throw new Error(`${file.path} failed its integrity check; download the model again.`);
      }
    }
    await cache.put(verifiedUrl, new Response(file.sha256, { headers: { 'content-type': 'text/plain' } }));
    onProgress({ status: 'done', file: file.path, loaded: file.bytes, total: file.bytes });
  }
  await removeOtherCompassVldRevisions(cache, modelId);
}

/** Delete this model's files from any other revision, left by an earlier pin. */
export async function removeOtherCompassVldRevisions(cache, modelId, revision = compassVldSpec(modelId).revision) {
  if (typeof cache.keys !== 'function') return 0;
  const base = `https://huggingface.co/${modelId}/resolve/`;
  const current = `${base}${encodeURIComponent(revision)}/`;
  let removed = 0;
  for (const request of await cache.keys()) {
    const url = typeof request === 'string' ? request : request.url;
    if (url.startsWith(base) && !url.startsWith(current) && await cache.delete(request)) removed += 1;
  }
  return removed;
}

async function fetchIntoCache(cache, fetchImpl, url, file, onProgress) {
  const response = await fetchImpl(url, { cache: 'no-store' });
  if (!response?.ok || !response.body) {
    const status = Number(response?.status) || 0;
    throw Object.assign(new Error(`Downloading ${file.path} failed (HTTP ${status || 'error'}).`), { transient: status === 429 || status >= 500 });
  }
  let loaded = 0;
  const counter = new TransformStream({
    transform(chunk, controller) {
      loaded += chunk.byteLength;
      onProgress({ status: 'progress', file: file.path, loaded, total: file.bytes });
      controller.enqueue(chunk);
    },
  });
  // No content-length: the pinned size is not yet known to be the stored one,
  // and nothing reads a file's size from its headers.
  await cache.put(url, new Response(response.body.pipeThrough(counter), {
    headers: { 'content-type': 'application/octet-stream' },
  }));
}

async function cachedBytes(cache, modelId, path) {
  const response = await cache.match(compassVldFileUrl(modelId, path));
  if (!response) {
    const error = new Error(`${modelId} is not cached locally (${path}).`);
    error.code = 'text_model_not_downloaded';
    throw error;
  }
  return new Uint8Array(await response.arrayBuffer());
}

export async function cachedCompassVldText(cache, modelId, path) {
  return new TextDecoder().decode(await cachedBytes(cache, modelId, path));
}

/**
 * The model's Transformers.js tokenizer, built from the cached files: the class
 * AutoTokenizer would pick, with the chat template. AutoTokenizer.from_pretrained
 * is not used because it first looks for tokenizer_config.json at revision
 * `main`, which this pinned download never caches: offline it finds nothing,
 * and online it asks Hugging Face on every load.
 */
export async function createCompassVldTokenizer(library, cache, modelId) {
  const [tokenizerJSON, tokenizerConfig, chatTemplate] = await Promise.all([
    cachedCompassVldText(cache, modelId, 'tokenizer.json').then(JSON.parse),
    cachedCompassVldText(cache, modelId, 'tokenizer_config.json').then(JSON.parse),
    cachedCompassVldText(cache, modelId, 'chat_template.jinja'),
  ]);
  const name = String(tokenizerConfig.tokenizer_class || '').replace(/Fast$/, '');
  const Base = library.PreTrainedTokenizer;
  const Tokenizer = name && (library[name] === Base || library[name]?.prototype instanceof Base) ? library[name] : Base;
  const tokenizer = new Tokenizer(tokenizerJSON, tokenizerConfig);
  // The template ships as chat_template.jinja; Transformers.js reads only tokenizer_config.json.
  tokenizer.chat_template = jinjaForTransformersJs(chatTemplate);
  return tokenizer;
}

/**
 * A chat template Transformers.js can render. `{% generation %}…{% endgeneration %}`
 * (in Compass VLD v6's template) only marks assistant text for training masks in
 * Python Transformers (AssistantTracker) and renders its body unchanged, but
 * Transformers.js's Jinja does not know the tag; an always-true `if` with the
 * same whitespace control renders identically.
 */
export function jinjaForTransformersJs(template) {
  return String(template)
    .replace(/\{%(-?)\s*generation\s*(-?)%\}/g, '{%$1 if true $2%}')
    .replace(/\{%(-?)\s*endgeneration\s*(-?)%\}/g, '{%$1 endif $2%}');
}

/** Create the model's sessions from cached files, one at a time (ORT Web's WebGPU EP requires it). */
export async function createCompassVldSessions(ort, cache, modelId, dtype = compassVldDtype(modelId), { sessionOptions = {} } = {}) {
  const spec = compassVldSpec(modelId);
  const sessions = {};
  try {
    for (const graph of spec.graphs) {
      const name = `${graph}_${graphDtype(dtype, graph, spec)}.onnx`;
      const model = await cachedBytes(cache, modelId, `onnx/${name}`);
      const data = await cachedBytes(cache, modelId, `onnx/${name}_data`);
      sessions[graph] = await ort.InferenceSession.create(model, {
        executionProviders: ['webgpu'],
        graphOptimizationLevel: 'all',
        preferredOutputLocation: 'gpu-buffer',
        ...sessionOptions,
        externalData: [{ path: `${name}_data`, data }],
      });
    }
  } catch (error) {
    for (const session of Object.values(sessions)) await session?.release?.().catch?.(() => {});
    throw error;
  }
  return sessions;
}

export const COMPASS_VLD = Object.freeze({
  imageTokenId: 248056,
  imageStartId: 248078, // <image>
  imageEndId: 248079, // </image>
  sliceStartId: 248088, // <slice>
  sliceEndId: 248089, // </slice>
  newlineId: 198, // "\n"
  imagePad: '<|image_pad|>',
  hidden: 1024,
  layers: 24,
  fullAttentionInterval: 4,
  gdnConv: [6144, 4],
  gdnState: [16, 128, 128],
  kvHeads: 2,
  headDim: 256,
  eosTokenIds: [248044, 248046],
  scaleResolution: 448,
  patchSize: 14,
  maxSliceNums: 9,
  mergeFactor: 4, // "16x": 4x4 patches per language-model token
});

// ---------------------------------------------------------------- Python numerics

/** Python 3 round(): ties to even. */
export function pyRound(x) {
  const r = Math.round(x);
  return (Math.abs(x % 1) === 0.5) ? 2 * Math.round(x / 2) : r;
}

/** torch.linspace(start, end, steps) in float32 (the same symmetric formula on CPU and CUDA). */
function linspaceF32(start, end, steps) {
  if (steps === 1) return [Math.fround(start)];
  const f = Math.fround;
  const s = f(start), e = f(end);
  const step = f(f(e - s) / (steps - 1));
  const half = Math.floor(steps / 2);
  const out = new Array(steps);
  for (let i = 0; i < steps; i++) {
    out[i] = i < half ? f(s + f(step * i)) : f(e - f(step * (steps - i - 1)));
  }
  return out;
}

// ---------------------------------------------------------------- slicing (processor)

function ensureDivide(length, divisor) {
  return Math.max(pyRound(length / divisor) * divisor, divisor);
}

function findBestResize(height, width, scaleResolution, patchSize, allowUpscale = false) {
  if (height * width > scaleResolution * scaleResolution || allowUpscale) {
    const aspect = width / height;
    height = Math.trunc(scaleResolution / Math.sqrt(aspect));
    width = Math.trunc(height * aspect);
  }
  return [ensureDivide(height, patchSize * 4), ensureDivide(width, patchSize * 4)];
}

function getRefineSize(height, width, grid, scaleResolution, patchSize, allowUpscale = false) {
  const [gridY, gridX] = grid;
  const refineWidth = ensureDivide(width, gridX);
  const refineHeight = ensureDivide(height, gridY);
  const [bh, bw] = findBestResize(refineHeight / gridY, refineWidth / gridX, scaleResolution, patchSize, allowUpscale);
  return [bh * gridY, bw * gridX];
}

/** [rows, cols] of the slice grid, or null for a thumbnail only. */
export function getSlicedGrid(height, width, maxSliceNums, scaleResolution) {
  const logRatio = Math.log(width / height);
  const ratio = (width * height) / (scaleResolution * scaleResolution);
  const multiple = Math.min(Math.ceil(ratio), maxSliceNums);
  if (multiple <= 1) return null;
  let best = [1, 1], minError = Infinity;
  for (const numSlices of [multiple - 1, multiple, multiple + 1]) {
    if (numSlices === 1 || numSlices > maxSliceNums) continue;
    for (let rows = 1; rows <= numSlices; rows++) {
      if (numSlices % rows !== 0) continue;
      const cols = numSlices / rows;
      const error = Math.abs(logRatio - Math.log(cols / rows));
      if (error < minError) { best = [rows, cols]; minError = error; }
      else if (error === minError && rows > best[0]) best = [rows, cols];
    }
  }
  return best;
}

// ---------------------------------------------------------------- Pillow bicubic resampling
// Port of Pillow's ImagingResample (BICUBIC, a = -0.5, support 2, antialiased
// when downscaling, 22-bit fixed-point coefficients, horizontal then vertical
// pass with uint8 rounding in between). Torch's uint8 antialiased bicubic, which
// the Transformers processor calls, reproduces Pillow's integer pipeline.
const PRECISION_BITS = 32 - 8 - 2;

function bicubic(x) {
  const a = -0.5;
  x = Math.abs(x);
  if (x < 1.0) return ((a + 2.0) * x - (a + 3.0)) * x * x + 1;
  if (x < 2.0) return (((x - 5) * x + 8) * x - 4) * a;
  return 0.0;
}

function precomputeCoeffs(inSize, outSize) {
  const scale = inSize / outSize;
  const filterscale = Math.max(scale, 1.0);
  const support = 2.0 * filterscale;
  const ksize = Math.ceil(support) * 2 + 1;
  const bounds = new Int32Array(outSize * 2);
  const kk = new Float64Array(outSize * ksize);
  const ss = 1.0 / filterscale;
  for (let xx = 0; xx < outSize; xx++) {
    const center = (xx + 0.5) * scale;
    let ww = 0.0;
    let xmin = Math.trunc(center - support + 0.5);
    if (xmin < 0) xmin = 0;
    let xmax = Math.trunc(center + support + 0.5);
    if (xmax > inSize) xmax = inSize;
    xmax -= xmin;
    const base = xx * ksize;
    let x = 0;
    for (; x < xmax; x++) {
      const w = bicubic((x + xmin - center + 0.5) * ss);
      kk[base + x] = w;
      ww += w;
    }
    for (x = 0; x < xmax; x++) if (ww !== 0.0) kk[base + x] /= ww;
    for (; x < ksize; x++) kk[base + x] = 0;
    bounds[xx * 2] = xmin;
    bounds[xx * 2 + 1] = xmax;
  }
  // Fixed point, as Pillow's normalize_coeffs_8bpc.
  const kint = new Int32Array(outSize * ksize);
  for (let i = 0; i < kk.length; i++) {
    const v = kk[i] * (1 << PRECISION_BITS);
    kint[i] = v < 0 ? Math.trunc(-0.5 + v) : Math.trunc(0.5 + v);
  }
  return { ksize, bounds, kint };
}

function clip8(v) {
  const r = Math.floor(v / (1 << PRECISION_BITS));
  return r < 0 ? 0 : (r > 255 ? 255 : r);
}

/** Resize interleaved RGB uint8 pixels with Pillow's BICUBIC. */
export function resizeBicubicRGB(src, width, height, outW, outH) {
  const half = 1 << (PRECISION_BITS - 1);
  let cur = src, cw = width, ch = height;
  if (outW !== cw) {
    const { ksize, bounds, kint } = precomputeCoeffs(cw, outW);
    const dst = new Uint8Array(outW * ch * 3);
    for (let y = 0; y < ch; y++) {
      for (let xx = 0; xx < outW; xx++) {
        const xmin = bounds[xx * 2], xmax = bounds[xx * 2 + 1], k = xx * ksize;
        let s0 = half, s1 = half, s2 = half;
        for (let x = 0; x < xmax; x++) {
          const p = (y * cw + x + xmin) * 3, w = kint[k + x];
          s0 += cur[p] * w; s1 += cur[p + 1] * w; s2 += cur[p + 2] * w;
        }
        const o = (y * outW + xx) * 3;
        dst[o] = clip8(s0); dst[o + 1] = clip8(s1); dst[o + 2] = clip8(s2);
      }
    }
    cur = dst; cw = outW;
  }
  if (outH !== ch) {
    const { ksize, bounds, kint } = precomputeCoeffs(ch, outH);
    const dst = new Uint8Array(cw * outH * 3);
    for (let yy = 0; yy < outH; yy++) {
      const ymin = bounds[yy * 2], ymax = bounds[yy * 2 + 1], k = yy * ksize;
      for (let x = 0; x < cw; x++) {
        let s0 = half, s1 = half, s2 = half;
        for (let y = 0; y < ymax; y++) {
          const p = ((y + ymin) * cw + x) * 3, w = kint[k + y];
          s0 += cur[p] * w; s1 += cur[p + 1] * w; s2 += cur[p + 2] * w;
        }
        const o = (yy * cw + x) * 3;
        dst[o] = clip8(s0); dst[o + 1] = clip8(s1); dst[o + 2] = clip8(s2);
      }
    }
    cur = dst; ch = outH;
  }
  return cur;
}

function cropRGB(src, width, x0, y0, w, h) {
  const out = new Uint8Array(w * h * 3);
  for (let y = 0; y < h; y++) out.set(src.subarray(((y0 + y) * width + x0) * 3, ((y0 + y) * width + x0 + w) * 3), y * w * 3);
  return out;
}

// The processor fuses rescale (1/255) and normalize (mean = std = 0.5) into (x - 127.5) / 127.5 in float32.
const NORM_LUT = (() => {
  const table = new Float32Array(256);
  for (let x = 0; x < 256; x++) table[x] = Math.fround((x - 127.5) / 127.5);
  return table;
})();

function normalizeCHW(rgb, w, h) {
  const out = new Float32Array(3 * h * w);
  const plane = h * w;
  for (let i = 0; i < plane; i++) {
    for (let c = 0; c < 3; c++) out[c * plane + i] = NORM_LUT[rgb[i * 3 + c]];
  }
  return out;
}

/** Interleaved RGB from RGB or RGBA pixels (alpha dropped, as the processor's RGB conversion does). */
export function toRGB(data, width, height, channels) {
  if (channels === 3) return data instanceof Uint8Array ? data : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  if (channels !== 4 && channels !== 1) throw new Error(`Unsupported image with ${channels} channels.`);
  const out = new Uint8Array(width * height * 3);
  for (let i = 0, j = 0; i < width * height; i++) {
    if (channels === 1) {
      out[j++] = data[i]; out[j++] = data[i]; out[j++] = data[i];
    } else {
      out[j++] = data[i * 4]; out[j++] = data[i * 4 + 1]; out[j++] = data[i * 4 + 2];
    }
  }
  return out;
}

/**
 * The processor (MiniCPMV4_6ImageProcessor, slice mode) for one image of
 * interleaved RGB pixels: the crops in placeholder order (thumbnail, then
 * slices row by row) with their patch grids, and the slice grid.
 */
export function preprocessImage(rgb, width, height, {
  maxSliceNums = COMPASS_VLD.maxSliceNums,
  scaleResolution = COMPASS_VLD.scaleResolution,
  patchSize = COMPASS_VLD.patchSize,
} = {}) {
  const grid = getSlicedGrid(height, width, maxSliceNums, scaleResolution);
  const [sh, sw] = findBestResize(height, width, scaleResolution, patchSize, grid === null);
  const crops = [];
  const source = resizeBicubicRGB(rgb, width, height, sw, sh);
  crops.push({ h: sh / patchSize, w: sw / patchSize, width: sw, height: sh, pixels: normalizeCHW(source, sw, sh) });
  if (grid) {
    const [rh, rw] = getRefineSize(height, width, grid, scaleResolution, patchSize, true);
    const refine = resizeBicubicRGB(rgb, width, height, rw, rh);
    const ph = Math.floor(rh / grid[0]), pw = Math.floor(rw / grid[1]);
    for (let i = 0; i < rh; i += ph) {
      for (let j = 0; j < rw; j += pw) {
        const piece = cropRGB(refine, rw, j, i, pw, ph);
        crops.push({ h: ph / patchSize, w: pw / patchSize, width: pw, height: ph, pixels: normalizeCHW(piece, pw, ph) });
      }
    }
  }
  return { crops, grid };
}

/** The processor's text for one image placeholder (use_image_id, 16x downsampling). */
export function imagePlaceholder(image, localIndex = 0) {
  const div = COMPASS_VLD.mergeFactor * COMPASS_VLD.mergeFactor;
  const [thumb, ...slices] = image.crops;
  let text = `<image_id>${localIndex}</image_id><image>${COMPASS_VLD.imagePad.repeat((thumb.h * thumb.w) / div)}</image>`;
  if (image.grid && slices.length) {
    const [rows, cols] = image.grid;
    const per = (slices[0].h * slices[0].w) / div;
    const slice = `<slice>${COMPASS_VLD.imagePad.repeat(per)}</slice>`;
    text += Array.from({ length: rows }, () => slice.repeat(cols)).join('\n');
  }
  return text;
}

/** Replace each `<|image_pad|>` the chat template rendered with its image's full placeholder. */
export function expandImagePlaceholders(prompt, images) {
  const parts = prompt.split(COMPASS_VLD.imagePad);
  if (parts.length - 1 !== images.length) {
    throw new Error(`The prompt has ${parts.length - 1} image slots for ${images.length} images.`);
  }
  let out = parts[0];
  for (let i = 0; i < images.length; i++) out += imagePlaceholder(images[i], i) + parts[i + 1];
  return out;
}

// ---------------------------------------------------------------- canvas M-RoPE

/**
 * Port of MiniCPMV4_7Model.get_rope_index for one unpadded sequence: `ids`
 * are token ids, `targetSizes` the patch grids [h, w] of every crop in order.
 * Returns the t/h/w position arrays and the next free position.
 */
export function canvasPositions(ids, targetSizes, cfg = COMPASS_VLD) {
  const S = ids.length;
  const T = new Int32Array(S), H = new Int32Array(S), W = new Int32Array(S);
  for (let i = 0; i < S; i++) { T[i] = i; H[i] = i; W[i] = i; }
  const markers = new Set([cfg.sliceStartId, cfg.sliceEndId, cfg.imageStartId, cfg.imageEndId, cfg.newlineId]);
  const isVisual = id => id === cfg.imageTokenId;
  // Runs of visual tokens are crops.
  const groups = [];
  let openSlices = null, previousEnd = 0;
  for (let i = 0; i < S;) {
    if (!isVisual(ids[i])) { i++; continue; }
    let j = i;
    while (j < S && isVisual(ids[j])) j++;
    const crop = [i, j];
    if (openSlices !== null && ids[crop[0] - 1] === cfg.sliceStartId) {
      openSlices.push(crop);
    } else {
      openSlices = [];
      const frame = { thumbStart: crop[0], thumbEnd: crop[1], slices: openSlices };
      let adjacent = groups.length > 0;
      for (let k = previousEnd; adjacent && k < crop[0] - 1; k++) if (!markers.has(ids[k])) adjacent = false;
      if (adjacent) groups[groups.length - 1].frames.push(frame);
      else groups.push({ start: crop[0] - 1, frames: [frame] });
    }
    previousEnd = crop[1];
    i = j;
  }
  const frameEnd = last => { let e = last; while (e < S && markers.has(ids[e])) e++; return e; };
  for (const g of groups) {
    for (const f of g.frames) f.end = frameEnd(f.slices.length ? f.slices[f.slices.length - 1][1] : f.thumbEnd);
    g.end = g.frames[g.frames.length - 1].end;
  }
  const set3 = (idx, t, h, w) => { T[idx] = t; H[idx] = h; W[idx] = w; };
  const mf = cfg.mergeFactor;
  let sizeIter = 0;
  const nextSize = () => targetSizes[sizeIter++];
  let currentPos = 0, currentIdx = 0;
  for (const g of groups) {
    if (g.start > currentIdx) {
      for (let k = currentIdx; k < g.start; k++) { const p = currentPos + (k - currentIdx); set3(k, p, p, p); }
      currentPos += g.start - currentIdx;
    }
    let cursor = g.start;
    for (const f of g.frames) {
      const thumbSize = nextSize();
      const frameStart = f.thumbStart - 1;
      if (frameStart > cursor) {
        for (let k = cursor; k < frameStart; k++) { const p = currentPos + (k - cursor); set3(k, p, p, p); }
        currentPos += frameStart - cursor + 1;
      }
      const fEnd = Math.min(f.end, g.end);
      const origin = currentPos;
      const halo = Math.max(origin - 1, 0);
      let sliceH = 0, sliceW = 0, numCols = 0;
      let canvasH = Math.floor(thumbSize[0] / mf), canvasW = Math.floor(thumbSize[1] / mf);
      let firstSlice = null;
      if (f.slices.length) {
        numCols = f.slices.length;
        for (let k = 0; k < f.slices.length - 1; k++) {
          if (f.slices[k + 1][0] - f.slices[k][1] > 2) { numCols = k + 1; break; }
        }
        let numRows = numCols > 0 ? Math.floor(f.slices.length / numCols) : 1;
        if (numRows * numCols !== f.slices.length) { numRows = 1; numCols = f.slices.length; }
        firstSlice = nextSize();
        sliceH = Math.floor(firstSlice[0] / mf); sliceW = Math.floor(firstSlice[1] / mf);
        canvasH = numRows * sliceH; canvasW = numCols * sliceW;
      }
      for (let k = frameStart; k < fEnd; k++) set3(k, origin, origin, origin);
      H[frameStart] = halo; W[frameStart] = halo;
      if (f.thumbEnd < fEnd) { H[f.thumbEnd] = origin + canvasH; W[f.thumbEnd] = origin + canvasW; }
      {
        // The thumbnail is stretched over the canvas.
        const gh = Math.floor(thumbSize[0] / mf), gw = Math.floor(thumbSize[1] / mf);
        const hc = linspaceF32(0, canvasH - 1, gh).map(pyRound), wc = linspaceF32(0, canvasW - 1, gw).map(pyRound);
        let k = f.thumbStart;
        for (let a = 0; a < gh; a++) for (let b = 0; b < gw; b++, k++) set3(k, origin, origin + hc[a], origin + wc[b]);
      }
      f.slices.forEach(([s0, s1], k) => {
        const hOff = Math.floor(k / numCols) * sliceH, wOff = (k % numCols) * sliceW;
        const size = k === 0 ? firstSlice : nextSize();
        const sh = Math.floor(size[0] / mf), sw = Math.floor(size[1] / mf);
        if (s0 - 1 >= frameStart) { H[s0 - 1] = origin + hOff; W[s0 - 1] = origin + wOff; }
        if (s1 < fEnd) { H[s1] = origin + hOff + sh - 1; W[s1] = origin + wOff + sw - 1; }
        let idx = s0;
        for (let a = 0; a < sh; a++) for (let b = 0; b < sw; b++, idx++) set3(idx, origin, origin + hOff + a, origin + wOff + b);
      });
      for (let k = 0; k < f.slices.length - 1; k++) {
        const gs = f.slices[k][1], ge = f.slices[k + 1][0];
        if (ge - gs <= 2) continue;
        const boundaryH = (Math.floor(k / numCols) + 1) * sliceH - 1;
        const rightEdge = numCols * sliceW;
        for (let n = gs + 1; n < ge - 1; n++) { H[n] = origin + boundaryH; W[n] = origin + rightEdge; }
      }
      currentPos = origin + Math.max(canvasH, canvasW) + 1;
      cursor = fEnd;
    }
    if (cursor < g.end) {
      for (let k = cursor; k < g.end; k++) { const p = currentPos + (k - cursor); set3(k, p, p, p); }
      currentPos += g.end - cursor;
    }
    currentIdx = g.end;
  }
  for (let k = currentIdx; k < S; k++) { const p = currentPos + (k - currentIdx); set3(k, p, p, p); }
  let max = 0;
  for (let i = 0; i < S; i++) max = Math.max(max, T[i], H[i], W[i]);
  return { t: T, h: H, w: W, nextPosition: max + 1 };
}

// ---------------------------------------------------------------- ORT runtime

/** IEEE half to float. */
export function f16ToF32(u16) {
  const out = new Float32Array(u16.length);
  for (let i = 0; i < u16.length; i++) {
    const h = u16[i], s = (h & 0x8000) ? -1 : 1, e = (h >> 10) & 0x1f, m = h & 0x3ff;
    out[i] = e === 0 ? s * m * 2 ** -24 : (e === 31 ? (m ? NaN : s * Infinity) : s * (1 + m / 1024) * 2 ** (e - 15));
  }
  return out;
}

export function argmax(values) {
  let best = 0;
  for (let i = 1; i < values.length; i++) if (values[i] > values[best]) best = i;
  return best;
}

/**
 * Every string the tokenizer encodes as one added token. Transformers.js
 * splits text on all of a tokenizer's added tokens, special or not, and this
 * model's tokenizer adds `<tool_call>`, `<tool_response>` and `<think>`
 * (with their closing tags) without marking them special, so
 * `all_special_tokens` leaves them out.
 */
export function addedTokenContents(tokenizer) {
  const added = tokenizer?._tokenizer?.get_added_tokens_decoder?.();
  if (!added) return Array.from(tokenizer?.all_special_tokens || []);
  return Array.from(added.values(), token => token.content);
}

/**
 * Text that spells one of the tokenizer's added tokens (`<|image_pad|>`,
 * `<|im_end|>`, `</tool_response>`, `<slice>`, …; addedTokenContents) would
 * be encoded as that token: an image slot with no image behind it, or a turn
 * or tool-result boundary that page text could inject. The returned function
 * puts a zero-width space after the first character of each such spelling,
 * so it stays readable and is encoded as ordinary text. It is for message
 * text before the chat template renders it; the template's own tokens are
 * added afterwards.
 */
export function plainTextFor(addedTokens = []) {
  const tokens = [...new Set(Array.from(addedTokens, String))].filter(token => token.length > 1)
    .sort((a, b) => b.length - a.length);
  if (!tokens.length) return text => String(text ?? '');
  const pattern = new RegExp(tokens.map(token => token.replace(/[\\^$.*+?()[\]{}|/-]/g, '\\$&')).join('|'), 'g');
  return text => String(text ?? '').replace(pattern, token => `${token[0]}\u200b${token.slice(1)}`);
}

export class CompassVldRuntime {
  /**
   * @param ort       onnxruntime-web (the WebGPU build Transformers.js uses)
   * @param tokenizer a Transformers.js tokenizer for this model
   * @param sessions  { embed_tokens, vision_encoder, decoder_model_merged }
   */
  constructor(ort, tokenizer, sessions, cfg = COMPASS_VLD) {
    this.ort = ort;
    this.tokenizer = tokenizer;
    this.embed = sessions.embed_tokens;
    this.vision = sessions.vision_encoder;
    this.decoder = sessions.decoder_model_merged;
    this.cfg = cfg;
    this.layerKinds = Array.from({ length: cfg.layers }, (_, i) => ((i + 1) % cfg.fullAttentionInterval === 0 ? 'attn' : 'gdn'));
    this.plainText = plainTextFor(addedTokenContents(tokenizer));
  }

  /** A copy of messages or tools with every string passed through plainText. */
  plainStrings(value) {
    if (typeof value === 'string') return this.plainText(value);
    if (Array.isArray(value)) return value.map(item => this.plainStrings(item));
    if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, this.plainStrings(item)]));
    }
    return value;
  }

  async dispose() {
    for (const session of [this.embed, this.vision, this.decoder]) {
      try { await session?.release?.(); } catch { /* already released */ }
    }
    this.embed = this.vision = this.decoder = null;
  }

  tensor(type, data, dims) {
    return new this.ort.Tensor(type, data, dims);
  }

  encode(text) {
    return Array.from(this.tokenizer.encode(text, { add_special_tokens: false }));
  }

  /** The processor for one decoded image (interleaved RGB). */
  preprocess(rgb, width, height) {
    return preprocessImage(rgb, width, height);
  }

  /** Token embeddings on the CPU (prompts, where image rows are written in). */
  async embedIds(ids) {
    const out = await this.embed.run({ input_ids: this.tensor('int64', BigInt64Array.from(ids.map(BigInt)), [1, ids.length]) });
    const t = out.inputs_embeds;
    const data = t.location === 'gpu-buffer' ? await t.getData(true) : t.data;
    return data instanceof Float32Array ? data : Float32Array.from(data);
  }

  /** Vision features for one preprocessed image, in placeholder order (thumbnail, slices). */
  async encodeImage(image) {
    const groups = new Map();
    image.crops.forEach((crop, index) => {
      const key = `${crop.height}x${crop.width}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(index);
    });
    const perCrop = new Array(image.crops.length);
    for (const indices of groups.values()) {
      const first = image.crops[indices[0]];
      const plane = 3 * first.height * first.width;
      const batch = new Float32Array(plane * indices.length);
      indices.forEach((cropIndex, b) => batch.set(image.crops[cropIndex].pixels, b * plane));
      const out = await this.vision.run({ pixel_values: this.tensor('float32', batch, [indices.length, 3, first.height, first.width]) });
      const t = out.image_features;
      const data = t.location === 'gpu-buffer' ? await t.getData(true) : t.data;
      const per = (first.h / this.cfg.mergeFactor) * (first.w / this.cfg.mergeFactor) * this.cfg.hidden;
      indices.forEach((cropIndex, b) => { perCrop[cropIndex] = data.subarray(b * per, (b + 1) * per); });
    }
    return perCrop;
  }

  /** Prompt inputs: ids, embeddings with the image rows filled in, canvas positions. */
  async buildInputs(promptText, images = [], { beforeImage = null } = {}) {
    const text = images.length ? expandImagePlaceholders(promptText, images) : promptText;
    const ids = this.encode(text);
    // Message text must reach here through plainText; an image token it spelled
    // would otherwise be taken for an image patch.
    const div = this.cfg.mergeFactor * this.cfg.mergeFactor;
    const patches = images.reduce((sum, image) => sum + image.crops.reduce((n, crop) => n + (crop.h * crop.w) / div, 0), 0);
    const pads = ids.reduce((sum, id) => sum + (id === this.cfg.imageTokenId ? 1 : 0), 0);
    if (pads !== patches) throw new Error(`The prompt has ${pads} image tokens for ${patches} image patches.`);
    const embeds = await this.embedIds(ids);
    if (images.length) {
      const features = [];
      for (const image of images) {
        beforeImage?.();
        features.push(...await this.encodeImage(image));
      }
      const H = this.cfg.hidden;
      let row = 0, fi = 0, offset = 0;
      for (let i = 0; i < ids.length; i++) {
        if (ids[i] !== this.cfg.imageTokenId) continue;
        while (fi < features.length && offset >= features[fi].length) { fi++; offset = 0; }
        if (fi >= features.length) throw new Error('The prompt has more image tokens than vision features.');
        embeds.set(features[fi].subarray(offset, offset + H), i * H);
        offset += H;
        row++;
      }
      const total = features.reduce((sum, f) => sum + f.length / H, 0);
      if (row !== total) throw new Error(`The prompt has ${row} image tokens for ${total} vision features.`);
    }
    const sizes = images.flatMap(image => image.crops.map(crop => [crop.h, crop.w]));
    return { ids, embeds, pos: canvasPositions(ids, sizes, this.cfg), sizes };
  }

  emptyCache() {
    const feeds = {};
    const [convC, convK] = this.cfg.gdnConv, [hs, dk, dv] = this.cfg.gdnState;
    this.layerKinds.forEach((kind, i) => {
      if (kind === 'gdn') {
        feeds[`past_conv.${i}`] = this.tensor('float16', new Uint16Array(convC * convK), [1, convC, convK]);
        feeds[`past_recurrent.${i}`] = this.tensor('float16', new Uint16Array(hs * dk * dv), [1, hs, dk, dv]);
      } else {
        feeds[`past_key_values.${i}.key`] = this.tensor('float16', new Uint16Array(0), [1, this.cfg.kvHeads, 0, this.cfg.headDim]);
        feeds[`past_key_values.${i}.value`] = this.tensor('float16', new Uint16Array(0), [1, this.cfg.kvHeads, 0, this.cfg.headDim]);
      }
    });
    return { feeds, length: 0 };
  }

  static disposeCache(cache) {
    for (const tensor of Object.values(cache?.feeds || {})) tensor?.dispose?.();
  }

  /**
   * One decoder pass over `n` rows continuing `cache`. `embeds` is a CPU
   * Float32Array of n rows or a GPU tensor [1, n, hidden]. Returns the
   * last-position logits (and decision_hidden when asked) and the new cache;
   * with `keepCache: false` the new cache is released and the given one stays
   * usable (continuations of a shared prefix).
   */
  async forward(embeds, positions, cache, { keepCache = true, wantHidden = false } = {}) {
    const n = positions.t.length, H = this.cfg.hidden;
    const posData = new BigInt64Array(3 * n);
    for (let i = 0; i < n; i++) {
      posData[i] = BigInt(positions.t[i]);
      posData[n + i] = BigInt(positions.h[i]);
      posData[2 * n + i] = BigInt(positions.w[i]);
    }
    const total = cache.length + n;
    const out = await this.decoder.run({
      ...cache.feeds,
      inputs_embeds: embeds instanceof Float32Array ? this.tensor('float32', embeds, [1, n, H]) : embeds,
      attention_mask: this.tensor('int64', new BigInt64Array(total).fill(1n), [1, total]),
      position_ids: this.tensor('int64', posData, [3, 1, n]),
    });
    const read = async tensor => {
      const data = tensor.location === 'gpu-buffer' ? await tensor.getData() : tensor.data;
      return data instanceof Uint16Array ? f16ToF32(data) : (data instanceof Float32Array ? data : Float32Array.from(data));
    };
    const present = Object.entries(out).filter(([name]) => name.startsWith('present'));
    let kept = false;
    try {
      const logits = await read(out.logits);
      const hidden = wantHidden && out.decision_hidden ? await read(out.decision_hidden) : null;
      const next = { feeds: {}, length: total };
      if (keepCache) {
        for (const [name, tensor] of present) {
          next.feeds[name.replace('present_conv', 'past_conv').replace('present_recurrent', 'past_recurrent').replace('present.', 'past_key_values.')] = tensor;
        }
        kept = true;
      }
      return { logits, hidden, cache: next };
    } finally {
      out.logits?.dispose?.();
      out.decision_hidden?.dispose?.();
      // The new cache is released unless it was handed back, also when a read failed.
      if (!kept) for (const [, tensor] of present) tensor.dispose?.();
    }
  }

  /**
   * Prefill prompt rows [0, count) in slices of `sliceTokens` (one pass when
   * 0), each continuing the previous slice's cache. `beforeSlice` may throw to
   * stop. Returns the last slice's outputs and the cache.
   */
  async prefill(inputs, { count = inputs.ids.length, sliceTokens = 0, wantHidden = false, beforeSlice = null } = {}) {
    const H = this.cfg.hidden;
    const step = sliceTokens > 0 ? sliceTokens : count;
    let cache = this.emptyCache();
    let result = null;
    try {
      for (let start = 0; start < count; start += step) {
        beforeSlice?.();
        const end = Math.min(start + step, count);
        const positions = { t: inputs.pos.t.subarray(start, end), h: inputs.pos.h.subarray(start, end), w: inputs.pos.w.subarray(start, end) };
        result = await this.forward(inputs.embeds.slice(start * H, end * H), positions, cache, { wantHidden: wantHidden && end === count });
        CompassVldRuntime.disposeCache(cache);
        cache = result.cache;
      }
      return { logits: result?.logits || null, hidden: result?.hidden || null, cache };
    } catch (error) {
      CompassVldRuntime.disposeCache(cache);
      throw error;
    }
  }

  /**
   * Greedy generation from a rendered chat prompt (each image as one
   * `<|image_pad|>`). New tokens continue the canvas positions: max(prompt
   * positions) + 1 + step on all three axes. `shouldStop` is checked before
   * every pass and may throw.
   */
  async generate(promptText, images = [], { maxNewTokens = 256, sliceTokens = 0, stopIds = this.cfg.eosTokenIds, shouldStop = null } = {}) {
    const inputs = await this.buildInputs(promptText, images, { beforeImage: shouldStop });
    let { logits, cache } = await this.prefill(inputs, { sliceTokens, beforeSlice: shouldStop });
    let next = inputs.pos.nextPosition;
    const ids = [];
    let finished = false;
    try {
      for (let step = 0; step < maxNewTokens; step++) {
        const token = argmax(logits);
        if (stopIds.includes(token)) { finished = true; break; }
        ids.push(token);
        if (ids.length >= maxNewTokens) break;
        shouldStop?.();
        // The new token's embedding stays on the GPU.
        const embedded = await this.embed.run({ input_ids: this.tensor('int64', BigInt64Array.of(BigInt(token)), [1, 1]) });
        const position = Int32Array.of(next);
        next += 1;
        let result;
        try {
          result = await this.forward(embedded.inputs_embeds, { t: position, h: position, w: position }, cache);
        } finally {
          embedded.inputs_embeds?.dispose?.();
        }
        CompassVldRuntime.disposeCache(cache);
        ({ logits, cache } = result);
      }
    } finally {
      CompassVldRuntime.disposeCache(cache);
    }
    return { ids, promptTokens: inputs.ids.length, finished };
  }

  /** Logits (and decision_hidden) after appending `text` to a prefilled prefix, leaving the prefix cache as it was. */
  async continuation(prefix, prefixCache, text) {
    const suffix = this.encode(text);
    if (suffix.includes(this.cfg.imageTokenId)) throw new Error('The continuation text has an image token; pass it through plainText.');
    const pos = canvasPositions(prefix.ids.concat(suffix), prefix.sizes, this.cfg);
    const P = prefix.ids.length;
    const embeds = await this.embedIds(suffix);
    const out = await this.forward(embeds, { t: pos.t.subarray(P), h: pos.h.subarray(P), w: pos.w.subarray(P) }, prefixCache,
      { keepCache: false, wantHidden: true });
    return { logits: out.logits, hidden: out.hidden, tokens: suffix.length };
  }
}
