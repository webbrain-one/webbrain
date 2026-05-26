/**
 * WebGPU inference worker.
 *
 * Why this is a separate Worker and not inline in offscreen.js: the
 * HuggingFace transformers.js WebGPU demos all run in a dedicated
 * Worker, and when we tried running inference directly in the
 * offscreen-document main thread on an Apple M4 Max with everything
 * else configured correctly (WebGPU EP registered, crossOriginIsolated,
 * SharedArrayBuffer available, asyncify wasm, fp16 dtype) we still hit
 * `std::bad_alloc` from `OrtRun` — the same demo configuration that
 * runs fine in the HF demo space. The offscreen-doc context appears to
 * give the wasm allocator a tighter heap ceiling than a regular page.
 *
 * Workers get their own V8 isolate with its own heap budget, and the
 * wasm Memory is bound to the worker's address space. Moving the
 * pipeline + inference here matches the HF demo architecture and gives
 * us the heap headroom Qwen-class models need.
 *
 * Protocol: offscreen.js sends typed messages over postMessage with a
 * correlation `id`; this worker replies with `{ id, ok, ... }` or
 * pushes unsolicited `{ type: 'progress', ... }` events during model
 * download.
 *
 * Why not run this in a Worker spawned BY the service worker (skipping
 * the offscreen doc entirely)? Workers spawned from MV3 SWs are
 * themselves service workers (no SharedArrayBuffer, no WebGPU, the
 * very limits we already hit). Dedicated workers can only be spawned
 * from documents, so we still need the offscreen page as the parent.
 */

let _libPromise = null;        // Promise resolving to transformers module
let _libraryVersion = null;    // for diagnostics
let _activePipelineKey = null; // `${modelId}|${dtype}|${device}`
let _activePipeline = null;    // text-generation pipeline instance
let _config = null;            // { transformersUrl, wasmMjsUrl, wasmUrl } from init
let _outputLocationMode = 'auto'; // 'auto' | 'gpu-buffer'
let _runtimeDeviceMode = 'webgpu'; // 'webgpu' | 'wasm'

/**
 * Dynamic import transformers.js using the URL passed from offscreen.js.
 * The worker can't use chrome.runtime.getURL() reliably across all
 * Chrome versions, so the parent computes the extension URLs and ships
 * them in the init message.
 */
async function loadLibrary() {
  if (_libPromise) return _libPromise;
  if (!_config) throw new Error('worker not initialized — init message must arrive before any chat/probe');
  _libPromise = (async () => {
    let lib;
    try {
      lib = await import(_config.transformersUrl);
    } catch (e) {
      _libPromise = null;
      throw new Error(
        'transformers.js library not vendored. See ' +
        'src/chrome/vendor/transformers/README.md for how to drop the ' +
        'build in. Underlying error: ' + (e?.message || String(e))
      );
    }
    _libraryVersion = lib.env?.version || lib.VERSION || 'unknown';
    if (lib.env) {
      lib.env.allowLocalModels = false;
      lib.env.allowRemoteModels = true;
      // Cache API rejects chrome-extension:// URLs; we don't need the
      // wasm cache anyway since our wasm is already local.
      lib.env.useWasmCache = false;
      // Pin wasmPaths to OUR vendored asyncify variant — the one with
      // WebGPU EP bindings (webgpuInit etc.). See README troubleshooting
      // table for why .asyncify and not .jsep.
      try {
        if (lib.env.backends?.onnx?.wasm) {
          lib.env.backends.onnx.wasm.wasmPaths = {
            mjs: _config.wasmMjsUrl,
            wasm: _config.wasmUrl,
          };
        }
      } catch { /* future library shape change → fall back to defaults */ }
    }
    return lib;
  })();
  return _libPromise;
}

