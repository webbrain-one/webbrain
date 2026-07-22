const COMPATIBILITY_PRESETS = new Set(['auto', 'openai', 'qwen', 'deepseek', 'openrouter', 'custom']);
const REASONING_EFFORTS = new Set(['auto', 'off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
const SYSTEM_PROMPT_ROLES = new Set(['auto', 'system', 'developer']);
const MAX_TOKEN_FIELDS = new Set(['auto', 'max_tokens', 'max_completion_tokens']);

export const RESERVED_EXTRA_BODY_KEYS = new Set([
  'model',
  'messages',
  'input',
  'instructions',
  'tools',
  'tool_choice',
  'stream',
  'max_tokens',
  'max_completion_tokens',
  'max_output_tokens',
]);

const UNSAFE_OBJECT_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

function clean(value) {
  return String(value || '').trim().toLowerCase();
}

export function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function allowedValue(value, allowed, fallback = 'auto') {
  const normalized = clean(value);
  return allowed.has(normalized) ? normalized : fallback;
}

export function normalizeProviderCompatibility(config = {}) {
  const compat = isPlainObject(config.compat) ? config.compat : {};
  return {
    preset: allowedValue(compat.preset ?? config.compatibilityPreset, COMPATIBILITY_PRESETS),
    reasoningEffort: allowedValue(compat.reasoningEffort ?? config.reasoningEffort, REASONING_EFFORTS),
    systemPromptRole: allowedValue(compat.systemPromptRole ?? config.systemPromptRole, SYSTEM_PROMPT_ROLES),
    maxTokensField: allowedValue(compat.maxTokensField ?? config.maxTokensField, MAX_TOKEN_FIELDS),
  };
}

export function isOfficialOpenAIConfig(config = {}) {
  const providerName = clean(config.providerName);
  if (providerName && providerName !== 'openai') return false;
  try {
    const url = new URL(config.baseUrl || 'https://api.openai.com/v1');
    return url.protocol === 'https:'
      && url.hostname.toLowerCase() === 'api.openai.com'
      && url.pathname.replace(/\/+$/, '') === '/v1';
  } catch {
    return false;
  }
}

export function shouldUseOpenAIResponsesApi(config = {}) {
  if (!isOfficialOpenAIConfig(config)) return false;
  // Match the official GPT-5.6 family only (base alias + Sol/Terra/Luna, with
  // optional dated suffixes). Proxies and non-OpenAI providers stay on Chat
  // Completions even when the model id contains "gpt-5.6".
  const model = String(config.model || '').trim().toLowerCase();
  return /^gpt-5\.6(?:$|-(?:sol|terra|luna)(?:$|-))/.test(model);
}

export function detectedCompatibilityPreset(config = {}) {
  const providerName = clean(config.providerName);
  const model = clean(config.model);
  if (providerName === 'openrouter') return 'openrouter';
  if (providerName === 'deepseek' || model.includes('deepseek')) return 'deepseek';
  if (model.includes('qwen')) return 'qwen';
  if (isOfficialOpenAIConfig(config)) return 'openai';
  return 'standard';
}

export function effectiveCompatibilityPreset(config = {}) {
  const compat = normalizeProviderCompatibility(config);
  return compat.preset === 'auto' ? detectedCompatibilityPreset(config) : compat.preset;
}

export function mapProviderMessages(messages, config = {}) {
  if (!Array.isArray(messages)) return [];
  const { systemPromptRole } = normalizeProviderCompatibility(config);
  if (systemPromptRole !== 'developer') return messages;
  return messages.map((message) => {
    if (!message || message.role !== 'system') return message;
    return { ...message, role: 'developer' };
  });
}

export function configuredMaxTokensField(config = {}, fallback = 'max_tokens') {
  const { maxTokensField } = normalizeProviderCompatibility(config);
  return maxTokensField === 'auto' ? fallback : maxTokensField;
}

export function addConfiguredMaxTokens(body, value, config = {}, fallback = 'max_tokens') {
  body[configuredMaxTokensField(config, fallback)] = value;
  return body;
}

function safeClone(value) {
  if (Array.isArray(value)) return value.map((item) => safeClone(item));
  if (!isPlainObject(value)) return value;
  const clone = {};
  for (const [key, child] of Object.entries(value)) {
    if (UNSAFE_OBJECT_KEYS.has(key)) continue;
    clone[key] = safeClone(child);
  }
  return clone;
}

function deepMerge(target, source) {
  const merged = isPlainObject(target) ? safeClone(target) : {};
  if (!isPlainObject(source)) return merged;
  for (const [key, value] of Object.entries(source)) {
    if (UNSAFE_OBJECT_KEYS.has(key)) continue;
    if (isPlainObject(value)) {
      merged[key] = deepMerge(merged[key], value);
    } else {
      merged[key] = safeClone(value);
    }
  }
  return merged;
}

function safeExtraBody(source) {
  if (!isPlainObject(source)) return {};
  const filtered = {};
  for (const [key, value] of Object.entries(source)) {
    if (RESERVED_EXTRA_BODY_KEYS.has(key) || UNSAFE_OBJECT_KEYS.has(key)) continue;
    filtered[key] = safeClone(value);
  }
  return filtered;
}

function mappedReasoningEffort(effort, preset) {
  if (effort === 'off') return 'none';
  if (preset === 'openrouter') {
    // OpenRouter's public effort ladder tops out at high.
    if (effort === 'minimal') return 'low';
    if (effort === 'xhigh' || effort === 'max') return 'high';
  }
  // OpenAI documents `max` as a distinct effort above `xhigh` (GPT-5.6).
  // Pass it through unchanged for the OpenAI preset and any other preset that
  // does not define its own clamp above.
  return effort;
}

export function compatibilityRequestBody(config = {}) {
  const compat = normalizeProviderCompatibility(config);
  if (compat.reasoningEffort === 'auto') return {};

  const preset = effectiveCompatibilityPreset(config);
  const enabled = compat.reasoningEffort !== 'off';
  if (preset === 'qwen') {
    return {
      chat_template_kwargs: enabled
        ? { enable_thinking: true, preserve_thinking: true }
        : { enable_thinking: false },
    };
  }
  if (preset === 'deepseek') {
    return { chat_template_kwargs: { thinking: enabled } };
  }
  if (preset === 'openrouter') {
    return enabled
      ? { reasoning: { effort: mappedReasoningEffort(compat.reasoningEffort, preset) } }
      : { reasoning: { enabled: false } };
  }
  if (preset === 'openai') {
    const effort = mappedReasoningEffort(compat.reasoningEffort, preset);
    return shouldUseOpenAIResponsesApi(config)
      ? { reasoning: { effort } }
      : { reasoning_effort: effort };
  }
  return {};
}

export function mergeProviderRequestBody(body, config = {}, perRequestExtraBody = undefined) {
  let extras = compatibilityRequestBody(config);
  extras = deepMerge(extras, safeExtraBody(config.extraBody));
  extras = deepMerge(extras, safeExtraBody(perRequestExtraBody));
  if (extras.chat_template_kwargs?.enable_thinking === false) {
    delete extras.chat_template_kwargs.preserve_thinking;
  }
  // Shallow-copy the body so untouched fields keep identity (Responses input
  // items must replay the exact same object references). Deep-merge only when
  // both sides have a plain object for the same key, so partial extras like
  // `{ reasoning: { summary } }` do not drop required nested fields.
  const result = isPlainObject(body) ? { ...body } : {};
  for (const [key, value] of Object.entries(extras)) {
    if (UNSAFE_OBJECT_KEYS.has(key)) continue;
    if (isPlainObject(value) && isPlainObject(result[key])) {
      result[key] = deepMerge(result[key], value);
    } else {
      result[key] = isPlainObject(value) || Array.isArray(value) ? safeClone(value) : value;
    }
  }
  return result;
}

export function validateProviderExtraBody(value) {
  if (!isPlainObject(value)) {
    return { ok: false, error: 'Custom request body must be a JSON object.' };
  }
  const reserved = Object.keys(value).filter((key) => RESERVED_EXTRA_BODY_KEYS.has(key));
  const unsafe = Object.keys(value).filter((key) => UNSAFE_OBJECT_KEYS.has(key));
  if (reserved.length) {
    return {
      ok: false,
      error: `Use the dedicated settings for reserved fields: ${reserved.join(', ')}.`,
      reserved,
    };
  }
  if (unsafe.length) {
    return { ok: false, error: `Unsafe object keys are not allowed: ${unsafe.join(', ')}.` };
  }
  return { ok: true, value };
}

export function parseProviderExtraBodyJson(raw) {
  const text = String(raw || '').trim();
  if (!text) return {};
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`Custom request body is not valid JSON: ${error.message}`);
  }
  const validation = validateProviderExtraBody(parsed);
  if (!validation.ok) throw new Error(validation.error);
  return parsed;
}
