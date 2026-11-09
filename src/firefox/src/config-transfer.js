import {
  CUSTOM_SKILLS_STORAGE_KEY,
  DEFAULT_SKILLS_REMOVED_STORAGE_KEY,
} from './agent/skills.js';
import {
  USER_MEMORY_AUTO_CAPTURE_KEY,
  USER_MEMORY_DEFAULT_MAX_PROMPT_CHARS,
  USER_MEMORY_ENABLED_KEY,
  USER_MEMORY_FORM_CAPTURE_KEY,
  USER_MEMORY_MAX_PROMPT_CHARS_KEY,
  USER_MEMORY_STORAGE_KEY,
} from './agent/user-memory.js';
import { AUTO_GROUP_TABS_KEY } from './tab-group-preference.js';
import { normalizeSettings as normalizeSafeSocialSettings, SETTINGS_KEY as SAFE_SOCIAL_SETTINGS_KEY } from './safesocial/config.js';
import { normalizeUiScale, UI_SCALE_STORAGE_KEY } from './ui/ui-scale.js';
import { DECISION_FEATURE_KEYS, DECISION_MODES, resolveDecisionConfig, resolveDecisionMode } from './agent/decision-config.js';

export const CONFIG_SCHEMA = 'webbrain-config/1';
export const MAX_CONFIG_IMPORT_CHARS = 10_000_000;

// This is intentionally an allowlist of user-controlled Settings state. It
// excludes conversations, traces, schedules, usage counters, the WebBrain
// Cloud device ID, and Cloud Sync session/token metadata.
export const DEFAULT_CONFIG_SETTINGS = Object.freeze({
  wbLocale: 'en',
  themeMode: 'system',
  [UI_SCALE_STORAGE_KEY]: 100,
  verboseMode: false,
  composerDeliveryMode: 'queue',
  agentIndicatorStyle: 'random',
  selectionShortcutEnabled: true,
  [AUTO_GROUP_TABS_KEY]: true,
  helpImproveWebBrain: true,
  screenshotFallback: true,
  maxAgentSteps: 130,
  requestTimeoutMs: 120_000,
  clarifyTimeoutSec: 60,
  clarifyTimeoutSemanticsV2: true,
  clarifyTimeoutPolicy: 'finish',
  autoScreenshot: 'navigation',
  useSiteAdapters: true,
  researchEscalationEnabled: false,
  researchEscalationEngine: 'chatgpt',
  voiceInputEnabled: true,
  alwaysAllowApiMutations: true,
  apiMutationObserverEnabled: true,
  pdfViewerEnabled: true,
  webMcpEnabled: true,
  openaiAskStreamingEnabled: true,
  planBeforeActMode: 'try',
  planBeforeAct: true,
  planReviewMode: 'confidence',
  planReviewConfidenceThreshold: 75,
  downloadDirectory: '',
  notifySound: true,
  completionConfetti: true,
  completionFlashTab: true,
  tracingEnabled: false,
  feedbackDiagnosticsEnabled: true,
  strictSecretMode: false,
  strictGuards: false,
  leanMode: 'auto',
  visionMode: 'auto',
  visionQuality: 'balanced',
  agentAllowLocalNetwork: false,
  scheduledTasksEnabled: true,
  scheduledRequireConsequentialConfirmation: true,
  providerFilter: 'all',
  costAllowanceSessionUsd: 10,
  costAllowanceTotalUsd: 10,
  screenshotRedaction: false,
  askBeforeConsequentialActions: true,
  wb_permissions: [],
  providers: {},
  activeProvider: 'webbrain_cloud',
  visionModel: null,
  transcriptionModel: null,
  imageGenModel: null,
  profileEnabled: false,
  profileText: '',
  [USER_MEMORY_STORAGE_KEY]: { version: 1, records: [] },
  [USER_MEMORY_ENABLED_KEY]: true,
  [USER_MEMORY_AUTO_CAPTURE_KEY]: true,
  [USER_MEMORY_FORM_CAPTURE_KEY]: true,
  [USER_MEMORY_MAX_PROMPT_CHARS_KEY]: USER_MEMORY_DEFAULT_MAX_PROMPT_CHARS,
  [CUSTOM_SKILLS_STORAGE_KEY]: [],
  [DEFAULT_SKILLS_REMOVED_STORAGE_KEY]: [],
  enableAllPackagedSkills: false,
  captchaSolverEnabled: false,
  capsolverApiKey: '',
  twoCaptchaApiKey: '',
  twoCaptchaEnabled: false,
  capsolverWeight: 100,
  twoCaptchaWeight: 99,
  capmonsterApiKey: '',
  capmonsterEnabled: false,
  capmonsterWeight: 98,
  solveCaptchaApiKey: '',
  solveCaptchaEnabled: false,
  solveCaptchaWeight: 97,
  antiCaptchaApiKey: '',
  antiCaptchaEnabled: false,
  antiCaptchaWeight: 96,
  nopechaApiKey: '',
  nopechaEnabled: false,
  nopechaWeight: 95,
  nonecapApiKey: '',
  nonecapEnabled: false,
  nonecapWeight: 94,
  solvechaApiKey: '',
  solvechaEnabled: false,
  solvechaWeight: 93,
  // Unset: decision-config.js maps a profile from before modes (On when
  // systemOneEnabled is true, else Auto), so old exports keep their meaning.
  decisionMode: '',
  systemOneEnabled: false,
  systemOneWatchEnabled: false,
  systemOneCompletionEnabled: false,
  systemOneFastClassifications: false,
  systemOneFastBrowser: false,
  systemOneWatchThreshold: 0.7,
  systemOneCompletionThreshold: 0.7,
  decisionProvider: '', decisionModel: '', decisionApiKey: '', decisionLocalApiKey: '', decisionBaseUrl: '', decisionVisionMode: 'auto', decisionVisionSupported: false,
  decisionInputRate: .02, decisionOutputRate: 0, systemOneDoneEnabled: true, systemOneDoneThreshold: .9,
  typesafeApiKey: '',
  [SAFE_SOCIAL_SETTINGS_KEY]: normalizeSafeSocialSettings(),
});

