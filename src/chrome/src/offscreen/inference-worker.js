/**
 * Dedicated WebGPU worker for endpoint-free local model inference.
 *
 * WebGPU is unavailable in the MV3 service worker, and large ONNX allocations
 * are more reliable in a dedicated worker than on the offscreen document's
 * main thread. The offscreen host owns this worker and proxies correlated
 * request/response messages to it.
 */

import { BONSAI2_TOKENIZER_CONFIG } from '../../vendor/bonsai2/tokenizer-config.js';
import {
  decisionSystemPrompt,
  decisionAnswer,
  decisionOptions,
  decisionQuestionText,
  decisionVerifyText,
  decisionStateText,
  normalizeDecisionRequest,
} from './webgpu-decisions.js';
import { BONSAI_DECISION_PROBE, bonsaiProbeScores } from './bonsai-decision-probe.js';
import { tinyAskGateProbability } from './tiny-ask-gate-probe.js';
import {
  CompassVldRuntime,
  compassVldDtype,
  compassVldFilesCached,
  createCompassVldSessions,
  createCompassVldTokenizer,
  downloadCompassVld,
  isCompassVldModel,
  isCompassVldV6Model,
  toRGB,
} from './compass-vld-runtime.js';
import { CompassVldV6Runtime } from './compass-vld-v6-runtime.js';
import { compassVldDecisionProbe, compassVldProbeScores } from './compass-vld-decision-probe.js';

let libraryPromise = null;
let libraryVersion = null;
let workerConfig = null;
let visionRuntime = null;
let visionRuntimeKey = '';
let visionRuntimeModelKey = '';
let visionRuntimeOwner = '';
let visionRuntimeLoadPromise = null;
let visionRuntimeLoadKey = '';
let textRuntime = null;
let textRuntimeKey = '';
let textRuntimeModelKey = '';
let textRuntimeLoadPromise = null;
let textRuntimeLoadKey = '';
let modelOperationQueue = Promise.resolve();
const TRANSFORMERS_CACHE_NAME = 'transformers-cache';
const TEXT_DOWNLOAD_EVENT = 'text-download-state';
const WEBGPU_TEXT_MAX_NEW_TOKENS = 256;
const WEBGPU_LFM25_MODEL_ID = 'LiquidAI/LFM2.5-2.6B-ONNX';
const WEBGPU_LFM25_12B_INSTRUCT_MODEL_ID = 'LiquidAI/LFM2.5-1.2B-Instruct-ONNX';
const WEBGPU_LFM25_12B_THINKING_MODEL_ID = 'LiquidAI/LFM2.5-1.2B-Thinking-ONNX';
const WEBGPU_LFM25_VL_16B_MODEL_ID = 'LiquidAI/LFM2.5-VL-1.6B-ONNX';
const WEBGPU_LFM25_VL_3B_MODEL_ID = 'LiquidAI/LFM2.5-VL-3B-ONNX';
const WEBGPU_NANBEIGE42_3B_MODEL_ID = 'Michionlion/Nanbeige4.2-3B-ONNX-WebGPU';
const WEBGPU_MINICPM5_2B_MODEL_ID = 'RASMUS/MiniCPM5-2B-ONNX';
const WEBGPU_BONSAI27_MODEL_ID = 'prism-ml/Bonsai-27B-gguf';
const WEBGPU_BONSAI2_SPLIT_TEXT_MODEL_IDS = new Set([
  'danyalmalik/Ternary-Bonsai-2-2B-ONNX-WebGPU',
  'danyalmalik/Ternary-Bonsai-2-4B-ONNX-WebGPU',
]);
const WEBGPU_BONSAI2_VISION_MODEL_IDS = new Set([
  'webbrain-one/Ternary-Bonsai-2-2B-ONNX-WebGPU-Vision',
  'webbrain-one/Ternary-Bonsai-2-4B-ONNX-WebGPU-Vision',
]);
const WEBGPU_BONSAI2_MODEL_IDS = new Set([
  ...WEBGPU_BONSAI2_SPLIT_TEXT_MODEL_IDS,
  ...WEBGPU_BONSAI2_VISION_MODEL_IDS,
  'Mike0021/Ternary-Bonsai-2-4B-text-ONNX',
]);
// Parallel-prefill decoder graphs (chunked GatedDeltaNet; see
// scripts/models/bonsai/chunk_gdn_prefill.py). Earlier revisions prefilled with
// an ONNX Scan that WebGPU runs one token at a time on the CPU. Installs that
// cached that graph keep it under the same URL, so replace just this small file;
// the unchanged weight files stay cached. The 2B graph also exposes the
// last-position hidden state as `decision_hidden` for the decision probe
// (scripts/models/bonsai/add_decision_hidden.py); logits and caches are as before.
const BONSAI2_DECODER_GRAPH_FILE = 'onnx/decoder_model_merged_q2f16.onnx';
const BONSAI2_DECODER_GRAPH_SHA256 = new Map([
  ['webbrain-one/Ternary-Bonsai-2-2B-ONNX-WebGPU-Vision', '240c07e1191911a2306faf106ee537382a1b4d5e6ecdd32b618da160db9145c1'],
  ['webbrain-one/Ternary-Bonsai-2-4B-ONNX-WebGPU-Vision', '52424fbb7094ed0a1036d8795e78c3da349fce1838ee6bd077523929b0bb7bb2'],
]);
// A refresh must never stall model loading on a flaky network; one attempt per
// worker lifetime, after which the working cached graph is used.
const BONSAI2_DECODER_GRAPH_REFRESH_TIMEOUT_MS = 15_000;
const checkedBonsai2DecoderGraphs = new Set();
// Cache-only loads remember a stale graph so inference does not re-hash it.
const staleBonsai2DecoderGraphs = new Set();
// The Qwen3.5 generation_config sidecar omitted by Danyal's split exports.
// Per-request decoding still controls do_sample and the output token budget.
const BONSAI2_GENERATION_CONFIG = {
  bos_token_id: 248044,
  eos_token_id: [248046, 248044],
  pad_token_id: 248044,
  do_sample: true,
  temperature: 0.6,
  top_k: 20,
  top_p: 0.95,
};
const WEBGPU_LFM25_MAX_NEW_TOKENS = 2048;
const WEBGPU_LFM25_TEXT_MODEL_IDS = new Set([
  WEBGPU_LFM25_MODEL_ID,
  WEBGPU_LFM25_12B_INSTRUCT_MODEL_ID,
  WEBGPU_LFM25_12B_THINKING_MODEL_ID,
]);
const WEBGPU_LFM25_VL_MODEL_IDS = new Set([
  WEBGPU_LFM25_VL_16B_MODEL_ID,
  WEBGPU_LFM25_VL_3B_MODEL_ID,
]);
// Presets whose reasoning is generated as hidden thinking rather than as part
// of the visible answer, so they need the long output budget.
const WEBGPU_REASONING_MODEL_IDS = new Set([
  WEBGPU_LFM25_MODEL_ID,
  WEBGPU_LFM25_12B_THINKING_MODEL_ID,
  WEBGPU_NANBEIGE42_3B_MODEL_ID,
  WEBGPU_MINICPM5_2B_MODEL_ID,
]);
// Chat templates that emit the opening `<think>` themselves, so the runtime
// only returns the reasoning suffix.
const WEBGPU_OPEN_THINKING_MODEL_IDS = new Set([
  WEBGPU_LFM25_MODEL_ID,
  WEBGPU_NANBEIGE42_3B_MODEL_ID,
]);
const WEBGPU_LONG_OUTPUT_MODEL_IDS = new Set([
  ...WEBGPU_LFM25_TEXT_MODEL_IDS,
  WEBGPU_NANBEIGE42_3B_MODEL_ID,
  WEBGPU_MINICPM5_2B_MODEL_ID,
  ...WEBGPU_BONSAI2_MODEL_IDS,
]);
// Publisher-recommended decoding for the shipped reasoning presets. Custom
// repositories keep Transformers.js greedy defaults.
const WEBGPU_TEXT_SAMPLING = new Map([
  [WEBGPU_LFM25_MODEL_ID, { temperature: 0.1, top_k: 50, repetition_penalty: 1.1 }],
  [WEBGPU_LFM25_12B_THINKING_MODEL_ID, { temperature: 0.05, top_k: 50, repetition_penalty: 1.05 }],
  // Nanbeige4.2-3B's own generation_config.json.
  [WEBGPU_NANBEIGE42_3B_MODEL_ID, { temperature: 0.6, top_k: 20, top_p: 0.95 }],
  // MiniCPM5-2B quickstart: temperature=1.0, top_p=0.95.
  [WEBGPU_MINICPM5_2B_MODEL_ID, { temperature: 1.0, top_p: 0.95 }],
]);
// Nanbeige ships a single WebGPU-fused graph under a non-default file name.
// Without this override Transformers.js looks for `onnx/model_q4f16.onnx`,
// which the repository does not publish.
const WEBGPU_TEXT_MODEL_FILE_NAMES = new Map([
  [WEBGPU_NANBEIGE42_3B_MODEL_ID, 'model_webgpu_mlp'],
]);
const WEBGPU_VISION_READY_MARKER_VERSION = 2;
const WEBGPU_VISION_READY_MARKER_PREFIX = 'https://webbrain.one/.well-known/webgpu-vision-ready/';
function createWebGpuTextSessionOptions() {
  return {
    extra: {
      // ORT's default bucket cache can retain rounded-up transient buffers. That
      // is especially costly for dynamic prefill/decode shapes on Metal.
      'ep.webgpuexecutionprovider.storageBufferCacheMode': 'simple',
    },
  };
}
const readyTextModelKeys = new Set();
const textDownloadFiles = new Map();
const nativeFetch = typeof globalThis.fetch === 'function' ? globalThis.fetch.bind(globalThis) : null;
let activeTextDownloadModelId = '';
let queuedTextDownload = null;
let textDownloadAbortController = null;
let textDownloadCancelMode = '';
let activeVisionDownloadRequest = null;
let queuedVisionDownload = null;
let visionDownloadAbortController = null;
const activeVisionGenerations = new Map();
const queuedVisionGenerations = new Set();
const cancelledVisionGenerations = new Set();
// Text generations that carry a requestKey (the in-page answer cards do) can be
// cancelled: one still queued never starts, and a running one is interrupted at
// its next token instead of finishing a result nobody is waiting for.
const queuedTextGenerations = new Set();
const activeTextGenerations = new Map();
const cancelledTextGenerations = new Set();
const TEXT_REQUEST_KEY_PATTERN = /^[a-z0-9-]{8,64}$/i;
// A re-tokenized answer that used this much of its budget is reported as cut off.
const WEBGPU_OUTPUT_LIMIT_RATIO = 0.97;

function textRequestKey(payload) {
  const key = typeof payload?.requestKey === 'string' ? payload.requestKey : '';
  return TEXT_REQUEST_KEY_PATTERN.test(key) ? key : '';
}

function throwIfTextCancelled(requestKey) {
  if (!requestKey || !cancelledTextGenerations.has(requestKey)) return;
  const error = new Error('The generation was cancelled.');
  error.name = 'AbortError';
  throw error;
}

function beginTextGeneration(requestKey, library) {
  if (!requestKey || !library?.InterruptableStoppingCriteria) return null;
  const criteria = new library.InterruptableStoppingCriteria();
  activeTextGenerations.set(requestKey, criteria);
  return criteria;
}

function endTextGeneration(requestKey) {
  if (requestKey) activeTextGenerations.delete(requestKey);
}

// Tokens in a generated text, counted with the model's own tokenizer; null when it cannot.
function countGeneratedTokens(tokenizer, text) {
  try {
    if (typeof tokenizer !== 'function' || !text) return null;
    const count = Number(tokenizer(text, { add_special_tokens: false })?.input_ids?.dims?.at?.(-1));
    return Number.isFinite(count) ? count : null;
  } catch {
    return null;
  }
}

// The worker has no finish reason for these models, so a generation that used
// (nearly) all of its token budget is reported as cut off for the caller to act on.
function outputLimitField(generatedTokens, maxNewTokens, ratio = WEBGPU_OUTPUT_LIMIT_RATIO) {
  return Number.isFinite(generatedTokens) && maxNewTokens > 0
    ? { outputTruncated: generatedTokens >= Math.max(1, Math.floor(maxNewTokens * ratio)) }
    : {};
}
let lastTextProgressPostAt = 0;
let webGpuAdapterProbePromise = null;
let webGpuAdapterSummary = '';
let observedWebGpuDevice = null;
let lastWebGpuDeviceError = '';
let lastWebGpuDeviceLost = '';
let textDownloadState = {
  status: 'not-downloaded',
  ready: false,
  modelId: '',
  dtype: '',
  file: '',
  loaded: 0,
  total: 0,
  progress: 0,
  error: '',
};

function textDtypeKey(dtype) {
  if (!dtype || typeof dtype !== 'object' || Array.isArray(dtype)) return String(dtype || '').trim();
  return JSON.stringify(Object.fromEntries(
    Object.entries(dtype).sort(([left], [right]) => left.localeCompare(right)),
  ));
}

function textModelKey(modelId, dtype) {
  return `${String(modelId || '').trim()}|${textDtypeKey(dtype)}`;
}

function sameTextModel(leftModelId, leftDtype, rightModelId, rightDtype) {
  return textModelKey(leftModelId, leftDtype) === textModelKey(rightModelId, rightDtype);
}

function assertOnnxTextModel(modelId) {
  const normalized = String(modelId || '').trim();
  if (!normalized) throw new Error('No text-generation model was specified.');
  if (normalized === WEBGPU_BONSAI27_MODEL_ID || /\.gguf$/i.test(normalized)) {
    throw new Error(`${normalized} is a GGUF checkpoint and cannot be loaded with Transformers.js. Use the Bonsai WebGPU runtime.`);
  }
  return normalized;
}

function isLfm25VlModel(modelId) {
  return WEBGPU_LFM25_VL_MODEL_IDS.has(String(modelId || '').trim());
}

function isMultimodalTextModel(modelId) {
  return isLfm25VlModel(modelId) || WEBGPU_BONSAI2_VISION_MODEL_IDS.has(modelId) || isCompassVldModel(modelId);
}

export function bonsai2CompatibilityMetadata(input) {
  // Supply missing sidecars from packaged metadata without borrowing a tokenizer
  // from another remote model or changing any unrecognized repository.
  try {
    const url = new URL(typeof input === 'string' || input instanceof URL ? String(input) : input?.url);
    const match = /^\/([^/]+\/[^/]+)\/resolve\/[^/]+\/(tokenizer_config|generation_config)\.json$/.exec(url.pathname);
    if (url.origin !== 'https://huggingface.co' || !WEBGPU_BONSAI2_SPLIT_TEXT_MODEL_IDS.has(match?.[1])) return null;
    return match[2] === 'tokenizer_config' ? BONSAI2_TOKENIZER_CONFIG : BONSAI2_GENERATION_CONFIG;
  } catch {
    return null;
  }
}

