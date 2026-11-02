/** In-browser WebGPU providers hosted by Chrome's shared offscreen worker. */

import { BaseLLMProvider } from './base.js';
import { ensureOffscreen } from '../offscreen/ensure.js';
import { responseAbortError } from '../network/response-body.js';

export const WEBGPU_VISION_MODEL_ID = 'webbrain-one/webbrain-vl-2-450M-onnx';
export const WEBGPU_MODEL_ID = 'LiquidAI/LFM2.5-2.6B-ONNX';
export const WEBGPU_LFM25_MODEL_ID = WEBGPU_MODEL_ID;
export const WEBGPU_LFM25_12B_INSTRUCT_MODEL_ID = 'LiquidAI/LFM2.5-1.2B-Instruct-ONNX';
export const WEBGPU_LFM25_12B_THINKING_MODEL_ID = 'LiquidAI/LFM2.5-1.2B-Thinking-ONNX';
export const WEBGPU_LFM25_VL_16B_MODEL_ID = 'LiquidAI/LFM2.5-VL-1.6B-ONNX';
export const WEBGPU_LFM25_VL_3B_MODEL_ID = 'LiquidAI/LFM2.5-VL-3B-ONNX';
export const WEBGPU_NANBEIGE42_3B_MODEL_ID = 'Michionlion/Nanbeige4.2-3B-ONNX-WebGPU';
export const WEBGPU_MINICPM5_2B_MODEL_ID = 'RASMUS/MiniCPM5-2B-ONNX';
export const WEBGPU_COMPASS_TINY_V2_MODEL_ID = 'webbrain-one/webbrain-compass-tiny-v2.1';
// WebBrain Compass VLD: one in-browser model for chat and tool calls,
// screenshots (VL) and decisions (D), on its own ONNX Runtime port inside the
// same worker and cache. v6 2B (LFM3-VL, offscreen/compass-vld-v6-runtime.js)
// is the default; Tiny v5 (MiniCPM-V, offscreen/compass-vld-runtime.js) stays
// selectable, and keeps serving screenshots and decisions where it is the
// only Compass VLD downloaded (WEBGPU_COMPASS_VLD_MODEL_IDS).
export const WEBGPU_COMPASS_VLD_V6_MODEL_ID = 'webbrain-one/webbrain-compass-vld-v6-2b-onnx';
export const WEBGPU_COMPASS_VLD_TINY_V5_MODEL_ID = 'webbrain-one/webbrain-compass-vld-tiny-v5-onnx';
// Preference order where either build would do: the newest downloaded one.
export const WEBGPU_COMPASS_VLD_MODEL_IDS = Object.freeze([WEBGPU_COMPASS_VLD_V6_MODEL_ID, WEBGPU_COMPASS_VLD_TINY_V5_MODEL_ID]);
// The model Apocalypse Mode, the install guide and an empty WebGPU setting use.
export const WEBGPU_DEFAULT_MODEL_ID = WEBGPU_COMPASS_VLD_V6_MODEL_ID;
export const WEBGPU_BONSAI2_2B_MODEL_ID = 'danyalmalik/Ternary-Bonsai-2-2B-ONNX-WebGPU';
export const WEBGPU_BONSAI2_4B_MODEL_ID = 'Mike0021/Ternary-Bonsai-2-4B-text-ONNX';
export const WEBGPU_BONSAI2_VL_2B_MODEL_ID = 'webbrain-one/Ternary-Bonsai-2-2B-ONNX-WebGPU-Vision';
export const WEBGPU_BONSAI2_VL_4B_MODEL_ID = 'webbrain-one/Ternary-Bonsai-2-4B-ONNX-WebGPU-Vision';
export const WEBGPU_BONSAI27_MODEL_ID = 'prism-ml/Bonsai-27B-gguf';
export const WEBGPU_DTYPE = 'q4f16';
export const WEBGPU_BONSAI2_DTYPE = 'q2f16';
export const WEBGPU_BONSAI2_VL_DTYPE = Object.freeze({
  embed_tokens: 'q2f16',
  vision_encoder: 'fp16',
  decoder_model_merged: 'q2f16',
});
export const WEBGPU_BONSAI27_DTYPE = 'q1';
export const WEBGPU_COMPASS_VLD_DTYPE = Object.freeze({
  embed_tokens: 'q8f16',
  vision_encoder: 'fp16',
  decoder_model_merged: 'q8f16',
});
// The bundle's recommended build: the q8f16 decoder (q4f16 is pinned too).
export const WEBGPU_COMPASS_VLD_V6_DTYPE = Object.freeze({
  vision_encoder: 'fp16',
  decoder: 'q8f16',
});
export const WEBGPU_RUNTIME_ONNX = 'onnx';
export const WEBGPU_RUNTIME_ONNX_VL = 'onnx-vl';
export const WEBGPU_RUNTIME_BITGPU = 'bitgpu';
export const WEBGPU_LFM25_VL_16B_DTYPE = Object.freeze({
  embed_tokens: 'fp16',
  vision_encoder: 'fp16',
  decoder_model_merged: 'q4',
});
export const WEBGPU_LFM25_VL_3B_DTYPE = Object.freeze({
  embed_tokens: 'fp16',
  vision_encoder: 'fp16',
  decoder_model_merged: 'q4',
});
export const WEBGPU_MODEL_PRESETS = Object.freeze([
  Object.freeze({
    id: WEBGPU_COMPASS_VLD_V6_MODEL_ID,
    runtime: WEBGPU_RUNTIME_ONNX_VL,
    label: 'Compass VLD v6 2B',
    size: '2.4 GB',
    dtype: WEBGPU_COMPASS_VLD_V6_DTYPE,
    dtypeLabel: 'Q8/FP16',
    // LFM3-VL-2B fine-tune: 6 of its 24 layers attend over the whole context
    // (about 12 KB of FP16 KV per token), 5 over a 256-token window, and the
    // rest keep a fixed conv state.
    contextWindow: 32768,
    supportsVision: true,
  }),
  Object.freeze({
    id: WEBGPU_COMPASS_VLD_TINY_V5_MODEL_ID,
    runtime: WEBGPU_RUNTIME_ONNX_VL,
    label: 'Compass VLD Tiny v5',
    size: '2.2 GB',
    dtype: WEBGPU_COMPASS_VLD_DTYPE,
    dtypeLabel: 'Q8/FP16',
    // MiniCPM-V-4.7-1B fine-tune with a Qwen3.5-0.8B language model: its six
    // full-attention layers keep about 12 KB of FP16 KV per token, and it was
    // trained on sequences up to 32k tokens.
    contextWindow: 32768,
    supportsVision: true,
  }),
  Object.freeze({
    id: WEBGPU_LFM25_MODEL_ID,
    runtime: WEBGPU_RUNTIME_ONNX,
    label: 'Minimal text model',
    size: '1.55 GB',
    dtype: WEBGPU_DTYPE,
    dtypeLabel: WEBGPU_DTYPE,
    contextWindow: 16384,
    supportsVision: false,
  }),
  Object.freeze({
    id: WEBGPU_LFM25_12B_INSTRUCT_MODEL_ID,
    runtime: WEBGPU_RUNTIME_ONNX,
    label: 'LFM2.5-1.2B-Instruct',
    size: '760 MB',
    dtype: WEBGPU_DTYPE,
    dtypeLabel: WEBGPU_DTYPE,
    contextWindow: 16384,
    supportsVision: false,
  }),
  Object.freeze({
    id: WEBGPU_LFM25_12B_THINKING_MODEL_ID,
    runtime: WEBGPU_RUNTIME_ONNX,
    label: 'LFM2.5-1.2B-Thinking',
    size: '760 MB',
    dtype: WEBGPU_DTYPE,
    dtypeLabel: WEBGPU_DTYPE,
    contextWindow: 16384,
    supportsVision: false,
  }),
  Object.freeze({
    id: WEBGPU_LFM25_VL_16B_MODEL_ID,
    runtime: WEBGPU_RUNTIME_ONNX_VL,
    label: 'LFM2.5-VL-1.6B',
    size: '2.3 GB',
    dtype: WEBGPU_LFM25_VL_16B_DTYPE,
    dtypeLabel: 'FP16/Q4',
    contextWindow: 16384,
    supportsVision: true,
  }),
  Object.freeze({
    id: WEBGPU_LFM25_VL_3B_MODEL_ID,
    runtime: WEBGPU_RUNTIME_ONNX_VL,
    label: 'LFM2.5-VL-3B',
    size: '4.0 GB',
    dtype: WEBGPU_LFM25_VL_3B_DTYPE,
    dtypeLabel: 'FP16/Q4',
    contextWindow: 16384,
    supportsVision: true,
  }),
  Object.freeze({
    id: WEBGPU_NANBEIGE42_3B_MODEL_ID,
    runtime: WEBGPU_RUNTIME_ONNX,
    label: 'Nanbeige4.2-3B',
    size: '3.1 GB',
    dtype: WEBGPU_DTYPE,
    dtypeLabel: WEBGPU_DTYPE,
    // The 44 logical KV slots cost about 176 KB per token in FP16, so a 16k
    // window would need roughly 2.9 GB of cache on top of 3.1 GB of weights.
    contextWindow: 4096,
    supportsVision: false,
  }),
  Object.freeze({
    id: WEBGPU_MINICPM5_2B_MODEL_ID,
    runtime: WEBGPU_RUNTIME_ONNX,
    label: 'MiniCPM5-2B',
    size: '1.83 GB',
    dtype: WEBGPU_DTYPE,
    dtypeLabel: WEBGPU_DTYPE,
    // OpenBMB's base context is 131k, but the practical browser setting stays
    // at 16k like the LFM2.5 text presets: 42 GQA layers cost roughly 42 KB
    // per token in FP16, so 16k needs about 672 MB of cache on top of weights.
    contextWindow: 16384,
    supportsVision: false,
  }),
  Object.freeze({
    id: WEBGPU_COMPASS_TINY_V2_MODEL_ID,
    runtime: WEBGPU_RUNTIME_ONNX,
    label: 'Compass Tiny v2.1',
    size: '1.87 GB',
    dtype: WEBGPU_DTYPE,
    dtypeLabel: WEBGPU_DTYPE,
    // WebBrain Compass Tiny v2.1 fine-tune of MiniCPM5-2B for Compact tool
    // routing. Same 42-layer GQA shape as the base export. Default browser
    // context is 32k.
    contextWindow: 32768,
    supportsVision: false,
  }),
  Object.freeze({
    id: WEBGPU_BONSAI2_2B_MODEL_ID,
    runtime: WEBGPU_RUNTIME_ONNX,
    label: 'Ternary Bonsai 2 2B',
    size: '787 MB',
    dtype: WEBGPU_BONSAI2_DTYPE,
    dtypeLabel: WEBGPU_BONSAI2_DTYPE,
    // Bound the native 262k context for browser GPU memory. Full-attention
    // KV slots cost about 12 KB/token at 2B and 32 KB/token at 4B in FP16.
    contextWindow: 16384,
    supportsVision: false,
  }),
  Object.freeze({
    id: WEBGPU_BONSAI2_4B_MODEL_ID,
    runtime: WEBGPU_RUNTIME_ONNX,
    label: 'Ternary Bonsai 2 4B',
    size: '1.50 GB',
    dtype: WEBGPU_BONSAI2_DTYPE,
    dtypeLabel: WEBGPU_BONSAI2_DTYPE,
    contextWindow: 16384,
    supportsVision: false,
  }),
  Object.freeze({
    id: WEBGPU_BONSAI2_VL_2B_MODEL_ID,
    runtime: WEBGPU_RUNTIME_ONNX_VL,
    label: 'Ternary Bonsai 2 2B Vision',
    size: '1.45 GB',
    dtype: WEBGPU_BONSAI2_VL_DTYPE,
    dtypeLabel: 'Q2/FP16',
    contextWindow: 16384,
    supportsVision: true,
  }),
  Object.freeze({
    id: WEBGPU_BONSAI2_VL_4B_MODEL_ID,
    runtime: WEBGPU_RUNTIME_ONNX_VL,
    label: 'Ternary Bonsai 2 4B Vision',
    size: '2.15 GB',
    dtype: WEBGPU_BONSAI2_VL_DTYPE,
    dtypeLabel: 'Q2/FP16',
    contextWindow: 16384,
    supportsVision: true,
  }),
  Object.freeze({
    id: WEBGPU_BONSAI27_MODEL_ID,
    runtime: WEBGPU_RUNTIME_BITGPU,
    label: 'Basic text model',
    size: '3.8 GB',
    dtype: WEBGPU_BONSAI27_DTYPE,
    dtypeLabel: WEBGPU_BONSAI27_DTYPE,
    contextWindow: 4096,
    supportsVision: false,
  }),
]);
// Keep legacy presets loadable without offering them for new selections.
// Both Chrome pickers use this order; Firefox has no offscreen chat runtime.
// The Apocalypse Mode markup lists every preset here in the same order.
export const WEBGPU_PICKER_MODEL_IDS = Object.freeze([
  WEBGPU_COMPASS_VLD_V6_MODEL_ID,
  WEBGPU_COMPASS_VLD_TINY_V5_MODEL_ID,
  WEBGPU_COMPASS_TINY_V2_MODEL_ID,
  WEBGPU_BONSAI2_2B_MODEL_ID,
  WEBGPU_BONSAI2_4B_MODEL_ID,
  WEBGPU_BONSAI2_VL_2B_MODEL_ID,
  WEBGPU_BONSAI2_VL_4B_MODEL_ID,
]);
// Shipped and loadable, but not offered in the pickers yet. To show one again,
// remove its id here. A saved selection still loads: Settings shows it as a
// custom model, and Apocalypse Mode switches to an offered preset.
export const WEBGPU_HIDDEN_MODEL_IDS = Object.freeze([
  WEBGPU_BONSAI2_2B_MODEL_ID,
  WEBGPU_BONSAI2_4B_MODEL_ID,
  WEBGPU_BONSAI2_VL_4B_MODEL_ID,
]);
export const WEBGPU_SELECTABLE_MODEL_PRESETS = Object.freeze(WEBGPU_PICKER_MODEL_IDS
  .filter(id => !WEBGPU_HIDDEN_MODEL_IDS.includes(id))
  .map(id => WEBGPU_MODEL_PRESETS.find(preset => preset.id === id)));
