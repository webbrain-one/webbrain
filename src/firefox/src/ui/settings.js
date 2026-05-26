/**
 * WebBrain Settings Page — provider configuration + display settings.
 */

import { t, getLocale, setLocale, LANGUAGES } from './i18n.js';

// Version shown in the subtitle. Kept here so it only needs one update per
// release; the subtitle string itself is translated.
const EXT_VERSION = '9.0.10';

const providersContainer = document.getElementById('providers');
const verboseToggle = document.getElementById('toggle-verbose');
const screenshotToggle = document.getElementById('toggle-screenshot-fallback');
const maxStepsRange = document.getElementById('range-max-steps');
const stepsValueLabel = document.getElementById('steps-value');
const requestTimeoutRange = document.getElementById('range-request-timeout');
const requestTimeoutValueLabel = document.getElementById('timeout-value');
const autoScreenshotSelect = document.getElementById('select-auto-screenshot');
const siteAdaptersToggle = document.getElementById('toggle-site-adapters');
const tracingToggle = document.getElementById('toggle-tracing');
const strictSecretToggle = document.getElementById('toggle-strict-secret');
const allowLocalNetworkToggle = document.getElementById('toggle-allow-local-network');
const accountSection = document.getElementById('account-section');
const visionBaseUrlInput = document.getElementById('vision-base-url');
const visionApiKeyInput = document.getElementById('vision-api-key');
const visionModelInput = document.getElementById('vision-model');
const btnSaveVision = document.getElementById('btn-save-vision');
const btnTestVision = document.getElementById('btn-test-vision');
const btnClearVision = document.getElementById('btn-clear-vision');
const visionTestResult = document.getElementById('test-vision');

// Transcription service (Whisper-compatible) — same shape as the vision
// override but routes to /v1/audio/transcriptions instead of /v1/chat/completions.
const transcriptionBaseUrlInput = document.getElementById('transcription-base-url');
const transcriptionApiKeyInput = document.getElementById('transcription-api-key');
const transcriptionModelInput = document.getElementById('transcription-model');
const btnSaveTranscription = document.getElementById('btn-save-transcription');
const btnTestTranscription = document.getElementById('btn-test-transcription');
const btnClearTranscription = document.getElementById('btn-clear-transcription');
const transcriptionTestResult = document.getElementById('test-transcription');
const profileEnabledToggle = document.getElementById('toggle-profile-enabled');
const profileTextArea = document.getElementById('profile-text');
const btnSaveProfile = document.getElementById('btn-save-profile');
const btnClearProfile = document.getElementById('btn-clear-profile');
const profileTestResult = document.getElementById('test-profile');
const captchaEnabledToggle = document.getElementById('toggle-captcha-enabled');
const captchaApiKeyInput = document.getElementById('captcha-api-key');
const btnSaveCaptcha = document.getElementById('btn-save-captcha');
const btnTestCaptcha = document.getElementById('btn-test-captcha');
const btnClearCaptcha = document.getElementById('btn-clear-captcha');
const captchaTestResult = document.getElementById('test-captcha');
const languageSelect = document.getElementById('select-language');
const subtitleEl = document.getElementById('subtitle');

function renderSubtitle() {
  if (subtitleEl) subtitleEl.textContent = t('st.subtitle', { version: EXT_VERSION });
}
renderSubtitle();

if (languageSelect) {
  languageSelect.innerHTML = LANGUAGES.map((l) => `<option value="${l.code}">${l.label}</option>`).join('');
  languageSelect.value = getLocale();
  languageSelect.addEventListener('change', () => {
    setLocale(languageSelect.value);
    renderSubtitle();
    renderAuthSection();
    renderProviders();
  });
  document.addEventListener('wb-locale-changed', () => {
    languageSelect.value = getLocale();
    renderSubtitle();
    if (accountSection) renderAuthSection();
    if (providersContainer) renderProviders();
  });
}

let providersData = {};
let activeProviderId = '';
let authToken = '';
let authEmail = '';
let authDefaultModel = '';

// Filter + collapse state for the providers panel. See chrome/settings.js
// for the rationale.
let providerFilter = 'all';     // 'all' | 'local' | 'cloud' | 'router'
const expandedProviders = new Set();

// --- Init ---