export const CONFIG_STORAGE_KEYS = Object.freeze(Object.keys(DEFAULT_CONFIG_SETTINGS));
const CONFIG_STORAGE_KEY_SET = new Set(CONFIG_STORAGE_KEYS);

const BOOLEAN_KEYS = new Set([
  'verboseMode',
  'selectionShortcutEnabled',
  AUTO_GROUP_TABS_KEY,
  'helpImproveWebBrain',
  'screenshotFallback',
  'clarifyTimeoutSemanticsV2',
  'useSiteAdapters',
  'researchEscalationEnabled',
  'voiceInputEnabled',
  'alwaysAllowApiMutations',
  'apiMutationObserverEnabled',
  'pdfViewerEnabled',
  'webMcpEnabled',
  'openaiAskStreamingEnabled',
  'planBeforeAct',
  'notifySound',
  'completionConfetti',
  'completionFlashTab',
  'tracingEnabled',
  'feedbackDiagnosticsEnabled',
  'strictSecretMode',
  'strictGuards',
  'agentAllowLocalNetwork',
  'scheduledTasksEnabled',
  'scheduledRequireConsequentialConfirmation',
  'screenshotRedaction',
  'askBeforeConsequentialActions',
  'profileEnabled',
  USER_MEMORY_ENABLED_KEY,
  USER_MEMORY_AUTO_CAPTURE_KEY,
  USER_MEMORY_FORM_CAPTURE_KEY,
  'enableAllPackagedSkills',
  'captchaSolverEnabled',
  'twoCaptchaEnabled',
  'capmonsterEnabled',
  'solveCaptchaEnabled',
  'antiCaptchaEnabled',
  'nopechaEnabled',
  'nonecapEnabled',
  'solvechaEnabled',
  'decisionVisionSupported', 'systemOneDoneEnabled',
  'systemOneEnabled',
  'systemOneWatchEnabled',
  'systemOneCompletionEnabled',
  'systemOneFastClassifications',
  'systemOneFastBrowser',
]);
const NUMBER_KEYS = new Set([
  'capsolverWeight',
  'twoCaptchaWeight',
  'capmonsterWeight',
  'solveCaptchaWeight',
  'antiCaptchaWeight',
  'nopechaWeight',
  'nonecapWeight',
  'solvechaWeight',
  'maxAgentSteps',
  'requestTimeoutMs',
  'clarifyTimeoutSec',
  'planReviewConfidenceThreshold',
  'costAllowanceSessionUsd',
  'costAllowanceTotalUsd',
  USER_MEMORY_MAX_PROMPT_CHARS_KEY,
  'decisionInputRate', 'decisionOutputRate', 'systemOneDoneThreshold',
  'systemOneWatchThreshold',
  'systemOneCompletionThreshold',
]);
const STRING_KEYS = new Set([
  'composerDeliveryMode',
  'agentIndicatorStyle',
  'clarifyTimeoutPolicy',
  'leanMode',
  'visionMode',
  'visionQuality',
  'wbLocale',
  'themeMode',
  'autoScreenshot',
  'researchEscalationEngine',
  'planBeforeActMode',
  'planReviewMode',
  'downloadDirectory',
  'providerFilter',
  'activeProvider',
  'profileText',
  'capsolverApiKey',
  'twoCaptchaApiKey',
  'capmonsterApiKey',
  'solveCaptchaApiKey',
  'antiCaptchaApiKey',
  'nopechaApiKey',
  'nonecapApiKey',
  'solvechaApiKey',
  'decisionMode', 'decisionProvider', 'decisionModel', 'decisionBaseUrl', 'decisionApiKey', 'decisionLocalApiKey', 'decisionVisionMode',
  'typesafeApiKey',
]);
const ARRAY_KEYS = new Set([
  'wb_permissions',
  CUSTOM_SKILLS_STORAGE_KEY,
  DEFAULT_SKILLS_REMOVED_STORAGE_KEY,
]);
const NULLABLE_OBJECT_KEYS = new Set(['visionModel', 'transcriptionModel', 'imageGenModel']);

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function clone(value) {
  return structuredClone(value);
}

