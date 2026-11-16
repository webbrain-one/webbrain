// Provider settings are user-authored. Model tool arguments never select a host or key.
export const IMAGE_GEN_MODEL_KEY = 'imageGenModel';
export const GENERATIVE_MEDIA_SETUP_NOTE = 'Built-in media generation requires setup in Providers → Generative.';
export const GENERATIVE_MEDIA_TIER_NOTE = 'Built-in media generation requires Full-tier Act mode.';
// `model` and `videoModel` are each provider's default image and video models,
// used when the settings leave that model empty.
export const MEDIA_PROVIDERS = Object.freeze({
  fal: { label: 'fal.ai', model: 'fal-ai/flux/schnell', videoModel: 'xai/grok-imagine-video/v1.5/lite/text-to-video', keyPlaceholder: 'FAL_KEY', docs: 'https://fal.ai/dashboard/keys' },
  openrouter: { label: 'OpenRouter', model: 'google/gemini-2.5-flash-image', videoModel: 'x-ai/grok-imagine-video-1.5-lite', keyPlaceholder: 'sk-or-…', docs: 'https://openrouter.ai/docs/guides/overview/multimodal/image-generation' },
  comfyrouter: { label: 'Comfy Router', model: 'bfl/flux-2-pro', videoModel: 'xai/grok-imagine-video-1.5-lite', keyPlaceholder: 'comfyui-…', docs: 'https://docs.comfy.org/development/comfy-router/quickstart' },
  comfyui: { label: 'ComfyUI (localhost)', baseUrl: 'http://127.0.0.1:8188', docs: 'https://docs.comfy.org/development/comfyui-server/comms_routes' },
});

// fal.ai charges less for a lower resolution, so videos default to 480p and
// 720p is the opt-in. A saved value that is not one of these (an imported or
// hand-edited setting) falls back to the default instead of disabling media.
export const FAL_VIDEO_RESOLUTIONS = Object.freeze(['480p', '720p']);
export const DEFAULT_FAL_VIDEO_RESOLUTION = '480p';

export function falVideoResolution(config) {
  const saved = String(config?.videoResolution || '').trim().toLowerCase();
  return FAL_VIDEO_RESOLUTIONS.includes(saved) ? saved : DEFAULT_FAL_VIDEO_RESOLUTION;
}

// Every provider has an image model and a video model. The saved settings keep
// the image model's fields under their original names (`model`, Comfy Router's
// `parameters`, ComfyUI's `workflow`), so settings saved before there were two
// stay valid; the video model's fields are `videoModel`, `videoParameters` and
// `videoWorkflow`.
const SLOT_FIELDS = Object.freeze({
  image: Object.freeze({ model: 'model', parameters: 'parameters', workflow: 'workflow' }),
  video: Object.freeze({ model: 'videoModel', parameters: 'videoParameters', workflow: 'videoWorkflow' }),
});

function filled(value) {
  if (typeof value === 'string') return value.trim() !== '';
  return value != null && (typeof value !== 'object' || Object.keys(value).length > 0);
}

export function mediaProvider(config) {
  // Previously saved { apiKey, model } settings remain fal.ai settings.
  return config?.provider == null ? 'fal' : String(config.provider);
}

export function normalizeMediaModel(value) {
  const model = String(value || '').trim().replace(/^\/+|\/+$/g, '');
  return /^[A-Za-z0-9][A-Za-z0-9._\-/]*$/.test(model) && !model.includes('..') ? model : '';
}

export function comfyBaseUrl(value) {
  const url = new URL(String(value || MEDIA_PROVIDERS.comfyui.baseUrl).trim());
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash
    || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname.toLowerCase())) {
    throw new Error('ComfyUI URL must use localhost, 127.0.0.1, or [::1], without credentials, query, or fragment.');
  }
  return url.href.replace(/\/+$/, '');
}

