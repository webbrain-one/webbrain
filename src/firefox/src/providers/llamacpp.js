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

  get supportsTools() {
    return true; // llama.cpp server supports function calling
  }

  get supportsVision() {
    return !!this.config.supportsVision;
  }

  get useCompactPrompt() {
    return !!this.config.useCompactPrompt;
  }

  async chat(messages, options = {}) {
    const body = {
      messages,
      temperature: options.temperature ?? 0.7,
      max_tokens: options.maxTokens ?? 4096,
      stream: false,
    };

    if (this.model) {
      body.model = this.model;
    }

    if (options.tools && options.tools.length > 0) {
      body.tools = options.tools;
      body.tool_choice = options.toolChoice || 'auto';
    }

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
      toolCalls: message?.tool_calls || null,
      usage: data.usage || null,
      raw: data,
    };
  }

  async *chatStream(messages, options = {}) {
    const body = {
      messages,
      temperature: options.temperature ?? 0.7,
      max_tokens: options.maxTokens ?? 4096,
      stream: true,
    };

    if (this.model) {
      body.model = this.model;
    }

    if (options.tools && options.tools.length > 0) {
      body.tools = options.tools;
      body.tool_choice = options.toolChoice || 'auto';
    }

    const streamUrl = `${this.baseUrl}/v1/chat/completions`;
    let res;
    try {
      res = await fetchWithTimeout(streamUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    } catch (e) {
      throw new Error(`llama.cpp network error — could not reach ${streamUrl} (${e.message}). Is the server running?`);
    }

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`llama.cpp stream error ${res.status}: ${err}`);
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
        if (payload === '[DONE]') {
          yield { type: 'done', content: '' };
          return;
        }
        try {
          const json = JSON.parse(payload);
          const delta = json.choices?.[0]?.delta;
          if (delta?.content) {
            yield { type: 'text', content: delta.content };
          }
          if (delta?.tool_calls) {
            yield { type: 'tool_call', content: delta.tool_calls };
          }
        } catch (e) {
          console.warn('[llama.cpp] malformed SSE chunk skipped:', payload?.slice(0, 120), e?.message);
        }
      }
    }
    yield { type: 'done', content: '' };
  }
}