function sanitizeProviders(value, { strict = false } = {}) {
  if (!isPlainObject(value)) return {};
  const providers = clone(value);
  for (const [id, config] of Object.entries(providers)) {
    if (!isPlainObject(config)) {
      if (strict) throw new Error(`Invalid provider configuration "${id}".`);
      delete providers[id];
      continue;
    }
    delete config.deviceGuid;
  }
  return providers;
}

function validSettingValue(key, value) {
  if (key === 'decisionProvider') return ['', 'openrouter', 'typesafe', 'local', 'webgpu_d1', 'webgpu_chat'].includes(value);
  if (key === 'decisionMode') return ['', ...DECISION_MODES].includes(value);
  if (key === 'decisionVisionMode') return ['auto', 'on', 'off'].includes(value);
  if (key === 'leanMode') return ['auto', 'on', 'off'].includes(value);
  // 'on' is Auto's name from before the option was renamed (currentSettingValue).
  if (key === 'visionMode') return ['auto', 'on', 'off'].includes(value);
  if (key === 'visionQuality') return ['economy', 'balanced', 'sharp'].includes(value);
  if (key === 'agentIndicatorStyle') return ['random', 'circuit', 'aurora', 'scan', 'gears', 'classic'].includes(value);
  if (key === 'decisionBaseUrl') {
    if (typeof value !== 'string') return false;
    try { resolveDecisionConfig({ decisionProvider: 'local', decisionBaseUrl: value }); return true; }
    catch { return false; }
  }
  if (BOOLEAN_KEYS.has(key)) return typeof value === 'boolean';
  if (NUMBER_KEYS.has(key)) return typeof value === 'number' && Number.isFinite(value);
  if (STRING_KEYS.has(key)) return typeof value === 'string';
  if (ARRAY_KEYS.has(key)) return Array.isArray(value);
  if (NULLABLE_OBJECT_KEYS.has(key)) return value === null || isPlainObject(value);
  if (key === 'providers' || key === USER_MEMORY_STORAGE_KEY || key === SAFE_SOCIAL_SETTINGS_KEY) return isPlainObject(value);
  return true;
}

