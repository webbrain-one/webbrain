/**
 * WebBrain Settings Page — provider configuration + display settings.
 */

import { t, getLocale, setLocale, LANGUAGES } from './i18n.js';

// Version shown in the subtitle. Kept here so it only needs one update per
// release; the subtitle string itself is translated.
const EXT_VERSION = '7.2.1';

const providersContainer = document.getElementById('providers');
const verboseToggle = document.getElementById('toggle-verbose');
const screenshotToggle = document.getElementById('toggle-screenshot-fallback');
const maxStepsRange = document.getElementById('range-max-steps');
const stepsValueLabel = document.getElementById('steps-value');
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

// --- Init ---

async function init() {
  // Load auth state
  const authStored = await browser.storage.local.get(['authToken', 'authEmail', 'authDefaultModel']);
  authToken = authStored.authToken || '';
  authEmail = authStored.authEmail || '';
  authDefaultModel = authStored.authDefaultModel || '';
  renderAuthSection();

  // Load display settings
  const stored = await browser.storage.local.get(['verboseMode', 'screenshotFallback', 'maxAgentSteps', 'autoScreenshot', 'useSiteAdapters', 'tracingEnabled', 'strictSecretMode', 'agentAllowLocalNetwork']);
  verboseToggle.checked = stored.verboseMode || false;
  screenshotToggle.checked = stored.screenshotFallback ?? true; // on by default
  maxStepsRange.value = stored.maxAgentSteps || 60;
  stepsValueLabel.textContent = maxStepsRange.value;
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
      flashCaptchaResult('ok', t('st.captcha.balance_ok', { balance: Number(res.balance).toFixed(4) }));
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
        { key: 'model', labelKey: 'st.provider.field.model', type: 'text', placeholder: 'gpt-5' },
        { key: 'baseUrl', labelKey: 'st.provider.field.api_base_url', type: 'text', placeholder: 'https://api.openai.com/v1' },
      ],
    },
    openrouter: {
      fields: [
        { key: 'apiKey', labelKey: 'st.provider.field.api_key', type: 'password', placeholder: 'sk-or-...' },
        { key: 'model', labelKey: 'st.provider.field.model', type: 'text', placeholder: 'anthropic/claude-sonnet-4' },
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
    // OAuth-based Claude subscription provider. Card body rendered by
    // renderClaudeOAuthCard() — sign-in button + auth status + disclaimer.
    claude_subscription: {
      customRender: 'claude_oauth',
      fields: [
        { key: 'model', labelKey: 'st.provider.field.model', type: 'text', placeholder: 'claude-sonnet-4-20250514' },
      ],
    },
  };

  for (const [id, config] of Object.entries(providersData)) {
    const isActive = id === activeProviderId;
    const fieldDefs = providerConfigs[id]?.fields || [];

    // Custom render for the OAuth Claude provider (sign-in button etc.).
    if (providerConfigs[id]?.customRender === 'claude_oauth') {
      providersContainer.appendChild(renderClaudeOAuthCard(id, config, isActive, fieldDefs));
      continue;
    }

    const card = document.createElement('div');
    card.className = `provider-card ${isActive ? 'active' : ''}`;

    let fieldsHTML = '';
    for (const field of fieldDefs) {
      const label = field.labelKey ? t(field.labelKey) : (field.label || field.key);
      const placeholder = field.placeholderKey ? t(field.placeholderKey) : (field.placeholder || '');
      if (field.type === 'checkbox') {
        // For useCompactPrompt on local providers, default to checked when
        // the config key hasn't been explicitly set yet (matches provider logic).
        let isChecked = config[field.key];
        if (field.key === 'useCompactPrompt' && config[field.key] == null) {
          const localProviders = ['llamacpp', 'ollama', 'lmstudio'];
          isChecked = localProviders.includes(id);
        }
        const checked = isChecked ? 'checked' : '';
        fieldsHTML += `
          <div class="field" style="display:flex;align-items:center;gap:8px;flex-direction:row;">
            <input type="checkbox" data-provider="${id}" data-key="${field.key}" data-type="checkbox" ${checked}
                   style="width:auto;cursor:pointer;">
            <label style="margin:0;cursor:pointer;">${escapeHtml(label)}</label>
          </div>
        `;
      } else {
        // For Ollama's model field, attach a <datalist> + a "Load models"
        // button so users can pick from `ollama list` without typing.
        const isOllamaModel = id === 'ollama' && field.key === 'model';
        const listAttr = isOllamaModel ? `list="models-${id}"` : '';
        const datalistHTML = isOllamaModel ? `<datalist id="models-${id}"></datalist>` : '';
        const loadBtnHTML = isOllamaModel
          ? `<button type="button" class="btn-secondary btn-load-models" data-provider="${id}"
                    style="margin-top:6px;">${escapeHtml(t('st.providers.load_models'))}</button>
             <span class="load-models-status" data-provider="${id}"
                   style="margin-left:8px;font-size:12px;color:var(--text2);"></span>`
          : '';
        fieldsHTML += `
          <div class="field">
            <label>${escapeHtml(label)}</label>
            <input type="${field.type}" data-provider="${id}" data-key="${field.key}" ${listAttr}
                   value="${escapeHtml(config[field.key] || '')}" placeholder="${escapeHtml(placeholder)}">
            ${datalistHTML}
            ${loadBtnHTML}
          </div>
        `;
      }
    }

    card.innerHTML = `
      <div class="provider-header">
        <div>
          <span class="provider-name">${escapeHtml(config.label || id)}</span>
          <span class="provider-type">${escapeHtml(config.type)}</span>
        </div>
        ${isActive ? `<span style="color:var(--accent);font-size:11px;font-weight:600">${escapeHtml(t('st.providers.active'))}</span>` : ''}
      </div>
      ${fieldsHTML}
      <div class="btn-row">
        <button class="btn-primary btn-save" data-provider="${id}">${escapeHtml(t('st.providers.save'))}</button>
        <button class="btn-secondary btn-test" data-provider="${id}">${escapeHtml(t('st.providers.test'))}</button>
        ${!isActive ? `<button class="btn-secondary btn-activate" data-provider="${id}">${escapeHtml(t('st.providers.set_active'))}</button>` : ''}
      </div>
      <div class="test-result" id="test-${id}"></div>
    `;

    providersContainer.appendChild(card);
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
    btn.addEventListener('click', () => loadOllamaModels(btn.dataset.provider));
  });
}

