import { LlamaCppProvider } from './llamacpp.js';
import { OpenAICompatibleProvider } from './openai.js';
import { AnthropicProvider, AnthropicOAuthProvider } from './anthropic.js';

const WEBBRAIN_CLOUD_PROVIDER_ID = 'webbrain_cloud';
const WEBBRAIN_DEVICE_GUID_KEY = 'webbrainDeviceGuid';
const OPENROUTER_DEFAULT_MODEL = 'minimax/minimax-m3';
const OPENROUTER_LEGACY_DEFAULT_MODEL = 'stepfun/step-3.7-flash';
const SUPPORTED_PROVIDER_TYPES = new Set(['llamacpp', 'openai', 'anthropic', 'anthropic_oauth']);
const SAFE_PROVIDER_ID_RE = /^[A-Za-z0-9_-]+$/;
const ROUTER_PROVIDER_IDS = ['openrouter', 'cloudflare', 'nvidia', 'groq'];

/**
 * Manages LLM provider instances and persists configuration.
 */
export class ProviderManager {
  constructor() {
    this.providers = new Map();
    this.activeProviderId = null;
  }

  /**
   * Load saved configuration from browser.storage.
   *
   * Merge semantics: defaults provide the SHAPE (which provider keys
   * exist), stored configs override per-key values where the user has
   * customized them. Without the merge, upgrades that introduce a
   * new provider entry (e.g. `claude_subscription` in v6.1) would
   * never appear for users with a saved `providers` object — they'd
   * have to clear extension storage to see the new entry. There's no
   * Deprecated provider entries are filtered after the merge so removed
   * defaults do not stay visible forever for existing users.
   */
  async load() {
    const data = await browser.storage.local.get(['providers', 'activeProvider', WEBBRAIN_DEVICE_GUID_KEY]);
    const stored = this._migrateStoredProviderConfigs(data.providers || {});
    const defaults = this._defaultConfigs();
    const configs = {};
    for (const [id, config] of Object.entries(defaults)) {
      configs[id] = { ...config, ...this._storedDefaultOverride(config, stored[id]) };
    }
    for (const [id, config] of Object.entries(stored)) {
      if (!configs[id] && this._isSupportedProviderConfig(id, config)) configs[id] = config;
    }
    delete configs.webbrain;
    delete configs.openai_subscription;
    if (configs[WEBBRAIN_CLOUD_PROVIDER_ID]) {
      configs[WEBBRAIN_CLOUD_PROVIDER_ID].deviceGuid = await this._getDeviceGuid(data[WEBBRAIN_DEVICE_GUID_KEY]);
    }
    this.activeProviderId = ['webbrain', 'openai_subscription'].includes(data.activeProvider)
      ? WEBBRAIN_CLOUD_PROVIDER_ID
      : (data.activeProvider || WEBBRAIN_CLOUD_PROVIDER_ID);
    if (!configs[this.activeProviderId]) this.activeProviderId = WEBBRAIN_CLOUD_PROVIDER_ID;

    this.providers.clear();
    for (const [id, config] of Object.entries(configs)) {
      this.providers.set(id, this._createProvider(id, config));
    }
  }

  /**
   * Save current configuration to browser.storage.
   */
  async save() {
    const configs = {};
    for (const [id, provider] of this.providers) {
      configs[id] = provider.config;
    }
    await browser.storage.local.set({
      providers: configs,
      activeProvider: this.activeProviderId,
    });
  }

