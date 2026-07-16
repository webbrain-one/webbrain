export const DEFAULT_LOCAL_CONTEXT_WINDOW = 16384;
export const DEFAULT_CLOUD_CONTEXT_WINDOW = 128000;
export const MIN_CONTEXT_WINDOW = 4096;
export const MAX_CONTEXT_WINDOW = 1048576;

const K128 = 131072;
const K256 = 262144;
const M1 = 1000000;

function clean(value) {
  return String(value || '').trim().toLowerCase();
}

function modelIdsMatch(left, right) {
  const a = clean(left);
  const b = clean(right);
  if (!a || !b) return false;
  return a === b;
}

function normalizeOllamaModelId(value) {
  const id = clean(value);
  if (!id) return '';
  return id.includes(':') ? id : `${id}:latest`;
}

function ollamaModelIdsMatch(left, right) {
  const a = normalizeOllamaModelId(left);
  const b = normalizeOllamaModelId(right);
  if (!a || !b) return false;
  return a === b;
}

/**
 * Clamp a detected/server-reported context window into the range Settings
 * accepts ([MIN_CONTEXT_WINDOW, MAX_CONTEXT_WINDOW] = 4k–1M). Returns null only
 * when the value is missing or unusable (non-positive / NaN). A sub-4k server
 * clamps up to the 4k usable minimum (still far below the overstated 16k
 * default) so the value stays consistent with the Settings field and savable.
 */
export function normalizeDetectedContextWindow(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  const floored = Math.floor(n);
  return Math.max(MIN_CONTEXT_WINDOW, Math.min(MAX_CONTEXT_WINDOW, floored));
}

/**
 * Whether an auto-detected window should replace the stored Settings value.
 * Always refresh when unset/default; never enlarge a non-default user
 * override; shrink a non-default override only when the caller marks the
 * detection as trusted live/runtime (`shrinkOverride: true`).
 */
export function shouldApplyDetectedContextWindow(current, detected, options = {}) {
  const next = normalizeDetectedContextWindow(detected);
  if (next == null) return false;
  const cur = Number(current);
  if (!Number.isFinite(cur) || cur <= 0) return true;
  if (cur === DEFAULT_LOCAL_CONTEXT_WINDOW) return true;
  if (next >= cur) return false;
  return options.shrinkOverride === true;
}

/**
 * llama.cpp `GET /props` — prefer default_generation_settings.n_ctx, then
 * top-level n_ctx.
 */
export function parseLlamaCppPropsContextWindow(data) {
  if (!data || typeof data !== 'object') return null;
  return normalizeDetectedContextWindow(
    data.default_generation_settings?.n_ctx ?? data.n_ctx
  );
}

/**
 * Parse `num_ctx` from Ollama `/api/show` `parameters`, which is usually a
 * whitespace-separated string (`"num_ctx 8192\\nstop ..."`), not an object.
 */
export function parseOllamaNumCtx(parameters) {
  if (parameters == null) return null;
  if (typeof parameters === 'object' && !Array.isArray(parameters)) {
    return normalizeDetectedContextWindow(parameters.num_ctx ?? parameters.numCtx);
  }
  const text = String(parameters);
  const match = /(?:^|[\s;])num_ctx[\s=]+(\d+)/i.exec(text);
  return match ? normalizeDetectedContextWindow(match[1]) : null;
}

/**
 * Ollama `GET /api/ps` — live allocated context for a running model.
 * Field is `context_length` on each entry (see `ollama ps` CONTEXT column).
 * When a preferred model is set but not running, returns null (do not borrow
 * another model's window).
 */
export function parseOllamaPsContextWindow(data, preferredModel = '') {
  const models = Array.isArray(data?.models) ? data.models : [];
  if (!models.length) return null;

  const want = String(preferredModel || '').trim();
  const candidates = want
    ? models.filter((m) => ollamaModelIdsMatch(m?.name || m?.model, want))
    : models;
  if (!candidates.length) return null;

  for (const model of candidates) {
    const n = normalizeDetectedContextWindow(
      model?.context_length ?? model?.contextLength
    );
    if (n != null) return n;
  }
  return null;
}

/**
 * Ollama `POST /api/show` — only Modelfile/runtime `num_ctx` from
 * `parameters`. Never use `model_info.*.context_length` or other top-level
 * context fields (architecture max / ambiguous; overstates the live window).
 */
export function parseOllamaShowContextWindow(data) {
  if (!data || typeof data !== 'object') return null;
  return parseOllamaNumCtx(data.parameters);
}

/**
 * LM Studio `GET /api/v0/models` — prefer a matching/loaded model's
 * loaded_context_length, then max_context_length.
 * When a preferred model is set but missing, returns null (do not borrow
 * another model's window). Model id matching is case-insensitive.
 */
export function parseLmStudioModelsContextWindow(data, preferredModel = '') {
  const source = Array.isArray(data?.data) ? data.data : [];
  if (!source.length) return null;

  const want = String(preferredModel || '').trim();
  const chat = source.filter((m) => m?.id && m.type !== 'embeddings');
  const loaded = chat.filter((m) => m.state === 'loaded');

  if (want) {
    const preferred = chat.find((m) => modelIdsMatch(m.id, want));
    if (!preferred) return null;
    return normalizeDetectedContextWindow(
      preferred.loaded_context_length ?? preferred.max_context_length ?? preferred.context_length
    );
  }

  const candidates = [...(loaded.length ? loaded : []), ...chat];
  for (const model of candidates) {
    const n = normalizeDetectedContextWindow(
      model.loaded_context_length ?? model.max_context_length ?? model.context_length
    );
    if (n != null) return n;
  }
  return null;
}

