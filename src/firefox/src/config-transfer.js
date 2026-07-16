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

export const CONFIG_SCHEMA = 'webbrain-config/1';
export const MAX_CONFIG_IMPORT_CHARS = 10_000_000;

// This is intentionally an allowlist of user-controlled Settings state. It
// excludes conversations, traces, schedules, usage counters, the WebBrain
// Cloud device ID, and Cloud Sync session/token metadata.
export const DEFAULT_CONFIG_SETTINGS = Object.freeze({
  wbLocale: 'en',
  themeMode: 'system',
  verboseMode: false,
  selectionShortcutEnabled: true,
  helpImproveWebBrain: true,
  screenshotFallback: true,
  maxAgentSteps: 130,
  requestTimeoutMs: 120_000,
  clarifyTimeoutSec: 60,
  clarifyTimeoutSemanticsV2: true,
  autoScreenshot: 'state_change',
  useSiteAdapters: true,
  voiceInputEnabled: true,
  apiMutationObserverEnabled: false,
  planBeforeActMode: 'try',
  planBeforeAct: true,
  planReviewMode: 'confidence',
  planReviewConfidenceThreshold: 75,
  notifySound: true,
  completionConfetti: true,
  tracingEnabled: false,
  strictSecretMode: false,
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
  profileEnabled: false,
  profileText: '',
  [USER_MEMORY_STORAGE_KEY]: { version: 1, records: [] },
  [USER_MEMORY_ENABLED_KEY]: true,
  [USER_MEMORY_AUTO_CAPTURE_KEY]: false,
  [USER_MEMORY_FORM_CAPTURE_KEY]: false,
  [USER_MEMORY_MAX_PROMPT_CHARS_KEY]: USER_MEMORY_DEFAULT_MAX_PROMPT_CHARS,
  [CUSTOM_SKILLS_STORAGE_KEY]: [],
  [DEFAULT_SKILLS_REMOVED_STORAGE_KEY]: [],
  captchaSolverEnabled: false,
  capsolverApiKey: '',
});

export const CONFIG_STORAGE_KEYS = Object.freeze(Object.keys(DEFAULT_CONFIG_SETTINGS));
const CONFIG_STORAGE_KEY_SET = new Set(CONFIG_STORAGE_KEYS);

const BOOLEAN_KEYS = new Set([
  'verboseMode',
  'selectionShortcutEnabled',
  'helpImproveWebBrain',
  'screenshotFallback',
  'clarifyTimeoutSemanticsV2',
  'useSiteAdapters',
  'voiceInputEnabled',
  'apiMutationObserverEnabled',
  'planBeforeAct',
  'notifySound',
  'completionConfetti',
  'tracingEnabled',
  'strictSecretMode',
  'agentAllowLocalNetwork',
  'scheduledTasksEnabled',
  'scheduledRequireConsequentialConfirmation',
  'screenshotRedaction',
  'askBeforeConsequentialActions',
  'profileEnabled',
  USER_MEMORY_ENABLED_KEY,
  USER_MEMORY_AUTO_CAPTURE_KEY,
  USER_MEMORY_FORM_CAPTURE_KEY,
  'captchaSolverEnabled',
]);
const NUMBER_KEYS = new Set([
  'maxAgentSteps',
  'requestTimeoutMs',
  'clarifyTimeoutSec',
  'planReviewConfidenceThreshold',
  'costAllowanceSessionUsd',
  'costAllowanceTotalUsd',
  USER_MEMORY_MAX_PROMPT_CHARS_KEY,
]);
const STRING_KEYS = new Set([
  'wbLocale',
  'themeMode',
  'autoScreenshot',
  'planBeforeActMode',
  'planReviewMode',
  'providerFilter',
  'activeProvider',
  'profileText',
  'capsolverApiKey',
]);
const ARRAY_KEYS = new Set([
  'wb_permissions',
  CUSTOM_SKILLS_STORAGE_KEY,
  DEFAULT_SKILLS_REMOVED_STORAGE_KEY,
]);
const NULLABLE_OBJECT_KEYS = new Set(['visionModel', 'transcriptionModel']);

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
  if (BOOLEAN_KEYS.has(key)) return typeof value === 'boolean';
  if (NUMBER_KEYS.has(key)) return typeof value === 'number' && Number.isFinite(value);
  if (STRING_KEYS.has(key)) return typeof value === 'string';
  if (ARRAY_KEYS.has(key)) return Array.isArray(value);
  if (NULLABLE_OBJECT_KEYS.has(key)) return value === null || isPlainObject(value);
  if (key === 'providers' || key === USER_MEMORY_STORAGE_KEY) return isPlainObject(value);
  return true;
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
    if (!validSettingValue(key, value)) {
      if (strict) throw new Error(`Invalid value for configuration setting "${key}".`);
      continue;
    }
    settings[key] = clone(value);
  }
  settings.providers = sanitizeProviders(settings.providers, { strict });
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