function packagedMetadataResponse(metadata, head = false) {
  const body = JSON.stringify(metadata);
  return new Response(head ? null : body, {
    headers: { 'content-type': 'application/json', 'content-length': String(new TextEncoder().encode(body).length) },
  });
}

async function cacheBonsai2CompatibilityMetadata(modelId) {
  if (!WEBGPU_BONSAI2_SPLIT_TEXT_MODEL_IDS.has(modelId) || typeof caches === 'undefined') return;
  const cache = await caches.open(TRANSFORMERS_CACHE_NAME);
  for (const file of ['tokenizer_config.json', 'generation_config.json']) {
    const url = `https://huggingface.co/${modelId}/resolve/main/${file}`;
    if (!await cache.match(url)) await cache.put(url, packagedMetadataResponse(bonsai2CompatibilityMetadata(url)));
  }
}

async function sha256Hex(buffer) {
  const digest = await crypto.subtle.digest('SHA-256', buffer);
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * Make a cached Bonsai 2 Vision decoder graph the parallel-prefill revision.
 * Inference loads are cache-only, so they only detect a stale graph
 * ('stale'); the replacement is fetched solely from explicit download flows
 * (`allowNetwork`). Offline or unexpected responses keep the cached graph,
 * which still produces the same answers, only with slower prefill.
 */
export async function refreshBonsai2DecoderGraph(modelId, {
  allowNetwork = false,
  expected = BONSAI2_DECODER_GRAPH_SHA256.get(modelId),
  timeoutMs = BONSAI2_DECODER_GRAPH_REFRESH_TIMEOUT_MS,
} = {}) {
  if (!expected || checkedBonsai2DecoderGraphs.has(modelId)) return 'skipped';
  if (!allowNetwork && staleBonsai2DecoderGraphs.has(modelId)) return 'stale';
  if (typeof caches === 'undefined' || !globalThis.crypto?.subtle) return 'unavailable';
  const url = `https://huggingface.co/${modelId}/resolve/main/${BONSAI2_DECODER_GRAPH_FILE}`;
  let cache;
  try {
    cache = await caches.open(TRANSFORMERS_CACHE_NAME);
    const cached = await cache.match(url);
    if (!cached) {
      // Not downloaded yet: the regular download fetches the current graph.
      checkedBonsai2DecoderGraphs.add(modelId);
      return 'not-cached';
    }
    if (await sha256Hex(await cached.arrayBuffer()) === expected) {
      checkedBonsai2DecoderGraphs.add(modelId);
      return 'current';
    }
  } catch {
    return 'unavailable';
  }
  // Cache-only loads (inference) never download; an explicit download replaces it.
  if (!allowNetwork) {
    staleBonsai2DecoderGraphs.add(modelId);
    console.info(`[webgpu] ${modelId}: the cached decoder graph predates parallel prefill; download the model again to update it.`);
    return 'stale';
  }
  const fetcher = typeof globalThis.fetch === 'function' ? globalThis.fetch.bind(globalThis) : nativeFetch;
  if (!fetcher) return 'unavailable';
  // Known offline (Apocalypse Mode): load the cached graph now and retry on a
  // later load instead of waiting for the network deadline.
  if (globalThis.navigator?.onLine === false) return 'unavailable';
  checkedBonsai2DecoderGraphs.add(modelId);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetcher(url, { cache: 'no-store', signal: controller.signal });
    if (!response?.ok) return 'unavailable';
    const bytes = await response.arrayBuffer();
    if (await sha256Hex(bytes) !== expected) return 'unexpected';
    await cache.put(url, new Response(bytes, {
      headers: { 'content-type': 'application/octet-stream', 'content-length': String(bytes.byteLength) },
    }));
    staleBonsai2DecoderGraphs.delete(modelId);
    return 'updated';
  } catch {
    return 'unavailable';
  } finally {
    clearTimeout(timer);
  }
}

// Long Bonsai 2 Vision prompts are prefilled in slices so no single GPU pass
// covers the whole prompt. On a GPU shared with the display (Apple silicon, a
// display-attached discrete card) one multi-second prefill starves window
// compositing and the desktop stutters; slices bound each pass. Each slice
// continues from the previous slice's recurrent/conv/KV cache, which the
// chunked decoder graph computes exactly like a single pass.
export const BONSAI2_DEFAULT_PREFILL_SLICE_TOKENS = 512;
const BONSAI2_MIN_PREFILL_SLICE_TOKENS = 64;
const BONSAI2_MAX_PREFILL_SLICE_TOKENS = 8192;

/** 0 disables slicing; invalid values use the default. */
export function bonsai2PrefillSliceTokens(value) {
  if (value === 0 || value === '0') return 0;
  const tokens = Math.round(Number(value));
  if (!Number.isFinite(tokens) || tokens <= 0) return BONSAI2_DEFAULT_PREFILL_SLICE_TOKENS;
  return Math.min(BONSAI2_MAX_PREFILL_SLICE_TOKENS, Math.max(BONSAI2_MIN_PREFILL_SLICE_TOKENS, tokens));
}

function presentToPastName(name) {
  return name
    .replace('present_conv', 'past_conv')
    .replace('present_recurrent', 'past_recurrent')
    .replace('present', 'past_key_values');
}

// Prefill the first `count` prompt tokens in slices of `sliceTokens` (one
// pass when 0) and return the recurrent/conv/KV cache. `beforeSlice` runs
// before each slice and may throw to stop (a cancelled decision).
async function prefillBonsai2Cache(runtime, inputs, sliceTokens, count, beforeSlice = null) {
  const { model, library } = runtime;
  beforeSlice?.();
  let embeds = await model.encode_text({ input_ids: inputs.input_ids });
  let attentionMask = inputs.attention_mask;
  if (inputs.pixel_values) {
    const imageFeatures = await model.encode_image({
      pixel_values: inputs.pixel_values,
      image_grid_thw: inputs.image_grid_thw,
    });
    ({ inputs_embeds: embeds, attention_mask: attentionMask } = model._merge_input_ids_with_image_features({
      image_features: imageFeatures,
      inputs_embeds: embeds,
      input_ids: inputs.input_ids,
      attention_mask: attentionMask,
    }));
  }
  const [positionIds] = model.get_rope_index(
    inputs.input_ids,
    inputs.image_grid_thw ?? null,
    inputs.video_grid_thw ?? null,
    attentionMask,
  );
  const step = sliceTokens || count;
  let cache = null;
  try {
    for (let start = 0; start < count; start += step) {
      beforeSlice?.();
      const end = Math.min(start + step, count);
      const outputs = await model.forward({
        inputs_embeds: embeds.slice(null, [start, end], null),
        attention_mask: attentionMask.slice(null, [0, end]),
        position_ids: positionIds.slice(null, null, [start, end]),
        past_key_values: cache,
      });
      const present = {};
      for (const [name, tensor] of Object.entries(outputs)) {
        if (name.startsWith('present')) present[presentToPastName(name)] = tensor;
        else if (tensor?.location === 'gpu-buffer') tensor.dispose();
      }
      if (cache) cache.update(present);
      else cache = new library.DynamicCache(present);
    }
    return cache;
  } catch (error) {
    await cache?.dispose?.();
    throw error;
  }
}

/**
 * Prefill all but the last prompt token in slices and return the cache, or
 * null when the prompt fits in one slice. generate() then continues from the
 * cache: the Qwen VL input preparation computes the full rotary positions and
 * feeds only the remaining token.
 */
export async function prefillBonsai2InSlices(runtime, inputs, sliceTokens, checkCancelled = () => {}) {
  const length = inputs.input_ids.dims.at(-1);
  if (!sliceTokens || length - 1 <= sliceTokens) return null;
  return prefillBonsai2Cache(runtime, inputs, sliceTokens, length - 1, checkCancelled);
}

/**
 * Next-token logits after appending `suffixIds` to a prefilled prompt. The
 * prefix cache is only read: the continuation's cache outputs are released,
 * so every question starts from the same page state.
 */
export async function bonsai2ContinuationLogits(runtime, prefixInputs, cache, suffixIds, { withHidden = false } = {}) {
  const { model, library } = runtime;
  const prefixLength = prefixInputs.input_ids.dims.at(-1), suffixLength = suffixIds.dims.at(-1);
  const total = prefixLength + suffixLength;
  const fullIds = library.cat([prefixInputs.input_ids, suffixIds], 1);
  const fullMask = new library.Tensor('int64', new BigInt64Array(total).fill(1n), [1, total]);
  const [positions] = model.get_rope_index(fullIds, prefixInputs.image_grid_thw ?? null, null, fullMask);
  const embeds = await model.encode_text({ input_ids: suffixIds });
  const outputs = await model.forward({
    inputs_embeds: embeds,
    attention_mask: fullMask,
    position_ids: positions.slice(null, null, [prefixLength, total]),
    past_key_values: cache,
  });
  try {
    const logits = Float32Array.from(outputs.logits.slice(null, -1, null).to('float32').data);
    if (!withHidden) return logits;
    // Present only in a decoder graph that exposes `decision_hidden`
    // (scripts/models/bonsai/add_decision_hidden.py).
    const hidden = outputs.decision_hidden ? Float32Array.from(outputs.decision_hidden.to('float32').data) : null;
    return { logits, hidden };
  } finally {
    for (const tensor of Object.values(outputs)) {
      if (tensor?.location === 'gpu-buffer') tensor.dispose();
    }
  }
}

export function normalizeBonsai2Config(config) {
  return {
    ...config,
    // The source export omits generation_config.json. Its base-model EOS is
    // only <|endoftext|>; chat must also stop at <|im_end|> or it generates
    // subsequent assistant turns after an otherwise complete answer.
    text_config: {
      ...config.text_config,
      eos_token_id: [248046, 248044],
      pad_token_id: 248044,
    },
    // Danyal's metadata still describes the original Qwen q4/fp16 shards;
    // both Bonsai q2f16 components have exactly one external data file.
    'transformers.js_config': {
      ...(config['transformers.js_config'] || {}),
      use_external_data_format: {
        'embed_tokens_q2f16.onnx': 1,
        'decoder_model_merged_q2f16.onnx': 1,
      },
      kv_cache_dtype: { q2f16: 'float16' },
    },
  };
}

export function applyBonsai2RotaryCompatibility(modelId, model) {
  if ((!WEBGPU_BONSAI2_SPLIT_TEXT_MODEL_IDS.has(modelId) && !WEBGPU_BONSAI2_VISION_MODEL_IDS.has(modelId))
      || typeof model?._get_text_only_rope_index !== 'function') return;
  const original = model._get_text_only_rope_index;
  model._get_text_only_rope_index = function (inputIds, attentionMask) {
    const [positions, deltas] = original.call(this, inputIds, attentionMask);
    if (attentionMask) {
      // Transformers.js 4.2 adds the prompt length to the pure-text MRoPE
      // delta instead of subtracting it. Cached decoding then jumps from
      // position N-1 to 3N. Recompute the delta from the actual positions;
      // image prompts use a separate, correct method and remain untouched.
      const [batchSize, sequenceLength] = attentionMask.dims;
      for (let batch = 0; batch < batchSize; batch++) {
        let maximum = -1n;
        const offset = batch * sequenceLength;
        for (let i = 0; i < sequenceLength; i++) {
          if (positions.data[offset + i] > maximum) maximum = positions.data[offset + i];
        }
        deltas.data[batch] = maximum + 1n - BigInt(sequenceLength);
      }
    }
    return [positions, deltas];
  };
}

function lfm25VlProcessorOptions(modelId) {
  if (!isLfm25VlModel(modelId)) return {};
  return {
    // LiquidAI's current VL ONNX repos use the Transformers v5 layout: image
    // settings are nested in processor_config.json and the chat template is a
    // separate Jinja file. The packaged Transformers.js 4.2 runtime supports
    // both through WebBrain's documented browser-bundle compatibility hooks.
    image_processor_config_file: 'processor_config.json',
    chat_template_file: 'chat_template.jinja',
  };
}

function assertTextDownloadCanStart(payload) {
  const modelId = assertOnnxTextModel(payload?.modelId);
  const dtype = payload?.dtype || 'q4f16';
  const conflictsWithTransfer = textDownloadState.modelId
    && !sameTextModel(textDownloadState.modelId, textDownloadState.dtype, modelId, dtype)
    && ['downloading', 'paused', 'stopping'].includes(textDownloadState.status);
  const conflictsWithQueued = queuedTextDownload
    && !sameTextModel(queuedTextDownload.modelId, queuedTextDownload.dtype, modelId, dtype);
  if (conflictsWithTransfer || conflictsWithQueued) {
    const blockingModel = conflictsWithTransfer ? textDownloadState.modelId : queuedTextDownload.modelId;
    throw new Error(`Finish or stop the ${blockingModel} download before downloading ${modelId}.`);
  }
  return { modelId, dtype, key: textModelKey(modelId, dtype) };
}

function textReadyMarkerUrl(modelId, dtype) {
  const key = encodeURIComponent(textModelKey(modelId, dtype));
  return `https://webbrain.one/.well-known/webgpu-model-ready/${key}`;
}

function safeDecodedUrl(value) {
  try { return decodeURIComponent(String(value || '')); } catch { return String(value || ''); }
}

function fetchTargetsActiveTextModel(input) {
  if (!activeTextDownloadModelId) return false;
  const url = typeof input === 'string' || input instanceof URL ? String(input) : input?.url;
  return safeDecodedUrl(url).includes(`/${activeTextDownloadModelId}/`);
}

function fetchTargetsActiveVisionModel(input) {
  if (!activeVisionDownloadRequest?.modelId) return false;
  const url = typeof input === 'string' || input instanceof URL ? String(input) : input?.url;
  return safeDecodedUrl(url).includes(`/${activeVisionDownloadRequest.modelId}/`);
}

function visionReadyMarkerUrl(modelId) {
  return `${WEBGPU_VISION_READY_MARKER_PREFIX}v${WEBGPU_VISION_READY_MARKER_VERSION}/${encodeURIComponent(String(modelId || '').trim())}`;
}

function isVisionReadyMarkerForModel(url, modelId) {
  const candidate = String(url || '');
  const encodedModelId = encodeURIComponent(String(modelId || '').trim());
  return candidate.startsWith(WEBGPU_VISION_READY_MARKER_PREFIX)
    && candidate.endsWith(`/${encodedModelId}`);
}

