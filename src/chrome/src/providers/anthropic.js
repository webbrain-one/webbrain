import { BaseLLMProvider } from './base.js';
import { fetchWithFallback } from './fetch-with-fallback.js';
import {
  getClaudeAccessToken,
  refreshClaudeAccessToken,
  CLAUDE_CODE_SYSTEM_PREAMBLE,
} from './oauth-claude.js';

const ANTHROPIC_REPLAY_TYPE = 'webbrain_provider_replay';
const ANTHROPIC_REPLAY_VERSION = 1;

/**
 * Provider for Anthropic Claude API (native, not OpenAI-compatible).
 */
export class AnthropicProvider extends BaseLLMProvider {
  get name() {
    return 'anthropic';
  }

  get baseUrl() {
    return this.config.baseUrl || 'https://api.anthropic.com';
  }

  get model() {
    return this.config.model || 'claude-sonnet-5';
  }

  get supportsTools() {
    return true;
  }

  get supportsVision() {
    // All current Claude models are multimodal.
    return /claude-(?:3|4|5|sonnet-|opus-|haiku-|fable-|mythos-)/.test(this.config.model || '');
  }

  get supportsDocuments() {
    // PDF passthrough as a {type:'document'} content block — Anthropic-only.
    return true;
  }

  _messagesUrl(_stream = false) {
    return `${String(this.baseUrl).replace(/\/+$/, '')}/v1/messages`;
  }

  _prepareRequestBody(body, options = {}, _stream = false) {
    const prepared = this._mergeConfiguredRequestBody(body, options);
    const gen55 = /^claude-(?:opus|sonnet|haiku)-5[-.]5(?:$|[-_.@])/.test(String(this.model || '').toLowerCase());
    let thinkingType = prepared.thinking?.type;
    if (gen55 && ['disabled', 'enabled'].includes(thinkingType)) {
      // The 5.5 generation has mandatory adaptive thinking; effort controls its budget.
      delete prepared.thinking;
      prepared.output_config = { ...prepared.output_config, effort: 'low' };
      thinkingType = undefined;
    } else if (thinkingType === 'disabled') {
      // A per-call disable must fully replace configured adaptive/manual fields.
      prepared.thinking = { type: 'disabled' };
    } else if (thinkingType === 'adaptive') {
      delete prepared.thinking.budget_tokens;
    }

    const forcedToolChoice = ['any', 'tool'].includes(prepared.tool_choice?.type);
    if (gen55 && forcedToolChoice) {
      // The 5.5 generation accepts only auto or none tool choice.
      prepared.tool_choice = { type: 'auto' };
    } else if (thinkingType === 'enabled' && forcedToolChoice) {
      // Manual extended thinking rejects forced tool choice. Preserve the
      // agent's explicit tool contract and disable thinking for this call.
      delete prepared.thinking;
    }

    if (!this._supportsTemperatureParameter()) {
      // Current Opus/Sonnet/Haiku/Fable/Mythos models reject every non-default
      // sampling override, even when thinking is omitted or disabled.
      delete prepared.temperature;
      delete prepared.top_p;
      delete prepared.top_k;
    } else if (prepared.thinking && prepared.thinking.type !== 'disabled') {
      // Older models reject temperature/top_k while thinking is active and
      // only accept top_p in the documented 0.95..1 range.
      delete prepared.temperature;
      delete prepared.top_k;
      const topP = Number(prepared.top_p);
      if (prepared.top_p != null && (!Number.isFinite(topP) || topP < 0.95 || topP > 1)) {
        delete prepared.top_p;
      }
    }
    return prepared;
  }

  _headers() {
    return {
      'Content-Type': 'application/json',
      'x-api-key': this.config.apiKey || '',
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    };
  }

  /**
   * Convert OpenAI-style tools to Anthropic tool format.
   */
  _convertTools(tools) {
    if (!tools) return undefined;
    return tools.map(t => {
      const fn = t.function || t;
      return {
        name: fn.name,
        description: fn.description,
        input_schema: fn.parameters,
      };
    });
  }

