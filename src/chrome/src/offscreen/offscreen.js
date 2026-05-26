/**
 * Offscreen document — host for tasks the MV3 service worker can't do
 * itself.
 *
 *   1. `offscreen-fetch` — fetch() proxy for local network LLM servers.
 *      The SW can't always reach 192.168.* / 127.* directly due to PNA +
 *      CORS; this page context can. See providers/fetch-with-fallback.js.
 *
 *   2. `webgpu-chat` / `webgpu-probe` — runs the WebGPU + ONNX local
 *      LLM (default Qwen 3.5 0.8B) via a dedicated Web Worker spawned
 *      from this document. The Worker (inference-worker.js) owns the
 *      transformers.js pipeline; this file just proxies messages.
 *
 *      WHY a Worker: direct inference in this offscreen-doc main thread
 *      OOMs even with everything configured correctly (WebGPU EP,
 *      crossOriginIsolated, SharedArrayBuffer, asyncify wasm). Workers
 *      get their own V8 isolate with its own heap; this matches what
 *      the HuggingFace WebGPU demo space does. See the worker file's
 *      header for the full story.
 *
 *      Library is vendored under src/chrome/vendor/transformers/ — see
 *      the README there for how to drop the build in.
 */

// ─── Local-network fetch proxy ────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type !== 'offscreen-fetch') return false;

  (async () => {
    try {
      const res = await fetch(msg.url, {
        method: msg.method || 'POST',
        headers: msg.headers || {},
        body: msg.body || undefined,
      });

      if (msg.stream) {
        // For streaming, read the full body and return it
        // (offscreen can't stream back via sendResponse)
        const text = await res.text();
        sendResponse({
          ok: res.ok,
          status: res.status,
          body: text,
        });
      } else {
        const text = await res.text();
        sendResponse({
          ok: res.ok,
          status: res.status,
          body: text,
        });
      }
    } catch (e) {
      sendResponse({
        ok: false,
        status: 0,
        error: e.message,
      });
    }
  })();

  return true; // keep sendResponse channel open for async
});

// ─── WebGPU LLM inference (proxied to worker) ─────────────────────────────

let _worker = null;             // the spawned inference Worker
let _workerInitPromise = null;  // resolves once init message has acked
let _nextRequestId = 1;
const _pendingRequests = new Map(); // id → {resolve, reject}

/**
 * Lazily spawn the inference worker on the first webgpu-* message.
 * The worker URL must point at the packaged worker file — same-origin
 * to the offscreen doc, no special manifest declaration needed
 * (workers spawned from extension pages don't need
 * web_accessible_resources). type:'module' so the worker can use
 * dynamic import() to pull in the vendored transformers.js.
 *
 * Init message ships the extension-origin URLs the worker needs;
 * chrome.runtime.getURL() may not be available in all Chrome worker
 * contexts, so we compute them here once.
 */
async function ensureWorker() {
  if (_worker && _workerInitPromise) return _workerInitPromise;
  _worker = new Worker(chrome.runtime.getURL('src/offscreen/inference-worker.js'), {
    type: 'module',
  });
  _worker.addEventListener('message', onWorkerMessage);
  _worker.addEventListener('error', (e) => {
    // Worker hard-failed (parse error, unhandled throw at top level).
    // Reject every in-flight request so callers see a real error
    // instead of hanging forever.
    console.error('[webgpu] worker error', e);
    for (const { reject } of _pendingRequests.values()) {
      reject(new Error('inference worker errored: ' + (e.message || 'unknown')));
    }
    _pendingRequests.clear();
    _worker = null;
    _workerInitPromise = null;
  });
  _workerInitPromise = sendToWorker('init', {
    transformersUrl: chrome.runtime.getURL('vendor/transformers/transformers.web.js'),
    wasmMjsUrl: chrome.runtime.getURL('vendor/transformers/ort-wasm-simd-threaded.asyncify.mjs'),
    wasmUrl: chrome.runtime.getURL('vendor/transformers/ort-wasm-simd-threaded.asyncify.wasm'),
  });
  return _workerInitPromise;
}

/**
 * Send a typed message to the worker and await its `{ id, ok, ... }`
 * reply. Unsolicited messages (`{ type: 'progress', ... }`) have no
 * id and bypass this map — see onWorkerMessage.
 */
function sendToWorker(type, payload) {
  const id = _nextRequestId++;
  return new Promise((resolve, reject) => {
    _pendingRequests.set(id, { resolve, reject });
    _worker.postMessage({ id, type, payload });
  });
}

function onWorkerMessage(e) {
  const data = e.data || {};
  if (data.type === 'progress') {
    // Unsolicited progress event — relay to the side panel. Same
    // shape we used before the Worker refactor so the UI code on the
    // sidepanel side didn't have to change.
    chrome.runtime.sendMessage({
      target: 'sidepanel',
      action: 'model_download',
      modelId: data.modelId,
      status: data.status,
      file: data.file,
      loaded: data.loaded,
      total: data.total,
      progress: data.progress,
    }).catch(() => { /* no listener — fine, progress UI is best-effort */ });
    return;
  }
  const pending = _pendingRequests.get(data.id);
  if (!pending) return; // late reply after error/timeout
  _pendingRequests.delete(data.id);
  if (data.ok) pending.resolve(data);
  else pending.reject(new Error(data.error || 'worker reported error with no message'));
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type !== 'webgpu-probe') return false;
  (async () => {
    try {
      await ensureWorker();
      const res = await sendToWorker('probe', {});
      sendResponse(res);
    } catch (e) {
      sendResponse({ ok: false, error: e.message });
    }
  })();
  return true;
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type !== 'webgpu-clear-cache') return false;
  (async () => {
    try {
      await ensureWorker();
      const res = await sendToWorker('clear-cache', {});
      sendResponse(res);
    } catch (e) {
      sendResponse({ ok: false, error: e.message });
    }
  })();
  return true;
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type !== 'webgpu-chat') return false;
  (async () => {
    try {
      await ensureWorker();
      const res = await sendToWorker('chat', {
        modelId: msg.model,
        dtype: msg.dtype,
        device: msg.device,
        messages: msg.messages || [],
        options: msg.options || {},
      });
      sendResponse(res);
    } catch (e) {
      sendResponse({ ok: false, error: e.message });
    }
  })();
  return true;
});