async function isVisionModelCached(modelId) {
  const normalized = String(modelId || '').trim();
  if (!normalized) return false;
  if (typeof caches === 'undefined') return null;
  const markerUrl = visionReadyMarkerUrl(normalized);
  try {
    for (const name of await caches.keys()) {
      if (!/transformers/i.test(name)) continue;
      const cache = await caches.open(name);
      if (await cache.match(markerUrl)) return true;
    }
  } catch {
    return null;
  }
  return false;
}

async function markVisionModelReady(modelId) {
  const normalized = String(modelId || '').trim();
  if (!normalized || typeof caches === 'undefined') return;
  const cache = await caches.open(TRANSFORMERS_CACHE_NAME);
  await cache.put(visionReadyMarkerUrl(normalized), new Response(JSON.stringify({
    modelId: normalized,
    markerVersion: WEBGPU_VISION_READY_MARKER_VERSION,
  }), {
    headers: { 'content-type': 'application/json' },
  }));
}

async function controlledFetch(input, init = {}) {
  const metadata = bonsai2CompatibilityMetadata(input);
  if (metadata) return packagedMetadataResponse(metadata, init.method === 'HEAD');
  if (!nativeFetch) throw new Error('Fetch is unavailable in the WebGPU worker.');
  if (textDownloadAbortController && fetchTargetsActiveTextModel(input)) {
    return nativeFetch(input, { ...init, signal: textDownloadAbortController.signal });
  }
  if (visionDownloadAbortController && fetchTargetsActiveVisionModel(input)) {
    return nativeFetch(input, { ...init, signal: visionDownloadAbortController.signal });
  }
  return nativeFetch(input, init);
}

function textDownloadSnapshot() {
  return { ...textDownloadState };
}

function postTextDownloadState({ force = false } = {}) {
  const now = Date.now();
  if (!force && now - lastTextProgressPostAt < 160) return;
  lastTextProgressPostAt = now;
  self.postMessage({ type: TEXT_DOWNLOAD_EVENT, state: textDownloadSnapshot() });
}

async function isTextModelReady(modelId, dtype) {
  const key = textModelKey(modelId, dtype);
  if (readyTextModelKeys.has(key)) return true;
  if (typeof caches === 'undefined') return false;
  try {
    const cache = await caches.open(TRANSFORMERS_CACHE_NAME);
    const marker = await cache.match(textReadyMarkerUrl(modelId, dtype));
    if (!marker) return false;
    // The marker does not name Compass VLD's pinned revision. When its
    // files are not all cached and checked (a newer pin, or a file stored but
    // never checked), drop the marker so the model reads as not downloaded and
    // Download fetches or checks them.
    if (isCompassVldModel(modelId) && !await compassVldFilesCached(cache, modelId, dtype)) {
      await cache.delete(textReadyMarkerUrl(modelId, dtype));
      return false;
    }
    readyTextModelKeys.add(key);
    return true;
  } catch {
    return false;
  }
}

async function markTextModelReady(modelId, dtype) {
  const key = textModelKey(modelId, dtype);
  if (typeof caches === 'undefined') {
    readyTextModelKeys.add(key);
    return;
  }
  const cache = await caches.open(TRANSFORMERS_CACHE_NAME);
  await cache.put(textReadyMarkerUrl(modelId, dtype), new Response(JSON.stringify({ modelId, dtype }), {
    headers: { 'content-type': 'application/json' },
  }));
  readyTextModelKeys.add(key);
}

async function loadLibrary() {
  if (libraryPromise) return libraryPromise;
  if (!workerConfig) throw new Error('WebGPU worker was not initialized.');
  libraryPromise = (async () => {
    let library;
    try {
      library = await import(workerConfig.transformersUrl);
    } catch (error) {
      libraryPromise = null;
      throw new Error(`The packaged Transformers.js runtime could not be loaded: ${error?.message || error}`);
    }
    libraryVersion = library.env?.version || library.VERSION || 'unknown';
    if (library.env) {
      library.env.allowLocalModels = false;
      library.env.allowRemoteModels = true;
      library.env.useBrowserCache = true;
      library.env.useWasmCache = false;
      library.env.fetch = controlledFetch;
      const wasm = library.env.backends?.onnx?.wasm;
      if (wasm) {
        wasm.numThreads = 1;
        wasm.wasmPaths = {
          mjs: workerConfig.wasmMjsUrl,
          wasm: workerConfig.wasmUrl,
        };
      }
    }
    return library;
  })();
  return libraryPromise;
}

function compactAdapterInfo(adapter) {
  if (!adapter) return '';
  const info = adapter.info || {};
  const identity = [info.vendor, info.architecture, info.device, info.description]
    .map(value => String(value || '').trim())
    .filter((value, index, values) => value && values.indexOf(value) === index)
    .join(' / ');
  const maxBufferSize = Number(adapter.limits?.maxBufferSize);
  const maxStorageBinding = Number(adapter.limits?.maxStorageBufferBindingSize);
  const limits = [
    Number.isFinite(maxBufferSize) ? `maxBufferSize=${maxBufferSize}` : '',
    Number.isFinite(maxStorageBinding) ? `maxStorageBufferBindingSize=${maxStorageBinding}` : '',
  ].filter(Boolean).join(', ');
  return [identity, limits].filter(Boolean).join('; ');
}

async function captureWebGpuAdapterSummary() {
  if (webGpuAdapterProbePromise) return webGpuAdapterProbePromise;
  webGpuAdapterProbePromise = (async () => {
    if (typeof navigator === 'undefined' || !navigator.gpu) return '';
    try {
      const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
      webGpuAdapterSummary = compactAdapterInfo(adapter);
    } catch {}
    return webGpuAdapterSummary;
  })();
  return webGpuAdapterProbePromise;
}

function bindWebGpuDeviceDiagnostics(library) {
  const device = library?.env?.backends?.onnx?.webgpu?.device;
  if (!device || device === observedWebGpuDevice) return;
  observedWebGpuDevice = device;
  lastWebGpuDeviceError = '';
  lastWebGpuDeviceLost = '';
  device.addEventListener?.('uncapturederror', event => {
    lastWebGpuDeviceError = String(event?.error?.message || event?.message || 'Unknown WebGPU validation error.');
    markWebgpuRuntimeDirty();
    console.error('[webgpu] uncaptured device error:', lastWebGpuDeviceError);
  });
  device.lost?.then(info => {
    if (device !== observedWebGpuDevice) return;
    lastWebGpuDeviceLost = String(info?.message || info?.reason || 'The WebGPU device was lost.');
    // A lost device can poison resident sessions without any OrtRun error
    // reaching the generate paths, so flag the runtimes dirty now: the next
    // run disposes them and rebuilds instead of burning one failing turn.
    markWebgpuRuntimeDirty();
    // ONNX Runtime initializes its Dawn device once per worker lifetime, so an
    // in-worker rebuild still runs against the dead adapter. Ask the host for
    // a fresh worker so the first request after a confirmed loss recovers.
    requestWebgpuWorkerRecycle('device-lost');
    console.error('[webgpu] device lost:', lastWebGpuDeviceLost);
  }).catch(() => {});
}

function isWebGpuExecutionFailure(error) {
  return /OrtRun|BufferManager::Download|mapAsync|GPUBuffer|device lost/i.test(error?.message || String(error));
}

async function enrichWebGpuExecutionError(error) {
  // WebGPU uncaptured-error/device-lost events can arrive just after OrtRun's
  // generic buffer readback exception. Give that event one task to land so the
  // user sees the actionable root error instead of only "Invalid Buffer".
  await new Promise(resolve => setTimeout(resolve, 0));
  const details = [lastWebGpuDeviceError, lastWebGpuDeviceLost]
    .map(value => String(value || '').trim())
    .filter((value, index, values) => value && values.indexOf(value) === index);
  const adapter = webGpuAdapterSummary || await captureWebGpuAdapterSummary();
  const suffix = [
    details.length ? `GPU detail: ${details.join(' ')}` : '',
    adapter ? `Adapter: ${adapter}.` : '',
    'Close other GPU-heavy tabs/apps and retry with a short prompt; a retry restarts the on-device worker and re-creates the session from the cached download, it does not re-download. On repeated out-of-memory failures, lower the context window on the WebGPU card in Providers (16384 is a safe fallback for Compass Tiny v2.1). If it persists, this GPU/driver cannot execute this model with the current WebGPU runtime.',
  ].filter(Boolean).join(' ');
  return new Error(`${error?.message || String(error)} ${suffix}`);
}

// A failed WebGPU run poisons the resident ORT session: the next run must
// rebuild from cache instead of reusing the dead device.
let webgpuRuntimeDirty = false;

function markWebgpuRuntimeDirty() {
  webgpuRuntimeDirty = true;
}

async function disposeWebgpuRuntimesIfDirty() {
  if (!webgpuRuntimeDirty) return false;
  // Consume the flag before disposing so a listener firing mid-dispose
  // re-marks it instead of being silently cleared.
  webgpuRuntimeDirty = false;
  await disposeAllRuntimes();
  return true;
}

async function handleWebGpuExecutionFailure(error) {
  const enriched = await enrichWebGpuExecutionError(error);
  markWebgpuRuntimeDirty();
  await disposeAllRuntimes();
  noteWebgpuExecutionFailure(error);
  return enriched;
}

// Consecutive WebGPU execution failures mean the device itself is dead, not
// just one session: onnxruntime-web initializes its Dawn device exactly once
// per worker lifetime, so no in-worker rebuild can recover. Signal the host to
// terminate and recreate this worker; the next request then starts from a
// fresh device while weights reload from the browser cache.
let webgpuExecutionFailureStreak = 0;
const WEBGPU_WORKER_RECYCLE_FAILURES = 2;
const WEBGPU_CERTAIN_DEVICE_DEATH_PATTERN = /external Instance reference|device lost/i;

function requestWebgpuWorkerRecycle(reason) {
  webgpuExecutionFailureStreak = 0;
  // Defer to a later macrotask so the failing request's `{ id, ok: false }`
  // response (posted in the current microtask chain) reaches the host first.
  // The caller then sees the enriched error instead of the recycle notice.
  setTimeout(() => {
    try {
      self.postMessage({ type: 'webgpu-device-dead', reason });
    } catch {}
  }, 0);
}

function noteWebgpuExecutionFailure(error) {
  webgpuExecutionFailureStreak += 1;
  const message = error?.message || String(error);
  const certainDeath = WEBGPU_CERTAIN_DEVICE_DEATH_PATTERN.test(message);
  if (certainDeath || webgpuExecutionFailureStreak >= WEBGPU_WORKER_RECYCLE_FAILURES) {
    requestWebgpuWorkerRecycle(certainDeath ? 'certain-device-death' : 'repeated-execution-failures');
  }
}

function noteWebgpuExecutionSuccess() {
  webgpuExecutionFailureStreak = 0;
}

export function perFileProgressEvents(event) {
  if (event?.status !== 'progress_total') return [event];
  // Transformers.js emits an aggregate snapshot immediately before the same
  // file's progress event. Account for its known files, never for its model
  // total as an additional file (which doubles every downloaded byte).
  return Object.entries(event?.files || {}).map(([file, progress]) => ({
    status: 'progress', file,
    loaded: Number(progress?.loaded || 0),
    total: Number(progress?.total || 0),
  }));
}

function postProgress(modelId, event) {
  const fileEvents = perFileProgressEvents(event);
  if (modelId === activeTextDownloadModelId && !textDownloadCancelMode) {
    const file = String(event?.file || (event?.status === 'progress_total' ? textDownloadState.file : event?.name) || '');
    for (const fileEvent of fileEvents) {
      const file = String(fileEvent?.file || '');
      if (!file) continue;
      const previous = textDownloadFiles.get(file) || { loaded: 0, total: 0, status: '' };
      const total = Number(fileEvent?.total || previous.total || 0);
      const loaded = fileEvent?.status === 'done' && total > 0
        ? total
        : Number(fileEvent?.loaded ?? previous.loaded ?? 0);
      textDownloadFiles.set(file, {
        status: fileEvent?.status || previous.status,
        loaded: Math.max(0, loaded),
        total: Math.max(0, total),
      });
    }
    let loaded = 0;
    let total = 0;
    for (const item of textDownloadFiles.values()) {
      if (item.total <= 0) continue;
      loaded += Math.min(item.loaded, item.total);
      total += item.total;
    }
    textDownloadState = {
      ...textDownloadState,
      status: 'downloading',
      ready: false,
      file,
      loaded,
      total,
      progress: total > 0 ? Math.max(0, Math.min(100, loaded / total * 100)) : 0,
      error: '',
    };
    postTextDownloadState({ force: event?.status === 'done' });
  }
  for (const fileEvent of fileEvents) {
    self.postMessage({
      type: 'progress',
      modelId,
      status: fileEvent?.status || '',
      file: fileEvent?.file || '',
      loaded: Number(fileEvent?.loaded || 0),
      total: Number(fileEvent?.total || 0),
      progress: Number(fileEvent?.progress || 0),
    });
  }
}

async function disposeRuntime(runtime) {
  if (runtime?.pipeline?.dispose) {
    try { await runtime.pipeline.dispose(); } catch {}
  } else if (runtime?.model?.dispose) {
    try { await runtime.model.dispose(); } catch {}
  }
  if (runtime?.processor?.dispose) {
    try { await runtime.processor.dispose(); } catch {}
  }
}

async function disposeVisionRuntime(expectedOwner = '') {
  if (expectedOwner && visionRuntimeOwner && visionRuntimeOwner !== expectedOwner) return;
  const runtime = visionRuntime;
  visionRuntime = null;
  visionRuntimeKey = '';
  visionRuntimeModelKey = '';
  visionRuntimeOwner = '';
  await disposeRuntime(runtime);
}

async function disposeTextRuntime() {
  const runtime = textRuntime;
  textRuntime = null;
  textRuntimeKey = '';
  textRuntimeModelKey = '';
  await disposeRuntime(runtime);
}

async function disposeAllRuntimes() {
  await disposeVisionRuntime();
  await disposeTextRuntime();
}

async function legacyLfm25VlConfig(library, modelId, progress_callback, localFilesOnly) {
  if (modelId !== WEBGPU_LFM25_VL_16B_MODEL_ID) return null;
  if (!library.AutoConfig) {
    throw new Error('The packaged Transformers.js version cannot load the LFM2.5-VL-1.6B model config.');
  }
  const config = await library.AutoConfig.from_pretrained(modelId, {
    progress_callback,
    local_files_only: localFilesOnly,
  });
  config['transformers.js_config'] = {
    ...(config['transformers.js_config'] || {}),
    // LiquidAI's 1.6B ONNX export predates the standard Transformers.js
    // ImageTextToText filenames used by the newer 3B package.
    session_file_names: {
      embed_tokens: 'embed_tokens',
      vision_encoder: 'embed_images',
      decoder_model_merged: 'decoder',
    },
    use_external_data_format: {
      'embed_tokens_fp16.onnx': 1,
      'embed_images_fp16.onnx': 1,
      'decoder_q4.onnx': 1,
    },
  };
  return config;
}