  _convertToolChoice(toolChoice) {
    if (!toolChoice || toolChoice === 'auto') return undefined;
    if (/^claude-(?:opus|sonnet|haiku)-5[-.]5(?:$|[-_.@])/.test(String(this.model || '').toLowerCase())) {
      return { type: 'auto' };
    }
    if (toolChoice === 'required') return { type: 'any' };
    const name = toolChoice?.function?.name || toolChoice?.name;
    if (name) return { type: 'tool', name };
    if (toolChoice?.type === 'required' || toolChoice?.type === 'any') return { type: 'any' };
    return undefined;
  }

  _reasoningReplayIdentity() {
    const rawBaseUrl = String(this.baseUrl || '').trim().replace(/\/+$/, '');
    let endpoint = rawBaseUrl;
    try {
      const url = new URL(rawBaseUrl);
      url.username = '';
      url.password = '';
      url.search = '';
      url.hash = '';
      endpoint = url.toString().replace(/\/+$/, '');
    } catch {}
    return [
      String(this.name || '').trim().toLowerCase(),
      String(this.config._providerId || '').trim().toLowerCase(),
      endpoint,
      String(this.config.project || '').trim().toLowerCase(),
      String(this.config.location || '').trim().toLowerCase(),
    ].join('\n');
  }

  _isValidReplayContent(content) {
    if (!Array.isArray(content) || content.length === 0) return false;
    let hasThinking = false;
    for (const block of content) {
      if (!block || typeof block !== 'object' || typeof block.type !== 'string' || !block.type) {
        return false;
      }
      if (block.type === 'thinking') {
        if (typeof block.thinking !== 'string' || typeof block.signature !== 'string' || !block.signature) {
          return false;
        }
        hasThinking = true;
      } else if (block.type === 'redacted_thinking') {
        if (typeof block.data !== 'string' || !block.data) return false;
        hasThinking = true;
      } else if (block.type === 'text') {
        if (typeof block.text !== 'string') return false;
      } else if (block.type === 'tool_use' && (
        typeof block.id !== 'string'
        || !block.id.trim()
        || typeof block.name !== 'string'
        || !block.name.trim()
        || !block.input
        || typeof block.input !== 'object'
        || Array.isArray(block.input)
      )) {
        return false;
      }
    }
    return hasThinking;
  }

  _replayState(content) {
    if (!this._isValidReplayContent(content)) return null;
    return {
      type: ANTHROPIC_REPLAY_TYPE,
      version: ANTHROPIC_REPLAY_VERSION,
      provider: this.name,
      model: this.model,
      providerIdentity: this._reasoningReplayIdentity(),
      content,
    };
  }

  _replayContent(message) {
    const state = message?._reasoning_replay?.providerState;
    const replayToolIds = Array.isArray(state?.content)
      ? state.content.filter(block => block?.type === 'tool_use').map(block => block.id)
      : [];
    const messageToolIds = Array.isArray(message?.tool_calls)
      ? message.tool_calls.map(call => call?.id)
      : [];
    const toolCallsMatch = replayToolIds.length === messageToolIds.length
      && replayToolIds.every((id, index) => id && id === messageToolIds[index]);
    if (
      state?.type !== ANTHROPIC_REPLAY_TYPE
      || state.version !== ANTHROPIC_REPLAY_VERSION
      || String(state.provider || '').trim().toLowerCase() !== String(this.name).trim().toLowerCase()
      || String(state.model || '').trim().toLowerCase() !== String(this.model).trim().toLowerCase()
      || state.providerIdentity !== this._reasoningReplayIdentity()
      || !this._isValidReplayContent(state.content)
      || !toolCallsMatch
    ) {
      return null;
    }
    return state.content;
  }

