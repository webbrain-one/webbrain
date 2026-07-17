import { inferContextWindow } from './context-windows.js';
import {
  addConfiguredMaxTokens,
  mapProviderMessages,
  mergeProviderRequestBody,
} from './provider-compatibility.js';

/**
 * Base LLM Provider — all providers implement this interface.
 */
export class BaseLLMProvider {
  constructor(config = {}) {
    this.config = config;
  }

  get name() {
    return 'base';
  }

  /**
   * Send a chat completion request.
   * @param {Array<{role: string, content: string}>} messages
   * @param {Object} options - { tools, temperature, maxTokens, stream }
   * @returns {Promise<{content: string, reasoningContent?: string, toolCalls: Array|null, usage: Object|null}>}
   */
  async chat(messages, options = {}) {
    throw new Error('chat() not implemented');
  }

  /**
   * Stream a chat completion request.
   * @param {Array<{role: string, content: string}>} messages
   * @param {Object} options
   * @yields {{type: 'text'|'tool_call'|'done', content: string}}
   */
  async *chatStream(messages, options = {}) {
    throw new Error('chatStream() not implemented');
  }

  /**
   * Check if this provider supports tool/function calling.
   */
  get supportsTools() {
    return false;
  }

  /**
   * Check if this provider supports image inputs (vision).
   */
  get supportsVision() {
    return false;
  }

  /**
   * Check if this provider supports document inputs (e.g. PDF passthrough
   * as a {type:'document'} content block). See pdf-tools.js.
   */
  get supportsDocuments() {
    return false;
  }

  /**
   * Approximate context window (in tokens) for the active model. The agent
   * uses this to decide when to auto-compact the conversation ("Context
   * automatically compacted"): once the running input-token count crosses a
   * fraction of this window, older turns are summarized away.
   *
   * Providers can pass an exact value via `config.contextWindow` (e.g. a
   * 16k local model, or a 200k cloud model). Otherwise the default is
   * model-aware for known cloud/router models and category-aware otherwise.
   * Local backends default to a conservative 16k because the actual runtime
   * context depends on how the server/model was launched. Set
   * `config.contextWindow` in Settings (or let Test connection / Load models
   * auto-detect it) to match the server's real window.
   */
  get contextWindow() {
    const n = Number(this.config.contextWindow);
    if (Number.isFinite(n) && n > 0) return n;
    return inferContextWindow(this.config);
  }

  /**
   * Whether this provider is running a small/local model that benefits from
   * a compact system prompt. When true, the agent uses SYSTEM_PROMPT_ACT_COMPACT
   * instead of the full SYSTEM_PROMPT_ACT to save context budget.
   */
  get useCompactPrompt() {
    return !!this.config.useCompactPrompt;
  }

  _mapMessages(messages) {
    return mapProviderMessages(messages, this.config);
  }

  _supportsReasoningContentReplay(_options = {}) {
    return false;
  }

  _supportsCurrentToolReasoningReplay(_options = {}) {
    return false;
  }

  _shouldReplayReasoningContent(_message, options = {}) {
    return this._supportsReasoningContentReplay(options);
  }

  _chatMessages(messages, options = {}) {
    // Internal replay state is provider-specific. Responses output Items never
    // belong in Chat Completions, and reasoning_content is only valid for
    // providers/models whose current request supports preserved thinking.
    const sanitized = (Array.isArray(messages) ? messages : []).map((message) => {
      if (!message || typeof message !== 'object') return message;
      const hasResponseItems = Object.hasOwn(message, 'response_items');
      const hasReasoningContent = Object.hasOwn(message, 'reasoning_content');
      const hasReasoningReplay = Object.hasOwn(message, '_reasoning_replay');
      if (!hasResponseItems && !hasReasoningContent && !hasReasoningReplay) return message;
      const keepReasoningContent = hasReasoningContent
        && this._shouldReplayReasoningContent(message, options);
      const {
        response_items: _responseItems,
        reasoning_content: reasoningContent,
        _reasoning_replay: _reasoningReplay,
        ...chatMessage
      } = message;
      return keepReasoningContent
        ? { ...chatMessage, reasoning_content: reasoningContent }
        : chatMessage;
    });
    return this._mapMessages(sanitized);
  }

  _addConfiguredMaxTokens(body, options, fallback = 'max_tokens') {
    return addConfiguredMaxTokens(body, options.maxTokens ?? 4096, this.config, fallback);
  }

  _mergeConfiguredRequestBody(body, options = {}) {
    return mergeProviderRequestBody(body, this.config, options.extraBody);
  }

  /**
   * Prompt tier for this provider: 'compact' | 'mid' | 'full'. Drives both
   * which ACT system prompt and which tool set the agent uses.
   *
   * Cloud providers are always 'full' — the tier knob is a small-model
   * concern, exposed only for local and OpenRouter providers. Otherwise an
   * explicit config.promptTier wins; failing that the legacy boolean
   * useCompactPrompt maps to 'compact'; failing that local providers default
   * to 'mid' and everything else (e.g. OpenRouter) to 'full'.
   */
  get promptTier() {
    if (this.config.category === 'cloud') return 'full';
    const t = this.config.promptTier;
    if (t === 'compact' || t === 'mid' || t === 'full') return t;
    if (this.config.useCompactPrompt) return 'compact';
    return this.config.category === 'local' ? 'mid' : 'full';
  }

  /**
   * Test the connection to this provider.
   * @returns {Promise<{ok: boolean, error?: string, model?: string}>}
   */
  async testConnection() {
    try {
      const res = await this.chat([{ role: 'user', content: 'Hi' }], { maxTokens: 5 });
      return { ok: true, model: this.config.model };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }
}
