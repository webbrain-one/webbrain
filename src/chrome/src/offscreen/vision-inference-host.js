/** Proxy endpoint-free WebGPU requests from the service worker to a module Worker. */

let visionWorker = null;
let visionWorkerReady = null;
let nextVisionRequestId = 1;
const pendingVisionRequests = new Map();
let bonsaiWorker = null;
let bonsaiWorkerReady = null;
let nextBonsaiRequestId = 1;
const pendingBonsaiRequests = new Map();
let textDownloadStartChain = Promise.resolve();
const WEBGPU_BONSAI27_MODEL_ID = 'prism-ml/Bonsai-27B-gguf';
const WEBGPU_LFM25_MODEL_ID = 'LiquidAI/LFM2.5-2.6B-ONNX';
const WEBGPU_RUNTIME_BITGPU = 'bitgpu';
const TEXT_TRANSFER_STATUSES = new Set(['starting', 'queued', 'downloading', 'paused', 'stopping']);
const VISION_DOWNLOAD_STATE_MESSAGE = 'webgpu-vision-download-state';
const visionDownloadFiles = new Map();
let visionDownloadState = null;
let visionDownloadStateTimer = null;
let visionPreloadPromise = null;
let visionPreloadKey = '';
let visionPreloadLifecycle = null;
const timedOutVisionRequests = new Map();
const WORKER_INITIALIZATION_TIMEOUT_MS = 15_000;
const VISION_WORKER_RECYCLE_COOLDOWN_MS = 30_000;
// Start one full window in the past so the first signal always recycles.
let lastVisionWorkerRecycleAt = -VISION_WORKER_RECYCLE_COOLDOWN_MS;
const VISION_INFERENCE_TIMEOUT_MS = 90_000;
const CANCELLATION_GRACE_PERIOD_MS = 5_000;
const DOWNLOAD_STALL_TIMEOUT_MS = 2 * 60_000;
const DOWNLOAD_ABSOLUTE_TIMEOUT_MS = 30 * 60_000;

function deadlineError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function clearVisionPreloadTimers(lifecycle = visionPreloadLifecycle) {
  if (!lifecycle) return;
  if (lifecycle.stallTimer) clearTimeout(lifecycle.stallTimer);
  if (lifecycle.absoluteTimer) clearTimeout(lifecycle.absoluteTimer);
  lifecycle.stallTimer = null;
  lifecycle.absoluteTimer = null;
}

function rejectPendingVisionRequests(error) {
  for (const pending of pendingVisionRequests.values()) {
    if (pending.timeoutId) clearTimeout(pending.timeoutId);
    pending.reject(error);
  }
  pendingVisionRequests.clear();
}

function resetVisionWorker(error = new Error('Vision worker was reset.')) {
  const staleWorker = visionWorker;
  visionWorker = null;
  visionWorkerReady = null;
  try { staleWorker?.terminate(); } catch {}
  rejectPendingVisionRequests(error);
  for (const timedOut of timedOutVisionRequests.values()) {
    if (timedOut.graceTimer) clearTimeout(timedOut.graceTimer);
  }
  timedOutVisionRequests.clear();
}

function requestVisionCancellation(requestId, worker, timeoutError) {
  if (!worker || worker !== visionWorker) return;
  const cancelId = nextVisionRequestId++;
  const timedOut = { worker, graceTimer: null, requestId, cancelId };
  timedOutVisionRequests.set(requestId, timedOut);
  timedOutVisionRequests.set(cancelId, timedOut);
  timedOut.graceTimer = setTimeout(() => {
    const current = timedOutVisionRequests.get(requestId);
    if (current !== timedOut) return;
    timedOutVisionRequests.delete(requestId);
    timedOutVisionRequests.delete(cancelId);
    resetVisionWorker(deadlineError(
      'vision_worker_recreated',
      `${timeoutError.message} Cancellation did not settle within ${CANCELLATION_GRACE_PERIOD_MS}ms; the worker was recreated.`,
    ));
  }, CANCELLATION_GRACE_PERIOD_MS);
  try {
    worker.postMessage({
      id: cancelId,
      type: 'cancel',
      payload: { requestId },
    });
  } catch {}
}