// The in-browser chat-model decision provider (webgpu_chat) is Chrome-only.
// A Chrome configuration that selects it imports here in Auto (System One off):
// neither an unusable provider nor a silent switch of a local-only choice to
// a cloud provider. `sparse` (provisioning patches) leaves the stored
// provider as it is.
function dropChromeOnlyDecisionProvider(settings, { sparse = false } = {}) {
  if (settings.decisionProvider !== 'webgpu_chat') return;
  if (sparse) {
    delete settings.decisionProvider;
    // A sparse patch only changes what it names: a provider-only patch must not
    // rewrite the mode of an existing On or Off profile. A mode the patch does
    // carry is still downgraded, as in a full restore.
    if (Object.hasOwn(settings, 'systemOneEnabled')) settings.systemOneEnabled = false;
    if (Object.hasOwn(settings, 'decisionMode') && settings.decisionMode !== 'off') settings.decisionMode = 'auto';
    return;
  }
  settings.decisionProvider = DEFAULT_CONFIG_SETTINGS.decisionProvider;
  settings.systemOneEnabled = false;
  // On with that provider becomes Auto here; an explicit Off stays off.
  if (settings.decisionMode !== 'off') settings.decisionMode = 'auto';
}

// A value an older export names by a setting's former option: vision mode's
// Auto was called On ('on').
function currentSettingValue(key, value) {
  if (key === 'visionMode' && value === 'on') return 'auto';
  return value;
}

function normalizeSettings(source, { strict = false } = {}) {
  const settings = clone(DEFAULT_CONFIG_SETTINGS);
  if (!isPlainObject(source)) {
    if (strict) throw new Error('Configuration settings must be a JSON object.');
    return settings;
  }

  for (const key of CONFIG_STORAGE_KEYS) {
    if (!Object.hasOwn(source, key)) continue;
    const value = source[key];
    if (key === UI_SCALE_STORAGE_KEY) {
      settings[key] = normalizeUiScale(value);
      continue;
    }
    if (key === SAFE_SOCIAL_SETTINGS_KEY) {
      if (!isPlainObject(value)) {
        if (strict) throw new Error(`Invalid value for configuration setting "${key}".`);
        continue;
      }
      settings[key] = normalizeSafeSocialSettings(value);
      continue;
    }
    if (!validSettingValue(key, value)) {
      if (strict) throw new Error(`Invalid value for configuration setting "${key}".`);
      continue;
    }
    settings[key] = clone(currentSettingValue(key, value));
  }
  settings.providers = sanitizeProviders(settings.providers, { strict });
  dropChromeOnlyDecisionProvider(settings);
  if (!Object.hasOwn(source, 'decisionInputRate')) {
    const decisionProvider = settings.decisionProvider;
    settings.decisionInputRate = decisionProvider === 'typesafe' || (!decisionProvider && source.typesafeApiKey)
      ? .042 : ['local', 'webgpu_d1'].includes(decisionProvider) ? 0 : .02;
  }
  // A profile saved before modes existed and left in On keeps the old reading: a missing switch is
  // off. Every other profile (explicit On, Auto or Off, or a pre-mode profile that was not On)
  // switches to On with the omitted switches enabled, so they are materialized as on and a round
  // trip does not turn them into the old `false` defaults.
  const isLegacyOnProfile = !DECISION_MODES.includes(source?.decisionMode) && source?.systemOneEnabled === true;
  // The legacy reading is resolved from the profile itself (completion verification, for one, is off
  // for an in-browser provider that never stored its switch), not taken from the modern defaults.
  const legacyFeatures = isLegacyOnProfile ? resolveDecisionConfig(source).features : null;
  for (const [feature, key] of Object.entries(DECISION_FEATURE_KEYS)) {
    if (Object.hasOwn(source, key)) continue;
    if (legacyFeatures) settings[key] = legacyFeatures[feature] === true;
    else settings[key] = true;
  }
  return settings;
}