async function init() {
  // Load auth state
  const authStored = await browser.storage.local.get(['authToken', 'authEmail', 'authDefaultModel']);
  authToken = authStored.authToken || '';
  authEmail = authStored.authEmail || '';
  authDefaultModel = authStored.authDefaultModel || '';
  renderAuthSection();

  // Load display settings
  const stored = await browser.storage.local.get(['verboseMode', 'screenshotFallback', 'maxAgentSteps', 'autoScreenshot', 'useSiteAdapters', 'tracingEnabled', 'strictSecretMode', 'agentAllowLocalNetwork', 'providerFilter', 'requestTimeoutMs']);
  if (typeof stored.providerFilter === 'string' && ['all','local','cloud','router'].includes(stored.providerFilter)) {
    providerFilter = stored.providerFilter;
  }
  verboseToggle.checked = stored.verboseMode || false;
  screenshotToggle.checked = stored.screenshotFallback ?? true; // on by default
  maxStepsRange.value = stored.maxAgentSteps || 130;
  stepsValueLabel.textContent = maxStepsRange.value;
  // requestTimeoutMs is stored in milliseconds, displayed as seconds.
  if (requestTimeoutRange && requestTimeoutValueLabel) {
    const tMs = (typeof stored.requestTimeoutMs === 'number' && stored.requestTimeoutMs > 0)
      ? stored.requestTimeoutMs
      : 120000;
    const tSec = Math.max(10, Math.min(600, Math.round(tMs / 1000)));
    requestTimeoutRange.value = tSec;
    requestTimeoutValueLabel.textContent = tSec + 's';
  }
  if (autoScreenshotSelect) autoScreenshotSelect.value = stored.autoScreenshot || 'state_change';
  if (siteAdaptersToggle) siteAdaptersToggle.checked = stored.useSiteAdapters ?? true;
  if (tracingToggle) tracingToggle.checked = stored.tracingEnabled === true;
  if (strictSecretToggle) strictSecretToggle.checked = stored.strictSecretMode === true; // off by default
  if (allowLocalNetworkToggle) allowLocalNetworkToggle.checked = stored.agentAllowLocalNetwork === true;

  // Load vision model config
  const visionStored = await browser.storage.local.get(['visionModel']);
  const vision = visionStored.visionModel || {};
  visionBaseUrlInput.value = vision.baseUrl || '';
  visionApiKeyInput.value = vision.apiKey || '';
  visionModelInput.value = vision.model || '';

  // Load transcription service config. Same shape as visionModel; used by
  // recorder/host.js → transcribe.js when transcribing recorded audio.
  const transcriptionStored = await browser.storage.local.get(['transcriptionModel']);
  const transcription = transcriptionStored.transcriptionModel || {};
  if (transcriptionBaseUrlInput) transcriptionBaseUrlInput.value = transcription.baseUrl || '';
  if (transcriptionApiKeyInput) transcriptionApiKeyInput.value = transcription.apiKey || '';
  if (transcriptionModelInput) transcriptionModelInput.value = transcription.model || '';

  // Load profile (auto-fill bio + throwaway password)
  const profileStored = await browser.storage.local.get(['profileEnabled', 'profileText']);
  if (profileEnabledToggle) profileEnabledToggle.checked = !!profileStored.profileEnabled;
  if (profileTextArea) profileTextArea.value = profileStored.profileText || '';

  // Load CapSolver config — off by default.
  const captchaStored = await browser.storage.local.get(['captchaSolverEnabled', 'capsolverApiKey']);
  if (captchaEnabledToggle) captchaEnabledToggle.checked = !!captchaStored.captchaSolverEnabled;
  if (captchaApiKeyInput) captchaApiKeyInput.value = captchaStored.capsolverApiKey || '';

  // Load providers
  const res = await sendToBackground('get_providers');
  providersData = res.providers;
  activeProviderId = res.active;
  renderProviders();
}

// --- Auth ---

function renderAuthSection() {
  if (authToken && authEmail) {
    accountSection.innerHTML = `
      <div class="account-card">
        <div class="account-info">
          <div class="account-email">${escapeHtml(authEmail)}</div>
          <div class="account-provider">${escapeHtml(t('st.account.provider_name'))}</div>
        </div>
        <button class="btn-sign-out" id="btn-sign-out">${escapeHtml(t('st.account.sign_out'))}</button>
      </div>
    `;
    document.getElementById('btn-sign-out').addEventListener('click', logout);
  } else {
    accountSection.innerHTML = `
      <div class="account-card">
        <div class="account-info">
          <div class="account-email not-signed-in">${escapeHtml(t('st.account.not_signed_in'))}</div>
        </div>
        <button class="btn-sign-in" id="btn-sign-in">${escapeHtml(t('st.account.sign_in'))}</button>
      </div>
    `;
    document.getElementById('btn-sign-in').addEventListener('click', openAuthTab);
  }
}

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function openAuthTab() {
  window.open('https://auth.webbrain.one', '_blank');
}

async function logout() {
  await browser.storage.local.remove(['authToken', 'authEmail', 'authDefaultModel']);
  authToken = '';
  authEmail = '';
  authDefaultModel = '';
  renderAuthSection();
}

window.addEventListener('message', (event) => {
  if (event.data?.type === 'WB_AUTH_TOKEN') {
    const { token, email, defaultModel } = event.data;
    authToken = token;
    authEmail = email;
    authDefaultModel = defaultModel || 'openai/gpt-4o';
    browser.storage.local.set({ authToken, authEmail, authDefaultModel });
    renderAuthSection();
    autoConfigureWebbrainProvider();
  }
});

async function autoConfigureWebbrainProvider() {
  const res = await sendToBackground('get_providers');
  providersData = res.providers;
  activeProviderId = res.active;
  renderProviders();
}

// --- Display Settings ---

verboseToggle.addEventListener('change', () => {
  browser.storage.local.set({ verboseMode: verboseToggle.checked });
});

screenshotToggle.addEventListener('change', () => {
  browser.storage.local.set({ screenshotFallback: screenshotToggle.checked });
});

maxStepsRange.addEventListener('input', () => {
  stepsValueLabel.textContent = maxStepsRange.value;
});

maxStepsRange.addEventListener('change', () => {
  browser.storage.local.set({ maxAgentSteps: parseInt(maxStepsRange.value) });
});

if (requestTimeoutRange) {
  requestTimeoutRange.addEventListener('input', () => {
    requestTimeoutValueLabel.textContent = requestTimeoutRange.value + 's';
  });
  requestTimeoutRange.addEventListener('change', () => {
    const sec = parseInt(requestTimeoutRange.value, 10);
    browser.storage.local.set({ requestTimeoutMs: sec * 1000 });
  });
}

autoScreenshotSelect?.addEventListener('change', () => {
  browser.storage.local.set({ autoScreenshot: autoScreenshotSelect.value });
});

siteAdaptersToggle?.addEventListener('change', () => {
  browser.storage.local.set({ useSiteAdapters: siteAdaptersToggle.checked });
});

tracingToggle?.addEventListener('change', () => {
  browser.storage.local.set({ tracingEnabled: tracingToggle.checked });
});

