import { getRequestTimeoutMs } from './fetch-with-fallback.js';
import { inferContextWindow, resolveMaxOutputTokens } from './context-windows.js';
import { createResponseReader, readResponseText, responseAbortError } from '../network/response-body.js';
import { isRateLimitClass, rateLimitStatusOf, retryAfterMs } from './model-retry.js';
import { resolvePromptTier } from './prompt-tier.js';
import {
  addConfiguredMaxTokens,
  mapProviderMessages,
  mergeProviderRequestBody,
  openAiCompatiblePayloadError,
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

  _rethrowAbortedChat(error, options = {}) {
    if (options.signal?.aborted) throw responseAbortError(options.signal);
    if (error?.name === 'AbortError' || error?.code === 'response_body_timeout') throw error;
  }

  async _openStreamReader(response, options = {}) {
    return createResponseReader(response, {
      signal: options.signal,
      idleTimeoutMs: options.streamIdleTimeoutMs ?? await getRequestTimeoutMs(),
    });
  }

  async _readErrorResponse(response, maxBytes = 1200, options = {}) {
    const read = await readResponseText(response, {
      maxBytes,
      signal: options.signal,
      idleTimeoutMs: options.streamIdleTimeoutMs ?? await getRequestTimeoutMs(),
    });
    return read.text;
  }

  /**
   * Whether this provider's streaming protocol is complete enough for the
   * interactive Ask UI. Built-ins opt in explicitly; custom providers remain
   * non-streaming unless their config declares support.
   */
  _supportsInteractiveAskStreaming() {
    return this.config.supportsAskStreaming === true;
  }

  _askStreamTransportError(message) {
    const error = new Error(message);
    error.isAskStreamError = true;
    error.isAskStreamFallbackSafe = this._supportsInteractiveAskStreaming();
    return error;
  }

  _askStreamTerminalError(message) {
    const error = new Error(message);
    error.isAskStreamError = true;
    error.isAskStreamTerminalError = true;
    return error;
  }

  // model-retry recognizes a rate limit, and the provider's Retry-After
  // cooldown, only through these fields; a bare Error is never retried as one.
  _httpStatusError(message, status, retryAfter = null) {
    const error = new Error(message);
    error.httpStatus = status;
    if (isRateLimitClass(error)) error.retryAfterMs = retryAfterMs(retryAfter);
    return error;
  }

  // Once a provider has committed HTTP 200 (OpenRouter does so as soon as an
  // upstream accepts the request), a later 429 or Cloud upstream failure
  // arrives only as an error object in the stream or body. Keep its code and
  // rate-limit class so it is retried like the HTTP response would be.
  _withProviderError(error, providerError) {
    const code = providerError?.code;
    if (typeof code === 'string' && code) error.code = code;
    const status = rateLimitStatusOf(providerError);
    if (status) error.httpStatus = status;
    return error;
  }

  _messagesContainImage(messages) {
    return messages.some((msg) => Array.isArray(msg?.content) && msg.content.some((block) => {
      return block && (block.type === 'image_url' || block.type === 'image');
    }));
  }

  _chatCompletionMessage(payload, label = this.name) {
    const apiError = openAiCompatiblePayloadError(payload);
    if (apiError) throw this._withProviderError(new Error(`${label} error: ${apiError}`), payload.error);
    const message = payload?.choices?.[0]?.message;
    if (!message || typeof message !== 'object') {
      throw new Error(`${label} returned no completion choice.`);
    }
    return message;
  }

  /**
   * Check if this provider supports tool/function calling.
   */
  get supportsTools() {
    return false;
  }

  /**
   * Whether interactive Ask turns may use this provider's streaming method.
   * Providers must opt in explicitly; merely implementing chatStream() is not
   * enough because some adapters retain a non-streaming compatibility shim.
   */
  get supportsAskStreaming() {
    return this.config.supportsAskStreaming === true;
  }

  /**
   * Check if this provider supports image inputs (vision).
   */
  get supportsVision() {
    return false;
  }

  /** Total image blocks accepted across one request, including attachments. */
  get maxImagesPerRequest() {
    const limit = Number(this.config.maxImagesPerRequest);
    return Number.isInteger(limit) && limit > 0 ? limit : null;
  }

  _assertImageLimit(messages) {
    const limit = this.maxImagesPerRequest;
    if (!limit) return;
    const imageTypes = new Set(['image_url', 'image', 'input_image']);
    const count = (Array.isArray(messages) ? messages : []).reduce((total, message) => total
      + (Array.isArray(message?.content) ? message.content.filter(block => imageTypes.has(block?.type)).length : 0), 0);
    if (count <= limit) return;
    // Vision compacts its own frame/patch chain before building a request.
    // Attachments are user evidence: reject excess instead of silently losing it.
    const error = new Error(`${this.config.label || this.name} accepts at most ${limit} images per request; this request contains ${count}. Reduce the images in this conversation or choose a provider with a higher image limit.`);
    error.code = 'provider_image_limit';
    error.imageCount = count;
    error.maxImagesPerRequest = limit;
    throw error;
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
   * Maximum tokens requested for a normal model generation. Providers may
   * expose a larger budget in Settings; that value is clamped to the selected
   * model's known output ceiling when we have one. Legacy configurations
   * retain the historical 4k request cap.
   */
  get maxOutputTokens() {
    return resolveMaxOutputTokens(this.config);
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
    // A local relay to the cloud (WebBrain Companion, the Local
    // OpenAI-compatible Proxy) defaults to Full: see prompt-tier.js.
    return resolvePromptTier(this.config);
  }

  /**
   * Test the connection to this provider.
   * @returns {Promise<{ok: boolean, error?: string, model?: string}>}
   */
  async testConnection() {
    try {
      // Responses reasoning models (e.g. muse-spark) count reasoning + output
      // against max_output_tokens; 5 → 16 is too low and always returns
      // `incomplete (max_output_tokens)`. Use a real budget for the health
      // check when the provider routes to /responses.
      const maxTokens = typeof this._usesResponsesApi === 'function' && this._usesResponsesApi() ? 512 : 5;
      const res = await this.chat([{ role: 'user', content: 'Hi' }], { maxTokens });
      return { ok: true, model: this.config.model };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }
}
