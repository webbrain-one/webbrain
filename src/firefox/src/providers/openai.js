import { BaseLLMProvider } from './base.js';
import { fetchWithTimeout } from './fetch-timeout.js';
import { shouldUseOpenAIResponsesApi } from './provider-compatibility.js';

const OPENAI_RESPONSES_MIN_MAX_OUTPUT_TOKENS = 16;
const KIMI_CURRENT_TOOL_REASONING_MODELS = new Set([
  'kimi-k3',
  'kimi-k2.7-code',
  'kimi-k2.7-code-highspeed',
  'kimi-k2.6',
  'kimi-k2.5',
]);
const KIMI_PRESERVED_THINKING_MODELS = new Set([
  'kimi-k3',
  'kimi-k2.7-code',
  'kimi-k2.7-code-highspeed',
]);

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
    // Explicit user opt-in always wins (used by LM Studio and any custom
    // OpenAI-compatible endpoint where the loaded model varies).
    if (this.config.supportsVision != null) return !!this.config.supportsVision;
    // Otherwise sniff the model name for known vision-capable identifiers.
    // Qwen went natively multimodal starting at 3.5 (no separate -VL
    // checkpoint needed), so qwen3\.[5-9] catches those alongside the
    // older qwen*vl-suffixed lines.
    const m = (this.config.model || '').toLowerCase();
    return /gpt-4o|gpt-4\.1|gpt-4-turbo|gpt-5|claude|gemini|kimi-k(?:-?3|2\.[5-9])|llava|qwen.*vl|qwen2.*vl|qwen3.*vl|qwen3\.[5-9]|pixtral|llama.*vision|gemma.*vision|gemma-?[34]/.test(m);
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
   * Newer OpenAI models (gpt-5, gpt-4.1+, o1, o3, o4) have a different API
   * contract from the gpt-4o-and-earlier line:
   *   - reject `max_tokens`, require `max_completion_tokens` instead
   *   - reject any `temperature` other than the default (1)
   * Local OpenAI-compatible servers and OpenRouter still use
   * the legacy contract. Detect by model name + provider type.
   */
  _isNewOpenAIContract() {
    const m = (this.config.model || '').toLowerCase();
    if (this.config.category === 'local') return false;
    if (this.config.providerName === 'lmstudio') return false;
    return /^(gpt-5|gpt-4\.1|o1|o3|o4)/.test(m);
  }

  _addMaxTokens(body, options) {
    // Prefer configured max-token field when set; otherwise preserve the
    // existing OpenAI new-contract vs legacy default.
    const fallback = this._isNewOpenAIContract() ? 'max_completion_tokens' : 'max_tokens';
    this._addConfiguredMaxTokens(body, options, fallback);
  }

  _addTemperature(body, options) {
    // GPT-5 / o-series only accept the default temperature (1). Sending
    // anything else returns 400. Provider configs can impose
    // the same omission for fixed-temperature models such as Kimi K2.5/K3.
    // In both cases, let the API apply its required default.
    if (this._isNewOpenAIContract() || this.config.omitTemperature) return;
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
    return shouldUseOpenAIResponsesApi({
      ...this.config,
      providerName: this.config.providerName || this.name,
      baseUrl: this.baseUrl,
      model: this.model,
    });
  }

  _supportsReasoningContentReplay(options = {}) {
    if (String(this.config.providerName || '').trim().toLowerCase() !== 'kimi') return false;
    const model = String(this.model || '').trim().toLowerCase();
    if (KIMI_PRESERVED_THINKING_MODELS.has(model)) return true;
    if (model !== 'kimi-k2.6') return false;

    const configuredThinking = this.config.extraBody?.thinking;
    const requestThinking = options.extraBody?.thinking;
    const keep = requestThinking?.keep ?? configuredThinking?.keep;
    const type = requestThinking?.type ?? configuredThinking?.type;
    return keep === 'all' && type !== 'disabled';
  }

  _supportsCurrentToolReasoningReplay() {
    if (String(this.config.providerName || '').trim().toLowerCase() !== 'kimi') return false;
    // K2.5 lacks cross-turn Preserved Thinking, but Kimi still requires the
    // reasoning attached to a tool call on that loop's immediate follow-up.
    return KIMI_CURRENT_TOOL_REASONING_MODELS.has(
      String(this.model || '').trim().toLowerCase()
    );
  }

  _shouldReplayReasoningContent(message, options = {}) {
    // Never mix opaque reasoning across providers or model switches.
    const replay = message?._reasoning_replay;
    if (!replay || typeof replay !== 'object') return false;
    const providerName = String(this.config.providerName || '').trim().toLowerCase();
    const model = String(this.model || '').trim().toLowerCase();
    if (String(replay.provider || '').trim().toLowerCase() !== providerName) return false;
    if (String(replay.model || '').trim().toLowerCase() !== model) return false;
    if (
      replay.currentToolLoop === true
      && Array.isArray(message.tool_calls)
      && message.tool_calls.length > 0
      && this._supportsCurrentToolReasoningReplay(options)
    ) {
      return true;
    }
    if (replay.preserveAcrossTurns !== true) return false;
    return this._supportsReasoningContentReplay(options);
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

  /**
   * Shared Chat Completions body builder (also used by unit tests).
   * Applies system→developer role mapping, configured max-token field,
   * compatibility presets, and safe extraBody merge.
   */
  _buildChatCompletionsBody(messages, options = {}, stream = false) {
    let body = {
      model: this.model,
      messages: this._chatMessages(messages, options),
      stream,
    };
    this._addTemperature(body, options);
    this._addMaxTokens(body, options);
    if (this._shouldSendTools(messages, options)) {
      body.tools = options.tools;
      body.tool_choice = options.toolChoice || 'auto';
    }
    body = this._mergeConfiguredRequestBody(body, options);
    this._addWebBrainCloudContext(body, options);
    if (stream) this._addStreamUsageOptions(body);
    return body;
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
    // Role mapping applies to plain chat turns; exact response_items replay
    // is left untouched so encrypted reasoning state stays intact.
    for (const message of this._mapMessages(Array.isArray(messages) ? messages : [])) {
      // These are the exact output Items returned by a prior stateless
      // Responses call. Replaying them preserves encrypted reasoning state,
      // which OpenAI requires when a reasoning turn emitted function calls.
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
        // Chat Completions is non-strict by default. Preserve that behavior
        // unless a WebBrain tool explicitly opted into strict schemas.
        strict: fn.strict === true,
      };
    });
  }

  _responsesToolChoice(toolChoice) {
    if (!toolChoice || typeof toolChoice === 'string') return toolChoice || 'auto';
    const name = toolChoice.function?.name || toolChoice.name;
    return name ? { type: 'function', name } : 'auto';
  }

  _responsesMaxOutputTokens(options) {
    const max = Number(options.maxTokens ?? 4096);
    if (!Number.isFinite(max)) return 4096;
    return Math.max(OPENAI_RESPONSES_MIN_MAX_OUTPUT_TOKENS, Math.floor(max));
  }

  _responsesBody(messages, options, stream) {
    let body = {
      model: this.model,
      input: this._responsesInput(messages),
      stream,
      store: false,
      include: ['reasoning.encrypted_content'],
      max_output_tokens: this._responsesMaxOutputTokens(options),
      // Keep reasoning enabled. `none` would recreate the workaround the
      // Responses migration is specifically intended to avoid.
      reasoning: {
        effort: options.reasoningEffort || this.config.reasoningEffort || this.config.compat?.reasoningEffort || 'medium',
      },
    };
    if (body.reasoning.effort === 'auto' || body.reasoning.effort === 'off') {
      body.reasoning.effort = body.reasoning.effort === 'off' ? 'none' : 'medium';
    }

    if (this._shouldSendTools(messages, options)) {
      body.tools = this._responsesTools(options.tools);
      body.tool_choice = this._responsesToolChoice(options.toolChoice);
    }

    // Merge configured compatibility extras (and safe extraBody) after the
    // base Responses shape. Reserved keys like model/input/stream/tools are
    // filtered out by mergeProviderRequestBody.
    body = this._mergeConfiguredRequestBody(body, options);

    // Normalize Chat Completions-style reasoning_effort if a preset emitted it.
    if (typeof body.reasoning_effort === 'string') {
      body.reasoning = { ...(body.reasoning || {}), effort: body.reasoning_effort };
      delete body.reasoning_effort;
    }

    // Re-assert Responses contract fields that custom/extra JSON must not
    // silently disable (stateless multi-turn reasoning replay).
    body.store = false;
    const include = Array.isArray(body.include) ? body.include.filter((item) => typeof item === 'string') : [];
    if (!include.includes('reasoning.encrypted_content')) {
      include.push('reasoning.encrypted_content');
    }
    body.include = include;
    if (!body.reasoning || typeof body.reasoning !== 'object' || Array.isArray(body.reasoning)) {
      body.reasoning = { effort: 'medium' };
    } else if (!body.reasoning.effort) {
      body.reasoning.effort = 'medium';
    }

    // Convert Chat Completions-style response_format (from config or per-call
    // extras) into Responses text.format, then strip the legacy key so both
    // are never sent together.
    const responseFormat = (body.response_format && typeof body.response_format === 'object')
      ? body.response_format
      : (options.extraBody && typeof options.extraBody === 'object' ? options.extraBody.response_format : null);
    if (responseFormat?.type === 'json_schema' && responseFormat.json_schema) {
      const schema = responseFormat.json_schema;
      body.text = {
        format: {
          type: 'json_schema',
          name: schema.name,
          schema: schema.schema,
          strict: schema.strict === true,
        },
      };
    }
    delete body.response_format;
    return body;
  }

  // Aliases used by provider-compatibility regression tests.
  _buildResponsesBody(messages, options = {}, stream = false) {
    return this._responsesBody(messages, options, stream);
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

  _responsesIncompleteReason(response) {
    return response?.incomplete_details?.reason
      || response?.status_details?.reason
      || response?.error?.code
      || null;
  }

  _responsesIncompleteError(response, { stream = false } = {}) {
    const reason = this._responsesIncompleteReason(response) || 'incomplete';
    const detail = response?.error?.message || response?.incomplete_details?.message || '';
    const prefix = stream ? 'Responses stream incomplete' : 'Responses incomplete';
    const message = detail
      ? `${prefix} (${reason}): ${detail}`
      : `${prefix} (${reason}).`;
    const error = new Error(message);
    error.isResponsesStreamError = !!stream;
    error.incomplete = true;
    error.incompleteReason = reason;
    return error;
  }

  _responsesResult(data) {
    // Official Responses can return HTTP 200 with status incomplete/failed
    // (max_output_tokens, content filter, etc.). Treat those as hard errors so
    // truncated answers are not persisted as successful turns.
    if (data?.status === 'incomplete') {
      throw this._responsesIncompleteError(data, { stream: false });
    }
    if (data?.status === 'failed') {
      const message = data?.error?.message || 'Responses request failed.';
      throw new Error(message);
    }
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

  // Alias used by provider-compatibility regression tests.
  _parseResponsesData(data) {
    return this._responsesResult(data);
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
          // Responses must finish with response.completed so we can retain
          // the complete output Items used for encrypted reasoning replay.
          // A bare legacy sentinel is therefore an incomplete stream, not a
          // successful empty response.
          throw this._responsesIncompleteError({
            incomplete_details: { reason: 'missing_response_completed' },
          }, { stream: true });
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
          } else if (event.type === 'response.completed') {
            const response = event.response || {};
            const remaining = finalToolCalls(response);
            if (remaining.length) yield { type: 'tool_call', content: remaining };
            if (response.usage) {
              yield { type: 'usage', usage: this._normalizeResponsesUsage(response.usage) };
            }
            yield { type: 'done', content: '', responseItems: response.output || [] };
            return;
          } else if (event.type === 'response.incomplete') {
            // Incomplete is terminal (token limit / filter / etc.). Surface it
            // instead of yielding a normal done that the agent treats as success.
            const response = event.response || {};
            if (response.usage) {
              yield { type: 'usage', usage: this._normalizeResponsesUsage(response.usage) };
            }
            throw this._responsesIncompleteError(response, { stream: true });
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
    // A clean transport EOF is still a failure when no terminal Responses
    // event arrived. Treating it as done would persist partial text and lose
    // any function-call/reasoning Items that only arrive on completion.
    throw this._responsesIncompleteError({
      incomplete_details: { reason: 'missing_response_completed' },
    }, { stream: true });
  }

  async chat(messages, options = {}) {
    if (this._usesResponsesApi()) {
      return this._chatResponses(messages, options);
    }
    const body = this._buildChatCompletionsBody(messages, options, false);
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
    const body = this._buildChatCompletionsBody(messages, options, true);
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
    let finalUsage = null;

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
          if (finalUsage) yield { type: 'usage', usage: finalUsage };
          yield { type: 'done', content: '' };
          return;
        }
        try {
          const json = JSON.parse(payload);
          if (json.usage) {
            finalUsage = json.usage;
          }
          const delta = json.choices?.[0]?.delta;
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
        } catch (e) {
          console.warn(`[${this.name}] malformed SSE chunk skipped:`, payload?.slice(0, 120), e?.message);
        }
      }
    }
    if (finalUsage) yield { type: 'usage', usage: finalUsage };
    yield { type: 'done', content: '' };
  }
}