async function getPipeline(modelId, dtype, device, outputLocationMode = _outputLocationMode, runtimeDeviceMode = _runtimeDeviceMode) {
  // Cache key includes dtype + device so editing those in Settings
  // rebuilds the pipeline instead of silently reusing the old one.
  const effectiveDevice = runtimeDeviceMode || device || 'webgpu';
  const key = `${modelId}|${dtype || 'default'}|${effectiveDevice}|${outputLocationMode}`;
  if (_activePipeline && _activePipelineKey === key) return _activePipeline;
  const lib = await loadLibrary();
  const { pipeline } = lib;

  // Diagnostic log to the worker's console. Worker logs show up in
  // DevTools → Sources → Workers panel, or in the offscreen doc's
  // console when filtered to "verbose" + the worker context.
  try {
    const gpuAvailable = typeof navigator !== 'undefined' && 'gpu' in navigator;
    let adapterInfo = null;
    if (gpuAvailable) {
      try {
        const adapter = await navigator.gpu.requestAdapter();
        adapterInfo = adapter ? {
          isFallbackAdapter: adapter.isFallbackAdapter,
          features: [...(adapter.features || [])].slice(0, 8),
        } : null;
      } catch (e) { adapterInfo = { error: e.message }; }
    }
    console.log('[webgpu-worker] pipeline init', {
      modelId, dtype, device: effectiveDevice,
      libraryVersion: _libraryVersion,
      navigatorGpu: gpuAvailable,
      adapter: adapterInfo,
      hasWebgpuBackend: !!lib.env?.backends?.onnx?.webgpu,
      wasmPaths: lib.env?.backends?.onnx?.wasm?.wasmPaths,
      crossOriginIsolated: typeof crossOriginIsolated !== 'undefined' ? crossOriginIsolated : 'n/a',
      hasSharedArrayBuffer: typeof SharedArrayBuffer !== 'undefined',
    });
  } catch { /* logging must never break inference */ }

  // Free the previous pipeline before loading a new one — two 500MB+
  // models pinned simultaneously is a recipe for OOM on integrated GPUs.
  if (_activePipeline && _activePipeline.dispose) {
    try { await _activePipeline.dispose(); } catch {}
  }
  const pipelineOptions = {
    device: effectiveDevice,
    dtype: dtype || 'q4f16',
    progress_callback: (ev) => postProgress(modelId, ev),
  };
  if (outputLocationMode === 'gpu-buffer') {
    pipelineOptions.session_options = { preferredOutputLocation: 'gpu-buffer' };
  }
  _activePipeline = await pipeline('text-generation', modelId, pipelineOptions);
  _activePipelineKey = key;
  return _activePipeline;
}

async function disposeActivePipeline() {
  if (_activePipeline && _activePipeline.dispose) {
    try { await _activePipeline.dispose(); } catch {}
  }
  _activePipeline = null;
  _activePipelineKey = null;
}

/**
 * Forward a model-download progress event to the parent (offscreen
 * doc). 200ms-per-file throttling for the continuous 'progress'
 * stream; state transitions always pass through.
 */
const _progressLastEmitted = new Map();
function postProgress(modelId, ev) {
  try {
    const file = ev?.file || ev?.name || '';
    const status = ev?.status || '';
    if (status === 'progress') {
      const key = `${modelId}|${file}`;
      const now = Date.now();
      const last = _progressLastEmitted.get(key) || 0;
      if (now - last < 200) return;
      _progressLastEmitted.set(key, now);
    }
    self.postMessage({
      type: 'progress',
      modelId, status, file,
      loaded: ev?.loaded || 0,
      total: ev?.total || 0,
      progress: ev?.progress || 0,
    });
  } catch { /* never let a UI update break the download */ }
}

function extractGeneratedText(output) {
  if (!output) return '';
  if (typeof output === 'string') return output;
  if (Array.isArray(output)) {
    const first = output[0];
    if (!first) return '';
    if (typeof first === 'string') return first;
    if (first.generated_text) {
      if (typeof first.generated_text === 'string') return first.generated_text;
      if (Array.isArray(first.generated_text)) {
        for (let i = first.generated_text.length - 1; i >= 0; i--) {
          const m = first.generated_text[i];
          if (m?.role === 'assistant' && typeof m.content === 'string') return m.content;
        }
      }
    }
  }
  return JSON.stringify(output);
}

function extractToolCalls(text) {
  if (!text || typeof text !== 'string') return null;
  if (!text.includes('<tool_call>')) return null;
  const calls = [];
  const re = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g;
  let match;
  let idx = 0;
  while ((match = re.exec(text)) !== null) {
    try {
      const obj = JSON.parse(match[1]);
      if (obj && obj.name) {
        calls.push({
          id: `webgpu_call_${Date.now()}_${idx++}`,
          type: 'function',
          function: {
            name: obj.name,
            arguments: typeof obj.arguments === 'string'
              ? obj.arguments
              : JSON.stringify(obj.arguments || {}),
          },
        });
      }
    } catch { /* malformed tool-call block — ignore */ }
  }
  return calls.length > 0 ? calls : null;
}

// ─── Message dispatch ─────────────────────────────────────────────────────