  /**
   * Convert OpenAI-style messages to Anthropic format.
   * Extracts system message, converts tool_calls/tool results.
   */
  _convertMessages(messages) {
    let system = '';
    const converted = [];

    for (const msg of messages) {
      if (msg.role === 'system') {
        system += (system ? '\n\n' : '') + msg.content;
        continue;
      }

      const replayContent = msg.role === 'assistant' ? this._replayContent(msg) : null;
      if (replayContent) {
        // Signatures and redacted blocks are opaque. Anthropic requires the
        // complete original block sequence on subsequent tool/user turns.
        converted.push({ role: 'assistant', content: replayContent });
        continue;
      }

      if (msg.role === 'assistant' && msg.tool_calls) {
        // Convert assistant tool_calls to Anthropic content blocks
        const content = [];
        if (msg.content) {
          content.push({ type: 'text', text: msg.content });
        }
        for (const tc of msg.tool_calls) {
          // Guard the parse: a tool call whose streamed arguments were
          // truncated (max_tokens mid-call) or emitted malformed by a weak
          // model is persisted into history verbatim by the agent loop. A
          // bare JSON.parse here would throw before every subsequent
          // request, permanently poisoning the conversation. Fall back to
          // an empty input object — the tool result following this turn
          // already carries the invalid-arguments error for the model.
          let input = {};
          try {
            input = typeof tc.function.arguments === 'string'
              ? JSON.parse(tc.function.arguments)
              : (tc.function.arguments ?? {});
          } catch { input = {}; }
          content.push({
            type: 'tool_use',
            id: tc.id,
            name: tc.function.name,
            input,
          });
        }
        converted.push({ role: 'assistant', content });
        continue;
      }

      if (msg.role === 'tool') {
        // Convert tool result messages. Anthropic requires ALL tool_result
        // blocks answering one assistant turn's parallel tool_use calls to live
        // in a SINGLE user message — emitting one user message per tool result
        // produces consecutive same-role messages that the API rejects with 400.
        const block = {
          type: 'tool_result',
          tool_use_id: msg.tool_call_id,
          content: msg.content,
        };
        const prev = converted[converted.length - 1];
        if (
          prev && prev.role === 'user' && Array.isArray(prev.content) &&
          prev.content.length > 0 &&
          prev.content.every((b) => b && b.type === 'tool_result')
        ) {
          prev.content.push(block);
        } else {
          converted.push({ role: 'user', content: [block] });
        }
        continue;
      }

      // Handle array-style content (e.g. user messages with embedded images
      // from auto-screenshot mode). The agent emits OpenAI-style content
      // arrays with {type:'text'} and {type:'image_url', image_url:{url}}.
      // Translate image_url → Anthropic's image/source format.
      if (Array.isArray(msg.content)) {
        const blocks = [];
        for (const part of msg.content) {
          if (part.type === 'text') {
            blocks.push({ type: 'text', text: part.text });
          } else if (part.type === 'image_url' && part.image_url?.url) {
            const url = part.image_url.url;
            const m = /^data:([^;]+);base64,(.+)$/.exec(url);
            if (m) {
              blocks.push({
                type: 'image',
                source: { type: 'base64', media_type: m[1], data: m[2] },
              });
            }
          } else if (part.type === 'document' && part.source) {
            // Native PDF passthrough — pdf-tools.js builds these blocks in
            // exactly Anthropic's expected shape so we forward as-is.
            blocks.push(part);
          }
        }
        converted.push({ role: msg.role, content: blocks });
        continue;
      }

      converted.push({ role: msg.role, content: msg.content });
    }

    return { system, messages: converted };
  }

  _normalizeUsage(usage) {
    if (!usage || typeof usage !== 'object') return null;
    const count = (value) => {
      const number = Number(value ?? 0);
      return Number.isFinite(number) && number > 0 ? number : 0;
    };
    const input = count(usage.input_tokens ?? usage.prompt_tokens);
    const output = count(usage.output_tokens ?? usage.completion_tokens);
    const cacheRead = count(usage.cache_read_input_tokens);
    const cacheWrite = count(usage.cache_creation_input_tokens);
    const normalized = {
      prompt_tokens: input,
      completion_tokens: output,
      total_tokens: count(usage.total_tokens) || input + cacheRead + cacheWrite + output,
    };
    if (Object.hasOwn(usage, 'cache_read_input_tokens')) normalized.cache_read_input_tokens = cacheRead;
    if (Object.hasOwn(usage, 'cache_creation_input_tokens')) normalized.cache_creation_input_tokens = cacheWrite;
    if (usage.cache_creation && typeof usage.cache_creation === 'object') {
      normalized.cache_creation = { ...usage.cache_creation };
    }
    return normalized;
  }