// The in-browser decision model: Compass VLD v6 2B, fine-tuned on the
// decision protocol, with its probe (offscreen/compass-vld-decision-probe.js);
// Tiny v5 and its probe answer where only v5 is downloaded.
// Ternary Bonsai 2 2B Vision keeps its probe for diagnostics and tiny Ask's
// screenshot gate; agent decisions no longer route to it.
export const WEBGPU_DECISION_MODEL_ID = WEBGPU_COMPASS_VLD_V6_MODEL_ID;
export const WEBGPU_DECISION_MODEL_IDS = new Set([...WEBGPU_COMPASS_VLD_MODEL_IDS, WEBGPU_BONSAI2_VL_2B_MODEL_ID]);
export const WEBGPU_MODEL_NOT_READY_ERROR = `${WEBGPU_DEFAULT_MODEL_ID} is not downloaded. Open Providers > WebGPU or Apocalypse Mode > WebGPU to download it before chatting.`;
// Chrome-only selection state. Keep this separate from the synced
// `visionModel` endpoint so enabling the fallback never overwrites a user's
// remote vision credentials or sends a Chromium-only provider type to Firefox.
export const WEBGPU_VISION_ENABLED_KEY = 'webgpuVisionEnabled';
// Optional chrome.storage.local override for the Bonsai 2 Vision prefill slice
// (prompt tokens per GPU pass; 0 disables slicing). Smaller slices keep a GPU
// shared with the display responsive at a small throughput cost.
export const WEBGPU_PREFILL_SLICE_TOKENS_KEY = 'webgpuPrefillSliceTokens';
// Legacy provenance key retained only so the one-time consent migration can
// remove selections made automatically by older Apocalypse Mode builds.
export const WEBGPU_VISION_AUTO_SELECTED_KEY = 'webgpuVisionAutoSelected';
export const WEBGPU_VISION_CONSENT_VERSION_KEY = 'webgpuVisionConsentVersion';
export const WEBGPU_VISION_CONSENT_VERSION = 2;
// Which in-browser model reads screenshots (Chrome-local, never synced or
// exported: Firefox has no WebGPU runtime). Auto follows Compass VLD: on once
// v6 2B or Tiny v5 is downloaded, and Ternary Bonsai 2 2B Vision when only
// that is downloaded; off until then. No choice starts a download; that always takes
// a click in Providers or Apocalypse Mode.
export const WEBGPU_VISION_CHOICE_KEY = 'webgpuVisionChoice';
export const WEBGPU_VISION_CHOICE_AUTO = 'auto';
export const WEBGPU_VISION_CHOICE_COMPASS_VLD = 'compass-vld';
export const WEBGPU_VISION_CHOICE_BONSAI = 'bonsai';
export const WEBGPU_VISION_CHOICE_WEBBRAIN_VL = 'webbrain-vl';
export const WEBGPU_VISION_CHOICE_OFF = 'off';
export const WEBGPU_VISION_CHOICES = Object.freeze([
  WEBGPU_VISION_CHOICE_AUTO,
  WEBGPU_VISION_CHOICE_COMPASS_VLD,
  WEBGPU_VISION_CHOICE_BONSAI,
  WEBGPU_VISION_CHOICE_WEBBRAIN_VL,
  WEBGPU_VISION_CHOICE_OFF,
]);
// The chat-model readers see screenshots through the chat runtime, so they
// share the chat preset's download, cache and worker queue rather than having
// their own.
// Compass VLD: v6 2B, or Tiny v5 where only that is downloaded
// (webgpuCompassVldModelFor).
export const WEBGPU_VISION_COMPASS_VLD_MODEL_ID = WEBGPU_COMPASS_VLD_V6_MODEL_ID;
export const WEBGPU_VISION_BONSAI_MODEL_ID = WEBGPU_BONSAI2_VL_2B_MODEL_ID;
// The chat-model reader for each choice that has one.
export const WEBGPU_VISION_CHAT_MODEL_IDS = Object.freeze({
  [WEBGPU_VISION_CHOICE_COMPASS_VLD]: WEBGPU_VISION_COMPASS_VLD_MODEL_ID,
  [WEBGPU_VISION_CHOICE_BONSAI]: WEBGPU_VISION_BONSAI_MODEL_ID,
});