  _defaultConfigs() {
    return {
      webbrain_cloud: {
        type: 'openai',
        category: 'cloud',
        label: 'WebBrain Cloud',
        providerName: 'webbrain-cloud',
        baseUrl: 'https://api.webbrain.one/v1',
        model: 'webbrain-cloud 1.0',
        contextWindow: 256000,
        inputCostPerMillionUsd: 0.20,
        outputCostPerMillionUsd: 1.15,
        supportsStreamUsageOptions: true,
        supportsVision: true,
        // WebBrain Cloud proxies to OpenRouter, whose upstream models
        // (minimax, stepfun, …) handle tools + images together fine. Dropping
        // tools on image turns forced the model into prompt-based tool calling,
        // which leaks raw tool-call template tokens (e.g. `]<]minimax[>[`) into
        // content and never produces a tool_calls array. Keep tools on.
        omitToolsWhenImagesPresent: false,
        apiKey: '',
        enabled: true,
      },
      llamacpp: {
        type: 'llamacpp',
        category: 'local',
        label: 'llama.cpp (Local)',
        baseUrl: 'http://localhost:8080',
        model: '',
        contextWindow: 16384,
        // Default ON for local providers: in practice users who reach for
        // local OpenAI-compatible backends in 2026 are running multimodal
        // models (Qwen-VL, Llama 3.2-Vision, etc.). False-positives where a
        // text-only model is loaded with vision=true still work — the agent
        // just sends image_url blocks the model ignores. False-negatives
        // (vision-capable model loaded with vision=false) silently lose the
        // multimodal channel, which is the worse failure mode.
        supportsVision: true,
        enabled: true,
      },
      ollama: {
        type: 'openai',
        category: 'local',
        label: 'Ollama (Local)',
        providerName: 'ollama',
        baseUrl: 'http://localhost:11434/v1',
        model: '',
        contextWindow: 16384,
        apiKey: 'ollama',
        supportsVision: true,
        enabled: true,
      },
      lmstudio: {
        type: 'openai',
        category: 'local',
        label: 'LM Studio (Local)',
        providerName: 'lmstudio',
        baseUrl: 'http://localhost:1234/v1',
        model: '',
        contextWindow: 16384,
        apiKey: 'lm-studio',
        supportsVision: true,
        enabled: true,
      },
      jan: {
        type: 'openai',
        category: 'local',
        label: 'Jan (Local)',
        providerName: 'jan',
        baseUrl: 'http://localhost:1337/v1',
        model: '',
        contextWindow: 16384,
        apiKey: '',
        supportsVision: true,
        enabled: true,
      },
      vllm: {
        type: 'openai',
        category: 'local',
        label: 'vLLM (Local)',
        providerName: 'vllm',
        baseUrl: 'http://localhost:8000/v1',
        model: '',
        contextWindow: 16384,
        apiKey: '',
        supportsVision: true,
        enabled: true,
      },
      sglang: {
        type: 'openai',
        category: 'local',
        label: 'SGLang (Local)',
        providerName: 'sglang',
        baseUrl: 'http://localhost:30000/v1',
        model: '',
        contextWindow: 16384,
        apiKey: '',
        supportsVision: true,
        enabled: true,
      },
      openai: {
        type: 'openai',
        category: 'cloud',
        label: 'OpenAI',
        providerName: 'openai',
        baseUrl: 'https://api.openai.com/v1',
        model: 'gpt-5.5',
        inputCostPerMillionUsd: 5,
        outputCostPerMillionUsd: 22.5,
        supportsStreamUsageOptions: true,
        apiKey: '',
        apiKeyUrl: 'https://platform.openai.com/api-keys',
        enabled: false,
      },
      anthropic: {
        type: 'anthropic',
        category: 'cloud',
        label: 'Anthropic Claude',
        baseUrl: 'https://api.anthropic.com',
        model: 'claude-sonnet-4-6',
        inputCostPerMillionUsd: 3,
        outputCostPerMillionUsd: 15,
        apiKey: '',
        apiKeyUrl: 'https://console.anthropic.com/settings/keys',
        enabled: false,
      },
      gemini: {
        type: 'openai',
        category: 'cloud',
        label: 'Google Gemini',
        providerName: 'gemini',
        baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
        model: 'gemini-3.1-flash',
        supportsStreamUsageOptions: true,
        apiKey: '',
        enabled: false,
      },
      cloudflare: {
        type: 'openai',
        category: 'router',
        label: 'Cloudflare Workers AI',
        providerName: 'cloudflare',
        baseUrl: 'https://api.cloudflare.com/client/v4/accounts/{account_id}/ai/v1',
        model: '@cf/zai-org/glm-5.2',
        contextWindow: 262144,
        supportsStreamUsageOptions: false,
        accountId: '',
        apiKey: '',
        apiKeyUrl: 'https://dash.cloudflare.com/profile/api-tokens',
        enabled: false,
      },
      mistral: {
        type: 'openai',
        category: 'cloud',
        label: 'Mistral AI',
        providerName: 'mistral',
        baseUrl: 'https://api.mistral.ai/v1',
        model: 'mistral-large-latest',
        inputCostPerMillionUsd: 0.5,
        outputCostPerMillionUsd: 1.5,
        supportsStreamUsageOptions: false,
        apiKey: '',
        apiKeyUrl: 'https://console.mistral.ai/api-keys/',
        enabled: false,
      },
      deepseek: {
        type: 'openai',
        category: 'cloud',
        label: 'DeepSeek',
        providerName: 'deepseek',
        baseUrl: 'https://api.deepseek.com/v1',
        model: 'deepseek-v4-flash',
        contextWindow: 1000000,
        inputCostPerMillionUsd: 0.27,
        outputCostPerMillionUsd: 1.1,
        supportsStreamUsageOptions: true,
        apiKey: '',
        apiKeyUrl: 'https://platform.deepseek.com/api_keys',
        enabled: false,
      },
      xai: {
        type: 'openai',
        category: 'cloud',
        label: 'xAI Grok',
        providerName: 'xai',
        baseUrl: 'https://api.x.ai/v1',
        model: 'grok-4.3',
        inputCostPerMillionUsd: 1.25,
        outputCostPerMillionUsd: 2.5,
        apiKey: '',
        apiKeyUrl: 'https://console.x.ai/',
        enabled: false,
      },
      nvidia: {
        type: 'openai',
        category: 'router',
        label: 'Nvidia NIM',
        providerName: 'nvidia',
        baseUrl: 'https://integrate.api.nvidia.com/v1',
        model: 'meta/llama-3.1-8b-instruct',
        inputCostPerMillionUsd: 0.22,
        outputCostPerMillionUsd: 0.22,
        apiKey: '',
        apiKeyUrl: 'https://build.nvidia.com/',
        enabled: false,
      },
      groq: {
        type: 'openai',
        category: 'router',
        label: 'Groq',
        providerName: 'groq',
        baseUrl: 'https://api.groq.com/openai/v1',
        model: 'llama-3.3-70b-versatile',
        inputCostPerMillionUsd: 0.59,
        outputCostPerMillionUsd: 0.79,
        apiKey: '',
        apiKeyUrl: 'https://console.groq.com/keys',
        enabled: false,
      },
      minimax: {
        type: 'openai',
        category: 'cloud',
        label: 'MiniMax',
        providerName: 'minimax',
        baseUrl: 'https://api.minimax.chat/v1',
        model: 'minimax-m2.7',
        apiKey: '',
        apiKeyUrl: 'https://platform.minimaxi.com/user-center/basic-information/interface-key',
        enabled: false,
      },
      alibaba: {
        type: 'openai',
        category: 'cloud',
        label: 'Alibaba Cloud (Qwen)',
        providerName: 'alibaba',
        baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
        model: 'qwen-max',
        apiKey: '',
        apiKeyUrl: 'https://dashscope.console.aliyun.com/apiKey',
        enabled: false,
      },
      openrouter: {
        type: 'openai',
        category: 'router',
        label: 'OpenRouter',
        providerName: 'openrouter',
        baseUrl: 'https://openrouter.ai/api/v1',
        model: OPENROUTER_DEFAULT_MODEL,
        supportsStreamUsageOptions: true,
        apiKey: '',
        apiKeyUrl: 'https://openrouter.ai/keys',
        enabled: false,
      },
      // Subscription auth (OAuth) entry, kept distinct from the API-key
      // entry above so a user can have both configured. Tokens live in
      // `browser.storage.local` under `anthropicOauthTokens` (see
      // oauth-claude.js), not in this config.
      claude_subscription: {
        type: 'anthropic_oauth',
        category: 'cloud',
        label: 'Claude (Pro/Max subscription)',
        model: 'claude-sonnet-4-6',
        enabled: false,
      },
    };
  }

