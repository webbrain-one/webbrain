import { BaseLLMProvider } from './base.js';
import { fetchWithTimeout } from './fetch-timeout.js';
import {
  getClaudeAccessToken,
  refreshClaudeAccessToken,
  CLAUDE_CODE_SYSTEM_PREAMBLE,
} from './oauth-claude.js';

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
    return this.config.model || 'claude-sonnet-4-20250514';
  }

  get supportsTools() {
    return true;
  }

  get supportsVision() {
    return /claude-(3|sonnet-4|opus-4|haiku-4|4)/.test(this.config.model || '');
  }

  get supportsDocuments() {
    // PDF passthrough as a {type:'document'} content block — Anthropic-only.
    return true;
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
      // from auto-screenshot mode). Translate OpenAI-style image_url blocks
      // to Anthropic's image/source format.
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

    const body = {
      model: this.model,
      max_tokens: options.maxTokens ?? 4096,
      messages: anthropicMessages,
    };

    if (system) body.system = system;
    this._addTemperature(body, options);
    if (options.tools && options.tools.length > 0) {
      body.tools = this._convertTools(options.tools);
    }

    const res = await fetchWithTimeout(`${this.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: this._headers(),
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      let err = '';
      try { err = (await res.text()).slice(0, 500); } catch {}
      throw new Error(`Anthropic error ${res.status}: ${err}`);
    }

    let data;
    try { data = await res.json(); } catch {
      throw new Error('Anthropic returned invalid JSON in chat response.');
    }

    // Extract text content and tool use blocks
    let content = '';
    let toolCalls = null;

    for (const block of data.content || []) {
      if (block.type === 'text') {
        content += block.text || '';
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

    return {
      content,
      toolCalls,
      usage: this._normalizeUsage(data.usage),
      raw: data,
    };
  }

  async *chatStream(messages, options = {}) {
    const { system, messages: anthropicMessages } = this._convertMessages(messages);

    const body = {
      model: this.model,
      max_tokens: options.maxTokens ?? 4096,
      messages: anthropicMessages,
      stream: true,
    };

    if (system) body.system = system;
    this._addTemperature(body, options);
    if (options.tools && options.tools.length > 0) {
      body.tools = this._convertTools(options.tools);
    }

    const res = await fetchWithTimeout(`${this.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: this._headers(),
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      let err = '';
      try { err = (await res.text()).slice(0, 500); } catch {}
      throw new Error(`Anthropic stream error ${res.status}: ${err}`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let sawUsage = false;
    const accumulatedUsage = {};
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
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith('data: ')) continue;
        const payload = trimmed.slice(6);
        try {
          const event = JSON.parse(payload);
          if (event.type === 'message_start') {
            updateUsage(event.message?.usage);
          } else if (event.type === 'message_delta') {
            updateUsage(event.usage);
          } else if (event.type === 'content_block_delta') {
            if (event.delta?.type === 'text_delta') {
              yield { type: 'text', content: event.delta.text };
            } else if (event.delta?.type === 'input_json_delta') {
              yield { type: 'tool_call_delta', content: event.delta.partial_json };
            }
          } else if (event.type === 'content_block_start') {
            if (event.content_block?.type === 'tool_use') {
              yield {
                type: 'tool_call_start',
                content: {
                  id: event.content_block.id || '',
                  name: event.content_block.name || '',
                },
              };
            }
          } else if (event.type === 'message_stop') {
            const usage = usageChunk();
            if (usage) yield { type: 'usage', usage };
            yield { type: 'done', content: '' };
            return;
          }
        } catch (e) {
          console.warn('[anthropic] malformed SSE chunk skipped:', e?.message);
        }
      }
    }
    const usage = usageChunk();
    if (usage) yield { type: 'usage', usage };
    yield { type: 'done', content: '' };
  }

  _supportsTemperatureParameter() {
    const model = String(this.model || '').toLowerCase();
    if (/^claude-opus-4-(?:[7-9]|[1-9]\d)(?:$|[-_.])/.test(model)) return false;
    if (/^claude-(?:sonnet|fable|mythos)-5(?:$|[-_.])/.test(model)) return false;
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
 * AnthropicOAuthProvider — Anthropic Messages API authenticated with a
 * Claude.ai Pro/Max OAuth token instead of an API key.
 *
 * See `src/chrome/src/providers/anthropic.js`'s AnthropicOAuthProvider
 * for full design notes — this is the Firefox mirror with browser.* APIs.
 *
 * The mandatory Claude Code system-prompt prefix and the Bearer +
 * `anthropic-beta: oauth-2025-04-20` header swap are critical: Anthropic's
 * OAuth gate rejects requests missing either, so do NOT strip them.
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

  get baseUrl() {
    return 'https://api.anthropic.com';
  }

  _headers() {
    return {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${this._accessToken || ''}`,
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'oauth-2025-04-20',
      // CORS opt-in for browser-origin calls to api.anthropic.com —
      // independent of the auth method, so OAuth needs it too. Without
      // it the browser blocks the preflight even when the token is
      // fine. Same posture as the API-key Anthropic path.
      'anthropic-dangerous-direct-browser-access': 'true',
    };
  }

  _convertMessages(messages) {
    const out = super._convertMessages(messages);
    const prefixed = out.system
      ? `${CLAUDE_CODE_SYSTEM_PREAMBLE}\n\n${out.system}`
      : CLAUDE_CODE_SYSTEM_PREAMBLE;
    return { system: prefixed, messages: out.messages };
  }

  async _ensureFreshToken() {
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
