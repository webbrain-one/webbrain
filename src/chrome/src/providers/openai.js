import { BaseLLMProvider } from './base.js';
import { openRouterReplayIdentity, openRouterReplayItems, projectOpenRouterReplay, accumulateReasoningDetails } from './openrouter-replay.js';
import { normalizeQwenToolResult, normalizeQwenToolStream } from './qwen-tool-calls.js';
import { normalizeDolphinPromptedResult, normalizeDolphinPromptedStream } from './dolphin-prompted-tools.js';
import { fetchWithFallback } from './fetch-with-fallback.js';
import {
  baseModelNameSniffedVision,
  isNewOpenAIContractConfig,
  isOfficialOpenAIConfig,
  isOpenCodeZenConfig,
  isOpenRouterLingVisionModel,
  isOpenRouterNexN25MiniModel,
  isOpenRouterDolphinVeniceConfig,
  openRouterDolphinPromptedTools,
  isQwenConfig,
  qwenToolOptions,
  requiresOpenAIDefaultTemperature,
  shouldUseOpenAIResponsesApi,
  supportsOpenAIAskStreaming,
  applyOpenRouterRoutingVariant,
  openRouterMuseToolOptions,
  mandatoryReasoningOptions,
} from './provider-compatibility.js';
import { normalizeRuntimeTraceConfig } from '../trace/runtime-config.js';
import { canonicalizeOllamaBaseUrl } from './context-windows.js';
import { AUTO_VISION_PROVIDER_IDS, configuredVisionSupport } from './vision-capabilities.js';

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
const Z_AI_STREAM_TERMINAL_FINISH_REASONS = new Set([
  'sensitive',
  'network_error',
  'model_context_window_exceeded',
]);

function sseDataPayload(line) {
  const normalized = String(line || '').replace(/\r$/, '');
  if (!normalized.startsWith('data:')) return null;
  const value = normalized.slice(5);
  const payload = value.startsWith(' ') ? value.slice(1) : value;
  return payload.trim() ? payload : null;
}

/**
 * Provider for OpenAI-compatible APIs (ChatGPT, OpenRouter, any OpenAI-compatible endpoint).
 */
export class OpenAICompatibleProvider extends BaseLLMProvider {
  _reasoningReplayIdentity() {
    return openRouterReplayIdentity({ ...this.config, baseUrl: this.baseUrl, model: this.model });
  }

  _chatMessages(messages, options = {}) {
    const mapped = super._chatMessages(messages, options);
    return projectOpenRouterReplay(mapped, messages, { ...this.config, baseUrl: this.baseUrl, model: this.model });
  }

  get name() {
    return this.config.providerName || 'openai';
  }

  get baseUrl() {
    let baseUrl = String(this.config.baseUrl || 'https://api.openai.com/v1').trim();
    const vertexLocation = String(this.config.location || '').trim();
    const replacements = {
      account_id: {
        value: String(this.config.accountId || '').trim(),
        valid: (value) => /^[0-9a-f]{32}$/i.test(value),
        message: 'Cloudflare Account ID is required and must be a 32-character hex string.',
      },
      project: {
        value: String(this.config.project || '').trim(),
        valid: (value) => /^[a-z][a-z0-9:._-]{4,127}$/i.test(value),
        message: 'Google Cloud project ID is required.',
      },
      location: {
        value: vertexLocation,
        valid: (value) => /^[a-z0-9-]+$/i.test(value),
        message: 'Google Cloud location is required.',
      },
      resource: {
        value: String(this.config.resource || '').trim(),
        valid: (value) => /^[a-z0-9-]{2,64}$/i.test(value),
        message: 'Azure resource name is required.',
      },
      vertex_endpoint: {
        value: vertexLocation.toLowerCase() === 'global'
          ? 'aiplatform.googleapis.com'
          : `${vertexLocation}-aiplatform.googleapis.com`,
        valid: (value) => /^(?:[a-z0-9-]+-)?aiplatform\.googleapis\.com$/i.test(value),
        message: 'Google Cloud location is required.',
      },
    };
    for (const [placeholder, replacement] of Object.entries(replacements)) {
      if (!baseUrl.includes(`{${placeholder}}`)) continue;
      if (!replacement.valid(replacement.value)) throw new Error(replacement.message);
      baseUrl = baseUrl.replaceAll(`{${placeholder}}`, replacement.value);
    }
    return baseUrl.replace(/\/+$/, '');
  }