strictSecretToggle?.addEventListener('change', () => {
  browser.storage.local.set({ strictSecretMode: strictSecretToggle.checked });
});

allowLocalNetworkToggle?.addEventListener('change', () => {
  browser.storage.local.set({ agentAllowLocalNetwork: allowLocalNetworkToggle.checked });
});

// --- Vision Model ---

function flashVisionResult(className, text) {
  visionTestResult.className = `test-result show ${className}`;
  visionTestResult.textContent = text;
  setTimeout(() => visionTestResult.classList.remove('show'), 2000);
}

btnSaveVision.addEventListener('click', async () => {
  const baseUrl = visionBaseUrlInput.value.trim();
  const apiKey = visionApiKeyInput.value.trim();
  const model = visionModelInput.value.trim();

  if (!baseUrl && !apiKey && !model) {
    await browser.storage.local.remove('visionModel');
    flashVisionResult('ok', t('st.vision.cleared'));
    return;
  }

  await browser.storage.local.set({
    visionModel: { baseUrl, apiKey, model },
  });
  flashVisionResult('ok', t('st.vision.saved'));
});

btnTestVision.addEventListener('click', async () => {
  const baseUrl = visionBaseUrlInput.value.trim();
  const apiKey = visionApiKeyInput.value.trim();
  const model = visionModelInput.value.trim();

  if (!baseUrl || !model) {
    visionTestResult.className = 'test-result show fail';
    visionTestResult.textContent = t('st.vision.fill_required');
    setTimeout(() => visionTestResult.classList.remove('show'), 2500);
    return;
  }

  await browser.storage.local.set({
    visionModel: { baseUrl, apiKey, model },
  });

  visionTestResult.className = 'test-result show';
  visionTestResult.textContent = t('st.vision.testing');
  visionTestResult.style.color = 'var(--text2)';

  const res = await sendToBackground('test_vision_provider');
  if (res.ok) {
    visionTestResult.className = 'test-result show ok';
    visionTestResult.textContent = t('st.vision.connected', { model: res.model || model });
  } else {
    visionTestResult.className = 'test-result show fail';
    visionTestResult.textContent = t('st.vision.failed', { error: res.error });
  }
});

btnClearVision.addEventListener('click', async () => {
  visionBaseUrlInput.value = '';
  visionApiKeyInput.value = '';
  visionModelInput.value = '';
  await browser.storage.local.remove('visionModel');
  flashVisionResult('ok', t('st.vision.cleared'));
});

// --- Transcription Service (Whisper-compatible) ---
//
// Same UX as the vision override. Stored in browser.storage.local under
// `transcriptionModel = { baseUrl, apiKey, model }`. Consumed by
// transcribe.js, which uses the override when all three fields are
// filled, and falls back to the auto-pick-from-providers behavior when
// any field is empty.

function flashTranscriptionResult(className, text) {
  if (!transcriptionTestResult) return;
  transcriptionTestResult.className = `test-result show ${className}`;
  transcriptionTestResult.textContent = text;
  setTimeout(() => transcriptionTestResult.classList.remove('show'), 2000);
}

if (btnSaveTranscription) {
  btnSaveTranscription.addEventListener('click', async () => {
    const baseUrl = transcriptionBaseUrlInput.value.trim();
    const apiKey = transcriptionApiKeyInput.value.trim();
    const model = transcriptionModelInput.value.trim();

    if (!baseUrl && !apiKey && !model) {
      await browser.storage.local.remove('transcriptionModel');
      flashTranscriptionResult('ok', t('st.transcription.cleared'));
      return;
    }

    await browser.storage.local.set({
      transcriptionModel: { baseUrl, apiKey, model },
    });
    flashTranscriptionResult('ok', t('st.transcription.saved'));
  });
}

if (btnTestTranscription) {
  btnTestTranscription.addEventListener('click', async () => {
    const baseUrl = transcriptionBaseUrlInput.value.trim();
    const apiKey = transcriptionApiKeyInput.value.trim();
    const model = transcriptionModelInput.value.trim();

    if (!baseUrl || !model) {
      transcriptionTestResult.className = 'test-result show fail';
      transcriptionTestResult.textContent = t('st.transcription.fill_required');
      setTimeout(() => transcriptionTestResult.classList.remove('show'), 2500);
      return;
    }

    await browser.storage.local.set({
      transcriptionModel: { baseUrl, apiKey, model },
    });

    transcriptionTestResult.className = 'test-result show';
    transcriptionTestResult.textContent = t('st.transcription.testing');
    transcriptionTestResult.style.color = 'var(--text2)';

    const res = await sendToBackground('test_transcription_provider');
    if (res.ok) {
      transcriptionTestResult.className = 'test-result show ok';
      transcriptionTestResult.textContent = t('st.transcription.connected', { model: res.model || model });
    } else {
      transcriptionTestResult.className = 'test-result show fail';
      transcriptionTestResult.textContent = t('st.transcription.failed', { error: res.error });
    }
  });
}

if (btnClearTranscription) {
  btnClearTranscription.addEventListener('click', async () => {
    transcriptionBaseUrlInput.value = '';
    transcriptionApiKeyInput.value = '';
    transcriptionModelInput.value = '';
    await browser.storage.local.remove('transcriptionModel');
    flashTranscriptionResult('ok', t('st.transcription.cleared'));
  });
}

// --- Profile auto-fill ---
// Persisted to browser.storage.local in plaintext; the agent picks the
// changes up via the storage.onChanged listener in background.js and
// refreshes open conversations' system prompts on the next turn.

function flashProfileResult(className, text) {
  if (!profileTestResult) return;
  profileTestResult.className = `test-result show ${className}`;
  profileTestResult.textContent = text;
  setTimeout(() => profileTestResult.classList.remove('show'), 2000);
}