/**
 * Render the Claude (Pro/Max subscription) provider card. Differs from
 * the normal cards in that auth is via OAuth (Sign in with Claude button)
 * — see Chrome equivalent for full notes.
 */
function renderClaudeOAuthCard(id, config, isActive, fieldDefs) {
  const card = document.createElement('div');
  card.className = `provider-card ${isActive ? 'active' : ''}`;

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

  card.innerHTML = `
    <div class="provider-header">
      <div>
        <span class="provider-name">${escapeHtml(config.label || id)}</span>
        <span class="provider-type">oauth</span>
      </div>
      ${isActive ? `<span style="color:var(--accent);font-size:11px;font-weight:600">${escapeHtml(t('st.providers.active'))}</span>` : ''}
    </div>

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

  card.querySelector('.btn-claude-signin').addEventListener('click', () => signInWithClaude(id));
  card.querySelector('.btn-claude-signout').addEventListener('click', () => signOutOfClaude(id));
  // Run after the caller appends the card; refreshClaudeOAuthStatus()
  // looks up elements through document.getElementById().
  queueMicrotask(() => refreshClaudeOAuthStatus(id));

  return card;
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

async function loadOllamaModels(id) {
  const statusEl = document.querySelector(`.load-models-status[data-provider="${id}"]`);
  const datalistEl = document.getElementById(`models-${id}`);
  if (!datalistEl) return;
  await saveProvider(id, { showFlash: false });
  if (statusEl) statusEl.textContent = t('st.providers.loading');
  const res = await sendToBackground('list_ollama_models', { providerId: id });
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
