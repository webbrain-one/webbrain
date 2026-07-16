import { BaseLLMProvider } from './base.js';
import { fetchWithTimeout } from './fetch-timeout.js';

/**
 * Provider for OpenAI-compatible APIs (ChatGPT, OpenRouter, any OpenAI-compatible endpoint).
 */
export class OpenAICompatibleProvider extends BaseLLMProvider {
  get name() {
    return this.config.providerName || 'openai';
  }

  get baseUrl() {
    const baseUrl = this.config.baseUrl || 'https://api.openai.com/v1';
    if ((this.config.providerName || '').toLowerCase() !== 'cloudflare') return baseUrl;
    if (!baseUrl.includes('{account_id}')) return baseUrl;
    const accountId = String(this.config.accountId || '').trim();
    if (!/^[0-9a-f]{32}$/i.test(accountId)) {
      throw new Error('Cloudflare Account ID is required and must be a 32-character hex string.');
    }
    return baseUrl.replace('{account_id}', accountId);
  }

  get model() {
    if (this.config.model) return this.config.model;
    return String(this.config.providerName || '').toLowerCase() === 'openai'
      && this._isOfficialOpenAIBaseUrl()
      ? 'gpt-5.6-terra'
      : 'gpt-4o';
  }

  get supportsTools() {
    return true;
  }

  get supportsVision() {
    if (this.config.supportsVision != null) return !!this.config.supportsVision;
    // Qwen went natively multimodal starting at 3.5 (no separate -VL
    // checkpoint needed), so qwen3\.[5-9] catches those alongside the
    // older qwen*vl-suffixed lines.
    const m = (this.config.model || '').toLowerCase();
    return /gpt-4o|gpt-4\.1|gpt-4-turbo|gpt-5|claude|gemini|llava|qwen.*vl|qwen2.*vl|qwen3.*vl|qwen3\.[5-9]|pixtral|llama.*vision|gemma.*vision|gemma-?[34]/.test(m);
  }

  get useCompactPrompt() {
    return !!this.config.useCompactPrompt;
  }

  _headers() {
    const headers = { 'Content-Type': 'application/json' };
    const providerName = (this.config.providerName || '').toLowerCase();
    if (this.config.apiKey) {
      headers['Authorization'] = `Bearer ${this.config.apiKey}`;
    }
    if (providerName === 'webbrain-cloud') {
      if (this.config.deviceGuid) headers['X-WebBrain-Device-Id'] = this.config.deviceGuid;
      headers['X-WebBrain-Client'] = 'extension';
      headers['X-WebBrain-Help-Improve'] = this.config.helpImproveWebBrain === false ? '0' : '1';
    }
    // OpenRouter-specific headers
    if (providerName === 'openrouter') {
      headers['HTTP-Referer'] = this.config.siteUrl || 'https://github.com/webbrain-one/webbrain';
      headers['X-Title'] = 'WebBrain';
    }
    return headers;
  }

  /**
   * GPT-5 / gpt-4.1 / o1 / o3 / o4 use a different API contract:
   *   - require max_completion_tokens instead of max_tokens
   *   - reject any temperature other than the default (1)
   */
  _isNewOpenAIContract() {
    const m = (this.config.model || '').toLowerCase();
    if (this.config.category === 'local') return false;
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
    if (this._isNewOpenAIContract()) return;
    body.temperature = options.temperature ?? 0.7;
  }

  _webbrainSubscribeUrl() {
    const url = new URL('https://webbrain.one/subscribe');
    if (this.config.deviceGuid) {
      url.searchParams.set('client_reference_id', this.config.deviceGuid);
    }
    return url.toString();
  }

  _formatHttpError(status, body) {
    const providerName = (this.config.providerName || '').toLowerCase();
    if (status === 402 && providerName === 'webbrain-cloud') {
      let subscribeUrl = this._webbrainSubscribeUrl();
      let message = 'Daily free WebBrain Cloud allowance used.';
      try {
        const parsed = JSON.parse(body || '{}');
        subscribeUrl = parsed.subscribe_url || subscribeUrl;
        message = parsed.error?.message || message;
      } catch { /* keep fallback */ }
      return `${message}\nSubscribe for more usage: ${subscribeUrl}`;
    }
    // Ollama enforces an Origin allowlist; browser extensions hit it with a
    // moz-extension:// or chrome-extension:// origin that isn't on the
    // default list, producing a 403 with an empty body.
    if (status === 403 && providerName === 'ollama') {
      return (
        (body ? body + '\n\n' : '') +
        'Ollama rejected the extension origin. Restart Ollama with OLLAMA_ORIGINS allowing extensions, e.g.:\n' +
        '  OLLAMA_ORIGINS="*" ollama serve\n' +
        '(or OLLAMA_ORIGINS="moz-extension://*,chrome-extension://*" for a tighter allowlist).'
      );
    }
    return body;
  }