  async chat(messages, options = {}) {
    const { system, messages: anthropicMessages } = this._convertMessages(messages);

    let body = {
      model: this.model,
      max_tokens: options.maxTokens ?? 4096,
      messages: anthropicMessages,
    };

    if (system) body.system = system;
    this._addTemperature(body, options);
    if (options.tools && options.tools.length > 0) {
      body.tools = this._convertTools(options.tools);
      const toolChoice = this._convertToolChoice(options.toolChoice);
      if (toolChoice) body.tool_choice = toolChoice;
    }
    body = this._prepareRequestBody(body, options, false);

    const res = await fetchWithFallback(this._messagesUrl(false), {
      method: 'POST',
      headers: this._headers(),
      body: JSON.stringify(body),
      signal: options.signal,
    });

    if (!res.ok) {
      let err = '';
      try { err = await this._readErrorResponse(res, 500, options); } catch (error) { this._rethrowAbortedChat(error, options); }
      throw this._httpStatusError(`Anthropic error ${res.status}: ${err}`, res.status, res.headers?.get?.('retry-after'));
    }

    let data;
    try { data = await res.json(); } catch (error) {
      this._rethrowAbortedChat(error, options);
      throw new Error('Anthropic returned invalid JSON in chat response.');
    }

    const responseContent = Array.isArray(data.content) ? data.content : [];
    let content = '';
    let reasoningContent = '';
    let toolCalls = null;

    for (const block of responseContent) {
      if (block.type === 'text') {
        content += block.text || '';
      } else if (block.type === 'thinking') {
        reasoningContent += block.thinking || '';
      } else if (block.type === 'tool_use') {
        if (!toolCalls) toolCalls = [];
        toolCalls.push({
          id: block.id || '',
          type: 'function',
          function: {
            name: block.name || '',
            arguments: JSON.stringify(block.input ?? {}),
          },
        });
      }
    }

    const replayState = this._replayState(responseContent);
    const requiresReplay = responseContent.some(block => block?.type === 'tool_use')
      && responseContent.some(block => block?.type === 'thinking' || block?.type === 'redacted_thinking');
    if (requiresReplay && !replayState) {
      throw new Error('Anthropic returned tool use with incomplete signed thinking blocks.');
    }

    return {
      content,
      reasoningContent,
      toolCalls,
      usage: this._normalizeUsage(data.usage),
      ...(replayState ? { responseItems: [replayState] } : {}),
      raw: data,
    };
  }