  get model() {
    if (this.config.model) {
      const model = String(this.config.model);
      return isOpenCodeZenConfig(this.config) ? model.replace(/^opencode\//i, '') : model;
    }
    if (this.config.requiresModel) throw new Error(`${this.config.label || this.name} model is required.`);
    // Some local servers apply their own default when no model is configured.
    // Others carry `requiresModel: true` and throw above. Treat the category as
    // the durable boundary so older/custom local entries never inherit a
    // fabricated cloud model id merely because their provider name is unknown.
    if (this.config.category === 'local') return null;
    return String(this.config.providerName || '').toLowerCase() === 'openai'
      && this._isOfficialOpenAIBaseUrl()
      ? 'gpt-5.6-terra'
      : 'gpt-4o';
  }

  get supportsTools() {
    const mode = this._capabilityMode('toolsMode');
    if (mode === 'on') return true;
    if (mode === 'off') return false;
    // OpenRouter's Nex N2.5 mini route accepts chat completions but has no
    // function-compatible endpoint. Sending even read-only tools returns 404.
    if (this._isOpenRouterNexN25Mini()) return false;
    if (isOpenRouterDolphinVeniceConfig({ ...this.config, baseUrl: this.baseUrl, model: this.config.model || '' })) return false;
    return this.config.supportsTools !== false;
  }

  get requiresPromptedTools() {
    return !this.supportsTools
      && isOpenRouterDolphinVeniceConfig({ ...this.config, baseUrl: this.baseUrl, model: this.config.model || '' });
  }

  get supportsVision() {
    const providerName = String(this.config.providerName || '').toLowerCase();
    if (providerName === 'ollama' && this.config.visionMode != null) {
      const mode = ['auto', 'on', 'off'].includes(this.config.visionMode)
        ? this.config.visionMode
        : 'auto';
      if (mode === 'on') return true;
      if (mode === 'off') return false;
      const detection = this.config.visionDetection;
      const model = String(this.config.model || '').trim().toLowerCase();
      const baseUrl = canonicalizeOllamaBaseUrl(this.config.baseUrl);
      const detectedModel = String(detection?.model || '').trim().toLowerCase();
      const detectedBaseUrl = canonicalizeOllamaBaseUrl(detection?.baseUrl);
      return !!model && !!baseUrl
        && model === detectedModel
        && baseUrl === detectedBaseUrl
        && detection?.supportsVision === true;
    }
    if (AUTO_VISION_PROVIDER_IDS.has(providerName)) {
      return configuredVisionSupport(providerName, this.config);
    }
    // The Advanced vision selector (auto/on/off) wins first. For OpenRouter
    // the /vision slash command also writes visionMode (see sidepanel
    // toggledVisionProviderConfig), so the toggle keeps working.
    const mode = this._capabilityMode('visionMode');
    if (mode === 'on') return true;
    if (mode === 'off') return false;
    // Legacy explicit opt-in/out (used by LM Studio, custom endpoints, and
    // the /vision toggle for non-OpenRouter providers) wins over detection.
    if (this.config.supportsVision != null) return !!this.config.supportsVision;
    // OpenRouter-scoped detection for models the shared sniff cannot name
    // (router route ids such as inclusionai/ling-3.0-flash-vl).
    if (this._isOpenRouterLingVisionModel()) return true;
    // Otherwise sniff the model name for known vision-capable identifiers.
    // Qwen went natively multimodal starting at 3.5 (no separate -VL
    // checkpoint needed), so qwen3\.[5-9] catches those alongside the
    // older qwen*vl-suffixed lines. Vendor-specific families extend
    // `_modelNameSniffedVision` (see the vendor subclass in this folder)
    // rather than widening this shared regex.
    const m = (this.config.model || '').toLowerCase();
    return this._modelNameSniffedVision(m);
  }

  /**
   * Shared model-name vision sniffing. Subclasses override this hook so a
   * vendor-specific allow/deny list never has to duplicate the explicit
   * user-override and auto-detection precedence handled by the
   * `supportsVision` getter above.
   */
  _modelNameSniffedVision(model) {
    return baseModelNameSniffedVision(model);
  }

  _isOpenRouterNexN25Mini() {
    return String(this.config.providerName || '').trim().toLowerCase() === 'openrouter'
      && isOpenRouterNexN25MiniModel(this.model);
  }

  _isOpenRouterLingVisionModel() {
    return String(this.config.providerName || '').trim().toLowerCase() === 'openrouter'
      && isOpenRouterLingVisionModel(this.model);
  }

  _capabilityMode(key) {
    const mode = String(this.config[key] || '').trim().toLowerCase();
    return ['auto', 'on', 'off'].includes(mode) ? mode : 'auto';
  }

  get useCompactPrompt() {
    return !!this.config.useCompactPrompt;
  }

  _chatAbortOptions(options = {}) {
    return options.signal ? { signal: options.signal } : {};
  }

  _headers(options = {}) {
    const headers = { 'Content-Type': 'application/json' };
    const providerName = (this.config.providerName || '').toLowerCase();
    if (this.config.requiresApiKey && !String(this.config.apiKey || '').trim()) {
      throw new Error(`${this.config.label || this.name} API key is required.`);
    }
    if (this.config.apiKey) {
      if (this.config.apiKeyHeader === 'x-goog-api-key') {
        headers['x-goog-api-key'] = String(this.config.apiKey);
      } else if (this.config.apiKeyHeader === 'api-key') {
        headers['api-key'] = String(this.config.apiKey);
      } else {
        headers['Authorization'] = `Bearer ${this.config.apiKey}`;
      }
    }
    if (providerName === 'webbrain-cloud') {
      if (this.config.deviceGuid) headers['X-WebBrain-Device-Id'] = this.config.deviceGuid;
      headers['X-WebBrain-Client'] = 'extension';
      const helpImprove = options.helpImprove ?? (this.config.helpImproveWebBrain === false ? '0' : '1');
      headers['X-WebBrain-Help-Improve'] = helpImprove;
    }
    // OpenRouter-specific headers
    if (providerName === 'openrouter') {
      headers['HTTP-Referer'] = this.config.siteUrl || 'https://github.com/webbrain-one/webbrain';
      headers['X-Title'] = 'WebBrain';
    }
    if (providerName === 'cloudflare') {
      const configuredGatewayId = String(this.config.gatewayId || '').trim();
      const gatewayId = configuredGatewayId
        || (String(this.model || '').trim().startsWith('@cf/') ? 'default' : '');
      if (gatewayId) headers['cf-aig-gateway-id'] = gatewayId;
    }
    if (providerName === 'opencode-go') {
      headers['x-opencode-session'] = this._opencodeSessionId(options);
    }
    return headers;
  }

  // OpenCode Go rejects requests that omit x-opencode-session. Prefer the
  // per-conversation id from the agent so routing and prompt caching stay
  // stable within a chat; fall back to a per-provider id for calls without a
  // conversation (for example Test connection).
  _opencodeSessionId(options = {}) {
    const provided = String(options.providerSessionId || '').trim();
    if (provided) return provided;
    if (!this._opencodeSessionFallback) {
      this._opencodeSessionFallback = `webbrain-${crypto.randomUUID()}`;
    }
    return this._opencodeSessionFallback;
  }

  async sendRuntimeEvents(sessionId, events, { timeoutMs = 2500 } = {}) {
    if (String(this.config.providerName || '').toLowerCase() !== 'webbrain-cloud') {
      return { ok: false, retryable: false, status: 0 };
    }
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), Math.max(250, timeoutMs)) : null;
    try {
      const response = await fetchWithFallback(`${this.baseUrl}/improvement/runtime-events`, {
        method: 'POST',
        headers: this._headers(),
        body: JSON.stringify({ session_id: String(sessionId || ''), events }),
        ...(controller ? { signal: controller.signal } : {}),
      });
      if (response.ok) return { ok: true, retryable: false, status: response.status };
      try { await response.text(); } catch {}
      return {
        ok: false,
        retryable: response.status === 408 || response.status === 429 || response.status >= 500,
        status: response.status,
      };
    } catch {
      return { ok: false, retryable: true, status: 0 };
    } finally {
      if (timer != null) clearTimeout(timer);
    }
  }

  /**
   * Transport for the voluntary per-provider "share queries for research"
   * outbox. Only ever called on the WebBrain Compass provider instance (the
   * share outbox routes through it because the backend lives on the WebBrain
   * API). Consent is forced on for this call: the share_ session is what the
   * user opted into by enabling the per-provider toggle, independent of the
   * global Help Improve WebBrain switch.
   */
  async sendShareGeneration(sessionId, payload, { timeoutMs = 4000 } = {}) {
    if (String(this.config.providerName || '').toLowerCase() !== 'webbrain-cloud') {
      return { ok: false, retryable: false, status: 0 };
    }
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), Math.max(250, timeoutMs)) : null;
    try {
      const response = await fetchWithFallback(`${this.baseUrl}/improvement/generations`, {
        method: 'POST',
        headers: this._headers({ helpImprove: '1' }),
        body: JSON.stringify({ session_id: String(sessionId || ''), ...payload }),
        ...(controller ? { signal: controller.signal } : {}),
      });
      if (response.ok) return { ok: true, retryable: false, status: response.status };
      try { await response.text(); } catch {}
      return {
        ok: false,
        retryable: response.status === 408 || response.status === 429 || response.status >= 500,
        status: response.status,
      };
    } catch {
      return { ok: false, retryable: true, status: 0 };
    } finally {
      if (timer != null) clearTimeout(timer);
    }
  }

  async sendShareDiagnostic(sessionId, diagnostic, { timeoutMs = 4000 } = {}) {
    if (String(this.config.providerName || '').toLowerCase() !== 'webbrain-cloud') {
      return { ok: false, retryable: false, status: 0 };
    }
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), Math.max(250, timeoutMs)) : null;
    try {
      const response = await fetchWithFallback(`${this.baseUrl}/improvement/diagnostic-traces`, {
        method: 'POST',
        headers: this._headers({ helpImprove: '1' }),
        body: JSON.stringify({ session_id: String(sessionId || ''), diagnostic }),
        ...(controller ? { signal: controller.signal } : {}),
      });
      if (response.ok) return { ok: true, retryable: false, status: response.status };
      try { await response.text(); } catch {}
      // Keep the durable outbox entry while an older Cloud deployment lacks
      // this newer endpoint; it will be retried after the server rolls out.
      return { ok: false, retryable: response.status === 404 || response.status === 408 || response.status === 429 || response.status >= 500, status: response.status };
    } catch {
      return { ok: false, retryable: true, status: 0 };
    } finally {
      if (timer != null) clearTimeout(timer);
    }
  }

  /**
   * Newer OpenAI models (gpt-5 and the o-series) reject `max_tokens` and any
   * non-default `temperature`, requiring `max_completion_tokens`. Detected by
   * model id via the shared `isNewOpenAIContractModel` helper (also used by
   * the settings Compatibility panel so the display and the wire contract
   * stay in sync). Local OpenAI-compatible servers and LM Studio keep the
   * legacy contract.
   */
  _isNewOpenAIContract() {
    return isNewOpenAIContractConfig(this.config);
  }

  _addMaxTokens(body, options) {
    // Prefer configured max-token field when set; otherwise preserve the
    // existing OpenAI new-contract vs legacy default.
    const fallback = this._isNewOpenAIContract() ? 'max_completion_tokens' : 'max_tokens';
    this._addConfiguredMaxTokens(body, options, fallback);
  }

  _addTemperature(body, options) {
    // GPT-5, supported GPT-6, and o-series models only accept the default
    // temperature. Provider configs can impose
    // the same omission for fixed-temperature models such as Kimi K2.5/K3.
    // In both cases, let the API apply its required default.
    if (requiresOpenAIDefaultTemperature({
      ...this.config,
      providerName: this.config.providerName || this.name,
      baseUrl: this.baseUrl,
      model: this.model,
    }) || this.config.omitTemperature) return;
    body.temperature = options.temperature ?? 0.7;
  }

  _webbrainSubscribeUrl() {
    const url = new URL('https://webbrain.one/subscribe');
    if (this.config.deviceGuid) {
      url.searchParams.set('client_reference_id', this.config.deviceGuid);
    }
    return url.toString();
  }

  _webbrainAccountUrl() {
    const url = new URL('https://api.webbrain.one/account');
    if (this.config.deviceGuid) {
      url.searchParams.set('client_reference_id', this.config.deviceGuid);
    }
    return url.toString();
  }

  _formatHttpError(status, body) {
    const providerName = (this.config.providerName || '').toLowerCase();
    if (status === 402 && providerName === 'webbrain-cloud') {
      let actionUrl = this._webbrainSubscribeUrl();
      let actionLabel = 'Subscribe for more usage';
      let message = 'Weekly free WebBrain Compass allowance used.';
      try {
        const parsed = JSON.parse(body || '{}');
        if (parsed.error?.code === 'webbrain_cloud_payment_failed') {
          actionUrl = parsed.manage_billing_url || this._webbrainAccountUrl();
          actionLabel = 'Update payment method';
        } else if (parsed.upgrade_url) {
          actionUrl = parsed.upgrade_url;
          actionLabel = 'Upgrade to WebBrain Plus';
        } else if (parsed.subscribe_url) {
          actionUrl = parsed.subscribe_url;
        } else if (parsed.error?.code === 'webbrain_cloud_plus_tier_exceeded') {
          actionUrl = '';
        }
        message = parsed.error?.message || message;
      } catch { /* keep fallback */ }
      return actionUrl ? `${message}\n${actionLabel}: ${actionUrl}` : message;
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

  _httpError(status, body, prefix, retryAfter = null) {
    const error = this._httpStatusError(`${prefix}: ${this._formatHttpError(status, body)}`, status, retryAfter);
    try {
      const parsed = JSON.parse(body || '{}');
      const providerCode = parsed?.error?.code;
      if (status === 402 && (this.config.providerName || '').toLowerCase() === 'webbrain-cloud') {
        error.quota = { code: providerCode, usage: parsed.usage || {},
          subscribe_url: parsed.subscribe_url || this._webbrainSubscribeUrl(),
          upgrade_url: parsed.upgrade_url, manage_billing_url: parsed.manage_billing_url };
      }
      if (typeof providerCode === 'string' && providerCode) error.code = providerCode;
    } catch { /* keep the formatted HTTP error without provider metadata */ }
    return error;
  }

  _shouldRequestStreamUsage() {
    const providerName = (this.config.providerName || '').toLowerCase();
    if (this.config.category === 'local') return false;
    if (providerName === 'ollama' || providerName === 'lmstudio') return false;
    // Mistral's generated endpoint table omits stream_options, but its current
    // Known Limitations page explicitly requires stream_options.include_usage:
    // https://docs.mistral.ai/resources/known-limitations
    // Override stale stored snapshots so Ask cost allowances remain metered.
    if (providerName === 'mistral') return true;
    if (this.config.supportsStreamUsageOptions != null) {
      return !!this.config.supportsStreamUsageOptions;
    }
    if (!providerName && this.baseUrl === 'https://api.openai.com/v1') return true;
    return providerName === 'openai'
      || providerName === 'openrouter'
      || providerName === 'gemini';
  }

  _addStreamUsageOptions(body) {
    if (!this._shouldRequestStreamUsage()) return;
    const streamOptions = body.stream_options && typeof body.stream_options === 'object'
      ? body.stream_options
      : {};
    body.stream_options = { ...streamOptions, include_usage: true };
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
    const runtimeConfig = normalizeRuntimeTraceConfig(options.webbrainRuntimeConfig);
    if (generationName || runtimeConfig) {
      const trace = body.trace && typeof body.trace === 'object' && !Array.isArray(body.trace)
        ? body.trace
        : {};
      body.trace = {
        ...trace,
        ...(generationName ? { generation_name: generationName.slice(0, 64) } : {}),
        ...(runtimeConfig ? { runtime_config: runtimeConfig } : {}),
      };
    }
  }

  /**
   * GPT-5.6 combines reasoning and function tools through the Responses API,
   * while supported GPT-5 Pro variants are Responses-only. Other OpenAI models
   * and compatible providers retain their existing Chat Completions wire
   * format.
   */
  _usesResponsesApi() {
    return shouldUseOpenAIResponsesApi({
      ...this.config,
      providerName: this.config.providerName || this.name,
      baseUrl: this.baseUrl,
      model: this.model,
    });
  }

  _supportsInteractiveAskStreaming() {
    const resolved = {
      ...this.config,
      providerName: this.config.providerName || this.name,
      baseUrl: this.baseUrl,
      model: this.model,
    };
    // DashScope rejects `tools` together with `stream: true`, while Ask always
    // supplies its read-only tool catalog. Keep even stale/imported opt-ins on
    // the safe non-streaming path.
    if ([
      'alibaba',
      'alibaba-coding-plan',
      'alibaba-coding-plan-cn',
    ].includes(String(resolved.providerName || '').trim().toLowerCase())) {
      return false;
    }
    if (isOfficialOpenAIConfig(resolved)) {
      return supportsOpenAIAskStreaming(resolved);
    }
    return super._supportsInteractiveAskStreaming();
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
    options = mandatoryReasoningOptions({ ...this.config, baseUrl: this.baseUrl, model: this.model }, options);
    options = qwenToolOptions({ ...this.config, baseUrl: this.baseUrl, model: this.config.model || '' }, options);
    options = openRouterMuseToolOptions({ ...this.config, baseUrl: this.baseUrl, model: this.model }, options);
    if (this.requiresPromptedTools) {
      const prompted = openRouterDolphinPromptedTools(messages, options);
      messages = prompted.messages;
      options = prompted.options;
    }
    let body = {
      messages: this._chatMessages(messages, options),
      stream,
    };
    if (this.model) body.model = this.model;
    this._addTemperature(body, options);
    this._addMaxTokens(body, options);
    if (this._shouldSendTools(messages, options)) {
      body.tools = options.tools;
      body.tool_choice = options.toolChoice || 'auto';
    }
    body = this._mergeConfiguredRequestBody(body, options);
    body = applyOpenRouterRoutingVariant(body, this.config);
    this._addWebBrainCloudContext(body, options);
    if (stream && body.tools && this.config.supportsToolStreamOption === true) {
      body.tool_stream = true;
    }
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
    options = openRouterMuseToolOptions({ ...this.config, baseUrl: this.baseUrl, model: this.model }, options);
    let body = {
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
    if (this.model) body.model = this.model;

    if (this._shouldSendTools(messages, options)) {
      body.tools = this._responsesTools(options.tools);
      body.tool_choice = this._responsesToolChoice(options.toolChoice);
    }

    // Merge configured compatibility extras (and safe extraBody) after the
    // base Responses shape. Reserved keys like model/input/stream/tools are
    // filtered out by mergeProviderRequestBody.
    body = this._mergeConfiguredRequestBody(body, options);
    body = applyOpenRouterRoutingVariant(body, this.config);

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
    const normalizedModel = String(this.model || '').trim().toLowerCase();
    if (/^gpt-5-pro(?:$|-\d{4}-\d{2}-\d{2}$)/.test(normalizedModel)) {
      // GPT-5 Pro only accepts high reasoning effort.
      body.reasoning.effort = 'high';
    } else if (
      /^gpt-6\.1-sol(?:$|[-_.:])/.test(normalizedModel)
      && !['low', 'medium', 'high', 'xhigh', 'max'].includes(body.reasoning.effort)
    ) {
      // GPT-6.1 Sol rejects `none` and `minimal`, including the compact
      // classifier override used by plannerRequestBody.
      body.reasoning.effort = 'low';
    } else if (
      /^gpt-5\.(?:2|4|5)-pro(?:$|-\d{4}-\d{2}-\d{2}$)/.test(normalizedModel)
      && !['medium', 'high', 'xhigh'].includes(body.reasoning.effort)
    ) {
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
    error.isResponsesStreamFallbackSafe = !!stream && reason === 'missing_response_completed';
    error.isOpenAIAskStreamFallbackSafe = error.isResponsesStreamFallbackSafe;
    error.isAskStreamFallbackSafe = error.isResponsesStreamFallbackSafe;
    error.isAskStreamTerminalError = !!stream && !error.isResponsesStreamFallbackSafe;
    error.incomplete = true;
    error.incompleteReason = reason;
    return error;
  }

  _responsesStreamTransportError(message) {
    const error = new Error(message);
    error.isResponsesStreamError = true;
    error.isResponsesStreamFallbackSafe = true;
    error.isOpenAIAskStreamFallbackSafe = true;
    error.isAskStreamFallbackSafe = true;
    return error;
  }

  _chatCompletionsStreamTransportError(message) {
    const error = this._askStreamTransportError(message);
    error.isChatCompletionsStreamError = true;
    error.isOpenAIAskStreamFallbackSafe = error.isAskStreamFallbackSafe;
    return error;
  }

  _chatCompletionsStreamApiError(data) {
    const detail = data?.error?.message
      || data?.message
      || data?.error?.code
      || 'The provider reported an error while streaming.';
    const providerError = data?.error && typeof data.error === 'object'
      ? data.error
      : { ...data, message: data?.message || String(data?.error || '') };
    return this._withProviderError(this._chatCompletionsStreamTerminalError(
      `${this.name} Chat Completions stream error: ${detail}`,
    ), providerError);
  }

  _chatCompletionsStreamTerminalError(message) {
    const error = this._askStreamTerminalError(message);
    error.isChatCompletionsStreamError = true;
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
      throw this._withProviderError(new Error(message), data?.error);
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
      res = await fetchWithFallback(url, {
        method: 'POST',
        headers: this._headers(options),
        body: JSON.stringify(this._responsesBody(messages, options, false)),
        ...this._chatAbortOptions(options),
      });
    } catch (e) {
      this._rethrowAbortedChat(e, options);
      throw new Error(`${this.name} network error — could not reach ${url} (${e.message}). Is the server running?`);
    }
    if (!res.ok) {
      let err = '';
      try { err = await this._readErrorResponse(res, 500, options); } catch (error) { this._rethrowAbortedChat(error, options); }
      throw this._httpError(res.status, err, `${this.name} error ${res.status}`, res.headers?.get?.('retry-after'));
    }
    let data;
    try { data = await res.json(); } catch (error) {
      this._rethrowAbortedChat(error, options);
      throw new Error(`${this.name} returned invalid JSON in Responses response.`);
    }
    return this._responsesResult(data);
  }

  async *_chatResponsesStream(messages, options) {
    const url = this._responsesUrl();
    let res;
    try {
      res = await fetchWithFallback(url, {
        method: 'POST',
        headers: this._headers(options),
        body: JSON.stringify(this._responsesBody(messages, options, true)),
        signal: options.signal,
      });
    } catch (e) {
      this._rethrowAbortedChat(e, options);
      throw this._responsesStreamTransportError(
        `${this.name} network error — could not reach ${url} (${e.message}). Is the server running?`,
      );
    }
    if (!res.ok) {
      const err = await this._readErrorResponse(res, 1200, options);
      const streamError = this._httpError(res.status, err, `${this.name} stream error ${res.status}`, res.headers?.get?.('retry-after'));
      streamError.isResponsesStreamError = true;
      throw streamError;
    }

    if (!res.body?.getReader) {
      throw this._responsesStreamTransportError(`${this.name} Responses stream returned no readable body.`);
    }

    let reader;
    try {
      reader = await this._openStreamReader(res, options);
    } catch (error) {
      this._rethrowAbortedChat(error, options);
      throw this._responsesStreamTransportError(
        `${this.name} Responses stream could not open its response body (${error?.message || 'reader unavailable'}).`,
      );
    }
    try {
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
        let chunk;
        try {
          chunk = await reader.read();
        } catch (error) {
          this._rethrowAbortedChat(error, options);
          throw this._responsesStreamTransportError(
            `${this.name} Responses stream transport error (${error?.message || 'read failed'}).`,
          );
        }
        const { done, value } = chunk;
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          const payload = sseDataPayload(line);
          if (payload == null) continue;
          if (payload.trim() === '[DONE]') {
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
              const finishReason = response.finish_reason ?? response.stop_reason;
              yield {
                type: 'done',
                content: '',
                responseItems: response.output || [],
                ...(finishReason != null ? { finishReason: String(finishReason) } : {}),
              };
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
              const streamError = this._withProviderError(
                this._askStreamTerminalError(message),
                event.response?.error || event.error || event,
              );
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
    } finally {
      reader.close();
    }
  }

  async chat(messages, options = {}) {
    if (this._usesResponsesApi()) {
      return this._chatResponses(messages, options);
    }
    const body = this._buildChatCompletionsBody(messages, options, false);
    const url = `${this.baseUrl}/chat/completions`;
    let res;
    try {
      res = await fetchWithFallback(url, {
        method: 'POST',
        headers: this._headers(options),
        body: JSON.stringify(body),
        ...this._chatAbortOptions(options),
      });
    } catch (e) {
      this._rethrowAbortedChat(e, options);
      throw new Error(`${this.name} network error — could not reach ${url} (${e.message}). Is the server running?`);
    }

    if (!res.ok) {
      let err = '';
      try { err = await this._readErrorResponse(res, 500, options); } catch (error) { this._rethrowAbortedChat(error, options); }
      throw this._httpError(res.status, err, `${this.name} error ${res.status}`, res.headers?.get?.('retry-after'));
    }

    let data;
    try { data = await res.json(); } catch (error) {
      this._rethrowAbortedChat(error, options);
      throw new Error(`${this.name} returned invalid JSON in chat response.`);
    }
    const message = this._chatCompletionMessage(data);
    const replayItems = openRouterReplayItems(
      { ...this.config, baseUrl: this.baseUrl, model: this.model }, message?.reasoning_details, message?.tool_calls,
    );

    const result = normalizeQwenToolResult(
      { ...this.config, baseUrl: this.baseUrl, model: this.config.model || '' },
      { ...options, tools: body.tools, toolChoice: body.tool_choice },
      {
        content: message?.content || '',
        reasoningContent: message?.reasoning_content || message?.reasoning || '',
        toolCalls: message?.tool_calls || null,
        ...(replayItems ? { responseItems: replayItems } : {}),
        usage: data.usage || null,
        finishReason: String(data?.choices?.[0]?.finish_reason || ''),
        raw: data,
      },
    );
    return this.requiresPromptedTools ? normalizeDolphinPromptedResult(options, result) : result;
  }

  async *chatStream(messages, options = {}) {
    if (this._usesResponsesApi()) {
      yield* this._chatStreamNative(messages, options);
      return;
    }
    const body = this._buildChatCompletionsBody(messages, options, true);
    if (this.requiresPromptedTools) {
      yield* normalizeDolphinPromptedStream(options, this._chatStreamNative(messages, options, body));
      return;
    }
    yield* normalizeQwenToolStream(
      { ...this.config, baseUrl: this.baseUrl, model: this.config.model || '' },
      { ...options, tools: body.tools, toolChoice: body.tool_choice },
      this._chatStreamNative(messages, options, body),
    );
  }

  async *_chatStreamNative(messages, options = {}, preparedBody = null) {
    if (this._usesResponsesApi()) {
      yield* this._chatResponsesStream(messages, options);
      return;
    }
    const body = preparedBody || this._buildChatCompletionsBody(messages, options, true);
    const streamUrl = `${this.baseUrl}/chat/completions`;
    let res;
    try {
      res = await fetchWithFallback(streamUrl, {
        method: 'POST',
        headers: this._headers(options),
        body: JSON.stringify(body),
        signal: options.signal,
      });
    } catch (e) {
      this._rethrowAbortedChat(e, options);
      throw this._chatCompletionsStreamTransportError(
        `${this.name} network error — could not reach ${streamUrl} (${e.message}). Is the server running?`,
      );
    }

    if (!res.ok) {
      const err = await this._readErrorResponse(res, 1200, options);
      throw this._httpError(res.status, err, `${this.name} stream error ${res.status}`, res.headers?.get?.('retry-after'));
    }

    if (!res.body?.getReader) {
      throw this._chatCompletionsStreamTransportError(
        `${this.name} Chat Completions stream returned no readable body.`,
      );
    }

    let reader;
    try {
      reader = await this._openStreamReader(res, options);
    } catch (error) {
      this._rethrowAbortedChat(error, options);
      throw this._chatCompletionsStreamTransportError(
        `${this.name} Chat Completions stream could not open its response body (${error?.message || 'reader unavailable'}).`,
      );
    }
    try {
      const decoder = new TextDecoder();
      let buffer = '';
      let finalUsage = null;
      let sawTerminalFinish = false;
      let terminalFinishReason = '';
      const keepReasoningReplay = this._reasoningReplayIdentity() !== null;
      const reasoningDetails = [];
      const replayCalls = new Map();
      const replayItems = () => openRouterReplayItems(
        { ...this.config, baseUrl: this.baseUrl, model: this.model }, reasoningDetails,
        [...replayCalls.entries()].sort(([a], [b]) => a - b).map(([, call]) => call),
      );

      while (true) {
        let chunk;
        try {
          chunk = await reader.read();
        } catch (error) {
          this._rethrowAbortedChat(error, options);
          if (finalUsage) yield { type: 'usage', usage: finalUsage };
          throw this._chatCompletionsStreamTransportError(
            `${this.name} Chat Completions stream transport error (${error?.message || 'read failed'}).`,
          );
        }
        const { done, value } = chunk;
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          const payload = sseDataPayload(line);
          if (payload == null) continue;
          if (payload.trim() === '[DONE]') {
            if (finalUsage) yield { type: 'usage', usage: finalUsage };
            yield {
              type: 'done',
              content: '',
              ...(terminalFinishReason ? { finishReason: terminalFinishReason } : {}),
              ...(replayItems() ? { responseItems: replayItems() } : {}),
            };
            return;
          }
          let json;
          try {
            json = JSON.parse(payload);
          } catch (error) {
            if (this._supportsInteractiveAskStreaming()) {
              throw this._chatCompletionsStreamTransportError(
                `${this.name} Chat Completions stream returned malformed JSON (${error?.message || 'parse failed'}).`,
              );
            }
            console.warn(`[${this.name}] malformed SSE chunk skipped:`, payload?.slice(0, 120), error?.message);
            continue;
          }
          if (json?.error) {
            throw this._chatCompletionsStreamApiError(json);
          }
          const streamUsage = json.usage || json.x_groq?.usage;
          if (streamUsage) {
            finalUsage = streamUsage;
          }
          const choice = json.choices?.[0];
          if (choice?.finish_reason === 'content_filter') {
            throw this._chatCompletionsStreamTerminalError(
              `${this.name} Chat Completions stream was blocked by the provider content filter.`,
            );
          }
          const finishReason = choice?.finish_reason;
          if (
            String(this.config.providerName || '').toLowerCase() === 'z_ai'
            && Z_AI_STREAM_TERMINAL_FINISH_REASONS.has(finishReason)
          ) {
            throw this._chatCompletionsStreamTerminalError(
              `${this.name} Chat Completions stream failed with terminal finish reason "${finishReason}".`,
            );
          }
          if (finishReason != null) {
            sawTerminalFinish = true;
            terminalFinishReason = String(finishReason);
          }
          const delta = choice?.delta;
          if (keepReasoningReplay) {
            accumulateReasoningDetails(reasoningDetails, delta?.reasoning_details);
            for (const call of delta?.tool_calls || []) {
              if (call.id) replayCalls.set(call.index ?? 0, { id: call.id });
            }
          }
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
      if (sawTerminalFinish) {
        yield { type: 'done', content: '', finishReason: terminalFinishReason, ...(replayItems() ? { responseItems: replayItems() } : {}) };
        return;
      }
      if (this._supportsInteractiveAskStreaming()) {
        throw this._chatCompletionsStreamTransportError(
          `${this.name} Chat Completions stream ended before the [DONE] sentinel.`,
        );
      }
      yield { type: 'done', content: '' };
    } finally {
      reader.close();
    }
  }
}
