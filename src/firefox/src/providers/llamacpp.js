import { BaseLLMProvider } from './base.js';
import { fetchWithTimeout } from './fetch-timeout.js';

/**
 * Provider for local llama.cpp server (OpenAI-compatible API on localhost).
 */
export class LlamaCppProvider extends BaseLLMProvider {
  get name() {
    return 'llama.cpp';
  }

  get baseUrl() {
    return this.config.baseUrl || 'http://localhost:8080';
  }

  get model() {
    return this.config.model || null;
  }

  get promptTier() {
    const tier = this.config.promptTier;
    if (tier === 'compact' || tier === 'mid' || tier === 'full') return tier;
    if (this.config.useCompactPrompt) return 'compact';
    return 'mid';
  }

  get supportsTools() {
    return true; // llama.cpp server supports function calling
  }

  get supportsVision() {
    return !!this.config.supportsVision;
  }

  get useCompactPrompt() {
    return !!this.config.useCompactPrompt;
  }

  _buildRequestBody(messages, options = {}, stream = false) {
    const body = {
      messages: this._chatMessages(messages),
      temperature: options.temperature ?? 0.7,
      stream,
    };
    this._addConfiguredMaxTokens(body, options, 'max_tokens');
    if (this.model) body.model = this.model;
    if (options.tools && options.tools.length > 0) {
      body.tools = options.tools;
      body.tool_choice = options.toolChoice || 'auto';
    }
    return this._mergeConfiguredRequestBody(body, options);
  }

  async chat(messages, options = {}) {
    const body = this._buildRequestBody(messages, options, false);

    const url = `${this.baseUrl}/v1/chat/completions`;
    let res;
    try {
      res = await fetchWithTimeout(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    } catch (e) {
      throw new Error(`llama.cpp network error — could not reach ${url} (${e.message}). Is the server running?`);
    }

    if (!res.ok) {
      let err = '';
      try { err = (await res.text()).slice(0, 500); } catch {}
      throw new Error(`llama.cpp error ${res.status}: ${err}`);
    }

    let data;
    try { data = await res.json(); } catch {
      throw new Error('llama.cpp returned invalid JSON in chat response.');
    }
    const choice = data.choices?.[0];
    const message = choice?.message;

    return {
      content: message?.content || '',
      reasoningContent: message?.reasoning_content || message?.reasoning || '',
      toolCalls: message?.tool_calls || null,
      usage: data.usage || null,
      raw: data,
    };
  }

  async *chatStream(messages, options = {}) {
    const body = this._buildRequestBody(messages, options, true);

    const streamUrl = `${this.baseUrl}/v1/chat/completions`;
    let res;
    try {
      res = await fetchWithTimeout(streamUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    } catch (e) {
      throw this._askStreamTransportError(
        `llama.cpp network error — could not reach ${streamUrl} (${e.message}). Is the server running?`,
      );
    }

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`llama.cpp stream error ${res.status}: ${err}`);
    }

    if (!res.body?.getReader) {
      throw this._askStreamTransportError('llama.cpp stream returned no readable body.');
    }
    let reader;
    try {
      reader = res.body.getReader();
    } catch (error) {
      throw this._askStreamTransportError(
        `llama.cpp stream could not open its response body (${error?.message || 'reader unavailable'}).`,
      );
    }
    const decoder = new TextDecoder();
    let buffer = '';
    let finalUsage = null;

    while (true) {
      let chunk;
      try {
        chunk = await reader.read();
      } catch (error) {
        if (finalUsage) yield { type: 'usage', usage: finalUsage };
        throw this._askStreamTransportError(
          `llama.cpp stream transport error (${error?.message || 'read failed'}).`,
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
        if (payload === '[DONE]') {
          if (finalUsage) yield { type: 'usage', usage: finalUsage };
          yield { type: 'done', content: '' };
          return;
        }
        let json;
        try {
          json = JSON.parse(payload);
        } catch (error) {
          if (this._supportsInteractiveAskStreaming()) {
            throw this._askStreamTransportError(
              `llama.cpp stream returned malformed JSON (${error?.message || 'parse failed'}).`,
            );
          }
          console.warn('[llama.cpp] malformed SSE chunk skipped:', payload?.slice(0, 120), error?.message);
          continue;
        }
        if (json?.error) {
          const detail = json.error?.message
            || json.error?.code
            || json.message
            || 'The provider reported a streaming error.';
          throw this._askStreamTerminalError(`llama.cpp stream error: ${detail}`);
        }
        if (json.usage) finalUsage = json.usage;
        const choice = json.choices?.[0];
        if (choice?.finish_reason === 'content_filter') {
          throw this._askStreamTerminalError('llama.cpp stream was blocked by the provider content filter.');
        }
        const delta = choice?.delta;
        const reasoningDelta = delta?.reasoning_content || delta?.reasoning;
        if (typeof reasoningDelta === 'string' && reasoningDelta) {
          yield { type: 'reasoning', content: reasoningDelta };
        }
        if (delta?.content) {
          yield { type: 'text', content: delta.content };
        }
        if (delta?.tool_calls) {
          yield { type: 'tool_call', content: delta.tool_calls };
        }
      }
    }
    if (finalUsage) yield { type: 'usage', usage: finalUsage };
    if (this._supportsInteractiveAskStreaming()) {
      throw this._askStreamTransportError('llama.cpp stream ended before the [DONE] sentinel.');
    }
    yield { type: 'done', content: '' };
  }
}