if (profileEnabledToggle) {
  profileEnabledToggle.addEventListener('change', () => {
    browser.storage.local.set({ profileEnabled: profileEnabledToggle.checked });
  });
}

if (btnSaveProfile) {
  btnSaveProfile.addEventListener('click', async () => {
    const value = (profileTextArea?.value || '').trim();
    await browser.storage.local.set({ profileText: value });
    flashProfileResult('ok', t('st.profile.saved'));
  });
}

if (btnClearProfile) {
  btnClearProfile.addEventListener('click', async () => {
    if (profileTextArea) profileTextArea.value = '';
    await browser.storage.local.set({ profileText: '' });
    flashProfileResult('ok', t('st.profile.cleared'));
  });
}

// --- CapSolver (captcha solving) ---
// Toggle persists immediately. The API key needs an explicit Save.

function flashCaptchaResult(className, text) {
  if (!captchaTestResult) return;
  captchaTestResult.className = `test-result show ${className}`;
  captchaTestResult.textContent = text;
  setTimeout(() => captchaTestResult.classList.remove('show'), 3000);
}

if (captchaEnabledToggle) {
  captchaEnabledToggle.addEventListener('change', () => {
    browser.storage.local.set({ captchaSolverEnabled: captchaEnabledToggle.checked });
  });
}

if (btnSaveCaptcha) {
  btnSaveCaptcha.addEventListener('click', async () => {
    const key = (captchaApiKeyInput?.value || '').trim();
    await browser.storage.local.set({ capsolverApiKey: key });
    flashCaptchaResult('ok', t('st.captcha.saved'));
  });
}

if (btnTestCaptcha) {
  btnTestCaptcha.addEventListener('click', async () => {
    const key = (captchaApiKeyInput?.value || '').trim();
    if (!key) {
      flashCaptchaResult('fail', t('st.captcha.need_key'));
      return;
    }
    captchaTestResult.className = 'test-result show';
    captchaTestResult.textContent = t('st.captcha.checking');
    captchaTestResult.style.color = 'var(--text2)';
    const res = await sendToBackground('test_capsolver_balance', { apiKey: key });
    if (res.ok) {
      flashCaptchaResult('ok', t('st.captcha.balance_ok', { balance: `$${Number(res.balance).toFixed(4)}` }));
    } else {
      flashCaptchaResult('fail', t('st.captcha.balance_fail', { error: res.error }));
    }
  });
}

if (btnClearCaptcha) {
  btnClearCaptcha.addEventListener('click', async () => {
    if (captchaApiKeyInput) captchaApiKeyInput.value = '';
    if (captchaEnabledToggle) captchaEnabledToggle.checked = false;
    await browser.storage.local.remove(['capsolverApiKey', 'captchaSolverEnabled']);
    flashCaptchaResult('ok', t('st.captcha.cleared'));
  });
}

// --- Provider Rendering ---

