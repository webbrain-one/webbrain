// Lean mode: Settings → Advanced → "Lean mode" ('auto' | 'on' | 'off').
//
// A strong model does not need WebBrain's verification scaffolding: the
// readbacks, completion judges and forced re-check turns that help small
// local models slow it down and can strand a run that was going fine. Lean
// mode skips every guard of class `quality` (guard-policy.js) in an Act run;
// the run keeps its tier's tools and prompt, plus one note asking the model to
// check its own work. The hard classes, permission gates, host checks, budgets
// and user control stay.
//
// This module decides when Auto turns lean mode on. It is shared verbatim by
// the Chrome and Firefox builds (test/lean-mode.mjs checks that).

import { guardEntry } from './guard-policy.js';
import { isLocalRelay, resolvePromptTier } from '../providers/prompt-tier.js';

export const LEAN_MODE_SETTINGS = Object.freeze(['auto', 'on', 'off']);
export const DEFAULT_LEAN_MODE = 'auto';

export function normalizeLeanModeSetting(value) {
  const text = String(value ?? '').trim().toLowerCase();
  return LEAN_MODE_SETTINGS.includes(text) ? text : DEFAULT_LEAN_MODE;
}

// Strong models, by model id. A model id is matched in lower case anywhere in
// the string, so router ids ("anthropic/claude-sonnet-4.5"), Bedrock ids
// ("us.anthropic.claude-opus-4-1-...") and dated snapshots all match. `min` is
// the lowest generation that counts; `exclude` drops small variants. Keep
// this list short and add families as they prove themselves.
export const LEAN_STRONG_MODEL_RULES = Object.freeze([
  // Claude Opus and Sonnet, generation 4 and later, and the Mythos-tier
  // Fable and Mythos models.
  Object.freeze({ family: 'claude', pattern: /claude-(?:opus|sonnet|fable|mythos)-(\d+)/, min: 4 }),
  Object.freeze({ family: 'claude', pattern: /claude-(\d+)(?:[.-]\d+)?-(?:opus|sonnet|fable|mythos)/, min: 4 }),
  // GPT-5 and later, gpt-6 variants included. Nano models are small.
  Object.freeze({ family: 'gpt', pattern: /(?:^|[^a-z])gpt-(\d+)/, min: 5, exclude: /nano/ }),
  // OpenAI o3/o4 reasoning models and later o-series.
  Object.freeze({ family: 'openai-reasoning', pattern: /(?:^|[/.:])o(\d+)(?:-|$)/, min: 3 }),
  // Gemini 2.5 Pro and newer Pro or Ultra models.
  Object.freeze({ family: 'gemini', pattern: /gemini-(\d+(?:\.\d+)?)-(?:pro|ultra)/, min: 2.5 }),
  // Gemini Flash from generation 3 (gemini-3-flash, gemini-3.8-flash-high).
  // Flash-Lite is a smaller model, and Flash before 3 stays off the list.
  Object.freeze({ family: 'gemini', pattern: /gemini-(\d+(?:\.\d+)?)-flash/, min: 3, exclude: /flash-lite/ }),
  // Grok 4 and later.
  Object.freeze({ family: 'grok', pattern: /grok-(\d+)/, min: 4 }),
]);

/** The strong-model family a model id belongs to, or '' when it is not listed. */
export function strongModelFamily(modelId) {
  const id = String(modelId ?? '').trim().toLowerCase();
  if (!id) return '';
  for (const rule of LEAN_STRONG_MODEL_RULES) {
    const match = rule.pattern.exec(id);
    if (!match || Number(match[1]) < rule.min) continue;
    if (rule.exclude && rule.exclude.test(id)) continue;
    return rule.family;
  }
  return '';
}

// Providers that run on the user's machine or in the browser. Auto never
// turns lean mode on for them, whatever model they serve: a local model may
// carry a strong model's name ("...-claude-sonnet-4-distill"). The type and
// id lists only classify a provider whose config names no category.
const LOCAL_PROVIDER_TYPES = Object.freeze(['llamacpp', 'webgpu']);
const LOCAL_PROVIDER_ID = /^(?:llamacpp|ollama|lmstudio|webgpu)(?:$|[_-])/;

// Local relays to the cloud (WebBrain Companion, the Local OpenAI-compatible
// Proxy; see providers/prompt-tier.js): their category is local, but the model
// that answers is the cloud model they serve, so Auto judges them by that
// model, as it does a router. The one model the Companion runs itself
// (Bonsai) is not on the strong list.

// The first value that is a non-blank string, read lazily: a provider's
// getters can throw, and a blank configured value (model: '') means "not
// set", so the provider's own default applies.
function firstText(...reads) {
  for (const read of reads) {
    let value;
    try { value = read(); } catch { continue; }
    if (value == null) continue;
    const text = String(value);
    if (text.trim()) return text;
  }
  return '';
}

/**
 * What Auto needs to know about a provider. Accepts a provider instance (its
 * `config`, `promptTier` and effective `model`) or a plain description for
 * tests and tools.
 */