async function getVisionRuntime(modelId, dtype, device, {
  localFilesOnly = false,
  owner = 'vision',
  readiness = 'vision',
} = {}) {
  const key = `vision|${modelId}|${device}|${JSON.stringify(dtype)}`;
  // A device loss flagged between turns leaves both resident sessions poisoned;
  // dispose them before the cached gate so we never hand out a dead session.
  await disposeWebgpuRuntimesIfDirty();
  // Before any resident-session shortcut: download flows replace a stale
  // decoder graph (and drop the session built from it); cache-only loads
  // only notice it.
  if (WEBGPU_BONSAI2_VISION_MODEL_IDS.has(modelId)) {
    const graph = await refreshBonsai2DecoderGraph(modelId, { allowNetwork: !localFilesOnly });
    if (graph === 'updated' && visionRuntimeKey.startsWith(`vision|${modelId}|`)) await disposeVisionRuntime();
  }
  if (visionRuntime && visionRuntimeKey === key) {
    visionRuntimeOwner = owner;
    return visionRuntime;
  }
  if (visionRuntimeLoadPromise) {
    if (visionRuntimeLoadKey === key) return visionRuntimeLoadPromise;
    await visionRuntimeLoadPromise.catch(() => {});
    if (visionRuntime && visionRuntimeKey === key) {
      visionRuntimeOwner = owner;
      return visionRuntime;
    }
  }

  const loadPromise = (async () => {
    const locallyReady = readiness === 'text'
      ? await isTextModelReady(modelId, dtype)
      : await isVisionModelCached(modelId);
    if (localFilesOnly && locallyReady === false) {
      const error = new Error(`${modelId} is not cached locally.`);
      error.code = readiness === 'text' ? 'text_model_not_downloaded' : 'vision_model_not_downloaded';
      throw error;
    }
    const library = await loadLibrary();
    const { AutoModelForImageTextToText, AutoProcessor } = library;
    if (!AutoModelForImageTextToText || !AutoProcessor) {
      throw new Error('The packaged Transformers.js version does not include image-text-to-text support.');
    }
    if (owner === 'text') await disposeTextRuntime();
    await disposeVisionRuntime();
    const progress_callback = event => postProgress(modelId, event);
    const config = await legacyLfm25VlConfig(library, modelId, progress_callback, localFilesOnly);
    const processorOptions = WEBGPU_BONSAI2_VISION_MODEL_IDS.has(modelId)
      ? { image_processor_config_file: 'processor_config.json', chat_template_file: 'chat_template.jinja' }
      : lfm25VlProcessorOptions(modelId);
    const previousAllowLocalModels = library.env?.allowLocalModels;
    if (localFilesOnly && library.env) library.env.allowLocalModels = true;
    let processorResult;
    let modelResult;
    try {
      [processorResult, modelResult] = await Promise.allSettled([
        AutoProcessor.from_pretrained(modelId, {
          ...processorOptions,
          progress_callback,
          local_files_only: localFilesOnly,
        }),
        AutoModelForImageTextToText.from_pretrained(modelId, {
          device,
          dtype,
          ...(config ? { config } : {}),
          progress_callback,
          local_files_only: localFilesOnly,
        }),
      ]);
    } finally {
      if (localFilesOnly && library.env) library.env.allowLocalModels = previousAllowLocalModels;
    }
    if (processorResult.status === 'rejected' || modelResult.status === 'rejected') {
      const loaded = [processorResult, modelResult]
        .filter(result => result.status === 'fulfilled')
        .map(result => result.value);
      for (const resource of loaded) {
        if (resource?.dispose) {
          try { await resource.dispose(); } catch {}
        }
      }
      const failure = processorResult.status === 'rejected'
        ? processorResult.reason
        : modelResult.reason;
      // A session that dies while loading (dead adapter) must not leave a
      // half-built runtime behind; flag it so the next call rebuilds.
      if (isWebGpuExecutionFailure(failure)) {
        markWebgpuRuntimeDirty();
        await disposeAllRuntimes();
        noteWebgpuExecutionFailure(failure);
        throw await enrichWebGpuExecutionError(failure);
      }
      throw failure;
    }
    const processor = processorResult.value;
    const model = modelResult.value;
    applyBonsai2RotaryCompatibility(modelId, model);
    if (WEBGPU_BONSAI2_VISION_MODEL_IDS.has(modelId) && processor.image_processor) {
      // Bound the visual token count for browser screenshots. Upstream Qwen's
      // 16M-pixel ceiling is intended for server GPUs and can exhaust WebGPU.
      processor.image_processor.max_pixels = 1024 * 1024;
    }
    bindWebGpuDeviceDiagnostics(library);
    visionRuntime = { library, processor, model };
    visionRuntimeKey = key;
    visionRuntimeModelKey = textModelKey(modelId, dtype);
    visionRuntimeOwner = owner;
    return visionRuntime;
  })();
  visionRuntimeLoadPromise = loadPromise;
  visionRuntimeLoadKey = key;
  try {
    return await loadPromise;
  } finally {
    if (visionRuntimeLoadPromise === loadPromise) {
      visionRuntimeLoadPromise = null;
      visionRuntimeLoadKey = '';
    }
  }
}

async function preloadRuntime(payload = {}) {
  const modelId = String(payload.modelId || '').trim();
  if (!modelId) throw new Error('No vision model was specified.');
  const device = payload.device || 'webgpu';
  const dtype = payload.dtype || {
    embed_tokens: 'fp16',
    vision_encoder: 'fp16',
    decoder_model_merged: 'q4',
  };
  await getVisionRuntime(modelId, dtype, device);
  await disposeVisionRuntime();
  return modelId;
}

function visionDownloadState(request, status) {
  return {
    status,
    ready: status === 'ready',
    modelId: request?.modelId || '',
    dtype: request?.dtype || '',
  };
}

async function preloadVisionModel(payload, request) {
  if (queuedVisionDownload !== request || request.cancelMode) {
    return visionDownloadState(request, request.cancelMode === 'stop' ? 'not-downloaded' : 'paused');
  }
  queuedVisionDownload = null;
  activeVisionDownloadRequest = request;
  const controller = new AbortController();
  visionDownloadAbortController = controller;
  try {
    await preloadRuntime(payload);
    const status = request.cancelMode === 'stop'
      ? 'not-downloaded'
      : request.cancelMode === 'pause' ? 'paused' : 'ready';
    if (status === 'ready') await markVisionModelReady(request.modelId);
    return visionDownloadState(request, status);
  } catch (error) {
    if (request.cancelMode || controller.signal.aborted) {
      return visionDownloadState(request, request.cancelMode === 'stop' ? 'not-downloaded' : 'paused');
    }
    throw error;
  } finally {
    if (visionDownloadAbortController === controller) visionDownloadAbortController = null;
    if (activeVisionDownloadRequest === request) activeVisionDownloadRequest = null;
  }
}

function pauseVisionDownload(modelId) {
  const normalizedModelId = String(modelId || '').trim();
  const queued = queuedVisionDownload;
  const active = activeVisionDownloadRequest;
  const targetQueued = queued && (!normalizedModelId || queued.modelId === normalizedModelId);
  const targetActive = active && (!normalizedModelId || active.modelId === normalizedModelId);
  if (targetQueued) {
    queued.cancelMode = 'pause';
    if (queuedVisionDownload === queued) queuedVisionDownload = null;
  }
  if (targetActive) {
    active.cancelMode = 'pause';
    visionDownloadAbortController?.abort();
  }
  const target = targetActive ? active : targetQueued ? queued : { modelId: normalizedModelId };
  return {
    ...visionDownloadState(target, 'paused'),
    targetsQueued: Boolean(targetQueued),
    targetsActive: Boolean(targetActive),
  };
}

function stopVisionDownload(modelId) {
  const normalizedModelId = String(modelId || '').trim();
  const queued = queuedVisionDownload;
  const active = activeVisionDownloadRequest;
  const targetsQueued = Boolean(queued && (!normalizedModelId || queued.modelId === normalizedModelId));
  const targetsActive = Boolean(active && (!normalizedModelId || active.modelId === normalizedModelId));
  if (targetsQueued) {
    queued.cancelMode = 'stop';
    if (queuedVisionDownload === queued) queuedVisionDownload = null;
  }
  if (targetsActive) {
    active.cancelMode = 'stop';
    visionDownloadAbortController?.abort();
  }
  return { targetsQueued, targetsActive, hasActiveVision: Boolean(active) };
}

async function getTextRuntime(modelId, dtype, device, { localFilesOnly = false } = {}) {
  assertOnnxTextModel(modelId);
  // Same poison gate as the vision path: never hand out a cached session after
  // a device failure. The build below already starts from disposed runtimes.
  await disposeWebgpuRuntimesIfDirty();
  const key = `text|${modelId}|${device}|${JSON.stringify(dtype)}`;
  if (textRuntime && textRuntimeKey === key) return textRuntime;
  if (textRuntimeLoadPromise) {
    if (textRuntimeLoadKey === key) return textRuntimeLoadPromise;
    await textRuntimeLoadPromise.catch(() => {});
    if (textRuntime && textRuntimeKey === key) return textRuntime;
  }

  const loadPromise = (async () => {
    const library = await loadLibrary();
    if (!library.pipeline) {
      throw new Error('The packaged Transformers.js version does not include text generation.');
    }
    await captureWebGpuAdapterSummary();
    await disposeVisionRuntime('text');
    await disposeTextRuntime();
    const previousAllowLocalModels = library.env?.allowLocalModels;
    if (localFilesOnly && library.env) library.env.allowLocalModels = true;
    let pipeline;
    try {
      // Seed omitted metadata before local_files_only loading, including older
      // browser caches created before these compatibility sidecars were added.
      await cacheBonsai2CompatibilityMetadata(modelId);
      const config = WEBGPU_BONSAI2_SPLIT_TEXT_MODEL_IDS.has(modelId)
        ? normalizeBonsai2Config(await library.AutoConfig.from_pretrained(modelId, {
          local_files_only: localFilesOnly,
          progress_callback: event => postProgress(modelId, event),
        }))
        : null;
      pipeline = await library.pipeline('text-generation', modelId, {
        device,
        dtype,
        ...(config ? { config } : {}),
        ...(WEBGPU_TEXT_MODEL_FILE_NAMES.has(modelId)
          ? { model_file_name: WEBGPU_TEXT_MODEL_FILE_NAMES.get(modelId) }
          : {}),
        // ORT mutates this object while appending its default session config.
        session_options: createWebGpuTextSessionOptions(),
        local_files_only: localFilesOnly,
        progress_callback: event => postProgress(modelId, event),
      });
    } catch (error) {
      // A session that dies while loading must not poison the next call.
      if (isWebGpuExecutionFailure(error)) {
        markWebgpuRuntimeDirty();
        await disposeAllRuntimes();
        noteWebgpuExecutionFailure(error);
        throw await enrichWebGpuExecutionError(error);
      }
      throw error;
    } finally {
      if (localFilesOnly && library.env) library.env.allowLocalModels = previousAllowLocalModels;
    }
    bindWebGpuDeviceDiagnostics(library);
    applyBonsai2RotaryCompatibility(modelId, pipeline.model);
    textRuntime = {
      library,
      pipeline,
      model: pipeline.model,
      tokenizer: pipeline.tokenizer,
    };
    textRuntimeKey = key;
    textRuntimeModelKey = textModelKey(modelId, dtype);
    return textRuntime;
  })();
  textRuntimeLoadPromise = loadPromise;
  textRuntimeLoadKey = key;
  try {
    return await loadPromise;
  } finally {
    if (textRuntimeLoadPromise === loadPromise) {
      textRuntimeLoadPromise = null;
      textRuntimeLoadKey = '';
    }
  }
}

/**
 * Compass VLD v6 2B (compass-vld-v6-runtime.js) or Tiny v5
 * (compass-vld-runtime.js): ONNX Runtime sessions on the
 * same WebGPU device as Transformers.js, a Transformers.js tokenizer, and the
 * model's own processor port. It is one multimodal model for chat, screenshots
 * and decisions, so it lives in the resident multimodal slot (owner `text`)
 * that those requests share; nothing reloads between them. A download fetches
 * and verifies the files first; inference loads only from the cache.
 */
async function getCompassVldRuntime(modelId, dtype, device, { localFilesOnly = false } = {}) {
  const key = `vision|${modelId}|${device}|${JSON.stringify(dtype)}`;
  await disposeWebgpuRuntimesIfDirty();
  if (visionRuntime && visionRuntimeKey === key) {
    visionRuntimeOwner = 'text';
    return visionRuntime;
  }
  if (visionRuntimeLoadPromise) {
    if (visionRuntimeLoadKey === key) return visionRuntimeLoadPromise;
    await visionRuntimeLoadPromise.catch(() => {});
    if (visionRuntime && visionRuntimeKey === key) {
      visionRuntimeOwner = 'text';
      return visionRuntime;
    }
  }
  const loadPromise = (async () => {
    if (typeof caches === 'undefined') throw new Error('Cache Storage is unavailable in the WebGPU worker.');
    const cache = await caches.open(TRANSFORMERS_CACHE_NAME);
    if (localFilesOnly) {
      if (!await compassVldFilesCached(cache, modelId, dtype)) {
        const error = new Error(`${modelId} is not cached locally.`);
        error.code = 'text_model_not_downloaded';
        throw error;
      }
    } else {
      await downloadCompassVld({
        cache,
        fetchImpl: controlledFetch,
        modelId,
        dtype,
        onProgress: event => postProgress(modelId, event),
        isCancelled: () => !!textDownloadCancelMode,
      });
    }
    const library = await loadLibrary();
    await captureWebGpuAdapterSummary();
    await disposeTextRuntime();
    await disposeVisionRuntime();
    const ort = await import(new URL('ort.webgpu.mjs', workerConfig.transformersUrl).href);
    const tokenizer = await createCompassVldTokenizer(library, cache, modelId);
    let sessions;
    try {
      sessions = await createCompassVldSessions(ort, cache, modelId, dtype, { sessionOptions: createWebGpuTextSessionOptions() });
    } catch (error) {
      if (isWebGpuExecutionFailure(error)) {
        markWebgpuRuntimeDirty();
        await disposeAllRuntimes();
        noteWebgpuExecutionFailure(error);
        throw await enrichWebGpuExecutionError(error);
      }
      throw error;
    }
    // v6 2B (LFM3-VL) and Tiny v5 (MiniCPM-V) share files, downloads and the
    // tokenizer, but each has its own processor and decoder loop.
    const engine = isCompassVldV6Model(modelId)
      ? new CompassVldV6Runtime(ort, tokenizer, sessions)
      : new CompassVldRuntime(ort, tokenizer, sessions);
    bindWebGpuDeviceDiagnostics(library);
    visionRuntime = { library, tokenizer, compassVld: engine, model: { dispose: () => engine.dispose() } };
    visionRuntimeKey = key;
    visionRuntimeModelKey = textModelKey(modelId, dtype);
    visionRuntimeOwner = 'text';
    return visionRuntime;
  })();
  visionRuntimeLoadPromise = loadPromise;
  visionRuntimeLoadKey = key;
  try {
    return await loadPromise;
  } finally {
    if (visionRuntimeLoadPromise === loadPromise) {
      visionRuntimeLoadPromise = null;
      visionRuntimeLoadKey = '';
    }
  }
}