  _migrateStoredProviderConfigs(stored) {
    const migrated = { ...stored };
    if (migrated.openrouter?.model === OPENROUTER_LEGACY_DEFAULT_MODEL) {
      migrated.openrouter = {
        ...migrated.openrouter,
        model: OPENROUTER_DEFAULT_MODEL,
      };
    }
    // Existing installs stored omitToolsWhenImagesPresent:true for WebBrain
    // Cloud, which suppressed native tools on every screenshot turn and broke
    // tool calling. Force it off so the saved config picks up the new default.
    if (migrated.webbrain_cloud?.omitToolsWhenImagesPresent) {
      migrated.webbrain_cloud = {
        ...migrated.webbrain_cloud,
        omitToolsWhenImagesPresent: false,
      };
    }
    for (const id of ROUTER_PROVIDER_IDS) {
      if (migrated[id] && migrated[id].category !== 'router') {
        migrated[id] = {
          ...migrated[id],
          category: 'router',
        };
      }
    }
    return migrated;
  }

  _storedDefaultOverride(defaultConfig, storedConfig) {
    if (!storedConfig || typeof storedConfig !== 'object') return {};
    const override = { ...storedConfig };
    // Stored configs are user-writable extension state. A stale/corrupt `type`
    // on a built-in provider should not replace the known implementation class.
    if (override.type !== defaultConfig.type) delete override.type;
    return override;
  }