/**
 * The stored choice. Builds before the choice had one local model, so an
 * explicit, consented enable of it stays that model rather than becoming Auto.
 */
export function storedWebgpuVisionChoice(stored = {}) {
  const choice = stored?.[WEBGPU_VISION_CHOICE_KEY];
  if (WEBGPU_VISION_CHOICES.includes(choice)) return choice;
  return stored?.[WEBGPU_VISION_ENABLED_KEY] === true
    && stored?.[WEBGPU_VISION_CONSENT_VERSION_KEY] === WEBGPU_VISION_CONSENT_VERSION
    ? WEBGPU_VISION_CHOICE_WEBBRAIN_VL
    : WEBGPU_VISION_CHOICE_AUTO;
}

/**
 * The Compass VLD build to use where either would do: the newest one
 * downloaded (`ready`: the downloaded model ids), else v6 2B, the one a
 * download would fetch.
 */
export function webgpuCompassVldModelFor(ready = []) {
  const downloaded = new Set(Array.from(ready || [], id => String(id || '').trim()));
  return WEBGPU_COMPASS_VLD_MODEL_IDS.find(id => downloaded.has(id)) || WEBGPU_COMPASS_VLD_V6_MODEL_ID;
}

export function isWebgpuCompassVldModel(modelId) {
  return WEBGPU_COMPASS_VLD_MODEL_IDS.includes(String(modelId || '').trim());
}