export function leanProviderInfo(provider) {
  const config = provider?.config && typeof provider.config === 'object' ? provider.config : provider || {};
  const category = firstText(() => config.category, () => provider?.category).trim().toLowerCase();
  const type = firstText(() => config.type, () => provider?.type).trim().toLowerCase();
  const providerId = firstText(() => config._providerId, () => provider?.providerId).trim().toLowerCase();
  const providerName = firstText(() => config.providerName, () => provider?.providerName).trim().toLowerCase();
  // A blank configured model is unset: the provider's model getter returns
  // the model it actually calls (AnthropicProvider defaults to its own).
  const model = firstText(() => config.model, () => provider?.model).trim();
  const relay = isLocalRelay({ providerName }, providerId);
  // A relay's stored tier counts only when the user chose it; its getter
  // already reads it that way, and a plain config is read the same way.
  const promptTier = (relay ? resolvePromptTier(config, providerId)
    : firstText(() => provider?.promptTier, () => config.promptTier)).trim().toLowerCase();
  // An explicit category decides, as ProviderManager.categoryFor does: the
  // built-in Ollama Cloud is 'cloud' although its id starts with "ollama-".
  // The type and id lists only classify a config written without one.
  const remote = category === 'cloud' || category === 'router';
  const local = !relay && (category === 'local'
    || (!remote && (LOCAL_PROVIDER_TYPES.includes(type) || LOCAL_PROVIDER_ID.test(providerId))));
  const cloud = !local && (remote || relay);
  return { category, type, providerId, providerName, model, promptTier, relay, local, cloud };
}

/**
 * Whether lean mode applies to a run. Lean mode is an Act-mode setting; Ask
 * and Dev keep their own behavior. 'on' and 'off' are the user's choice.
 * 'auto' needs a cloud provider, or a local relay to the cloud (WebBrain
 * Companion, the Local OpenAI-compatible Proxy), serving a listed strong
 * model; never llama.cpp, Ollama, LM Studio, WebGPU or any other local
 * provider. The provider's prompt tier vetoes it: a provider the user set to
 * the Compact or Mid tier is never lean under Auto. A relay defaults to Full,
 * and its stored tier counts only once the user chose it (prompt-tier.js).
 * Returns { active, setting, reason, family? }.
 */
export function resolveLeanMode(setting, { mode = 'act', provider = null } = {}) {
  const value = normalizeLeanModeSetting(setting);
  if (mode !== 'act') return { active: false, setting: value, reason: 'not_act_mode' };
  if (value === 'on') return { active: true, setting: value, reason: 'setting_on' };
  if (value === 'off') return { active: false, setting: value, reason: 'setting_off' };
  const info = leanProviderInfo(provider);
  if (info.local) return { active: false, setting: value, reason: 'local_provider' };
  if (!info.cloud) return { active: false, setting: value, reason: 'unknown_provider' };
  if (info.promptTier === 'compact' || info.promptTier === 'mid') {
    return { active: false, setting: value, reason: 'prompt_tier' };
  }
  const family = strongModelFamily(info.model);
  if (!family) return { active: false, setting: value, reason: 'model_not_listed' };
  return { active: true, setting: value, reason: info.relay ? 'strong_relay_model' : 'strong_cloud_model', family };
}

// Quality guards that keep running in lean mode, with the reason. Each one
// produces evidence a hard check consumes, or protects a step a hard check
// relies on; skipping it would weaken that hard check. Ids the agent never
// consults through the guard helpers keep their behavior anyway; they are
// listed so the docs and tests name every exception.
export const LEAN_KEPT_QUALITY_GUARDS = Object.freeze({
  'owned-native-chat-read-repair': 'The recipient guard needs WebBrain\'s own exact read of the latest messages before a reply is sent.',
  'chat-send-evidence-unavailable': 'A send whose conversation or message baseline cannot be observed cannot be checked for the right recipient or a duplicate.',
  'recipient-draft-evidence-unavailable': 'The recipient guard reads the draft body and the message baseline to verify a send.',
  'recipient-guard-target-preparation': 'It runs inside the recipient guard\'s own target resolution.',
  'preparation-timeout-action-pipeline': 'The same deadline covers the publication audit, chat-send preparation and the task-attempt checkpoint.',
  'social-publication-draft-quality': 'The publication audit judges the observed composer draft; a draft it cannot observe cannot be audited.',
  'steer-prior-submission-target-unresolved': 'After a correction, an unidentified submit control may repeat an earlier submission.',
  'captcha-solve-detection-binding': 'It keeps a paid CAPTCHA solve from going to the wrong widget.',
  'set-field-bundled-submit-outcome': 'set_field never sends its bundled Enter for a value it could not verify (content script).',
  'clickax-native-button-preparation': 'Its vetoes include a person acting in the tab and a change of task owner (host checks).',
  'clickax-trusted-retry-vetoes': 'It stops WebBrain\'s own automatic re-click from acting twice.',
  'action-no-progress-classification': 'It feeds the loop detector, a budget.',
  'terminal-recovery-no-success': 'It is the ending of the step-limit and observation budgets.',
});

/** True when lean mode skips guard `id`: a registered quality guard that is not kept. */
export function leanSkipsGuard(id) {
  const entry = guardEntry(id);
  return entry?.class === 'quality' && !Object.hasOwn(LEAN_KEPT_QUALITY_GUARDS, String(id));
}
