/**
 * WebGPU Provider — Firefox stub.
 *
 * The Chrome version (src/chrome/src/providers/webgpu.js) runs Qwen 3
 * 0.6B locally via @huggingface/transformers in the offscreen document.
 * Firefox doesn't have `browser.offscreen` and its WebGPU exposure to
 * extension contexts is its own can of worms (gated behind a pref on
 * release builds at the time of writing). Rather than ship a half-
 * working implementation, this stub fails fast with a clear message
 * and we keep the config entry in place purely so the categorization
 * parity test stays green between chrome and firefox.
 *
 * When we're ready: wire a Firefox sidebar / extension page as the
 * inference host, mirror the offscreen message handlers, swap this
 * class body for the chrome implementation, and remove this notice.
 */

import { BaseLLMProvider } from './base.js';

const NOT_YET = 'WebGPU provider is not yet supported on Firefox. ' +
  'Use the Chrome build for now, or pick a different provider in Settings.';

export class WebGPUProvider extends BaseLLMProvider {
  constructor(config = {}) {
    super(config);
    this.model = config.model || 'onnx-community/gemma-4-E2B-it-ONNX';
  }

  get name() { return 'webgpu'; }
  get supportsTools() { return true; }
  get supportsVision() { return !!this.config.supportsVision; }
  get useCompactPrompt() { return this.config.useCompactPrompt !== false; }

  async chat() { throw new Error(NOT_YET); }
  async *chatStream() { throw new Error(NOT_YET); }
  async testConnection() { return { ok: false, error: NOT_YET }; }
  async clearCache() { return { ok: false, error: NOT_YET }; }
}