function renderProviders() {
  providersContainer.innerHTML = '';

  // Field definitions reference i18n keys (labelKey) so switching languages
  // re-renders with translated labels. Placeholders stay as raw values —
  // they're example URLs or API key shapes and reading them in English is
  // universal enough.
  const providerConfigs = {
    llamacpp: {
      fields: [
        { key: 'baseUrl', labelKey: 'st.provider.field.server_url', type: 'text', placeholder: 'http://localhost:8080' },
        { key: 'model', labelKey: 'st.provider.field.model', type: 'text', placeholder: 'qwen/qwen3.5-9b' },
        { key: 'supportsVision', labelKey: 'st.provider.field.supports_vision', type: 'checkbox' },
        { key: 'useCompactPrompt', labelKey: 'st.provider.field.compact_prompt', type: 'checkbox' },
      ],
    },
    // WebGPU stub on Firefox — fields still render so the card looks the
    // same as on chrome, but Test Connection will report "not yet supported".
    webgpu_qwen3: {
      fields: [
        { key: 'model', labelKey: 'st.provider.field.model', type: 'text', placeholder: 'onnx-community/gemma-4-E2B-it-ONNX' },
        { key: 'dtype', labelKey: 'st.provider.field.dtype', type: 'text', placeholder: 'q4f16' },
        { key: 'useCompactPrompt', labelKey: 'st.provider.field.compact_prompt', type: 'checkbox' },
      ],
    },
    ollama: {
      fields: [
        { key: 'baseUrl', labelKey: 'st.provider.field.server_url', type: 'text', placeholder: 'http://localhost:11434/v1' },
        { key: 'model', labelKey: 'st.provider.field.model', type: 'text', placeholder: 'llama3.1' },
        { key: 'supportsVision', labelKey: 'st.provider.field.supports_vision', type: 'checkbox' },
        { key: 'useCompactPrompt', labelKey: 'st.provider.field.compact_prompt', type: 'checkbox' },
      ],
    },
    lmstudio: {
      fields: [
        { key: 'baseUrl', labelKey: 'st.provider.field.server_url', type: 'text', placeholder: 'http://localhost:1234/v1' },
        { key: 'model', labelKey: 'st.provider.field.model_optional', type: 'text', placeholderKey: 'st.provider.field.model_loaded_hint' },
        { key: 'supportsVision', labelKey: 'st.provider.field.supports_vision', type: 'checkbox' },
        { key: 'useCompactPrompt', labelKey: 'st.provider.field.compact_prompt', type: 'checkbox' },
      ],
    },
    openai: {
      fields: [
        { key: 'apiKey', labelKey: 'st.provider.field.api_key', type: 'password', placeholder: 'sk-...' },
        { key: 'model', labelKey: 'st.provider.field.model', type: 'text', placeholder: 'gpt-5.5' },
        { key: 'baseUrl', labelKey: 'st.provider.field.api_base_url', type: 'text', placeholder: 'https://api.openai.com/v1' },
      ],
    },
    openrouter: {
      fields: [
        { key: 'apiKey', labelKey: 'st.provider.field.api_key', type: 'password', placeholder: 'sk-or-...' },
        { key: 'model', labelKey: 'st.provider.field.model', type: 'text', placeholder: 'anthropic/claude-sonnet-4-6' },
        { key: 'baseUrl', labelKey: 'st.provider.field.api_base_url', type: 'text', placeholder: 'https://openrouter.ai/api/v1' },
      ],
    },
    anthropic: {
      fields: [
        { key: 'apiKey', labelKey: 'st.provider.field.api_key', type: 'password', placeholder: 'sk-ant-...' },
        { key: 'model', labelKey: 'st.provider.field.model', type: 'text', placeholder: 'claude-sonnet-4-20250514' },
        { key: 'baseUrl', labelKey: 'st.provider.field.api_base_url', type: 'text', placeholder: 'https://api.anthropic.com' },
      ],
    },
    gemini: {
      fields: [
        { key: 'apiKey', labelKey: 'st.provider.field.api_key', type: 'password', placeholder: 'AIza...' },
        { key: 'model', labelKey: 'st.provider.field.model', type: 'text', placeholder: 'gemini-3.1-flash' },
        { key: 'baseUrl', labelKey: 'st.provider.field.api_base_url', type: 'text', placeholder: 'https://generativelanguage.googleapis.com/v1beta/openai' },
      ],
    },
    mistral: {
      fields: [
        { key: 'apiKey', labelKey: 'st.provider.field.api_key', type: 'password', placeholder: 'API key' },
        { key: 'model', labelKey: 'st.provider.field.model', type: 'text', placeholder: 'mistral-large-latest' },
        { key: 'baseUrl', labelKey: 'st.provider.field.api_base_url', type: 'text', placeholder: 'https://api.mistral.ai/v1' },
      ],
    },
    deepseek: {
      fields: [
        { key: 'apiKey', labelKey: 'st.provider.field.api_key', type: 'password', placeholder: 'sk-...' },
        { key: 'model', labelKey: 'st.provider.field.model', type: 'text', placeholder: 'deepseek-chat' },
        { key: 'baseUrl', labelKey: 'st.provider.field.api_base_url', type: 'text', placeholder: 'https://api.deepseek.com/v1' },
      ],
    },
    xai: {
      fields: [
        { key: 'apiKey', labelKey: 'st.provider.field.api_key', type: 'password', placeholder: 'xai-...' },
        { key: 'model', labelKey: 'st.provider.field.model', type: 'text', placeholder: 'grok-4.3' },
        { key: 'baseUrl', labelKey: 'st.provider.field.api_base_url', type: 'text', placeholder: 'https://api.x.ai/v1' },
      ],
    },
    nvidia: {
      fields: [
        { key: 'apiKey', labelKey: 'st.provider.field.api_key', type: 'password', placeholder: 'nvapi-...' },
        { key: 'model', labelKey: 'st.provider.field.model', type: 'text', placeholder: 'meta/llama-3.1-8b-instruct' },
        { key: 'baseUrl', labelKey: 'st.provider.field.api_base_url', type: 'text', placeholder: 'https://integrate.api.nvidia.com/v1' },
      ],
    },
    groq: {
      fields: [
        { key: 'apiKey', labelKey: 'st.provider.field.api_key', type: 'password', placeholder: 'gsk_...' },
        { key: 'model', labelKey: 'st.provider.field.model', type: 'text', placeholder: 'llama-3.3-70b-versatile' },
        { key: 'baseUrl', labelKey: 'st.provider.field.api_base_url', type: 'text', placeholder: 'https://api.groq.com/openai/v1' },
      ],
    },
    // OAuth-based Claude subscription provider. Card body rendered by
    // renderClaudeOAuthCardBody() — sign-in button + auth status + disclaimer.
    claude_subscription: {
      customRender: 'claude_oauth',
      fields: [
        { key: 'model', labelKey: 'st.provider.field.model', type: 'text', placeholder: 'claude-sonnet-4-20250514' },
      ],
    },
  };

  // Filter pill row above the providers list.
  providersContainer.appendChild(renderProviderFilterBar());

  const entries = Object.entries(providersData);
  let visibleCount = 0;
  for (const [id, config] of entries) {
    const isActive = id === activeProviderId;
    const fieldDefs = providerConfigs[id]?.fields || [];

    const category = config.category || 'cloud';
    if (providerFilter !== 'all' && category !== providerFilter && !isActive) continue;
    visibleCount++;

    if (providerConfigs[id]?.customRender === 'claude_oauth') {
      providersContainer.appendChild(
        wrapCollapsibleCard(id, config, isActive, renderClaudeOAuthCardBody(id, config, fieldDefs))
      );
      continue;
    }

    let fieldsHTML = '';
    for (const field of fieldDefs) {
      const label = field.labelKey ? t(field.labelKey) : (field.label || field.key);
      const placeholder = field.placeholderKey ? t(field.placeholderKey) : (field.placeholder || '');
      if (field.type === 'checkbox') {
        // useCompactPrompt defaults to UNCHECKED across the board now.
        // Earlier builds defaulted it ON for local providers — the compact
        // prompt drops too many guardrails (modal handling, duplicate-
        // submit guard wording, iframe rules) and small local models that
        // are vision-capable in 2026 (Qwen-VL, Llama 3.2-V) are big enough
        // to handle the full prompt comfortably. The checkbox is preserved
        // so users on truly tiny models (under 8B) can opt back in.
        const isChecked = !!config[field.key];
        const checked = isChecked ? 'checked' : '';
        fieldsHTML += `
          <div class="field" style="display:flex;align-items:center;gap:8px;flex-direction:row;">
            <input type="checkbox" data-provider="${id}" data-key="${field.key}" data-type="checkbox" ${checked}
                   style="width:auto;cursor:pointer;">
            <label style="margin:0;cursor:pointer;">${escapeHtml(label)}</label>
          </div>
        `;
        } else {
        const localModelProviders = ['llamacpp', 'ollama', 'lmstudio'];
        const canLoadModels = localModelProviders.includes(id) && field.key === 'model';
        const listAttr = canLoadModels ? `list="models-${id}"` : '';
        const datalistHTML = canLoadModels ? `<datalist id="models-${id}"></datalist>` : '';
        const loadBtnHTML = canLoadModels
          ? `<button type="button" class="btn-secondary btn-load-models" data-provider="${id}"
                    style="margin-top:6px;">${escapeHtml(t('st.providers.load_models'))}</button>
             <span class="load-models-status" data-provider="${id}"
                   style="margin-left:8px;font-size:12px;color:var(--text2);"></span>`
          : '';
        const apiKeyLink = (field.key === 'apiKey' && config.apiKeyUrl)
          ? ` <a href="${escapeHtml(config.apiKeyUrl)}" target="_blank" rel="noopener noreferrer" style="font-size:11px;margin-left:6px;color:var(--accent,#4A90D9);text-decoration:none;">${escapeHtml(t('st.providers.get_api_key'))}</a>`
          : '';
        fieldsHTML += `
          <div class="field">
            <label>${escapeHtml(label)}${apiKeyLink}</label>
            <input type="${field.type}" data-provider="${id}" data-key="${field.key}" ${listAttr}
                   value="${escapeHtml(config[field.key] || '')}" placeholder="${escapeHtml(placeholder)}">
            ${datalistHTML}
            ${loadBtnHTML}
          </div>
        `;
      }
    }

    const body = `
      ${fieldsHTML}
      <div class="btn-row">
        <button class="btn-primary btn-save" data-provider="${id}">${escapeHtml(t('st.providers.save'))}</button>
        <button class="btn-secondary btn-test" data-provider="${id}">${escapeHtml(t('st.providers.test'))}</button>
        ${!isActive ? `<button class="btn-secondary btn-activate" data-provider="${id}">${escapeHtml(t('st.providers.set_active'))}</button>` : ''}
        ${config.type === 'webgpu' ? `<button class="btn-secondary btn-clear-cache" data-provider="${id}">${escapeHtml(t('st.providers.clear_cache'))}</button>` : ''}
      </div>
      <div class="test-result" id="test-${id}"></div>
    `;

    providersContainer.appendChild(wrapCollapsibleCard(id, config, isActive, body));
  }

  if (visibleCount === 0) {
    const empty = document.createElement('div');
    empty.className = 'provider-filter-empty';
    empty.textContent = t('st.providers.filter.empty') || 'No providers in this category. Switch filter to All.';
    providersContainer.appendChild(empty);
  }

  document.querySelectorAll('.btn-save').forEach(btn => {
    btn.addEventListener('click', () => saveProvider(btn.dataset.provider));
  });
  document.querySelectorAll('.btn-test').forEach(btn => {
    btn.addEventListener('click', () => testProvider(btn.dataset.provider));
  });
  document.querySelectorAll('.btn-activate').forEach(btn => {
    btn.addEventListener('click', () => activateProvider(btn.dataset.provider));
  });
  document.querySelectorAll('.btn-load-models').forEach(btn => {
    btn.addEventListener('click', () => loadProviderModels(btn.dataset.provider));
  });
  document.querySelectorAll('.btn-clear-cache').forEach(btn => {
    btn.addEventListener('click', () => clearWebGPUCache(btn.dataset.provider));
  });
  document.querySelectorAll('.btn-claude-signin').forEach(btn => {
    btn.addEventListener('click', () => signInWithClaude(btn.dataset.provider));
  });
  document.querySelectorAll('.btn-claude-signout').forEach(btn => {
    btn.addEventListener('click', () => signOutOfClaude(btn.dataset.provider));
  });
  document.querySelectorAll('.claude-oauth-status').forEach(el => {
    const id = el.id.replace(/^claude-oauth-status-/, '');
    if (id) queueMicrotask(() => refreshClaudeOAuthStatus(id));
  });
}