export function parseMediaJson(value, label) {
  let parsed = value;
  if (typeof value === 'string') {
    if (value.length > 1024 * 1024) throw new Error(`${label} exceeds 1 MB.`);
    try { parsed = JSON.parse(value || '{}'); } catch { throw new Error(`${label} must be valid JSON.`); }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(`${label} must be a JSON object.`);
  return parsed;
}

function validateWorkflow(value, label) {
  const nodes = Object.values(parseMediaJson(value, label));
  if (!nodes.length || nodes.some(node => !node || typeof node.class_type !== 'string'
    || !node.inputs || typeof node.inputs !== 'object' || Array.isArray(node.inputs))) {
    throw new Error(`Export the ${label} in API format (node IDs, class_type, and inputs).`);
  }
  if (!nodes.some(node => Object.values(node.inputs).some(value => typeof value === 'string' && value.includes('{{prompt}}')))) {
    throw new Error(`Replace the positive prompt text in the ${label} with {{prompt}}.`);
  }
}

export function validateMediaConfig(config) {
  const provider = mediaProvider(config);
  if (!Object.hasOwn(MEDIA_PROVIDERS, provider)) throw new Error('Unknown generative media provider.');
  if (provider === 'comfyui') {
    comfyBaseUrl(config?.baseUrl);
    // One workflow is required; the other is optional.
    const saved = ['workflow', 'videoWorkflow'].filter(field => filled(config?.[field]));
    for (const field of saved.length ? saved : ['workflow']) {
      validateWorkflow(config?.[field], field === 'workflow' ? 'ComfyUI workflow' : 'ComfyUI video workflow');
    }
  } else {
    if (!String(config?.apiKey || '').trim()) throw new Error('API Key is required.');
    // Either model may be left empty for the provider's default.
    for (const [field, label] of [['model', 'image model'], ['videoModel', 'video model']]) {
      if (!filled(config?.[field])) continue;
      const model = normalizeMediaModel(config[field]);
      if (!model) throw new Error(`The ${label} ID is not valid.`);
      if (provider === 'comfyrouter' && model.split('/').length !== 2) throw new Error('Comfy Router model IDs use provider/model.');
    }
    if (provider === 'comfyrouter') {
      parseMediaJson(config?.parameters || '{}', 'Image model input');
      parseMediaJson(config?.videoParameters || '{}', 'Video model input');
    }
  }
  return provider;
}

/**
 * What a request for an image or a video ('image' or 'video') uses: the
 * saved model, or the provider's default, with its saved Comfy Router input;
 * for ComfyUI, the saved workflow for that kind, or the other workflow when
 * only one is saved. OpenRouter's saved image model can be a video model
 * (saved before there were two), so generative-media.js settles OpenRouter's
 * models against its catalogs instead.
 */
export function mediaSlot(config, kind) {
  const provider = mediaProvider(config);
  const video = kind === 'video';
  const fields = SLOT_FIELDS[video ? 'video' : 'image'];
  if (provider === 'comfyui') {
    const own = filled(config?.[fields.workflow]);
    return {
      model: video && own ? 'ComfyUI video workflow' : 'ComfyUI workflow',
      workflow: own ? config[fields.workflow] : config?.[SLOT_FIELDS[video ? 'image' : 'video'].workflow],
    };
  }
  return {
    model: normalizeMediaModel(config?.[fields.model]) || MEDIA_PROVIDERS[provider]?.[video ? 'videoModel' : 'model'] || '',
    parameters: config?.[fields.parameters],
  };
}

export function isImageGenConfigured(config) {
  try { validateMediaConfig(config); return true; } catch { return false; }
}

export function imageGenAvailability({ configured = false, tier = 'full', mode = 'ask', readOnlyProfile = false } = {}) {
  if (!configured) return 'not_configured';
  if (tier !== 'full') return 'tier_restricted';
  if (readOnlyProfile) return 'profile_restricted';
  return mode === 'act' || mode === 'dev' ? 'available' : 'ask_mode';
}

export function mediaPermissionUrl(config) {
  switch (mediaProvider(config)) {
    case 'fal': return 'https://queue.fal.run';
    case 'openrouter': return 'https://openrouter.ai';
    case 'comfyrouter': return 'https://api.comfy.org';
    case 'comfyui': return comfyBaseUrl(config?.baseUrl);
    default: return '';
  }
}

export function bindMediaPrompt(value, prompt) {
  if (typeof value === 'string') return value.replaceAll('{{prompt}}', prompt);
  if (Array.isArray(value)) return value.map(item => bindMediaPrompt(item, prompt));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, bindMediaPrompt(item, prompt)]));
  return value;
}
