const STRING_ENUMS = Object.freeze({
  browser_target: new Set(['chrome', 'firefox']),
  mode: new Set(['ask', 'act', 'dev']),
  prompt_tier: new Set(['compact', 'mid', 'full']),
  generative_media_availability: new Set(['available', 'not_configured', 'tier_restricted', 'profile_restricted', 'ask_mode']),
  plan_before_act_mode: new Set(['off', 'try', 'strict']),
  auto_screenshot: new Set(['off', 'navigation', 'state_change', 'every_step']),
  image_detail: new Set(['auto', 'low', 'high']),
  selection_scope_policy: new Set(['selection_only', 'selection_context']),
  lean_mode_setting: new Set(['auto', 'on', 'off']),
  vision_mode_setting: new Set(['auto', 'off']),
});

const BOOLEAN_FIELDS = Object.freeze([
  'generative_media_configured',
  'screenshot_redaction',
  'strict_secret_mode',
  'use_site_adapters',
  'web_mcp_enabled',
  'api_mutations_allowed',
  'user_memory_enabled',
  'selection_grounded',
  'standalone_chat_profile',
  'standalone_webgpu_profile',
  'tiny_ask_profile',
  'lossless_trace',
  'selection_scope_anchor_present',
  'lean_mode',
  'enforce_action_guards',
  'vision_mode',
]);

// Bounds keep the payload sane, not to re-validate settings: each range is a
// superset of what the agent's own normalizers can hold (steps ≤ 200 with 0 =
// unlimited, dimension ≤ 2048, screenshots ≤ 5), so a legitimate setting is
// never silently dropped for being out of range.
const INTEGER_RANGES = Object.freeze({
  max_agent_steps: [0, 10_000],
  max_image_dimension: [1, 16_384],
  max_screenshots_per_turn: [0, 1_000],
  selection_scope_excluded_messages: [0, 10_000],
});

function safeVersion(value) {
  const version = String(value || '').trim();
  return /^[0-9A-Za-z][0-9A-Za-z.+_-]{0,63}$/.test(version) ? version : '';
}

/**
 * Runtime trace metadata crosses both a provider boundary and an export
 * boundary. Keep it to a small, versioned allowlist of booleans, bounded
 * integers, and enums so a caller can never smuggle credentials or profile
 * contents into a trace by passing an arbitrary settings object.
 */
export function normalizeRuntimeTraceConfig(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;

  const normalized = { schema_version: 1 };
  const extensionVersion = safeVersion(value.extension_version);
  if (extensionVersion) normalized.extension_version = extensionVersion;

  for (const [field, allowed] of Object.entries(STRING_ENUMS)) {
    const candidate = String(value[field] || '').trim().toLowerCase();
    if (allowed.has(candidate)) normalized[field] = candidate;
  }
  for (const field of BOOLEAN_FIELDS) {
    if (typeof value[field] === 'boolean') normalized[field] = value[field];
  }
  for (const [field, [min, max]] of Object.entries(INTEGER_RANGES)) {
    const candidate = Number(value[field]);
    if (Number.isInteger(candidate) && candidate >= min && candidate <= max) {
      normalized[field] = candidate;
    }
  }

  return normalized;
}