function armVisionDownloadTimers(lifecycle, modelId) {
  if (!lifecycle) return;
  const fail = (code, message) => {
    if (visionPreloadLifecycle !== lifecycle || lifecycle.cancelMode) return;
    lifecycle.cancelMode = 'timeout';
    clearVisionPreloadTimers(lifecycle);
    publishVisionDownloadState({
      modelId,
      status: 'error',
      progress: visionDownloadState?.progress || 0,
      loaded: visionDownloadState?.loaded || 0,
      total: visionDownloadState?.total || 0,
      error: message,
    }, true);
    resetVisionWorker(deadlineError(code, message));
  };
  const resetStall = () => {
    if (lifecycle.stallTimer) clearTimeout(lifecycle.stallTimer);
    lifecycle.stallTimer = setTimeout(() => fail(
      'vision_download_stalled',
      `Local vision download made no byte progress for ${DOWNLOAD_STALL_TIMEOUT_MS}ms.`,
    ), DOWNLOAD_STALL_TIMEOUT_MS);
  };
  lifecycle.resetStall = resetStall;
  lifecycle.armAbsoluteDeadline = () => {
    if (!lifecycle || lifecycle.absoluteTimer || lifecycle.cancelMode) return;
    lifecycle.absoluteTimer = setTimeout(() => fail(
      'vision_download_timeout',
      `Local vision download exceeded ${DOWNLOAD_ABSOLUTE_TIMEOUT_MS}ms.`,
    ), DOWNLOAD_ABSOLUTE_TIMEOUT_MS);
  };
}

function publishVisionDownloadState(state, immediate = false) {
  visionDownloadState = {
    modelId: String(state?.modelId || ''),
    status: String(state?.status || 'idle'),
    progress: Math.max(0, Math.min(100, Number(state?.progress) || 0)),
    loaded: Math.max(0, Number(state?.loaded) || 0),
    total: Math.max(0, Number(state?.total) || 0),
    error: String(state?.error || '').slice(0, 500),
    updatedAt: Date.now(),
  };
  const flush = () => {
    visionDownloadStateTimer = null;
    try {
      const pending = chrome.runtime.sendMessage({
        type: VISION_DOWNLOAD_STATE_MESSAGE,
        state: visionDownloadState,
      });
      pending?.catch?.(() => {});
    } catch { /* The service worker may be shutting down with this document. */ }
  };
  if (immediate) {
    if (visionDownloadStateTimer) clearTimeout(visionDownloadStateTimer);
    flush();
  } else if (!visionDownloadStateTimer) {
    visionDownloadStateTimer = setTimeout(flush, 250);
  }
}

function updateVisionDownloadProgress(data) {
  const file = String(data?.file || 'model');
  const loaded = Math.max(0, Number(data?.loaded) || 0);
  const total = Math.max(0, Number(data?.total) || 0);
  if (total > 0) visionDownloadFiles.set(file, { loaded: Math.min(loaded, total), total });
  let aggregateLoaded = 0;
  let aggregateTotal = 0;
  for (const entry of visionDownloadFiles.values()) {
    aggregateLoaded += entry.loaded;
    aggregateTotal += entry.total;
  }
  if (visionPreloadLifecycle && aggregateLoaded > (visionPreloadLifecycle.lastLoaded || 0)) {
    visionPreloadLifecycle.lastLoaded = aggregateLoaded;
    visionPreloadLifecycle.hasProgress = true;
    visionPreloadLifecycle.resetStall?.();
  }
  const eventProgress = Math.max(0, Math.min(100, Number(data?.progress) || 0));
  publishVisionDownloadState({
    modelId: data?.modelId,
    status: 'downloading',
    progress: aggregateTotal > 0 ? aggregateLoaded / aggregateTotal * 100 : eventProgress,
    loaded: aggregateLoaded,
    total: aggregateTotal,
  });
}