/**
 * Build the filter pill row. See chrome/settings.js for the canonical doc.
 */
function renderProviderFilterBar() {
  const bar = document.createElement('div');
  bar.className = 'provider-filter-bar';
  const filters = [
    { key: 'all',    labelKey: 'st.providers.filter.all' },
    { key: 'local',  labelKey: 'st.providers.filter.local' },
    { key: 'cloud',  labelKey: 'st.providers.filter.cloud' },
    { key: 'router', labelKey: 'st.providers.filter.router' },
  ];
  for (const f of filters) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `provider-filter-pill${providerFilter === f.key ? ' active' : ''}`;
    btn.dataset.filter = f.key;
    btn.textContent = t(f.labelKey);
    btn.addEventListener('click', () => {
      if (providerFilter === f.key) return;
      // Snapshot whatever the user has typed but not yet saved BEFORE we
      // rebuild the DOM — otherwise input values for the currently-rendered
      // cards are lost (e.g. typed an API key, then clicked a filter pill
      // to compare two providers).
      syncInputsIntoProvidersData();
      providerFilter = f.key;
      try { browser.storage.local.set({ providerFilter: f.key }); } catch {}
      renderProviders();
    });
    bar.appendChild(btn);
  }
  return bar;
}

/**
 * Wrap a provider card body in a collapsible shell. See chrome/settings.js
 * for the design notes.
 */