  _isSupportedProviderConfig(id, config) {
    return SAFE_PROVIDER_ID_RE.test(String(id || '')) &&
      !!config &&
      typeof config === 'object' &&
      SUPPORTED_PROVIDER_TYPES.has(config.type);
  }

  /**
   * Provider category for filter UI. See chrome/providers/manager.js for
   * the canonical doc. Categories: 'local' | 'cloud' | 'router'. Reads
   * config.category first; falls back to a per-id table so pre-7.3
   * stored configs classify correctly.
   */
  static categoryFor(id, config) {
    if (config && config.category) return config.category;
    if (config?.type === 'llamacpp') return 'local';
    if (['llamacpp', 'ollama', 'lmstudio', 'jan', 'vllm', 'sglang'].includes(id)) return 'local';
    if (ROUTER_PROVIDER_IDS.includes(id)) return 'router';
    return 'cloud';
  }

  _createProvider(id, config) {
    const normalizedConfig = {
      ...config,
      category: ProviderManager.categoryFor(id, config),
    };
    switch (normalizedConfig.type) {
      case 'llamacpp':
        return new LlamaCppProvider(normalizedConfig);
      case 'openai':
        return new OpenAICompatibleProvider(normalizedConfig);
      case 'anthropic':
        return new AnthropicProvider(normalizedConfig);
      case 'anthropic_oauth':
        return new AnthropicOAuthProvider(normalizedConfig);
      default:
        throw new Error(`Unknown provider type: ${normalizedConfig.type}`);
    }
  }

  /**
   * Get the currently active provider.
   */
  getActive() {
    const provider = this.providers.get(this.activeProviderId);
    if (!provider) {
      throw new Error(`No active provider: ${this.activeProviderId}`);
    }
    return provider;
  }

  /**
   * Get a dedicated vision provider if the user has configured one under
   * `visionModel` in storage. Returns an OpenAI-compatible provider instance
   * or null if not configured. Caller is responsible for falling back to the
   * active provider when this returns null.
   */
  async getVisionProvider() {
    try {
      const { visionModel } = await browser.storage.local.get(['visionModel']);
      if (!visionModel || !visionModel.baseUrl || !visionModel.model) return null;
      return new OpenAICompatibleProvider({
        type: 'openai',
        label: 'Vision Model',
        providerName: 'vision',
        baseUrl: visionModel.baseUrl,
        model: visionModel.model,
        apiKey: visionModel.apiKey || '',
        enabled: true,
        // Advertise vision support regardless of model-name heuristics — the
        // user explicitly configured this endpoint for vision.
        supportsVision: true,
      });
    } catch (e) {
      console.warn('[providers] getVisionProvider failed:', e);
      return null;
    }
  }

  /**
   * Switch the active provider.
   */
  async setActive(id) {
    if (!this.providers.has(id)) {
      throw new Error(`Provider not found: ${id}`);
    }
    this.activeProviderId = id;
    await this.save();
  }

  /**
   * Update a provider's configuration.
   */
  async updateProvider(id, config) {
    if (!this.providers.has(id)) {
      throw new Error(`Provider not found: ${id}`);
    }
    const current = this.providers.get(id).config;
    const merged = { ...current, ...this._storedDefaultOverride(current, config) };
    this.providers.set(id, this._createProvider(id, merged));
    await this.save();
  }

