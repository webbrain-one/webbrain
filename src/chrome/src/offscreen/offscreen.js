/**
 * Offscreen document — host for tasks the MV3 service worker can't do
 * itself.
 *
 *   1. `offscreen-fetch` — fetch() proxy for local network LLM servers.
 *      The SW can't always reach 192.168.* / 127.* directly due to PNA +
 *      CORS; this page context can. See providers/fetch-with-fallback.js.
 *
 *   2. `webgpu-chat` / `webgpu-probe` — runs the WebGPU + ONNX local
 *      LLM (default Qwen 3 0.6B). The SW has no WebGPU; this document
 *      does. Pipeline is loaded lazily on first chat call and cached for
 *      the document's lifetime. Library is vendored under
 *      src/chrome/vendor/transformers/ — see the README there for how
 *      to drop the build in.
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

// ─── WebGPU LLM inference ─────────────────────────────────────────────────

let _libPromise = null;        // Promise resolving to the transformers module
let _libraryVersion = null;    // for diagnostics
let _activeModelId = null;     // which model the cached pipeline is for
let _activePipeline = null;    // text-generation pipeline instance

/**
 * Lazily import the vendored @huggingface/transformers ESM build. The
 * library is large (~5MB JS + ~30MB WASM blob) so we keep it out of the
 * extension's normal load path — it only loads when the user actually
 * picks the WebGPU provider. Missing-vendor case returns a clear error
 * pointing at the vendor README.
 */
async function loadLibrary() {
  if (_libPromise) return _libPromise;
  _libPromise = (async () => {
    let lib;
    try {
      // Dynamic import so a missing file fails at runtime (with a clear
      // message) instead of at offscreen-doc parse time.
      lib = await import('../../vendor/transformers/transformers.min.js');
    } catch (e) {
      _libPromise = null; // allow retry after the user vendors the file
      throw new Error(
        'transformers.js library not vendored. See ' +
        'src/chrome/vendor/transformers/README.md for how to drop the ' +
        'build in. Underlying error: ' + (e?.message || String(e))
      );
    }
    _libraryVersion = lib.env?.version || lib.VERSION || 'unknown';
    if (lib.env) {
      // Force HF Hub for model loads (extensions can't run a side-server
      // for local model files). IndexedDB cache is on by default — that
      // gives us the "big first download, instant subsequent runs" UX.
      lib.env.allowLocalModels = false;
      lib.env.allowRemoteModels = true;
    }
    return lib;
  })();
  return _libPromise;
}

async function getPipeline(modelId, dtype, device) {
  if (_activePipeline && _activeModelId === modelId) return _activePipeline;
  const lib = await loadLibrary();
  const { pipeline } = lib;
  // Free the previous pipeline before loading a new one — two 500MB
  // models pinned in GPU memory is a recipe for OOM on integrated GPUs.
  if (_activePipeline && _activePipeline.dispose) {
    try { await _activePipeline.dispose(); } catch {}
  }
  _activePipeline = await pipeline('text-generation', modelId, {
    device: device || 'webgpu',
    dtype: dtype || 'q4',
    // Stream download progress to the side panel. Without this the UI
    // shows nothing for ~30-60s on first run while ~500MB of weights
    // pull from the HF Hub, which is indistinguishable from a hang.
    // The callback fires per file with one of:
    //   {status:'initiate', file, name}        // queued
    //   {status:'download', file, name}        // about to start
    //   {status:'progress', file, loaded, total, progress}  // bytes streaming
    //   {status:'done', file, name}            // file complete
    //   {status:'ready', model, task}          // pipeline ready
    progress_callback: (ev) => broadcastProgress(modelId, ev),
  });
  _activeModelId = modelId;
  return _activePipeline;
}

/**
 * Forward a transformers.js progress event to anyone listening (side
 * panel). The SW relays this to its open extension pages via
 * chrome.runtime.sendMessage with action='model_download'. We use a
 * "fire-and-forget, swallow rejections" pattern because no listener is
 * fine — first-run UI is a bonus, not a contract.
 *
 * Throttling: 'progress' events fire many times per second across
 * multiple files in parallel. We rate-limit to one event per file per
 * 200ms so the message channel doesn't drown in updates.
 */
