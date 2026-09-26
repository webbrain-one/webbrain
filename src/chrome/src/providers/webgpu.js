/** In-browser WebGPU providers hosted by Chrome's shared offscreen worker. */

import { BaseLLMProvider } from './base.js';
import { ensureOffscreen } from '../offscreen/ensure.js';

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
export const WEBGPU_COMPASS_TINY_XS_V3_MODEL_ID = 'webbrain-one/webbrain-compass-tiny-xs-v3-onnx';
export const WEBGPU_TEXT_UI_MODEL_IDS = Object.freeze([WEBGPU_COMPASS_TINY_V2_MODEL_ID, WEBGPU_COMPASS_TINY_XS_V3_MODEL_ID]);
export const WEBGPU_BONSAI27_MODEL_ID = 'prism-ml/Bonsai-27B-gguf';
export const WEBGPU_DTYPE = 'q4f16';
export const WEBGPU_BONSAI27_DTYPE = 'q1';
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
    id: WEBGPU_COMPASS_TINY_XS_V3_MODEL_ID,
    runtime: WEBGPU_RUNTIME_ONNX,
    label: 'Compass Tiny XS v3 (private research preview)',
    size: '3.96 GB',
    dtype: 'fp16',
    dtypeLabel: 'FP16 storage / FP32 GEMM',
    contextWindow: 4096,
    supportsVision: false,
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
export const WEBGPU_MODEL_NOT_READY_ERROR = `${WEBGPU_COMPASS_TINY_V2_MODEL_ID} is not downloaded. Open Settings > Providers > WebGPU or Apocalypse Mode > WebGPU to download it before chatting.`;
// Chrome-only selection state. Keep this separate from the synced
// `visionModel` endpoint so enabling the fallback never overwrites a user's
// remote vision credentials or sends a Chromium-only provider type to Firefox.
export const WEBGPU_VISION_ENABLED_KEY = 'webgpuVisionEnabled';
// Legacy provenance key retained only so the one-time consent migration can
// remove selections made automatically by older Apocalypse Mode builds.
export const WEBGPU_VISION_AUTO_SELECTED_KEY = 'webgpuVisionAutoSelected';
export const WEBGPU_VISION_CONSENT_VERSION_KEY = 'webgpuVisionConsentVersion';
export const WEBGPU_VISION_CONSENT_VERSION = 2;
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
  if (!model) return WEBGPU_COMPASS_TINY_V2_MODEL_ID;
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

class WebGPUOffscreenProvider extends BaseLLMProvider {
  async _dispatch(message, { timeoutMs = 0 } = {}) {
    await ensureOffscreen();
    return await new Promise((resolve, reject) => {
      let settled = false;
      const finish = (callback, value) => {
        if (settled) return;
        settled = true;
        if (timeoutId) clearTimeout(timeoutId);
        callback(value);
      };
      const timeoutId = timeoutMs > 0
        ? setTimeout(() => {
          const error = new Error(`In-browser WebGPU request timed out after ${timeoutMs}ms (${message?.type || 'unknown'}).`);
          error.code = 'webgpu_request_timeout';
          finish(reject, error);
        }, timeoutMs)
        : null;
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
      ...(model === WEBGPU_COMPASS_TINY_XS_V3_MODEL_ID ? { contextWindow: Math.min(4096, Math.max(1024, Number(config.contextWindow) || 4096)) } : {}),
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

  get maxOutputTokens() {
    return this.model === WEBGPU_COMPASS_TINY_XS_V3_MODEL_ID
      ? Math.min(2048, super.maxOutputTokens) : super.maxOutputTokens;
  }

  get supportsVision() {
    return webgpuModelSupportsVision(this.model);
  }

  async chat(messages, options = {}) {
    if (this._messagesContainImage(messages) && !this.supportsVision) {
      throw new Error('The WebGPU chat model is text-only. Configure a separate model under Settings -> Multimodal for screenshots.');
    }
    const download = await this.downloadStatus();
    if (!download.ready) {
      throw new Error(`${webgpuModelDisplayName(this.model)} is not downloaded. Open Settings > Providers > WebGPU or Apocalypse Mode > WebGPU to download it before chatting.`);
    }
    const response = await this._dispatch({
      type: 'webgpu-chat',
      model: this.model,
      runtime: webgpuModelRuntime(this.model),
      device: this.device,
      dtype: this.dtype,
      requireTools: this.requiresToolTemplate,
      messages: this._chatMessages(messages, options),
      options: {
        maxTokens: options.maxTokens,
        tools: Array.isArray(options.tools) ? options.tools : [],
      },
    });
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
      usage: response.usage || null,
      raw: response.raw || null,
    };
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
      // Download credential only; never attach it to a chat request.
      ...(target.model === WEBGPU_COMPASS_TINY_XS_V3_MODEL_ID ? { hfToken: String(this.config.hfToken || '') } : {}),
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
      const error = new Error('The local Vision Model is disabled. Enable it explicitly in Settings before using screenshots.');
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
