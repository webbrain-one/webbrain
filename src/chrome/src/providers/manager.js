import { LlamaCppProvider } from './llamacpp.js';
import { OpenAICompatibleProvider } from './openai.js';
import { DeepSeekProvider } from './deepseek.js';
import { AzureOpenAIProvider } from './azure-openai.js';
import { AnthropicProvider, AnthropicOAuthProvider } from './anthropic.js';
import { VertexAnthropicProvider } from './vertex-anthropic.js';
import { signOutClaude } from './oauth-claude.js';
import { AwsBedrockProvider } from './aws-bedrock.js';
import {
  WebGPUProvider,
  WebGPUVisionProvider,
  WEBGPU_COMPASS_TINY_V2_MODEL_ID,
  WEBGPU_COMPASS_TINY_XS_V3_MODEL_ID,
  WEBGPU_DTYPE,
  WEBGPU_MODEL_ID,
  WEBGPU_RUNTIME_BITGPU,
  WEBGPU_VISION_AUTO_SELECTED_KEY,
  WEBGPU_VISION_CONSENT_VERSION,
  WEBGPU_VISION_CONSENT_VERSION_KEY,
  WEBGPU_VISION_DOWNLOAD_STATE_KEY,
  WEBGPU_VISION_ENABLED_KEY,
  WEBGPU_VISION_MODEL_ID,
  hasWebgpuVisionCache,
  normalizeWebgpuModelId,
  webgpuModelDisplayName,
  webgpuModelDtype,
  webgpuModelPreset,
  webgpuModelRuntime,
} from './webgpu.js';
import { ADDITIONAL_PROVIDER_DEFAULTS } from './provider-catalog.js';
import { purgeShareGenerations } from '../trace/webbrain-share-outbox.js';
import {
  DEEPSEEK_BASE_URL,
  DEEPSEEK_DEFAULT_MODEL,
  DEEPSEEK_LEGACY_DEFAULT_BASE_URL,
  DEEPSEEK_LEGACY_DEFAULT_MODEL,
  isDeepSeekModel,
} from './deepseek-config.js';
// Static, NOT dynamic: this module runs in the MV3 service worker, where
// `await import()` throws "import() is disallowed on ServiceWorkerGlobalScope".
// The provider modules above already import this statically, so it's in the SW
// bundle anyway. (A previous dynamic import here silently broke local model
// detection — listProviderModels/testTranscriptionProvider threw before the
// fetch ever ran, so onboarding reported "no models" for a reachable server.)
import { fetchWithFallback } from './fetch-with-fallback.js';
import {
  VISION_MODES,
  parseLlamaCppVisionSupport,
  parseLmStudioVisionSupport,
  parseLocalAiVisionSupport,
  visionCapabilityIdentity,
  visionDetectionMatches,
  visionDetectionSource,
  visionProviderKind,
} from './vision-capabilities.js';
import {
  canonicalizeOllamaBaseUrl,
  lmStudioContextWindowIsLive,
  parseLlamaCppPropsContextWindow,
  parseLocalAiModelConfigContextWindow,
  parseLmStudioModelsContextWindow,
  parseOllamaPsContextWindow,
  parseOllamaShowContextWindow,
  parseOllamaShowVisionSupport,
  parseOpenAiModelListContextWindow,
  shouldApplyDetectedContextWindow,
} from './context-windows.js';
import {
  isDirectDeepSeekConfig,
  normalizeOpenAICompatibleBaseUrl,
  openAiCompatiblePayloadError,
  unsupportedVisionGenerationControl,
  visionGenerationOptions,
} from './provider-compatibility.js';
import {
  loadTranscriptionConnectionTestAudio,
  loadVisionConnectionTestImage,
} from './connection-test-assets.js';

const WEBBRAIN_CLOUD_PROVIDER_ID = 'webbrain_cloud';
const WEBBRAIN_CLOUD_PROVIDER_LABEL = 'WebBrain Compass';
const DUPLICATE_PROVIDER_SUFFIX = '__duplicate';
const LOCAL_MODEL_LIST_PROVIDER_IDS = ['llamacpp', 'ollama', 'lmstudio', 'jan', 'vllm', 'sglang', 'localai', 'gpt4all', 'local_openai_proxy', 'unsloth'];
const WEBBRAIN_CLOUD_CONTEXT_WINDOW = 1000000;
const WEBBRAIN_CLOUD_LEGACY_CONTEXT_WINDOW = 256000;
const WEBBRAIN_DEVICE_GUID_KEY = 'webbrainDeviceGuid';
const HELP_IMPROVE_WEBBRAIN_KEY = 'helpImproveWebBrain';
const OPENROUTER_DEFAULT_MODEL = 'openrouter/free';
const OPENROUTER_LEGACY_DEFAULT_MODEL = 'stepfun/step-3.7-flash';
const OPENAI_DEFAULT_MODEL = 'gpt-5.6-terra';
const OPENAI_LEGACY_DEFAULT_MODEL = 'gpt-5.5';
const OPENCODE_LEGACY_DEFAULT_MODEL = 'ring-2.6-1t-free';
const SUPPORTED_PROVIDER_TYPES = new Set(['llamacpp', 'webgpu', 'openai', 'azure_openai', 'aws_bedrock', 'anthropic', 'anthropic_oauth', 'vertex_anthropic']);
const SAFE_PROVIDER_ID_RE = /^[A-Za-z0-9_-]+$/;
const ROUTER_PROVIDER_IDS = ['openrouter', 'cloudflare', 'nvidia', 'groq', 'huggingface', 'fireworks', 'together'];
const PROVIDER_CREDENTIAL_KEYS = ['apiKey', 'accessKeyId', 'secretAccessKey', 'sessionToken'];
const PROVIDER_COST_KEYS = [
  'inputCostPerMillionUsd',
  'cacheReadCostPerMillionUsd',
  'cacheWriteCostPerMillionUsd',
  'cacheWrite1hCostPerMillionUsd',
  'outputCostPerMillionUsd',
];
// Last-shipped-on-main snapshots this upgrade replaced. OpenAI and OpenRouter
// keep the special-case rules in _migrateStoredProviderConfigs instead.
const UNTOUCHED_DEFAULT_MIGRATIONS = [
  {
    id: 'anthropic',
    fromModel: 'claude-sonnet-4-6',
    fromCosts: {
      inputCostPerMillionUsd: 3,
      cacheReadCostPerMillionUsd: 0.3,
      cacheWriteCostPerMillionUsd: 3.75,
      cacheWrite1hCostPerMillionUsd: 6,
      outputCostPerMillionUsd: 15,
    },
  },
  { id: 'gemini', fromModel: 'gemini-3.1-flash' },
  {
    id: 'xai',
    fromModel: 'grok-4.3',
    fromCosts: {
      inputCostPerMillionUsd: 1.25,
      outputCostPerMillionUsd: 2.5,
    },
  },
  { id: 'minimax', fromModel: 'minimax-m2.7' },
  { id: 'kimi', fromModel: 'kimi-k2.5' },
  { id: 'alibaba', fromModel: 'qwen-max' },
  {
    id: 'mistral',
    fromModel: 'mistral-large-latest',
    fromCosts: {
      inputCostPerMillionUsd: 0.5,
      outputCostPerMillionUsd: 1.5,
    },
  },
  {
    id: 'z_ai',
    fromModel: 'glm-5.2',
    fromContextWindow: 1000000,
    fromCosts: {
      inputCostPerMillionUsd: 1.4,
      cacheReadCostPerMillionUsd: 0.26,
      outputCostPerMillionUsd: 4.4,
    },
  },
  {
    id: 'groq',
    fromModel: 'llama-3.3-70b-versatile',
    fromCosts: {
      inputCostPerMillionUsd: 0.59,
      outputCostPerMillionUsd: 0.79,
    },
  },
  {
    id: 'nvidia',
    fromModel: 'meta/llama-3.1-8b-instruct',
    fromCosts: {
      inputCostPerMillionUsd: 0.22,
      outputCostPerMillionUsd: 0.22,
    },
  },
  { id: 'together', fromModel: 'meta-llama/Llama-3.3-70B-Instruct-Turbo' },
  { id: 'huggingface', fromModel: 'zai-org/GLM-5.2' },
  { id: 'fireworks', fromModel: 'accounts/fireworks/models/llama-v3p3-70b-instruct' },
  {
    id: 'aws_bedrock',
    fromModel: '',
    fromCosts: {
      inputCostPerMillionUsd: 3,
      cacheReadCostPerMillionUsd: 0.3,
      cacheWriteCostPerMillionUsd: 3.75,
      cacheWrite1hCostPerMillionUsd: 6,
      outputCostPerMillionUsd: 15,
    },
  },
  {
    id: 'baseten',
    fromModel: 'moonshotai/Kimi-K2.6',
    fromContextWindow: 262000,
    fromCosts: {
      inputCostPerMillionUsd: 0.95,
      cacheReadCostPerMillionUsd: 0.16,
      outputCostPerMillionUsd: 4,
    },
  },
  {
    id: 'siliconflow',
    fromModel: 'moonshotai/Kimi-K2.6',
    fromContextWindow: 262000,
    fromCosts: {
      inputCostPerMillionUsd: 0.77,
      cacheReadCostPerMillionUsd: 0.2,
      outputCostPerMillionUsd: 4,
    },
  },
  {
    id: 'cohere',
    fromModel: 'command-a-03-2025',
    fromContextWindow: 256000,
    fromCosts: {
      inputCostPerMillionUsd: 2.5,
      outputCostPerMillionUsd: 10,
    },
  },
  {
    id: 'deepinfra',
    fromModel: 'meta-llama/Llama-4-Scout-17B-16E-Instruct',
    fromContextWindow: 327680,
    fromCosts: {
      inputCostPerMillionUsd: 0.1,
      outputCostPerMillionUsd: 0.3,
    },
  },
  { id: 'google-vertex', fromModel: 'gemini-2.5-flash', fromContextWindow: 1048576 },
  {
    id: 'google-vertex-anthropic',
    fromModel: 'claude-haiku-4-5@20251001',
    fromContextWindow: 200000,
    fromCosts: {
      inputCostPerMillionUsd: 1,
      cacheReadCostPerMillionUsd: 0.1,
      cacheWriteCostPerMillionUsd: 1.25,
      outputCostPerMillionUsd: 5,
    },
  },
  { id: 'minimax-coding-plan', fromModel: 'MiniMax-M2.1', fromContextWindow: 204800 },
  { id: 'minimax-cn-coding-plan', fromModel: 'MiniMax-M2.1', fromContextWindow: 204800 },
  { id: 'modelscope', fromModel: 'Qwen/Qwen3-30B-A3B-Thinking-2507', fromContextWindow: 262144 },
  {
    id: 'stepfun',
    fromModel: 'step-1-32k',
    fromContextWindow: 32768,
    fromCosts: {
      inputCostPerMillionUsd: 2.05,
      cacheReadCostPerMillionUsd: 0.41,
      outputCostPerMillionUsd: 9.59,
    },
  },
  { id: 'zai-coding-plan', fromModel: 'glm-4.7', fromContextWindow: 204800 },
  {
    id: 'zhipuai',
    fromModel: 'glm-5.1',
    fromContextWindow: 200000,
    fromCosts: {
      inputCostPerMillionUsd: 1.4,
      cacheReadCostPerMillionUsd: 0.26,
      outputCostPerMillionUsd: 4.4,
    },
  },
  { id: 'zhipuai-coding-plan', fromModel: 'glm-5.1', fromContextWindow: 200000 },
  // Model IDs unchanged; only the catalog vision flag flipped in this upgrade.
  { id: 'helicone', fromModel: 'chatgpt-4o-latest', fromSupportsVision: false },
  { id: 'vercel', fromModel: 'xai/grok-4.1-fast-reasoning', fromSupportsVision: false },
  { id: 'modelscope', fromModel: 'Qwen/Qwen3.8-27B', fromSupportsVision: false },
  { id: 'siliconflow', fromModel: 'moonshotai/Kimi-K3', fromSupportsVision: false },
  { id: 'minimax-coding-plan', fromModel: 'MiniMax-M3', fromSupportsVision: false },
  { id: 'minimax-cn-coding-plan', fromModel: 'MiniMax-M3', fromSupportsVision: false },
  { id: 'stepfun', fromModel: 'step-3.7-flash', fromSupportsVision: false },
];
const DUPLICATE_BLANK_CONFIG_KEYS = [
  ...PROVIDER_CREDENTIAL_KEYS,
  'baseUrl',
  'model',
  'contextWindow',
  'maxOutputTokens',
  'apiVersion',
  'region',
  'accountId',
  'gatewayId',
  'resource',
  'project',
  'location',
  'inputCostPerMillionUsd',
  'cacheReadCostPerMillionUsd',
  'cacheWriteCostPerMillionUsd',
  'cacheWrite1hCostPerMillionUsd',
  'outputCostPerMillionUsd',
  'promptTier',
  'routingVariant',
  'visionMode',
  'visionDetection',
  'supportsVision',
  'compat',
  'extraBody',
];
const OLLAMA_VISION_MODES = new Set(['auto', 'on', 'off']);
const OLLAMA_VISION_METADATA_TIMEOUT_MS = 3000;
const VISION_METADATA_TIMEOUT_MS = 3000;
const WEBGPU_VISION_STATUSES = new Set([
  'not-downloaded', 'queued', 'downloading', 'loading', 'ready', 'paused', 'error',
]);

