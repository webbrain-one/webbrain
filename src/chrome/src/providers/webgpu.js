/**
 * WebGPU Provider — runs Qwen / similar small models entirely in the
 * browser via WebGPU + ONNX (@huggingface/transformers).
 *
 * Why this exists: the other "local" providers (llama.cpp, ollama, lmstudio)
 * still require the user to install + run a separate server. This one needs
 * nothing — model weights download from HuggingFace on first use, cached in
 * IndexedDB by transformers.js, and inference runs on the user's GPU through
 * the extension's offscreen document.
 *
 * Architecture:
 *   service worker (background)
 *      └─ WebGPUProvider.chat() ──┐
 *                                  ▼ chrome.runtime.sendMessage
 *   offscreen document            ──┐
 *      └─ @huggingface/transformers │
 *         pipeline('text-generation', model, { device: 'webgpu' })
 *         (loaded lazily on first chat call)
 *
 * The offscreen document is required because service workers don't have
 * WebGPU access (or DOM, or IndexedDB the way transformers.js wants it).
 * Webbrain already uses an offscreen doc for the local-network fetch proxy
 * — we reuse the same document and add a new message handler there.
 *
 * Tool use: Qwen 3 supports structured tool calls via its ChatML template,
 * but at 0.6B params reliability is mixed. supportsTools = true, but the
 * settings UI nudges users toward Ask mode for this provider; Act mode is
 * available with a "small model, expect breakage" hint.
 *
 * First-run cost: ~500MB download (q4f16 quant of Qwen3-0.6B). Cached in
 * IndexedDB by transformers.js so subsequent runs are instant.
 *
 * Library vendoring: the @huggingface/transformers ESM build is large (~5MB
 * + a ~30MB onnxruntime-web WASM blob) — too big to commit. See
 * src/chrome/vendor/transformers/README.md for how to drop the file in.
 * The provider returns a clear error when the library is missing.
 */

import { BaseLLMProvider } from './base.js';

export class WebGPUProvider extends BaseLLMProvider {
  constructor(config = {}) {
    super(config);
    this.model = config.model || 'onnx-community/Qwen3-0.6B-ONNX';
    // dtype: 'q4f16' = 4-bit weights + fp16 activations. Plain 'q4' uses
    // fp32 activations, whose intermediate buffers blow past the WASM
    // 2GB heap mid-inference (std::bad_alloc out of OrtRun). 'q4f16' is
    // also the dtype the transformers.js team recommends for Qwen 3 on
    // WebGPU. Override via config.dtype if you want fp16/int8/etc.
    this.dtype = config.dtype || 'q4f16';
    // device:'webgpu' is the default; setting it explicitly here lets us
    // override to 'wasm' in tests or as a fallback when WebGPU is absent.
    this.device = config.device || 'webgpu';
  }

  get name() {
    return 'webgpu';
  }

  get supportsTools() {
    // Qwen 3 has a tool-call template. Reliability at 0.6B is best-effort —
    // see the settings UI hint that nudges users toward Ask mode.
    return true;
  }

  get supportsVision() {
    // Qwen 3 0.6B is text-only. If we add a Qwen-VL or Gemma-3n entry later,
    // that provider config can opt-in via the same shape used elsewhere.
    return !!this.config.supportsVision;
  }

  get useCompactPrompt() {
    // Default ON for this provider — 0.6B context budget is tight and the
    // compact prompt is exactly the workload it was written for.
    return this.config.useCompactPrompt !== false;
  }

  async chat(messages, options = {}) {
    const res = await this._dispatch({
      type: 'webgpu-chat',
      model: this.model,
      dtype: this.dtype,
      device: this.device,
      messages,
      options: {
        temperature: options.temperature,
        maxTokens: options.maxTokens,
        tools: options.tools || null,
        toolChoice: options.toolChoice || 'auto',
      },
    });
    if (!res || res.error) {
      throw new Error(`webgpu: ${res?.error || 'no response from offscreen document'}`);
    }
    return {
      content: res.content || '',
      toolCalls: res.toolCalls || null,
      usage: res.usage || null,
      raw: res.raw || null,
    };
  }

