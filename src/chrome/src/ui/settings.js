/**
 * WebBrain Settings Page — provider configuration + display settings.
 */

import { t, getLocale, setLocale, LANGUAGES } from './i18n.js';
import { THEME_MODES, applyMode, loadMode, watch } from './theme.js';
import { CAPABILITY_LABEL } from '../agent/permission-gate.js';

// Version shown in the subtitle. Kept here so it only needs one update per
// release; the subtitle string itself is translated.
const EXT_VERSION = '15.2.0';

const providersContainer = document.getElementById('providers');
const verboseToggle = document.getElementById('toggle-verbose');
const screenshotToggle = document.getElementById('toggle-screenshot-fallback');
const maxStepsRange = document.getElementById('range-max-steps');
const stepsValueLabel = document.getElementById('steps-value');
const requestTimeoutRange = document.getElementById('range-request-timeout');
const requestTimeoutValueLabel = document.getElementById('timeout-value');
const costSessionLimitInput = document.getElementById('input-cost-session-limit');
const costTotalLimitInput = document.getElementById('input-cost-total-limit');
const costSpentValueLabel = document.getElementById('cost-spent-value');
const btnResetCostSpend = document.getElementById('btn-reset-cost-spend');
const autoScreenshotSelect = document.getElementById('select-auto-screenshot');
const siteAdaptersToggle = document.getElementById('toggle-site-adapters');
const notifySoundToggle = document.getElementById('toggle-notify-sound');
const tracingToggle = document.getElementById('toggle-tracing');
const strictSecretToggle = document.getElementById('toggle-strict-secret');
const allowLocalNetworkToggle = document.getElementById('toggle-allow-local-network');
const scheduledTasksToggle = document.getElementById('toggle-scheduled-tasks');
const scheduledConfirmToggle = document.getElementById('toggle-scheduled-confirm');
const accountSection = document.getElementById('account-section');
const visionBaseUrlInput = document.getElementById('vision-base-url');
const visionApiKeyInput = document.getElementById('vision-api-key');
const visionModelInput = document.getElementById('vision-model');
const btnSaveVision = document.getElementById('btn-save-vision');

// Transcription service (Whisper-compatible) — same shape as the vision
// override but routes to /v1/audio/transcriptions instead of /v1/chat/completions.
const transcriptionBaseUrlInput = document.getElementById('transcription-base-url');
const transcriptionApiKeyInput = document.getElementById('transcription-api-key');
const transcriptionModelInput = document.getElementById('transcription-model');
const btnSaveTranscription = document.getElementById('btn-save-transcription');
const btnTestTranscription = document.getElementById('btn-test-transcription');
const btnClearTranscription = document.getElementById('btn-clear-transcription');
const transcriptionTestResult = document.getElementById('test-transcription');
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
const themeSelect = document.getElementById('select-theme');
const subtitleEl = document.getElementById('subtitle');

// --- Appearance / theme ---
// Loaded from chrome.storage.local (canonical) with a localStorage mirror
// kept in sync by theme.js — so the FOUC bootstrap in <head> always has the
// latest mode on next page open. watch() keeps every open extension page
// (this settings tab + the side panel) in sync if any one of them flips it.
let currentThemeMode = 'system';
if (themeSelect) {
  loadMode().then((mode) => {
    currentThemeMode = mode;
    themeSelect.value = mode;
    applyMode(mode, { syncStorage: false }); // already loaded, just paint
  });
  themeSelect.addEventListener('change', () => {
    const mode = THEME_MODES.includes(themeSelect.value) ? themeSelect.value : 'system';
    currentThemeMode = mode;
    applyMode(mode);
  });
  watch(() => currentThemeMode);
  // If another Settings tab or the side panel flips the theme, watch()
  // already re-paints this page — but the closure variable and the select
  // value won't update on their own. Without this, the picker drifts out
  // of sync and a later OS-theme flip can re-apply the stale 'system'.
  if (globalThis.chrome?.storage?.onChanged) {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local' || !changes.themeMode) return;
      const next = changes.themeMode.newValue;
      if (!THEME_MODES.includes(next)) return;
      currentThemeMode = next;
      if (themeSelect.value !== next) themeSelect.value = next;
    });
  }
}

function renderSubtitle() {
  if (subtitleEl) subtitleEl.textContent = t('st.subtitle', { version: EXT_VERSION });
}
renderSubtitle();

if (languageSelect) {
  languageSelect.innerHTML = LANGUAGES.map((l) => `<option value="${l.code}">${l.label}</option>`).join('');
  languageSelect.value = getLocale();
  languageSelect.addEventListener('change', () => {
    setLocale(languageSelect.value);
    // Re-render dynamic bits whose text comes from JS.
    renderSubtitle();
    renderAuthSection();
    renderProviders();
  });
  document.addEventListener('wb-locale-changed', () => {
    languageSelect.value = getLocale();
    renderSubtitle();
    if (accountSection) renderAuthSection();
    if (providersContainer) renderProviders();
    renderPermissions();
  });
}

let providersData = {};
let activeProviderId = '';
let authToken = '';
let authEmail = '';
let authDefaultModel = '';

const DEFAULT_COST_ALLOWANCE_USD = 10;

function normalizeCostAmount(value, fallback = DEFAULT_COST_ALLOWANCE_USD) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function formatUsd(value) {
  return '$' + normalizeCostAmount(value, 0).toFixed(2);
}

function renderCostAllowanceSpent(spent, limit) {
  if (!costSpentValueLabel) return;
  costSpentValueLabel.textContent = `${formatUsd(spent)} / ${formatUsd(limit)}`;
}

// Filter + collapse state for the providers panel. With 11+ providers the
// flat list is unwieldy — filter keeps the visual surface small, and
// per-card collapse defaults non-active cards to header-only so the page
// doesn't scroll forever.
let providerFilter = 'all';     // 'all' | 'local' | 'cloud' | 'router'
const expandedProviders = new Set(); // ids the user explicitly expanded this session