function wrapCollapsibleCard(id, config, isActive, bodyHtml) {
  const expanded = isActive || expandedProviders.has(id);
  const card = document.createElement('div');
  card.className = `provider-card ${isActive ? 'active' : ''} ${expanded ? 'expanded' : 'collapsed'}`;
  card.dataset.providerId = id;
  card.dataset.providerCategory = config.category || 'cloud';

  const header = document.createElement('div');
  header.className = 'provider-header provider-header-clickable';
  // Model name appears in the collapsed header as small mono-font text — the
  // headline question for any AI tool is "what model is this set to?", and
  // making the user expand the card to find out is bad UX. Empty model (e.g.
  // LM Studio defaults to whatever's loaded) just renders nothing rather
  // than a placeholder.
  const modelStr = (config.model && String(config.model).trim()) || '';
  const providerTitle = id === 'webgpu_qwen3' ? 'WebGPU' : (config.label || id);
  header.innerHTML = `
    <div class="provider-header-left">
      <span class="provider-chevron" aria-hidden="true">${expanded ? '▾' : '▸'}</span>
      <span class="provider-name">${escapeHtml(providerTitle)}</span>
      <span class="provider-type">${escapeHtml(config.type)}</span>
      ${config.category ? `<span class="provider-category-badge provider-category-${escapeHtml(config.category)}">${escapeHtml(config.category)}</span>` : ''}
      ${modelStr ? `<span class="provider-model" title="${escapeHtml(modelStr)}">${escapeHtml(modelStr)}</span>` : ''}
    </div>
    ${isActive ? `<span style="color:var(--accent);font-size:11px;font-weight:600">${escapeHtml(t('st.providers.active'))}</span>` : ''}
  `;
  header.addEventListener('click', (e) => {
    if (e.target.closest('button, input, a, select')) return;
    // Snapshot unsaved typing in other expanded cards before we rebuild
    // the DOM — same reason as the filter-pill handler above.
    syncInputsIntoProvidersData();
    if (expandedProviders.has(id)) expandedProviders.delete(id);
    else expandedProviders.add(id);
    renderProviders();
  });

  const body = document.createElement('div');
  body.className = 'provider-body';
  body.innerHTML = bodyHtml;

  card.appendChild(header);
  if (expanded) card.appendChild(body);
  return card;
}

/**
 * Render the Claude (Pro/Max subscription) provider card. Differs from
 * the normal cards in that auth is via OAuth (Sign in with Claude button)
 * — see Chrome equivalent for full notes.
 */
function renderClaudeOAuthCardBody(id, config, fieldDefs) {
  const isActive = id === activeProviderId;
  let fieldsHTML = '';
  for (const field of fieldDefs) {
    const label = field.labelKey ? t(field.labelKey) : (field.label || field.key);
    const placeholder = field.placeholder || '';
    fieldsHTML += `
      <div class="field">
        <label>${escapeHtml(label)}</label>
        <input type="${field.type}" data-provider="${id}" data-key="${field.key}"
               value="${escapeHtml(config[field.key] || '')}" placeholder="${escapeHtml(placeholder)}">
      </div>
    `;
  }

  return `
    <div class="claude-oauth-status" id="claude-oauth-status-${id}"
         style="padding:10px 12px;border-radius:6px;background:var(--surface2,#f5f5f7);
                margin-bottom:10px;font-size:13px;color:var(--text2);">
      Loading sign-in status…
    </div>

    ${fieldsHTML}

    <div class="btn-row">
      <button class="btn-primary btn-claude-signin" data-provider="${id}" style="display:none;">
        Sign in with Claude
      </button>
      <button class="btn-secondary btn-claude-signout" data-provider="${id}" style="display:none;">
        Sign out
      </button>
      <button class="btn-primary btn-save" data-provider="${id}">${escapeHtml(t('st.providers.save'))}</button>
      <button class="btn-secondary btn-test" data-provider="${id}">${escapeHtml(t('st.providers.test'))}</button>
      ${!isActive ? `<button class="btn-secondary btn-activate" data-provider="${id}">${escapeHtml(t('st.providers.set_active'))}</button>` : ''}
    </div>

    <div class="test-result" id="test-${id}"></div>

    <div style="margin-top:14px;padding:10px 12px;border-radius:6px;
                background:rgba(204,153,0,0.08);border:1px solid rgba(204,153,0,0.25);
                font-size:12px;color:var(--text2);line-height:1.5;">
      <strong>Heads up:</strong> Uses your Claude.ai Pro/Max subscription's quota via the OAuth flow Anthropic ships for Claude Code. This is a third-party use of that flow — Anthropic's terms restrict using Pro/Max subscriptions with non-Anthropic tools, and the integration could stop working at any time if Anthropic rotates their CLI's OAuth client. Your access + refresh tokens are stored in <code>browser.storage.local</code> in plaintext (same as API keys). Use at your own risk; for production / reliability, prefer the API-key Anthropic provider above.
    </div>
  `;
}