  async *chatStream(messages, options = {}) {
    // v1: no true token streaming. The 0.6B model finishes a normal turn
    // in a couple of seconds on most laptops; the round-trip-and-yield
    // simplification lets us ship the provider without first solving the
    // background↔offscreen chunked-message router. Upgrade target: when
    // somebody asks for it, swap this for a streamId-based subscription
    // that forwards transformers.js `streamer` callbacks back to the SW.
    const result = await this.chat(messages, options);
    if (result.toolCalls && result.toolCalls.length > 0) {
      // Convention shared with openai.js / llamacpp.js: when a chunk has
      // type:'tool_call', `content` IS the tool_calls array (not text).
      // processMessageStream() in agent.js reads chunk.content for tool
      // deltas — yielding text in `content` here would drop the tool call.
      yield { type: 'tool_call', content: result.toolCalls };
    } else {
      yield { type: 'text', content: result.content };
    }
    yield { type: 'done', usage: result.usage };
  }

  async testConnection() {
    // Don't trigger a full model load just to test — that's 500MB and
    // tens of seconds. Instead, just verify the offscreen document is
    // reachable and the library is vendored.
    try {
      const res = await this._dispatch({ type: 'webgpu-probe' });
      if (!res || res.error) {
        return { ok: false, error: res?.error || 'offscreen probe failed' };
      }
      // Surface the "software WebGPU adapter" case as a failed
      // testConnection — running a sub-1B model on SwiftShader / Lavapipe
      // OOMs the WASM heap before generating a single token. Better to
      // warn here than to silently waste a 500MB download.
      if (res.hasWebGPU === false) {
        return {
          ok: false,
          error: 'WebGPU not available in this browser. Open chrome://gpu and ' +
            'check the "WebGPU" row — if it says Disabled or Software only, ' +
            'this provider can\'t run on this machine.',
        };
      }
      if (res.isFallbackAdapter === true) {
        return {
          ok: false,
          error: 'WebGPU is using a software fallback adapter (SwiftShader / ' +
            'Lavapipe). Inference will exhaust the WASM heap. Enable hardware ' +
            'WebGPU at chrome://flags/#enable-unsafe-webgpu, or run on a ' +
            'machine with a supported GPU.',
        };
      }
      return {
        ok: true,
        model: this.model,
        device: res.device || this.device,
        libraryVersion: res.libraryVersion || null,
        adapterFeatures: res.adapterFeatures || null,
      };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  /**
   * Send a message to the offscreen document and await its reply.
   * Lazily creates the offscreen doc if it doesn't exist yet — same
   * pattern as fetch-with-fallback.js.
   */
  async _dispatch(msg) {
    await ensureOffscreen();
    return new Promise((resolve, reject) => {
      try {
        chrome.runtime.sendMessage(msg, (response) => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
          } else {
            resolve(response);
          }
        });
      } catch (e) {
        reject(e);
      }
    });
  }
}

// ─── Offscreen lifecycle ──────────────────────────────────────────────────
//
// Mirror of the helper in fetch-with-fallback.js, but kept local so the
// provider has no circular dep on the fetch layer. Both ultimately drive
// the same `src/offscreen/offscreen.html` document.

let _offscreenReady = false;

async function ensureOffscreen() {
  if (_offscreenReady) return;
  try {
    const existing = await chrome.offscreen.hasDocument?.();
    if (existing) {
      _offscreenReady = true;
      return;
    }
  } catch { /* hasDocument unsupported on older Chrome — fall through */ }
  try {
    await chrome.offscreen.createDocument({
      url: 'src/offscreen/offscreen.html',
      // WORKERS is the closest documented reason for "I want WebGPU + a
      // long-lived JS runtime". LOCAL_STORAGE works too and is what the
      // existing fetch path uses; we match it so we don't fight over
      // recreating the doc with a different reason.
      reasons: ['LOCAL_STORAGE'],
      justification: 'Run local LLM inference on WebGPU',
    });
    _offscreenReady = true;
  } catch (e) {
    if (e.message?.includes('already exists') || e.message?.includes('Only a single offscreen')) {
      _offscreenReady = true;
    } else {
      throw e;
    }
  }
}