// --- Init ---

async function init() {
  // Load auth state
  const authStored = await chrome.storage.local.get(['authToken', 'authEmail', 'authDefaultModel']);
  authToken = authStored.authToken || '';
  authEmail = authStored.authEmail || '';
  authDefaultModel = authStored.authDefaultModel || '';
  renderAuthSection();

  // Load display settings
  const stored = await chrome.storage.local.get(['verboseMode', 'screenshotFallback', 'maxAgentSteps', 'autoScreenshot', 'useSiteAdapters', 'notifySound', 'tracingEnabled', 'strictSecretMode', 'agentAllowLocalNetwork', 'scheduledTasksEnabled', 'scheduledRequireConsequentialConfirmation', 'providerFilter', 'requestTimeoutMs', 'costAllowanceSessionUsd', 'costAllowanceTotalUsd', 'cloudCostSpentUsd']);
  if (typeof stored.providerFilter === 'string' && ['all','local','cloud','router'].includes(stored.providerFilter)) {
    providerFilter = stored.providerFilter;
  }
  verboseToggle.checked = stored.verboseMode || false;
  screenshotToggle.checked = stored.screenshotFallback ?? true; // on by default
  if (stored.maxAgentSteps === 0) {
    maxStepsRange.value = 200;
    stepsValueLabel.textContent = '∞';
  } else {
    maxStepsRange.value = stored.maxAgentSteps || 130;
    stepsValueLabel.textContent = maxStepsRange.value;
  }
  // requestTimeoutMs is stored in milliseconds, displayed as seconds.
  // Default 60s when unset. Floor 10s / ceiling 600s matches the slider.
  if (requestTimeoutRange && requestTimeoutValueLabel) {
    const tMs = (typeof stored.requestTimeoutMs === 'number' && stored.requestTimeoutMs > 0)
      ? stored.requestTimeoutMs
      : 120000;
    const tSec = Math.max(10, Math.min(600, Math.round(tMs / 1000)));
    requestTimeoutRange.value = tSec;
    requestTimeoutValueLabel.textContent = tSec + 's';
  }
  autoScreenshotSelect.value = stored.autoScreenshot || 'state_change';
  siteAdaptersToggle.checked = stored.useSiteAdapters ?? true;
  notifySoundToggle.checked = stored.notifySound ?? true; // on by default
  tracingToggle.checked = stored.tracingEnabled === true; // off by default
  const sessionLimit = normalizeCostAmount(stored.costAllowanceSessionUsd);
  const totalLimit = normalizeCostAmount(stored.costAllowanceTotalUsd);
  const totalSpent = normalizeCostAmount(stored.cloudCostSpentUsd, 0);
  if (costSessionLimitInput) costSessionLimitInput.value = sessionLimit.toFixed(2);
  if (costTotalLimitInput) costTotalLimitInput.value = totalLimit.toFixed(2);
  renderCostAllowanceSpent(totalSpent, totalLimit);
  if (strictSecretToggle) {
    strictSecretToggle.checked = stored.strictSecretMode === true; // off by default
  }
  if (allowLocalNetworkToggle) {
    allowLocalNetworkToggle.checked = stored.agentAllowLocalNetwork === true; // off by default
  }
  if (scheduledTasksToggle) {
    scheduledTasksToggle.checked = stored.scheduledTasksEnabled !== false; // on by default
  }
  if (scheduledConfirmToggle) {
    scheduledConfirmToggle.checked = stored.scheduledRequireConsequentialConfirmation !== false; // on by default
  }

  // Load vision model config
  const visionStored = await chrome.storage.local.get(['visionModel']);
  const vision = visionStored.visionModel || {};
  visionBaseUrlInput.value = vision.baseUrl || '';
  visionApiKeyInput.value = vision.apiKey || '';
  visionModelInput.value = vision.model || '';

  // Load transcription service config. Same shape as visionModel; used by
  // recorder/host.js → transcribe.js when transcribing recorded audio.
  const transcriptionStored = await chrome.storage.local.get(['transcriptionModel']);
  const transcription = transcriptionStored.transcriptionModel || {};
  if (transcriptionBaseUrlInput) transcriptionBaseUrlInput.value = transcription.baseUrl || '';
  if (transcriptionApiKeyInput) transcriptionApiKeyInput.value = transcription.apiKey || '';
  if (transcriptionModelInput) transcriptionModelInput.value = transcription.model || '';

  // Load profile (auto-fill bio + throwaway password)
  const profileStored = await chrome.storage.local.get(['profileEnabled', 'profileText']);
  if (profileEnabledToggle) profileEnabledToggle.checked = !!profileStored.profileEnabled;
  if (profileTextArea) profileTextArea.value = profileStored.profileText || '';

  // Load CapSolver config — off by default.
  const captchaStored = await chrome.storage.local.get(['captchaSolverEnabled', 'capsolverApiKey']);
  if (captchaEnabledToggle) captchaEnabledToggle.checked = !!captchaStored.captchaSolverEnabled;
  if (captchaApiKeyInput) captchaApiKeyInput.value = captchaStored.capsolverApiKey || '';

  // Load site permissions (capability × origin grants) + the master switch
  await initPermissionGateToggle();
  await renderPermissions();

  // Load providers
  const res = await sendToBackground('get_providers');
  providersData = res.providers;
  activeProviderId = res.active;
  renderProviders();
}

// --- Site permissions (capability × origin grants) ---

const PERMISSIONS_KEY = 'wb_permissions';
const GATE_KEY = 'askBeforeConsequentialActions';