async function refreshClaudeOAuthStatus(id) {
  const statusEl = document.getElementById(`claude-oauth-status-${id}`);
  const signInBtn = document.querySelector(`.btn-claude-signin[data-provider="${id}"]`);
  const signOutBtn = document.querySelector(`.btn-claude-signout[data-provider="${id}"]`);
  if (!statusEl) return;

  try {
    const status = await sendToBackgroundWithTimeout('claude_oauth_status', {}, 5000);
    if (status?.signedIn) {
      const obtained = new Date(status.obtainedAt || Date.now()).toLocaleString();
      const expires = new Date(status.expiresAt || Date.now()).toLocaleTimeString();
      statusEl.innerHTML = `<strong style="color:var(--ok,#1a8a4a);">Signed in.</strong> Token issued ${escapeHtml(obtained)}, refreshes around ${escapeHtml(expires)}.`;
      if (signInBtn) signInBtn.style.display = 'none';
      if (signOutBtn) signOutBtn.style.display = '';
    } else {
      statusEl.innerHTML = `Not signed in. Click <strong>Sign in with Claude</strong> to authorize this extension against your Claude.ai account.`;
      if (signInBtn) signInBtn.style.display = '';
      if (signOutBtn) signOutBtn.style.display = 'none';
    }
  } catch (e) {
    statusEl.innerHTML = `Status unavailable: ${escapeHtml(e.message)}`;
    if (signInBtn) signInBtn.style.display = '';
    if (signOutBtn) signOutBtn.style.display = 'none';
  }
}

async function signInWithClaude(id) {
  const statusEl = document.getElementById(`claude-oauth-status-${id}`);
  if (statusEl) statusEl.innerHTML = `Opening Claude.ai sign-in tab… complete authorization in the new tab. The sign-in tab closes automatically once you approve.`;
  try {
    const res = await sendToBackground('claude_oauth_start');
    if (res?.ok) {
      await refreshClaudeOAuthStatus(id);
    } else {
      if (statusEl) statusEl.innerHTML = `Sign-in failed: ${escapeHtml(res?.error || 'Unknown error')}`;
    }
  } catch (e) {
    if (statusEl) statusEl.innerHTML = `Sign-in failed: ${escapeHtml(e.message)}`;
  }
}

async function signOutOfClaude(id) {
  await sendToBackground('claude_oauth_signout');
  await refreshClaudeOAuthStatus(id);
}

async function loadProviderModels(id) {
  const statusEl = document.querySelector(`.load-models-status[data-provider="${id}"]`);
  const datalistEl = document.getElementById(`models-${id}`);
  if (!datalistEl) return;
  await saveProvider(id, { showFlash: false });
  if (statusEl) statusEl.textContent = t('st.providers.loading');
  const res = await sendToBackground('list_provider_models', { providerId: id });
  if (res.ok) {
    datalistEl.innerHTML = res.models
      .map((m) => `<option value="${escapeHtml(m)}"></option>`)
      .join('');
    if (statusEl) {
      statusEl.textContent = t('st.providers.models_loaded', { count: res.models.length });
      statusEl.style.color = 'var(--text2)';
    }
  } else {
    if (statusEl) {
      statusEl.textContent = res.error || 'Failed to load models';
      statusEl.style.color = 'var(--danger, #c33)';
    }
  }
}

async function saveProvider(id, { showFlash = true } = {}) {
  const inputs = document.querySelectorAll(`input[data-provider="${id}"]`);
  const config = {};
  inputs.forEach(input => {
    if (input.dataset.type === 'checkbox' || input.type === 'checkbox') {
      config[input.dataset.key] = input.checked;
    } else {
      config[input.dataset.key] = input.value;
    }
  });

  await sendToBackground('update_provider', { providerId: id, config });

  if (showFlash) {
    const testEl = document.getElementById(`test-${id}`);
    testEl.className = 'test-result show ok';
    testEl.textContent = t('st.providers.saved');
    setTimeout(() => testEl.classList.remove('show'), 2000);
  }
}

async function testProvider(id) {
  // Skip the save-flash so its 2s auto-hide doesn't blank out the test result
  // mid-flight on slow endpoints.
  await saveProvider(id, { showFlash: false });

  const testEl = document.getElementById(`test-${id}`);
  testEl.className = 'test-result show';
  testEl.textContent = t('st.providers.testing');
  testEl.style.color = 'var(--text2)';

  const res = await sendToBackground('test_provider', { providerId: id });
  if (res.ok) {
    testEl.className = 'test-result show ok';
    testEl.textContent = t('st.providers.connected', { model: res.model || t('st.providers.unknown_model') });
  } else {
    testEl.className = 'test-result show fail';
    testEl.textContent = t('st.providers.failed', { error: res.error });
  }
}

async function clearWebGPUCache(id) {
  const testEl = document.getElementById(`test-${id}`);
  testEl.className = 'test-result show';
  testEl.textContent = t('st.providers.clearing_cache');
  testEl.style.color = 'var(--text2)';
  try {
    const res = await sendToBackground('clear_webgpu_cache');
    testEl.className = 'test-result show ok';
    testEl.textContent = t('st.providers.cache_cleared');
  } catch (e) {
    testEl.className = 'test-result show fail';
    testEl.textContent = t('st.providers.cache_clear_failed', { error: e.message });
  }
}

function syncInputsIntoProvidersData() {
  document.querySelectorAll('input[data-provider]').forEach((input) => {
    const id = input.dataset.provider;
    const key = input.dataset.key;
    if (!id || !key || !providersData[id]) return;
    if (input.dataset.type === 'checkbox' || input.type === 'checkbox') {
      providersData[id][key] = input.checked;
    } else {
      providersData[id][key] = input.value;
    }
  });
}

async function activateProvider(id) {
  syncInputsIntoProvidersData();
  await sendToBackground('set_active_provider', { providerId: id });
  activeProviderId = id;
  renderProviders();
}

async function sendToBackground(action, data = {}) {
  const response = await browser.runtime.sendMessage(
    { target: 'background', action, ...data }
  );
  if (response?.error) {
    throw new Error(response.error);
  }
  return response;
}

function sendToBackgroundWithTimeout(action, data = {}, timeoutMs = 5000) {
  let timeoutId;
  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error('Timed out waiting for background response. Reload the extension and reopen Settings.')), timeoutMs);
  });
  return Promise.race([sendToBackground(action, data), timeout])
    .finally(() => clearTimeout(timeoutId));
}

init();
