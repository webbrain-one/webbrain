import {
  normalizeDetectedContextWindow,
} from './providers/context-windows.js';

const OLLAMA_LAUNCH_PROVIDER_ID = 'ollama';
const DEFAULT_OLLAMA_BASE_URL = 'http://127.0.0.1:11434/v1';
const DEFAULT_CONTEXT_WINDOW = 65536;
const LOCAL_OLLAMA_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

function normalizeModel(value) {
  const model = String(value || '').trim();
  if (!model) throw new Error('Ollama launch handoff requires a model');
  if (model.length > 200 || /[\x00-\x1f\x7f]/.test(model)) {
    throw new Error('Ollama launch handoff model is invalid');
  }
  return model;
}

function normalizeBaseUrl(value) {
  let url;
  try {
    url = new URL(String(value || DEFAULT_OLLAMA_BASE_URL));
  } catch {
    throw new Error('Ollama launch handoff baseUrl is invalid');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Ollama launch handoff baseUrl must use http or https');
  }
  if (url.username || url.password) {
    throw new Error('Ollama launch handoff baseUrl cannot include credentials');
  }
  if (!LOCAL_OLLAMA_HOSTS.has(url.hostname)) {
    throw new Error('Ollama launch handoff only accepts loopback Ollama hosts');
  }

  const normalizedPath = (url.pathname || '/').replace(/\/+$/, '') || '/v1';
  if (normalizedPath !== '/v1') {
    throw new Error('Ollama launch handoff baseUrl must point to the OpenAI-compatible /v1 endpoint');
  }
  url.pathname = '/v1';
  url.search = '';
  url.hash = '';
  return url.href.replace(/\/$/, '');
}

function normalizeContextWindow(value) {
  if (value == null || value === '') return DEFAULT_CONTEXT_WINDOW;
  // Same semantics as detection: clamp valid values into the Settings range;
  // invalid values fall back to the launch default.
  const normalized = normalizeDetectedContextWindow(value);
  return normalized == null ? DEFAULT_CONTEXT_WINDOW : normalized;
}

export function normalizeOllamaLaunchHandoff(raw = {}) {
  const model = normalizeModel(raw.model);
  const baseUrl = normalizeBaseUrl(raw.baseUrl);
  const contextWindow = normalizeContextWindow(raw.contextWindow);
  return {
    providerId: OLLAMA_LAUNCH_PROVIDER_ID,
    model,
    baseUrl,
    contextWindow,
    config: {
      type: 'openai',
      category: 'local',
      label: 'Ollama (Local)',
      providerName: 'ollama',
      baseUrl,
      model,
      contextWindow,
      apiKey: 'ollama',
      supportsVision: true,
      promptTier: 'mid',
      enabled: true,
    },
  };
}