self.addEventListener('message', async (e) => {
  const { id, type, payload } = e.data || {};

  // init: must arrive before any other message — carries the
  // extension-origin URLs the worker can't synthesize on its own.
  if (type === 'init') {
    _config = payload;
    self.postMessage({ id, ok: true });
    return;
  }

  if (type === 'probe') {
    try {
      await loadLibrary();
      const hasWebGPU = typeof navigator !== 'undefined' && 'gpu' in navigator;
      let isFallbackAdapter = null;
      let adapterFeatures = null;
      if (hasWebGPU) {
        try {
          const adapter = await navigator.gpu.requestAdapter();
          if (adapter) {
            isFallbackAdapter = adapter.isFallbackAdapter;
            adapterFeatures = [...(adapter.features || [])].slice(0, 8);
          } else {
            isFallbackAdapter = true;
          }
        } catch { /* report what we can */ }
      }
      self.postMessage({
        id, ok: true,
        libraryVersion: _libraryVersion,
        device: hasWebGPU ? 'webgpu' : 'wasm',
        hasWebGPU,
        isFallbackAdapter,
        adapterFeatures,
      });
    } catch (err) {
      self.postMessage({ id, ok: false, error: err.message });
    }
    return;
  }

  if (type === 'clear-cache') {
    try {
      await disposeActivePipeline();
      _libPromise = null;
      const deleted = [];
      for (const name of ['transformers-cache', 'experimental_transformers-hash-cache']) {
        if (await caches.delete(name)) deleted.push(name);
      }
      self.postMessage({ id, ok: true, deletedCaches: deleted });
    } catch (err) {
      self.postMessage({ id, ok: false, error: err.message });
    }
    return;
  }

  if (type === 'chat') {
    try {
      const { modelId, dtype, device, messages, options } = payload;
      let pipe;
      try {
        pipe = await getPipeline(modelId, dtype, device);
      } catch (initErr) {
        const initMsg = initErr?.message || String(initErr);
        const missingKernel = initMsg.includes('Kernel not found') || initMsg.includes('GatherBlockQuantized');
        const usingWasm = _runtimeDeviceMode === 'wasm';
        if (!missingKernel || !usingWasm) throw initErr;
        // If a previous turn switched us to wasm and this quantized model
        // can't initialize there, immediately reset back to webgpu and retry.
        _runtimeDeviceMode = 'webgpu';
        _outputLocationMode = 'auto';
        await disposeActivePipeline();
        pipe = await getPipeline(modelId, dtype, device, _outputLocationMode, _runtimeDeviceMode);
      }
      const opts = options || {};
      const generateArgs = {
        max_new_tokens: opts.maxTokens || 1024,
        temperature: opts.temperature ?? 0.7,
        do_sample: (opts.temperature ?? 0.7) > 0,
        return_full_text: false,
      };
      if (opts.tools && opts.tools.length > 0) {
        // OpenAI sends {type:'function', function:{name,...}}; Qwen's
        // template wants just the inner function object.
        generateArgs.tools = opts.tools.map(t => t.function || t);
      }
      let output;
      const runWithRetries = async () => {
        try {
          return await pipe(messages || [], generateArgs);
        } catch (err) {
          const msg = err?.message || String(err);
          const cpuError = msg.includes('The data is not on CPU');
          const mapError = msg.includes('Failed to download data from buffer') || msg.includes("Failed to execute 'mapAsync'");
          if (!cpuError && !mapError) throw err;

          // First retry: toggle output mode inside WebGPU.
          _outputLocationMode = mapError ? 'gpu-buffer' : 'auto';
          _runtimeDeviceMode = 'webgpu';
          await disposeActivePipeline();
          pipe = await getPipeline(modelId, dtype, device, _outputLocationMode, _runtimeDeviceMode);
          try {
            return await pipe(messages || [], generateArgs);
          } catch (retryErr) {
            const retryMsg = retryErr?.message || String(retryErr);
            const retryMapError = retryMsg.includes('Failed to download data from buffer') || retryMsg.includes("Failed to execute 'mapAsync'");
            if (!retryMapError) throw retryErr;

            // Second retry: WebGPU buffer is still unstable; fall back to WASM.
            _outputLocationMode = 'auto';
            _runtimeDeviceMode = 'wasm';
            await disposeActivePipeline();
            pipe = await getPipeline(modelId, dtype, device, _outputLocationMode, _runtimeDeviceMode);
            try {
              return await pipe(messages || [], generateArgs);
            } catch (wasmErr) {
              const wasmMsg = wasmErr?.message || String(wasmErr);
              const missingKernel = wasmMsg.includes('Kernel not found') || wasmMsg.includes('GatherBlockQuantized');
              if (missingKernel) {
                _runtimeDeviceMode = 'webgpu';
                await disposeActivePipeline();
                throw new Error(
                  `WASM fallback unsupported for this quantized model (${modelId}). ` +
                  `ONNX Runtime CPU/WASM is missing GatherBlockQuantized kernels. ` +
                  `Please keep device=webgpu and reduce context/tokens, or choose a WASM-compatible model. ` +
                  `Underlying error: ${wasmMsg}`
                );
              }
              throw wasmErr;
            }
          }
        }
      };
      output = await runWithRetries();
      const text = extractGeneratedText(output);
      const toolCalls = extractToolCalls(text);
      self.postMessage({
        id, ok: true,
        content: toolCalls ? '' : text,
        toolCalls: toolCalls || null,
        usage: null,
        raw: { rawText: text },
      });
    } catch (err) {
      self.postMessage({ id, ok: false, error: err.message });
    }
    return;
  }

  // Unknown message type — reply with error so callers don't hang.
  self.postMessage({ id, ok: false, error: `unknown worker message type: ${type}` });
});