  async *chatStream(messages, options = {}) {
    const { system, messages: anthropicMessages } = this._convertMessages(messages);

    let body = {
      model: this.model,
      max_tokens: options.maxTokens ?? 4096,
      messages: anthropicMessages,
      stream: true,
    };

    if (system) body.system = system;
    this._addTemperature(body, options);
    if (options.tools && options.tools.length > 0) {
      body.tools = this._convertTools(options.tools);
      const toolChoice = this._convertToolChoice(options.toolChoice);
      if (toolChoice) body.tool_choice = toolChoice;
    }
    body = this._prepareRequestBody(body, options, true);

    const url = this._messagesUrl(true);
    let res;
    try {
      res = await fetchWithFallback(url, {
        method: 'POST',
        headers: this._headers(),
        body: JSON.stringify(body),
        signal: options.signal,
      });
    } catch (error) {
      this._rethrowAbortedChat(error, options);
      throw this._askStreamTransportError(
        `Anthropic network error — could not reach ${url} (${error?.message || 'request failed'}).`,
      );
    }

    if (!res.ok) {
      let err = '';
      try { err = await this._readErrorResponse(res, 500, options); } catch (error) { this._rethrowAbortedChat(error, options); }
      throw this._httpStatusError(`Anthropic stream error ${res.status}: ${err}`, res.status, res.headers?.get?.('retry-after'));
    }

    if (!res.body?.getReader) {
      throw this._askStreamTransportError('Anthropic stream returned no readable body.');
    }
    let reader;
    try {
      reader = await this._openStreamReader(res, options);
    } catch (error) {
      this._rethrowAbortedChat(error, options);
      throw this._askStreamTransportError(
        `Anthropic stream could not open its response body (${error?.message || 'reader unavailable'}).`,
      );
    }
    try {
      const decoder = new TextDecoder();
      let buffer = '';
      let sawUsage = false;
      let stopReason = '';
      const accumulatedUsage = {};
      const streamedBlocks = new Map();
      let replayValid = true;
      let sawThinking = false;
      let sawToolUse = false;
      const updateUsage = (usage) => {
        if (!usage || typeof usage !== 'object') return;
        sawUsage = true;
        for (const key of [
          'input_tokens',
          'output_tokens',
          'prompt_tokens',
          'completion_tokens',
          'cache_read_input_tokens',
          'cache_creation_input_tokens',
        ]) {
          const value = Number(usage[key] ?? 0);
          if (Number.isFinite(value) && value > Number(accumulatedUsage[key] ?? 0)) {
            accumulatedUsage[key] = value;
          }
        }
        if (usage.cache_creation && typeof usage.cache_creation === 'object') {
          const current = accumulatedUsage.cache_creation || {};
          accumulatedUsage.cache_creation = { ...current };
          for (const key of ['ephemeral_5m_input_tokens', 'ephemeral_1h_input_tokens']) {
            const value = Number(usage.cache_creation[key] ?? 0);
            if (Number.isFinite(value) && value > Number(current[key] ?? 0)) {
              accumulatedUsage.cache_creation[key] = value;
            }
          }
        }
      };
      const usageChunk = () => sawUsage ? this._normalizeUsage(accumulatedUsage) : null;

      while (true) {
        let chunk;
        try {
          chunk = await reader.read();
        } catch (error) {
          this._rethrowAbortedChat(error, options);
          const usage = usageChunk();
          if (usage) yield { type: 'usage', usage };
          throw this._askStreamTransportError(
            `Anthropic stream transport error (${error?.message || 'read failed'}).`,
          );
        }
        const { done, value } = chunk;
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || !trimmed.startsWith('data: ')) continue;
          const payload = trimmed.slice(6);
          let event;
          try {
            event = JSON.parse(payload);
          } catch (error) {
            replayValid = false;
            if (this._supportsInteractiveAskStreaming()) {
              throw this._askStreamTransportError(
                `Anthropic stream returned malformed JSON (${error?.message || 'parse failed'}).`,
              );
            }
            console.warn('[anthropic] malformed SSE chunk skipped:', payload?.slice(0, 120), error?.message);
            continue;
          }
          if (event.type === 'error') {
            const detail = event.error?.message || event.error?.type || 'The provider reported a streaming error.';
            // After the 200, Anthropic reports rate_limit_error and
            // overloaded_error only here; keep their 429/529 class.
            throw this._withProviderError(this._askStreamTerminalError(`Anthropic stream error: ${detail}`), event.error);
          }
          if (event.type === 'message_start') {
            updateUsage(event.message?.usage);
          } else if (event.type === 'message_delta') {
            updateUsage(event.usage);
            if (event.delta?.stop_reason != null) stopReason = String(event.delta.stop_reason);
          } else if (event.type === 'content_block_delta') {
            const record = streamedBlocks.get(event.index);
            const deltaType = event.delta?.type;
            if (!record || record.stopped) {
              replayValid = false;
            } else if (deltaType === 'thinking_delta' && record.block.type === 'thinking') {
              record.block.thinking += String(event.delta.thinking || '');
            } else if (deltaType === 'signature_delta' && record.block.type === 'thinking') {
              record.block.signature += String(event.delta.signature || '');
            } else if (deltaType === 'text_delta' && record.block.type === 'text') {
              record.block.text += String(event.delta.text || '');
            } else if (
              deltaType === 'citations_delta'
              && record.block.type === 'text'
              && event.delta.citation
              && typeof event.delta.citation === 'object'
            ) {
              if (!Array.isArray(record.block.citations)) record.block.citations = [];
              record.block.citations.push(JSON.parse(JSON.stringify(event.delta.citation)));
            } else if (deltaType === 'input_json_delta' && record.block.type === 'tool_use') {
              record.inputJson += String(event.delta.partial_json || '');
            } else {
              replayValid = false;
            }
            if (event.delta?.type === 'text_delta') {
              yield { type: 'text', content: event.delta.text };
            } else if (event.delta?.type === 'thinking_delta') {
              yield { type: 'reasoning', content: event.delta.thinking };
            } else if (event.delta?.type === 'input_json_delta') {
              yield { type: 'tool_call_delta', content: event.delta.partial_json };
            }
          } else if (event.type === 'content_block_start') {
            const index = event.index;
            const source = event.content_block;
            if (source?.type === 'thinking' || source?.type === 'redacted_thinking') sawThinking = true;
            if (source?.type === 'tool_use') sawToolUse = true;
            if (
              !Number.isInteger(index)
              || index !== streamedBlocks.size
              || streamedBlocks.has(index)
              || !source
              || typeof source !== 'object'
              || typeof source.type !== 'string'
              || !source.type
            ) {
              replayValid = false;
            } else {
              let block;
              try {
                block = JSON.parse(JSON.stringify(source));
              } catch {
                replayValid = false;
              }
              if (block) {
                if (block.type === 'thinking') {
                  block.thinking = typeof block.thinking === 'string' ? block.thinking : '';
                  block.signature = typeof block.signature === 'string' ? block.signature : '';
                } else if (block.type === 'text') {
                  block.text = typeof block.text === 'string' ? block.text : '';
                }
                streamedBlocks.set(index, { block, inputJson: '', stopped: false });
              }
            }
            if (event.content_block?.type === 'tool_use') {
              yield {
                type: 'tool_call_start',
                content: {
                  id: event.content_block.id || '',
                  name: event.content_block.name || '',
                },
              };
            }
          } else if (event.type === 'content_block_stop') {
            const record = streamedBlocks.get(event.index);
            if (!record || record.stopped) {
              replayValid = false;
            } else {
              record.stopped = true;
              if (record.block.type === 'tool_use' && record.inputJson) {
                try {
                  const input = JSON.parse(record.inputJson);
                  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('invalid tool input');
                  record.block.input = input;
                } catch {
                  replayValid = false;
                }
              }
            }
          } else if (event.type === 'message_stop') {
            const usage = usageChunk();
            if (usage) yield { type: 'usage', usage };
            let replayState = null;
            if (replayValid && [...streamedBlocks.values()].every(record => record.stopped)) {
              const content = [...streamedBlocks.entries()]
                .sort(([left], [right]) => left - right)
                .map(([, record]) => record.block);
              replayState = this._replayState(content);
            }
            const requiresReplay = sawThinking && sawToolUse;
            if (requiresReplay && !replayState) {
              console.warn('[anthropic] thinking+tool_use stream missing replay state; next turn will lose thinking context.');
            }
            yield {
              type: 'done',
              content: '',
              ...(stopReason ? { finishReason: stopReason } : {}),
              ...(replayState ? { responseItems: [replayState] } : {}),
            };
            return;
          }
        }
      }
      const usage = usageChunk();
      if (usage) yield { type: 'usage', usage };
      throw this._askStreamTransportError('Anthropic stream ended before the message_stop event.');
    } finally {
      reader.close();
    }
  }

  _supportsTemperatureParameter() {
    const model = String(this.model || '').toLowerCase();
    if (/^claude-opus-4-(?:[7-9]|[1-9]\d)(?:$|[-_.@])/.test(model)) return false;
    if (/^claude-(?:opus|sonnet|haiku|fable|mythos)-5(?:$|[-_.@])/.test(model)) return false;
    if (/^claude-mythos-preview(?:$|[-_.@])/.test(model)) return false;
    return true;
  }

  _addTemperature(body, options = {}) {
    if (options.temperature == null) return;
    // Anthropic rejects non-default sampling parameters on Opus 4.7+ / 4.8.
    // Omit the field entirely for those models and let the API default apply.
    if (!this._supportsTemperatureParameter()) return;
    body.temperature = options.temperature;
  }
}

