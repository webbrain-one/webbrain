// The prompt tier a provider runs at ('compact' | 'mid' | 'full'), which picks
// the Act system prompt and tool set. One rule for the provider getter
// (base.js), the settings page's tier menu and Lean mode's Auto. Shared
// verbatim by the Chrome and Firefox builds (test/lean-mode.mjs checks that).

export const PROMPT_TIERS = Object.freeze(['compact', 'mid', 'full']);

// Local relays: apps on this computer that forward to the cloud subscriptions
// the user signed in with. WebBrain Companion embeds CLIProxyAPI, and the
// Local OpenAI-compatible Proxy is CLIProxyAPI on its own. Their category is
// local (their address is), but the model that answers is a cloud model.
export const LOCAL_RELAY_PROVIDER_NAMES = Object.freeze(['webbrain-companion', 'local-openai-proxy']);
const LOCAL_RELAY_PROVIDER_ID = /^(?:webbrain_companion|local_openai_proxy)(?:$|[_-])/;

/** Whether a provider config (and its provider id, for instances) is a local relay. */
export function isLocalRelay(config = {}, providerId = '') {
  let name = '';
  let id = '';
  try { name = String(config?.providerName ?? '').trim().toLowerCase(); } catch {}
  try { id = String(providerId || config?._providerId || '').trim().toLowerCase(); } catch {}
  return LOCAL_RELAY_PROVIDER_NAMES.includes(name) || LOCAL_RELAY_PROVIDER_ID.test(id);
}

/**
 * The tier a provider config resolves to. Cloud providers are always Full: the
 * tier is a small-model concern, offered only for local and router providers.
 * Otherwise a tier set in the config wins; failing that the legacy
 * useCompactPrompt maps to Compact; failing that local providers run at Mid and
 * everything else (routers) at Full.
 *
 * A local relay defaults to Full, and its stored tier counts only when the
 * user chose it (promptTierChosen): the settings page used to save the tier
 * menu's value with every provider, so a relay's stored Mid was nearly always
 * the old local default, not a choice.
 */
export function resolvePromptTier(config = {}, providerId = '') {
  if (config?.category === 'cloud') return 'full';
  const relay = isLocalRelay(config, providerId);
  const tier = config?.promptTier;
  if (PROMPT_TIERS.includes(tier) && (!relay || config?.promptTierChosen === true)) return tier;
  if (config?.useCompactPrompt) return 'compact';
  return config?.category === 'local' && !relay ? 'mid' : 'full';
}