async function getDownloadedTextRuntime(modelId, dtype, device, { localFilesOnly = false } = {}) {
  if (isCompassVldModel(modelId)) return getCompassVldRuntime(modelId, dtype, device, { localFilesOnly });
  if (isMultimodalTextModel(modelId)) {
    return getVisionRuntime(modelId, dtype, device, {
      localFilesOnly,
      owner: 'text',
      readiness: 'text',
    });
  }
  return getTextRuntime(modelId, dtype, device, { localFilesOnly });
}

async function disposeDownloadedTextRuntime(modelId = '') {
  if (!modelId || isMultimodalTextModel(modelId)) await disposeVisionRuntime('text');
  if (!modelId || !isMultimodalTextModel(modelId)) await disposeTextRuntime();
}

function chatTemplateText(value) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(chatTemplateText).join('\n');
  if (value && typeof value === 'object') return Object.values(value).map(chatTemplateText).join('\n');
  return '';
}

export function tokenizerSupportsTools(tokenizer) {
  const template = chatTemplateText(tokenizer?.chat_template ?? tokenizer?.chatTemplate);
  return /\btools\b/.test(template);
}

function assertToolCapableTextRuntime(runtime, modelId) {
  if (tokenizerSupportsTools(runtime?.tokenizer ?? runtime?.processor?.tokenizer)) return;
  throw new Error(`${modelId} is not compatible with WebBrain: custom repositories must provide a chat template that accepts tools.`);
}

async function getTextDownloadStatus(modelId, dtype) {
  const ready = await isTextModelReady(modelId, dtype);
  const sameModel = sameTextModel(textDownloadState.modelId, textDownloadState.dtype, modelId, dtype);
  if (sameModel && ['downloading', 'paused', 'stopping'].includes(textDownloadState.status)) {
    return textDownloadSnapshot();
  }
  if (ready) {
    return {
      status: 'ready',
      ready: true,
      modelId,
      dtype,
      file: sameModel ? textDownloadState.file : '',
      loaded: sameModel ? textDownloadState.loaded : 0,
      total: sameModel ? textDownloadState.total : 0,
      progress: 100,
      error: '',
    };
  }
  if (sameModel && textDownloadState.status === 'error') return textDownloadSnapshot();
  return {
    status: 'not-downloaded',
    ready: false,
    modelId,
    dtype,
    file: '',
    loaded: 0,
    total: 0,
    progress: 0,
    error: '',
  };
}

async function downloadTextModel(payload, { onStarted } = {}) {
  const modelId = assertOnnxTextModel(payload?.modelId);
  const device = payload?.device || 'webgpu';
  const dtype = payload?.dtype || 'q4f16';
  const tracksDifferentTransfer = textDownloadState.modelId
    && !sameTextModel(textDownloadState.modelId, textDownloadState.dtype, modelId, dtype)
    && ['downloading', 'paused', 'stopping'].includes(textDownloadState.status);
  if (tracksDifferentTransfer) {
    throw new Error(`Finish or stop the ${textDownloadState.modelId} download before downloading ${modelId}.`);
  }
  await clearLegacyLfm25VlWrongPrecisionCache(modelId, dtype);
  if (await isTextModelReady(modelId, dtype)) {
    // An explicit download of a cached model is the update path for its graph.
    // Model operations are serialized, so no load can race this replacement.
    if (WEBGPU_BONSAI2_VISION_MODEL_IDS.has(modelId)
        && await refreshBonsai2DecoderGraph(modelId, { allowNetwork: true }) === 'updated'
        && visionRuntimeKey.startsWith(`vision|${modelId}|`)) {
      // The resident session was built from the replaced graph.
      await disposeVisionRuntime();
    }
    if (payload?.requireTools === true) {
      const runtime = await getDownloadedTextRuntime(modelId, dtype, device, { localFilesOnly: true });
      assertToolCapableTextRuntime(runtime, modelId);
    }
    textDownloadState = {
      ...textDownloadState,
      status: 'ready',
      ready: true,
      modelId,
      dtype,
      progress: 100,
      error: '',
    };
    postTextDownloadState({ force: true });
    return textDownloadSnapshot();
  }

  const resuming = textDownloadState.status === 'paused'
    && sameTextModel(textDownloadState.modelId, textDownloadState.dtype, modelId, dtype);
  if (!resuming) textDownloadFiles.clear();
  activeTextDownloadModelId = modelId;
  textDownloadCancelMode = '';
  const controller = new AbortController();
  textDownloadAbortController = controller;
  textDownloadState = {
    status: 'downloading',
    ready: false,
    modelId,
    dtype,
    file: resuming ? textDownloadState.file : '',
    loaded: resuming ? textDownloadState.loaded : 0,
    total: resuming ? textDownloadState.total : 0,
    progress: resuming ? textDownloadState.progress : 0,
    error: '',
  };
  postTextDownloadState({ force: true });
  onStarted?.(textDownloadSnapshot());

  try {
    const runtime = await getDownloadedTextRuntime(modelId, dtype, device);
    if (payload?.requireTools === true) assertToolCapableTextRuntime(runtime, modelId);
    if (textDownloadCancelMode) {
      await disposeDownloadedTextRuntime(modelId);
      return textDownloadSnapshot();
    }
    await markTextModelReady(modelId, dtype);
    textDownloadState = {
      ...textDownloadState,
      status: 'ready',
      ready: true,
      progress: 100,
      error: '',
    };
    postTextDownloadState({ force: true });
    return textDownloadSnapshot();
  } catch (error) {
    if (textDownloadCancelMode === 'pause' || textDownloadCancelMode === 'stop' || controller.signal.aborted) {
      textDownloadState = {
        ...textDownloadState,
        status: textDownloadCancelMode === 'stop' ? 'stopping' : 'paused',
        ready: false,
        error: '',
      };
      postTextDownloadState({ force: true });
      return textDownloadSnapshot();
    }
    textDownloadState = {
      ...textDownloadState,
      status: 'error',
      ready: false,
      error: error?.message || String(error),
    };
    postTextDownloadState({ force: true });
    throw error;
  } finally {
    if (textDownloadAbortController === controller) textDownloadAbortController = null;
    activeTextDownloadModelId = '';
  }
}

async function clearLegacyLfm25VlWrongPrecisionCache(modelId, dtype) {
  if (modelId !== WEBGPU_LFM25_VL_16B_MODEL_ID || typeof caches === 'undefined') return 0;
  const modelPath = `/${modelId}/`;
  const wrongPrecisionFile = /\/onnx\/(?:decoder|embed_images)\.onnx(?:_data(?:_\d+)?)?(?:[?#]|$)/;
  let deletedEntries = 0;
  for (const name of await caches.keys()) {
    if (!/transformers/i.test(name)) continue;
    const cache = await caches.open(name);
    for (const request of await cache.keys()) {
      const url = safeDecodedUrl(request.url);
      if (url.includes(modelPath) && wrongPrecisionFile.test(url) && await cache.delete(request)) {
        deletedEntries++;
      }
    }
  }
  if (deletedEntries > 0) {
    for (const key of readyTextModelKeys) {
      if (key === modelId || key.startsWith(`${modelId}|`)) {
        readyTextModelKeys.delete(key);
      }
    }
    const markerUrl = dtype ? textReadyMarkerUrl(modelId, dtype) : '';
    for (const name of await caches.keys()) {
      if (!/transformers/i.test(name)) continue;
      const cache = await caches.open(name);
      if (markerUrl) await cache.delete(markerUrl);
      for (const request of await cache.keys()) {
        const url = safeDecodedUrl(request.url);
        if (url.includes('/.well-known/webgpu-model-ready/') && (url.includes(modelId) || url.includes(encodeURIComponent(modelId)))) {
          await cache.delete(request);
        }
      }
    }
  }
  return deletedEntries;
}

function pauseTextDownload() {
  if (textDownloadState.status !== 'downloading') return textDownloadSnapshot();
  textDownloadCancelMode = 'pause';
  textDownloadState = { ...textDownloadState, status: 'paused', ready: false, error: '' };
  textDownloadAbortController?.abort();
  postTextDownloadState({ force: true });
  return textDownloadSnapshot();
}

async function clearTextModelCache(modelId, dtype) {
  if (textRuntimeModelKey === textModelKey(modelId, dtype)) await disposeTextRuntime();
  if (visionRuntimeOwner === 'text' && visionRuntimeModelKey === textModelKey(modelId, dtype)) {
    await disposeVisionRuntime('text');
  }
  const modelPath = `/${modelId}/`;
  const markerUrl = textReadyMarkerUrl(modelId, dtype);
  if (typeof caches !== 'undefined') {
    for (const name of await caches.keys()) {
      if (!/transformers/i.test(name)) continue;
      const cache = await caches.open(name);
      for (const request of await cache.keys()) {
        const url = safeDecodedUrl(request.url);
        if (url.includes(modelPath) || request.url === markerUrl) await cache.delete(request);
      }
      await cache.delete(markerUrl);
    }
  }
  readyTextModelKeys.delete(textModelKey(modelId, dtype));
  textDownloadFiles.clear();
  textDownloadCancelMode = '';
  const clearedState = {
    status: 'not-downloaded',
    ready: false,
    modelId,
    dtype,
    file: '',
    loaded: 0,
    total: 0,
    progress: 0,
    error: '',
  };
  const sameModel = !textDownloadState.modelId
    || sameTextModel(textDownloadState.modelId, textDownloadState.dtype, modelId, dtype);
  if (sameModel) {
    textDownloadState = clearedState;
    postTextDownloadState({ force: true });
  }
  return { ...clearedState };
}

function enqueueModelOperation(operation) {
  const result = modelOperationQueue.then(operation, operation);
  // Keep the queue usable after one request fails while preserving that
  // failure for the caller awaiting `result`.
  modelOperationQueue = result.catch(() => {});
  return result;
}

function imageUrlFromBlock(block) {
  if (block?.type === 'image_url') {
    return typeof block.image_url === 'string'
      ? block.image_url
      : block.image_url?.url;
  }
  if (block?.type === 'image') {
    return typeof block.image === 'string' ? block.image : block.url;
  }
  return '';
}

export function prepareMultimodalMessages(messages) {
  const imageUrls = [];
  const prepared = [];
  for (const message of Array.isArray(messages) ? messages : []) {
    if (!message || typeof message !== 'object') continue;
    const role = ['system', 'user', 'assistant', 'tool'].includes(message.role)
      ? message.role
      : 'user';
    const imageBlocks = [];
    const textBlocks = [];
    if (Array.isArray(message.content)) {
      for (const block of message.content) {
        if (block?.type === 'text' && typeof block.text === 'string') {
          textBlocks.push({ type: 'text', text: block.text });
          continue;
        }
        const imageUrl = imageUrlFromBlock(block);
        if (imageUrl) {
          imageUrls.push(imageUrl);
          imageBlocks.push({ type: 'image' });
        }
      }
    } else if (typeof message.content === 'string') {
      textBlocks.push({ type: 'text', text: message.content });
    }
    // LFM2.5-VL's published chat template places <image> before the question.
    // Normalize OpenAI-style messages (which often put text first) to that
    // model-specific contract without changing the provider-facing API.
    const blocks = [...imageBlocks, ...textBlocks];
    if (blocks.length || Array.isArray(message.tool_calls)) {
      prepared.push({
        role,
        content: blocks,
        ...(typeof message.tool_call_id === 'string' ? { tool_call_id: message.tool_call_id } : {}),
        ...(typeof message.name === 'string' ? { name: message.name } : {}),
        ...(Array.isArray(message.tool_calls)
          ? { tool_calls: message.tool_calls.map(normalizeTextToolCall) }
          : {}),
        ...(message.reasoning_content ? { reasoning_content: String(message.reasoning_content) } : {}),
      });
    }
  }
  return { messages: prepared, imageUrls };
}

export async function processMultimodalInputs(runtime, modelId, images, prompt) {
  // Qwen's processor takes (text, images), while LFM takes (images, text).
  // Keep this distinction at the runtime boundary so screenshot messages and
  // their untrusted-content framing stay identical throughout the agent.
  if (!WEBGPU_BONSAI2_VISION_MODEL_IDS.has(modelId)) {
    return runtime.processor(images, prompt, { add_special_tokens: false });
  }
  if (!Array.isArray(images) || images.length < 2) {
    return runtime.processor(prompt, images, { add_special_tokens: false });
  }
  // The bundled Qwen image processor treats a batch as video frames. Screenshot
  // history consists of independent images, potentially with different shapes.
  // Process each separately, then join patches and one grid row per image.
  const marker = '<|image_pad|>';
  const chunks = prompt.split(marker);
  if (chunks.length !== images.length + 1) {
    throw new Error('The screenshot count does not match the image placeholders in the prompt.');
  }
  const imageInputs = [];
  for (const image of images) imageInputs.push(await runtime.processor.image_processor(image));
  const mergeArea = runtime.processor.image_processor.config.merge_size ** 2;
  let expanded = chunks[0];
  for (let i = 0; i < imageInputs.length; i++) {
    const grid = imageInputs[i].image_grid_thw.tolist()[0];
    const tokens = Number(grid.reduce((product, dimension) => product * dimension, 1n)) / mergeArea;
    expanded += marker.repeat(tokens) + chunks[i + 1];
  }
  return {
    ...runtime.processor.tokenizer(expanded, { add_special_tokens: false }),
    pixel_values: runtime.library.cat(imageInputs.map(input => input.pixel_values), 0),
    image_grid_thw: runtime.library.cat(imageInputs.map(input => input.image_grid_thw), 0),
  };
}

function createVisionProbeImage(RawImage) {
  if (!RawImage) throw new Error('The packaged runtime does not expose RawImage.');
  // LFM2.5-VL-450M is much more dependable at coarse visual classification
  // than fine OCR. Use three large, unlabeled color panels so the connection
  // test still proves that pixels reached the model without asking it to read
  // tiny synthetic glyphs.
  const width = 480;
  const height = 320;
  const channels = 3;
  const colors = [
    [255, 255, 0],
    [0, 0, 255],
    [255, 0, 0],
  ];
  const data = new Uint8ClampedArray(width * height * channels);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const targetOffset = (y * width + x) * channels;
      const color = colors[Math.min(colors.length - 1, Math.floor(x / (width / colors.length)))];
      for (let channel = 0; channel < channels; channel++) {
        data[targetOffset + channel] = color[channel];
      }
    }
  }
  return new RawImage(data, width, height, channels);
}