/**
 * Manages LLM provider instances and persists configuration.
 */
export class ProviderManager {
  constructor() {
    this.providers = new Map();
    this.activeProviderId = null;
    this._ollamaVisionChecks = new Map();
    this._visionCapabilityChecks = new Map();
    this._visionCapabilityEpochs = new Map();
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
   * Deprecated provider entries are filtered after the merge so removed
   * defaults do not stay visible forever for existing users.
   */
  async load() {
    const data = await chrome.storage.local.get([
      'providers',
      'activeProvider',
      'visionModel',
      WEBBRAIN_DEVICE_GUID_KEY,
      HELP_IMPROVE_WEBBRAIN_KEY,
      WEBGPU_VISION_ENABLED_KEY,
      WEBGPU_VISION_AUTO_SELECTED_KEY,
      WEBGPU_VISION_CONSENT_VERSION_KEY,
    ]);
    await this._migrateWebgpuVisionConsent(data);
    const rawStoredOllama = data.providers?.ollama;
    const ollamaVisionConfigMigrated = !!rawStoredOllama && (
      !OLLAMA_VISION_MODES.has(rawStoredOllama.visionMode)
      || Object.hasOwn(rawStoredOllama, 'supportsVision')
    );
    const genericVisionConfigMigrated = Object.entries(data.providers || {}).some(([id, config]) => {
      return !!visionProviderKind(config?.duplicateOf || id, config) && (
        !VISION_MODES.has(config.visionMode)
        || Object.hasOwn(config, 'supportsVision')
        || (!String(config.model || '').trim() && config.visionDetection != null)
      );
    });
    const hadLegacyClaudeSubscription = Object.hasOwn(data.providers || {}, 'claude_subscription');
    const rawStoredProviders = data.providers || {};
    const stored = this._migrateStoredProviderConfigs(rawStoredProviders);
    const legacyActiveProviderId = ['webbrain', 'openai_subscription'].includes(data.activeProvider)
      ? WEBBRAIN_CLOUD_PROVIDER_ID
      : data.activeProvider;
    // Field-level merge: defaults provide the full shape (including new
    // fields like apiKeyUrl), stored values override individual fields
    // without dropping keys that don't exist in stored.
    const defaults = this._defaultConfigs();
    const configs = {};
    let providerStateMigrated = ollamaVisionConfigMigrated
      || genericVisionConfigMigrated
      || this._storedProviderConfigsChanged(rawStoredProviders, stored);
    for (const [id, config] of Object.entries(defaults)) {
      const storedConfig = stored[id];
      const hasConfiguredMarker = !!storedConfig && Object.hasOwn(storedConfig, 'configured');
      const configured = id !== WEBBRAIN_CLOUD_PROVIDER_ID && (
        storedConfig?.configured === true ||
        (!hasConfiguredMarker && !!storedConfig && (
          id === legacyActiveProviderId ||
          this._hasStoredProviderCredentials(config, storedConfig)
        ))
      );
      configs[id] = {
        ...config,
        ...this._storedDefaultOverride(config, storedConfig),
        configured,
      };
      // Voluntary research sharing is opt-in per provider and default-off
      // (never on for WebBrain Compass itself, which already shares via its
      // own outbox). Applied in the field-level merge so existing stored
      // configs without the key inherit the off state without polluting the
      // default catalog snapshots.
      if (id !== WEBBRAIN_CLOUD_PROVIDER_ID && !Object.hasOwn(configs[id], 'shareQueriesForResearch')) {
        configs[id].shareQueriesForResearch = false;
      }
      if (Object.hasOwn(configs[id], 'duplicateOf')) {
        delete configs[id].duplicateOf;
        providerStateMigrated = true;
      }
      if (storedConfig && !hasConfiguredMarker) providerStateMigrated = true;
    }
    // Carry over any stored-only entries (e.g. legacy provider ids).
    for (const [id, config] of Object.entries(stored)) {
      if (!configs[id] && this._isSupportedProviderConfig(id, config)) {
        const hasConfiguredMarker = Object.hasOwn(config, 'configured');
        configs[id] = {
          ...config,
          configured: id !== WEBBRAIN_CLOUD_PROVIDER_ID && (config.configured === true || !hasConfiguredMarker),
        };
        if (!hasConfiguredMarker) providerStateMigrated = true;
      }
    }
    for (const [id, config] of Object.entries(configs)) {
      if (config.duplicateOf && !this._isValidDuplicateConfig(id, config, configs)) {
        delete configs[id];
        providerStateMigrated = true;
      }
    }
    delete configs.webbrain;
    delete configs.openai_subscription;
    delete configs.claude_subscription;
    // The claude_subscription provider entry above is gone and its
    // settings-UI sign-out control with it, so purge any leftover OAuth
    // token bundle here — otherwise a previously-signed-in user's raw
    // access/refresh tokens would sit in storage with no UI path to clear them.
    if (hadLegacyClaudeSubscription) await signOutClaude();
    if (configs[WEBBRAIN_CLOUD_PROVIDER_ID]) {
      configs[WEBBRAIN_CLOUD_PROVIDER_ID].deviceGuid = await this._getDeviceGuid(data[WEBBRAIN_DEVICE_GUID_KEY]);
      configs[WEBBRAIN_CLOUD_PROVIDER_ID].helpImproveWebBrain = data[HELP_IMPROVE_WEBBRAIN_KEY] !== false;
    }
    this.activeProviderId = legacyActiveProviderId || WEBBRAIN_CLOUD_PROVIDER_ID;
    if (!configs[this.activeProviderId]) this.activeProviderId = WEBBRAIN_CLOUD_PROVIDER_ID;
    if (this.activeProviderId !== WEBBRAIN_CLOUD_PROVIDER_ID && configs[this.activeProviderId]?.configured !== true) {
      this.activeProviderId = WEBBRAIN_CLOUD_PROVIDER_ID;
      providerStateMigrated = true;
    }

    this.providers.clear();
    for (const [id, config] of Object.entries(configs)) {
      this.providers.set(id, this._createProvider(id, config));
    }
    // A persisted WebGPU selection can outlive its cache (Chrome eviction or
    // manual clear). Revalidate like setActive() does; otherwise chats fail
    // readiness indefinitely instead of using the Cloud fallback.
    if (this.activeProviderId === 'webgpu') {
      try {
        const download = await this.providers.get('webgpu')?.downloadStatus?.().catch(() => null);
        if (download && download.ready !== true) {
          await this.setActive(WEBBRAIN_CLOUD_PROVIDER_ID);
          providerStateMigrated = false; // setActive persisted the migrated configs too.
        }
      } catch {
        // Probe failures must not block startup; chat will report the missing download.
      }
    }
    if (providerStateMigrated) await this.save();
  }

  async _migrateWebgpuVisionConsent(data = {}) {
    if (data[WEBGPU_VISION_CONSENT_VERSION_KEY] === WEBGPU_VISION_CONSENT_VERSION) {
      if (data[WEBGPU_VISION_AUTO_SELECTED_KEY] != null) {
        await chrome.storage.local.remove(WEBGPU_VISION_AUTO_SELECTED_KEY);
        delete data[WEBGPU_VISION_AUTO_SELECTED_KEY];
      }
      return;
    }

    const legacyExplicitSelection = data.visionModel?.type === 'webgpu';
    if (legacyExplicitSelection) {
      await chrome.storage.local.set({
        [WEBGPU_VISION_CONSENT_VERSION_KEY]: WEBGPU_VISION_CONSENT_VERSION,
        [WEBGPU_VISION_ENABLED_KEY]: true,
      });
    }
    const removals = [];
    if (data[WEBGPU_VISION_AUTO_SELECTED_KEY] != null) removals.push(WEBGPU_VISION_AUTO_SELECTED_KEY);
    if (legacyExplicitSelection) removals.push('visionModel');
    else if (data[WEBGPU_VISION_ENABLED_KEY] != null) removals.push(WEBGPU_VISION_ENABLED_KEY);
    if (removals.length) await chrome.storage.local.remove(removals);

    if (legacyExplicitSelection) {
      data[WEBGPU_VISION_CONSENT_VERSION_KEY] = WEBGPU_VISION_CONSENT_VERSION;
    } else {
      delete data[WEBGPU_VISION_CONSENT_VERSION_KEY];
    }
    data[WEBGPU_VISION_ENABLED_KEY] = legacyExplicitSelection;
    delete data[WEBGPU_VISION_AUTO_SELECTED_KEY];
    if (legacyExplicitSelection) delete data.visionModel;
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
    const defaults = {
      webbrain_cloud: {
        type: 'openai',
        category: 'cloud',
        label: WEBBRAIN_CLOUD_PROVIDER_LABEL,
        providerName: 'webbrain-cloud',
        baseUrl: 'https://api.webbrain.one/v1',
        model: 'webbrain-cloud 1.0',
        contextWindow: WEBBRAIN_CLOUD_CONTEXT_WINDOW,
        inputCostPerMillionUsd: 0.20,
        outputCostPerMillionUsd: 1.15,
        supportsStreamUsageOptions: true,
        supportsAskStreaming: true,
        supportsVision: true,
        // WebBrain Compass proxies to OpenRouter, whose upstream models
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
        supportsAskStreaming: true,
        visionMode: 'auto',
        visionDetection: null,
        enabled: true,
      },
      ollama: {
        type: 'openai',
        category: 'local',
        label: 'Ollama (Local)',
        providerName: 'ollama',
        requiresModel: true,
        baseUrl: 'http://localhost:11434/v1',
        model: '',
        contextWindow: 16384,
        apiKey: 'ollama',
        supportsAskStreaming: true,
        visionMode: 'auto',
        visionDetection: null,
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
        supportsAskStreaming: true,
        visionMode: 'auto',
        visionDetection: null,
        enabled: true,
      },
      jan: {
        type: 'openai',
        category: 'local',
        label: 'Jan (Local)',
        providerName: 'jan',
        requiresModel: true,
        baseUrl: 'http://localhost:1337/v1',
        model: '',
        contextWindow: 16384,
        apiKey: '',
        supportsAskStreaming: true,
        supportsVision: true,
        enabled: true,
      },
      vllm: {
        type: 'openai',
        category: 'local',
        label: 'vLLM (Local)',
        providerName: 'vllm',
        requiresModel: true,
        baseUrl: 'http://localhost:8000/v1',
        model: '',
        contextWindow: 16384,
        apiKey: '',
        supportsAskStreaming: true,
        supportsVision: true,
        enabled: true,
      },
      sglang: {
        type: 'openai',
        category: 'local',
        label: 'SGLang (Local)',
        providerName: 'sglang',
        requiresModel: true,
        baseUrl: 'http://localhost:30000/v1',
        model: '',
        contextWindow: 16384,
        apiKey: '',
        supportsAskStreaming: true,
        supportsVision: true,
        enabled: true,
      },
      localai: {
        type: 'openai',
        category: 'local',
        label: 'LocalAI (Local)',
        providerName: 'localai',
        requiresModel: true,
        baseUrl: 'http://localhost:8080/v1',
        model: '',
        contextWindow: 16384,
        apiKey: '',
        supportsAskStreaming: true,
        visionMode: 'auto',
        visionDetection: null,
        enabled: true,
      },
      gpt4all: {
        type: 'openai',
        category: 'local',
        label: 'GPT4All (Local)',
        providerName: 'gpt4all',
        requiresModel: true,
        baseUrl: 'http://localhost:4891/v1',
        model: '',
        contextWindow: 16384,
        apiKey: '',
        supportsAskStreaming: true,
        supportsVision: true,
        enabled: true,
      },
      local_openai_proxy: {
        type: 'openai',
        category: 'local',
        label: 'Local OpenAI-compatible Proxy',
        providerName: 'local-openai-proxy',
        baseUrl: 'http://127.0.0.1:8317/v1',
        model: '',
        requiresModel: true,
        contextWindow: 16384,
        apiKey: '',
        requiresApiKey: true,
        supportsAskStreaming: true,
        supportsVision: false,
        enabled: true,
      },
      unsloth: {
        type: 'openai',
        category: 'local',
        label: 'Unsloth Studio (Local)',
        providerName: 'unsloth',
        baseUrl: 'http://127.0.0.1:8888/v1',
        model: '',
        requiresModel: true,
        contextWindow: 16384,
        apiKey: '',
        requiresApiKey: true,
        supportsAskStreaming: true,
        supportsVision: false,
        enabled: true,
      },
      webgpu: {
        type: 'webgpu',
        category: 'local',
        label: 'WebGPU (In-browser)',
        providerName: 'webgpu',
        baseUrl: '',
        model: WEBGPU_COMPASS_TINY_V2_MODEL_ID,
        device: 'webgpu',
        dtype: WEBGPU_DTYPE,
        contextWindow: 32768,
        promptTier: 'compact',
        supportsAskStreaming: false,
        supportsVision: false,
        enabled: true,
      },
      azure_openai: {
        type: 'azure_openai',
        category: 'cloud',
        label: 'Azure OpenAI',
        providerName: 'azure-openai',
        // Azure endpoint root (no /openai/ path). Example:
        // https://my-resource.openai.azure.com
        baseUrl: 'https://{resource}.openai.azure.com',
        // "model" is the Azure *deployment name*.
        model: '',
        apiVersion: '2024-10-21',
        apiKey: '',
        supportsAskStreaming: true,
        enabled: false,
      },
      aws_bedrock: {
        type: 'aws_bedrock',
        category: 'cloud',
        label: 'AWS Bedrock (Converse)',
        providerName: 'aws-bedrock',
        // Bedrock endpoint is derived from region; baseUrl is unused but kept for UI consistency.
        baseUrl: 'https://bedrock-runtime.{region}.amazonaws.com',
        // "model" is the Bedrock model id, e.g. "anthropic.claude-sonnet-5"
        model: '',
        region: 'us-east-1',
        accessKeyId: '',
        secretAccessKey: '',
        sessionToken: '',
        supportsVision: false,
        // Seed Claude Sonnet 5 rates; users should adjust for other Bedrock models.
        inputCostPerMillionUsd: 2,
        cacheReadCostPerMillionUsd: 0.2,
        cacheWriteCostPerMillionUsd: 2.5,
        cacheWrite1hCostPerMillionUsd: 4,
        outputCostPerMillionUsd: 10,
        enabled: false,
      },
      openai: {
        type: 'openai',
        category: 'cloud',
        label: 'OpenAI',
        providerName: 'openai',
        baseUrl: 'https://api.openai.com/v1',
        model: OPENAI_DEFAULT_MODEL,
        // Keep the default at the standard-price input threshold; users can
        // opt into the model's larger window when long-context pricing is acceptable.
        contextWindow: 272000,
        maxOutputTokens: 128000,
        inputCostPerMillionUsd: 2.5,
        cacheReadCostPerMillionUsd: 0.25,
        // GPT-5.6 family bills included cache writes at 1.25× input.
        cacheWriteCostPerMillionUsd: 3.125,
        outputCostPerMillionUsd: 15,
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
        model: 'claude-sonnet-5',
        contextWindow: 1000000,
        maxOutputTokens: 128000,
        inputCostPerMillionUsd: 2,
        cacheReadCostPerMillionUsd: 0.2,
        cacheWriteCostPerMillionUsd: 2.5,
        cacheWrite1hCostPerMillionUsd: 4,
        outputCostPerMillionUsd: 10,
        supportsAskStreaming: true,
        apiKey: '',
        apiKeyUrl: 'https://console.anthropic.com/settings/keys',
        enabled: false,
      },
      // Google Gemini via the OpenAI-compatible endpoint. Pure REST, no
      // separate SDK needed. Streaming, function-calling, vision all work
      // through the same OpenAICompatibleProvider.
      gemini: {
        type: 'openai',
        category: 'cloud',
        label: 'Google Gemini',
        providerName: 'gemini',
        baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
        model: 'gemini-3.7-flash',
        supportsStreamUsageOptions: true,
        supportsAskStreaming: true,
        apiKey: '',
        enabled: false,
      },
      cloudflare: {
        type: 'openai',
        category: 'router',
        label: 'Cloudflare AI Gateway / Workers AI',
        providerName: 'cloudflare',
        baseUrl: 'https://api.cloudflare.com/client/v4/accounts/{account_id}/ai/v1',
        model: '@cf/zai-org/glm-5.2',
        contextWindow: 262144,
        supportsStreamUsageOptions: false,
        accountId: '',
        gatewayId: '',
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
        model: 'mistral-medium-3.5',
        inputCostPerMillionUsd: 1.5,
        outputCostPerMillionUsd: 7.5,
        supportsStreamUsageOptions: true,
        supportsAskStreaming: true,
        apiKey: '',
        apiKeyUrl: 'https://console.mistral.ai/api-keys/',
        enabled: false,
      },
      deepseek: {
        type: 'openai',
        category: 'cloud',
        label: 'DeepSeek',
        providerName: 'deepseek',
        baseUrl: DEEPSEEK_BASE_URL,
        model: DEEPSEEK_DEFAULT_MODEL,
        contextWindow: 1000000,
        maxOutputTokens: 384000,
        // `deepseek-flash` off-peak list price, CNY per 1M tokens: 1 input,
        // 0.02 cache-hit input, 4 output (peak is 2 / 0.04 / 8), converted at
        // 1 USD = 7.1 CNY.
        // https://api-docs.deepseek.com/zh-cn/quick_start/pricing
        inputCostPerMillionUsd: 0.14,
        cacheReadCostPerMillionUsd: 0.0028,
        outputCostPerMillionUsd: 0.56,
        supportsStreamUsageOptions: true,
        supportsAskStreaming: true,
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
        model: 'grok-4.6',
        inputCostPerMillionUsd: 2,
        outputCostPerMillionUsd: 6,
        supportsAskStreaming: true,
        apiKey: '',
        apiKeyUrl: 'https://console.x.ai/',
        enabled: false,
      },
      // Nvidia NIM (cloud / self-hosted inference microservice)
      nvidia: {
        type: 'openai',
        category: 'router',
        label: 'Nvidia NIM',
        providerName: 'nvidia',
        baseUrl: 'https://integrate.api.nvidia.com/v1',
        model: 'nvidia/nemotron-3-super-120b-a12b',
        inputCostPerMillionUsd: 0.22,
        outputCostPerMillionUsd: 0.22,
        supportsAskStreaming: true,
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
        model: 'openai/gpt-oss-120b',
        inputCostPerMillionUsd: 0.15,
        outputCostPerMillionUsd: 0.6,
        supportsAskStreaming: true,
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
        model: 'MiniMax-M3',
        apiKey: '',
        apiKeyUrl: 'https://platform.minimaxi.com/user-center/basic-information/interface-key',
        enabled: false,
      },
      kimi: {
        type: 'openai',
        category: 'cloud',
        label: 'Kimi',
        providerName: 'kimi',
        baseUrl: 'https://api.moonshot.ai/v1',
        model: 'kimi-k3',
        supportsStreamUsageOptions: true,
        omitTemperature: true,
        compat: { maxTokensField: 'max_completion_tokens' },
        apiKey: '',
        apiKeyUrl: 'https://platform.kimi.ai/console/api-keys',
        enabled: false,
      },
      alibaba: {
        type: 'openai',
        category: 'cloud',
        label: 'Alibaba Cloud (Qwen)',
        providerName: 'alibaba',
        baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
        model: 'qwen3.8-max',
        supportsStreamUsageOptions: true,
        apiKey: '',
        apiKeyUrl: 'https://dashscope.console.aliyun.com/apiKey',
        enabled: false,
      },
      together: {
        type: 'openai',
        category: 'router',
        label: 'Together AI',
        providerName: 'together',
        baseUrl: 'https://api.together.xyz/v1',
        model: 'moonshotai/Kimi-K3',
        supportsStreamUsageOptions: true,
        supportsAskStreaming: true,
        apiKey: '',
        apiKeyUrl: 'https://api.together.ai/settings/api-keys',
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
        supportsAskStreaming: true,
        apiKey: '',
        apiKeyUrl: 'https://openrouter.ai/keys',
        enabled: false,
      },
      huggingface: {
        type: 'openai',
        category: 'router',
        label: 'Hugging Face Inference',
        providerName: 'huggingface',
        baseUrl: 'https://router.huggingface.co/v1',
        model: 'moonshotai/Kimi-K3',
        supportsStreamUsageOptions: true,
        apiKey: '',
        apiKeyUrl: 'https://huggingface.co/settings/tokens',
        enabled: false,
      },
      fireworks: {
        type: 'openai',
        category: 'router',
        label: 'Fireworks',
        providerName: 'fireworks',
        baseUrl: 'https://api.fireworks.ai/inference/v1',
        model: 'accounts/fireworks/models/kimi-k3',
        supportsStreamUsageOptions: true,
        supportsAskStreaming: true,
        apiKey: '',
        apiKeyUrl: 'https://fireworks.ai/account/api-keys',
        enabled: false,
      },
      z_ai: {
        type: 'openai',
        category: 'cloud',
        label: 'z.ai GLM',
        providerName: 'z_ai',
        baseUrl: 'https://api.z.ai/api/paas/v4',
        model: 'glm-5.3',
        contextWindow: 1000000,
        inputCostPerMillionUsd: 1.4,
        cacheReadCostPerMillionUsd: 0.26,
        outputCostPerMillionUsd: 4.4,
        supportsToolStreamOption: true,
        supportsAskStreaming: true,
        apiKey: '',
        apiKeyUrl: 'https://docs.z.ai/guides/overview/quick-start',
        enabled: false,
      },
      ...ADDITIONAL_PROVIDER_DEFAULTS,
    };
    return defaults;
  }

  _migrateStoredProviderConfigs(stored) {
    const migrated = { ...stored };
    const storedOpenAi = migrated.openai;
    const openAiBaseUrl = String(storedOpenAi?.baseUrl || 'https://api.openai.com/v1').replace(/\/+$/, '');
    const untouchedOpenAiDefault = storedOpenAi?.model === OPENAI_LEGACY_DEFAULT_MODEL
      && storedOpenAi?.configured !== true
      && !String(storedOpenAi?.apiKey || '').trim()
      && openAiBaseUrl === 'https://api.openai.com/v1'
      && (storedOpenAi?.inputCostPerMillionUsd == null || Number(storedOpenAi.inputCostPerMillionUsd) === 5)
      && (storedOpenAi?.outputCostPerMillionUsd == null || Number(storedOpenAi.outputCostPerMillionUsd) === 22.5);
    if (untouchedOpenAiDefault) {
      migrated.openai = {
        ...storedOpenAi,
        model: OPENAI_DEFAULT_MODEL,
        inputCostPerMillionUsd: 2.5,
        cacheReadCostPerMillionUsd: 0.25,
        cacheWriteCostPerMillionUsd: 3.125,
        outputCostPerMillionUsd: 15,
      };
    }
    if (migrated.openrouter?.model === OPENROUTER_LEGACY_DEFAULT_MODEL) {
      migrated.openrouter = {
        ...migrated.openrouter,
        model: OPENROUTER_DEFAULT_MODEL,
      };
    }
    // DeepSeek renamed its shipped default model to `deepseek-flash`. The
    // retired `deepseek-v4-flash` id (plus the old /v1 base path and the
    // pre-V4.1 prices) identifies a card the user never touched, so the rename
    // and the new price sheet can be applied without overriding a real choice.
    const storedDeepSeek = migrated.deepseek;
    const deepSeekBaseUrl = String(storedDeepSeek?.baseUrl || '').replace(/\/+$/, '');
    const untouchedDeepSeekDefault = storedDeepSeek?.model === DEEPSEEK_LEGACY_DEFAULT_MODEL
      && storedDeepSeek?.configured !== true
      && !String(storedDeepSeek?.apiKey || '').trim()
      && (deepSeekBaseUrl === DEEPSEEK_LEGACY_DEFAULT_BASE_URL || deepSeekBaseUrl === DEEPSEEK_BASE_URL)
      && (storedDeepSeek?.inputCostPerMillionUsd == null || Number(storedDeepSeek.inputCostPerMillionUsd) === 0.27)
      && (storedDeepSeek?.outputCostPerMillionUsd == null || Number(storedDeepSeek.outputCostPerMillionUsd) === 1.1);
    if (untouchedDeepSeekDefault) {
      migrated.deepseek = {
        ...storedDeepSeek,
        baseUrl: DEEPSEEK_BASE_URL,
        model: DEEPSEEK_DEFAULT_MODEL,
        inputCostPerMillionUsd: 0.14,
        cacheReadCostPerMillionUsd: 0.0028,
        outputCostPerMillionUsd: 0.56,
      };
    }
    // WebGPU now ships Compass Tiny v2.1 only (32k). Migrate untouched
    // LFM2.5 2.6B 16k defaults so fresh and uncustomized installs land on
    // Compass without wiping an explicitly chosen model.
    if (migrated.webgpu
      && String(migrated.webgpu.model || '').trim() === WEBGPU_MODEL_ID
      && migrated.webgpu.configured !== true
      && Number(migrated.webgpu.contextWindow) === 16384) {
      migrated.webgpu = {
        ...migrated.webgpu,
        model: WEBGPU_COMPASS_TINY_V2_MODEL_ID,
        contextWindow: 32768,
      };
    }
    // Compass itself shipped at 16k before the 32k default. Bump untouched
    // Compass 16k configs to 32k.
    if (migrated.webgpu
      && String(migrated.webgpu.model || '').trim() === WEBGPU_COMPASS_TINY_V2_MODEL_ID
      && migrated.webgpu.configured !== true
      && Number(migrated.webgpu.contextWindow) === 16384) {
      migrated.webgpu = {
        ...migrated.webgpu,
        contextWindow: 32768,
      };
    }
    this._migrateUntouchedShippedDefaults(migrated);
    // The OpenCode entry is editable, so only replace the retired shipped
    // model while it still points at the official Zen endpoint. In particular,
    // preserve model ids selected for custom endpoints even when configured.
    {
      const cur = migrated.opencode;
      if (cur && typeof cur.model === 'string') {
        const defaults = this._defaultConfigs().opencode;
        const baseUrl = String(cur.baseUrl || defaults.baseUrl).replace(/\/+$/, '');
        const model = String(cur.model).trim().toLowerCase().replace(/^opencode\//, '');
        if (baseUrl === defaults.baseUrl && model === OPENCODE_LEGACY_DEFAULT_MODEL) {
          migrated.opencode = { ...cur, model: defaults.model };
        }
      }
    }
    if (migrated.ollama) {
      const config = migrated.ollama;
      const visionMode = OLLAMA_VISION_MODES.has(config.visionMode)
        ? config.visionMode
        : (config.supportsVision === true
          ? 'on'
          : (config.supportsVision === false ? 'off' : 'auto'));
      if (Object.hasOwn(config, 'supportsVision') || config.visionMode !== visionMode) {
        migrated.ollama = {
          ...config,
          visionMode,
        };
        delete migrated.ollama.supportsVision;
      }
    }
    for (const [id, config] of Object.entries(migrated)) {
      if (!visionProviderKind(config.duplicateOf || id, config)) continue;
      const legacySupportsVision = config.supportsVision;
      const hasConfiguredModel = !!String(config.model || '').trim();
      const visionMode = VISION_MODES.has(config.visionMode)
        ? config.visionMode
        : (legacySupportsVision === false
          ? 'off'
          : (legacySupportsVision === true ? 'on' : 'auto'));
      const visionDetection = hasConfiguredModel ? (config.visionDetection || null) : null;
      if (
        Object.hasOwn(config, 'supportsVision')
        || config.visionMode !== visionMode
        || config.visionDetection !== visionDetection
      ) {
        migrated[id] = {
          ...config,
          visionMode,
          // With an empty Model field the server's loaded model can change
          // without a settings update, so never restore a persisted detection.
          visionDetection,
        };
        delete migrated[id].supportsVision;
      }
    }
    // The managed provider name is shipped UI, not a user customization. Older
    // releases persisted the complete config, so migrate their stored label.
    if (
      migrated[WEBBRAIN_CLOUD_PROVIDER_ID]
      && migrated[WEBBRAIN_CLOUD_PROVIDER_ID].label !== WEBBRAIN_CLOUD_PROVIDER_LABEL
    ) {
      migrated[WEBBRAIN_CLOUD_PROVIDER_ID] = {
        ...migrated[WEBBRAIN_CLOUD_PROVIDER_ID],
        label: WEBBRAIN_CLOUD_PROVIDER_LABEL,
      };
    }
    // Existing installs stored omitToolsWhenImagesPresent:true for WebBrain
    // Compass, which suppressed native tools on every screenshot turn and broke
    // tool calling. Force it off so the saved config picks up the new default.
    if (migrated.webbrain_cloud?.omitToolsWhenImagesPresent) {
      migrated.webbrain_cloud = {
        ...migrated.webbrain_cloud,
        omitToolsWhenImagesPresent: false,
      };
    }
    if (Number(migrated.webbrain_cloud?.contextWindow) === WEBBRAIN_CLOUD_LEGACY_CONTEXT_WINDOW) {
      migrated.webbrain_cloud = {
        ...migrated.webbrain_cloud,
        contextWindow: WEBBRAIN_CLOUD_CONTEXT_WINDOW,
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

  _storedCostsMatchShipped(stored, fromCosts) {
    if (!fromCosts) return true;
    return Object.entries(fromCosts).every(([key, value]) => (
      stored[key] == null || Number(stored[key]) === value
    ));
  }

  _isUntouchedShippedDefault(stored, next, { fromModel, fromCosts, fromSupportsVision }) {
    if (!stored || typeof stored !== 'object' || !next) return false;
    if (stored.configured === true) return false;
    if (this._hasStoredProviderCredentials(next, stored)) return false;
    if (String(stored.model || '') !== String(fromModel || '')) return false;
    if (fromSupportsVision !== undefined && stored.supportsVision !== fromSupportsVision) return false;
    const officialBaseUrl = String(next.baseUrl || '').replace(/\/+$/, '');
    const storedBaseUrl = String(stored.baseUrl || next.baseUrl || '').replace(/\/+$/, '');
    if (officialBaseUrl && storedBaseUrl !== officialBaseUrl) return false;
    return this._storedCostsMatchShipped(stored, fromCosts);
  }

  _applyUntouchedDefaultMigration(stored, next, { applyCosts, fromContextWindow }) {
    const migrated = { ...stored, model: next.model };
    if (applyCosts) {
      for (const key of PROVIDER_COST_KEYS) {
        if (next[key] != null) migrated[key] = next[key];
      }
    }
    if (
      fromContextWindow != null
      && next.contextWindow != null
      && stored.contextWindow != null
      && Number(stored.contextWindow) === fromContextWindow
    ) {
      migrated.contextWindow = next.contextWindow;
    }
    if (Object.hasOwn(next, 'supportsVision')) {
      migrated.supportsVision = next.supportsVision;
    }
    return migrated;
  }

  _migrateUntouchedShippedDefaults(migrated) {
    const defaults = this._defaultConfigs();
    let changed = false;
    for (const { id, fromModel, fromCosts, fromContextWindow, fromSupportsVision } of UNTOUCHED_DEFAULT_MIGRATIONS) {
      const stored = migrated[id];
      const next = defaults[id];
      if (!this._isUntouchedShippedDefault(stored, next, { fromModel, fromCosts, fromSupportsVision })) continue;
      migrated[id] = this._applyUntouchedDefaultMigration(stored, next, {
        applyCosts: !!fromCosts,
        fromContextWindow,
      });
      changed = true;
    }
    return changed;
  }

  _storedProviderConfigsChanged(before, after) {
    const previous = before && typeof before === 'object' ? before : {};
    const next = after && typeof after === 'object' ? after : {};
    const ids = new Set([...Object.keys(previous), ...Object.keys(next)]);
    for (const id of ids) {
      if (previous[id] === next[id]) continue;
      if (JSON.stringify(previous[id] ?? null) !== JSON.stringify(next[id] ?? null)) return true;
    }
    return false;
  }

  _storedDefaultOverride(defaultConfig, storedConfig) {
    if (!storedConfig || typeof storedConfig !== 'object') return {};
    const override = { ...storedConfig };
    // Stored configs are user-writable extension state. A stale/corrupt `type`
    // on a built-in provider should not replace the known implementation class.
    if (override.type !== defaultConfig.type) delete override.type;
    return override;
  }

  _hasStoredProviderCredentials(defaultConfig, storedConfig) {
    if (!storedConfig || typeof storedConfig !== 'object') return false;
    // Older releases persisted a full snapshot of every built-in provider.
    // Model, endpoint, vision, cost, and similar values may therefore differ
    // only because a shipped default changed. A non-empty credential in a field
    // whose shipped value is empty is the only strong per-provider signal
    // available. This deliberately ignores changed local-server dummy keys;
    // the legacy active provider is handled separately in load().
    return PROVIDER_CREDENTIAL_KEYS.some((key) => {
      const value = storedConfig[key];
      const defaultValue = defaultConfig[key];
      return typeof value === 'string' && value.trim() !== '' &&
        (typeof defaultValue !== 'string' || defaultValue.trim() === '');
    });
  }

  _isSupportedProviderConfig(id, config) {
    return SAFE_PROVIDER_ID_RE.test(String(id || '')) &&
      !!config &&
      typeof config === 'object' &&
      SUPPORTED_PROVIDER_TYPES.has(config.type);
  }

  _providerDefinitionId(id, config = this.providers.get(id)?.config) {
    return String(config?.duplicateOf || id || '');
  }

  _duplicateProviderId(id) {
    return `${id}${DUPLICATE_PROVIDER_SUFFIX}`;
  }

  _canDuplicateProvider(id, config = this.providers.get(id)?.config) {
    return !!config && !config.duplicateOf && id !== WEBBRAIN_CLOUD_PROVIDER_ID && config.type !== 'webgpu';
  }

  _isValidDuplicateConfig(id, config, configs) {
    const sourceId = config?.duplicateOf;
    const sourceConfig = configs[sourceId];
    return typeof sourceId === 'string' &&
      SAFE_PROVIDER_ID_RE.test(sourceId) &&
      id === this._duplicateProviderId(sourceId) &&
      !!sourceConfig &&
      this._canDuplicateProvider(sourceId, sourceConfig) &&
      sourceConfig.configured === true &&
      sourceConfig.type === config.type;
  }

  /**
   * Provider category for filter UI. Returns one of:
   *   'local'  — runs in-browser or connects through a local endpoint
   *   'cloud'  — first-party API endpoint (openai, anthropic, gemini, etc.)
   *   'router' — multi-model gateways that fan out to many backends (openrouter, cloudflare, nvidia, groq)
   * Reads `config.category` first; falls back to a per-id table so configs
   * written before 7.3 (which lacked the field) still classify correctly.
   */
  static categoryFor(id, config) {
    if (config && config.category) return config.category;
    if (config?.type === 'llamacpp' || config?.type === 'webgpu') return 'local';
    if (['llamacpp', 'ollama', 'lmstudio', 'jan', 'vllm', 'sglang', 'localai', 'gpt4all', 'local_openai_proxy', 'unsloth', 'webgpu'].includes(id)) return 'local';
    if (ROUTER_PROVIDER_IDS.includes(id)) return 'router';
    return 'cloud';
  }

  _createProvider(id, config) {
    const definitionId = this._providerDefinitionId(id, config);
    const normalizedConfig = {
      ...config,
      category: ProviderManager.categoryFor(id, config),
      supportsAskStreaming: config.supportsAskStreaming ?? [
        'llamacpp',
        'openai',
        'azure_openai',
        'anthropic',
        'anthropic_oauth',
        'vertex_anthropic',
      ].includes(config.type),
    };
    // Runtime-only identity for provider-specific conversation state. Keep it
    // non-enumerable so it never leaks into storage, exports, or the settings UI.
    Object.defineProperty(normalizedConfig, '_providerId', { value: String(id || '') });
    if (definitionId === 'ollama') {
      normalizedConfig.visionMode = OLLAMA_VISION_MODES.has(normalizedConfig.visionMode)
        ? normalizedConfig.visionMode
        : 'auto';
      delete normalizedConfig.supportsVision;
    }
    if (visionProviderKind(definitionId, normalizedConfig)) {
      const legacySupportsVision = normalizedConfig.supportsVision;
      normalizedConfig.visionMode = VISION_MODES.has(normalizedConfig.visionMode)
        ? normalizedConfig.visionMode
        : (typeof legacySupportsVision === 'boolean'
          ? (legacySupportsVision ? 'on' : 'off')
          : 'auto');
      delete normalizedConfig.supportsVision;
    }
    switch (normalizedConfig.type) {
      case 'llamacpp':
        return new LlamaCppProvider(normalizedConfig);
      case 'webgpu':
        return new WebGPUProvider(normalizedConfig);
      case 'openai':
        // All non-local DeepSeek cards use the dedicated capability hooks. Only
        // direct cards opt into DeepSeek's native request contract; router cards
        // retain their existing OpenRouter compatibility preset.
        return (isDirectDeepSeekConfig(normalizedConfig)
          || (normalizedConfig.category !== 'local' && isDeepSeekModel(normalizedConfig.model)))
          ? new DeepSeekProvider(normalizedConfig)
          : new OpenAICompatibleProvider(normalizedConfig);
      case 'azure_openai':
        return new AzureOpenAIProvider(normalizedConfig);
      case 'aws_bedrock':
        return new AwsBedrockProvider(normalizedConfig);
      case 'anthropic':
        return new AnthropicProvider(normalizedConfig);
      case 'anthropic_oauth':
        return new AnthropicOAuthProvider(normalizedConfig);
      case 'vertex_anthropic':
        return new VertexAnthropicProvider(normalizedConfig);
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

  /** Get a provider without changing the user's globally selected provider. */
  getProvider(id) {
    const provider = this.providers.get(id);
    if (!provider) throw new Error(`Provider not found: ${id}`);
    return provider;
  }

  /**
   * Stable provider-config ids currently opted into voluntary research
   * sharing. The share outbox purges queued entries for any other id before
   * delivery so revoking the toggle is honored immediately. Keyed by config
   * id (not providerName): duplicates share one providerName, and some
   * built-ins have none at all.
   */
  consentedShareProviderIds() {
    const ids = new Set();
    try {
      for (const [id, provider] of this.providers?.entries?.() || []) {
        if (provider?.config?.shareQueriesForResearch !== true) continue;
        const pid = String(provider.config._providerId || id || '');
        if (pid) ids.add(pid);
      }
    } catch {}
    return ids;
  }

  async _fetchVisionCapability(providerId, provider, identity) {
    const root = identity.baseUrl.replace(/\/v1$/i, '');
    const headers = this._modelListHeaders(provider);
    const controller = new AbortController();
    const fetchJson = async (url) => {
      const response = await fetchWithFallback(url, {
        method: 'GET',
        headers,
        timeoutMs: VISION_METADATA_TIMEOUT_MS,
        signal: controller.signal,
      });
      if (!response.ok) return { ok: false, status: response.status };
      try {
        return { ok: true, data: await response.json() };
      } catch {
        return { ok: false, malformed: true };
      }
    };
    const request = (async () => {
      try {
        if (providerId === 'llamacpp') {
          const query = identity.model ? `?model=${encodeURIComponent(identity.model)}` : '';
          const result = await fetchJson(`${root}/props${query}`);
          if (!result.ok) return result;
          const supportsVision = parseLlamaCppVisionSupport(result.data);
          return supportsVision == null ? { ok: false, malformed: true } : { ok: true, supportsVision };
        }
        if (providerId === 'lmstudio') {
          const current = await fetchJson(`${root}/api/v1/models`);
          if (current.ok) {
            const supportsVision = parseLmStudioVisionSupport(current.data, identity.model, 'v1');
            if (supportsVision != null) return { ok: true, supportsVision };
          }
          const legacy = await fetchJson(`${root}/api/v0/models`);
          if (!legacy.ok) return legacy;
          const supportsVision = parseLmStudioVisionSupport(legacy.data, identity.model, 'v0');
          return supportsVision == null ? { ok: false, malformed: true } : { ok: true, supportsVision };
        }
        if (providerId === 'localai') {
          const result = await fetchJson(`${root}/v1/models/capabilities`);
          if (!result.ok) return result;
          const supportsVision = parseLocalAiVisionSupport(result.data, identity.model);
          return supportsVision == null ? { ok: false, malformed: true } : { ok: true, supportsVision };
        }
        return { ok: false, skipped: true };
      } catch (error) {
        return { ok: false, error: error?.message || String(error) };
      }
    })();
    let timeoutId;
    const timeout = new Promise((resolve) => {
      timeoutId = setTimeout(() => {
        controller.abort(new DOMException('Vision capability metadata timed out', 'TimeoutError'));
        resolve({ ok: false, timeout: true });
      }, VISION_METADATA_TIMEOUT_MS);
    });
    try {
      return await Promise.race([request, timeout]);
    } finally {
      clearTimeout(timeoutId);
    }
  }

  async ensureVisionCapability(id) {
    const provider = this.providers.get(id);
    const providerKind = visionProviderKind(this._providerDefinitionId(id, provider?.config), provider?.config);
    if (!provider || !providerKind) return { ok: false, skipped: true };
    const mode = VISION_MODES.has(provider.config.visionMode) ? provider.config.visionMode : 'auto';
    if (mode !== 'auto') return { ok: true, skipped: true, supportsVision: mode === 'on' };
    const identity = visionCapabilityIdentity(providerKind, provider.config);
    if (!identity) return { ok: false, skipped: true };
    const hasConfiguredModel = !!identity.model;
    if (hasConfiguredModel && visionDetectionMatches(providerKind, provider.config)) {
      return { ok: true, cached: true, supportsVision: provider.config.visionDetection.supportsVision };
    }

    const epoch = this._visionCapabilityEpochs.get(id) || 0;
    const checkKey = `${id}\n${identity.key}`;
    let pending = this._visionCapabilityChecks.get(checkKey);
    if (!pending) {
      pending = this._fetchVisionCapability(providerKind, provider, identity);
      this._visionCapabilityChecks.set(checkKey, pending);
    }
    const result = await pending;
    if ((!hasConfiguredModel || !result.ok) && this._visionCapabilityChecks.get(checkKey) === pending) {
      // Empty-model identities describe whatever is currently loaded, not a
      // stable model. Coalesce only concurrent callers, then recheck next turn.
      this._visionCapabilityChecks.delete(checkKey);
    }
    const current = this.providers.get(id);
    const currentKind = visionProviderKind(this._providerDefinitionId(id, current?.config), current?.config);
    const currentIdentity = visionCapabilityIdentity(currentKind, current?.config);
    if (!current || current.config.visionMode !== 'auto'
      || currentKind !== providerKind
      || currentIdentity?.key !== identity.key
      || (this._visionCapabilityEpochs.get(id) || 0) !== epoch) {
      return { ...result, stale: true };
    }
    if (!result.ok) {
      if (!hasConfiguredModel && current.config.visionDetection?.transient === true) {
        const { visionDetection: _ignored, ...withoutDetection } = current.config;
        this.providers.set(id, this._createProvider(id, withoutDetection));
      }
      return result;
    }

    const detection = {
      providerId: providerKind,
      model: identity.model,
      baseUrl: identity.baseUrl,
      supportsVision: result.supportsVision,
      source: visionDetectionSource(providerKind),
      ...(!hasConfiguredModel ? { transient: true } : {}),
    };
    this.providers.set(id, this._createProvider(id, { ...current.config, visionDetection: detection }));
    if (hasConfiguredModel) await this.save();
    return { ok: true, supportsVision: result.supportsVision, detection };
  }

  _ollamaVisionIdentity(config) {
    const model = String(config?.model || '').trim();
    const baseUrl = canonicalizeOllamaBaseUrl(config?.baseUrl);
    if (!model || !baseUrl) return null;
    return {
      model,
      baseUrl,
      key: `${baseUrl}\n${model.toLowerCase()}`,
    };
  }

  async _fetchOllamaVisionSupport(provider, identity) {
    const root = identity.baseUrl.replace(/\/v1$/, '');
    const controller = new AbortController();
    const request = (async () => {
      try {
        const res = await fetchWithFallback(`${root}/api/show`, {
          method: 'POST',
          headers: { ...this._modelListHeaders(provider), 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: identity.model }),
          timeoutMs: OLLAMA_VISION_METADATA_TIMEOUT_MS,
          signal: controller.signal,
        });
        if (!res.ok) return { ok: false, status: res.status };
        const supportsVision = parseOllamaShowVisionSupport(await res.json());
        if (supportsVision == null) return { ok: false, malformed: true };
        return { ok: true, supportsVision };
      } catch (error) {
        return { ok: false, error: error?.message || String(error) };
      }
    })();
    let timeoutId;
    const timeout = new Promise((resolve) => {
      timeoutId = setTimeout(() => {
        controller.abort(new DOMException('Ollama vision metadata timed out', 'TimeoutError'));
        resolve({ ok: false, timeout: true });
      }, OLLAMA_VISION_METADATA_TIMEOUT_MS);
    });
    try {
      // The shared fetch wrapper bounds time-to-headers. This outer race also
      // covers a server that sends headers and then stalls while JSON is read.
      return await Promise.race([request, timeout]);
    } finally {
      clearTimeout(timeoutId);
    }
  }

  async ensureOllamaVisionCapability(id = 'ollama') {
    const provider = this.providers.get(id);
    if (!provider) return { ok: false, skipped: true };
    const mode = OLLAMA_VISION_MODES.has(provider.config.visionMode)
      ? provider.config.visionMode
      : 'auto';
    if (mode !== 'auto') return { ok: true, skipped: true, supportsVision: mode === 'on' };
    const identity = this._ollamaVisionIdentity(provider.config);
    if (!identity) return { ok: false, skipped: true };

    let pending = this._ollamaVisionChecks.get(identity.key);
    if (!pending) {
      pending = this._fetchOllamaVisionSupport(provider, identity);
      this._ollamaVisionChecks.set(identity.key, pending);
    }
    const result = await pending;
    if (!result.ok && this._ollamaVisionChecks.get(identity.key) === pending) {
      // A transient timeout, network failure, or malformed response must not
      // pin this model to text-only for the service worker's entire lifetime.
      this._ollamaVisionChecks.delete(identity.key);
    }
    const current = this.providers.get(id);
    const currentIdentity = this._ollamaVisionIdentity(current?.config);
    if (!current || current.config.visionMode !== 'auto' || currentIdentity?.key !== identity.key) {
      return { ...result, stale: true };
    }

    if (!result.ok) {
      if (current.config.visionDetection) {
        const { visionDetection: _ignored, ...withoutDetection } = current.config;
        this.providers.set(id, this._createProvider(id, withoutDetection));
      }
      return result;
    }

    const detection = {
      model: identity.model,
      baseUrl: identity.baseUrl,
      supportsVision: result.supportsVision,
      source: 'ollama_show',
    };
    const existing = current.config.visionDetection;
    if (JSON.stringify(existing) !== JSON.stringify(detection)) {
      this.providers.set(id, this._createProvider(id, { ...current.config, visionDetection: detection }));
      await this.save();
    }
    return { ok: true, supportsVision: result.supportsVision, detection };
  }

  async prepareActiveProviderCapabilities() {
    const activeProvider = this.providers.get(this.activeProviderId);
    const definitionId = this._providerDefinitionId(this.activeProviderId, activeProvider?.config);
    if (definitionId === 'ollama') {
      return this.ensureOllamaVisionCapability(this.activeProviderId);
    }
    if (visionProviderKind(definitionId, activeProvider?.config)) {
      return this.ensureVisionCapability(this.activeProviderId);
    }
    return { ok: true, skipped: true };
  }

  /** Return the explicitly configured portable vision override, if any. */
  async getVisionOverrideProvider() {
    try {
      const { visionModel } = await chrome.storage.local.get(['visionModel']);
      if (!visionModel) return null;
      // The short-lived WebGPU storage shape is a fallback preference, never an
      // explicit override. Keep accepting it through getLocalVisionFallbackProvider.
      if (visionModel.type === 'webgpu') return null;
      if (!visionModel.baseUrl || !visionModel.model) return null;
      return new OpenAICompatibleProvider({
        type: 'openai',
        category: 'cloud',
        label: 'Vision Model',
        providerName: 'vision',
        baseUrl: normalizeOpenAICompatibleBaseUrl(visionModel.baseUrl),
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

  /** Return the Chrome-only WebBrain VL fallback, but only when explicitly enabled and ready. */
  async getLocalVisionFallbackProvider() {
    try {
      const readiness = await this.getWebgpuVisionReadiness();
      if (readiness.enabled && readiness.consented && readiness.status === 'ready') {
        return new WebGPUVisionProvider();
      }
    } catch (e) {
      console.warn('[providers] getLocalVisionFallbackProvider failed:', e);
    }
    return null;
  }

  async getWebgpuVisionReadiness() {
    const stored = await chrome.storage.local.get([
      WEBGPU_VISION_ENABLED_KEY,
      WEBGPU_VISION_CONSENT_VERSION_KEY,
      WEBGPU_VISION_DOWNLOAD_STATE_KEY,
    ]);
    const consented = stored[WEBGPU_VISION_CONSENT_VERSION_KEY] === WEBGPU_VISION_CONSENT_VERSION;
    const enabled = consented && stored[WEBGPU_VISION_ENABLED_KEY] === true;
    const state = stored[WEBGPU_VISION_DOWNLOAD_STATE_KEY] || {};
    const modelMatches = !state.modelId || state.modelId === WEBGPU_VISION_MODEL_ID;
    const normalizedStateStatus = state.status === 'starting' ? 'queued' : state.status;
    const storedStatus = WEBGPU_VISION_STATUSES.has(normalizedStateStatus)
      ? normalizedStateStatus
      : 'not-downloaded';
    let status = enabled && modelMatches ? storedStatus : 'disabled';
    let progress = Math.max(0, Math.min(100, Number(state.progress) || 0));
    let loaded = Math.max(0, Number(state.loaded) || 0);
    let total = Math.max(0, Number(state.total) || 0);
    let error = String(state.error || '').slice(0, 500);
    let updatedAt = Math.max(0, Number(state.updatedAt) || 0);
    if (status === 'ready') {
      const cached = await hasWebgpuVisionCache(WEBGPU_VISION_MODEL_ID);
      if (cached === false) {
        status = 'not-downloaded';
        progress = 0;
        loaded = 0;
        total = 0;
        error = 'Cached vision artifacts are missing.';
        updatedAt = Date.now();
        try {
          await chrome.storage.local.set({
            [WEBGPU_VISION_DOWNLOAD_STATE_KEY]: {
              ...state,
              modelId: WEBGPU_VISION_MODEL_ID,
              status: 'not-downloaded',
              progress: 0,
              loaded: 0,
              total: 0,
              error,
              updatedAt,
            },
          });
        } catch {}
      }
    }
    return {
      enabled,
      consented,
      status,
      progress,
      loaded,
      total,
      error,
      updatedAt,
      modelId: WEBGPU_VISION_MODEL_ID,
    };
  }

  /**
   * Resolve screenshot routing without letting an enabled local fallback mask
   * a vision-capable active provider.
   */
  async resolveVisionRoute(activeProvider = null) {
    const override = await this.getVisionOverrideProvider();
    if (override) return { provider: override, route: 'explicit_override', rawImage: false };
    if (activeProvider?.supportsVision) {
      return { provider: activeProvider, route: 'active_raw', rawImage: true };
    }
    const fallback = await this.getLocalVisionFallbackProvider();
    if (fallback) {
      const visionStatus = await this.getWebgpuVisionReadiness().catch(() => ({
        enabled: true,
        consented: true,
        status: 'ready',
        progress: 100,
        loaded: 0,
        total: 0,
        error: '',
        updatedAt: 0,
        modelId: WEBGPU_VISION_MODEL_ID,
      }));
      return {
        provider: fallback,
        route: 'local_fallback',
        rawImage: false,
        visionStatus,
      };
    }
    const visionStatus = await this.getWebgpuVisionReadiness();
    return {
      provider: null,
      route: visionStatus.enabled ? 'local_fallback_unavailable' : 'none',
      rawImage: false,
      visionStatus,
    };
  }

  /** Backward-compatible name for the intentional external override only. */
  async getVisionProvider() {
    return this.getVisionOverrideProvider();
  }

  /** Release local vision memory without deleting the browser's model cache. */
  async disposeWebgpuVisionRuntime() {
    try {
      // Do not create an offscreen document merely to dispose a worker that
      // cannot exist. Older Chrome builds may not expose hasDocument(), in
      // which case dispatching is the safest fallback.
      const existsPromise = chrome.offscreen?.hasDocument?.();
      const exists = existsPromise ? await existsPromise.catch(() => null) : null;
      if (exists === false) return { ok: true, disposed: false };
      return await new WebGPUVisionProvider().dispose();
    } catch (error) {
      return { ok: false, error: error?.message || String(error) };
    }
  }

  /** Explicitly enable the Chrome-only local vision fallback and start its cache fill. */
  async enableAndPreloadWebgpuVision() {
    const provider = new WebGPUVisionProvider();
    const probe = await provider.testConnection();
    if (!probe.ok) return probe;

    await chrome.storage.local.set({
      [WEBGPU_VISION_ENABLED_KEY]: true,
      [WEBGPU_VISION_CONSENT_VERSION_KEY]: WEBGPU_VISION_CONSENT_VERSION,
    });
    await chrome.storage.local.remove(WEBGPU_VISION_AUTO_SELECTED_KEY);

    const readiness = await this.getWebgpuVisionReadiness();
    if (readiness.status === 'ready') {
      return { ok: true, started: false, ready: true };
    }

    return provider.preload();
  }

  async startWebgpuVisionDownload() {
    const readiness = await this.getWebgpuVisionReadiness();
    if (!readiness.enabled || !readiness.consented) {
      return {
        ok: false,
        recoverable: true,
        code: 'vision_consent_required',
        error: 'Enable local vision with “Use local fallback” in Settings first.',
        visionStatus: readiness,
      };
    }
    if (readiness.status === 'ready') return { ok: true, started: false, ready: true };
    return new WebGPUVisionProvider().preload();
  }

  async resumeWebgpuVisionDownload() {
    const readiness = await this.getWebgpuVisionReadiness();
    if (!readiness.enabled || !['queued', 'downloading', 'loading'].includes(readiness.status)) {
      return { ok: true, resumed: false, ...readiness };
    }
    return new WebGPUVisionProvider().preload();
  }

  async pauseWebgpuVisionDownload() {
    return new WebGPUVisionProvider().pauseDownload();
  }

  async stopWebgpuVisionDownload() {
    const stored = await chrome.storage.local.get('visionModel');
    const keys = [WEBGPU_VISION_ENABLED_KEY, WEBGPU_VISION_AUTO_SELECTED_KEY];
    if (stored.visionModel?.type === 'webgpu') keys.push('visionModel');
    // Disable selection before waiting for the serialized cache cleanup so a
    // concurrent screenshot cannot silently recreate the removed download.
    await chrome.storage.local.remove(keys);
    return new WebGPUVisionProvider().stopDownload();
  }

  _webgpuProvider() {
    const provider = this.providers.get('webgpu');
    if (!(provider instanceof WebGPUProvider)) throw new Error('WebGPU provider is unavailable.');
    return provider;
  }

  async getWebgpuDownloadStatus(msg = {}) {
    return this._webgpuProvider().downloadStatus(msg);
  }

  /** Configure a shipped Apocalypse text preset and start Compass cache fill. */
  async enableAndStartWebgpuTextDownload() {
    try {
      const currentModel = this.getAll().webgpu?.model;
      const preset = webgpuModelPreset(currentModel);
      const model = preset?.id || WEBGPU_COMPASS_TINY_V2_MODEL_ID;
      const dtype = preset?.dtype || webgpuModelDtype(model, WEBGPU_DTYPE);
      await this.updateProvider('webgpu', {
        model,
        dtype,
        contextWindow: preset?.contextWindow || 32768,
        promptTier: 'compact',
      });
      const provider = this._webgpuProvider();
      const probe = await provider.testConnection();
      if (!probe.ok) return probe;

      const status = await provider.downloadStatus();
      if (status.ready === true || ['downloading', 'stopping'].includes(status.status)) {
        return { ...status, ok: true, started: false };
      }
      // Bonsai is opt-in and too large to start from Apocalypse enable.
      if (webgpuModelRuntime(model) === WEBGPU_RUNTIME_BITGPU) {
        return { ...status, ok: true, started: false };
      }

      const result = await provider.startDownload();
      return {
        ...result,
        ok: true,
        started: result?.status === 'downloading',
      };
    } catch (error) {
      return { ok: false, error: error?.message || String(error) };
    }
  }

  async startWebgpuDownload(msg) {
    return this._webgpuProvider().startDownload(msg);
  }

  async pauseWebgpuDownload() {
    return this._webgpuProvider().pauseDownload();
  }

  async stopWebgpuDownload(msg) {
    try {
      return await this._webgpuProvider().stopDownload(msg);
    } finally {
      // Revalidate after completion or failure: cleanup can remove enough
      // files to make the model unusable before reporting an error. Keep this
      // central so Settings and Apocalypse Mode receive the same fallback.
      if (this.activeProviderId === 'webgpu') {
        try {
          const currentModel = this.providers.get('webgpu')?.config?.model;
          const status = await this._webgpuProvider().downloadStatus({ model: currentModel }).catch(() => null);
          if (status && status.ready !== true) {
            const fallback = this.providers.has(WEBBRAIN_CLOUD_PROVIDER_ID)
              ? WEBBRAIN_CLOUD_PROVIDER_ID
              : [...this.providers.keys()].find((candidate) => candidate !== 'webgpu') || WEBBRAIN_CLOUD_PROVIDER_ID;
            await this.setActive(fallback);
          }
        } catch {
          // Keep the selection; chat will report the missing download.
        }
      }
    }
  }

  /**
   * Switch the active provider.
   */
  async setActive(id) {
    if (!this.providers.has(id)) {
      throw new Error(`Provider not found: ${id}`);
    }
    const previousProvider = this.providers.get(this.activeProviderId);
    const nextProvider = this.providers.get(id);
    if (nextProvider instanceof WebGPUProvider) {
      const download = await nextProvider.downloadStatus();
      if (!download.ready) {
        throw new Error(`Download ${webgpuModelDisplayName(nextProvider.model)} in Settings > Providers > WebGPU or Apocalypse Mode > WebGPU before selecting it for chat.`);
      }
    }
    this.activeProviderId = id;
    await this.save();
    if (previousProvider instanceof WebGPUProvider && !(nextProvider instanceof WebGPUProvider)) {
      try {
        // Avoid creating the shared offscreen document just to dispose a model
        // that was never loaded. Older Chrome builds may not expose
        // hasDocument(), in which case dispatching is the safest fallback.
        const existsPromise = chrome.offscreen?.hasDocument?.();
        const exists = existsPromise ? await existsPromise.catch(() => null) : null;
        if (exists !== false) {
          const result = await previousProvider.dispose();
          if (!result?.ok) console.warn('[providers] WebGPU dispose failed:', result?.error || 'unknown error');
        }
      } catch (error) {
        console.warn('[providers] WebGPU dispose failed:', error?.message || error);
      }
    }
  }

  /**
   * Update a provider's configuration.
   */
  async updateProvider(id, config, { markConfigured = true } = {}) {
    if (!this.providers.has(id)) {
      throw new Error(`Provider not found: ${id}`);
    }
    const current = this.providers.get(id).config;
    const updates = this._storedDefaultOverride(current, config);
    for (const key of ['id', 'duplicateOf', 'sourceProviderId', 'isDuplicate', 'hasDuplicate', 'canDuplicate']) {
      delete updates[key];
    }
    const merged = {
      ...current,
      ...updates,
      configured: id !== WEBBRAIN_CLOUD_PROVIDER_ID && (markConfigured || current.configured === true),
    };
    if (id === 'webgpu' && Object.hasOwn(updates, 'model')) {
      merged.model = normalizeWebgpuModelId(merged.model);
      const preset = webgpuModelPreset(merged.model);
      if (preset?.contextWindow && !Object.hasOwn(updates, 'contextWindow')) {
        merged.contextWindow = preset.contextWindow;
      }
      // A retained Bonsai dtype ('q1') must not leak into a new target: a
      // custom ONNX repository would otherwise request model_q1.onnx instead
      // of the documented q4f16 graph. Reset to the preset (or ONNX default)
      // whenever the model changes unless the update explicitly supplies one.
      if (!Object.hasOwn(updates, 'dtype')) {
        merged.dtype = preset?.dtype || WEBGPU_DTYPE;
      }
    }
    if (id === 'webgpu' && merged.model === WEBGPU_COMPASS_TINY_XS_V3_MODEL_ID) {
      merged.contextWindow = Math.min(4096, Math.max(1024, Number(merged.contextWindow) || 4096));
      merged.maxOutputTokens = Math.min(2048, Math.max(1, Number(merged.maxOutputTokens) || 2048));
      merged.dtype = 'fp16';
    }
    if (this._providerDefinitionId(id, current) === 'ollama') {
      merged.visionMode = OLLAMA_VISION_MODES.has(merged.visionMode) ? merged.visionMode : 'auto';
      delete merged.supportsVision;
      const currentIdentity = this._ollamaVisionIdentity(current);
      const nextIdentity = this._ollamaVisionIdentity(merged);
      if (currentIdentity?.key !== nextIdentity?.key || current.visionMode !== merged.visionMode) {
        merged.visionDetection = null;
      }
    }
    const definitionId = this._providerDefinitionId(id, merged);
    const genericVisionKind = visionProviderKind(definitionId, merged);
    if (genericVisionKind) {
      const explicitLegacyVision = Object.hasOwn(config, 'supportsVision') && !Object.hasOwn(config, 'visionMode')
        ? config.supportsVision
        : null;
      merged.visionMode = typeof explicitLegacyVision === 'boolean'
        ? (explicitLegacyVision ? 'on' : 'off')
        : (VISION_MODES.has(merged.visionMode) ? merged.visionMode : 'auto');
      delete merged.supportsVision;
      const currentKind = visionProviderKind(this._providerDefinitionId(id, current), current);
      const currentIdentity = visionCapabilityIdentity(currentKind, current);
      const nextIdentity = visionCapabilityIdentity(genericVisionKind, merged);
      if (currentKind !== genericVisionKind || currentIdentity?.key !== nextIdentity?.key || current.visionMode !== merged.visionMode) {
        merged.visionDetection = null;
        this._visionCapabilityEpochs.set(id, (this._visionCapabilityEpochs.get(id) || 0) + 1);
        for (const key of this._visionCapabilityChecks.keys()) {
          if (key.startsWith(`${id}\n`)) this._visionCapabilityChecks.delete(key);
        }
      }
    }
    this.providers.set(id, this._createProvider(id, merged));
    // Revocation is permanent for queued data, even if sharing is enabled
    // again before another agent run. Await deletion before acknowledging it.
    // Explicit off updates also retry a previously failed purge.
    if (Object.hasOwn(updates, 'shareQueriesForResearch') && merged.shareQueriesForResearch !== true) {
      await purgeShareGenerations(entry => String(entry?.provider_id || '') === id);
    }
    // Editing the model of the active WebGPU provider to an undownloaded
    // target would leave every chat failing readiness (setActive() guards
    // selection but not edits). Fall back so the active selection stays usable.
    if (id === 'webgpu' && this.activeProviderId === 'webgpu' && Object.hasOwn(updates, 'model')) {
      try {
        const download = await this.providers.get('webgpu')?.downloadStatus?.();
        if (download && download.ready !== true) {
          const fallback = this.providers.has(WEBBRAIN_CLOUD_PROVIDER_ID)
            ? WEBBRAIN_CLOUD_PROVIDER_ID
            : [...this.providers.keys()].find((candidate) => candidate !== 'webgpu') || WEBBRAIN_CLOUD_PROVIDER_ID;
          // Reuse normal switching so the abandoned resident model releases
          // its GPU allocations as well as persisting the new selection.
          await this.setActive(fallback);
          return;
        }
      } catch {
        // Probe failures must not block saving; chat will report the missing download.
      }
    }
    await this.save();
  }

  /**
   * Create a fresh independently persisted instance of a configurable
   * provider. The duplicate keeps its source definition ID so UIs can reuse
   * the source card fields and branding, but it never inherits saved source
   * settings or credentials.
   */
  async duplicateProvider(id) {
    const source = this.providers.get(id);
    if (!source) throw new Error(`Provider not found: ${id}`);
    if (!this._canDuplicateProvider(id, source.config)) {
      throw new Error(`Provider cannot be duplicated: ${id}`);
    }
    if (source.config.configured !== true) {
      throw new Error(`Save provider before duplicating it: ${id}`);
    }
    const duplicateId = this._duplicateProviderId(id);
    if (this.providers.has(duplicateId) || [...this.providers.values()].some(provider => provider.config?.duplicateOf === id)) {
      throw new Error(`${source.config.label || id} already has a duplicate.`);
    }

    const baseline = this._defaultConfigs()[id];
    if (!baseline || baseline.type !== source.config.type) {
      throw new Error(`Provider definition not found: ${id}`);
    }
    const duplicateConfig = structuredClone(baseline);
    for (const key of DUPLICATE_BLANK_CONFIG_KEYS) delete duplicateConfig[key];
    duplicateConfig.duplicateOf = id;
    duplicateConfig.label = `${baseline.label || id} 2`;
    duplicateConfig.configured = false;
    this.providers.set(duplicateId, this._createProvider(duplicateId, duplicateConfig));
    try {
      await this.save();
    } catch (error) {
      this.providers.delete(duplicateId);
      throw error;
    }
    return { providerId: duplicateId, sourceProviderId: id };
  }

  /** Keep the persisted active ID valid when the selected duplicate disappears. */
  async removeDuplicateProvider(id) {
    const duplicate = this.providers.get(id);
    if (!duplicate) throw new Error(`Provider not found: ${id}`);
    const sourceId = duplicate.config?.duplicateOf;
    if (!sourceId) throw new Error('Only duplicate providers can be removed.');

    const previousActiveProviderId = this.activeProviderId;
    this.providers.delete(id);
    if (previousActiveProviderId === id) {
      const source = this.providers.get(sourceId);
      this.activeProviderId = source && (sourceId === WEBBRAIN_CLOUD_PROVIDER_ID || source.config?.configured === true)
        ? sourceId
        : WEBBRAIN_CLOUD_PROVIDER_ID;
    }
    try {
      if (duplicate.config?.shareQueriesForResearch === true) {
        await purgeShareGenerations(entry => String(entry?.provider_id || '') === id);
      }
      await this.save();
    } catch (error) {
      this.providers.set(id, duplicate);
      this.activeProviderId = previousActiveProviderId;
      throw error;
    }
    this._visionCapabilityEpochs.delete(id);
    for (const key of this._visionCapabilityChecks.keys()) {
      if (key.startsWith(`${id}\n`)) this._visionCapabilityChecks.delete(key);
    }
    return { removedProviderId: id, activeProviderId: this.activeProviderId };
  }

  /**
   * Get all provider configs for the settings UI. Each entry includes a
   * `category` field ('local' | 'cloud' | 'router') so the UI can filter
   * without re-deriving the classification.
   */
  getAll() {
    const result = {};
    const duplicatedSourceIds = new Set(
      [...this.providers.values()].map(provider => provider.config?.duplicateOf).filter(Boolean),
    );
    const duplicateEntriesBySourceId = new Map();
    for (const entry of this.providers) {
      const sourceId = entry[1].config?.duplicateOf;
      if (sourceId) duplicateEntriesBySourceId.set(sourceId, entry);
    }
    const orderedEntries = [];
    for (const entry of this.providers) {
      const [id, provider] = entry;
      if (provider.config?.duplicateOf) continue;
      orderedEntries.push(entry);
      const duplicateEntry = duplicateEntriesBySourceId.get(id);
      if (duplicateEntry) orderedEntries.push(duplicateEntry);
    }
    for (const entry of duplicateEntriesBySourceId.values()) {
      if (!this.providers.has(entry[1].config?.duplicateOf)) orderedEntries.push(entry);
    }
    for (const [id, provider] of orderedEntries) {
      const config = provider.config;
      const isDuplicate = !!config.duplicateOf;
      const hasDuplicate = !isDuplicate && duplicatedSourceIds.has(id);
      result[id] = {
        id,
        ...config,
        category: ProviderManager.categoryFor(id, config),
        sourceProviderId: this._providerDefinitionId(id, config),
        isDuplicate,
        hasDuplicate,
        canDuplicate: this._canDuplicateProvider(id, config) && !hasDuplicate,
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
    if (!candidates.length) {
      const result = await provider.testConnection();
      return this._attachDetectedContextWindow(id, provider, result);
    }

    let firstFailure = null;
    for (const baseUrl of candidates) {
      const candidateProvider = baseUrl === observedBaseUrl
        ? provider
        : this._createProvider(id, { ...provider.config, baseUrl });
      const result = await candidateProvider.testConnection();
      if (result.ok) {
        let next = result;
        if (baseUrl !== observedBaseUrl) {
          const updated = await this._updateProviderBaseUrl(id, baseUrl, observedBaseUrl);
          if (updated) next = { ...result, baseUrl };
        }
        const active = this.providers.get(id) || candidateProvider;
        return this._attachDetectedContextWindow(id, active, next);
      }
      if (!firstFailure) firstFailure = result;
    }
    return firstFailure || { ok: false, error: 'Provider connection failed' };
  }

  /**
   * Test the optional dedicated vision provider's connection.
   */
  async testVisionProvider() {
    const provider = await this.getVisionOverrideProvider()
      || await this.getLocalVisionFallbackProvider();
    if (!provider) return { ok: false, error: 'Vision model not configured' };
    let imageDataUrl;
    try {
      imageDataUrl = await loadVisionConnectionTestImage(chrome.runtime);
    } catch (error) {
      return { ok: false, error: error.message };
    }
    const isLocalWebgpu = provider.name === 'webgpu-vision';
    const probePrompt = isLocalWebgpu
      ? 'The image contains three solid vertical color panels. Name their colors from left to right. Reply with only the three color names.'
      : 'Read the three-character black code centered in the attached image. Reply with only that code.';
    const messages = [{
      role: 'user',
      content: [
        { type: 'image_url', image_url: { url: imageDataUrl } },
        { type: 'text', text: probePrompt },
      ],
    }];
    let attempts = 1;
    let reasoningControl = true;
    let result;
    try {
      result = await provider.chat(messages, {
        ...visionGenerationOptions(256, {
          reasoningControl,
          providerConfig: provider?.config,
        }),
        webbrainVisionProbe: true,
      });
    } catch (error) {
      if (!unsupportedVisionGenerationControl(error)) return { ok: false, error: error.message };
      reasoningControl = false;
      attempts++;
      try {
        result = await provider.chat(messages, {
          ...visionGenerationOptions(800, {
            reasoningControl,
            providerConfig: provider?.config,
          }),
          webbrainVisionProbe: true,
        });
      } catch (fallbackError) {
        return { ok: false, error: fallbackError.message };
      }
    }
    if (!String(result?.content || '').trim() && attempts === 1) {
      attempts++;
      try {
        result = await provider.chat(messages, {
          ...visionGenerationOptions(800, {
            reasoningControl,
            providerConfig: provider?.config,
          }),
          webbrainVisionProbe: true,
        });
      } catch (error) {
        return { ok: false, error: error.message };
      }
    }
    const probeText = String(result?.content || '').trim();
    if (!probeText) {
      return { ok: false, error: 'Vision model returned no visible description after the image probe.' };
    }
    const normalizedProbeText = probeText
      .toLowerCase()
      .replace(/\b(?:navy|azure)\b/g, 'blue')
      .replace(/\bgold(?:en)?\b/g, 'yellow');
    const yellowAt = normalizedProbeText.indexOf('yellow');
    const blueAt = normalizedProbeText.indexOf('blue');
    const redAt = normalizedProbeText.indexOf('red');
    const passed = isLocalWebgpu
      ? yellowAt >= 0 && blueAt > yellowAt && redAt > blueAt
      : /\bWB7\b/i.test(probeText);
    if (!passed) {
      const observed = probeText.replace(/\s+/g, ' ').slice(0, 120);
      return {
        ok: false,
        error: `Vision model responded but did not read the image probe correctly (received: "${observed}").`,
      };
    }
    return { ok: true, model: provider.model, baseUrl: provider.baseUrl };
  }

  /**
   * Test the optional dedicated transcription provider's connection.
   *
   * Sends a tiny valid silent WAV to /audio/transcriptions. A /models check is
   * insufficient because chat-only servers often expose the requested model
   * while lacking a Whisper-compatible audio route entirely.
   */
  async testTranscriptionProvider() {
    let cfg;
    try {
      const stored = await chrome.storage.local.get(['transcriptionModel']);
      cfg = stored?.transcriptionModel;
    } catch (e) {
      return { ok: false, error: 'Failed to read transcription config: ' + e.message };
    }
    if (!cfg || !cfg.baseUrl || !cfg.model) {
      return { ok: false, error: 'Transcription model not configured (Base URL and Model are required).' };
    }
    const baseUrl = normalizeOpenAICompatibleBaseUrl(cfg.baseUrl);
    const url = `${baseUrl}/audio/transcriptions`;
    const headers = {};
    if (cfg.apiKey) headers['Authorization'] = `Bearer ${cfg.apiKey}`;
    const form = new FormData();
    let audioBlob;
    try {
      audioBlob = await loadTranscriptionConnectionTestAudio(chrome.runtime);
    } catch (error) {
      return { ok: false, error: error.message };
    }
    form.append('file', audioBlob, 'webbrain-connection-test.wav');
    form.append('model', cfg.model);
    form.append('response_format', 'json');
    try {
      const res = await fetchWithFallback(url, { method: 'POST', headers, body: form });
      if (!res.ok) {
        let body = '';
        try { body = (await res.text()).slice(0, 300); } catch {}
        return { ok: false, error: `HTTP ${res.status}: ${body || res.statusText}` };
      }
      try {
        const data = await res.json();
        const payloadError = openAiCompatiblePayloadError(data);
        if (payloadError) return { ok: false, error: payloadError };
        if (typeof data?.text !== 'string' && typeof data?.transcript !== 'string') {
          return { ok: false, error: 'Transcription provider returned no transcript field.' };
        }
        return { ok: true, model: cfg.model, baseUrl };
      } catch (error) {
        return { ok: false, error: `Transcription provider returned invalid JSON: ${error.message}` };
      }
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  /**
   * Fetch selectable models for local providers. Ollama uses its native
   * /api/tags endpoint; llama.cpp, LM Studio, Jan, vLLM, SGLang, LocalAI,
   * GPT4All, Unsloth Studio, and generic local proxies use
   * OpenAI-compatible /v1/models.
   */
  async listProviderModels(id) {
    const provider = this.providers.get(id);
    if (!provider) return { ok: false, error: 'Provider not found' };
    const definitionId = this._providerDefinitionId(id, provider.config);
    if (!LOCAL_MODEL_LIST_PROVIDER_IDS.includes(definitionId)) {
      return { ok: false, error: 'Model loading is only supported for local providers' };
    }
    if (provider.config.requiresApiKey && !String(provider.config.apiKey || '').trim()) {
      return { ok: false, error: `${provider.config.label || provider.name} API key is required` };
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

    if (definitionId === 'lmstudio') {
      const host = rawBaseUrl.replace(/\/v1\/?$/, '');
      try {
        const res = await fetchWithFallback(`${host}/api/v0/models`, { method: 'GET', headers });
        if (res.ok) {
          const payload = await res.json();
          const models = this._extractLmStudioModels(payload);
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
    for (const candidate of this._modelListCandidates(definitionId, rawBaseUrl)) {
      const url = definitionId === 'ollama' ? `${candidate.requestBaseUrl}/api/tags` : `${candidate.requestBaseUrl}/models`;
      try {
        const res = await fetchWithFallback(url, { method: 'GET', headers });
        if (!res.ok) {
          let errBody = '';
          try { errBody = await res.text(); } catch {}
          if (res.status === 403) {
            // The OLLAMA_ORIGINS remediation only applies to Ollama — for
            // the other local providers sharing this path (llamacpp,
            // lmstudio, jan, vllm, sglang, localai) a 403 means something
            // else (auth proxy, --api-key, ...), so report it generically.
            if (!firstFailure) firstFailure = definitionId === 'ollama'
              ? {
                  ok: false,
                  error:
                    'Ollama returned 403 - set OLLAMA_ORIGINS="*" (or moz-extension://*,chrome-extension://*) and restart `ollama serve`.',
                }
              : this._modelListFailure(res.status, errBody, res.statusText);
            continue;
          }
          if (!firstFailure) firstFailure = this._modelListFailure(res.status, errBody, res.statusText);
          continue;
        }
        const data = await res.json();
        const models = this._extractModelIds(definitionId, data);
        const result = { ok: true, models };
        if (candidate.configBaseUrl !== observedBaseUrl) {
          if (await this._updateProviderBaseUrl(id, candidate.configBaseUrl, observedBaseUrl)) {
            result.baseUrl = candidate.configBaseUrl;
          } else {
            return result;
          }
        }
        const active = this.providers.get(id) || provider;
        if (
          active.config.baseUrl !== candidate.configBaseUrl ||
          active.config.model !== provider.config.model
        ) {
          return result;
        }
        return this._attachDetectedContextWindow(id, active, result, {
          requestBaseUrl: candidate.requestBaseUrl,
          modelListData: data,
        });
      } catch (e) {
        if (!firstFailure) firstFailure = { ok: false, error: e.message };
      }
    }
    return firstFailure || { ok: false, error: 'Failed to load models' };
  }

  async listOllamaModels(id) {
    return this.listProviderModels(id);
  }

  async detectProviderContextWindow(id, model) {
    const provider = this.providers.get(id);
    if (!provider) return { ok: false, error: 'Provider not found' };
    const selectedModel = String(model || '').trim();
    if (!selectedModel) return { ok: false, error: 'No model selected' };
    const savedModel = String(provider.config?.model || '').trim();
    if (savedModel !== selectedModel) {
      return { ok: false, error: 'Selected model changed before context detection completed' };
    }
    const observed = {
      model: provider.config?.model,
      baseUrl: provider.config?.baseUrl,
    };
    const detected = await this._detectLocalContextWindow(id, provider, { model: selectedModel });
    if (detected?.contextWindow == null) return { ok: false, error: 'No context window detected' };
    const current = this.providers.get(id) || provider;
    if (!shouldApplyDetectedContextWindow(current?.config?.contextWindow, detected.contextWindow, {
      shrinkOverride: detected.shrinkOverride === true,
    })) {
      return { ok: true };
    }
    if (!await this._updateProviderContextWindow(id, detected.contextWindow, observed)) {
      return { ok: false, error: 'Provider changed before context detection completed' };
    }
    return { ok: true, contextWindow: detected.contextWindow };
  }

  _modelListHeaders(provider) {
    const headers = { 'Accept': 'application/json' };
    const apiKey = provider?.config?.apiKey;
    if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
    return headers;
  }

  _modelListFailure(status, body = '', statusText = '') {
    const text = String(body || '').trim();
    if (status === 404 && /<!doctype\s+html|<html[\s>]|file not found/i.test(text)) {
      return {
        ok: false,
        error: 'No local model server was detected.',
        errorKey: 'ob.tokens.none_status',
      };
    }
    const compact = text.replace(/\s+/g, ' ').slice(0, 300);
    return { ok: false, error: `HTTP ${status}: ${compact || statusText || 'Request failed'}` };
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

  async _updateProviderContextWindow(id, contextWindow, observed = {}) {
    const current = this.providers.get(id);
    if (!current || !Number.isFinite(contextWindow) || contextWindow <= 0) return false;
    if (observed.model !== undefined && current.config.model !== observed.model) return false;
    if (observed.baseUrl !== undefined && current.config.baseUrl !== observed.baseUrl) return false;
    if (Number(current.config.contextWindow) === contextWindow) return true;
    this.providers.set(id, this._createProvider(id, { ...current.config, contextWindow }));
    await this.save();
    return true;
  }

  async _attachDetectedContextWindow(id, provider, result, options = {}) {
    const definitionId = this._providerDefinitionId(id, provider?.config);
    if (!result?.ok || !LOCAL_MODEL_LIST_PROVIDER_IDS.includes(definitionId)) return result;
    const observed = {
      model: provider?.config?.model,
      baseUrl: provider?.config?.baseUrl,
    };
    const detected = await this._detectLocalContextWindow(id, provider, options);
    if (detected?.contextWindow == null) return result;
    const current = this.providers.get(id) || provider;
    if (!shouldApplyDetectedContextWindow(current?.config?.contextWindow, detected.contextWindow, {
      shrinkOverride: detected.shrinkOverride === true,
    })) {
      return result;
    }
    if (!await this._updateProviderContextWindow(id, detected.contextWindow, observed)) {
      return result;
    }
    return { ...result, contextWindow: detected.contextWindow };
  }

  /**
   * Best-effort local context detection. Supported local servers expose usable
   * runtime/configured windows through provider-specific metadata; others no-op.
   * Returns
   * `{ contextWindow, shrinkOverride }` where shrinkOverride means the value
   * came from live/runtime allocation (safe to shrink a manual override).
   */
  async _detectLocalContextWindow(id, provider, options = {}) {
    const definitionId = this._providerDefinitionId(id, provider?.config);
    if (!LOCAL_MODEL_LIST_PROVIDER_IDS.includes(definitionId)) return null;
    const headers = this._modelListHeaders(provider);
    const rawBaseUrl = String(options.requestBaseUrl || provider?.config?.baseUrl || '')
      .trim()
      .replace(/\/+$/, '');
    if (!rawBaseUrl && definitionId !== 'lmstudio') return null;
    const root = rawBaseUrl.replace(/\/v1$/i, '');
    const model = String(options.model || provider?.config?.model || '').trim();

    try {
      if (definitionId === 'lmstudio') {
        const payload = options.lmStudioData || null;
        let data = payload;
        if (!data) {
          const host = root || rawBaseUrl.replace(/\/v1\/?$/, '');
          if (!host) return null;
          const res = await fetchWithFallback(`${host}/api/v0/models`, { method: 'GET', headers });
          if (!res.ok) return null;
          data = await res.json();
        }
        const contextWindow = parseLmStudioModelsContextWindow(data, model);
        if (contextWindow == null) return null;
        return {
          contextWindow,
          shrinkOverride: lmStudioContextWindowIsLive(data, model),
        };
      }

      if (definitionId === 'llamacpp') {
        const res = await fetchWithFallback(`${root}/props`, { method: 'GET', headers });
        if (!res.ok) return null;
        const contextWindow = parseLlamaCppPropsContextWindow(await res.json());
        if (contextWindow == null) return null;
        return { contextWindow, shrinkOverride: true };
      }

      if (definitionId === 'ollama') {
        // Prefer live allocated context from /api/ps (honors runtime num_ctx /
        // OLLAMA_CONTEXT_LENGTH). Fall back to /api/show num_ctx — never the
        // architecture max in model_info.*.context_length (overstates).
        // Show-only is good enough to refresh the 16k default, but not to
        // shrink a deliberate manual override.
        try {
          const psRes = await fetchWithFallback(`${root}/api/ps`, { method: 'GET', headers });
          if (psRes.ok) {
            const live = parseOllamaPsContextWindow(await psRes.json(), model);
            if (live != null) return { contextWindow: live, shrinkOverride: true };
          }
        } catch { /* fall through to /api/show */ }

        if (!model) return null;
        const res = await fetchWithFallback(`${root}/api/show`, {
          method: 'POST',
          headers: { ...headers, 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: model }),
        });
        if (!res.ok) return null;
        const contextWindow = parseOllamaShowContextWindow(await res.json());
        if (contextWindow == null) return null;
        return { contextWindow, shrinkOverride: false };
      }

      if (definitionId === 'vllm' || definitionId === 'sglang') {
        let data = options.modelListData || null;
        if (!data) {
          const openAiBase = /\/v1$/i.test(rawBaseUrl) ? rawBaseUrl : `${root}/v1`;
          const res = await fetchWithFallback(`${openAiBase}/models`, { method: 'GET', headers });
          if (!res.ok) return null;
          data = await res.json();
        }
        const contextWindow = parseOpenAiModelListContextWindow(data, model);
        if (contextWindow == null) return null;
        return { contextWindow, shrinkOverride: true };
      }

      if (definitionId === 'localai') {
        if (!model) return null;
        const res = await fetchWithFallback(`${root}/api/models/config-json/${encodeURIComponent(model)}`, {
          method: 'GET',
          headers,
        });
        if (!res.ok) return null;
        const contextWindow = parseLocalAiModelConfigContextWindow(await res.json());
        if (contextWindow == null) return null;
        return { contextWindow, shrinkOverride: true };
      }
    } catch {
      return null;
    }
    return null;
  }

  _extractModelIds(id, data) {
    const source = id === 'ollama' ? data?.models : data?.data;
    if (!Array.isArray(source)) return [];
    // Studio exposes its full catalog, but nonresident entries fail when
    // request-time model switching is disabled (the default).
    const selectable = id === 'unsloth'
      ? source.filter((m) => m?.loaded !== false)
      : source;
    const ids = selectable
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
      await chrome.storage.local.set({ [WEBBRAIN_DEVICE_GUID_KEY]: guid });
    } catch (e) {
      console.warn('[providers] failed to persist device guid:', e);
    }
    return guid;
  }

  _looksLikeGuid(value) {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value || ''));
  }

  async _deviceFingerprintMaterial() {
    const platform = await this._getPlatformInfo();
    const nav = globalThis.navigator || {};
    return JSON.stringify({
      runtimeId: chrome.runtime?.id || '',
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

  _getPlatformInfo() {
    return new Promise((resolve) => {
      try {
        const maybePromise = chrome.runtime.getPlatformInfo((info) => resolve(info || null));
        if (maybePromise && typeof maybePromise.then === 'function') {
          maybePromise.then((info) => resolve(info || null), () => resolve(null));
        }
      } catch {
        resolve(null);
      }
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