/** The model a choice uses right now: 'compass-vld', 'bonsai', 'webbrain-vl', or null (off). */
export function resolveWebgpuVisionChoice(choice, { compassVldReady = false, bonsaiReady = false } = {}) {
  if ([WEBGPU_VISION_CHOICE_COMPASS_VLD, WEBGPU_VISION_CHOICE_BONSAI, WEBGPU_VISION_CHOICE_WEBBRAIN_VL].includes(choice)) return choice;
  if (choice !== WEBGPU_VISION_CHOICE_AUTO) return null;
  if (compassVldReady === true) return WEBGPU_VISION_CHOICE_COMPASS_VLD;
  return bonsaiReady === true ? WEBGPU_VISION_CHOICE_BONSAI : null;
}

export function webgpuVisionChoiceModelId(model) {
  return WEBGPU_VISION_CHAT_MODEL_IDS[model] || WEBGPU_VISION_MODEL_ID;
}

/** Whether a resolved choice reads screenshots through a chat preset (not the dedicated VL worker). */
export function isWebgpuChatVisionChoice(model) {
  return Object.hasOwn(WEBGPU_VISION_CHAT_MODEL_IDS, model || '');
}
export const WEBGPU_VISION_DOWNLOAD_STATE_KEY = 'webgpuVisionDownloadState';
export const WEBGPU_VISION_DOWNLOAD_STATE_MESSAGE = 'webgpu-vision-download-state';
export const WEBGPU_VISION_READY_MARKER_VERSION = 2;
export const WEBGPU_WORKER_INIT_TIMEOUT_MS = 15_000;
export const WEBGPU_VISION_INFERENCE_TIMEOUT_MS = 90_000;
export const WEBGPU_VISION_DTYPE = Object.freeze({
  embed_tokens: 'fp16',
  vision_encoder: 'fp16',
  decoder_model_merged: 'q4',
});