const _progressLastEmitted = new Map(); // key = `${modelId}|${file}`, value = ts
function broadcastProgress(modelId, ev) {
  try {
    const file = ev?.file || ev?.name || '';
    const status = ev?.status || '';
    // Always pass through state transitions (initiate / download / done /
    // ready); rate-limit only the continuous 'progress' stream.
    if (status === 'progress') {
      const key = `${modelId}|${file}`;
      const now = Date.now();
      const last = _progressLastEmitted.get(key) || 0;
      if (now - last < 200) return;
      _progressLastEmitted.set(key, now);
    }
    chrome.runtime.sendMessage({
      target: 'sidepanel',
      action: 'model_download',
      modelId,
      status,
      file,
      loaded: ev?.loaded || 0,
      total: ev?.total || 0,
      progress: ev?.progress || 0,
    }).catch(() => { /* no listener — fine, progress UI is best-effort */ });
  } catch { /* never let a UI update break the download */ }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type !== 'webgpu-probe') return false;
  (async () => {
    try {
      // Just check the library imports and WebGPU exists — don't load
      // model weights (that's the expensive step we defer until the
      // user actually runs a chat).
      await loadLibrary();
      const hasWebGPU = typeof navigator !== 'undefined' && 'gpu' in navigator;
      sendResponse({
        ok: true,
        libraryVersion: _libraryVersion,
        device: hasWebGPU ? 'webgpu' : 'wasm',
        hasWebGPU,
      });
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
      const pipe = await getPipeline(msg.model, msg.dtype, msg.device);
      const messages = msg.messages || [];
      const opts = msg.options || {};

      // transformers.js text-generation pipelines accept a messages array
      // for ChatML-style templating. Qwen 3 ships a chat template that
      // knows about tools — passing `tools` in here makes the system
      // prompt include them, and the model emits <tool_call>{...}</tool_call>
      // blocks in its reply which we extract below.
      const generateArgs = {
        max_new_tokens: opts.maxTokens || 1024,
        temperature: opts.temperature ?? 0.7,
        do_sample: (opts.temperature ?? 0.7) > 0,
        return_full_text: false,
      };
      if (opts.tools && opts.tools.length > 0) {
        // OpenAI sends {type:'function', function:{name,description,parameters}}
        // Qwen's template wants just the inner function object.
        generateArgs.tools = opts.tools.map(t => t.function || t);
      }

      const output = await pipe(messages, generateArgs);
      const text = extractGeneratedText(output);
      const toolCalls = extractToolCalls(text);

      sendResponse({
        ok: true,
        content: toolCalls ? '' : text,
        toolCalls: toolCalls || null,
        usage: null, // transformers.js doesn't surface token counts uniformly
        raw: { rawText: text },
      });
    } catch (e) {
      sendResponse({ ok: false, error: e.message });
    }
  })();

  return true;
});

/**
 * Pull the generated text out of transformers.js's output. The pipeline
 * returns one of a few shapes depending on options — handle the common
 * ones, fall back to JSON-stringifying so we never silently drop content.
 */
function extractGeneratedText(output) {
  if (!output) return '';
  if (typeof output === 'string') return output;
  if (Array.isArray(output)) {
    const first = output[0];
    if (!first) return '';
    if (typeof first === 'string') return first;
    if (first.generated_text) {
      if (typeof first.generated_text === 'string') return first.generated_text;
      // ChatML mode: generated_text is the full messages array. Pick the
      // last assistant message.
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

/**
 * Parse Qwen-style `<tool_call>{...}</tool_call>` blocks out of the
 * model's text output and convert them to OpenAI-format tool_calls.
 * Returns null if no tool calls are found.
 *
 * Qwen 3's chat template emits one block per tool call with `name` +
 * `arguments` fields inside. The agent expects OpenAI's
 * {id, type:'function', function:{name, arguments:JSON-stringified}}
 * shape — we map between them here so the rest of the pipeline
 * (loop detector, tool dispatch) treats WebGPU exactly like any other
 * provider.
 */
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
    } catch { /* malformed tool-call block — ignore, treat as text */ }
  }
  return calls.length > 0 ? calls : null;
}