function openAiModelCardContextWindow(model) {
  if (!model || typeof model !== 'object') return null;
  return normalizeDetectedContextWindow(
    model.max_model_len ??
    model.maxModelLen ??
    model.max_context_length ??
    model.maxContextLength ??
    model.context_window ??
    model.contextWindow
  );
}

/**
 * OpenAI-compatible `GET /v1/models` extensions used by vLLM and SGLang.
 * Prefer an exact preferred model match; if none is selected, use the first
 * model card that carries explicit context metadata.
 */
export function parseOpenAiModelListContextWindow(data, preferredModel = '') {
  const source = Array.isArray(data?.data) ? data.data : [];
  if (!source.length) return null;

  const want = String(preferredModel || '').trim();
  const cards = source.filter((m) => m && typeof m === 'object' && m.id);

  if (want) {
    const preferred = cards.find((m) => modelIdsMatch(m.id, want));
    return preferred ? openAiModelCardContextWindow(preferred) : null;
  }

  for (const model of cards) {
    const n = openAiModelCardContextWindow(model);
    if (n != null) return n;
  }
  return null;
}

/**
 * LocalAI `GET /api/models/config-json/:name` — use configured runtime
 * `context_size` only. Do not infer from architecture/model maxima.
 */
export function parseLocalAiModelConfigContextWindow(data) {
  if (!data || typeof data !== 'object') return null;
  const candidates = [
    data.context_size,
    data.contextSize,
    data.config?.context_size,
    data.config?.contextSize,
    data.model_config?.context_size,
    data.model_config?.contextSize,
    data.parameters?.context_size,
    data.parameters?.contextSize,
  ];
  for (const value of candidates) {
    const n = normalizeDetectedContextWindow(value);
    if (n != null) return n;
  }
  return null;
}

/**
 * True when LM Studio detection came from a loaded model's
 * `loaded_context_length` (safe to shrink a manual override).
 */
export function lmStudioContextWindowIsLive(data, preferredModel = '') {
  const source = Array.isArray(data?.data) ? data.data : [];
  const want = String(preferredModel || '').trim();
  const chat = source.filter((m) => m?.id && m.type !== 'embeddings');
  const target = want
    ? chat.find((m) => modelIdsMatch(m.id, want))
    : chat.find((m) => m.state === 'loaded');
  if (target?.state !== 'loaded') return false;
  return normalizeDetectedContextWindow(target.loaded_context_length) != null;
}

/**
 * Best-effort context-window metadata for cloud/router models. Local models
 * are runtime-configured by the user/server; they stay on the conservative 16k
 * default until Settings supplies `config.contextWindow` (including values
 * filled by Test connection / Load models auto-detect).
 */
export function inferContextWindow(config = {}) {
  const category = clean(config.category);
  if (category === 'local') return DEFAULT_LOCAL_CONTEXT_WINDOW;

  const provider = clean(config.providerName || config.type || config.label);
  const model = clean(config.model);

  if (!model) return DEFAULT_CLOUD_CONTEXT_WINDOW;

  // OpenAI
  if (/^gpt-5\.6(?:[.\-]|$)/.test(model) || model.includes('/gpt-5.6')) return 1050000;
  if (model.includes('gpt-5.5-pro')) return 1050000;
  if (/^gpt-5(?:[.\-]|$)/.test(model) || model.includes('/gpt-5')) return 400000;

  // Anthropic Claude
  if (/claude-(?:fable-5|mythos-5|mythos|opus-4-[6-8]|sonnet-4-6)/.test(model)) return M1;
  if (model.includes('claude-')) return 200000;

  // Google Gemini
  if (/gemini-(?:3|3\.|2\.5)/.test(model)) return M1;

  // Cloudflare Workers AI
  if (provider === 'cloudflare' && model.includes('@cf/zai-org/glm-5.2')) return K256;

  // Mistral
  if (/mistral-medium-(?:3\.5|2604)/.test(model)) return K256;

  // DeepSeek
  if (model.includes('deepseek-v4')) return M1;

  // xAI
  if (model.includes('grok-4.3')) return M1;

  // Groq-hosted common models and OpenAI open-weight GPT-OSS models.
  if (model.includes('gpt-oss')) return K128;
  if (provider === 'groq' && /(?:llama-3\.[13]|compound)/.test(model)) return K128;

  // NVIDIA NIM defaults in WebBrain.
  if (/(?:nemotron.*49b|llama-3[._-]3-nemotron|llama-3\.1-8b)/.test(model)) return K128;

  // MiniMax direct and OpenRouter slugs.
  if (/minimax.*m3/.test(model)) return M1;
  if (/minimax.*(?:m2\.7|m2\.5|m2\.1|m2)(?:-|$|\/|\.)/.test(model) || model.includes('minimax-01')) {
    return 204800;
  }

  // Alibaba / Qwen direct models and OpenRouter Qwen slugs.
  if (model.includes('qwen3.7-plus')) return M1;
  if (model.includes('qwen3.7-max')) return K256;
  if (model.includes('qwen3-max')) return K256;
  if (/qwen(?:3\.5)?-(?:plus|turbo)/.test(model)) return M1;
  if (model.includes('qwen-max')) return 32768;
  if (/qwen3-(?:235b|30b|32b|next)/.test(model)) return K128;

  return DEFAULT_CLOUD_CONTEXT_WINDOW;
}