async function runVision(payload, requestId) {
  const modelId = String(payload?.modelId || '').trim();
  if (!modelId) throw new Error('No vision model was specified.');
  const device = payload?.device || 'webgpu';
  const dtype = payload?.dtype || {
    embed_tokens: 'fp16',
    vision_encoder: 'fp16',
    decoder_model_merged: 'q4',
  };
  const library = await loadLibrary();
  const stoppingCriteria = library.InterruptableStoppingCriteria
    ? new library.InterruptableStoppingCriteria()
    : null;
  if (stoppingCriteria) activeVisionGenerations.set(requestId, stoppingCriteria);
  try {
    if (cancelledVisionGenerations.has(requestId)) {
      const error = new Error('Vision generation was cancelled.');
      error.name = 'AbortError';
      throw error;
    }
    const runtime = await getVisionRuntime(modelId, dtype, device, {
      localFilesOnly: true,
      owner: 'vision',
      readiness: 'vision',
    });
    const { messages, imageUrls } = prepareMultimodalMessages(payload?.messages);
    if (imageUrls.length !== 1) {
      throw new Error(`${modelId} requires exactly one screenshot; received ${imageUrls.length}.`);
    }
    const prompt = runtime.processor.apply_chat_template(messages, {
      add_generation_prompt: true,
      ...(WEBGPU_BONSAI2_MODEL_IDS.has(modelId) ? { enable_thinking: false } : {}),
    });
    const image = payload?.options?.visionProbe === true
      ? createVisionProbeImage(runtime.library.RawImage)
      : await runtime.library.load_image(imageUrls[0]);
    const inputs = await processMultimodalInputs(runtime, modelId, image, prompt);
    const requestedTokens = Number(payload?.options?.maxTokens);
    const maxNewTokens = Number.isFinite(requestedTokens)
      ? Math.max(1, Math.min(1600, Math.round(requestedTokens)))
      : 800;
    lastWebGpuDeviceError = '';
    lastWebGpuDeviceLost = '';
    let outputs;
    try {
      outputs = await runtime.model.generate({
        ...inputs,
        do_sample: false,
        max_new_tokens: maxNewTokens,
        ...(stoppingCriteria ? { stopping_criteria: [stoppingCriteria] } : {}),
      });
    } catch (error) {
      // A dead WebGPU device poisons the resident session: enrich, drop it,
      // and let the next turn rebuild from the cached weights.
      if (isWebGpuExecutionFailure(error)) throw await handleWebGpuExecutionFailure(error);
      throw error;
    }
    if (cancelledVisionGenerations.has(requestId)) {
      const error = new Error('Vision generation was cancelled.');
      error.name = 'AbortError';
      throw error;
    }
  const inputLength = inputs.input_ids.dims.at(-1);
  const generated = outputs.slice(null, [inputLength, null]);
  const decoded = runtime.processor.batch_decode(generated, { skip_special_tokens: true });
  noteWebgpuExecutionSuccess();
  return String(decoded?.[0] || '').trim();
  } finally {
    activeVisionGenerations.delete(requestId);
    cancelledVisionGenerations.delete(requestId);
  }
}

function normalizeTextToolCall(toolCall) {
  if (!toolCall || typeof toolCall !== 'object') return toolCall;
  const usesFunctionWrapper = toolCall.function && typeof toolCall.function === 'object';
  const target = usesFunctionWrapper ? toolCall.function : toolCall;
  let parsedArguments = target.arguments;
  if (typeof parsedArguments === 'string') {
    try {
      parsedArguments = JSON.parse(parsedArguments);
    } catch {
      parsedArguments = {};
    }
  }
  if (!parsedArguments || typeof parsedArguments !== 'object' || Array.isArray(parsedArguments)) {
    // Ling's template calls .items() unconditionally, so malformed or omitted
    // historical arguments must still be represented by an object.
    parsedArguments = {};
  }
  if (parsedArguments === target.arguments) return toolCall;

  if (usesFunctionWrapper) {
    return {
      ...toolCall,
      function: { ...target, arguments: parsedArguments },
    };
  }
  return { ...toolCall, arguments: parsedArguments };
}

export function prepareTextMessages(messages) {
  return (Array.isArray(messages) ? messages : []).map(message => {
    if (!message || typeof message !== 'object') return { role: 'user', content: '' };
    const prepared = {
      ...message,
      ...(Array.isArray(message.tool_calls)
        ? { tool_calls: message.tool_calls.map(normalizeTextToolCall) }
        : {}),
    };
    if (Array.isArray(message.content)) {
      const text = message.content
        .filter(block => block?.type === 'text' && typeof block.text === 'string')
        .map(block => block.text)
        .join('\n');
      return { ...prepared, content: text };
    }
    return { ...prepared, content: String(message.content || '') };
  });
}

export function splitThinking(content, { openingTagInPrompt = false } = {}) {
  const source = String(content || '').trim();
  const match = /^<think>\s*([\s\S]*?)\s*<\/think>\s*([\s\S]*)$/i.exec(source);
  if (match) {
    return {
      content: String(match[2] || '').trim(),
      reasoningContent: String(match[1] || '').trim() || null,
      incompleteReasoning: false,
    };
  }
  if (!openingTagInPrompt) {
    return { content: source, reasoningContent: null, incompleteReasoning: false };
  }

  // LFM2.5's official template places `<think>` in the generation prompt.
  // Transformers.js therefore returns only the generated suffix: reasoning,
  // `</think>`, then the user-facing answer.
  const closingTag = /<\/think>/i.exec(source);
  if (!closingTag) {
    return {
      content: '',
      reasoningContent: source || null,
      incompleteReasoning: !!source,
    };
  }
  return {
    content: source.slice(closingTag.index + closingTag[0].length).trim(),
    reasoningContent: source.slice(0, closingTag.index).trim() || null,
    incompleteReasoning: false,
  };
}

function addLegacyVlTools(messages, tools) {
  if (!tools.length) return messages;
  const toolText = `List of tools: [${tools.map(tool => JSON.stringify(tool)).join(', ')}]`;
  const prepared = messages.map(message => ({ ...message, content: [...(message.content || [])] }));
  if (prepared[0]?.role === 'system') {
    prepared[0].content.push({ type: 'text', text: `\n${toolText}` });
  } else {
    prepared.unshift({ role: 'system', content: [{ type: 'text', text: toolText }] });
  }
  return prepared;
}

async function loadCompassVldImages(runtime, urls, beforeImage = null) {
  const images = [];
  for (const url of urls) {
    beforeImage?.();
    const image = await runtime.library.load_image(url);
    images.push(runtime.compassVld.preprocess(toRGB(image.data, image.width, image.height, image.channels), image.width, image.height));
  }
  return images;
}

// Chat, tool calls and screenshot reading on Compass VLD (v6 2B or Tiny v5). Tool calls
// come back as the template's <tool_call> XML in the text, which the agent's
// tool-call parser reads, as for the other Qwen-template presets.
async function runCompassVldText(payload) {
  const requestKey = textRequestKey(payload);
  throwIfTextCancelled(requestKey);
  const modelId = assertOnnxTextModel(payload?.modelId);
  const device = payload?.device || 'webgpu';
  const dtype = payload?.dtype || compassVldDtype(modelId);
  if (!await isTextModelReady(modelId, dtype)) {
    throw new Error(`${modelId} is not downloaded. Open Providers > WebGPU or Apocalypse Mode > WebGPU to download it before chatting.`);
  }
  const runtime = await getCompassVldRuntime(modelId, dtype, device, { localFilesOnly: true });
  throwIfTextCancelled(requestKey);
  if (payload?.requireTools === true) assertToolCapableTextRuntime(runtime, modelId);
  const tools = Array.isArray(payload?.options?.tools) ? payload.options.tools : [];
  const { messages, imageUrls } = prepareMultimodalMessages(payload?.messages);
  // Page text and tool descriptions stay text even where they spell a special token.
  const prompt = runtime.tokenizer.apply_chat_template(runtime.compassVld.plainStrings(messages), {
    add_generation_prompt: true,
    tokenize: false,
    enable_thinking: false,
    tools: tools.length ? runtime.compassVld.plainStrings(tools) : undefined,
  });
  const stopIfCancelled = () => throwIfTextCancelled(requestKey);
  const images = await loadCompassVldImages(runtime, imageUrls, stopIfCancelled);
  const requestedTokens = Number(payload?.options?.maxTokens);
  const maxNewTokens = Number.isFinite(requestedTokens)
    ? Math.max(1, Math.min(1600, Math.round(requestedTokens)))
    : 800;
  lastWebGpuDeviceError = '';
  lastWebGpuDeviceLost = '';
  // A cancel marks the key; the generation loop stops at its next step.
  if (requestKey) activeTextGenerations.set(requestKey, { interrupt() {} });
  let output;
  try {
    output = await runtime.compassVld.generate(prompt, images, {
      maxNewTokens,
      sliceTokens: bonsai2PrefillSliceTokens(payload?.options?.prefillSliceTokens),
      shouldStop: stopIfCancelled,
    });
  } catch (error) {
    if (isWebGpuExecutionFailure(error)) throw await handleWebGpuExecutionFailure(error);
    throw error;
  } finally {
    endTextGeneration(requestKey);
  }
  throwIfTextCancelled(requestKey);
  const decoded = runtime.tokenizer.decode(output.ids, { skip_special_tokens: true });
  const result = splitThinking(String(decoded || '').trim());
  noteWebgpuExecutionSuccess();
  return {
    content: result.content,
    reasoningContent: result.reasoningContent,
    outputTruncated: !output.finished,
  };
}

async function runMultimodalText(payload) {
  const requestKey = textRequestKey(payload);
  throwIfTextCancelled(requestKey);
  const modelId = assertOnnxTextModel(payload?.modelId);
  if (isCompassVldModel(modelId)) return runCompassVldText(payload);
  if (!isMultimodalTextModel(modelId)) {
    throw new Error(`${modelId} is not a shipped WebGPU multimodal model.`);
  }
  const device = payload?.device || 'webgpu';
  const dtype = payload?.dtype || {
    embed_tokens: 'fp16',
    vision_encoder: 'fp16',
    decoder_model_merged: 'q4',
  };
  if (!await isTextModelReady(modelId, dtype)) {
    throw new Error(`${modelId} is not downloaded. Open Providers > WebGPU or Apocalypse Mode > WebGPU to download it before chatting.`);
  }
  const runtime = await getVisionRuntime(modelId, dtype, device, {
    localFilesOnly: true,
    owner: 'text',
    readiness: 'text',
  });
  throwIfTextCancelled(requestKey);
  if (payload?.requireTools === true) assertToolCapableTextRuntime(runtime, modelId);
  const tools = Array.isArray(payload?.options?.tools) ? payload.options.tools : [];
  let { messages, imageUrls } = prepareMultimodalMessages(payload?.messages);
  if (modelId === WEBGPU_LFM25_VL_16B_MODEL_ID) messages = addLegacyVlTools(messages, tools);
  const prompt = runtime.processor.apply_chat_template(messages, {
    add_generation_prompt: true,
    tools: tools.length ? tools : undefined,
    ...(WEBGPU_BONSAI2_MODEL_IDS.has(modelId) ? { enable_thinking: false } : {}),
  });
  let inputs;
  if (imageUrls.length) {
    const images = await Promise.all(imageUrls.map(url => runtime.library.load_image(url)));
    inputs = await processMultimodalInputs(runtime, modelId, images.length === 1 ? images[0] : images, prompt);
  } else {
    inputs = runtime.processor.tokenizer(prompt, { add_special_tokens: false });
  }
  const requestedTokens = Number(payload?.options?.maxTokens);
  const maxNewTokens = Number.isFinite(requestedTokens)
    ? Math.max(1, Math.min(1600, Math.round(requestedTokens)))
    : 800;
  lastWebGpuDeviceError = '';
  lastWebGpuDeviceLost = '';
  const criteria = beginTextGeneration(requestKey, runtime.library);
  let outputs;
  let prefilled = null;
  try {
    if (WEBGPU_BONSAI2_VISION_MODEL_IDS.has(modelId)) {
      prefilled = await prefillBonsai2InSlices(
        runtime,
        inputs,
        bonsai2PrefillSliceTokens(payload?.options?.prefillSliceTokens),
        () => throwIfTextCancelled(requestKey),
      );
    }
    // A cancel that landed during the last slice should not start a generation.
    throwIfTextCancelled(requestKey);
    outputs = await runtime.model.generate({
      ...inputs,
      ...(prefilled ? { past_key_values: prefilled } : {}),
      do_sample: false,
      max_new_tokens: maxNewTokens,
      ...(criteria ? { stopping_criteria: [criteria] } : {}),
    });
  } catch (error) {
    if (isWebGpuExecutionFailure(error)) throw await handleWebGpuExecutionFailure(error);
    throw error;
  } finally {
    endTextGeneration(requestKey);
    // generate() keeps a caller-supplied cache alive; release its GPU buffers
    // without masking a generation error.
    if (prefilled) await prefilled.dispose().catch(() => {});
  }
  throwIfTextCancelled(requestKey);
  const inputLength = inputs.input_ids.dims.at(-1);
  const generated = outputs.slice(null, [inputLength, null]);
  const decoded = runtime.processor.batch_decode(generated, { skip_special_tokens: true });
  const result = splitThinking(String(decoded?.[0] || '').trim());
  noteWebgpuExecutionSuccess();
  // The generated tensor is exact, so reaching the budget means no end-of-text token came first.
  return {
    content: result.content,
    reasoningContent: result.reasoningContent,
    ...outputLimitField(Number(generated?.dims?.at?.(-1)), maxNewTokens, 1),
  };
}