function progressMatchesActiveVisionModel(data, activeModelId, preloading) {
  const progressModelId = String(data?.modelId || '').trim();
  return Boolean(preloading
    && progressModelId
    && progressModelId === String(activeModelId || '').trim());
}

function settleVisionRequest(data) {
  if (data?.type === 'text-download-state') {
    try {
      chrome.runtime.sendMessage({ type: 'webgpu-text-download-state', state: data.state }, () => {
        void chrome.runtime.lastError;
      });
    } catch {}
    return;
  }
  if (data?.type === 'progress') {
    if (!progressMatchesActiveVisionModel(data, visionDownloadState?.modelId, visionPreloadPromise)) return;
    console.debug('[webgpu] model download', data);
    updateVisionDownloadProgress(data);
    return;
  }
  if (data?.type === 'vision-preload-state') {
    if (!progressMatchesActiveVisionModel(data, visionDownloadState?.modelId, visionPreloadPromise)) return;
    if (data.status === 'loading') {
      visionPreloadLifecycle?.armAbsoluteDeadline?.();
      visionPreloadLifecycle?.resetStall?.();
    }
    publishVisionDownloadState({
      modelId: data.modelId,
      status: data.status === 'loading' ? 'loading' : 'queued',
      progress: visionDownloadState?.progress || 0,
      loaded: visionDownloadState?.loaded || 0,
      total: visionDownloadState?.total || 0,
    }, true);
    return;
  }
  const timedOut = timedOutVisionRequests.get(data?.id);
  if (timedOut) {
    if (data?.id === timedOut.cancelId && data?.queued === true && data?.active !== true) {
      if (timedOut.graceTimer) clearTimeout(timedOut.graceTimer);
      timedOutVisionRequests.delete(timedOut.requestId);
      timedOutVisionRequests.delete(timedOut.cancelId);
      return;
    }
    if (data?.id !== timedOut.requestId) return;
    if (timedOut.graceTimer) clearTimeout(timedOut.graceTimer);
    timedOutVisionRequests.delete(timedOut.requestId);
    if (timedOut.cancelId) timedOutVisionRequests.delete(timedOut.cancelId);
    return;
  }
  const pending = pendingVisionRequests.get(data?.id);
  if (!pending) return;
  pendingVisionRequests.delete(data.id);
  if (pending.timeoutId) clearTimeout(pending.timeoutId);
  if (data.ok) pending.resolve(data);
  else {
    const error = new Error(data.error || 'Vision worker failed.');
    error.code = data.code || 'vision_worker_error';
    pending.reject(error);
  }
}

function startVisionPreload(message) {
  const modelId = String(message?.model || '').trim();
  const key = `${modelId}|${message?.device || 'webgpu'}|${JSON.stringify(message?.dtype || {})}`;
  if (visionPreloadPromise && visionPreloadKey === key) return false;
  visionDownloadFiles.clear();
  publishVisionDownloadState({ modelId, status: 'starting', progress: 0 }, true);
  const lifecycle = { cancelMode: '', lastLoaded: 0, hasProgress: false, stallTimer: null, absoluteTimer: null };
  visionPreloadKey = key;
  visionPreloadLifecycle = lifecycle;
  armVisionDownloadTimers(lifecycle, modelId);
  const operation = sendVisionWorkerMessage('preload', {
    modelId,
    device: message?.device,
    dtype: message?.dtype,
  }).then((response) => {
    if (lifecycle.cancelMode === 'stop') return response;
    const status = lifecycle.cancelMode === 'pause' ? 'paused' : response?.status || 'ready';
    publishVisionDownloadState({
      modelId,
      status,
      progress: status === 'ready' ? 100 : visionDownloadState?.progress || 0,
      loaded: status === 'not-downloaded' ? 0 : visionDownloadState?.loaded || 0,
      total: status === 'not-downloaded' ? 0 : visionDownloadState?.total || 0,
    }, true);
    return response;
  }, { timeoutMs: 0 }).catch((error) => {
    if (lifecycle.cancelMode === 'stop') return;
    if (lifecycle.cancelMode === 'pause') {
      publishVisionDownloadState({
        modelId,
        status: 'paused',
        progress: visionDownloadState?.progress || 0,
        loaded: visionDownloadState?.loaded || 0,
        total: visionDownloadState?.total || 0,
      }, true);
      return;
    }
    if (lifecycle.cancelMode === 'timeout') return;
    publishVisionDownloadState({
      modelId,
      status: 'error',
      progress: visionDownloadState?.progress || 0,
      loaded: visionDownloadState?.loaded || 0,
      total: visionDownloadState?.total || 0,
      error: error?.message || String(error),
    }, true);
  }).finally(() => {
    clearVisionPreloadTimers(lifecycle);
    if (visionPreloadPromise === operation) {
      visionPreloadPromise = null;
      visionPreloadKey = '';
      visionPreloadLifecycle = null;
    }
  });
  visionPreloadPromise = operation;
  return true;
}

