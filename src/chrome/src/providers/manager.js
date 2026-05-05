import { LlamaCppProvider } from './llamacpp.js';
import { OpenAICompatibleProvider } from './openai.js';
import { AnthropicProvider, AnthropicOAuthProvider } from './anthropic.js';

/**
 * Manages LLM provider instances and persists configuration.
 */
export class ProviderManager {
  constructor() {
    this.providers = new Map();
    this.activeProviderId = null;
  }

  /**
   * Load saved configuration from chrome.storage.
   *
   * Merge semantics: defaults provide the SHAPE (which provider keys
   * exist), stored configs override per-key values where the user has
   * customized them. We MUST merge rather than treating stored as
   * authoritative — otherwise upgrades that introduce a new provider
   * entry (e.g. `claude_subscription` in v6.1) would never appear for
   * users who already have a `providers` object in storage. They'd
   * have to manually clear extension storage to see the new entry.
   *
   * Note we don't have a "delete provider" operation in the manager,
   * so spreading defaults can't resurrect a user-removed entry.
   */
  async load() {
    const data = await chrome.storage.local.get(['providers', 'activeProvider']);
    const stored = data.providers || {};
    const configs = { ...this._defaultConfigs(), ...stored };
    this.activeProviderId = data.activeProvider || 'llamacpp';

    this.providers.clear();
    for (const [id, config] of Object.entries(configs)) {
      this.providers.set(id, this._createProvider(id, config));
    }
  }

  /**
   * Save current configuration to chrome.storage.
   */
  async save() {
    const configs = {};
    for (const [id, provider] of this.providers) {
      configs[id] = provider.config;
    }
    await chrome.storage.local.set({
      providers: configs,
      activeProvider: this.activeProviderId,
    });
  }

  _defaultConfigs() {
    return {
      llamacpp: {
        type: 'llamacpp',
        label: 'llama.cpp (Local)',
        baseUrl: 'http://localhost:8080',
        model: '',
        supportsVision: false,
        enabled: true,
      },
      ollama: {
        type: 'openai',
        label: 'Ollama (Local)',
        providerName: 'ollama',
        baseUrl: 'http://localhost:11434/v1',
        model: 'llama3.1',
        apiKey: 'ollama',
        supportsVision: false,
        enabled: true,
      },
      lmstudio: {
        type: 'openai',
        label: 'LM Studio (Local)',
        providerName: 'lmstudio',
        baseUrl: 'http://localhost:1234/v1',
        model: '',
        apiKey: 'lm-studio',
        supportsVision: false,
        enabled: true,
      },
      openai: {
        type: 'openai',
        label: 'OpenAI',
        providerName: 'openai',
        baseUrl: 'https://api.openai.com/v1',
        model: 'gpt-5',
        apiKey: '',
        enabled: false,
      },
      openrouter: {
        type: 'openai',
        label: 'OpenRouter',
        providerName: 'openrouter',
        baseUrl: 'https://openrouter.ai/api/v1',
        model: 'anthropic/claude-sonnet-4',
        apiKey: '',
        enabled: false,
      },
      anthropic: {
        type: 'anthropic',
        label: 'Anthropic Claude',
        baseUrl: 'https://api.anthropic.com',
        model: 'claude-sonnet-4-6',
        apiKey: '',
        enabled: false,
      },
      // Subscription auth (OAuth) entry, kept distinct from the API-key
      // entry above so a user can have both configured and switch
      // between them. Tokens live in `chrome.storage.local` under
      // `anthropicOauthTokens` (see oauth-claude.js), not in this
      // config. Settings UI shows a "Sign in with Claude" button for
      // this provider instead of the API-key field.
      claude_subscription: {
        type: 'anthropic_oauth',
        label: 'Claude (Pro/Max subscription)',
        model: 'claude-sonnet-4-6',
        enabled: false,
      },
      openai_subscription: {
        type: 'openai',
        label: 'OpenAI (ChatGPT subscription)',
        providerName: 'openai',
        baseUrl: 'https://api.openai.com/v1',
        model: 'gpt-5',
        apiKey: '',
        enabled: false,
      },
      webbrain: {
        type: 'openai',
        label: 'WebBrain Cloud',
        providerName: 'webbrain',
        baseUrl: 'https://auth.webbrain.one/v1',
        model: 'openai/gpt-4o',
        apiKey: '',
        enabled: false,
      },
    };
  }

  _createProvider(id, config) {
    switch (config.type) {
      case 'llamacpp':
        return new LlamaCppProvider(config);
      case 'openai':
        return new OpenAICompatibleProvider(config);
      case 'anthropic':
        return new AnthropicProvider(config);
      case 'anthropic_oauth':
        return new AnthropicOAuthProvider(config);
      default:
        throw new Error(`Unknown provider type: ${config.type}`);
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
      const { visionModel } = await chrome.storage.local.get(['visionModel']);
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
    const merged = { ...this.providers.get(id)?.config, ...config };
    this.providers.set(id, this._createProvider(id, merged));
    await this.save();
  }

  /**
   * Get all provider configs for the settings UI.
   */
  getAll() {
    const result = {};
    for (const [id, provider] of this.providers) {
      result[id] = { id, ...provider.config };
    }
    return result;
  }

  /**
   * Test a specific provider's connection.
   */
  async testProvider(id) {
    const provider = this.providers.get(id);
    if (!provider) return { ok: false, error: 'Provider not found' };
    return provider.testConnection();
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
   * Fetch the list of installed models from a running Ollama server.
   * Uses the native /api/tags endpoint (not the OpenAI-compat /v1).
   */
  async listOllamaModels(id) {
    const provider = this.providers.get(id);
    if (!provider) return { ok: false, error: 'Provider not found' };
    const baseUrl = (provider.config.baseUrl || '').replace(/\/v1\/?$/, '').replace(/\/$/, '');
    if (!baseUrl) return { ok: false, error: 'Base URL is empty' };
    const url = `${baseUrl}/api/tags`;
    const { fetchWithFallback } = await import('./fetch-with-fallback.js');
    try {
      const res = await fetchWithFallback(url, { method: 'GET' });
      if (!res.ok) {
        const errBody = await res.text();
        if (res.status === 403) {
          return {
            ok: false,
            error:
              'Ollama returned 403 — set OLLAMA_ORIGINS="*" (or moz-extension://*,chrome-extension://*) and restart `ollama serve`.',
          };
        }
        return { ok: false, error: `HTTP ${res.status}: ${errBody}` };
      }
      const data = await res.json();
      const models = Array.isArray(data?.models)
        ? data.models.map((m) => m?.name).filter(Boolean)
        : [];
      return { ok: true, models };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }
}