export function createConfigExport(stored = {}, options = {}) {
  const settings = normalizeSettings(stored);
  if (typeof options.locale === 'string' && options.locale) settings.wbLocale = options.locale;
  return {
    schema: CONFIG_SCHEMA,
    exportedAt: new Date(options.exportedAt ?? Date.now()).toISOString(),
    webbrainVersion: String(options.webbrainVersion || 'unknown'),
    warning: 'Contains plaintext provider API keys and other sensitive Settings data. Store securely.',
    settings,
  };
}

export function parseConfigImport(json) {
  const text = String(json || '');
  if (text.length > MAX_CONFIG_IMPORT_CHARS) throw new Error('Configuration JSON is too large.');
  if (!text.trim()) throw new Error('Paste configuration JSON or use /import --file.');

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('Configuration is not valid JSON.');
  }
  if (!isPlainObject(parsed) || parsed.schema !== CONFIG_SCHEMA) {
    throw new Error(`Expected a ${CONFIG_SCHEMA} export.`);
  }
  if (!isPlainObject(parsed.settings)) {
    throw new Error('Configuration settings must be a JSON object.');
  }

  return {
    settings: normalizeSettings(parsed.settings, { strict: true }),
    ignoredKeys: Object.keys(parsed.settings).filter((key) => !CONFIG_STORAGE_KEY_SET.has(key)),
    sourceVersion: typeof parsed.webbrainVersion === 'string' ? parsed.webbrainVersion : '',
  };
}

// Provisioning can apply an already-sanitized export as a sparse patch. Unlike
// the user-facing restore command above, omitted settings remain untouched.
export function parseConfigPatchImport(json) {
  const text = String(json || '');
  if (text.length > MAX_CONFIG_IMPORT_CHARS) throw new Error('Configuration JSON is too large.');
  if (!text.trim()) throw new Error('Paste configuration JSON or use /import --file.');

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('Configuration is not valid JSON.');
  }
  if (!isPlainObject(parsed) || parsed.schema !== CONFIG_SCHEMA) {
    throw new Error(`Expected a ${CONFIG_SCHEMA} export.`);
  }
  if (!isPlainObject(parsed.settings)) {
    throw new Error('Configuration settings must be a JSON object.');
  }

  const settings = {};
  const ignoredKeys = [];
  for (const [key, value] of Object.entries(parsed.settings)) {
    if (!CONFIG_STORAGE_KEY_SET.has(key)) {
      ignoredKeys.push(key);
      continue;
    }
    if (!validSettingValue(key, value)) {
      throw new Error(`Invalid value for configuration setting "${key}".`);
    }
    settings[key] = key === UI_SCALE_STORAGE_KEY
      ? normalizeUiScale(value)
      : key === SAFE_SOCIAL_SETTINGS_KEY
      ? normalizeSafeSocialSettings(value)
      : key === 'providers'
      ? sanitizeProviders(value, { strict: true })
      : clone(value);
  }
  dropChromeOnlyDecisionProvider(settings, { sparse: true });
  return {
    settings,
    ignoredKeys,
    sourceVersion: typeof parsed.webbrainVersion === 'string' ? parsed.webbrainVersion : '',
  };
}

export function mergeConfigPatchSettings(current = {}, patch = {}) {
  const merged = clone(patch);
  if (!Object.hasOwn(merged, 'providers')) return merged;
  const currentProviders = isPlainObject(current.providers) ? clone(current.providers) : {};
  const patchProviders = isPlainObject(merged.providers) ? merged.providers : {};
  // Cloud provisioning owns this provider's credentials, endpoint and device
  // identity. A portable export may contain a stale copy, so never let it
  // replace the runtime's current WebBrain Compass configuration.
  delete patchProviders.webbrain_cloud;
  delete patchProviders.webbrain_cloud_max;
  merged.providers = { ...currentProviders, ...patchProviders };
  return merged;
}