  _shouldRequestStreamUsage() {
    const providerName = (this.config.providerName || '').toLowerCase();
    if (this.config.category === 'local') return false;
    if (providerName === 'ollama' || providerName === 'lmstudio') return false;
    if (this.config.supportsStreamUsageOptions != null) {
      return !!this.config.supportsStreamUsageOptions;
    }
    if (!providerName && this.baseUrl === 'https://api.openai.com/v1') return true;
    return providerName === 'openai'
      || providerName === 'openrouter'
      || providerName === 'deepseek'
      || providerName === 'gemini';
  }

  _addStreamUsageOptions(body) {
    if (!this._shouldRequestStreamUsage()) return;
    const streamOptions = body.stream_options && typeof body.stream_options === 'object'
      ? body.stream_options
      : {};
    body.stream_options = { ...streamOptions, include_usage: true };
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

  _addWebBrainCloudContext(body, options) {
    if (String(this.config.providerName || '').toLowerCase() !== 'webbrain-cloud') return;
    const sessionId = String(options.webbrainSessionId || '').trim();
    if (sessionId) body.session_id = sessionId.slice(0, 200);
    const generationName = String(options.webbrainGenerationName || '').trim().toLowerCase();
    if (generationName) {
      const trace = body.trace && typeof body.trace === 'object' && !Array.isArray(body.trace)
        ? body.trace
        : {};
      body.trace = { ...trace, generation_name: generationName.slice(0, 64) };
    }
  }

  /**
   * GPT-5.6 combines reasoning and function tools through the Responses API.
   * Keep this route deliberately narrow: older OpenAI models and every
   * OpenAI-compatible provider retain their existing Chat Completions wire
   * format. A custom base URL also stays on Chat Completions because there is
   * no guarantee that the proxy implements /v1/responses.
   */
  _usesResponsesApi() {
    if (String(this.config.providerName || '').toLowerCase() !== 'openai') return false;
    const model = String(this.model || '').trim().toLowerCase();
    if (!/^gpt-5\.6(?:$|-(?:sol|terra|luna)(?:$|-))/.test(model)) return false;
    return this._isOfficialOpenAIBaseUrl();
  }

  _isOfficialOpenAIBaseUrl() {
    try {
      const url = new URL(this.baseUrl);
      return url.protocol === 'https:'
        && url.hostname === 'api.openai.com'
        && url.pathname.replace(/\/+$/, '') === '/v1';
    } catch {
      return false;
    }
  }

  _responsesUrl() {
    return `${this.baseUrl.replace(/\/+$/, '')}/responses`;
  }

  _chatMessages(messages) {
    return (Array.isArray(messages) ? messages : []).map((message) => {
      if (!message || !Object.hasOwn(message, 'response_items')) return message;
      const { response_items: _responseItems, ...chatMessage } = message;
      return chatMessage;
    });
  }

  _responsesContent(content) {
    if (!Array.isArray(content)) return content == null ? '' : String(content);
    return content.map((block) => {
      if (!block || typeof block !== 'object') {
        return { type: 'input_text', text: String(block ?? '') };
      }
      if (block.type === 'input_text' || block.type === 'input_image') return block;
      if (block.type === 'text') {
        return { type: 'input_text', text: String(block.text || '') };
      }
      if (block.type === 'image_url') {
        const imageUrl = typeof block.image_url === 'string'
          ? block.image_url
          : block.image_url?.url;
        return {
          type: 'input_image',
          image_url: imageUrl || '',
          ...(block.image_url?.detail ? { detail: block.image_url.detail } : {}),
        };
      }
      return { type: 'input_text', text: block.text || JSON.stringify(block) };
    });
  }

  _responsesInput(messages) {
    const input = [];
    for (const message of Array.isArray(messages) ? messages : []) {
      if (Array.isArray(message?.response_items) && message.response_items.length) {
        input.push(...message.response_items);
        continue;
      }

      if (message?.role === 'tool') {
        input.push({
          type: 'function_call_output',
          call_id: String(message.tool_call_id || ''),
          output: typeof message.content === 'string'
            ? message.content
            : JSON.stringify(message.content ?? ''),
        });
        continue;
      }

      if (message?.role === 'assistant' && Array.isArray(message.tool_calls)) {
        if (message.content) {
          input.push({ role: 'assistant', content: this._responsesContent(message.content) });
        }
        for (const toolCall of message.tool_calls) {
          const fn = toolCall?.function || {};
          input.push({
            type: 'function_call',
            call_id: String(toolCall?.id || ''),
            name: String(fn.name || ''),
            arguments: typeof fn.arguments === 'string'
              ? fn.arguments
              : JSON.stringify(fn.arguments || {}),
          });
        }
        continue;
      }

      input.push({
        role: message?.role || 'user',
        content: this._responsesContent(message?.content),
      });
    }
    return input;
  }

  _responsesTools(tools) {
    return (Array.isArray(tools) ? tools : []).map((tool) => {
      if (tool?.type !== 'function' || !tool.function) return tool;
      const fn = tool.function;
      return {
        type: 'function',
        name: fn.name,
        description: fn.description,
        parameters: fn.parameters || { type: 'object', properties: {} },
        strict: fn.strict === true,
      };
    });
  }

  _responsesToolChoice(toolChoice) {
    if (!toolChoice || typeof toolChoice === 'string') return toolChoice || 'auto';
    const name = toolChoice.function?.name || toolChoice.name;
    return name ? { type: 'function', name } : 'auto';
  }

  _responsesBody(messages, options, stream) {
    const body = {
      model: this.model,
      input: this._responsesInput(messages),
      stream,
      store: false,
      include: ['reasoning.encrypted_content'],
      max_output_tokens: options.maxTokens ?? 4096,
      reasoning: {
        effort: options.reasoningEffort || this.config.reasoningEffort || 'medium',
      },
    };

    if (this._shouldSendTools(messages, options)) {
      body.tools = this._responsesTools(options.tools);
      body.tool_choice = this._responsesToolChoice(options.toolChoice);
    }

    const extra = options.extraBody;
    if (extra && typeof extra === 'object') {
      if (typeof extra.reasoning_effort === 'string') {
        body.reasoning = { effort: extra.reasoning_effort };
      } else if (extra.reasoning && typeof extra.reasoning === 'object') {
        body.reasoning = { ...body.reasoning, ...extra.reasoning };
      }
      if (extra.response_format?.type === 'json_schema' && extra.response_format.json_schema) {
        const schema = extra.response_format.json_schema;
        body.text = {
          format: {
            type: 'json_schema',
            name: schema.name,
            schema: schema.schema,
            strict: schema.strict === true,
          },
        };
      }
    }
    return body;
  }

  _normalizeResponsesUsage(usage) {
    if (!usage || typeof usage !== 'object') return usage || null;
    return {
      ...usage,
      prompt_tokens: usage.prompt_tokens ?? usage.input_tokens ?? 0,
      completion_tokens: usage.completion_tokens ?? usage.output_tokens ?? 0,
      total_tokens: usage.total_tokens ??
        ((usage.input_tokens || 0) + (usage.output_tokens || 0)),
    };
  }

  _responseText(output) {
    const text = [];
    for (const item of Array.isArray(output) ? output : []) {
      if (item?.type !== 'message') continue;
      for (const part of Array.isArray(item.content) ? item.content : []) {
        if (part?.type === 'output_text' && part.text) text.push(part.text);
        if (part?.type === 'refusal' && part.refusal) text.push(part.refusal);
      }
    }
    return text.join('');
  }

  _responseToolCall(item, index = 0) {
    if (item?.type !== 'function_call') return null;
    return {
      index,
      id: item.call_id,
      type: 'function',
      function: {
        name: item.name || '',
        arguments: item.arguments || '',
      },
    };
  }

  _responsesResult(data) {
    const output = Array.isArray(data?.output) ? data.output : [];
    const toolCalls = output
      .map((item, index) => this._responseToolCall(item, index))
      .filter(Boolean);
    const reasoningContent = output
      .filter(item => item?.type === 'reasoning')
      .flatMap(item => Array.isArray(item.summary) ? item.summary : [])
      .map(part => part?.text || '')
      .join('');
    return {
      content: this._responseText(output),
      reasoningContent,
      toolCalls: toolCalls.length ? toolCalls : null,
      usage: this._normalizeResponsesUsage(data?.usage),
      responseItems: output,
      raw: data,
    };
  }

  async _chatResponses(messages, options) {
    const url = this._responsesUrl();
    let res;
    try {
      res = await fetchWithTimeout(url, {
        method: 'POST',
        headers: this._headers(),
        body: JSON.stringify(this._responsesBody(messages, options, false)),
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
      throw new Error(`${this.name} returned invalid JSON in Responses response.`);
    }
    return this._responsesResult(data);
  }

  async *_chatResponsesStream(messages, options) {
    const url = this._responsesUrl();
    let res;
    try {
      res = await fetchWithTimeout(url, {
        method: 'POST',
        headers: this._headers(),
        body: JSON.stringify(this._responsesBody(messages, options, true)),
      });
    } catch (e) {
      throw new Error(`${this.name} network error — could not reach ${url} (${e.message}). Is the server running?`);
    }
    if (!res.ok) {
      const err = await res.text();
      throw new Error(`${this.name} stream error ${res.status}: ${this._formatHttpError(res.status, err)}`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    const toolItems = new Map();
    const emittedToolIndexes = new Set();
    let buffer = '';

    const finalToolCalls = (response) => {
      const calls = [];
      for (const [index, item] of (response?.output || []).entries()) {
        if (emittedToolIndexes.has(index)) continue;
        const call = this._responseToolCall(item, index);
        if (call) {
          emittedToolIndexes.add(index);
          calls.push(call);
        }
      }
      return calls;
    };

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
          yield { type: 'done', content: '', responseItems: [] };
          return;
        }
        try {
          const event = JSON.parse(payload);
          if ((event.type === 'response.output_text.delta' || event.type === 'response.refusal.delta') && event.delta) {
            yield { type: 'text', content: event.delta };
          } else if (event.type === 'response.output_item.added' && event.item?.type === 'function_call') {
            toolItems.set(event.output_index, { ...event.item });
          } else if (event.type === 'response.function_call_arguments.delta') {
            const item = toolItems.get(event.output_index);
            if (item) item.arguments = `${item.arguments || ''}${event.delta || ''}`;
          } else if (event.type === 'response.function_call_arguments.done') {
            const item = toolItems.get(event.output_index);
            if (item && typeof event.arguments === 'string') item.arguments = event.arguments;
          } else if (event.type === 'response.output_item.done' && event.item?.type === 'function_call') {
            const index = event.output_index ?? 0;
            if (!emittedToolIndexes.has(index)) {
              emittedToolIndexes.add(index);
              const call = this._responseToolCall(event.item, index);
              if (call) yield { type: 'tool_call', content: [call] };
            }
          } else if (event.type === 'response.completed' || event.type === 'response.incomplete') {
            const response = event.response || {};
            const remaining = finalToolCalls(response);
            if (remaining.length) yield { type: 'tool_call', content: remaining };
            if (response.usage) {
              yield { type: 'usage', usage: this._normalizeResponsesUsage(response.usage) };
            }
            yield { type: 'done', content: '', responseItems: response.output || [] };
            return;
          } else if (event.type === 'response.failed' || event.type === 'error') {
            const message = event.response?.error?.message || event.error?.message || event.message || 'Responses stream failed.';
            const streamError = new Error(message);
            streamError.isResponsesStreamError = true;
            throw streamError;
          }
        } catch (e) {
          if (e?.isResponsesStreamError) throw e;
          console.warn(`[${this.name}] malformed Responses SSE chunk skipped:`, payload?.slice(0, 120), e?.message);
        }
      }
    }
    yield { type: 'done', content: '', responseItems: [] };
  }

  async chat(messages, options = {}) {
    if (this._usesResponsesApi()) {
      return this._chatResponses(messages, options);
    }
    const body = {
      model: this.model,
      messages: this._chatMessages(messages),
      stream: false,
    };
    this._addTemperature(body, options);
    this._addMaxTokens(body, options);

    if (this._shouldSendTools(messages, options)) {
      body.tools = options.tools;
      body.tool_choice = options.toolChoice || 'auto';
    }

    if (options.extraBody && typeof options.extraBody === 'object') {
      Object.assign(body, options.extraBody);
    }
    this._addWebBrainCloudContext(body, options);

    const url = `${this.baseUrl}/chat/completions`;
    let res;
    try {
      res = await fetchWithTimeout(url, {
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
      reasoningContent: message?.reasoning_content || message?.reasoning || '',
      toolCalls: message?.tool_calls || null,
      usage: data.usage || null,
      raw: data,
    };
  }

  async *chatStream(messages, options = {}) {
    if (this._usesResponsesApi()) {
      yield* this._chatResponsesStream(messages, options);
      return;
    }
    const body = {
      model: this.model,
      messages: this._chatMessages(messages),
      stream: true,
    };
    this._addTemperature(body, options);
    this._addMaxTokens(body, options);

    if (this._shouldSendTools(messages, options)) {
      body.tools = options.tools;
      body.tool_choice = options.toolChoice || 'auto';
    }

    if (options.extraBody && typeof options.extraBody === 'object') {
      Object.assign(body, options.extraBody);
    }
    this._addWebBrainCloudContext(body, options);
    this._addStreamUsageOptions(body);

    const streamUrl = `${this.baseUrl}/chat/completions`;
    let res;
    try {
      res = await fetchWithTimeout(streamUrl, {
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
          if (json.usage) {
            yield { type: 'usage', usage: json.usage };
          }
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