/**
 * AnthropicOAuthProvider — same Anthropic Messages API, but authenticates
 * with a Claude.ai Pro/Max OAuth token instead of an API key.
 *
 * Differs from AnthropicProvider in three places:
 *   1. Auth: `Authorization: Bearer <oauth-token>` + `anthropic-beta:
 *      oauth-2025-04-20`, no `x-api-key`. Token is refreshed lazily
 *      on every chat call (and eagerly on 401 → refresh → retry once).
 *   2. System prompt: prefixed with the mandatory Claude Code preamble.
 *      Anthropic's OAuth gate flags requests that omit it. Do NOT
 *      strip the prefix.
 *   3. Connection test: posts a 1-token "ok" prompt — same as base —
 *      but a 401 here is the "user needs to sign in again" signal,
 *      which the settings UI surfaces with its own error string.
 *
 * Implementation note on retry-after-refresh: we cache the access
 * token on the instance (`this._accessToken`) before each request so
 * the inherited sync `_headers()` can read it without going async.
 * `super.chat` / `super.chatStream` use that token via _headers() and
 * the inherited body-construction logic.
 */
export class AnthropicOAuthProvider extends AnthropicProvider {
  constructor(config) {
    super(config);
    this._accessToken = null;
    this._refreshPromise = null;
  }