export function webgpuVisionReadyMarkerUrl(modelId = WEBGPU_VISION_MODEL_ID) {
  return `https://webbrain.one/.well-known/webgpu-vision-ready/v${WEBGPU_VISION_READY_MARKER_VERSION}/${encodeURIComponent(String(modelId || '').trim())}`;
}

/**
 * Probe the Transformers.js cache for a completed local vision download.
 * Presence of a leftover config/weight file is not enough: Chrome can evict
 * the large ONNX payload while leaving small artifacts. The ready marker is
 * written only after a successful preload.
 * Returns true/false when Cache Storage is readable, or null when the
 * result is unknown and stored readiness must not be downgraded.
 */
export async function hasWebgpuVisionCache(modelId = WEBGPU_VISION_MODEL_ID) {
  const normalized = String(modelId || '').trim();
  if (!normalized || typeof caches === 'undefined') return null;
  const markerUrl = webgpuVisionReadyMarkerUrl(normalized);
  try {
    for (const name of await caches.keys()) {
      if (!/transformers/i.test(name)) continue;
      const cache = await caches.open(name);
      if (await cache.match(markerUrl)) return true;
    }
    return false;
  } catch {
    return null;
  }
}

export function normalizeWebgpuModelId(value) {
  let model = String(value || '').trim();
  if (!model) return WEBGPU_DEFAULT_MODEL_ID;
  if (/^https?:\/\//i.test(model)) {
    let url;
    try {
      url = new URL(model);
    } catch {
      throw new Error('Enter a Hugging Face repository as owner/repository or a huggingface.co URL.');
    }
    if (!['huggingface.co', 'www.huggingface.co'].includes(url.hostname.toLowerCase())) {
      throw new Error('Custom WebGPU models must use a huggingface.co repository.');
    }
    const parts = url.pathname.split('/').filter(Boolean).map(part => decodeURIComponent(part));
    if (parts.length !== 2) {
      throw new Error('Use the repository URL, not a file, branch, or collection URL.');
    }
    model = parts.join('/');
  }
  model = model.replace(/^\/+|\/+$/g, '');
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/.test(model)) {
    throw new Error('Enter a Hugging Face repository as owner/repository.');
  }
  return model;
}

export function webgpuModelPreset(modelId) {
  try {
    const normalized = normalizeWebgpuModelId(modelId);
    return WEBGPU_MODEL_PRESETS.find(preset => preset.id === normalized) || null;
  } catch {
    return null;
  }
}

export function isShippedWebgpuPreset(modelId) {
  return webgpuModelPreset(modelId) != null;
}

export function isSelectableWebgpuPreset(modelId) {
  if (!String(modelId || '').trim()) return false;
  const preset = webgpuModelPreset(modelId);
  return !!preset && WEBGPU_SELECTABLE_MODEL_PRESETS.includes(preset);
}

export function webgpuModelRuntime(modelId) {
  return webgpuModelPreset(modelId)?.runtime || WEBGPU_RUNTIME_ONNX;
}

export function webgpuModelDisplayName(modelId) {
  const normalized = normalizeWebgpuModelId(modelId);
  return webgpuModelPreset(normalized)?.label || normalized;
}

export function webgpuModelDtype(modelId, fallback = WEBGPU_DTYPE) {
  const normalized = normalizeWebgpuModelId(modelId);
  return webgpuModelPreset(normalized)?.dtype || fallback;
}

export function webgpuModelSupportsVision(modelId) {
  return webgpuModelPreset(modelId)?.supportsVision === true;
}

export function webgpuModelRequiresToolTemplate(modelId) {
  const normalized = normalizeWebgpuModelId(modelId);
  return !isShippedWebgpuPreset(normalized);
}