function encodeFloat16Base64(values) {
  const half = new Uint16Array(values.length), view = new DataView(new ArrayBuffer(4));
  for (let i = 0; i < values.length; i++) {
    view.setFloat32(0, values[i]);
    const bits = view.getUint32(0), sign = (bits >>> 16) & 0x8000, exponent = ((bits >>> 23) & 0xff) - 112, mantissa = (bits >>> 13) & 0x3ff;
    half[i] = exponent <= 0 ? sign : exponent >= 31 ? sign | 0x7c00 : sign | (exponent << 10) | mantissa;
  }
  let binary = '';
  const bytes = new Uint8Array(half.buffer);
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

// Option probabilities read from one forward pass per question (see
// webgpu-decisions.js). Only the Bonsai 2 Vision presets are supported: they
// use the chunked decoder whose cache the continuations share.
const DECISION_QUESTION_MARKER = '\u2063WEBBRAIN_DECISION_QUESTION\u2063';

function decisionCancelledError() {
  const error = new Error('The in-browser decision was cancelled.');
  error.name = 'AbortError';
  error.code = 'webgpu_decision_cancelled';
  return error;
}

// `isCancelled` reports a `cancel` for this request (a judge timeout or Stop).
// It is checked before loading, between prefill slices and before every
// continuation, so a timed-out decision frees the model queue promptly.
// The same protocol on Compass VLD (v6 2B or Tiny v5), each fine-tuned on these
// prompts (d1's train split): the page state and screenshots are prefilled
// once and each question continues that cache.
async function runCompassVldDecision(payload, { isCancelled = () => false } = {}) {
  const stopIfCancelled = () => { if (isCancelled()) throw decisionCancelledError(); };
  stopIfCancelled();
  const modelId = assertOnnxTextModel(payload?.modelId);
  const request = normalizeDecisionRequest(payload);
  const dtype = payload?.dtype || compassVldDtype(modelId);
  if (!await isTextModelReady(modelId, dtype)) {
    throw new Error(`${modelId} is not downloaded. Open Providers > WebGPU or Apocalypse Mode > WebGPU to download it first.`);
  }
  const runtime = await getCompassVldRuntime(modelId, dtype, payload?.device || 'webgpu', { localFilesOnly: true });
  stopIfCancelled();
  const temperature = Number(payload?.temperature) > 0 ? Number(payload.temperature) : 1;
  const variant = ['readout', 'default', 'strict', 'verify', 'probe', 'gate'].includes(payload?.promptVariant) ? payload.promptVariant : 'probe';
  if (variant === 'probe' && !compassVldDecisionProbe(modelId)) {
    throw new Error(`No decision probe is trained for ${modelId}.`);
  }
  const engine = runtime.compassVld;
  // The page state, the user's message and the questions stay text even where
  // they spell a special token.
  const plain = text => engine.plainText(text);
  const messages = [
    { role: 'system', content: [{ type: 'text', text: decisionSystemPrompt(payload?.promptVariant) }] },
    { role: 'user', content: [
      ...request.images.map(() => ({ type: 'image' })),
      { type: 'text', text: `${plain(variant === 'gate' ? String(request.state || '') : decisionStateText(request.state))}\n\n${DECISION_QUESTION_MARKER}` },
    ] },
  ];
  const rendered = runtime.tokenizer.apply_chat_template(messages, { add_generation_prompt: true, enable_thinking: false, tokenize: false });
  const split = rendered.indexOf(DECISION_QUESTION_MARKER);
  if (split < 0 || rendered.indexOf(DECISION_QUESTION_MARKER, split + 1) >= 0) {
    throw new Error('The decision prompt did not render as expected.');
  }
  const prefixText = rendered.slice(0, split);
  const tailText = rendered.slice(split + DECISION_QUESTION_MARKER.length);
  const codeIds = new Map();
  const codeId = code => {
    if (!codeIds.has(code)) {
      const ids = engine.encode(code);
      if (ids.length !== 1) throw new Error(`Decision answer code ${code} is not a single token.`);
      codeIds.set(code, ids[0]);
    }
    return codeIds.get(code);
  };
  lastWebGpuDeviceError = '';
  lastWebGpuDeviceLost = '';
  const started = performance.now();
  let prefill = null;
  const answers = {};
  const questionMs = [];
  let suffixTokens = 0;
  try {
    const images = await loadCompassVldImages(runtime, request.images, stopIfCancelled);
    const prefix = await engine.buildInputs(prefixText, images, { beforeImage: stopIfCancelled });
    prefill = await engine.prefill(prefix, {
      sliceTokens: bonsai2PrefillSliceTokens(payload?.prefillSliceTokens),
      beforeSlice: stopIfCancelled,
    });
    const prefillMs = performance.now() - started;
    const returnHidden = payload?.returnHidden === true;
    const verify = variant === 'verify' || variant === 'probe';
    const yesNo = verify || variant === 'gate';
    const yesId = yesNo ? codeId('Yes') : null, noId = yesNo ? codeId('No') : null;
    for (const [id, question] of request.entries) {
      const questionStarted = performance.now();
      if (verify) {
        const margins = [], hidden = [];
        const count = decisionOptions(question).names.length;
        for (let index = 0; index < count; index++) {
          stopIfCancelled();
          const output = await engine.continuation(prefix, prefill.cache, `${plain(decisionVerifyText(question, index))}${tailText}`);
          suffixTokens += output.tokens;
          margins.push(output.logits[yesId] - output.logits[noId]);
          hidden.push(output.hidden);
        }
        const scores = variant === 'probe' ? compassVldProbeScores(margins, hidden, modelId) : margins;
        answers[id] = {
          ...decisionAnswer(question, scores, { temperature }),
          ...(returnHidden ? { margins, hidden: hidden.map(vector => (vector ? encodeFloat16Base64(vector) : null)) } : {}),
        };
        questionMs.push(Math.round(performance.now() - questionStarted));
        continue;
      }
      if (variant === 'gate') {
        if (question.type !== 'noul') throw new Error('The screenshot gate takes Yes/No questions only.');
        stopIfCancelled();
        const output = await engine.continuation(prefix, prefill.cache, `${plain(decisionQuestionText(question))}${tailText}`);
        suffixTokens += output.tokens;
        const margin = output.logits[yesId] - output.logits[noId];
        const probability = tinyAskGateProbability(modelId, margin, output.hidden);
        // Without a trained probe the gate fails and tiny Ask stays text-only;
        // the margin and hidden state still go to the probe's training script.
        if (probability === null && !(returnHidden && output.hidden)) {
          throw new Error(`No screenshot gate probe is trained for ${modelId}.`);
        }
        answers[id] = {
          type: 'noul',
          noul: probability,
          ...(returnHidden ? { margins: [margin], hidden: [output.hidden ? encodeFloat16Base64(output.hidden) : null] } : {}),
        };
        questionMs.push(Math.round(performance.now() - questionStarted));
        continue;
      }
      stopIfCancelled();
      const output = await engine.continuation(prefix, prefill.cache, `${plain(decisionQuestionText(question))}${tailText}`);
      suffixTokens += output.tokens;
      const logits = output.logits;
      const ids = decisionOptions(question).codes.map(codeId);
      let top = -Infinity;
      for (const value of logits) if (value > top) top = value;
      let total = 0;
      for (const value of logits) total += Math.exp(value - top);
      const mass = ids.reduce((sum, tokenId) => sum + Math.exp(logits[tokenId] - top), 0) / total;
      answers[id] = decisionAnswer(question, ids.map(tokenId => logits[tokenId]), { temperature, mass });
      questionMs.push(Math.round(performance.now() - questionStarted));
    }
    noteWebgpuExecutionSuccess();
    return {
      model: modelId,
      provider: 'webgpu',
      answers,
      usage: { input_tokens: prefix.ids.length + suffixTokens, output_tokens: 0 },
      diagnostics: {
        generated_tokens: 0,
        prefix_tokens: prefix.ids.length,
        images: request.images.length,
        prefill_ms: Math.round(prefillMs),
        question_ms: questionMs,
        total_ms: Math.round(performance.now() - started),
        temperature,
        prompt_variant: variant,
      },
    };
  } catch (error) {
    if (isWebGpuExecutionFailure(error)) throw await handleWebGpuExecutionFailure(error);
    throw error;
  } finally {
    if (prefill) CompassVldRuntime.disposeCache(prefill.cache);
  }
}

async function runMultimodalDecision(payload, { isCancelled = () => false } = {}) {
  const stopIfCancelled = () => { if (isCancelled()) throw decisionCancelledError(); };
  stopIfCancelled();
  const modelId = assertOnnxTextModel(payload?.modelId);
  if (isCompassVldModel(modelId)) return runCompassVldDecision(payload, { isCancelled });
  if (!WEBGPU_BONSAI2_VISION_MODEL_IDS.has(modelId)) {
    throw new Error(`${modelId} does not support in-browser decisions.`);
  }
  const request = normalizeDecisionRequest(payload);
  const dtype = payload?.dtype || { embed_tokens: 'fp16', vision_encoder: 'fp16', decoder_model_merged: 'q2f16' };
  if (!await isTextModelReady(modelId, dtype)) {
    throw new Error(`${modelId} is not downloaded. Open Providers > WebGPU or Apocalypse Mode > WebGPU to download it first.`);
  }
  const runtime = await getVisionRuntime(modelId, dtype, payload?.device || 'webgpu', {
    localFilesOnly: true,
    owner: 'text',
    readiness: 'text',
  });
  stopIfCancelled();
  const temperature = Number(payload?.temperature) > 0 ? Number(payload.temperature) : 1;
  const messages = [
    { role: 'system', content: [{ type: 'text', text: decisionSystemPrompt(payload?.promptVariant) }] },
    { role: 'user', content: [
      ...request.images.map(() => ({ type: 'image' })),
      { type: 'text', text: `${payload?.promptVariant === 'gate' ? String(request.state || '') : decisionStateText(request.state)}\n\n${DECISION_QUESTION_MARKER}` },
    ] },
  ];
  const rendered = runtime.processor.apply_chat_template(messages, { add_generation_prompt: true, enable_thinking: false });
  const split = rendered.indexOf(DECISION_QUESTION_MARKER);
  if (split < 0 || rendered.indexOf(DECISION_QUESTION_MARKER, split + 1) >= 0) {
    throw new Error('The decision prompt did not render as expected.');
  }
  const prefixText = rendered.slice(0, split);
  const tailText = rendered.slice(split + DECISION_QUESTION_MARKER.length);
  const tokenizer = runtime.processor.tokenizer;
  const codeIds = new Map();
  const codeId = code => {
    if (!codeIds.has(code)) {
      const ids = tokenizer.encode(code, { add_special_tokens: false });
      if (ids.length !== 1) throw new Error(`Decision answer code ${code} is not a single token.`);
      codeIds.set(code, ids[0]);
    }
    return codeIds.get(code);
  };
  let prefix;
  if (request.images.length) {
    const images = await Promise.all(request.images.map(url => runtime.library.load_image(url)));
    prefix = await processMultimodalInputs(runtime, modelId, images.length === 1 ? images[0] : images, prefixText);
  } else {
    prefix = tokenizer(prefixText, { add_special_tokens: false });
  }
  lastWebGpuDeviceError = '';
  lastWebGpuDeviceLost = '';
  const prefixLength = prefix.input_ids.dims.at(-1);
  const started = performance.now();
  let cache = null;
  const answers = {};
  const questionMs = [];
  let suffixTokens = 0;
  try {
    cache = await prefillBonsai2Cache(runtime, prefix, bonsai2PrefillSliceTokens(payload?.prefillSliceTokens), prefixLength, stopIfCancelled);
    const prefillMs = performance.now() - started;
    // `probe` (the default) scores each option's verify continuation with the
    // trained probe; `verify` returns the raw Yes margins; `readout` and
    // `strict` read the option codes in one pass. `gate` reads one Yes/No
    // question about a user's message with its hidden state and scores it with
    // the screenshot gate probe (tiny Ask); the others are for the diagnostic
    // fixture path.
    const variant = ['readout', 'default', 'strict', 'verify', 'probe', 'gate'].includes(payload?.promptVariant) ? payload.promptVariant : 'probe';
    const verify = variant === 'verify' || variant === 'probe';
    if (variant === 'probe' && modelId !== BONSAI_DECISION_PROBE.model) {
      throw new Error(`No decision probe is trained for ${modelId}.`);
    }
    const returnHidden = payload?.returnHidden === true;
    const yesNo = verify || variant === 'gate';
    const yesId = yesNo ? codeId('Yes') : null, noId = yesNo ? codeId('No') : null;
    for (const [id, question] of request.entries) {
      const questionStarted = performance.now();
      if (verify) {
        // One continuation per option; the answer compares their Yes margins.
        const margins = [], hidden = [];
        const count = decisionOptions(question).names.length;
        for (let index = 0; index < count; index++) {
          const suffix = tokenizer(`${decisionVerifyText(question, index)}${tailText}`, { add_special_tokens: false });
          suffixTokens += suffix.input_ids.dims.at(-1);
          stopIfCancelled();
          const output = await bonsai2ContinuationLogits(runtime, prefix, cache, suffix.input_ids, { withHidden: true });
          margins.push(output.logits[yesId] - output.logits[noId]);
          if (variant === 'probe' && !output.hidden) {
            throw new Error('In-browser decisions need the updated Ternary Bonsai 2 2B Vision decoder. Download the model again in Providers > WebGPU.');
          }
          hidden.push(output.hidden);
        }
        const scores = variant === 'probe' ? bonsaiProbeScores(margins, hidden) : margins;
        answers[id] = {
          ...decisionAnswer(question, scores, { temperature }),
          ...(returnHidden ? { margins, hidden: hidden.map(vector => (vector ? encodeFloat16Base64(vector) : null)) } : {}),
        };
        questionMs.push(Math.round(performance.now() - questionStarted));
        continue;
      }
      if (variant === 'gate') {
        if (question.type !== 'noul') throw new Error('The screenshot gate takes Yes/No questions only.');
        const suffix = tokenizer(`${decisionQuestionText(question)}${tailText}`, { add_special_tokens: false });
        suffixTokens += suffix.input_ids.dims.at(-1);
        stopIfCancelled();
        const output = await bonsai2ContinuationLogits(runtime, prefix, cache, suffix.input_ids, { withHidden: true });
        const margin = output.logits[yesId] - output.logits[noId];
        const probability = tinyAskGateProbability(modelId, margin, output.hidden);
        // Collecting training data needs only the margin and hidden state.
        if (probability === null && !(returnHidden && output.hidden)) {
          throw new Error('The screenshot gate needs the updated Ternary Bonsai 2 2B Vision decoder. Download the model again in Providers > WebGPU.');
        }
        answers[id] = {
          type: 'noul',
          noul: probability,
          ...(returnHidden ? { margins: [margin], hidden: [output.hidden ? encodeFloat16Base64(output.hidden) : null] } : {}),
        };
        questionMs.push(Math.round(performance.now() - questionStarted));
        continue;
      }
      const suffix = tokenizer(`${decisionQuestionText(question)}${tailText}`, { add_special_tokens: false });
      suffixTokens += suffix.input_ids.dims.at(-1);
      stopIfCancelled();
      const logits = await bonsai2ContinuationLogits(runtime, prefix, cache, suffix.input_ids);
      const ids = decisionOptions(question).codes.map(codeId);
      let top = -Infinity;
      for (const value of logits) if (value > top) top = value;
      let total = 0;
      for (const value of logits) total += Math.exp(value - top);
      const mass = ids.reduce((sum, tokenId) => sum + Math.exp(logits[tokenId] - top), 0) / total;
      answers[id] = decisionAnswer(question, ids.map(tokenId => logits[tokenId]), { temperature, mass });
      questionMs.push(Math.round(performance.now() - questionStarted));
    }
    noteWebgpuExecutionSuccess();
    return {
      model: modelId,
      provider: 'webgpu',
      answers,
      usage: { input_tokens: prefixLength + suffixTokens, output_tokens: 0 },
      diagnostics: {
        generated_tokens: 0,
        prefix_tokens: prefixLength,
        images: request.images.length,
        prefill_ms: Math.round(prefillMs),
        question_ms: questionMs,
        total_ms: Math.round(performance.now() - started),
        temperature,
        prompt_variant: variant,
      },
    };
  } catch (error) {
    if (isWebGpuExecutionFailure(error)) throw await handleWebGpuExecutionFailure(error);
    throw error;
  } finally {
    if (cache) await cache.dispose().catch(() => {});
  }
}

async function runText(payload) {
  const requestKey = textRequestKey(payload);
  throwIfTextCancelled(requestKey);
  const modelId = assertOnnxTextModel(payload?.modelId);
  const device = payload?.device || 'webgpu';
  const dtype = payload?.dtype || 'q4f16';
  const usesReasoningTemplate = WEBGPU_REASONING_MODEL_IDS.has(modelId);
  const opensThinkingInPrompt = WEBGPU_OPEN_THINKING_MODEL_IDS.has(modelId);
  const usesLongOutputBudget = WEBGPU_LONG_OUTPUT_MODEL_IDS.has(modelId);
  const sampling = WEBGPU_TEXT_SAMPLING.get(modelId);
  if (!await isTextModelReady(modelId, dtype)) {
    throw new Error(`${modelId} is not downloaded. Open Providers > WebGPU or Apocalypse Mode > WebGPU to download it before chatting.`);
  }
  const runtime = await getTextRuntime(modelId, dtype, device, { localFilesOnly: true });
  throwIfTextCancelled(requestKey);
  if (payload?.requireTools === true) assertToolCapableTextRuntime(runtime, modelId);
  const requestedTokens = Number(payload?.options?.maxTokens);
  const maxTokenLimit = usesLongOutputBudget
    ? WEBGPU_LFM25_MAX_NEW_TOKENS
    : WEBGPU_TEXT_MAX_NEW_TOKENS;
  const maxNewTokens = Number.isFinite(requestedTokens)
    ? Math.max(1, Math.min(maxTokenLimit, Math.round(requestedTokens)))
    : maxTokenLimit;
  const tools = Array.isArray(payload?.options?.tools) ? payload.options.tools : [];
  lastWebGpuDeviceError = '';
  lastWebGpuDeviceLost = '';
  const criteria = beginTextGeneration(requestKey, runtime.library);
  let output;
  try {
    output = await runtime.pipeline(prepareTextMessages(payload?.messages), {
      do_sample: Boolean(sampling),
      ...(sampling || {}),
      max_new_tokens: maxNewTokens,
      ...(criteria ? { stopping_criteria: [criteria] } : {}),
      tools: tools.length ? tools : undefined,
      // Reasoning templates re-open `<think>` for the pending turn and collapse
      // completed thinking in history; the rest suppress thinking outright.
      tokenizer_encode_kwargs: usesReasoningTemplate
        ? { preserve_thinking: false }
        : { enable_thinking: false },
    });
  } catch (error) {
    if (isWebGpuExecutionFailure(error)) throw await handleWebGpuExecutionFailure(error);
    throw error;
  } finally {
    endTextGeneration(requestKey);
  }
  throwIfTextCancelled(requestKey);
  const generated = output?.[0]?.generated_text;
  const content = Array.isArray(generated)
    ? generated.at(-1)?.content
    : generated;
  if (typeof content !== 'string') {
    throw new Error('The WebGPU model returned no generated text.');
  }
  const result = splitThinking(content, { openingTagInPrompt: opensThinkingInPrompt });
  if (result.incompleteReasoning) {
    throw new Error(`${modelId} used its generation budget before finishing reasoning. Retry with a shorter prompt.`);
  }
  noteWebgpuExecutionSuccess();
  return {
    content: result.content,
    reasoningContent: result.reasoningContent,
    ...outputLimitField(countGeneratedTokens(runtime.tokenizer, content), maxNewTokens),
  };
}

async function probeRuntime() {
  await loadLibrary();
  const hasWebGPU = typeof navigator !== 'undefined' && !!navigator.gpu;
  let adapter = null;
  if (hasWebGPU) {
    try { adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' }); } catch {}
  }
  const isFallbackAdapter = !!(adapter?.isFallbackAdapter ?? adapter?.info?.isFallbackAdapter);
  return {
    libraryVersion,
    hasWebGPU: hasWebGPU && !!adapter,
    isFallbackAdapter,
    adapterFeatures: adapter ? [...adapter.features].slice(0, 12) : [],
  };
}

export async function clearVisionModelCache(modelId) {
  const normalizedModelId = String(modelId || '').trim();
  if (!normalizedModelId) throw new Error('No vision model was specified.');
  await disposeVisionRuntime('vision');
  const modelPath = `/${normalizedModelId}/`;
  const markerUrl = visionReadyMarkerUrl(normalizedModelId);
  let deletedEntries = 0;
  if (typeof caches !== 'undefined') {
    for (const name of await caches.keys()) {
      if (!/transformers/i.test(name)) continue;
      const cache = await caches.open(name);
      for (const request of await cache.keys()) {
        const url = safeDecodedUrl(request.url);
        if (url.includes(modelPath) || isVisionReadyMarkerForModel(request.url, normalizedModelId)) {
          if (await cache.delete(request)) deletedEntries++;
        }
      }
      if (await cache.delete(markerUrl)) deletedEntries++;
    }
  }
  return { modelId: normalizedModelId, deletedEntries };
}

self.addEventListener('message', async event => {
  const { id, type, payload } = event.data || {};
  try {
    if (type === 'cancel') {
      const requestId = Number(payload?.requestId);
      const queued = queuedVisionGenerations.has(requestId);
      const active = activeVisionGenerations.has(requestId);
      const cancellable = Number.isFinite(requestId) && (queued || active);
      if (cancellable) {
        cancelledVisionGenerations.add(requestId);
        activeVisionGenerations.get(requestId)?.interrupt?.();
      }
      self.postMessage({
        id,
        ok: true,
        cancelled: cancellable,
        requestId,
        queued: queued && !active,
        active,
      });
      return;
    }
    if (type === 'cancel-text') {
      const requestKey = typeof payload?.requestKey === 'string' ? payload.requestKey : '';
      const queued = queuedTextGenerations.has(requestKey);
      const active = activeTextGenerations.has(requestKey);
      const cancellable = TEXT_REQUEST_KEY_PATTERN.test(requestKey) && (queued || active);
      if (cancellable) {
        cancelledTextGenerations.add(requestKey);
        activeTextGenerations.get(requestKey)?.interrupt?.();
      }
      self.postMessage({ id, ok: true, cancelled: cancellable, queued: queued && !active, active });
      return;
    }
    if (type === 'init') {
      workerConfig = payload;
      self.postMessage({ id, ok: true });
      return;
    }
    if (type === 'probe') {
      self.postMessage({ id, ok: true, ...(await probeRuntime()) });
      return;
    }
    if (type === 'text-download-status') {
      const modelId = String(payload?.modelId || '').trim();
      const dtype = payload?.dtype || 'q4f16';
      if (!modelId || payload?.probeActive === true) {
        if (['starting', 'queued', 'downloading', 'paused', 'stopping'].includes(textDownloadState.status)) {
          self.postMessage({ id, ok: true, ...textDownloadSnapshot() });
          return;
        }
        if (!modelId) {
          self.postMessage({ id, ok: true, ...textDownloadSnapshot() });
          return;
        }
      }
      self.postMessage({ id, ok: true, ...(await getTextDownloadStatus(modelId, dtype)) });
      return;
    }
    if (type === 'download-text') {
      const state = await enqueueModelOperation(() => downloadTextModel(payload));
      self.postMessage({ id, ok: true, ...state });
      return;
    }
    if (type === 'start-download-text') {
      const request = assertTextDownloadCanStart(payload);
      queuedTextDownload = request;
      let acknowledged = false;
      const operation = enqueueModelOperation(() => {
        if (queuedTextDownload !== request) return getTextDownloadStatus(request.modelId, request.dtype);
        return downloadTextModel(payload, {
          onStarted(state) {
            acknowledged = true;
            self.postMessage({ id, ok: true, ...state });
          },
        });
      });
      void operation.then((state) => {
        if (!acknowledged) self.postMessage({ id, ok: true, ...state });
      }).catch((error) => {
        if (!acknowledged) self.postMessage({ id, ok: false, error: error?.message || String(error) });
      }).finally(() => {
        if (queuedTextDownload?.key === request.key) queuedTextDownload = null;
      });
      return;
    }
    if (type === 'pause-text-download') {
      self.postMessage({ id, ok: true, ...pauseTextDownload() });
      return;
    }
    if (type === 'stop-text-download') {
      const modelId = String(payload?.modelId || '').trim();
      const dtype = payload?.dtype || 'q4f16';
      const targetsQueuedTransfer = queuedTextDownload
        && sameTextModel(queuedTextDownload.modelId, queuedTextDownload.dtype, modelId, dtype);
      if (targetsQueuedTransfer) queuedTextDownload = null;
      const targetsTrackedTransfer = sameTextModel(textDownloadState.modelId, textDownloadState.dtype, modelId, dtype);
      if (targetsTrackedTransfer) {
        textDownloadCancelMode = 'stop';
        textDownloadState = { ...textDownloadState, status: 'stopping', ready: false, error: '' };
        if (activeTextDownloadModelId === modelId) textDownloadAbortController?.abort();
        postTextDownloadState({ force: true });
      }
      const state = await enqueueModelOperation(() => clearTextModelCache(modelId, dtype));
      self.postMessage({ id, ok: true, ...state });
      return;
    }
    if (type === 'pause-vision-download') {
      self.postMessage({ id, ok: true, ...pauseVisionDownload(payload?.modelId) });
      return;
    }
    if (type === 'stop-vision-download') {
      const modelId = String(payload?.modelId || '').trim();
      if (!modelId) throw new Error('No vision model was specified.');
      const stopped = stopVisionDownload(modelId);
      // A queued preload owns no live vision operation. Clear its model-specific
      // cache immediately so Stop is not trapped behind an unrelated text-model
      // transfer in the shared WebGPU operation queue. The host may also pass
      // targetsQueued after pause already dequeued that preload.
      const targetsQueued = stopped.targetsQueued || payload?.targetsQueued === true;
      const result = targetsQueued && !stopped.hasActiveVision
        ? await clearVisionModelCache(modelId)
        : await enqueueModelOperation(() => clearVisionModelCache(modelId));
      self.postMessage({
        id,
        ok: true,
        status: 'not-downloaded',
        ready: false,
        ...result,
      });
      return;
    }
    if (type === 'clear-cache') {
      const modelId = String(payload?.modelId || '').trim();
      const result = await enqueueModelOperation(() => clearVisionModelCache(modelId));
      self.postMessage({ id, ok: true, ...result });
      return;
    }
    if (type === 'dispose' || type === 'dispose-all') {
      await enqueueModelOperation(disposeAllRuntimes);
      self.postMessage({ id, ok: true, disposed: true });
      return;
    }
    if (type === 'dispose-vision') {
      await enqueueModelOperation(() => disposeVisionRuntime('vision'));
      self.postMessage({ id, ok: true, disposed: true });
      return;
    }
    if (type === 'dispose-text') {
      await enqueueModelOperation(() => disposeDownloadedTextRuntime());
      self.postMessage({ id, ok: true, disposed: true });
      return;
    }
    if (type === 'preload') {
      const modelId = String(payload?.modelId || '').trim();
      if (!modelId) throw new Error('No vision model was specified.');
      const request = {
        modelId,
        dtype: payload?.dtype || '',
        cancelMode: '',
      };
      queuedVisionDownload = request;
      self.postMessage({ type: 'vision-preload-state', modelId, status: 'queued' });
      const state = await enqueueModelOperation(() => {
        self.postMessage({ type: 'vision-preload-state', modelId, status: 'loading' });
        return preloadVisionModel(payload, request);
      });
      if (queuedVisionDownload === request) queuedVisionDownload = null;
      self.postMessage({ id, ok: true, ...state });
      return;
    }
    if (type === 'chat') {
      queuedVisionGenerations.add(id);
      try {
        const content = await enqueueModelOperation(() => runVision(payload, id));
        self.postMessage({ id, ok: true, content, raw: { model: payload?.modelId || '' } });
      } finally {
        queuedVisionGenerations.delete(id);
        cancelledVisionGenerations.delete(id);
      }
      return;
    }
    if (type === 'text-chat' || type === 'multimodal-text-chat') {
      const requestKey = textRequestKey(payload);
      if (requestKey) queuedTextGenerations.add(requestKey);
      try {
        const result = await enqueueModelOperation(
          () => (type === 'text-chat' ? runText(payload) : runMultimodalText(payload)),
        );
        self.postMessage({
          id,
          ok: true,
          ...result,
          raw: { model: payload?.modelId || '' },
        });
      } finally {
        if (requestKey) {
          queuedTextGenerations.delete(requestKey);
          cancelledTextGenerations.delete(requestKey);
        }
      }
      return;
    }
    if (type === 'multimodal-decide') {
      // Cancellable through `cancel` like vision generations, while queued or running.
      queuedVisionGenerations.add(id);
      try {
        const result = await enqueueModelOperation(async () => {
          activeVisionGenerations.set(id, {});
          try {
            return await runMultimodalDecision(payload, { isCancelled: () => cancelledVisionGenerations.has(id) });
          } finally {
            activeVisionGenerations.delete(id);
          }
        });
        self.postMessage({ id, ok: true, ...result });
      } finally {
        queuedVisionGenerations.delete(id);
        cancelledVisionGenerations.delete(id);
      }
      return;
    }
    throw new Error(`Unknown WebGPU worker message: ${type || 'missing type'}`);
  } catch (error) {
    self.postMessage({ id, ok: false, error: error?.message || String(error) });
  }
});