async function initPermissionGateToggle() {
  const toggle = document.getElementById('toggle-permission-gate');
  const warning = document.getElementById('permission-gate-warning');
  if (!toggle) return;
  const stored = await chrome.storage.local.get(GATE_KEY);
  const askBefore = stored[GATE_KEY] ?? true; // gate ON by default
  toggle.checked = askBefore;
  if (warning) warning.style.display = askBefore ? 'none' : '';
  toggle.addEventListener('change', async () => {
    await chrome.storage.local.set({ [GATE_KEY]: toggle.checked });
    if (warning) warning.style.display = toggle.checked ? 'none' : '';
  });
}

async function renderPermissions() {
  const listEl = document.getElementById('permissions-list');
  const actionsEl = document.getElementById('permissions-actions');
  if (!listEl) return;

  const stored = await chrome.storage.local.get(PERMISSIONS_KEY);
  const grants = Array.isArray(stored[PERMISSIONS_KEY]) ? stored[PERMISSIONS_KEY] : [];

  if (grants.length === 0) {
    listEl.innerHTML = `<div class="setting-desc">${escapeHtml(t('st.perms.empty'))}</div>`;
    if (actionsEl) actionsEl.style.display = 'none';
    return;
  }

  // Stable display order: host, then capability.
  grants.sort((a, b) =>
    String(a.host || '').localeCompare(String(b.host || '')) ||
    String(a.capability || '').localeCompare(String(b.capability || '')));

  listEl.innerHTML = grants.map((g) => {
    const verb = CAPABILITY_LABEL[g.capability] || g.capability;
    const denied = g.action === 'deny';
    const desc = denied ? t('st.perms.blocked', { verb }) : t('st.perms.allowed', { verb });
    // host + capability uniquely identify a grant (record() dedupes per pair).
    // Keep them in SEPARATE data attributes — no delimiter to round-trip wrong.
    return `
      <div class="setting-row" style="align-items:center;">
        <div class="setting-info">
          <div class="setting-label">${denied ? '⛔ ' : ''}${escapeHtml(String(g.host || ''))}</div>
          <div class="setting-desc">${escapeHtml(desc)}</div>
        </div>
        <button class="btn-secondary" data-cap="${escapeHtml(String(g.capability || ''))}" data-host="${escapeHtml(String(g.host || ''))}">${escapeHtml(t('st.perms.revoke'))}</button>
      </div>`;
  }).join('');

  if (actionsEl) actionsEl.style.display = 'flex';

  listEl.querySelectorAll('button[data-cap]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const capability = btn.dataset.cap;
      const host = btn.dataset.host;
      const cur = (await chrome.storage.local.get(PERMISSIONS_KEY))[PERMISSIONS_KEY] || [];
      const next = cur.filter((g) => !(g.capability === capability && g.host === host));
      await chrome.storage.local.set({ [PERMISSIONS_KEY]: next });
      renderPermissions();
    });
  });
}

document.getElementById('btn-clear-all-permissions')?.addEventListener('click', async () => {
  await chrome.storage.local.set({ [PERMISSIONS_KEY]: [] });
  renderPermissions();
});

// Live-sync the Permissions tab when grants (or the master switch) change
// elsewhere while this page is open — e.g. the agent records a new "Always
// allow" grant from the side-panel permission card. Without this the list
// shows a stale snapshot until a manual refresh.
if (globalThis.chrome?.storage?.onChanged) {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes[PERMISSIONS_KEY]) renderPermissions();
    if (changes[GATE_KEY]) {
      const toggle = document.getElementById('toggle-permission-gate');
      const warning = document.getElementById('permission-gate-warning');
      const askBefore = changes[GATE_KEY].newValue ?? true;
      if (toggle) toggle.checked = askBefore;
      if (warning) warning.style.display = askBefore ? 'none' : '';
    }
  });
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
  await chrome.storage.local.remove(['authToken', 'authEmail', 'authDefaultModel']);
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
    chrome.storage.local.set({ authToken, authEmail, authDefaultModel });
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
  chrome.storage.local.set({ verboseMode: verboseToggle.checked });
});

screenshotToggle.addEventListener('change', () => {
  chrome.storage.local.set({ screenshotFallback: screenshotToggle.checked });
});

maxStepsRange.addEventListener('input', () => {
  stepsValueLabel.textContent = maxStepsRange.value == 200 ? '∞' : maxStepsRange.value;
});

maxStepsRange.addEventListener('change', () => {
  chrome.storage.local.set({ maxAgentSteps: maxStepsRange.value == 200 ? 0 : parseInt(maxStepsRange.value) });
});

if (requestTimeoutRange) {
  requestTimeoutRange.addEventListener('input', () => {
    requestTimeoutValueLabel.textContent = requestTimeoutRange.value + 's';
  });
  requestTimeoutRange.addEventListener('change', () => {
    // Stored as ms (the provider code consumes ms). UI shows seconds.
    const sec = parseInt(requestTimeoutRange.value, 10);
    chrome.storage.local.set({ requestTimeoutMs: sec * 1000 });
  });
}

autoScreenshotSelect.addEventListener('change', () => {
  chrome.storage.local.set({ autoScreenshot: autoScreenshotSelect.value });
});

siteAdaptersToggle.addEventListener('change', () => {
  chrome.storage.local.set({ useSiteAdapters: siteAdaptersToggle.checked });
});

notifySoundToggle.addEventListener('change', () => {
  chrome.storage.local.set({ notifySound: notifySoundToggle.checked });
});

tracingToggle.addEventListener('change', () => {
  chrome.storage.local.set({ tracingEnabled: tracingToggle.checked });
});

costSessionLimitInput?.addEventListener('change', () => {
  const value = normalizeCostAmount(costSessionLimitInput.value);
  costSessionLimitInput.value = value.toFixed(2);
  chrome.storage.local.set({ costAllowanceSessionUsd: value });
});

costTotalLimitInput?.addEventListener('change', async () => {
  const value = normalizeCostAmount(costTotalLimitInput.value);
  costTotalLimitInput.value = value.toFixed(2);
  const stored = await chrome.storage.local.get(['cloudCostSpentUsd']);
  renderCostAllowanceSpent(normalizeCostAmount(stored.cloudCostSpentUsd, 0), value);
  chrome.storage.local.set({ costAllowanceTotalUsd: value });
});