function newWebgpuRequestKey() {
  return globalThis.crypto?.randomUUID?.()
    || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

class WebGPUOffscreenProvider extends BaseLLMProvider {
  /**
   * Send one request to the offscreen host. With a signal, an abort rejects at
   * once (the caller stops waiting) and `onAbort` tells the host to stop the work.
   */
  async _dispatch(message, { timeoutMs = 0, signal = null, onAbort = null } = {}) {
    if (signal?.aborted) throw responseAbortError(signal);
    await ensureOffscreen();
    // Starting the offscreen document can take a while; an abort that landed meanwhile
    // has no listener to fire (a listener added to an aborted signal never runs), so
    // look again before anything is sent.
    if (signal?.aborted) throw responseAbortError(signal);
    return await new Promise((resolve, reject) => {
      let settled = false;
      const finish = (callback, value) => {
        if (settled) return;
        settled = true;
        if (timeoutId) clearTimeout(timeoutId);
        signal?.removeEventListener?.('abort', abortListener);
        callback(value);
      };
      const abortListener = () => {
        try { onAbort?.(); } catch { /* the request is abandoned either way */ }
        finish(reject, responseAbortError(signal));
      };
      const timeoutId = timeoutMs > 0
        ? setTimeout(() => {
          const error = new Error(`In-browser WebGPU request timed out after ${timeoutMs}ms (${message?.type || 'unknown'}).`);
          error.code = 'webgpu_request_timeout';
          finish(reject, error);
        }, timeoutMs)
        : null;
      signal?.addEventListener?.('abort', abortListener, { once: true });
      try {
        chrome.runtime.sendMessage(message, (response) => {
          const lastError = chrome.runtime.lastError;
          if (lastError) finish(reject, new Error(lastError.message));
          else finish(resolve, response);
        });
      } catch (error) {
        finish(reject, error);
      }
    });
  }

  // Ask the offscreen host to stop a text generation nobody is waiting for any more.
  _cancelChat(requestKey) {
    try {
      chrome.runtime.sendMessage({ type: 'webgpu-chat-cancel', requestKey }, () => {
        void chrome.runtime.lastError;
      });
    } catch { /* best effort: the generation then finishes on its own */ }
  }

  async _testWebGPU() {
    try {
      const response = await this._dispatch(
        { type: 'webgpu-probe' },
        { timeoutMs: WEBGPU_WORKER_INIT_TIMEOUT_MS },
      );
      if (!response || response.error) {
        return { ok: false, error: response?.error || 'offscreen probe failed' };
      }
      if (!response.hasWebGPU) {
        return {
          ok: false,
          error: 'Hardware WebGPU is unavailable. Check chrome://gpu and enable WebGPU before using this provider.',
        };
      }
      if (response.isFallbackAdapter) {
        return {
          ok: false,
          error: 'Chrome is using a software WebGPU adapter. This provider requires a hardware WebGPU adapter.',
        };
      }
      return {
        ok: true,
        model: this.model,
        device: 'webgpu',
        libraryVersion: response.libraryVersion || null,
      };
    } catch (error) {
      return { ok: false, error: error?.message || String(error) };
    }
  }
}

/**
 * General, endpoint-free local provider. LFM2.5 text and VL checkpoints use
 * Transformers.js ONNX; Bonsai 27B uses the vendored bitgpu worker.
 */
export class WebGPUProvider extends WebGPUOffscreenProvider {
  constructor(config = {}) {
    const model = normalizeWebgpuModelId(config.model);
    const dtype = webgpuModelDtype(model, config.dtype || WEBGPU_DTYPE);
    super({
      ...config,
      type: 'webgpu',
      category: 'local',
      providerName: 'webgpu',
      label: 'WebGPU (In-browser)',
      baseUrl: '',
      model,
      device: 'webgpu',
      dtype,
      promptTier: config.promptTier || 'compact',
      supportsVision: webgpuModelSupportsVision(model),
      supportsAskStreaming: false,
    });
    this.model = model;
    this.baseUrl = '';
    this.device = 'webgpu';
    this.dtype = dtype;
    this.requiresToolTemplate = webgpuModelRequiresToolTemplate(model);
  }

  get name() {
    return 'webgpu';
  }

  get supportsTools() {
    return true;
  }

  get supportsVision() {
    return webgpuModelSupportsVision(this.model);
  }

  async chat(messages, options = {}) {
    if (options.signal?.aborted) throw responseAbortError(options.signal);
    if (this._messagesContainImage(messages) && !this.supportsVision) {
      throw new Error('The WebGPU chat model is text-only. Configure a separate model under Providers -> Vision for screenshots.');
    }
    const download = await this.downloadStatus();
    if (!download.ready) {
      throw new Error(`${webgpuModelDisplayName(this.model)} is not downloaded. Open Providers > WebGPU or Apocalypse Mode > WebGPU to download it before chatting.`);
    }
    // A caller that can abort gets a key the worker can use to interrupt this generation.
    const signal = options.signal || null;
    const requestKey = signal ? newWebgpuRequestKey() : '';
    const prefillSliceTokens = await this._prefillSliceTokens();
    const response = await this._dispatch({
      type: 'webgpu-chat',
      model: this.model,
      runtime: webgpuModelRuntime(this.model),
      device: this.device,
      dtype: this.dtype,
      requireTools: this.requiresToolTemplate,
      ...(requestKey ? { requestKey } : {}),
      messages: this._chatMessages(messages, options),
      options: {
        maxTokens: options.maxTokens,
        tools: Array.isArray(options.tools) ? options.tools : [],
        ...(prefillSliceTokens == null ? {} : { prefillSliceTokens }),
      },
    }, { signal, onAbort: requestKey ? () => this._cancelChat(requestKey) : null });
    if (!response || response.error) {
      const error = new Error(`In-browser WebGPU: ${response?.error || 'no response from the inference worker'}`);
      // A failed OrtRun leaves the WebGPU session/device in an unknown state,
      // while an exhausted generation budget is deterministic for the same
      // prompt. The generic two-second network retry only repeats either costly
      // GPU failure, so surface these terminally instead.
      if (/OrtRun|BufferManager::Download|mapAsync|GPUBuffer|device lost|used its generation budget before finishing reasoning|cannot hold Bonsai 27B/i.test(error.message)) {
        error.isAskStreamTerminalError = true;
      }
      throw error;
    }
    return {
      content: String(response.content || ''),
      reasoningContent: response.reasoningContent || null,
      toolCalls: Array.isArray(response.toolCalls) && response.toolCalls.length ? response.toolCalls : null,
      usage: null,
      raw: response.raw || null,
      // The worker has no finish reason for these models; it reports whether the
      // answer used up its token budget so callers can tell a cut-off from a finish.
      ...(typeof response.outputTruncated === 'boolean' ? { outputTruncated: response.outputTruncated } : {}),
    };
  }

  /**
   * Decision readout on the in-browser model: option probabilities from one
   * forward pass per question, in the d1 answer shape. Bonsai 2 Vision only.
   */
  async decide({ state = '', images = [], questions, temperature, promptVariant, returnHidden = false, signal } = {}) {
    if (webgpuModelRuntime(this.model) !== WEBGPU_RUNTIME_ONNX_VL || !WEBGPU_DECISION_MODEL_IDS.has(this.model)) {
      throw new Error(`${webgpuModelDisplayName(this.model)} does not support in-browser decisions.`);
    }
    const stopIfAborted = () => { if (signal?.aborted) throw signal.reason ?? new DOMException('The in-browser decision was cancelled.', 'AbortError'); };
    stopIfAborted();
    const download = await this.downloadStatus();
    if (!download.ready) {
      throw new Error(`${webgpuModelDisplayName(this.model)} is not downloaded. Open Providers > WebGPU or Apocalypse Mode > WebGPU to download it first.`);
    }
    const prefillSliceTokens = await this._prefillSliceTokens();
    stopIfAborted();
    // An abort (judge timeout, Stop) cancels the worker operation, so it does
    // not keep the model queue busy ahead of the next request.
    const decisionId = globalThis.crypto?.randomUUID?.() || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    const cancel = () => { this._dispatch({ type: 'webgpu-decide-cancel', decisionId }).catch(() => {}); };
    signal?.addEventListener?.('abort', cancel, { once: true });
    let response;
    try {
      response = await this._dispatch({
        type: 'webgpu-decide',
        decisionId,
        model: this.model,
        runtime: WEBGPU_RUNTIME_ONNX_VL,
        device: this.device,
        dtype: this.dtype,
        state,
        images,
        questions,
        ...(Number(temperature) > 0 ? { temperature: Number(temperature) } : {}),
        ...(['readout', 'strict', 'verify', 'probe', 'gate'].includes(promptVariant) ? { promptVariant } : {}),
        ...(returnHidden === true ? { returnHidden: true } : {}),
        ...(prefillSliceTokens == null ? {} : { prefillSliceTokens }),
      });
    } finally {
      signal?.removeEventListener?.('abort', cancel);
    }
    stopIfAborted();
    if (!response || response.ok === false || response.error) {
      throw new Error(`In-browser WebGPU: ${response?.error || 'no response from the inference worker'}`);
    }
    return { model: response.model, provider: 'webgpu', answers: response.answers, usage: response.usage, diagnostics: response.diagnostics };
  }

  async _prefillSliceTokens() {
    try {
      const stored = await chrome.storage.local.get(WEBGPU_PREFILL_SLICE_TOKENS_KEY);
      return stored?.[WEBGPU_PREFILL_SLICE_TOKENS_KEY] ?? null;
    } catch {
      return null;
    }
  }

  /** Probe the packaged runtime and adapter without downloading model weights. */
  async testConnection() {
    return this._testWebGPU();
  }

  async downloadStatus(options = {}) {
    const target = this._textDownloadTarget(options);
    const response = await this._dispatch({
      type: 'webgpu-download-status',
      model: target.model,
      runtime: target.runtime,
      dtype: target.dtype,
    });
    if (!response || response.error) {
      throw new Error(response?.error || 'Unable to read the WebGPU model download status.');
    }
    return response;
  }

  _textDownloadTarget(options = {}) {
    const model = String(options.model || this.model).trim() || this.model;
    return {
      model,
      runtime: webgpuModelRuntime(model),
      dtype: webgpuModelDtype(model, options.dtype || this.dtype),
      requireTools: webgpuModelRequiresToolTemplate(model),
    };
  }

  async startDownload(options = {}) {
    const target = this._textDownloadTarget(options);
    const response = await this._dispatch({
      type: 'webgpu-download-start',
      model: target.model,
      runtime: target.runtime,
      device: this.device,
      dtype: target.dtype,
      requireTools: target.requireTools,
    });
    if (!response || response.error) {
      throw new Error(response?.error || `Unable to download ${webgpuModelDisplayName(target.model)}.`);
    }
    return response;
  }

  async pauseDownload() {
    const response = await this._dispatch({ type: 'webgpu-download-pause' });
    if (!response || response.error) {
      throw new Error(response?.error || 'Unable to pause the WebGPU model download.');
    }
    return response;
  }

  async stopDownload(options = {}) {
    const target = this._textDownloadTarget(options);
    const response = await this._dispatch({
      type: 'webgpu-download-stop',
      model: target.model,
      runtime: target.runtime,
      dtype: target.dtype,
    });
    if (!response || response.error) {
      throw new Error(response?.error || 'Unable to stop the WebGPU model download.');
    }
    return response;
  }

  /** Release text-model GPU allocations while preserving the browser cache. */
  async dispose() {
    try {
      const response = await this._dispatch({ type: 'webgpu-dispose' });
      return response?.error
        ? { ok: false, error: response.error }
        : { ok: true, disposed: response?.disposed !== false };
    } catch (error) {
      return { ok: false, error: error?.message || String(error) };
    }
  }
}

export class WebGPUVisionProvider extends WebGPUOffscreenProvider {
  constructor(config = {}) {
    const model = String(config.model || WEBGPU_VISION_MODEL_ID).trim();
    super({
      ...config,
      type: 'webgpu',
      category: 'local',
      providerName: 'webgpu-vision',
      label: 'In-browser vision',
      baseUrl: 'local://webgpu',
      model,
      supportsVision: true,
    });
    this.model = model;
    this.baseUrl = this.config.baseUrl;
    this.device = config.device || 'webgpu';
    this.dtype = config.dtype || WEBGPU_VISION_DTYPE;
  }

  get name() {
    return 'webgpu-vision';
  }

  get supportsVision() {
    return true;
  }

  get supportsTools() {
    return false;
  }

  async chat(messages, options = {}) {
    const stored = await chrome.storage.local.get([
      WEBGPU_VISION_ENABLED_KEY,
      WEBGPU_VISION_CONSENT_VERSION_KEY,
      WEBGPU_VISION_DOWNLOAD_STATE_KEY,
    ]);
    if (stored[WEBGPU_VISION_ENABLED_KEY] !== true
        || stored[WEBGPU_VISION_CONSENT_VERSION_KEY] !== WEBGPU_VISION_CONSENT_VERSION) {
      const error = new Error('The local Vision Model is disabled. Enable it explicitly in Providers → Vision before using screenshots.');
      error.code = 'vision_model_disabled';
      throw error;
    }
    const state = stored[WEBGPU_VISION_DOWNLOAD_STATE_KEY];
    if (state?.modelId !== this.model || state?.status !== 'ready') {
      const error = new Error(`The local Vision Model is not ready (${state?.status || 'not-downloaded'}).`);
      error.code = `vision_model_${state?.status || 'not_downloaded'}`.replace(/-/g, '_');
      error.visionStatus = state || null;
      throw error;
    }
    const response = await this._dispatch({
      type: 'webgpu-vision-chat',
      model: this.model,
      device: this.device,
      dtype: this.dtype,
      messages,
      options: {
        maxTokens: options.maxTokens,
        ...(options.webbrainVisionProbe === true ? { visionProbe: true } : {}),
      },
    }, { timeoutMs: WEBGPU_VISION_INFERENCE_TIMEOUT_MS });
    if (!response || response.error) {
      const error = new Error(`In-browser vision: ${response?.error || 'no response from the inference worker'}`);
      error.code = response?.code || 'vision_worker_error';
      error.recovery = response?.recovery || null;
      throw error;
    }
    return {
      content: String(response.content || ''),
      toolCalls: null,
      usage: null,
      raw: response.raw || null,
    };
  }

  /** Probe WebGPU and the packaged runtime without downloading model weights. */
  async testConnection() {
    return this._testWebGPU();
  }

  /** Start caching the model in the offscreen worker without waiting for the transfer. */
  async preload() {
    try {
      const response = await this._dispatch({
        type: 'webgpu-vision-preload',
        model: this.model,
        device: this.device,
        dtype: this.dtype,
      }, { timeoutMs: WEBGPU_WORKER_INIT_TIMEOUT_MS });
      return response?.error
        ? { ok: false, error: response.error }
        : { ok: true, started: response?.started !== false, ready: response?.ready === true };
    } catch (error) {
      return { ok: false, error: error?.message || String(error) };
    }
  }

  async pauseDownload() {
    try {
      const response = await this._dispatch({
        type: 'webgpu-vision-pause',
        model: this.model,
      }, { timeoutMs: WEBGPU_WORKER_INIT_TIMEOUT_MS });
      return response?.error
        ? { ok: false, error: response.error }
        : { ok: true, ...response };
    } catch (error) {
      return { ok: false, error: error?.message || String(error) };
    }
  }

  async stopDownload() {
    try {
      const response = await this._dispatch({
        type: 'webgpu-vision-stop',
        model: this.model,
        dtype: this.dtype,
      }, { timeoutMs: 45_000 });
      return response?.error
        ? { ok: false, error: response.error }
        : { ok: true, ...response };
    } catch (error) {
      return { ok: false, error: error?.message || String(error) };
    }
  }

  async clearCache() {
    return this.stopDownload();
  }

  /** Release GPU/model allocations while preserving downloaded model files. */
  async dispose() {
    try {
      const response = await this._dispatch(
        { type: 'webgpu-vision-dispose' },
        { timeoutMs: WEBGPU_WORKER_INIT_TIMEOUT_MS },
      );
      return response?.error
        ? { ok: false, error: response.error }
        : { ok: true, disposed: response?.disposed !== false };
    } catch (error) {
      return { ok: false, error: error?.message || String(error) };
    }
  }

}

/**
 * An in-browser chat preset that reads images (Compass VLD v6 2B or Tiny v5, Ternary
 * Bonsai 2 2B Vision) as the screenshot reader for a text-only active model.
 * It is the chat preset itself, so it shares that download and the worker's
 * serialized model queue: a screenshot asked for during a chat generation
 * waits its turn there, and the agent's 90 s vision deadline aborts it through
 * the same chat cancellation key. Tools are never offered; the agent only
 * wants a description back.
 */
export class WebGPUChatVisionProvider extends WebGPUProvider {
  constructor(config = {}) {
    const model = config.model || WEBGPU_VISION_COMPASS_VLD_MODEL_ID;
    super({ ...config, model });
    this.config.providerName = 'webgpu-vision';
    this.config.label = `In-browser vision (${webgpuModelDisplayName(model)})`;
  }

  get name() {
    return this.model === WEBGPU_VISION_BONSAI_MODEL_ID ? 'webgpu-vision-bonsai' : 'webgpu-vision-compass-vld';
  }

  get supportsTools() {
    return false;
  }

  get supportsVision() {
    return true;
  }

  async chat(messages, options = {}) {
    return super.chat(messages, { ...options, tools: [] });
  }
}
