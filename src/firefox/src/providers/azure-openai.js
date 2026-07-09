import { BaseLLMProvider } from './base.js';
import { fetchWithTimeout } from './fetch-timeout.js';

/**
 * Azure OpenAI provider (deployment-based OpenAI-compatible API).
 *
 * Azure differs from the standard OpenAI contract in two key ways:
 * - The "model" is an Azure *deployment name* embedded in the URL path.
 * - Auth uses `api-key` (not `Authorization: Bearer`), and requests require
 *   an `api-version` query param.
 */
export class AzureOpenAIProvider extends BaseLLMProvider {
  get name() {
    return this.config.providerName || 'azure-openai';
  }

  get endpoint() {
    return String(this.config.baseUrl || '').trim().replace(/\/+$/, '');
  }

  get deployment() {
    return String(this.config.model || '').trim();
  }

  get model() {
    return this.deployment;
  }

  get apiVersion() {
    return String(this.config.apiVersion || '2024-10-21').trim();
  }

  get supportsTools() {
    return true;
  }

  get supportsVision() {
    if (this.config.supportsVision != null) return !!this.config.supportsVision;
    return false;
  }

  _headers() {
    const headers = { 'Content-Type': 'application/json' };
    if (this.config.apiKey) headers['api-key'] = String(this.config.apiKey);
    return headers;
  }

  _assertConfigured() {
    if (!this.endpoint) throw new Error('Azure endpoint (Base URL) is required.');
    if (!/^https?:\/\//i.test(this.endpoint)) throw new Error('Azure endpoint must be a valid http(s) URL.');
    if (!this.deployment) throw new Error('Azure deployment name is required (Model field).');
    if (!this.apiVersion) throw new Error('Azure api-version is required.');
  }

  _chatUrl() {
    this._assertConfigured();
    const url = new URL(`${this.endpoint}/openai/deployments/${encodeURIComponent(this.deployment)}/chat/completions`);
    url.searchParams.set('api-version', this.apiVersion);
    return url.toString();
  }

  _addMaxTokens(body, options) {
    body.max_tokens = options.maxTokens ?? 4096;
  }

  _addTemperature(body, options) {
    body.temperature = options.temperature ?? 0.7;
  }

  _messagesContainImage(messages) {
    return messages.some((msg) => Array.isArray(msg?.content) && msg.content.some((block) => {
      return block && (block.type === 'image_url' || block.type === 'image');
    }));
  }

  _shouldSendTools(messages, options) {
    if (!options.tools || options.tools.length === 0) return false;
    return !(this.config.omitToolsWhenImagesPresent && this._messagesContainImage(messages));
  }

  _addStreamUsageOptions(body) {
    if (this.config.supportsStreamUsageOptions === false) return;
    const streamOptions = body.stream_options && typeof body.stream_options === 'object'
      ? body.stream_options
      : {};
    body.stream_options = { ...streamOptions, include_usage: true };
  }

  async chat(messages, options = {}) {
    const body = { messages, stream: false };
    this._addTemperature(body, options);
    this._addMaxTokens(body, options);
    if (this._shouldSendTools(messages, options)) {
      body.tools = options.tools;
      body.tool_choice = options.toolChoice || 'auto';
    }
    if (options.extraBody && typeof options.extraBody === 'object') {
      Object.assign(body, options.extraBody);
    }

    const url = this._chatUrl();
    let res;
    try {
      res = await fetchWithTimeout(url, { method: 'POST', headers: this._headers(), body: JSON.stringify(body) });
    } catch (e) {
      throw new Error(`${this.name} network error — could not reach ${url} (${e.message}). Is the server running?`);
    }
    if (!res.ok) {
      let err = '';
      try { err = (await res.text()).slice(0, 800); } catch {}
      throw new Error(`${this.name} error ${res.status}: ${err || res.statusText}`);
    }

    let data;
    try { data = await res.json(); } catch {
      throw new Error(`${this.name} returned invalid JSON in chat response.`);
    }
    const message = data.choices?.[0]?.message;
    return {
      content: message?.content || '',
      reasoningContent: message?.reasoning_content || message?.reasoning || '',
      toolCalls: message?.tool_calls || null,
      usage: data.usage || null,
      raw: data,
    };
  }

  async *chatStream(messages, options = {}) {
    const body = { messages, stream: true };
    this._addTemperature(body, options);
    this._addMaxTokens(body, options);
    if (this._shouldSendTools(messages, options)) {
      body.tools = options.tools;
      body.tool_choice = options.toolChoice || 'auto';
    }
    if (options.extraBody && typeof options.extraBody === 'object') {
      Object.assign(body, options.extraBody);
    }
    this._addStreamUsageOptions(body);

    const url = this._chatUrl();
    let res;
    try {
      res = await fetchWithTimeout(url, { method: 'POST', headers: this._headers(), body: JSON.stringify(body) });
    } catch (e) {
      throw new Error(`${this.name} network error — could not reach ${url} (${e.message}). Is the server running?`);
    }
    if (!res.ok) {
      let err = '';
      try { err = (await res.text()).slice(0, 800); } catch {}
      throw new Error(`${this.name} stream error ${res.status}: ${err || res.statusText}`);
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
          if (json.usage) yield { type: 'usage', usage: json.usage };
          const delta = json.choices?.[0]?.delta;
          if (delta?.content) yield { type: 'text', content: delta.content };
          if (delta?.tool_calls) yield { type: 'tool_call', content: delta.tool_calls };
        } catch {
          // ignore malformed chunk
        }
      }
    }
    yield { type: 'done', content: '' };
  }
}