  /**
   * Get all provider configs for the settings UI. Each entry includes a
   * `category` field ('local' | 'cloud' | 'router') so the UI can filter
   * without re-deriving the classification.
   */
  getAll() {
    const result = {};
    for (const [id, provider] of this.providers) {
      const config = provider.config;
      result[id] = {
        id,
        ...config,
        category: ProviderManager.categoryFor(id, config),
      };
    }
    return result;
  }

  /**
   * Test a specific provider's connection.
   */
  async testProvider(id) {
    const provider = this.providers.get(id);
    if (!provider) return { ok: false, error: 'Provider not found' };
    const observedBaseUrl = provider.config.baseUrl;
    const candidates = this._baseUrlCandidates(provider.config);
    if (!candidates.length) return provider.testConnection();

    let firstFailure = null;
    for (const baseUrl of candidates) {
      const candidateProvider = baseUrl === observedBaseUrl
        ? provider
        : this._createProvider(id, { ...provider.config, baseUrl });
      const result = await candidateProvider.testConnection();
      if (result.ok) {
        if (baseUrl !== observedBaseUrl) {
          const updated = await this._updateProviderBaseUrl(id, baseUrl, observedBaseUrl);
          return updated ? { ...result, baseUrl } : result;
        }
        return result;
      }
      if (!firstFailure) firstFailure = result;
    }
    return firstFailure || { ok: false, error: 'Provider connection failed' };
  }

  /**
   * Test the optional dedicated vision provider's connection.
   */
  async testVisionProvider() {
    const provider = await this.getVisionProvider();
    if (!provider) return { ok: false, error: 'Vision model not configured' };
    return provider.testConnection();
  }