function detachVisionPreload(cancelMode) {
  if (visionPreloadLifecycle) {
    visionPreloadLifecycle.cancelMode = cancelMode;
    clearVisionPreloadTimers(visionPreloadLifecycle);
  }
  visionPreloadPromise = null;
  visionPreloadKey = '';
  visionPreloadLifecycle = null;
}

async function waitForVisionPreloadSettlement(operation) {
  if (!operation) return true;
  let timeoutId = null;
  try {
    return await Promise.race([
      operation.then(() => true, () => true),
      new Promise(resolve => {
        timeoutId = setTimeout(() => resolve(false), CANCELLATION_GRACE_PERIOD_MS);
      }),
    ]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

function isBitgpuTextModel(modelId, runtime) {
  if (String(runtime || '').trim() === WEBGPU_RUNTIME_BITGPU) return true;
  return String(modelId || '').trim() === WEBGPU_BONSAI27_MODEL_ID;
}

function isActiveTextTransfer(state) {
  return TEXT_TRANSFER_STATUSES.has(String(state?.status || '').toLowerCase());
}

async function probeExistingTextWorkerStatus(modelId = '', options = {}) {
  try {
    const payload = modelId ? { modelId, ...options } : { ...options };
    if (isBitgpuTextModel(modelId)) {
      if (!bonsaiWorker) return null;
      return await sendBonsaiWorkerMessage('text-download-status', payload);
    }
    if (!visionWorker) return null;
    return await sendVisionWorkerMessage('text-download-status', payload);
  } catch {
    return null;
  }
}

async function findActiveTextTransfer(requestedModel) {
  // Probe both runtimes: the other worker (Bonsai vs ONNX) and the requested
  // worker itself for a different model. Probing only the other runtime misses
  // same-worker transfers (e.g. ONNX A downloading while status for ONNX B is
  // requested), leaving Settings with no Stop control for the running transfer.
  const probes = isBitgpuTextModel(requestedModel)
    ? [
      probeExistingTextWorkerStatus('', { probeActive: true }),
      probeExistingTextWorkerStatus(WEBGPU_BONSAI27_MODEL_ID, { probeActive: true }),
    ]
    : [
      probeExistingTextWorkerStatus(WEBGPU_BONSAI27_MODEL_ID, { probeActive: true }),
      probeExistingTextWorkerStatus('', { probeActive: true }),
    ];
  const results = await Promise.all(probes);
  const transfers = results.filter(isActiveTextTransfer);
  return transfers.find(state => state.status !== 'paused') || transfers[0] || null;
}

function startExclusiveTextDownload(message) {
  const operation = textDownloadStartChain.then(async () => {
    const activeTransfer = await findActiveTextTransfer(message.model);
    if (activeTransfer && String(activeTransfer.status || '').toLowerCase() !== 'paused') {
      const model = String(activeTransfer.modelId || 'Another WebGPU model');
      throw new Error(`${model} is still ${activeTransfer.status || 'downloading'}. Pause it before switching models.`);
    }
    return await sendTextWorkerMessage(message.model, 'start-download-text', {
      modelId: message.model,
      device: message.device,
      dtype: message.dtype,
      requireTools: message.requireTools === true,
      ...(message.hfToken ? { hfToken: message.hfToken } : {}),
    }, { exclusive: true, runtime: message.runtime });
  });
  textDownloadStartChain = operation.catch(() => {});
  return operation;
}

function settleBonsaiRequest(data) {
  if (data?.type === 'text-download-state') {
    try {
      chrome.runtime.sendMessage({ type: 'webgpu-text-download-state', state: data.state }, () => {
        void chrome.runtime.lastError;
      });
    } catch {}
    return;
  }
  const pending = pendingBonsaiRequests.get(data?.id);
  if (!pending) return;
  pendingBonsaiRequests.delete(data.id);
  if (data.ok) pending.resolve(data);
  else pending.reject(new Error(data.error || 'Bonsai worker failed.'));
}

function sendBonsaiWorkerMessage(type, payload = {}) {
  const id = nextBonsaiRequestId++;
  return new Promise((resolve, reject) => {
    pendingBonsaiRequests.set(id, { resolve, reject });
    bonsaiWorker.postMessage({ id, type, payload });
  });
}

async function ensureBonsaiWorker() {
  if (bonsaiWorkerReady) return bonsaiWorkerReady;
  bonsaiWorker = new Worker(chrome.runtime.getURL('src/offscreen/bonsai-worker.js'), {
    type: 'module',
  });
  bonsaiWorker.addEventListener('message', event => settleBonsaiRequest(event.data));
  bonsaiWorker.addEventListener('error', event => {
    const error = new Error(event?.message || 'Bonsai worker crashed.');
    for (const pending of pendingBonsaiRequests.values()) pending.reject(error);
    pendingBonsaiRequests.clear();
    bonsaiWorker = null;
    bonsaiWorkerReady = null;
  });
  bonsaiWorkerReady = sendBonsaiWorkerMessage('init', {
    manifestUrl: chrome.runtime.getURL('vendor/bitgpu/models/bonsai-27b-gguf/model-manifest.json'),
    auxUrl: chrome.runtime.getURL('vendor/bitgpu/models/bonsai-27b-gguf/Bonsai-27B-Q1_0.aux.bin'),
    dataUrl: 'https://huggingface.co/prism-ml/Bonsai-27B-gguf/resolve/main/Bonsai-27B-Q1_0.gguf',
    tokenizerJsonUrl: 'https://huggingface.co/prism-ml/Bonsai-27B-unpacked/resolve/main/tokenizer.json',
    tokenizerConfigUrl: 'https://huggingface.co/prism-ml/Bonsai-27B-unpacked/resolve/main/tokenizer_config.json',
  });
  return bonsaiWorkerReady;
}

async function disposeOtherTextRuntime(keepRuntime) {
  if (keepRuntime !== 'onnx' && visionWorker) {
    try { await sendVisionWorkerMessage('dispose-text'); } catch { /* ONNX text session may already be empty */ }
  }
  if (keepRuntime !== 'bitgpu' && bonsaiWorker) {
    try { await sendBonsaiWorkerMessage('dispose-text'); } catch { /* Bonsai session may already be empty */ }
  }
}

async function sendTextWorkerMessage(modelId, type, payload = {}, { exclusive = false, runtime } = {}) {
  if (isBitgpuTextModel(modelId, runtime) || isBitgpuTextModel(payload.modelId, payload.runtime)) {
    if (exclusive) await disposeOtherTextRuntime('bitgpu');
    await ensureBonsaiWorker();
    return sendBonsaiWorkerMessage(type, payload);
  }
  if (exclusive) await disposeOtherTextRuntime('onnx');
  await ensureVisionWorker();
  return sendVisionWorkerMessage(type, payload);
}

function defaultVisionWorkerTimeout(type) {
  if (type === 'init') return WORKER_INITIALIZATION_TIMEOUT_MS;
  if (type === 'chat') return VISION_INFERENCE_TIMEOUT_MS;
  // Cache removal is serialized behind model work and can take longer than
  // initialization. Keep its caller attached until the worker acknowledges
  // completion (or fails), so provider fallback cannot miss a late deletion.
  if (type === 'stop-text-download') return 0;
  if (type === 'preload' || type === 'text-chat' || type === 'multimodal-text-chat' || type === 'download-text' || type === 'start-download-text') return 0;
  return WORKER_INITIALIZATION_TIMEOUT_MS;
}

function sendVisionWorkerMessage(type, payload = {}, { timeoutMs = defaultVisionWorkerTimeout(type) } = {}) {
  const id = nextVisionRequestId++;
  const worker = visionWorker;
  if (!worker) return Promise.reject(new Error('Vision worker is unavailable.'));
  return new Promise((resolve, reject) => {
    let timeoutId = null;
    if (timeoutMs > 0) {
      timeoutId = setTimeout(() => {
        const pending = pendingVisionRequests.get(id);
        if (!pending) return;
        pendingVisionRequests.delete(id);
        const code = type === 'init' ? 'vision_worker_init_timeout' : type === 'chat' ? 'vision_inference_timeout' : 'vision_worker_message_timeout';
        const error = deadlineError(code, `Vision worker ${type} request timed out after ${timeoutMs}ms.`);
        reject(error);
        if (type === 'chat') requestVisionCancellation(id, worker, error);
        else if (type === 'init' || type === 'pause-vision-download' || type === 'stop-vision-download') {
          resetVisionWorker(error);
        }
      }, timeoutMs);
    }
    pendingVisionRequests.set(id, { resolve, reject, timeoutId, type, worker });
    try {
      worker.postMessage({ id, type, payload });
    } catch (error) {
      if (timeoutId) clearTimeout(timeoutId);
      pendingVisionRequests.delete(id);
      reject(error);
    }
  });
}

async function ensureVisionWorker() {
  if (visionWorkerReady) return visionWorkerReady;
  const worker = new Worker(chrome.runtime.getURL('src/offscreen/inference-worker.js'), {
    type: 'module',
  });
  visionWorker = worker;
  worker.addEventListener('message', event => {
    if (visionWorker !== worker) return;
    // The worker asks for a fresh context when its WebGPU device dies:
    // onnxruntime-web initializes its Dawn device once per worker lifetime,
    // so no in-worker session rebuild can recover. Terminate and recreate;
    // the next request re-initializes and reloads weights from the cache.
    // Stale workers (already replaced) are ignored by the guard above.
    if (event.data?.type === 'webgpu-device-dead') {
      // A persistently poisoned GPU process would otherwise recycle (and
      // reload ~2 GB into) every attempt; back off instead and surface errors
      // until the window passes, then recycle on the next signal.
      if (Date.now() - lastVisionWorkerRecycleAt < VISION_WORKER_RECYCLE_COOLDOWN_MS) return;
      lastVisionWorkerRecycleAt = Date.now();
      resetVisionWorker(deadlineError(
        'webgpu_device_recreated',
        `The WebGPU device died (${event.data?.reason || 'execution failure'}); the worker was recreated.`,
      ));
      return;
    }
    settleVisionRequest(event.data);
  });
  worker.addEventListener('error', event => {
    if (visionWorker !== worker) return;
    const error = new Error(event?.message || 'Vision worker crashed.');
    resetVisionWorker(error);
  });
  visionWorkerReady = sendVisionWorkerMessage('init', {
    transformersUrl: chrome.runtime.getURL('vendor/transformers/transformers.web.js'),
    ortUrl: chrome.runtime.getURL('vendor/transformers/ort.webgpu.mjs'),
    wasmMjsUrl: chrome.runtime.getURL('vendor/transformers/ort-wasm-simd-threaded.asyncify.mjs'),
    wasmUrl: chrome.runtime.getURL('vendor/transformers/ort-wasm-simd-threaded.asyncify.wasm'),
  }, { timeoutMs: WORKER_INITIALIZATION_TIMEOUT_MS });
  try {
    return await visionWorkerReady;
  } catch (error) {
    if (visionWorker === worker) resetVisionWorker(error);
    throw error;
  }
}

const WEBGPU_MESSAGE_TYPES = new Set([
  'webgpu-chat',
  'webgpu-download-start',
  'webgpu-download-pause',
  'webgpu-download-stop',
  'webgpu-download-status',
  'webgpu-dispose',
  'webgpu-probe',
  'webgpu-vision-chat',
  'webgpu-vision-probe',
  'webgpu-vision-preload',
  'webgpu-vision-pause',
  'webgpu-vision-stop',
  'webgpu-vision-dispose',
  'webgpu-vision-clear-cache',
]);

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!WEBGPU_MESSAGE_TYPES.has(message?.type)) return false;
  (async () => {
    try {
      // Bonsai is GGUF/bitgpu. Never boot Transformers.js for those messages —
      // that runtime always fetches config.json, which the GGUF repo does not have.
      if (!isBitgpuTextModel(message.model, message.runtime)) {
        await ensureVisionWorker();
      }
      if (message.type === 'webgpu-vision-preload') {
        await ensureVisionWorker();
        const started = startVisionPreload(message);
        sendResponse({ ok: true, started });
        return;
      }
      if (message.type === 'webgpu-probe' || message.type === 'webgpu-vision-probe') {
        await ensureVisionWorker();
        sendResponse(await sendVisionWorkerMessage('probe'));
        return;
      }
      if (message.type === 'webgpu-download-status') {
        const status = await sendTextWorkerMessage(message.model, 'text-download-status', {
          modelId: message.model,
          dtype: message.dtype,
        }, { runtime: message.runtime });
        const activeTransfer = await findActiveTextTransfer(message.model);
        sendResponse(activeTransfer ? { ...status, activeTransfer } : status);
        return;
      }
      if (message.type === 'webgpu-download-start') {
        sendResponse(await startExclusiveTextDownload(message));
        return;
      }
      if (message.type === 'webgpu-download-pause') {
        const paused = [];
        if (visionWorker) paused.push(await sendVisionWorkerMessage('pause-text-download'));
        if (bonsaiWorker) paused.push(await sendBonsaiWorkerMessage('pause-text-download'));
        sendResponse(paused.find(state => state?.status === 'paused') || paused[0] || { ok: true, status: 'paused' });
        return;
      }
      if (message.type === 'webgpu-download-stop') {
        sendResponse(await sendTextWorkerMessage(message.model, 'stop-text-download', {
          modelId: message.model,
          dtype: message.dtype,
        }, { runtime: message.runtime }));
        return;
      }
      if (message.type === 'webgpu-vision-pause') {
        const operation = visionPreloadPromise;
        if (visionPreloadLifecycle) {
          visionPreloadLifecycle.cancelMode = 'pause';
          clearVisionPreloadTimers(visionPreloadLifecycle);
        }
        let response;
        try {
          response = await sendVisionWorkerMessage('pause-vision-download', {
            modelId: message.model,
          }, { timeoutMs: CANCELLATION_GRACE_PERIOD_MS });
        } catch (error) {
          if (error?.code !== 'vision_worker_message_timeout') throw error;
          response = {
            ok: true,
            status: 'paused',
            targetsActive: true,
            workerRecreated: true,
            recovery: 'worker_recreated',
          };
        }
        if (response?.targetsActive && !(await waitForVisionPreloadSettlement(operation))) {
          resetVisionWorker(deadlineError(
            'vision_download_pause_forced_reset',
            'Local vision loading did not pause cooperatively; the worker was recreated.',
          ));
        }
        detachVisionPreload('pause');
        publishVisionDownloadState({
          modelId: message.model,
          status: 'paused',
          progress: visionDownloadState?.progress || 0,
          loaded: visionDownloadState?.loaded || 0,
          total: visionDownloadState?.total || 0,
        }, true);
        sendResponse(response);
        return;
      }
      if (message.type === 'webgpu-vision-stop') {
        const operation = visionPreloadPromise;
        if (visionPreloadLifecycle) {
          visionPreloadLifecycle.cancelMode = 'stop';
          clearVisionPreloadTimers(visionPreloadLifecycle);
        }
        publishVisionDownloadState({
          modelId: message.model,
          status: 'stopping',
          progress: visionDownloadState?.progress || 0,
          loaded: visionDownloadState?.loaded || 0,
          total: visionDownloadState?.total || 0,
        }, true);
        let pauseResponse;
        try {
          pauseResponse = await sendVisionWorkerMessage('pause-vision-download', {
            modelId: message.model,
          }, { timeoutMs: CANCELLATION_GRACE_PERIOD_MS });
        } catch (error) {
          if (error?.code !== 'vision_worker_message_timeout') throw error;
          pauseResponse = {
            ok: true,
            status: 'stopping',
            targetsActive: true,
            workerRecreated: true,
            recovery: 'worker_recreated',
          };
        }
        let response;
        if (pauseResponse?.targetsActive) {
          if (!(await waitForVisionPreloadSettlement(operation))) {
            resetVisionWorker(deadlineError(
              'vision_download_stop_forced_reset',
              'Local vision loading did not stop cooperatively; the worker was recreated.',
            ));
          }
          await ensureVisionWorker();
          response = await sendVisionWorkerMessage('clear-cache', { modelId: message.model });
        } else {
          // pause-vision-download dequeues a queued preload. Tell Stop so it
          // still takes the immediate cache-clear path instead of waiting
          // behind an unrelated text-model transfer.
          response = await sendVisionWorkerMessage('stop-vision-download', {
            modelId: message.model,
            dtype: message.dtype,
            ...(pauseResponse?.targetsQueued ? { targetsQueued: true } : {}),
          });
        }
        detachVisionPreload('stop');
        visionDownloadFiles.clear();
        publishVisionDownloadState({
          modelId: message.model,
          status: 'not-downloaded',
          progress: 0,
          loaded: 0,
          total: 0,
        }, true);
        sendResponse(response);
        return;
      }
      if (message.type === 'webgpu-vision-clear-cache') {
        const response = await sendVisionWorkerMessage('clear-cache', { modelId: message.model });
        visionDownloadFiles.clear();
        publishVisionDownloadState({ modelId: message.model, status: 'not-downloaded', progress: 0 }, true);
        sendResponse(response);
        return;
      }
      if (message.type === 'webgpu-vision-dispose') {
        sendResponse(await sendVisionWorkerMessage('dispose-vision'));
        return;
      }
      if (message.type === 'webgpu-dispose') {
        const disposed = [];
        if (visionWorker) disposed.push(await sendVisionWorkerMessage('dispose-text'));
        if (bonsaiWorker) disposed.push(await sendBonsaiWorkerMessage('dispose-text'));
        sendResponse(disposed[0] || { ok: true, disposed: true });
        return;
      }
      if (message.type === 'webgpu-chat') {
        const workerMessageType = message.runtime === 'onnx-vl'
          ? 'multimodal-text-chat'
          : 'text-chat';
        sendResponse(await sendTextWorkerMessage(message.model, workerMessageType, {
          modelId: message.model,
          device: message.device,
          dtype: message.dtype,
          requireTools: message.requireTools === true,
          messages: message.messages || [],
          options: message.options || {},
        }, { exclusive: true, runtime: message.runtime }));
        return;
      }
      const response = await sendVisionWorkerMessage('chat', {
        modelId: message.model,
        device: message.device,
        dtype: message.dtype,
        messages: message.messages || [],
        options: message.options || {},
      });
      publishVisionDownloadState({ modelId: message.model, status: 'ready', progress: 100 }, true);
      sendResponse(response);
    } catch (error) {
      sendResponse({
        ok: false,
        error: error?.message || String(error),
        code: error?.code || 'webgpu_request_failed',
        recovery: error?.code === 'vision_inference_timeout' ? 'cancellation_requested' : undefined,
      });
    }
  })();
  return true;
});