  get name() {
    return 'anthropic-oauth';
  }

  // OAuth tokens go through `api.anthropic.com` regardless of what the
  // user puts in baseUrl — Anthropic only honors the OAuth bearer at
  // their canonical host. We could allow a custom baseUrl for proxies
  // but that's a power-user feature and out of scope for now.
  get baseUrl() {
    return 'https://api.anthropic.com';
  }

  _headers() {
    // _accessToken is populated by _ensureFreshToken() before any
    // chat/stream call. If it's missing, we fail loudly via the
    // server's 401, which getClaudeAccessToken() will surface as
    // "Not signed in" via the message.
    return {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${this._accessToken || ''}`,
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'oauth-2025-04-20',
      // CORS opt-in. The browser would normally block direct calls to
      // api.anthropic.com from an extension origin (failing the
      // preflight); Anthropic exposes this header as the documented
      // escape hatch. Same posture the API-key path uses — it's
      // independent of the auth method, so the OAuth call needs it
      // too. Dropping this surfaces as a CORS / preflight rejection
      // even when the OAuth token itself is fine.
      'anthropic-dangerous-direct-browser-access': 'true',
    };
  }

  _convertMessages(messages) {
    const out = super._convertMessages(messages);
    // Mandatory Claude Code preamble. Stripping this triggers OAuth-gate
    // rejection — see oauth-claude.js for the rationale.
    const prefixed = out.system
      ? `${CLAUDE_CODE_SYSTEM_PREAMBLE}\n\n${out.system}`
      : CLAUDE_CODE_SYSTEM_PREAMBLE;
    return { system: prefixed, messages: out.messages };
  }

  async _ensureFreshToken() {
    // getClaudeAccessToken refreshes lazily if expiry has passed.
    this._accessToken = await getClaudeAccessToken();
  }

  async _refreshOnce() {
    if (!this._refreshPromise) {
      this._refreshPromise = refreshClaudeAccessToken().finally(() => {
        this._refreshPromise = null;
      });
    }
    return this._refreshPromise;
  }

  async chat(messages, options = {}) {
    await this._ensureFreshToken();
    try {
      return await super.chat(messages, options);
    } catch (e) {
      // Token may have been revoked / hard-expired between our cache
      // check and the request landing. One retry-after-refresh is
      // safe; further failures bubble out as auth errors.
      if (/Anthropic error 401/.test(e.message)) {
        await this._refreshOnce();
        await this._ensureFreshToken();
        return await super.chat(messages, options);
      }
      throw e;
    }
  }

  async *chatStream(messages, options = {}) {
    await this._ensureFreshToken();
    try {
      yield* super.chatStream(messages, options);
      return;
    } catch (e) {
      if (/Anthropic stream error 401/.test(e.message)) {
        await this._refreshOnce();
        await this._ensureFreshToken();
        yield* super.chatStream(messages, options);
        return;
      }
      throw e;
    }
  }
}