  /**
   * Test the optional dedicated transcription provider's connection.
   *
   * Hits <baseUrl>/models with the configured auth, which is the cheapest
   * round-trip that validates "the endpoint is reachable AND the key works"
   * without uploading actual audio. /v1/models is mandatory in the
   * OpenAI-compatible spec, so every Whisper-hosting provider exposes it.
   * If /models returns 200, /audio/transcriptions on the same base URL will
   * accept calls (modulo per-model availability — that's checked when the
   * actual transcription runs).
   *
   * NOTE: Firefox MV2 has no tab recorder today, so a configured
   * transcription endpoint is currently dormant. The UI + storage still
   * exist for parity and as a forward-looking setting for whenever a
   * Firefox recorder lands.
   */
  async testTranscriptionProvider() {
    const api = (typeof browser !== 'undefined' ? browser : chrome);
    let cfg;
    try {
      const stored = await api.storage.local.get(['transcriptionModel']);
      cfg = stored?.transcriptionModel;
    } catch (e) {
      return { ok: false, error: 'Failed to read transcription config: ' + e.message };
    }
    if (!cfg || !cfg.baseUrl || !cfg.model) {
      return { ok: false, error: 'Transcription model not configured (Base URL and Model are required).' };
    }
    const baseUrl = cfg.baseUrl.replace(/\/$/, '');
    const url = `${baseUrl}/models`;
    const headers = { 'Accept': 'application/json' };
    if (cfg.apiKey) headers['Authorization'] = `Bearer ${cfg.apiKey}`;
    try {
      const res = await fetch(url, { method: 'GET', headers });
      if (!res.ok) {
        let body = '';
        try { body = (await res.text()).slice(0, 300); } catch {}
        return { ok: false, error: `HTTP ${res.status}: ${body || res.statusText}` };
      }
      try {
        const data = await res.json();
        const ids = this._extractModelIds('openai-compatible', data) || [];
        const matches = ids.includes(cfg.model);
        return { ok: true, model: cfg.model, modelListed: matches, modelCount: ids.length };
      } catch {
        return { ok: true, model: cfg.model };
      }
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  /**
   * Fetch selectable models for local providers. Ollama uses its native
   * /api/tags endpoint; llama.cpp, LM Studio, Jan, vLLM, and SGLang use
   * OpenAI-compatible /v1/models.
   */
  async listProviderModels(id) {
    const provider = this.providers.get(id);
    if (!provider) return { ok: false, error: 'Provider not found' };
    if (!['llamacpp', 'ollama', 'lmstudio', 'jan', 'vllm', 'sglang'].includes(id)) {
      return { ok: false, error: 'Model loading is only supported for local providers' };
    }

    const observedBaseUrl = provider.config.baseUrl;
    const rawBaseUrl = (observedBaseUrl || '').trim().replace(/\/+$/, '');
    if (!rawBaseUrl) return { ok: false, error: 'Base URL is empty' };

    // LM Studio: prefer its native /api/v0/models, which (unlike the
    // OpenAI-compatible /v1/models) reports per-model load `state` and `type`.
    // The plain /v1/models lists the whole *downloaded* catalog with no load
    // info, so onboarding ended up offering every model (and even embeddings).
    // Here we surface only the model(s) actually loaded and drop embeddings;
    // if nothing is loaded we fall back to the full chat-model list so JIT
    // loading still works. If the native endpoint is unavailable (older LM
    // Studio), we fall through to /v1/models below.
    const headers = this._modelListHeaders(provider);

    if (id === 'lmstudio') {
      const host = rawBaseUrl.replace(/\/v1\/?$/, '');
      try {
        const res = await fetch(`${host}/api/v0/models`, { method: 'GET', headers });
        if (res.ok) {
          const models = this._extractLmStudioModels(await res.json());
          if (models.length) {
            const configBaseUrl = `${host}/v1`;
            const result = { ok: true, models };
            if (configBaseUrl !== observedBaseUrl) {
              if (await this._updateProviderBaseUrl(id, configBaseUrl, observedBaseUrl)) {
                result.baseUrl = configBaseUrl;
              }
            }
            return result;
          }
        }
      } catch { /* fall through to /v1/models */ }
    }

    let firstFailure = null;
    for (const candidate of this._modelListCandidates(id, rawBaseUrl)) {
      const url = id === 'ollama' ? `${candidate.requestBaseUrl}/api/tags` : `${candidate.requestBaseUrl}/models`;
      try {
        const res = await fetch(url, { method: 'GET', headers });
        if (!res.ok) {
          const errBody = await res.text();
          if (res.status === 403) {
            if (!firstFailure) firstFailure = {
              ok: false,
              error:
                'Ollama returned 403 - set OLLAMA_ORIGINS="*" (or moz-extension://*,chrome-extension://*) and restart `ollama serve`.',
            };
            continue;
          }
          if (!firstFailure) firstFailure = { ok: false, error: `HTTP ${res.status}: ${errBody}` };
          continue;
        }
        const data = await res.json();
        const models = this._extractModelIds(id, data);
        const result = { ok: true, models };
        if (candidate.configBaseUrl !== observedBaseUrl) {
          if (await this._updateProviderBaseUrl(id, candidate.configBaseUrl, observedBaseUrl)) {
            result.baseUrl = candidate.configBaseUrl;
          }
        }
        return result;
      } catch (e) {
        if (!firstFailure) firstFailure = { ok: false, error: e.message };
      }
    }
    return firstFailure || { ok: false, error: 'Failed to load models' };
  }

  async listOllamaModels(id) {
    return this.listProviderModels(id);
  }

  _modelListHeaders(provider) {
    const headers = { 'Accept': 'application/json' };
    const apiKey = provider?.config?.apiKey;
    if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
    return headers;
  }

  _baseUrlCandidates(config) {
    const raw = typeof config?.baseUrl === 'string' ? config.baseUrl : '';
    const trimmed = raw.trim();
    if (!trimmed) return [];

    const noTrailingSlash = trimmed.replace(/\/+$/, '');
    const withoutTerminalV1 = noTrailingSlash.replace(/\/v1$/i, '');
    const withTerminalV1 = /\/v1$/i.test(noTrailingSlash)
      ? noTrailingSlash
      : `${noTrailingSlash}/v1`;
    const rootBaseProviders = new Set(['llamacpp', 'anthropic']);
    const primary = rootBaseProviders.has(config?.type)
      ? [withoutTerminalV1, noTrailingSlash, trimmed, withTerminalV1]
      : [noTrailingSlash, trimmed, withTerminalV1, withoutTerminalV1];

    const candidates = [];
    const add = (value) => {
      if (value && !candidates.includes(value)) candidates.push(value);
    };
    for (const value of primary) add(value);
    for (const value of primary) {
      if (value && !value.endsWith('/')) add(`${value}/`);
    }
    return candidates;
  }

  _modelListCandidates(id, rawBaseUrl) {
    const root = rawBaseUrl.replace(/\/v1$/i, '');
    const openAiBase = /\/v1$/i.test(rawBaseUrl) ? rawBaseUrl : `${rawBaseUrl}/v1`;
    const candidates = [];
    const add = (requestBaseUrl, configBaseUrl) => {
      if (!requestBaseUrl || !configBaseUrl) return;
      if (candidates.some((candidate) =>
        candidate.requestBaseUrl === requestBaseUrl && candidate.configBaseUrl === configBaseUrl
      )) return;
      candidates.push({ requestBaseUrl, configBaseUrl });
    };

    if (id === 'ollama') {
      add(root, `${root}/v1`);
      add(rawBaseUrl, openAiBase);
      return candidates;
    }
    if (id === 'llamacpp') {
      add(`${root}/v1`, root);
      return candidates;
    }

    add(openAiBase, openAiBase);
    add(rawBaseUrl, rawBaseUrl);
    add(root, root);
    return candidates;
  }

  async _updateProviderBaseUrl(id, baseUrl, observedBaseUrl) {
    const current = this.providers.get(id);
    if (!current) return false;
    if (current.config.baseUrl === baseUrl) return true;
    if (observedBaseUrl !== undefined && current.config.baseUrl !== observedBaseUrl) return false;
    this.providers.set(id, this._createProvider(id, { ...current.config, baseUrl }));
    await this.save();
    return true;
  }

  _extractModelIds(id, data) {
    const source = id === 'ollama' ? data?.models : data?.data;
    if (!Array.isArray(source)) return [];
    const ids = source
      .map((m) => {
        if (typeof m === 'string') return m;
        return id === 'ollama' ? m?.name : m?.id;
      })
      .filter(Boolean);
    return [...new Set(ids)].sort((a, b) => a.localeCompare(b));
  }

  /**
   * Parse LM Studio's native /api/v0/models response, which carries a per-model
   * `state` ('loaded' | 'not-loaded') and `type` ('llm' | 'vlm' | 'embeddings').
   * We drop embeddings (not chat models) and, if any chat model is currently
   * loaded, return only the loaded one(s) — otherwise the full chat list so the
   * user can still pick one and let LM Studio JIT-load it.
   */
  _extractLmStudioModels(data) {
    const source = Array.isArray(data?.data) ? data.data : [];
    const chat = source.filter((m) => m && m.id && m.type !== 'embeddings');
    const loaded = chat.filter((m) => m.state === 'loaded');
    const pick = loaded.length ? loaded : chat;
    const ids = pick.map((m) => m.id).filter(Boolean);
    return [...new Set(ids)].sort((a, b) => a.localeCompare(b));
  }

  async _getDeviceGuid(storedGuid) {
    if (this._looksLikeGuid(storedGuid)) return storedGuid;
    const material = await this._deviceFingerprintMaterial();
    const guid = await this._guidFromMaterial(material);
    try {
      await browser.storage.local.set({ [WEBBRAIN_DEVICE_GUID_KEY]: guid });
    } catch (e) {
      console.warn('[providers] failed to persist device guid:', e);
    }
    return guid;
  }

  _looksLikeGuid(value) {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value || ''));
  }

  async _deviceFingerprintMaterial() {
    let platform = null;
    try {
      platform = await browser.runtime.getPlatformInfo();
    } catch {
      platform = null;
    }
    const nav = globalThis.navigator || {};
    return JSON.stringify({
      runtimeId: browser.runtime?.id || '',
      os: platform?.os || '',
      arch: platform?.arch || '',
      naclArch: platform?.nacl_arch || '',
      userAgent: nav.userAgent || '',
      platform: nav.platform || '',
      language: nav.language || '',
      languages: Array.isArray(nav.languages) ? nav.languages.join(',') : '',
      hardwareConcurrency: nav.hardwareConcurrency || '',
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || '',
    });
  }

  async _guidFromMaterial(material) {
    const bytes = new TextEncoder().encode(`webbrain-device-v1:${material}`);
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    const hex = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
    return [
      hex.slice(0, 8),
      hex.slice(8, 12),
      `5${hex.slice(13, 16)}`,
      `${(parseInt(hex.slice(16, 18), 16) & 0x3f | 0x80).toString(16).padStart(2, '0')}${hex.slice(18, 20)}`,
      hex.slice(20, 32),
    ].join('-');
  }
}
