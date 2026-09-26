/**
 * Dedicated WebGPU worker for endpoint-free local model inference.
 *
 * WebGPU is unavailable in the MV3 service worker, and large ONNX allocations
 * are more reliable in a dedicated worker than on the offscreen document's
 * main thread. The offscreen host owns this worker and proxies correlated
 * request/response messages to it.
 */

import { SPARK_MODEL_ID, SPARK_REVISION, sparkCacheReady, cacheSparkFiles, createSparkRuntime } from './spark-runtime.js';

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
  if (modelId === SPARK_MODEL_ID) return dtype === 'fp16' && await sparkCacheReady();
  const key = textModelKey(modelId, dtype);
  if (readyTextModelKeys.has(key)) return true;
  if (typeof caches === 'undefined') return false;
  try {
    const cache = await caches.open(TRANSFORMERS_CACHE_NAME);
    const marker = await cache.match(textReadyMarkerUrl(modelId, dtype));
    if (!marker) return false;
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
    'Close other GPU-heavy tabs/apps and retry with a short prompt; a retry restarts the on-device worker and re-creates the session from the cached download, it does not re-download. On repeated out-of-memory failures, lower the context window on the WebGPU card in Settings > Providers (16384 is a safe fallback for Compass Tiny v2.1). If it persists, this GPU/driver cannot execute this model with the current WebGPU runtime.',
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

function postProgress(modelId, event) {
  if (modelId === activeTextDownloadModelId && !textDownloadCancelMode) {
    const file = String(event?.file || event?.name || '');
    if (file) {
      const previous = textDownloadFiles.get(file) || { loaded: 0, total: 0, status: '' };
      const total = Number(event?.total || previous.total || 0);
      const loaded = event?.status === 'done' && total > 0
        ? total
        : Number(event?.loaded ?? previous.loaded ?? 0);
      textDownloadFiles.set(file, {
        status: event?.status || previous.status,
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
  self.postMessage({
    type: 'progress',
    modelId,
    status: event?.status || '',
    file: event?.file || event?.name || '',
    loaded: Number(event?.loaded || 0),
    total: Number(event?.total || 0),
    progress: Number(event?.progress || 0),
  });
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
    const processorOptions = lfm25VlProcessorOptions(modelId);
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
    if (modelId === SPARK_MODEL_ID) {
      if (dtype !== 'fp16') throw new Error('Tiny XS v3 requires its native FP16 graph, not q4f16.');
      try {
        const ort = await import(workerConfig.ortUrl);
        const spark = await createSparkRuntime({
          library, ort,
          wasmPaths: { mjs: workerConfig.wasmMjsUrl, wasm: workerConfig.wasmUrl },
        });
        textRuntime = { library, tokenizer: spark.tokenizer, spark, model: { dispose: () => spark.dispose() } };
        textRuntimeKey = key;
        textRuntimeModelKey = textModelKey(modelId, dtype);
        return textRuntime;
      } catch (error) {
        if (isWebGpuExecutionFailure(error)) throw await handleWebGpuExecutionFailure(error);
        throw error;
      }
    }
    const previousAllowLocalModels = library.env?.allowLocalModels;
    if (localFilesOnly && library.env) library.env.allowLocalModels = true;
    let pipeline;
    try {
      pipeline = await library.pipeline('text-generation', modelId, {
        device,
        dtype,
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

async function getDownloadedTextRuntime(modelId, dtype, device, { localFilesOnly = false } = {}) {
  if (isLfm25VlModel(modelId)) {
    return getVisionRuntime(modelId, dtype, device, {
      localFilesOnly,
      owner: 'text',
      readiness: 'text',
    });
  }
  return getTextRuntime(modelId, dtype, device, { localFilesOnly });
}

async function disposeDownloadedTextRuntime(modelId = '') {
  if (!modelId || isLfm25VlModel(modelId)) await disposeVisionRuntime('text');
  if (!modelId || !isLfm25VlModel(modelId)) await disposeTextRuntime();
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
  if (tokenizerSupportsTools(runtime?.tokenizer)) return;
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
    if (modelId === SPARK_MODEL_ID) {
      if (dtype !== 'fp16') throw new Error('Tiny XS v3 requires FP16 precision.');
      await cacheSparkFiles({
        token: String(payload?.hfToken || ''), signal: controller.signal,
        fetchFile: nativeFetch, progress: event => postProgress(modelId, event),
      });
    }
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
      throw new Error(`LFM2.5-VL requires exactly one screenshot; received ${imageUrls.length}.`);
    }
    const prompt = runtime.processor.apply_chat_template(messages, {
      add_generation_prompt: true,
    });
    const image = payload?.options?.visionProbe === true
      ? createVisionProbeImage(runtime.library.RawImage)
      : await runtime.library.load_image(imageUrls[0]);
    const inputs = await runtime.processor(image, prompt, { add_special_tokens: false });
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

async function runMultimodalText(payload) {
  const modelId = assertOnnxTextModel(payload?.modelId);
  if (!isLfm25VlModel(modelId)) {
    throw new Error(`${modelId} is not a shipped WebGPU multimodal model.`);
  }
  const device = payload?.device || 'webgpu';
  const dtype = payload?.dtype || {
    embed_tokens: 'fp16',
    vision_encoder: 'fp16',
    decoder_model_merged: 'q4',
  };
  if (!await isTextModelReady(modelId, dtype)) {
    throw new Error(`${modelId} is not downloaded. Open Settings > Providers > WebGPU or Apocalypse Mode > WebGPU to download it before chatting.`);
  }
  const runtime = await getVisionRuntime(modelId, dtype, device, {
    localFilesOnly: true,
    owner: 'text',
    readiness: 'text',
  });
  const tools = Array.isArray(payload?.options?.tools) ? payload.options.tools : [];
  let { messages, imageUrls } = prepareMultimodalMessages(payload?.messages);
  if (modelId === WEBGPU_LFM25_VL_16B_MODEL_ID) messages = addLegacyVlTools(messages, tools);
  const prompt = runtime.processor.apply_chat_template(messages, {
    add_generation_prompt: true,
    tools: tools.length ? tools : undefined,
  });
  let inputs;
  if (imageUrls.length) {
    const images = await Promise.all(imageUrls.map(url => runtime.library.load_image(url)));
    inputs = await runtime.processor(images.length === 1 ? images[0] : images, prompt, {
      add_special_tokens: false,
    });
  } else {
    inputs = runtime.processor.tokenizer(prompt, { add_special_tokens: false });
  }
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
    });
  } catch (error) {
    if (isWebGpuExecutionFailure(error)) throw await handleWebGpuExecutionFailure(error);
    throw error;
  }
  const inputLength = inputs.input_ids.dims.at(-1);
  const generated = outputs.slice(null, [inputLength, null]);
  const decoded = runtime.processor.batch_decode(generated, { skip_special_tokens: true });
  const result = splitThinking(String(decoded?.[0] || '').trim());
  noteWebgpuExecutionSuccess();
  return { content: result.content, reasoningContent: result.reasoningContent };
}

async function runText(payload) {
  const modelId = assertOnnxTextModel(payload?.modelId);
  const device = payload?.device || 'webgpu';
  const dtype = payload?.dtype || 'q4f16';
  const usesReasoningTemplate = WEBGPU_REASONING_MODEL_IDS.has(modelId);
  const opensThinkingInPrompt = WEBGPU_OPEN_THINKING_MODEL_IDS.has(modelId);
  const usesLongOutputBudget = WEBGPU_LONG_OUTPUT_MODEL_IDS.has(modelId);
  const sampling = WEBGPU_TEXT_SAMPLING.get(modelId);
  if (!await isTextModelReady(modelId, dtype)) {
    throw new Error(`${modelId} is not downloaded. Open Settings > Providers > WebGPU or Apocalypse Mode > WebGPU to download it before chatting.`);
  }
  const runtime = await getTextRuntime(modelId, dtype, device, { localFilesOnly: true });
  if (payload?.requireTools === true) assertToolCapableTextRuntime(runtime, modelId);
  const requestedTokens = Number(payload?.options?.maxTokens);
  const maxTokenLimit = modelId === SPARK_MODEL_ID ? 2048 : usesLongOutputBudget
    ? WEBGPU_LFM25_MAX_NEW_TOKENS
    : WEBGPU_TEXT_MAX_NEW_TOKENS;
  const maxNewTokens = Number.isFinite(requestedTokens)
    ? Math.max(1, Math.min(maxTokenLimit, Math.round(requestedTokens)))
    : maxTokenLimit;
  const tools = Array.isArray(payload?.options?.tools) ? payload.options.tools : [];
  lastWebGpuDeviceError = '';
  lastWebGpuDeviceLost = '';
  let output;
  try {
    if (runtime.spark) {
      const generated = await runtime.spark.generate(prepareTextMessages(payload?.messages), { tools, maxTokens: maxNewTokens });
      const result = splitThinking(generated.content);
      if (result.incompleteReasoning) throw new Error(`${modelId} used its generation budget before finishing reasoning.`);
      noteWebgpuExecutionSuccess();
      return { content: result.content, reasoningContent: result.reasoningContent, usage: generated.usage, raw: { revision: SPARK_REVISION, finishReason: generated.finishReason } };
    }
    output = await runtime.pipeline(prepareTextMessages(payload?.messages), {
      do_sample: Boolean(sampling),
      ...(sampling || {}),
      max_new_tokens: maxNewTokens,
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
  }
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
  return { content: result.content, reasoningContent: result.reasoningContent };
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
    if (type === 'text-chat') {
      const result = await enqueueModelOperation(() => runText(payload));
      self.postMessage({
        id,
        ok: true,
        ...result,
        raw: { model: payload?.modelId || '' },
      });
      return;
    }
    if (type === 'multimodal-text-chat') {
      const result = await enqueueModelOperation(() => runMultimodalText(payload));
      self.postMessage({
        id,
        ok: true,
        ...result,
        raw: { model: payload?.modelId || '' },
      });
      return;
    }
    throw new Error(`Unknown WebGPU worker message: ${type || 'missing type'}`);
  } catch (error) {
    self.postMessage({ id, ok: false, error: error?.message || String(error) });
  }
});