btnResetCostSpend?.addEventListener('click', async () => {
  await chrome.storage.local.set({ cloudCostSpentUsd: 0 });
  renderCostAllowanceSpent(0, normalizeCostAmount(costTotalLimitInput?.value));
});

if (strictSecretToggle) {
  strictSecretToggle.addEventListener('change', () => {
    chrome.storage.local.set({ strictSecretMode: strictSecretToggle.checked });
  });
}

if (allowLocalNetworkToggle) {
  allowLocalNetworkToggle.addEventListener('change', () => {
    chrome.storage.local.set({ agentAllowLocalNetwork: allowLocalNetworkToggle.checked });
  });
}

if (scheduledTasksToggle) {
  scheduledTasksToggle.addEventListener('change', () => {
    chrome.storage.local.set({ scheduledTasksEnabled: scheduledTasksToggle.checked });
  });
}

if (scheduledConfirmToggle) {
  scheduledConfirmToggle.addEventListener('change', () => {
    chrome.storage.local.set({ scheduledRequireConsequentialConfirmation: scheduledConfirmToggle.checked });
  });
}

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
    await chrome.storage.local.remove('visionModel');
    flashVisionResult('ok', t('st.vision.cleared'));
    return;
  }

  await chrome.storage.local.set({
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

  await chrome.storage.local.set({
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
  await chrome.storage.local.remove('visionModel');
  flashVisionResult('ok', t('st.vision.cleared'));
});

// --- Transcription Service (Whisper-compatible) ---
//
// Same UX as the vision override. Stored in chrome.storage.local under
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
      await chrome.storage.local.remove('transcriptionModel');
      flashTranscriptionResult('ok', t('st.transcription.cleared'));
      return;
    }

    await chrome.storage.local.set({
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

    // Persist before testing so the background handler sees the values.
    await chrome.storage.local.set({
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
    await chrome.storage.local.remove('transcriptionModel');
    flashTranscriptionResult('ok', t('st.transcription.cleared'));
  });
}

// --- Profile auto-fill ---
// Persisted to chrome.storage.local in plaintext; the agent picks the
// changes up via the storage.onChanged listener in background.js and
// refreshes open conversations' system prompts on the next turn.

function flashProfileResult(className, text) {
  if (!profileTestResult) return;
  profileTestResult.className = `test-result show ${className}`;
  profileTestResult.textContent = text;
  setTimeout(() => profileTestResult.classList.remove('show'), 2000);
}

// Enabling/disabling the toggle saves immediately — no "Save" click needed
// for the on/off state so users don't get confused when the toggle
// appears to not do anything.
if (profileEnabledToggle) {
  profileEnabledToggle.addEventListener('change', () => {
    chrome.storage.local.set({ profileEnabled: profileEnabledToggle.checked });
  });
}

if (btnSaveProfile) {
  btnSaveProfile.addEventListener('click', async () => {
    const text = (profileTextArea?.value || '').trim();
    await chrome.storage.local.set({ profileText: text });
    flashProfileResult('ok', t('st.profile.saved'));
  });
}

if (btnClearProfile) {
  btnClearProfile.addEventListener('click', async () => {
    if (profileTextArea) profileTextArea.value = '';
    await chrome.storage.local.set({ profileText: '' });
    flashProfileResult('ok', t('st.profile.cleared'));
  });
}

// --- CapSolver (captcha solving) ---
// Toggle persists immediately so the prompt updates on the next agent turn
// without forcing a Save click. The API key needs an explicit Save.

function flashCaptchaResult(className, text) {
  if (!captchaTestResult) return;
  captchaTestResult.className = `test-result show ${className}`;
  captchaTestResult.textContent = text;
  setTimeout(() => captchaTestResult.classList.remove('show'), 3000);
}

if (captchaEnabledToggle) {
  captchaEnabledToggle.addEventListener('change', () => {
    chrome.storage.local.set({ captchaSolverEnabled: captchaEnabledToggle.checked });
  });
}

if (btnSaveCaptcha) {
  btnSaveCaptcha.addEventListener('click', async () => {
    const key = (captchaApiKeyInput?.value || '').trim();
    await chrome.storage.local.set({ capsolverApiKey: key });
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
    await chrome.storage.local.remove(['capsolverApiKey', 'captchaSolverEnabled']);
    flashCaptchaResult('ok', t('st.captcha.cleared'));
  });
}

// --- Provider Rendering ---

// Prompt-tier selector, shown only for local + OpenRouter providers (cloud is
// always 'full'). Mirrors the resolution in providers/base.js get promptTier().
const PROMPT_TIER_FIELD = {
  key: 'promptTier',
  labelKey: 'st.provider.field.prompt_tier',
  type: 'select',
  options: [
    { value: 'compact', labelKey: 'st.provider.field.prompt_tier.compact' },
    { value: 'mid', labelKey: 'st.provider.field.prompt_tier.mid' },
    { value: 'full', labelKey: 'st.provider.field.prompt_tier.full' },
  ],
};

const CONTEXT_WINDOW_FIELD = {
  key: 'contextWindow',
  labelKey: 'st.provider.field.context_window',
  type: 'number',
  placeholder: '16384',
  min: 4096,
  step: 1024,
};

const COST_ESTIMATE_FIELDS = [
  { key: 'inputCostPerMillionUsd', labelKey: 'st.provider.field.input_cost_per_million', type: 'number', placeholder: '3.00' },
  { key: 'outputCostPerMillionUsd', labelKey: 'st.provider.field.output_cost_per_million', type: 'number', placeholder: '15.00' },
];

const ZERO_ALLOWED_NUMBER_FIELDS = new Set([
  'inputCostPerMillionUsd',
  'outputCostPerMillionUsd',
]);

function providerInputValue(input) {
  if (input.dataset.type === 'checkbox' || input.type === 'checkbox') {
    return input.checked;
  }
  if (input.dataset.type === 'number' || input.type === 'number') {
    const raw = input.value.trim();
    if (raw === '') return '';
    const n = Number(raw);
    if (!Number.isFinite(n)) return '';
    return ZERO_ALLOWED_NUMBER_FIELDS.has(input.dataset.key)
      ? (n >= 0 ? n : '')
      : (n > 0 ? n : '');
  }
  return input.value;
}

// Effective tier for the dropdown's initial value — same precedence as the
// provider getter: cloud is forced full; an explicit promptTier wins; the
// legacy useCompactPrompt boolean maps to compact; otherwise local → mid.
function effectivePromptTier(config) {
  if ((config.category || 'cloud') === 'cloud') return 'full';
  const tier = config.promptTier;
  if (tier === 'compact' || tier === 'mid' || tier === 'full') return tier;
  if (config.useCompactPrompt) return 'compact';
  return config.category === 'local' ? 'mid' : 'full';
}

function renderProviders() {
  providersContainer.innerHTML = '';

  // Field definitions reference i18n keys (labelKey) so switching languages
  // re-renders with translated labels. Placeholders stay as raw values —
  // they're example URLs or API key shapes and reading them in English is
  // universal enough.
  const providerConfigs = {
    webbrain_cloud: {
      fields: [],
    },
    llamacpp: {
      fields: [
        { key: 'baseUrl', labelKey: 'st.provider.field.server_url', type: 'text', placeholder: 'http://localhost:8080' },
        { key: 'model', labelKey: 'st.provider.field.model', type: 'text', placeholder: 'qwen/qwen3.5-9b' },
        CONTEXT_WINDOW_FIELD,
        { key: 'supportsVision', labelKey: 'st.provider.field.supports_vision', type: 'checkbox' },
        PROMPT_TIER_FIELD,
      ],
    },
    ollama: {
      fields: [
        { key: 'baseUrl', labelKey: 'st.provider.field.server_url', type: 'text', placeholder: 'http://localhost:11434/v1' },
        { key: 'model', labelKey: 'st.provider.field.model', type: 'text', placeholder: 'llama3.1' },
        CONTEXT_WINDOW_FIELD,
        { key: 'supportsVision', labelKey: 'st.provider.field.supports_vision', type: 'checkbox' },
        PROMPT_TIER_FIELD,
      ],
    },
    lmstudio: {
      fields: [
        { key: 'baseUrl', labelKey: 'st.provider.field.server_url', type: 'text', placeholder: 'http://localhost:1234/v1' },
        { key: 'model', labelKey: 'st.provider.field.model_optional', type: 'text', placeholderKey: 'st.provider.field.model_loaded_hint' },
        CONTEXT_WINDOW_FIELD,
        { key: 'supportsVision', labelKey: 'st.provider.field.supports_vision', type: 'checkbox' },
        PROMPT_TIER_FIELD,
      ],
    },
    jan: {
      fields: [
        { key: 'baseUrl', labelKey: 'st.provider.field.server_url', type: 'text', placeholder: 'http://localhost:1337/v1' },
        { key: 'apiKey', labelKey: 'st.provider.field.api_key', type: 'password', placeholder: 'optional' },
        { key: 'model', labelKey: 'st.provider.field.model', type: 'text', placeholder: 'llama3.2-3b-instruct' },
        CONTEXT_WINDOW_FIELD,
        { key: 'supportsVision', labelKey: 'st.provider.field.supports_vision', type: 'checkbox' },
        PROMPT_TIER_FIELD,
      ],
    },
    vllm: {
      fields: [
        { key: 'baseUrl', labelKey: 'st.provider.field.server_url', type: 'text', placeholder: 'http://localhost:8000/v1' },
        { key: 'apiKey', labelKey: 'st.provider.field.api_key', type: 'password', placeholder: 'optional' },
        { key: 'model', labelKey: 'st.provider.field.model', type: 'text', placeholder: 'NousResearch/Meta-Llama-3-8B-Instruct' },
        CONTEXT_WINDOW_FIELD,
        { key: 'supportsVision', labelKey: 'st.provider.field.supports_vision', type: 'checkbox' },
        PROMPT_TIER_FIELD,
      ],
    },
    sglang: {
      fields: [
        { key: 'baseUrl', labelKey: 'st.provider.field.server_url', type: 'text', placeholder: 'http://localhost:30000/v1' },
        { key: 'apiKey', labelKey: 'st.provider.field.api_key', type: 'password', placeholder: 'optional' },
        { key: 'model', labelKey: 'st.provider.field.model', type: 'text', placeholder: 'Qwen/Qwen3-4B' },
        CONTEXT_WINDOW_FIELD,
        { key: 'supportsVision', labelKey: 'st.provider.field.supports_vision', type: 'checkbox' },
        PROMPT_TIER_FIELD,
      ],
    },
    openai: {
      fields: [
        { key: 'apiKey', labelKey: 'st.provider.field.api_key', type: 'password', placeholder: 'sk-...' },
        { key: 'model', labelKey: 'st.provider.field.model', type: 'text', placeholder: 'gpt-5.5',
          suggestions: ['gpt-5.5', 'gpt-5.4', 'gpt-5.2', 'gpt-5.3-codex'] },
        { key: 'baseUrl', labelKey: 'st.provider.field.api_base_url', type: 'text', placeholder: 'https://api.openai.com/v1' },
        ...COST_ESTIMATE_FIELDS,
      ],
    },
    openrouter: {
      fields: [
        { key: 'apiKey', labelKey: 'st.provider.field.api_key', type: 'password', placeholder: 'sk-or-...' },
        { key: 'model', labelKey: 'st.provider.field.model', type: 'text', placeholder: 'minimax/minimax-m3',
          suggestions: ['minimax/minimax-m3', 'stepfun/step-3.7-flash', 'minimax/minimax-m2.7', 'qwen/qwen3.7-max', 'xiaomi/mimo-v2.5-pro'] },
        { key: 'baseUrl', labelKey: 'st.provider.field.api_base_url', type: 'text', placeholder: 'https://openrouter.ai/api/v1' },
        PROMPT_TIER_FIELD,
      ],
    },
    anthropic: {
      fields: [
        { key: 'apiKey', labelKey: 'st.provider.field.api_key', type: 'password', placeholder: 'sk-ant-...' },
        { key: 'model', labelKey: 'st.provider.field.model', type: 'text', placeholder: 'claude-opus-4-8',
          suggestions: ['claude-opus-4-8', 'claude-sonnet-4-6', 'claude-haiku-4-5'] },
        { key: 'baseUrl', labelKey: 'st.provider.field.api_base_url', type: 'text', placeholder: 'https://api.anthropic.com' },
        ...COST_ESTIMATE_FIELDS,
      ],
    },
    gemini: {
      fields: [
        { key: 'apiKey', labelKey: 'st.provider.field.api_key', type: 'password', placeholder: 'AIza...' },
        { key: 'model', labelKey: 'st.provider.field.model', type: 'text', placeholder: 'gemini-3.1-pro',
          suggestions: ['gemini-3.1-pro', 'gemini-3-flash', 'gemini-3.5-flash', 'gemini-3.1-flash-lite'] },
        { key: 'baseUrl', labelKey: 'st.provider.field.api_base_url', type: 'text', placeholder: 'https://generativelanguage.googleapis.com/v1beta/openai' },
        ...COST_ESTIMATE_FIELDS,
      ],
    },
    mistral: {
      fields: [
        { key: 'apiKey', labelKey: 'st.provider.field.api_key', type: 'password', placeholder: 'API key' },
        { key: 'model', labelKey: 'st.provider.field.model', type: 'text', placeholder: 'mistral-medium-3.5',
          suggestions: ['mistral-medium-3.5', 'mistral-small-4', 'codestral-25.08', 'devstral-medium'] },
        { key: 'baseUrl', labelKey: 'st.provider.field.api_base_url', type: 'text', placeholder: 'https://api.mistral.ai/v1' },
        ...COST_ESTIMATE_FIELDS,
      ],
    },
    deepseek: {
      fields: [
        { key: 'apiKey', labelKey: 'st.provider.field.api_key', type: 'password', placeholder: 'sk-...' },
        { key: 'model', labelKey: 'st.provider.field.model', type: 'text', placeholder: 'deepseek-v4-flash',
          suggestions: ['deepseek-v4-flash', 'deepseek-v4-pro'] },
        { key: 'baseUrl', labelKey: 'st.provider.field.api_base_url', type: 'text', placeholder: 'https://api.deepseek.com/v1' },
        ...COST_ESTIMATE_FIELDS,
      ],
    },
    xai: {
      fields: [
        { key: 'apiKey', labelKey: 'st.provider.field.api_key', type: 'password', placeholder: 'xai-...' },
        { key: 'model', labelKey: 'st.provider.field.model', type: 'text', placeholder: 'grok-4.3',
          suggestions: ['grok-4.3', 'grok-4.1-fast', 'grok-build-0.1'] },
        { key: 'baseUrl', labelKey: 'st.provider.field.api_base_url', type: 'text', placeholder: 'https://api.x.ai/v1' },
        ...COST_ESTIMATE_FIELDS,
      ],
    },
    nvidia: {
      fields: [
        { key: 'apiKey', labelKey: 'st.provider.field.api_key', type: 'password', placeholder: 'nvapi-...' },
        { key: 'model', labelKey: 'st.provider.field.model', type: 'text', placeholder: 'nvidia/llama-3.3-nemotron-super-49b',
          suggestions: ['nvidia/llama-3.3-nemotron-super-49b', 'nvidia/llama-3.1-nemotron-70b-instruct', 'nvidia/nemotron-nano-9b-v2', 'meta/llama-3.3-70b-instruct', 'deepseek-ai/deepseek-r1'] },
        { key: 'baseUrl', labelKey: 'st.provider.field.api_base_url', type: 'text', placeholder: 'https://integrate.api.nvidia.com/v1' },
        ...COST_ESTIMATE_FIELDS,
      ],
    },
    minimax: {
      fields: [
        { key: 'apiKey', labelKey: 'st.provider.field.api_key', type: 'password', placeholder: 'API key' },
        { key: 'model', labelKey: 'st.provider.field.model', type: 'text', placeholder: 'minimax-m2.7',
          suggestions: ['minimax-m2.7', 'minimax-m2', 'minimax-text-01'] },
        { key: 'baseUrl', labelKey: 'st.provider.field.api_base_url', type: 'text', placeholder: 'https://api.minimax.chat/v1' },
        ...COST_ESTIMATE_FIELDS,
      ],
    },
    alibaba: {
      fields: [
        { key: 'apiKey', labelKey: 'st.provider.field.api_key', type: 'password', placeholder: 'sk-...' },
        { key: 'model', labelKey: 'st.provider.field.model', type: 'text', placeholder: 'qwen-max',
          suggestions: ['qwen-max', 'qwen-plus', 'qwen-turbo', 'qwen3-235b-a22b'] },
        { key: 'baseUrl', labelKey: 'st.provider.field.api_base_url', type: 'text', placeholder: 'https://dashscope.aliyuncs.com/compatible-mode/v1' },
        ...COST_ESTIMATE_FIELDS,
      ],
    },
    groq: {
      fields: [
        { key: 'apiKey', labelKey: 'st.provider.field.api_key', type: 'password', placeholder: 'gsk_...' },
        { key: 'model', labelKey: 'st.provider.field.model', type: 'text', placeholder: 'openai/gpt-oss-120b',
          suggestions: ['openai/gpt-oss-120b', 'openai/gpt-oss-20b', 'meta-llama/llama-4-scout-17b-16e-instruct', 'llama-3.3-70b-versatile', 'qwen/qwen3-32b'] },
        { key: 'baseUrl', labelKey: 'st.provider.field.api_base_url', type: 'text', placeholder: 'https://api.groq.com/openai/v1' },
        ...COST_ESTIMATE_FIELDS,
      ],
    },
    // OAuth-based Claude subscription provider. The card body is rendered
    // by renderClaudeOAuthCard() — it shows a sign-in/out button, the
    // current account state, and a disclaimer about Anthropic's terms.
    // The model field is the only normal config field.
    claude_subscription: {
      customRender: 'claude_oauth',
      fields: [
        { key: 'model', labelKey: 'st.provider.field.model', type: 'text', placeholder: 'claude-sonnet-4-6' },
      ],
    },
  };

  // Filter bar — sits above the list. Pill row, click-to-switch.
  // "All" includes everything; the per-category pills hide cards whose
  // `category` doesn't match. The active provider is ALWAYS visible
  // regardless of filter (so the user never loses track of it).
  providersContainer.appendChild(renderProviderFilterBar());

  const entries = Object.entries(providersData);
  let visibleCount = 0;
  for (const [id, config] of entries) {
    // Claude Pro/Max subscription OAuth flow is broken — hide until fixed.
    if (id === 'claude_subscription') continue;

    const isActive = id === activeProviderId;
    const fieldDefs = providerConfigs[id]?.fields || [];

    // Filter: hide cards whose category doesn't match (active always shown).
    const category = config.category || 'cloud';
    if (providerFilter !== 'all' && category !== providerFilter && !isActive) continue;
    visibleCount++;

    // Custom render for the OAuth Claude provider — same collapsible
    // wrapper, but the body comes from renderClaudeOAuthCard().
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
      if (field.type === 'select') {
        const current = field.key === 'promptTier'
          ? effectivePromptTier(config)
          : (config[field.key] ?? field.options[0]?.value);
        const optionsHTML = field.options
          .map(o => `<option value="${escapeHtml(o.value)}"${o.value === current ? ' selected' : ''}>${escapeHtml(o.labelKey ? t(o.labelKey) : o.label)}</option>`)
          .join('');
        fieldsHTML += `
          <div class="field">
            <label>${escapeHtml(label)}</label>
            <select data-provider="${id}" data-key="${field.key}" data-type="select">${optionsHTML}</select>
          </div>
        `;
      } else if (field.type === 'checkbox') {
        const isChecked = !!config[field.key];
        const checked = isChecked ? 'checked' : '';
        fieldsHTML += `
          <div class="field" style="display:flex;align-items:center;gap:8px;flex-direction:row;">
            <input type="checkbox" data-provider="${id}" data-key="${field.key}" data-type="checkbox" ${checked}
                   style="width:auto;cursor:pointer;">
            <label style="margin:0;cursor:pointer;">${escapeHtml(label)}</label>
          </div>
        `;
        } else if (field.suggestions && field.key === 'model') {
        const rawVal = config[field.key] || '';
        const isCustom = rawVal && !field.suggestions.includes(rawVal);
        const effectiveVal = rawVal || field.suggestions[0];
        const selectVal = isCustom ? '__custom__' : effectiveVal;
        const optionsHTML = field.suggestions
          .map(s => `<option value="${escapeHtml(s)}"${s === selectVal ? ' selected' : ''}>${escapeHtml(s)}</option>`)
          .join('') +
          `<option value="__custom__"${isCustom ? ' selected' : ''}>${escapeHtml(t('st.provider.field.model_custom'))}</option>`;
        fieldsHTML += `
          <div class="field">
            <label>${escapeHtml(label)}</label>
            <select class="model-select" data-model-for="${id}">${optionsHTML}</select>
            <input type="text" data-provider="${id}" data-key="model"
                   value="${escapeHtml(effectiveVal)}" placeholder="${escapeHtml(placeholder)}"
                   style="${isCustom ? '' : 'display:none;'}margin-top:6px;">
          </div>
        `;
      } else {
        const localModelProviders = ['llamacpp', 'ollama', 'lmstudio', 'jan', 'vllm', 'sglang'];
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
        const minAttr = field.min != null ? ` min="${escapeHtml(field.min)}"` : '';
        const stepAttr = field.step != null ? ` step="${escapeHtml(field.step)}"` : '';
        const value = config[field.key] ?? '';
        fieldsHTML += `
          <div class="field">
            <label>${escapeHtml(label)}${apiKeyLink}</label>
            <input type="${field.type}" data-provider="${id}" data-key="${field.key}" data-type="${field.type}" ${listAttr}${minAttr}${stepAttr}
                   value="${escapeHtml(value)}" placeholder="${escapeHtml(placeholder)}">
            ${datalistHTML}
            ${loadBtnHTML}
          </div>
        `;
      }
    }

    const providerNote = id === 'webbrain_cloud'
      ? `<div style="margin-top:10px;padding:10px 12px;border-radius:6px;
                  background:rgba(74,144,217,0.08);border:1px solid rgba(74,144,217,0.22);
                  font-size:12px;color:var(--text2);line-height:1.5;">
           Free daily WebBrain Cloud usage is included. Requests go through api.webbrain.one; by default we log
           metadata for quota and debugging, not prompt text, page content, screenshots, or model responses.
           <a href="https://webbrain.one/privacy" target="_blank" rel="noopener noreferrer"
              style="color:var(--accent,#4A90D9);text-decoration:none;">Privacy policy</a>.
           For more usage, subscribe at
           <a href="https://webbrain.one/subscribe" target="_blank" rel="noopener noreferrer"
              style="color:var(--accent,#4A90D9);text-decoration:none;">webbrain.one/subscribe</a>.
         </div>`
      : '';

    const body = `
      ${fieldsHTML}
      ${providerNote}
      <div class="btn-row">
        <button class="btn-primary btn-save" data-provider="${id}">${escapeHtml(t('st.providers.save'))}</button>
        <button class="btn-secondary btn-test" data-provider="${id}">${escapeHtml(t('st.providers.test'))}</button>
        ${!isActive ? `<button class="btn-secondary btn-activate" data-provider="${id}">${escapeHtml(t('st.providers.set_active'))}</button>` : ''}
      </div>
      <div class="test-result" id="test-${id}"></div>
    `;

    providersContainer.appendChild(wrapCollapsibleCard(id, config, isActive, body));
  }

  // If the filter would leave the list empty (no cards match and no active
  // provider in this category either), tell the user. Don't make them
  // guess why nothing is showing.
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
  document.querySelectorAll('.model-select').forEach(sel => {
    sel.addEventListener('change', () => {
      const providerId = sel.dataset.modelFor;
      const input = document.querySelector(`input[data-provider="${providerId}"][data-key="model"]`);
      if (!input) return;
      if (sel.value === '__custom__') {
        input.style.display = '';
        input.value = '';
        input.focus();
      } else {
        input.style.display = 'none';
        input.value = sel.value;
      }
    });
  });
  // OAuth-Claude-specific bindings. These only fire if the OAuth card is
  // currently rendered (i.e., expanded — collapsed bodies aren't in DOM).
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
 * Build the filter pill row. Clicking a pill updates `providerFilter`,
 * persists it to storage, and re-renders. Categories: all / local /
 * cloud / router.
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
      try { chrome.storage.local.set({ providerFilter: f.key }); } catch {}
      renderProviders();
    });
    bar.appendChild(btn);
  }
  return bar;
}

