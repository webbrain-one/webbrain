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
          content.push({
            type: 'tool_use',
            id: tc.id,
            name: tc.function.name,
            input: typeof tc.function.arguments === 'string'
              ? JSON.parse(tc.function.arguments)
              : tc.function.arguments,
          });
        }
        converted.push({ role: 'assistant', content });
        continue;
      }

      if (msg.role === 'tool') {
        // Convert tool result messages
        converted.push({
          role: 'user',
          content: [{
            type: 'tool_result',
            tool_use_id: msg.tool_call_id,
            content: msg.content,
          }],
        });
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

  async chat(messages, options = {}) {
    const { system, messages: anthropicMessages } = this._convertMessages(messages);

    const body = {
      model: this.model,
      max_tokens: options.maxTokens ?? 4096,
      messages: anthropicMessages,
    };

    if (system) body.system = system;
    if (options.temperature != null) body.temperature = options.temperature;
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
      usage: data.usage ? {
        prompt_tokens: data.usage.input_tokens,
        completion_tokens: data.usage.output_tokens,
        total_tokens: (data.usage.input_tokens || 0) + (data.usage.output_tokens || 0),
      } : null,
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
    if (options.temperature != null) body.temperature = options.temperature;
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
          if (event.type === 'content_block_delta') {
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
            yield { type: 'done', content: '' };
            return;
          }
        } catch (e) {
          console.warn('[anthropic] malformed SSE chunk skipped:', e?.message);
        }
      }
    }
    yield { type: 'done', content: '' };
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
