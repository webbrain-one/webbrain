import { BaseLLMProvider } from './base.js';
import { fetchWithFallback } from './fetch-with-fallback.js';

/**
 * Provider for OpenAI-compatible APIs (ChatGPT, OpenRouter, any OpenAI-compatible endpoint).
 */
export class OpenAICompatibleProvider extends BaseLLMProvider {
  get name() {
    return this.config.providerName || 'openai';
  }

  get baseUrl() {
    return this.config.baseUrl || 'https://api.openai.com/v1';
  }

  get model() {
    return this.config.model || 'gpt-4o';
  }

  get supportsTools() {
    return true;
  }

  get supportsVision() {
    // Explicit user opt-in always wins (used by LM Studio and any custom
    // OpenAI-compatible endpoint where the loaded model varies).
    if (this.config.supportsVision != null) return !!this.config.supportsVision;
    // Otherwise sniff the model name for known vision-capable identifiers.
    const m = (this.config.model || '').toLowerCase();
    return /gpt-4o|gpt-4\.1|gpt-4-turbo|gpt-5|claude|gemini|llava|qwen.*vl|qwen2.*vl|qwen3.*vl|pixtral|llama.*vision|gemma.*vision|gemma-?[34]/.test(m);
  }

  get useCompactPrompt() {
    return !!this.config.useCompactPrompt;
  }

  _headers() {
    const headers = { 'Content-Type': 'application/json' };
    if (this.config.apiKey) {
      headers['Authorization'] = `Bearer ${this.config.apiKey}`;
    }
    // OpenRouter-specific headers
    if (this.config.providerName === 'openrouter') {
      headers['HTTP-Referer'] = this.config.siteUrl || 'https://github.com/esokullu/webbrain';
      headers['X-Title'] = 'WebBrain';
    }
    return headers;
  }

  /**
   * Newer OpenAI models (gpt-5, gpt-4.1+, o1, o3, o4) have a different API
   * contract from the gpt-4o-and-earlier line:
   *   - reject `max_tokens`, require `max_completion_tokens` instead
   *   - reject any `temperature` other than the default (1)
   * Local OpenAI-compatible servers (LM Studio) and OpenRouter still use
   * the legacy contract. Detect by model name + provider type.
   */
  _isNewOpenAIContract() {
    const m = (this.config.model || '').toLowerCase();
    if (this.config.providerName === 'lmstudio') return false;
    return /^(gpt-5|gpt-4\.1|o1|o3|o4)/.test(m);
  }

  _addMaxTokens(body, options) {
    const max = options.maxTokens ?? 4096;
    if (this._isNewOpenAIContract()) {
      body.max_completion_tokens = max;
    } else {
      body.max_tokens = max;
    }
  }

  _addTemperature(body, options) {
    // GPT-5 / o-series only accept the default temperature (1). Sending
    // anything else returns 400. Omit the field entirely so the API uses
    // its default; older models keep the explicit value.
    if (this._isNewOpenAIContract()) return;
    body.temperature = options.temperature ?? 0.7;
  }

  _formatHttpError(status, body) {
    // Ollama enforces an Origin allowlist; browser extensions hit it with a
    // moz-extension:// or chrome-extension:// origin that isn't on the
    // default list, producing a 403 with an empty body.
    if (status === 403 && this.config.providerName === 'ollama') {
      return (
        (body ? body + '\n\n' : '') +
        'Ollama rejected the extension origin. Restart Ollama with OLLAMA_ORIGINS allowing extensions, e.g.:\n' +
        '  OLLAMA_ORIGINS="*" ollama serve\n' +
        '(or OLLAMA_ORIGINS="moz-extension://*,chrome-extension://*" for a tighter allowlist).'
      );
    }
    return body;
  }

  async chat(messages, options = {}) {
    const body = {
      model: this.model,
      messages,
      stream: false,
    };
    this._addTemperature(body, options);
    this._addMaxTokens(body, options);

    if (options.tools && options.tools.length > 0) {
      body.tools = options.tools;
      body.tool_choice = options.toolChoice || 'auto';
    }

    if (options.extraBody && typeof options.extraBody === 'object') {
      Object.assign(body, options.extraBody);
    }

    const url = `${this.baseUrl}/chat/completions`;
    let res;
    try {
      res = await fetchWithFallback(url, {
        method: 'POST',
        headers: this._headers(),
        body: JSON.stringify(body),
      });
    } catch (e) {
      throw new Error(`${this.name} network error — could not reach ${url} (${e.message}). Is the server running?`);
    }

    if (!res.ok) {
      let err = '';
      try { err = (await res.text()).slice(0, 500); } catch {}
      throw new Error(`${this.name} error ${res.status}: ${this._formatHttpError(res.status, err)}`);
    }

    let data;
    try { data = await res.json(); } catch {
      throw new Error(`${this.name} returned invalid JSON in chat response.`);
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
      model: this.model,
      messages,
      stream: true,
    };
    this._addTemperature(body, options);
    this._addMaxTokens(body, options);

    if (options.tools && options.tools.length > 0) {
      body.tools = options.tools;
      body.tool_choice = options.toolChoice || 'auto';
    }

    const streamUrl = `${this.baseUrl}/chat/completions`;
    let res;
    try {
      res = await fetchWithFallback(streamUrl, {
        method: 'POST',
        headers: this._headers(),
        body: JSON.stringify(body),
      });
    } catch (e) {
      throw new Error(`${this.name} network error — could not reach ${streamUrl} (${e.message}). Is the server running?`);
    }

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`${this.name} stream error ${res.status}: ${this._formatHttpError(res.status, err)}`);
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
          console.warn(`[${this.name}] malformed SSE chunk skipped:`, payload?.slice(0, 120), e?.message);
        }
      }
    }
    yield { type: 'done', content: '' };
  }
}