/**
 * Wrap a provider card's body in a collapsible shell. Active provider
 * starts expanded; everything else starts collapsed but the user can
 * toggle individual cards open by clicking the header. Expansion state
 * is session-only (resets on settings reload) — keeps the default
 * predictable rather than reflecting whatever the user last poked at.
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
  // than a placeholder, to avoid pretending we know what they're running.
  const modelStr = (config.model && String(config.model).trim()) || '';
  header.innerHTML = `
    <div class="provider-header-left">
      <span class="provider-chevron" aria-hidden="true">${expanded ? '▾' : '▸'}</span>
      <span class="provider-name">${escapeHtml(config.label || id)}</span>
      <span class="provider-type">${escapeHtml(config.type)}</span>
      ${config.category ? `<span class="provider-category-badge provider-category-${escapeHtml(config.category)}">${escapeHtml(config.category)}</span>` : ''}
      ${modelStr ? `<span class="provider-model" title="${escapeHtml(modelStr)}">${escapeHtml(modelStr)}</span>` : ''}
    </div>
    ${isActive ? `<span style="color:var(--accent);font-size:11px;font-weight:600">${escapeHtml(t('st.providers.active'))}</span>` : ''}
  `;
  header.addEventListener('click', (e) => {
    // Ignore clicks that originated on inputs/buttons inside the header
    // (none today, but future-proof).
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
 * Render the BODY of the Claude (Pro/Max subscription) provider card.
 *
 * Returns the inner HTML — header + outer wrapper come from
 * wrapCollapsibleCard() in renderProviders(). Differs from a normal
 * provider card in three ways:
 *   - No API-key field. Auth is via OAuth — handled by the background
 *     script. We just dispatch claude_oauth_start/signout/status.
 *   - Loaded auth state shows the obtained-at timestamp and a "Sign
 *     out" button; unauthed state shows "Sign in with Claude".
 *   - A persistent disclaimer warns the user that Anthropic's terms
 *     restrict third-party clients from using Pro/Max subs and that
 *     this integration may stop working at any time.
 *
 * Event bindings (sign-in/out) + the async status refresh fire from
 * the per-card pass at the end of renderProviders() — see
 * bindClaudeOAuthCards().
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
      <strong>Heads up:</strong> Uses your Claude.ai Pro/Max subscription's quota via the OAuth flow Anthropic ships for Claude Code. This is a third-party use of that flow — Anthropic's terms restrict using Pro/Max subscriptions with non-Anthropic tools, and the integration could stop working at any time if Anthropic rotates their CLI's OAuth client. Your access + refresh tokens are stored in <code>chrome.storage.local</code> in plaintext (same as API keys). Use at your own risk; for production / reliability, prefer the API-key Anthropic provider above.
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
  // Persist whatever the user has typed in baseUrl/model so the background
  // call uses the current values, not stale storage.
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
  const inputs = document.querySelectorAll(`input[data-provider="${id}"], select[data-provider="${id}"]`);
  const config = {};
  inputs.forEach(input => {
    config[input.dataset.key] = providerInputValue(input);
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

/**
 * Snapshot any unsaved field values from the current DOM back into
 * providersData so a subsequent renderProviders() preserves them.
 * Without this, clicking "Set Active" or any other action that re-renders
 * silently throws away whatever the user has typed but not yet saved.
 */
function syncInputsIntoProvidersData() {
  document.querySelectorAll('input[data-provider], select[data-provider]').forEach((input) => {
    const id = input.dataset.provider;
    const key = input.dataset.key;
    if (!id || !key || !providersData[id]) return;
    providersData[id][key] = providerInputValue(input);
  });
}

async function activateProvider(id) {
  syncInputsIntoProvidersData();
  await sendToBackground('set_active_provider', { providerId: id });
  activeProviderId = id;
  renderProviders();
}

function sendToBackground(action, data = {}) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(
      { target: 'background', action, ...data },
      (response) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
        } else if (response?.error) {
          reject(new Error(response.error));
        } else {
          resolve(response);
        }
      }
    );
  });
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
