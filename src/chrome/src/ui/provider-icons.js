/**
 * Provider brand icons for settings + sidepanel.
 *
 * Assets live in icons/providers/ (Lobe Icons MIT subset + a few official
 * marks for brands Lobe does not ship). See icons/providers/SOURCES.md.
 * Unknown ids return empty so we never invent monograms.
 */

export const PROVIDER_ICON_FILES = {
  webbrain_cloud: 'webbrain_cloud.png',
  llamacpp: 'llamacpp.svg',
  ollama: 'ollama.svg',
  lmstudio: 'lmstudio.svg',
  jan: 'jan.png',
  vllm: 'vllm.svg',
  sglang: 'sglang.png',
  localai: 'localai.png',
  azure_openai: 'azure_openai.svg',
  aws_bedrock: 'aws_bedrock.svg',
  openai: 'openai.svg',
  anthropic: 'anthropic.svg',
  gemini: 'gemini.svg',
  cloudflare: 'cloudflare.svg',
  mistral: 'mistral.svg',
  deepseek: 'deepseek.svg',
  xai: 'xai.svg',
  nvidia: 'nvidia.svg',
  groq: 'groq.svg',
  minimax: 'minimax.svg',
  kimi: 'kimi.svg',
  alibaba: 'alibaba.svg',
  together: 'together.svg',
  openrouter: 'openrouter.svg',
  huggingface: 'huggingface.svg',
  fireworks: 'fireworks.svg',
  z_ai: 'z_ai.svg',
};

export function providerIconUrl(id) {
  const file = PROVIDER_ICON_FILES[id];
  if (!file) return '';
  try {
    if (typeof chrome !== 'undefined' && chrome.runtime?.getURL) {
      return chrome.runtime.getURL(`icons/providers/${file}`);
    }
  } catch { /* fall through */ }
  return `../../icons/providers/${file}`;
}

/**
 * @param {string} id
 * @param {string} [label] unused when decorative (default); kept for call-site compat
 * @param {string} [className]
 * @param {{ decorative?: boolean }} [opts] decorative icons use empty alt (list rows next to a visible name)
 */
export function providerIconHtml(id, label, className = 'provider-icon', opts = {}) {
  const src = providerIconUrl(id);
  if (!src) return '';
  const safeSrc = String(src).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
  const decorative = opts.decorative !== false;
  const safeAlt = decorative
    ? ''
    : String(label || id || '')
      .replace(/&/g, '&amp;')
      .replace(/"/g, '&quot;')
      .replace(/</g, '&lt;');
  const safeClass = String(className || 'provider-icon').replace(/[^a-zA-Z0-9 _-]/g, '');
  return `<img class="${safeClass}" src="${safeSrc}" alt="${safeAlt}" width="20" height="20" decoding="async" draggable="false">`;
}

/** Short display name for a known provider id (sniff hints, menus). */
export const PROVIDER_SHORT_LABELS = {
  webbrain_cloud: 'WebBrain Cloud',
  llamacpp: 'llama.cpp',
  ollama: 'Ollama',
  lmstudio: 'LM Studio',
  jan: 'Jan',
  vllm: 'vLLM',
  sglang: 'SGLang',
  localai: 'LocalAI',
  azure_openai: 'Azure OpenAI',
  aws_bedrock: 'AWS Bedrock',
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  gemini: 'Gemini',
  cloudflare: 'Cloudflare',
  mistral: 'Mistral',
  deepseek: 'DeepSeek',
  xai: 'xAI',
  nvidia: 'NVIDIA',
  groq: 'Groq',
  minimax: 'MiniMax',
  kimi: 'Kimi',
  alibaba: 'Qwen',
  together: 'Together',
  openrouter: 'OpenRouter',
  huggingface: 'Hugging Face',
  fireworks: 'Fireworks',
  z_ai: 'z.ai GLM',
};

/** Hostname equals domain or is a subdomain of it (avoids substring spoofing). */
function hostMatchesDomain(host, domain) {
  if (!host || !domain) return false;
  return host === domain || host.endsWith(`.${domain}`);
}

/**
 * Best-effort provider id from an OpenAI-compatible base URL.
 * Used by Multimodal settings to show a brand mark when the user pastes
 * a known endpoint — not a security boundary, just a UX hint.
 * Matches on parsed hostname only (CodeQL: no raw-URL substring checks).
 */
export function sniffProviderIdFromBaseUrl(baseUrl) {
  const raw = String(baseUrl || '').trim();
  if (!raw) return '';
  let host = '';
  let port = '';
  try {
    const u = new URL(raw.includes('://') ? raw : `http://${raw}`);
    host = (u.hostname || '').toLowerCase();
    port = u.port || '';
  } catch {
    return '';
  }
  if (!host) return '';

  if (host === 'localhost' || host === '127.0.0.1' || host === '0.0.0.0' || host.endsWith('.local')) {
    if (port === '11434') return 'ollama';
    if (port === '1234') return 'lmstudio';
    if (port === '1337') return 'jan';
    if (port === '30000') return 'sglang';
    if (port === '8000') return 'vllm';
    if (port === '8080') return 'llamacpp';
    return '';
  }

  if (hostMatchesDomain(host, 'openrouter.ai')) return 'openrouter';
  if (host === 'api.openai.com' || hostMatchesDomain(host, 'openai.com')) return 'openai';
  if (hostMatchesDomain(host, 'anthropic.com')) return 'anthropic';
  if (host === 'generativelanguage.googleapis.com' || hostMatchesDomain(host, 'googleapis.com')) return 'gemini';
  if (host === 'api.x.ai' || hostMatchesDomain(host, 'x.ai')) return 'xai';
  if (hostMatchesDomain(host, 'groq.com')) return 'groq';
  if (hostMatchesDomain(host, 'mistral.ai')) return 'mistral';
  if (hostMatchesDomain(host, 'deepseek.com')) return 'deepseek';
  if (hostMatchesDomain(host, 'fireworks.ai')) return 'fireworks';
  if (hostMatchesDomain(host, 'together.xyz') || hostMatchesDomain(host, 'together.ai')) return 'together';
  if (hostMatchesDomain(host, 'huggingface.co') || hostMatchesDomain(host, 'hf.co')) return 'huggingface';
  if (hostMatchesDomain(host, 'cloudflare.com') || hostMatchesDomain(host, 'workers.dev')) return 'cloudflare';
  if (host === 'integrate.api.nvidia.com' || hostMatchesDomain(host, 'nvidia.com')) return 'nvidia';
  if (host === 'openai.azure.com' || host.endsWith('.openai.azure.com')) return 'azure_openai';
  // Bedrock runtime hosts are subdomains of amazonaws.com.
  if (hostMatchesDomain(host, 'amazonaws.com')) return 'aws_bedrock';
  if (hostMatchesDomain(host, 'moonshot.cn') || hostMatchesDomain(host, 'moonshot.ai')
      || hostMatchesDomain(host, 'kimi.ai') || hostMatchesDomain(host, 'kimi.com')) return 'kimi';
  if (hostMatchesDomain(host, 'aliyuncs.com')) return 'alibaba';
  if (hostMatchesDomain(host, 'minimax.chat') || hostMatchesDomain(host, 'minimax.io')
      || hostMatchesDomain(host, 'minimaxi.com')) return 'minimax';
  if (hostMatchesDomain(host, 'webbrain.one')) return 'webbrain_cloud';
  if (hostMatchesDomain(host, 'z.ai') || hostMatchesDomain(host, 'chatglm.cn')) return 'z_ai';
  return '';
}
