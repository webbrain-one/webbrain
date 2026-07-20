/**
 * WebBrain Settings Page — provider configuration + display settings.
 */

import { t, getLocale, setLocale, LANGUAGES } from './i18n.js';
import { THEME_MODES, applyMode, loadMode, watch } from './theme.js';
import { renderSkillMarkdown } from './skill-markdown.js';
import { CAPABILITY_LABEL } from '../agent/permission-gate.js';
import {
  CUSTOM_SKILLS_STORAGE_KEY,
  DEFAULT_SKILL_SOURCES,
  DEFAULT_SKILLS_REMOVED_STORAGE_KEY,
  MAX_CUSTOM_SKILL_IMPORT_BYTES,
  MAX_CUSTOM_SKILLS,
  PACKAGED_SKILL_SOURCES,
  fetchSkillImportResponse,
  normalizeCustomSkills,
  normalizeDefaultSkillRemovalIds,
  readSkillImportText,
} from '../agent/skills.js';
import {
  USER_MEMORY_AUTO_CAPTURE_KEY,
  USER_MEMORY_DEFAULT_MAX_PROMPT_CHARS,
  USER_MEMORY_ENABLED_KEY,
  USER_MEMORY_FORM_CAPTURE_KEY,
  USER_MEMORY_MAX_PROMPT_CHARS_KEY,
  normalizeUserMemoryMaxPromptChars,
} from '../agent/user-memory.js';
import {
  detectedCompatibilityPreset,
  normalizeProviderCompatibility,
  parseProviderExtraBodyJson,
  shouldUseOpenAIResponsesApi,
} from '../providers/provider-compatibility.js';
import {
  DOWNLOAD_DIRECTORY_STORAGE_KEY,
  normalizeDownloadDirectory,
} from '../download-directory.js';
import {
  providerIconHtml,
  providerIconUrl,
  PROVIDER_SHORT_LABELS,
  sniffProviderIdFromBaseUrl,
} from './provider-icons.js';

// Version shown in the subtitle. Kept here so it only needs one update per
// release; the subtitle string itself is translated.
const EXT_VERSION = '25.1.2';

const providersContainer = document.getElementById('providers');
const displaySettings = document.getElementById('display-settings');
const generalSearchInput = document.getElementById('input-general-search');
const generalSearchEmpty = document.getElementById('general-search-empty');
const advancedSettings = document.querySelector('.advanced-settings');
const verboseToggle = document.getElementById('toggle-verbose');
const selectionShortcutToggle = document.getElementById('toggle-selection-shortcut');
const helpImproveToggle = document.getElementById('toggle-help-improve');
const screenshotToggle = document.getElementById('toggle-screenshot-fallback');
const maxStepsRange = document.getElementById('range-max-steps');
const stepsValueLabel = document.getElementById('steps-value');
const requestTimeoutRange = document.getElementById('range-request-timeout');
const requestTimeoutValueLabel = document.getElementById('timeout-value');
const clarifyTimeoutRange = document.getElementById('range-clarify-timeout');
const clarifyTimeoutValueLabel = document.getElementById('clarify-timeout-value');
const costSessionLimitInput = document.getElementById('input-cost-session-limit');
const costTotalLimitInput = document.getElementById('input-cost-total-limit');
const costSpentValueLabel = document.getElementById('cost-spent-value');
const btnResetCostSpend = document.getElementById('btn-reset-cost-spend');
const autoScreenshotSelect = document.getElementById('select-auto-screenshot');
const siteAdaptersToggle = document.getElementById('toggle-site-adapters');
const voiceInputToggle = document.getElementById('toggle-voice-input');
const apiMutationObserverToggle = document.getElementById('toggle-api-mutation-observer');
const planBeforeActModeSelect = document.getElementById('select-plan-before-act-mode');
const planReviewModeSelect = document.getElementById('select-plan-review-mode');
const planReviewConfidenceRange = document.getElementById('range-plan-review-confidence');
const planReviewConfidenceValueLabel = document.getElementById('plan-review-confidence-value');
const planReviewConfidenceRow = document.getElementById('row-plan-review-confidence');
const notifySoundToggle = document.getElementById('toggle-notify-sound');
const completionConfettiToggle = document.getElementById('toggle-completion-confetti');
const tracingToggle = document.getElementById('toggle-tracing');
const strictSecretToggle = document.getElementById('toggle-strict-secret');
const allowLocalNetworkToggle = document.getElementById('toggle-allow-local-network');
const scheduledTasksToggle = document.getElementById('toggle-scheduled-tasks');
const scheduledConfirmToggle = document.getElementById('toggle-scheduled-confirm');
const visionBaseUrlInput = document.getElementById('vision-base-url');
const visionApiKeyInput = document.getElementById('vision-api-key');
const visionModelInput = document.getElementById('vision-model');
const btnSaveVision = document.getElementById('btn-save-vision');
const skillNameInput = document.getElementById('skill-name');
const skillUrlInput = document.getElementById('skill-url');
const skillTextArea = document.getElementById('skill-text');
const btnAddSkillUrl = document.getElementById('btn-add-skill-url');
const btnAddSkillText = document.getElementById('btn-add-skill-text');
const btnClearSkillForm = document.getElementById('btn-clear-skill-form');
const skillsResult = document.getElementById('skills-result');
const skillsList = document.getElementById('skills-list');
const packagedSkillsList = document.getElementById('packaged-skills-list');
const skillPreviewDialog = document.getElementById('skill-preview-dialog');
const skillPreviewTitle = document.getElementById('skill-preview-title');
const skillPreviewSource = document.getElementById('skill-preview-source');
const skillPreviewRendered = document.getElementById('skill-preview-rendered');
const skillPreviewRaw = document.getElementById('skill-preview-raw');
const skillPreviewViewButtons = document.querySelectorAll('[data-skill-preview-view]');
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
const profileSyncStatus = document.getElementById('profile-sync-status');
const profileSyncResult = document.getElementById('test-profile-sync');
const profileSyncEmail = document.getElementById('profile-sync-email');
const profileSyncPassword = document.getElementById('profile-sync-password');
const profileSyncConfirm = document.getElementById('profile-sync-confirm');
const profileSyncEmailField = document.getElementById('profile-sync-email-field');
const profileSyncPasswordField = document.getElementById('profile-sync-password-field');
const profileSyncConfirmField = document.getElementById('profile-sync-confirm-field');
const profileSyncAdvanced = document.getElementById('profile-sync-advanced');
const btnProfileSyncAuth = document.getElementById('btn-profile-sync-auth');
const btnProfileSyncEnable = document.getElementById('btn-profile-sync-enable');
const btnProfileSyncUnlock = document.getElementById('btn-profile-sync-unlock');
const btnProfileSyncNow = document.getElementById('btn-profile-sync-now');
const btnProfileSyncLock = document.getElementById('btn-profile-sync-lock');
const btnProfileSyncChange = document.getElementById('btn-profile-sync-change');
const btnProfileSyncDisable = document.getElementById('btn-profile-sync-disable');
const btnProfileSyncReset = document.getElementById('btn-profile-sync-reset');
const userMemoryEnabledToggle = document.getElementById('toggle-user-memory-enabled');
const userMemoryAutoToggle = document.getElementById('toggle-user-memory-auto');
const userMemoryFormToggle = document.getElementById('toggle-user-memory-form');
const userMemoryMaxCharsInput = document.getElementById('input-user-memory-max-chars');
const userMemoryList = document.getElementById('user-memory-list');
const btnRefreshUserMemory = document.getElementById('btn-refresh-user-memory');
const btnExportUserMemory = document.getElementById('btn-export-user-memory');
const btnClearUserMemory = document.getElementById('btn-clear-user-memory');
const userMemoryImportText = document.getElementById('user-memory-import-text');
const btnImportUserMemory = document.getElementById('btn-import-user-memory');
const userMemoryTestResult = document.getElementById('test-user-memory');
const captchaEnabledToggle = document.getElementById('toggle-captcha-enabled');
const captchaApiKeyInput = document.getElementById('captcha-api-key');
const btnSaveCaptcha = document.getElementById('btn-save-captcha');
const btnTestCaptcha = document.getElementById('btn-test-captcha');
const btnClearCaptcha = document.getElementById('btn-clear-captcha');
const captchaTestResult = document.getElementById('test-captcha');
const languageSelect = document.getElementById('select-language');
const themeSelect = document.getElementById('select-theme');
const downloadDirectoryInput = document.getElementById('input-download-directory');
const subtitleEl = document.getElementById('subtitle');

// --- Appearance / theme ---
// Loaded from browser.storage.local (canonical) with a localStorage mirror
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
  themeSelect.addEventListener('change', async () => {
    const mode = THEME_MODES.includes(themeSelect.value) ? themeSelect.value : 'system';
    currentThemeMode = mode;
    await applyMode(mode);
  });
  watch(() => currentThemeMode);
  // If another Settings tab or the side panel flips the theme, watch()
  // already re-paints this page — but the closure variable and the select
  // value won't update on their own. Without this, the picker drifts out
  // of sync and a later OS-theme flip can re-apply the stale 'system'.
  if (globalThis.browser?.storage?.onChanged) {
    browser.storage.onChanged.addListener((changes, area) => {
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

function normalizeGeneralSearchText(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

function searchTextForGeneralItem(item) {
  const searchableNodes = [item, ...Array.from(item.querySelectorAll('[id], [data-i18n], [data-i18n-html], [data-i18n-placeholder]'))];
  const keyedText = searchableNodes
    .map((el) => [
      el.id,
      el.dataset?.i18n,
      el.dataset?.i18nHtml,
      el.dataset?.i18nPlaceholder,
    ].filter(Boolean).join(' '))
    .join(' ');
  return normalizeGeneralSearchText(`${item.textContent || ''} ${keyedText}`);
}

function setGeneralSearchHidden(item, hidden) {
  item.hidden = hidden;
  item.classList.toggle('general-search-hidden', hidden);
}

function filterGeneralSettings() {
  if (!displaySettings || !generalSearchInput) return;
  const query = normalizeGeneralSearchText(generalSearchInput.value);
  const visibleItems = Array.from(displaySettings.children)
    .filter((el) => el.classList?.contains('setting-row'));
  const advancedBody = advancedSettings?.querySelector('.advanced-settings-body');
  const advancedItems = advancedBody
    ? Array.from(advancedBody.children).filter((el) => el.classList?.contains('setting-row') || el.classList?.contains('provider-card'))
    : [];

  let visibleMatches = 0;
  let advancedMatches = 0;
  visibleItems.forEach((item) => {
    const matches = !query || searchTextForGeneralItem(item).includes(query);
    setGeneralSearchHidden(item, !!query && !matches);
    if (matches) visibleMatches += 1;
  });
  advancedItems.forEach((item) => {
    const matches = !query || searchTextForGeneralItem(item).includes(query);
    setGeneralSearchHidden(item, !!query && !matches);
    if (matches) advancedMatches += 1;
  });

  if (advancedSettings) {
    setGeneralSearchHidden(advancedSettings, !!query && advancedMatches === 0);
    if (query && advancedMatches > 0) advancedSettings.open = true;
  }
  if (generalSearchEmpty) {
    generalSearchEmpty.hidden = !query || (visibleMatches + advancedMatches) > 0;
  }
}

if (generalSearchInput) {
  generalSearchInput.addEventListener('input', filterGeneralSettings);
}

if (languageSelect) {
  languageSelect.innerHTML = LANGUAGES.map((l) => `<option value="${l.code}">${l.label}</option>`).join('');
  languageSelect.value = getLocale();
  languageSelect.addEventListener('change', async () => {
    await setLocale(languageSelect.value);
    renderSubtitle();
    filterGeneralSettings();
    renderProviders();
  });
  document.addEventListener('wb-locale-changed', () => {
    languageSelect.value = getLocale();
    renderSubtitle();
    filterGeneralSettings();
    if (providersContainer) renderProviders();
    renderSkills();
    renderPermissions();
  });
}

let providersData = {};
// Unsaved custom-body text must survive provider-card/filter/search renders,
// including temporarily invalid JSON while the user is still editing it.
// Keep the raw UI draft separate from the last valid provider config.
const providerCompatibilityJsonDrafts = new Map();
let activeProviderId = '';
let providerActivationRequestId = 0;
let requestedActiveProviderId = '';

const WEBBRAIN_SUBSCRIBE_URL = 'https://webbrain.one/subscribe';
const WEBBRAIN_ACCOUNT_URL = 'https://api.webbrain.one/account';

const DEFAULT_COST_ALLOWANCE_USD = 10;
const MAX_AGENT_STEPS_DEFAULT = 130;
const MAX_AGENT_STEPS_UNLIMITED_SENTINEL = 200;
const PLAN_BEFORE_ACT_MODES = new Set(['try', 'strict', 'off']);
const PLAN_REVIEW_MODES = new Set(['confidence', 'always', 'never']);
// Product default: auto-approve plans at 75% confidence to reduce review stops.
// Planner prompt still tells the LLM to reserve 90%+ for straightforward plans;
// that intentional gap keeps model scoring conservative without over-pausing.
const PLAN_REVIEW_CONFIDENCE_DEFAULT = 75;

function normalizePlanBeforeActMode(stored = {}) {
  if (PLAN_BEFORE_ACT_MODES.has(stored.planBeforeActMode)) return stored.planBeforeActMode;
  if (stored.planBeforeAct === true) return 'strict';
  if (stored.planBeforeAct === false) return 'off';
  return 'try';
}

function normalizePlanReviewMode(stored = {}) {
  return PLAN_REVIEW_MODES.has(stored.planReviewMode) ? stored.planReviewMode : 'confidence';
}

function normalizePlanReviewConfidenceThreshold(stored = {}) {
  let threshold = Number(stored.planReviewConfidenceThreshold);
  if (!Number.isFinite(threshold)) threshold = PLAN_REVIEW_CONFIDENCE_DEFAULT;
  if (threshold > 0 && threshold <= 1) threshold *= 100;
  return Math.max(50, Math.min(99, Math.round(threshold)));
}

function updatePlanReviewConfidenceUI() {
  if (!planReviewConfidenceRange || !planReviewConfidenceValueLabel) return;
  planReviewConfidenceValueLabel.textContent = `${planReviewConfidenceRange.value}%`;
  const thresholdEnabled = !planReviewModeSelect || planReviewModeSelect.value === 'confidence';
  planReviewConfidenceRange.disabled = !thresholdEnabled;
  if (planReviewConfidenceRow) {
    planReviewConfidenceRow.classList.toggle('setting-row-muted', !thresholdEnabled);
  }
}

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

function webbrainSubscribeUrl(deviceGuid) {
  const url = new URL(WEBBRAIN_SUBSCRIBE_URL);
  if (deviceGuid) {
    url.searchParams.set('client_reference_id', deviceGuid);
  }
  return url.toString();
}

function webbrainAccountUrl(deviceGuid) {
  const url = new URL(WEBBRAIN_ACCOUNT_URL);
  if (deviceGuid) {
    url.searchParams.set('client_reference_id', deviceGuid);
  }
  return url.toString();
}

function isUnlimitedMaxAgentSteps(value) {
  const n = Number(value);
  return Number.isFinite(n) && (n === 0 || n >= MAX_AGENT_STEPS_UNLIMITED_SENTINEL);
}

function boundedMaxAgentSteps(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 5 && n < MAX_AGENT_STEPS_UNLIMITED_SENTINEL
    ? Math.floor(n)
    : MAX_AGENT_STEPS_DEFAULT;
}

// Filter + collapse state for the providers panel. See chrome/settings.js
// for the rationale.
let providerFilter = 'all';     // 'all' | 'local' | 'cloud' | 'router'
let providerSearchQuery = '';
const expandedProviders = new Set();
let customSkills = [];
let skillPreviewRequestId = 0;
const DEFAULT_SKILL_IDS = new Set(DEFAULT_SKILL_SOURCES.map((source) => source.id));

// --- Init ---

async function init() {
  // Migration: the old auth.webbrain.one sign-in stored a bearer token and
  // account info here. Billing is now device-GUID based and there is no sign-in
  // UI, so purge any stale credentials left over from that flow.
  browser.storage.local.remove(['authToken', 'authEmail', 'authDefaultModel']).catch(() => {});

  // Load display settings
  const stored = await browser.storage.local.get(['verboseMode', 'selectionShortcutEnabled', 'helpImproveWebBrain', 'screenshotFallback', 'maxAgentSteps', 'autoScreenshot', 'useSiteAdapters', 'voiceInputEnabled', 'apiMutationObserverEnabled', 'planBeforeActMode', 'planBeforeAct', 'planReviewMode', 'planReviewConfidenceThreshold', DOWNLOAD_DIRECTORY_STORAGE_KEY, 'notifySound', 'completionConfetti', 'tracingEnabled', 'strictSecretMode', 'agentAllowLocalNetwork', 'scheduledTasksEnabled', 'scheduledRequireConsequentialConfirmation', 'providerFilter', 'requestTimeoutMs', 'clarifyTimeoutSec', 'clarifyTimeoutSemanticsV2', 'costAllowanceSessionUsd', 'costAllowanceTotalUsd', 'cloudCostSpentUsd', 'screenshotRedaction']);
  if (typeof stored.providerFilter === 'string' && ['all','local','cloud','router'].includes(stored.providerFilter)) {
    providerFilter = stored.providerFilter;
  }
  verboseToggle.checked = stored.verboseMode || false;
  if (selectionShortcutToggle) selectionShortcutToggle.checked = stored.selectionShortcutEnabled !== false;
  if (helpImproveToggle) helpImproveToggle.checked = stored.helpImproveWebBrain !== false; // on by default
  screenshotToggle.checked = stored.screenshotFallback ?? true; // on by default
  if (isUnlimitedMaxAgentSteps(stored.maxAgentSteps)) {
    maxStepsRange.value = MAX_AGENT_STEPS_UNLIMITED_SENTINEL;
    stepsValueLabel.textContent = '∞';
  } else {
    maxStepsRange.value = boundedMaxAgentSteps(stored.maxAgentSteps);
    stepsValueLabel.textContent = maxStepsRange.value;
  }
  // requestTimeoutMs is stored in milliseconds, displayed as seconds.
  if (requestTimeoutRange && requestTimeoutValueLabel) {
    const tMs = (typeof stored.requestTimeoutMs === 'number' && stored.requestTimeoutMs > 0)
      ? stored.requestTimeoutMs
      : 120000;
    const tSec = Math.max(10, Math.min(600, Math.round(tMs / 1000)));
    requestTimeoutRange.value = tSec;
    requestTimeoutValueLabel.textContent = tSec + 's';
  }
  // Clarify auto-timeout: 0 = Instant, 1–1200s wait, >1200 (1205) = Off. Default 60s.
  if (clarifyTimeoutRange && clarifyTimeoutValueLabel) {
    const raw = Number(stored.clarifyTimeoutSec);
    let cSec = 60;
    if (Number.isFinite(raw) && raw >= 0) {
      cSec = raw > 1200 ? 1205 : Math.min(1200, Math.floor(raw));
    }
    // One-shot migration: old 0 meant Off; new Off is 1205.
    if (!stored.clarifyTimeoutSemanticsV2) {
      const updates = { clarifyTimeoutSemanticsV2: true };
      if (Number(stored.clarifyTimeoutSec) === 0) {
        cSec = 1205;
        updates.clarifyTimeoutSec = 1205;
      }
      browser.storage.local.set(updates).catch(() => {});
    }
    clarifyTimeoutRange.value = cSec;
    clarifyTimeoutValueLabel.textContent = formatClarifyTimeoutLabel(cSec);
  }
  if (autoScreenshotSelect) autoScreenshotSelect.value = stored.autoScreenshot || 'state_change';
  if (siteAdaptersToggle) siteAdaptersToggle.checked = stored.useSiteAdapters ?? true;
  if (voiceInputToggle) voiceInputToggle.checked = stored.voiceInputEnabled ?? true;
  if (apiMutationObserverToggle) apiMutationObserverToggle.checked = stored.apiMutationObserverEnabled === true;
  if (planBeforeActModeSelect) planBeforeActModeSelect.value = normalizePlanBeforeActMode(stored);
  if (planReviewModeSelect) planReviewModeSelect.value = normalizePlanReviewMode(stored);
  if (planReviewConfidenceRange) {
    planReviewConfidenceRange.value = normalizePlanReviewConfidenceThreshold(stored);
    updatePlanReviewConfidenceUI();
  }
  if (downloadDirectoryInput) {
    downloadDirectoryInput.value = normalizeDownloadDirectory(stored[DOWNLOAD_DIRECTORY_STORAGE_KEY]);
  }
  if (notifySoundToggle) notifySoundToggle.checked = stored.notifySound ?? true;
  if (completionConfettiToggle) completionConfettiToggle.checked = stored.completionConfetti ?? true;
  if (tracingToggle) tracingToggle.checked = stored.tracingEnabled === true;
  const sessionLimit = normalizeCostAmount(stored.costAllowanceSessionUsd);
  const totalLimit = normalizeCostAmount(stored.costAllowanceTotalUsd);
  const totalSpent = normalizeCostAmount(stored.cloudCostSpentUsd, 0);
  if (costSessionLimitInput) costSessionLimitInput.value = sessionLimit.toFixed(2);
  if (costTotalLimitInput) costTotalLimitInput.value = totalLimit.toFixed(2);
  renderCostAllowanceSpent(totalSpent, totalLimit);
  if (strictSecretToggle) strictSecretToggle.checked = stored.strictSecretMode === true; // off by default
  if (allowLocalNetworkToggle) allowLocalNetworkToggle.checked = stored.agentAllowLocalNetwork === true;
  if (scheduledTasksToggle) scheduledTasksToggle.checked = stored.scheduledTasksEnabled !== false;
  if (scheduledConfirmToggle) scheduledConfirmToggle.checked = stored.scheduledRequireConsequentialConfirmation !== false;

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
  updateMultimodalDetectedProvider('vision');
  updateMultimodalDetectedProvider('transcription');

  // Load profile (auto-fill bio + throwaway password)
  const profileStored = await browser.storage.local.get(['profileEnabled', 'profileText']);
  if (profileEnabledToggle) profileEnabledToggle.checked = !!profileStored.profileEnabled;
  if (profileTextArea) profileTextArea.value = profileStored.profileText || '';
  await loadUserMemorySettings();

  // Load CapSolver config — off by default.
  const captchaStored = await browser.storage.local.get(['captchaSolverEnabled', 'capsolverApiKey']);
  if (captchaEnabledToggle) captchaEnabledToggle.checked = !!captchaStored.captchaSolverEnabled;
  if (captchaApiKeyInput) captchaApiKeyInput.value = captchaStored.capsolverApiKey || '';

  await loadCustomSkills();

  // Load site permissions (capability × origin grants) + the master switch
  await initPermissionGateToggle();
  await renderPermissions();
  await initScreenshotRedactionToggle();

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
  const stored = await browser.storage.local.get(GATE_KEY);
  const askBefore = stored[GATE_KEY] ?? true; // gate ON by default
  toggle.checked = askBefore;
  if (warning) warning.style.display = askBefore ? 'none' : '';
  toggle.addEventListener('change', async () => {
    await browser.storage.local.set({ [GATE_KEY]: toggle.checked });
    if (warning) warning.style.display = toggle.checked ? 'none' : '';
  });
}

// Screenshot redaction (issue #312): local, best-effort PII blurring on
// screenshots BEFORE they are sent to a vision model. OFF by default.
const REDACTION_KEY = 'screenshotRedaction';
async function initScreenshotRedactionToggle() {
  const toggle = document.getElementById('toggle-screenshot-redaction');
  if (!toggle) return;
  const stored = await browser.storage.local.get(REDACTION_KEY);
  toggle.checked = stored[REDACTION_KEY] === true; // OFF by default
  toggle.addEventListener('change', async () => {
    await browser.storage.local.set({ [REDACTION_KEY]: toggle.checked });
  });
}

async function renderPermissions() {
  const listEl = document.getElementById('permissions-list');
  const actionsEl = document.getElementById('permissions-actions');
  if (!listEl) return;

  const stored = await browser.storage.local.get(PERMISSIONS_KEY);
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
      const cur = (await browser.storage.local.get(PERMISSIONS_KEY))[PERMISSIONS_KEY] || [];
      const next = cur.filter((g) => !(g.capability === capability && g.host === host));
      await browser.storage.local.set({ [PERMISSIONS_KEY]: next });
      renderPermissions();
    });
  });
}

document.getElementById('btn-clear-all-permissions')?.addEventListener('click', async () => {
  await browser.storage.local.set({ [PERMISSIONS_KEY]: [] });
  renderPermissions();
});

// Live-sync the Permissions tab when grants (or the master switch) change
// elsewhere while this page is open — e.g. the agent records a new "Always
// allow" grant from the side-panel permission card. Without this the list
// shows a stale snapshot until a manual refresh.
if (globalThis.browser?.storage?.onChanged) {
  browser.storage.onChanged.addListener((changes, area) => {
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

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

// --- Skills ---

function makeSkillId() {
  return `skill_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function showSkillsResult(className, text, color = '') {
  if (!skillsResult) return null;
  skillsResult.className = `test-result show${className ? ` ${className}` : ''}`;
  skillsResult.textContent = text;
  skillsResult.style.color = color || '';
  return skillsResult;
}

function flashSkillsResult(className, text) {
  const resultEl = showSkillsResult(className, text);
  if (resultEl) setTimeout(() => resultEl.classList.remove('show'), 3000);
}

function isLoopbackHostname(hostname) {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]' || hostname === '::1';
}

function normalizeSkillUrl(raw) {
  let url;
  try {
    url = new URL(String(raw || '').trim());
  } catch {
    throw new Error(t('st.skills.error.url'));
  }
  const isHttpLoopback = url.protocol === 'http:' && isLoopbackHostname(url.hostname);
  if (url.protocol !== 'https:' && !isHttpLoopback) {
    throw new Error(t('st.skills.error.url'));
  }
  return url.href;
}

function extractSkillText(raw, contentType = '') {
  const text = String(raw || '');
  if (/html/i.test(contentType)) {
    const doc = new DOMParser().parseFromString(text, 'text/html');
    doc.querySelectorAll('script, style, noscript').forEach((el) => el.remove());
    const body = (doc.body?.innerText || doc.body?.textContent || '').trim();
    const title = (doc.title || '').trim();
    return [title ? `# ${title}` : '', body].filter(Boolean).join('\n\n').trim();
  }
  return text.trim();
}

function setSkillPreviewView(view) {
  const showRaw = view === 'raw';
  if (skillPreviewRendered) skillPreviewRendered.hidden = showRaw;
  if (skillPreviewRaw) skillPreviewRaw.hidden = !showRaw;
  skillPreviewViewButtons.forEach((button) => {
    button.setAttribute('aria-pressed', String(button.dataset.skillPreviewView === view));
  });
}

function setSkillPreviewContent(content) {
  const text = String(content || '');
  if (skillPreviewRendered) skillPreviewRendered.innerHTML = renderSkillMarkdown(text);
  if (skillPreviewRaw) skillPreviewRaw.textContent = text;
}

function openSkillPreview(name, source, content) {
  if (!skillPreviewDialog || !skillPreviewTitle || !skillPreviewSource || !skillPreviewRendered || !skillPreviewRaw) return;
  skillPreviewTitle.textContent = name;
  skillPreviewSource.textContent = source;
  setSkillPreviewContent(content);
  setSkillPreviewView('rendered');
  if (skillPreviewDialog.open) return;
  if (typeof skillPreviewDialog.showModal === 'function') skillPreviewDialog.showModal();
  else skillPreviewDialog.setAttribute('open', '');
}

function closeSkillPreview() {
  skillPreviewRequestId += 1;
  if (!skillPreviewDialog) return;
  if (typeof skillPreviewDialog.close === 'function') skillPreviewDialog.close();
  else skillPreviewDialog.removeAttribute('open');
}

async function loadPackagedSkillContent(source) {
  const response = await fetch(browser.runtime.getURL(source.path));
  if (!response.ok) throw new Error(t('st.skills.error.fetch', { status: response.status }));
  return response.text();
}

async function previewPackagedSkill(skillId) {
  const source = PACKAGED_SKILL_SOURCES.find((item) => item.id === skillId);
  if (!source) return;
  const requestId = ++skillPreviewRequestId;
  openSkillPreview(source.name, t('st.skills.source.built_in'), t('st.providers.loading'));
  try {
    const content = await loadPackagedSkillContent(source);
    if (requestId === skillPreviewRequestId) setSkillPreviewContent(content);
  } catch (error) {
    if (requestId === skillPreviewRequestId) {
      setSkillPreviewContent(error?.message || t('st.skills.error.fetch', { status: '—' }));
    }
  }
}

function previewEnabledSkill(skillId) {
  const skill = customSkills.find((item) => item.id === skillId);
  if (!skill) return;
  skillPreviewRequestId += 1;
  const source = skill.sourceType === 'built-in'
    ? t('st.skills.source.built_in')
    : skill.sourceType === 'url' && skill.sourceUrl ? skill.sourceUrl : t('st.skills.source.raw');
  openSkillPreview(skill.name, source, skill.content);
}

skillPreviewDialog?.addEventListener('click', (event) => {
  if (event.target === skillPreviewDialog || event.target.closest('.skill-preview-dialog-close')) {
    closeSkillPreview();
  }
});
skillPreviewViewButtons.forEach((button) => {
  button.addEventListener('click', () => setSkillPreviewView(button.dataset.skillPreviewView));
});

async function loadCustomSkills() {
  if (!skillsList) return;
  const stored = await browser.storage.local.get(CUSTOM_SKILLS_STORAGE_KEY);
  customSkills = normalizeCustomSkills(stored[CUSTOM_SKILLS_STORAGE_KEY]);
  renderSkills();
}

async function saveCustomSkills(nextSkills, opts = {}) {
  customSkills = normalizeCustomSkills(nextSkills);
  const update = { [CUSTOM_SKILLS_STORAGE_KEY]: customSkills };
  const removedSkill = opts.removedSkill;
  const installedSkill = opts.installedSkill;
  const removedDefault = removedSkill?.sourceType === 'built-in' && DEFAULT_SKILL_IDS.has(removedSkill.id);
  const installedDefault = installedSkill?.sourceType === 'built-in' && DEFAULT_SKILL_IDS.has(installedSkill.id);
  if (removedDefault || installedDefault) {
    const stored = await browser.storage.local.get(DEFAULT_SKILLS_REMOVED_STORAGE_KEY);
    let removedIds = normalizeDefaultSkillRemovalIds(stored[DEFAULT_SKILLS_REMOVED_STORAGE_KEY]);
    if (removedDefault && !removedIds.includes(removedSkill.id)) removedIds.push(removedSkill.id);
    if (installedDefault) removedIds = removedIds.filter((id) => id !== installedSkill.id);
    update[DEFAULT_SKILLS_REMOVED_STORAGE_KEY] = removedIds;
  }
  await browser.storage.local.set(update);
  renderSkills();
}

function renderPackagedSkills() {
  if (!packagedSkillsList) return;
  const installedIds = new Set(customSkills.map((skill) => skill.id));
  const available = PACKAGED_SKILL_SOURCES.filter((source) => !installedIds.has(source.id));
  if (available.length === 0) {
    packagedSkillsList.innerHTML = `<div class="setting-desc">${escapeHtml(t('st.skills.available.empty'))}</div>`;
    return;
  }
  packagedSkillsList.innerHTML = available.map((source) => `
    <div class="setting-row" style="align-items:center;">
      <div class="setting-info">
        <button type="button" class="setting-label skill-name-button"
                data-packaged-skill-preview-id="${escapeHtml(source.id)}">${escapeHtml(source.name)}</button>
        <div class="setting-desc skill-source">${escapeHtml(t('st.skills.source.built_in'))}</div>
      </div>
      <button class="btn-secondary" data-packaged-skill-id="${escapeHtml(source.id)}">${escapeHtml(t('st.skills.enable'))}</button>
    </div>`).join('');

  packagedSkillsList.querySelectorAll('button[data-packaged-skill-preview-id]').forEach((btn) => {
    btn.addEventListener('click', () => previewPackagedSkill(btn.dataset.packagedSkillPreviewId));
  });
  packagedSkillsList.querySelectorAll('button[data-packaged-skill-id]').forEach((btn) => {
    btn.addEventListener('click', () => addPackagedSkill(btn.dataset.packagedSkillId, btn));
  });
}

function renderSkills() {
  if (!skillsList) return;
  renderPackagedSkills();
  if (customSkills.length === 0) {
    skillsList.innerHTML = `<div class="setting-desc">${escapeHtml(t('st.skills.empty'))}</div>`;
    return;
  }

  skillsList.innerHTML = customSkills.map((skill) => {
    const source = skill.sourceType === 'built-in'
      ? t('st.skills.source.built_in')
      : skill.sourceType === 'url' && skill.sourceUrl ? skill.sourceUrl : t('st.skills.source.raw');
    const toolNames = (skill.tools || []).map((tool) => tool.name).filter(Boolean);
    const toolSummary = toolNames.length
      ? ` · ${t('st.skills.item.tools', { tools: toolNames.join(', ') })}`
      : '';
    return `
      <div class="setting-row" style="align-items:center;">
        <div class="setting-info">
          <button type="button" class="setting-label skill-name-button"
                  data-skill-preview-id="${escapeHtml(skill.id)}">${escapeHtml(skill.name)}</button>
          <div class="setting-desc skill-source">${escapeHtml(source)} · ${escapeHtml(t('st.skills.item.chars', { count: skill.content.length }))}${escapeHtml(toolSummary)}</div>
        </div>
        <button class="btn-secondary" data-skill-id="${escapeHtml(skill.id)}">${escapeHtml(t('st.skills.remove'))}</button>
      </div>`;
  }).join('');

  skillsList.querySelectorAll('button[data-skill-preview-id]').forEach((btn) => {
    btn.addEventListener('click', () => previewEnabledSkill(btn.dataset.skillPreviewId));
  });
  skillsList.querySelectorAll('button[data-skill-id]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const removedSkill = customSkills.find((skill) => skill.id === btn.dataset.skillId);
      await saveCustomSkills(
        customSkills.filter((skill) => skill.id !== btn.dataset.skillId),
        { removedSkill },
      );
      flashSkillsResult('ok', t('st.skills.removed'));
    });
  });
}

async function addCustomSkill(record, opts = {}) {
  if (customSkills.length >= MAX_CUSTOM_SKILLS) {
    throw new Error(t('st.skills.error.limit', { count: MAX_CUSTOM_SKILLS }));
  }
  const next = normalizeCustomSkills([...customSkills, record]);
  if (next.length <= customSkills.length) {
    throw new Error(t('st.skills.error.empty_content'));
  }
  await saveCustomSkills(next, opts);
}

async function addPackagedSkill(skillId, button) {
  const source = PACKAGED_SKILL_SOURCES.find((item) => item.id === skillId);
  if (!source || customSkills.some((skill) => skill.id === skillId)) return;
  if (button) button.disabled = true;
  try {
    const record = {
      id: source.id,
      name: source.name,
      sourceType: 'built-in',
      sourceUrl: source.path,
      content: await loadPackagedSkillContent(source),
      createdAt: Date.now(),
    };
    await addCustomSkill(record, { installedSkill: record });
    flashSkillsResult('ok', t('st.skills.added'));
  } catch (e) {
    if (button) button.disabled = false;
    flashSkillsResult('fail', e.message || t('st.skills.error.add_failed'));
  }
}

async function addSkillFromText() {
  const content = (skillTextArea?.value || '').trim();
  if (!content) {
    flashSkillsResult('fail', t('st.skills.error.empty_text'));
    return;
  }
  try {
    await addCustomSkill({
      id: makeSkillId(),
      name: skillNameInput?.value || '',
      sourceType: 'text',
      content,
      createdAt: Date.now(),
    });
    if (skillNameInput) skillNameInput.value = '';
    if (skillTextArea) skillTextArea.value = '';
    flashSkillsResult('ok', t('st.skills.added'));
  } catch (e) {
    flashSkillsResult('fail', e.message || t('st.skills.error.add_failed'));
  }
}

async function addSkillFromUrl() {
  let url;
  try {
    url = normalizeSkillUrl(skillUrlInput?.value);
  } catch (e) {
    flashSkillsResult('fail', e.message);
    return;
  }

  const previousText = btnAddSkillUrl?.textContent;
  if (btnAddSkillUrl) {
    btnAddSkillUrl.disabled = true;
    btnAddSkillUrl.textContent = t('st.skills.loading_url');
  }
  showSkillsResult('', t('st.skills.loading_url'), 'var(--text2)');

  try {
    const { response, url: finalUrl } = await fetchSkillImportResponse(url, {
      validateUrl: normalizeSkillUrl,
      redirectMessage: t('st.skills.error.url'),
    });
    if (!response.ok) throw new Error(t('st.skills.error.fetch', { status: response.status }));
    const content = extractSkillText(
      await readSkillImportText(response, {
        maxBytes: MAX_CUSTOM_SKILL_IMPORT_BYTES,
        tooLargeMessage: t('st.skills.error.too_large'),
      }),
      response.headers.get('content-type') || '',
    );
    if (!content) throw new Error(t('st.skills.error.empty_content'));
    await addCustomSkill({
      id: makeSkillId(),
      name: skillNameInput?.value || '',
      sourceType: 'url',
      sourceUrl: finalUrl,
      content,
      createdAt: Date.now(),
    });
    if (skillNameInput) skillNameInput.value = '';
    if (skillUrlInput) skillUrlInput.value = '';
    flashSkillsResult('ok', t('st.skills.added'));
  } catch (e) {
    flashSkillsResult('fail', e.message || t('st.skills.error.add_failed'));
  } finally {
    if (btnAddSkillUrl) {
      btnAddSkillUrl.disabled = false;
      btnAddSkillUrl.textContent = previousText || t('st.skills.add_url');
    }
  }
}

btnAddSkillText?.addEventListener('click', addSkillFromText);
btnAddSkillUrl?.addEventListener('click', addSkillFromUrl);
btnClearSkillForm?.addEventListener('click', () => {
  if (skillNameInput) skillNameInput.value = '';
  if (skillUrlInput) skillUrlInput.value = '';
  if (skillTextArea) skillTextArea.value = '';
  flashSkillsResult('ok', t('st.skills.form_cleared'));
});

if (globalThis.browser?.storage?.onChanged) {
  browser.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes[CUSTOM_SKILLS_STORAGE_KEY]) return;
    customSkills = normalizeCustomSkills(changes[CUSTOM_SKILLS_STORAGE_KEY].newValue);
    renderSkills();
  });
}

// --- Display Settings ---

downloadDirectoryInput?.addEventListener('input', () => {
  downloadDirectoryInput.setCustomValidity('');
});

downloadDirectoryInput?.addEventListener('change', async () => {
  const raw = String(downloadDirectoryInput.value || '').trim();
  const directory = normalizeDownloadDirectory(raw);
  if (raw && !directory) {
    downloadDirectoryInput.setCustomValidity(t('st.display.download_directory.error'));
    downloadDirectoryInput.reportValidity();
    return;
  }
  downloadDirectoryInput.setCustomValidity('');
  downloadDirectoryInput.value = directory;
  await browser.storage.local.set({ [DOWNLOAD_DIRECTORY_STORAGE_KEY]: directory }).catch(() => {});
});

verboseToggle.addEventListener('change', async () => {
  await browser.storage.local.set({ verboseMode: verboseToggle.checked }).catch(() => {});
});

selectionShortcutToggle?.addEventListener('change', async () => {
  await browser.storage.local.set({ selectionShortcutEnabled: selectionShortcutToggle.checked }).catch(() => {});
});

helpImproveToggle?.addEventListener('change', async () => {
  await browser.storage.local.set({ helpImproveWebBrain: helpImproveToggle.checked }).catch(() => {});
});

screenshotToggle.addEventListener('change', async () => {
  await browser.storage.local.set({ screenshotFallback: screenshotToggle.checked }).catch(() => {});
});

maxStepsRange.addEventListener('input', () => {
  stepsValueLabel.textContent = Number(maxStepsRange.value) === MAX_AGENT_STEPS_UNLIMITED_SENTINEL ? '∞' : maxStepsRange.value;
});

maxStepsRange.addEventListener('change', async () => {
  await browser.storage.local.set({
    maxAgentSteps: Number(maxStepsRange.value) === MAX_AGENT_STEPS_UNLIMITED_SENTINEL
      ? 0
      : parseInt(maxStepsRange.value, 10),
  }).catch(() => {});
});

if (requestTimeoutRange) {
  requestTimeoutRange.addEventListener('input', () => {
    requestTimeoutValueLabel.textContent = requestTimeoutRange.value + 's';
  });
  requestTimeoutRange.addEventListener('change', async () => {
    const sec = parseInt(requestTimeoutRange.value, 10);
    await browser.storage.local.set({ requestTimeoutMs: sec * 1000 }).catch(() => {});
  });
}

function formatClarifyTimeoutLabel(sec) {
  if (sec === 0) {
    return (typeof t === 'function' ? t('st.display.clarify_timeout.instant') : null) || 'Instant';
  }
  if (sec > 1200) {
    return (typeof t === 'function' ? t('st.display.clarify_timeout.off') : null) || 'Off';
  }
  return `${sec}s`;
}

if (clarifyTimeoutRange) {
  clarifyTimeoutRange.addEventListener('input', () => {
    if (clarifyTimeoutValueLabel) {
      clarifyTimeoutValueLabel.textContent = formatClarifyTimeoutLabel(parseInt(clarifyTimeoutRange.value, 10) || 0);
    }
  });
  clarifyTimeoutRange.addEventListener('change', async () => {
    const sec = Math.max(0, Math.min(1205, parseInt(clarifyTimeoutRange.value, 10) || 0));
    await browser.storage.local.set({ clarifyTimeoutSec: sec, clarifyTimeoutSemanticsV2: true }).catch(() => {});
  });
}

autoScreenshotSelect?.addEventListener('change', async () => {
  await browser.storage.local.set({ autoScreenshot: autoScreenshotSelect.value }).catch(() => {});
});

siteAdaptersToggle?.addEventListener('change', async () => {
  await browser.storage.local.set({ useSiteAdapters: siteAdaptersToggle.checked }).catch(() => {});
});

voiceInputToggle?.addEventListener('change', async () => {
  await browser.storage.local.set({ voiceInputEnabled: voiceInputToggle.checked }).catch(() => {});
});

apiMutationObserverToggle?.addEventListener('change', async () => {
  await browser.storage.local.set({ apiMutationObserverEnabled: apiMutationObserverToggle.checked }).catch(() => {});
});

if (planBeforeActModeSelect) {
  planBeforeActModeSelect.addEventListener('change', async () => {
    const mode = PLAN_BEFORE_ACT_MODES.has(planBeforeActModeSelect.value) ? planBeforeActModeSelect.value : 'off';
    await browser.storage.local.set({
      planBeforeActMode: mode,
      planBeforeAct: mode !== 'off',
    }).catch(() => {});
  });
}

if (planReviewModeSelect) {
  planReviewModeSelect.addEventListener('change', async () => {
    const mode = PLAN_REVIEW_MODES.has(planReviewModeSelect.value) ? planReviewModeSelect.value : 'confidence';
    updatePlanReviewConfidenceUI();
    await browser.storage.local.set({ planReviewMode: mode }).catch(() => {});
  });
}

if (planReviewConfidenceRange) {
  planReviewConfidenceRange.addEventListener('input', updatePlanReviewConfidenceUI);
  planReviewConfidenceRange.addEventListener('change', async () => {
    const threshold = normalizePlanReviewConfidenceThreshold({
      planReviewConfidenceThreshold: planReviewConfidenceRange.value,
    });
    planReviewConfidenceRange.value = threshold;
    updatePlanReviewConfidenceUI();
    await browser.storage.local.set({ planReviewConfidenceThreshold: threshold }).catch(() => {});
  });
}

notifySoundToggle?.addEventListener('change', async () => {
  await browser.storage.local.set({ notifySound: notifySoundToggle.checked }).catch(() => {});
});

completionConfettiToggle?.addEventListener('change', async () => {
  await browser.storage.local.set({ completionConfetti: completionConfettiToggle.checked }).catch(() => {});
});

tracingToggle?.addEventListener('change', async () => {
  await browser.storage.local.set({ tracingEnabled: tracingToggle.checked }).catch(() => {});
});

costSessionLimitInput?.addEventListener('change', async () => {
  const value = normalizeCostAmount(costSessionLimitInput.value);
  costSessionLimitInput.value = value.toFixed(2);
  await browser.storage.local.set({ costAllowanceSessionUsd: value }).catch(() => {});
});

costTotalLimitInput?.addEventListener('change', async () => {
  const value = normalizeCostAmount(costTotalLimitInput.value);
  costTotalLimitInput.value = value.toFixed(2);
  const stored = await browser.storage.local.get(['cloudCostSpentUsd']);
  renderCostAllowanceSpent(normalizeCostAmount(stored.cloudCostSpentUsd, 0), value);
  await browser.storage.local.set({ costAllowanceTotalUsd: value }).catch(() => {});
});

btnResetCostSpend?.addEventListener('click', async () => {
  await browser.storage.local.set({ cloudCostSpentUsd: 0 });
  renderCostAllowanceSpent(0, normalizeCostAmount(costTotalLimitInput?.value));
});

strictSecretToggle?.addEventListener('change', async () => {
  await browser.storage.local.set({ strictSecretMode: strictSecretToggle.checked }).catch(() => {});
});

allowLocalNetworkToggle?.addEventListener('change', async () => {
  await browser.storage.local.set({ agentAllowLocalNetwork: allowLocalNetworkToggle.checked }).catch(() => {});
});

scheduledTasksToggle?.addEventListener('change', async () => {
  await browser.storage.local.set({ scheduledTasksEnabled: scheduledTasksToggle.checked }).catch(() => {});
});

scheduledConfirmToggle?.addEventListener('change', async () => {
  await browser.storage.local.set({ scheduledRequireConsequentialConfirmation: scheduledConfirmToggle.checked }).catch(() => {});
});

// --- Vision Model ---

function updateMultimodalDetectedProvider(kind) {
  const baseInput = kind === 'vision' ? visionBaseUrlInput : transcriptionBaseUrlInput;
  const hint = document.getElementById(`${kind}-detected`);
  const icon = document.getElementById(`${kind}-detected-icon`);
  const label = document.getElementById(`${kind}-detected-label`);
  if (!baseInput || !hint || !icon || !label) return;
  const id = sniffProviderIdFromBaseUrl(baseInput.value);
  const src = providerIconUrl(id);
  if (!id || !src) {
    hint.hidden = true;
    icon.removeAttribute('src');
    label.textContent = '';
    return;
  }
  icon.src = src;
  label.textContent = PROVIDER_SHORT_LABELS[id] || id;
  hint.hidden = false;
}

function showVisionResult(className, text, color = '') {
  visionTestResult.className = `test-result show${className ? ` ${className}` : ''}`;
  visionTestResult.textContent = text;
  visionTestResult.style.color = color || '';
  return visionTestResult;
}

function flashVisionResult(className, text) {
  const resultEl = showVisionResult(className, text);
  setTimeout(() => resultEl.classList.remove('show'), 2000);
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
    const resultEl = showVisionResult('fail', t('st.vision.fill_required'));
    setTimeout(() => resultEl.classList.remove('show'), 2500);
    return;
  }

  await browser.storage.local.set({
    visionModel: { baseUrl, apiKey, model },
  });

  showVisionResult('', t('st.vision.testing'), 'var(--text2)');

  try {
    const res = await sendToBackground('test_vision_provider');
    if (res?.ok) {
      showVisionResult('ok', t('st.vision.connected', { model: res.model || model }));
    } else {
      showVisionResult('fail', t('st.vision.failed', { error: res?.error || 'Unknown error' }));
    }
  } catch (e) {
    showVisionResult('fail', t('st.vision.failed', { error: e.message }));
  }
});

btnClearVision.addEventListener('click', async () => {
  visionBaseUrlInput.value = '';
  visionApiKeyInput.value = '';
  visionModelInput.value = '';
  updateMultimodalDetectedProvider('vision');
  await browser.storage.local.remove('visionModel');
  flashVisionResult('ok', t('st.vision.cleared'));
});

visionBaseUrlInput?.addEventListener('input', () => updateMultimodalDetectedProvider('vision'));

// --- Transcription Service (Whisper-compatible) ---
//
// Same UX as the vision override. Stored in browser.storage.local under
// `transcriptionModel = { baseUrl, apiKey, model }`. Consumed by
// transcribe.js, which uses the override when all three fields are
// filled, and falls back to the auto-pick-from-providers behavior when
// any field is empty.

function showTranscriptionResult(className, text, color = '') {
  if (!transcriptionTestResult) return;
  transcriptionTestResult.className = `test-result show${className ? ` ${className}` : ''}`;
  transcriptionTestResult.textContent = text;
  transcriptionTestResult.style.color = color || '';
  return transcriptionTestResult;
}

function flashTranscriptionResult(className, text) {
  const resultEl = showTranscriptionResult(className, text);
  if (resultEl) setTimeout(() => resultEl.classList.remove('show'), 2000);
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
      const resultEl = showTranscriptionResult('fail', t('st.transcription.fill_required'));
      if (resultEl) setTimeout(() => resultEl.classList.remove('show'), 2500);
      return;
    }

    await browser.storage.local.set({
      transcriptionModel: { baseUrl, apiKey, model },
    });

    showTranscriptionResult('', t('st.transcription.testing'), 'var(--text2)');

    try {
      const res = await sendToBackground('test_transcription_provider');
      if (res?.ok) {
        showTranscriptionResult('ok', t('st.transcription.connected', { model: res.model || model }));
      } else {
        showTranscriptionResult('fail', t('st.transcription.failed', { error: res?.error || 'Unknown error' }));
      }
    } catch (e) {
      showTranscriptionResult('fail', t('st.transcription.failed', { error: e.message }));
    }
  });
}

if (btnClearTranscription) {
  btnClearTranscription.addEventListener('click', async () => {
    transcriptionBaseUrlInput.value = '';
    transcriptionApiKeyInput.value = '';
    transcriptionModelInput.value = '';
    updateMultimodalDetectedProvider('transcription');
    await browser.storage.local.remove('transcriptionModel');
    flashTranscriptionResult('ok', t('st.transcription.cleared'));
  });
}

transcriptionBaseUrlInput?.addEventListener('input', () => updateMultimodalDetectedProvider('transcription'));

// --- Profile auto-fill ---
let profileSyncChallenge = null;
function showProfileSyncResult(ok, text) { if (!profileSyncResult) return; profileSyncResult.className = `test-result show ${ok ? 'ok' : 'fail'}`; profileSyncResult.textContent = text; }
function setProfileSyncVisible(el, visible) { if (el) el.hidden = !visible; }
function describeProfileSyncState(state) {
  if (state.status === 'syncing') return 'Encrypted sync is updating...';
  if (state.status === 'offline') return 'Encrypted sync is waiting for a connection.';
  if (state.status === 'subscription') return 'WebBrain Cloud membership is required for encrypted sync.';
  if (state.status === 'error') return state.error || 'Encrypted sync needs attention.';
  if (!state.authenticated) return 'Sign in with your WebBrain Cloud email to use encrypted sync.';
  if (!state.enabled || state.status === 'empty') return 'Signed in. Choose a sync password to turn on encrypted sync.';
  if (state.unlocked) return 'Encrypted sync is on for this device.';
  return 'Encrypted sync is locked. Enter your sync password to unlock it on this device.';
}
function renderProfileSyncState(state) {
  const authenticated = !!state.authenticated;
  const enabled = state.enabled === true && state.status !== 'empty';
  const unlocked = !!state.unlocked;
  setProfileSyncVisible(profileSyncEmailField, !authenticated);
  setProfileSyncVisible(profileSyncPasswordField, authenticated && !unlocked);
  setProfileSyncVisible(profileSyncConfirmField, authenticated && !enabled);
  setProfileSyncVisible(btnProfileSyncAuth, !authenticated);
  setProfileSyncVisible(btnProfileSyncEnable, authenticated && !enabled);
  setProfileSyncVisible(btnProfileSyncUnlock, authenticated && enabled && !unlocked);
  setProfileSyncVisible(btnProfileSyncNow, authenticated && enabled && unlocked);
  setProfileSyncVisible(profileSyncAdvanced, authenticated && enabled && unlocked);
  if (profileSyncPassword) profileSyncPassword.autocomplete = enabled ? 'current-password' : 'new-password';
  if (profileSyncPasswordField?.hidden && profileSyncPassword) profileSyncPassword.value = '';
  if (profileSyncConfirmField?.hidden && profileSyncConfirm) profileSyncConfirm.value = '';
  if (profileSyncStatus) profileSyncStatus.textContent = describeProfileSyncState(state || {});
}
async function refreshProfileSyncState() { const state = await sendToBackground('profile_sync_state').catch(e => ({ status: 'error', error: e.message })); renderProfileSyncState(state); return state; }
async function reloadProfileSyncData() { const stored = await browser.storage.local.get(['profileEnabled', 'profileText', 'visionModel', 'transcriptionModel']); if (profileEnabledToggle) profileEnabledToggle.checked = !!stored.profileEnabled; if (profileTextArea) profileTextArea.value = stored.profileText || ''; const vision = stored.visionModel || {}; visionBaseUrlInput.value = vision.baseUrl || ''; visionApiKeyInput.value = vision.apiKey || ''; visionModelInput.value = vision.model || ''; const transcription = stored.transcriptionModel || {}; if (transcriptionBaseUrlInput) transcriptionBaseUrlInput.value = transcription.baseUrl || ''; if (transcriptionApiKeyInput) transcriptionApiKeyInput.value = transcription.apiKey || ''; if (transcriptionModelInput) transcriptionModelInput.value = transcription.model || ''; updateMultimodalDetectedProvider('vision'); updateMultimodalDetectedProvider('transcription'); await loadUserMemorySettings(); const res = await sendToBackground('get_providers'); providersData = res.providers; activeProviderId = res.active; renderProviders(); }
async function requestProfileSyncDataConsent() { const permissions = await browser.permissions.getAll(); if (!Object.hasOwn(permissions, 'data_collection')) return window.confirm('Turn on encrypted sync? WebBrain will transmit an end-to-end encrypted copy of your memories, profile autofill, and API-key provider settings to WebBrain Cloud. Chat history and OAuth sign-ins are not synced.'); return browser.permissions.request({ data_collection: ['personallyIdentifyingInfo', 'authenticationInfo', 'personalCommunications', 'websiteContent', 'technicalAndInteraction'] }); }
function profileSyncButtonRestore(button, pendingLabel) {
  if (!button) return () => {};
  const previousDisabled = button.disabled;
  const previousText = button.textContent;
  button.disabled = true;
  if (pendingLabel) button.textContent = pendingLabel;
  return () => { button.disabled = previousDisabled; button.textContent = previousText; };
}
async function profileSyncAction(action, data = {}, options = {}) {
  const restoreButton = profileSyncButtonRestore(options.button, options.pendingLabel);
  try {
    if (options.pending) showProfileSyncResult(true, options.pending);
    const result = await sendToBackground(action, data);
    if (['profile_sync_unlock', 'profile_sync_now', 'profile_sync_reset'].includes(action)) await reloadProfileSyncData();
    showProfileSyncResult(true, options.success || 'Encrypted sync updated.');
    await refreshProfileSyncState();
    return result;
  } catch (error) {
    showProfileSyncResult(false, error?.message || 'Encrypted sync failed.');
    throw error;
  } finally {
    restoreButton();
  }
}
function checkedSyncPassword(requireConfirmation = false) { const password = profileSyncPassword?.value || ''; const confirmation = profileSyncConfirm?.value || ''; if (password.length < 12) throw new Error('Use a sync password of at least 12 characters.'); if (requireConfirmation && !confirmation) throw new Error('Confirm the new sync password.'); if (confirmation && password !== confirmation) throw new Error('Sync passwords do not match.'); return password; }
function promptConfirmedSyncPassword(label = 'New sync password') { const password = window.prompt(`${label} (12+ characters):`); if (!password) return null; if (password.length < 12) throw new Error('Use a sync password of at least 12 characters.'); const confirmation = window.prompt('Confirm sync password:'); if (!confirmation) throw new Error('Confirm the sync password.'); if (password !== confirmation) throw new Error('Sync passwords do not match.'); return password; }
btnProfileSyncAuth?.addEventListener('click', async () => { const email = (profileSyncEmail?.value || '').trim(); if (!email) return showProfileSyncResult(false, 'Enter your WebBrain Cloud billing email.'); try { profileSyncChallenge = await profileSyncAction('profile_sync_auth_start', { email }); showProfileSyncResult(true, 'Check your email, approve the WebBrain Cloud sign-in link, then return here.'); const poll = setInterval(async () => { if (!profileSyncChallenge) return clearInterval(poll); try { const result = await sendToBackground('profile_sync_auth_status', { challengeId: profileSyncChallenge.challenge_id, verifier: profileSyncChallenge.verifier }); if (result.token) { clearInterval(poll); profileSyncChallenge = null; showProfileSyncResult(true, 'Cloud Sync authenticated. Set a password and enable sync.'); await refreshProfileSyncState(); } } catch (error) { clearInterval(poll); profileSyncChallenge = null; showProfileSyncResult(false, error.message); } }, 3000); setTimeout(() => clearInterval(poll), 30 * 60 * 1000); } catch { } });
btnProfileSyncEnable?.addEventListener('click', async () => { try { const password = checkedSyncPassword(true); if (!await requestProfileSyncDataConsent()) throw new Error('Encrypted sync permission was not granted.'); await profileSyncAction('profile_sync_unlock', { password, create: true }); } catch (e) { showProfileSyncResult(false, e.message); } });
btnProfileSyncUnlock?.addEventListener('click', async () => { try { const password = checkedSyncPassword(); if (!await requestProfileSyncDataConsent()) throw new Error('Encrypted sync permission was not granted.'); await profileSyncAction('profile_sync_unlock', { password, create: false }); } catch (e) { showProfileSyncResult(false, e.message); } });
btnProfileSyncNow?.addEventListener('click', () => profileSyncAction('profile_sync_now', {}, { button: btnProfileSyncNow, pending: 'Syncing encrypted cloud copy...', pendingLabel: 'Syncing...', success: 'Encrypted sync is up to date.' }).catch(() => {}));
btnProfileSyncLock?.addEventListener('click', () => profileSyncAction('profile_sync_lock'));
btnProfileSyncChange?.addEventListener('click', () => { const oldPassword = window.prompt('Current sync password:'); if (!oldPassword) return; try { const newPassword = promptConfirmedSyncPassword('New sync password'); if (newPassword) profileSyncAction('profile_sync_change_password', { oldPassword, newPassword }); } catch (e) { showProfileSyncResult(false, e.message); } });
btnProfileSyncDisable?.addEventListener('click', () => { if (window.confirm('Turn off encrypted sync on this device? Local data will remain.')) profileSyncAction('profile_sync_disable'); });
btnProfileSyncReset?.addEventListener('click', () => { if (!window.confirm('Replace the encrypted cloud copy with this device’s current WebBrain setup?')) return; try { const password = promptConfirmedSyncPassword('Sync password for the replacement cloud copy'); if (password) profileSyncAction('profile_sync_reset', { password }); } catch (e) { showProfileSyncResult(false, e.message); } });
refreshProfileSyncState();

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
  profileEnabledToggle.addEventListener('change', async () => {
    await browser.storage.local.set({ profileEnabled: profileEnabledToggle.checked }).catch(() => {});
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

function flashUserMemoryResult(className, text) {
  if (!userMemoryTestResult) return;
  userMemoryTestResult.className = `test-result show ${className}`;
  userMemoryTestResult.textContent = text;
  setTimeout(() => userMemoryTestResult.classList.remove('show'), 2500);
}

const USER_MEMORY_FAILURE_REASON_KEYS = {
  invalid_or_sensitive: 'st.memory.reason.invalid_or_sensitive',
  not_found: 'st.memory.reason.not_found',
};

function userMemoryFailureText(res) {
  const reasonKey = USER_MEMORY_FAILURE_REASON_KEYS[res?.reason];
  if (reasonKey) return t(reasonKey);
  return t('st.memory.failed', { error: res?.reason || res?.error || 'unknown error' });
}

function renderUserMemoryRecords(records = []) {
  if (!userMemoryList) return;
  const active = records.filter((record) => record && !record.archivedAt && record.text);
  if (!active.length) {
    userMemoryList.innerHTML = `<div style="font-size:12px;color:var(--text2);">${escapeHtml(t('st.memory.empty'))}</div>`;
    return;
  }
  userMemoryList.innerHTML = active.map((record) => `
    <div data-memory-id="${escapeHtml(record.id)}" style="background:var(--bg3);border:1px solid var(--border);border-radius:6px;margin:0;padding:12px;">
      <div style="display:flex;gap:8px;align-items:center;margin-bottom:8px;flex-wrap:wrap;">
        <code style="font-size:11px;color:var(--text2);">${escapeHtml(record.id)}</code>
        <select class="user-memory-kind" style="background:var(--bg);color:var(--text);border:1px solid var(--border);border-radius:6px;padding:4px 8px;">
          ${['preference', 'profile_hint', 'workflow_preference'].map((kind) => `<option value="${kind}"${record.kind === kind ? ' selected' : ''}>${kind}</option>`).join('')}
        </select>
      </div>
      <textarea class="user-memory-text" rows="3" style="width:100%;background:var(--bg);border:1px solid var(--border);border-radius:6px;color:var(--text);padding:8px 10px;font:inherit;font-size:13px;line-height:1.45;resize:vertical;">${escapeHtml(record.text)}</textarea>
      <div class="btn-row" style="margin-top:8px;">
        <button class="btn-primary btn-save-user-memory" data-memory-id="${escapeHtml(record.id)}" data-i18n="st.memory.save">${escapeHtml(t('st.memory.save'))}</button>
        <button class="btn-secondary btn-delete-user-memory" data-memory-id="${escapeHtml(record.id)}" data-i18n="st.memory.delete">${escapeHtml(t('st.memory.delete'))}</button>
      </div>
    </div>
  `).join('');
  userMemoryList.querySelectorAll('.btn-save-user-memory').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const card = btn.closest('[data-memory-id]');
      const id = btn.dataset.memoryId;
      const text = card?.querySelector('.user-memory-text')?.value || '';
      const kind = card?.querySelector('.user-memory-kind')?.value || 'preference';
      const res = await sendToBackground('update_user_memory', { id, text, kind });
      if (!res?.ok) {
        flashUserMemoryResult('error', userMemoryFailureText(res));
        return;
      }
      flashUserMemoryResult('ok', t('st.memory.saved'));
      await loadUserMemorySettings();
    });
  });
  userMemoryList.querySelectorAll('.btn-delete-user-memory').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const res = await sendToBackground('delete_user_memory', { id: btn.dataset.memoryId });
      if (!res?.ok) {
        flashUserMemoryResult('error', userMemoryFailureText(res));
        return;
      }
      flashUserMemoryResult('ok', t('st.memory.deleted'));
      await loadUserMemorySettings();
    });
  });
}

async function loadUserMemorySettings() {
  const res = await sendToBackground('get_user_memory').catch((error) => ({ ok: false, error: error.message }));
  if (!res?.ok) {
    renderUserMemoryRecords([]);
    flashUserMemoryResult('error', t('st.memory.failed', { error: res?.error || 'unknown error' }));
    return;
  }
  if (userMemoryEnabledToggle) userMemoryEnabledToggle.checked = res.enabled !== false;
  if (userMemoryAutoToggle) userMemoryAutoToggle.checked = res.autoCaptureEnabled === true;
  if (userMemoryFormToggle) userMemoryFormToggle.checked = res.formCaptureEnabled === true;
  if (userMemoryMaxCharsInput) userMemoryMaxCharsInput.value = String(res.maxPromptChars ?? USER_MEMORY_DEFAULT_MAX_PROMPT_CHARS);
  renderUserMemoryRecords(res.records || []);
}

if (userMemoryEnabledToggle) {
  userMemoryEnabledToggle.addEventListener('change', async () => {
    await browser.storage.local.set({ [USER_MEMORY_ENABLED_KEY]: userMemoryEnabledToggle.checked }).catch(() => {});
  });
}

if (userMemoryAutoToggle) {
  userMemoryAutoToggle.addEventListener('change', async () => {
    await browser.storage.local.set({ [USER_MEMORY_AUTO_CAPTURE_KEY]: userMemoryAutoToggle.checked }).catch(() => {});
  });
}

if (userMemoryFormToggle) {
  userMemoryFormToggle.addEventListener('change', async () => {
    await browser.storage.local.set({ [USER_MEMORY_FORM_CAPTURE_KEY]: userMemoryFormToggle.checked }).catch(() => {});
  });
}

if (userMemoryMaxCharsInput) {
  userMemoryMaxCharsInput.addEventListener('change', async () => {
    const rawMaxPromptChars = String(userMemoryMaxCharsInput.value || '').trim();
    const value = rawMaxPromptChars === ''
      ? USER_MEMORY_DEFAULT_MAX_PROMPT_CHARS
      : normalizeUserMemoryMaxPromptChars(rawMaxPromptChars);
    userMemoryMaxCharsInput.value = String(value);
    await browser.storage.local.set({ [USER_MEMORY_MAX_PROMPT_CHARS_KEY]: value }).catch(() => {});
  });
}

if (btnRefreshUserMemory) {
  btnRefreshUserMemory.addEventListener('click', loadUserMemorySettings);
}

if (btnClearUserMemory) {
  btnClearUserMemory.addEventListener('click', async () => {
    if (!window.confirm(t('st.memory.clear_confirm'))) return;
    const res = await sendToBackground('clear_user_memory');
    if (!res?.ok) {
      flashUserMemoryResult('error', t('st.memory.failed', { error: res?.error || 'unknown error' }));
      return;
    }
    flashUserMemoryResult('ok', t('st.memory.cleared'));
    await loadUserMemorySettings();
  });
}

if (btnExportUserMemory) {
  btnExportUserMemory.addEventListener('click', async () => {
    const res = await sendToBackground('export_user_memory');
    if (!res?.ok) {
      flashUserMemoryResult('error', t('st.memory.failed', { error: res?.error || 'unknown error' }));
      return;
    }
    const blob = new Blob([res.json || JSON.stringify(res.store || {}, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `webbrain-user-memory-${Date.now()}.json`;
    document.body.appendChild(a);
    try { a.click(); } finally {
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 7000);
    }
    flashUserMemoryResult('ok', t('st.memory.exported'));
  });
}

if (btnImportUserMemory) {
  btnImportUserMemory.addEventListener('click', async () => {
    const json = userMemoryImportText?.value || '';
    if (!json.trim()) {
      flashUserMemoryResult('error', t('st.memory.import_empty'));
      return;
    }
    let res;
    try {
      res = await sendToBackground('import_user_memory', { json });
    } catch (error) {
      flashUserMemoryResult('error', t('st.memory.failed', { error: error?.message || 'invalid JSON' }));
      return;
    }
    if (!res?.ok) {
      flashUserMemoryResult('error', t('st.memory.failed', { error: res?.error || 'invalid JSON' }));
      return;
    }
    if (userMemoryImportText) userMemoryImportText.value = '';
    flashUserMemoryResult('ok', t('st.memory.imported'));
    await loadUserMemorySettings();
  });
}

// --- CapSolver (captcha solving) ---
// Toggle persists immediately. The API key needs an explicit Save.

function showCaptchaResult(className, text, color = '') {
  if (!captchaTestResult) return;
  captchaTestResult.className = `test-result show${className ? ` ${className}` : ''}`;
  captchaTestResult.textContent = text;
  captchaTestResult.style.color = color || '';
  return captchaTestResult;
}

function flashCaptchaResult(className, text) {
  const resultEl = showCaptchaResult(className, text);
  if (resultEl) setTimeout(() => resultEl.classList.remove('show'), 3000);
}

if (captchaEnabledToggle) {
  captchaEnabledToggle.addEventListener('change', async () => {
    await browser.storage.local.set({ captchaSolverEnabled: captchaEnabledToggle.checked }).catch(() => {});
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
    showCaptchaResult('', t('st.captcha.checking'), 'var(--text2)');
    try {
      const res = await sendToBackground('test_capsolver_balance', { apiKey: key });
      if (res?.ok) {
        flashCaptchaResult('ok', t('st.captcha.balance_ok', { balance: `$${Number(res.balance).toFixed(4)}` }));
      } else {
        flashCaptchaResult('fail', t('st.captcha.balance_fail', { error: res?.error || 'Unknown error' }));
      }
    } catch (e) {
      flashCaptchaResult('fail', t('st.captcha.balance_fail', { error: e.message }));
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
const MIN_API_KEY_LENGTH = 12;

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

function setProviderConfigValue(config, path, value) {
  const keys = String(path || '').split('.').filter(Boolean);
  if (!keys.length) return;
  let target = config;
  for (const key of keys.slice(0, -1)) {
    if (!target[key] || typeof target[key] !== 'object' || Array.isArray(target[key])) target[key] = {};
    target = target[key];
  }
  target[keys.at(-1)] = value;
}

function providerApiKeyWarning(id, config) {
  const input = document.querySelector(`input[data-provider="${id}"][data-key="apiKey"]`);
  if (!input) return '';
  const apiKey = String(config.apiKey || '').trim();
  const keyIsOptional = providersData[id]?.category === 'local';
  const looksInvalid = apiKey ? apiKey.length < MIN_API_KEY_LENGTH : !keyIsOptional;
  input.setAttribute('aria-invalid', looksInvalid ? 'true' : 'false');
  return looksInvalid ? t('st.providers.api_key_warning') : '';
}

function restoreProviderApiKeyWarnings() {
  for (const [id, config] of Object.entries(providersData)) {
    if (config?.configured !== true) continue;
    const warning = providerApiKeyWarning(id, config);
    if (warning) setProviderTestResult(id, 'warn', warning);
  }
}

function supportsProviderCompatibilitySettings(id, config = {}) {
  return id !== 'webbrain_cloud' && ['openai', 'llamacpp', 'azure_openai'].includes(config.type);
}

function providerExtraBodyText(value) {
  if (typeof value === 'string') return value;
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length === 0) return '';
  try { return JSON.stringify(value, null, 2); } catch { return ''; }
}

function prettyCompatibilityValue(value) {
  const key = `st.providers.compat.value.${value}`;
  const translated = t(key);
  return translated === key ? (value || '') : translated;
}

function automaticTokenField(config) {
  if (shouldUseOpenAIResponsesApi(config)) return 'max_output_tokens';
  const model = String(config.model || '').toLowerCase();
  const isNewOfficialContract = config.type === 'openai'
    && config.category !== 'local'
    && config.providerName !== 'lmstudio'
    && /^(gpt-5|gpt-4\.1|o1|o3|o4)/.test(model);
  return isNewOfficialContract ? 'max_completion_tokens' : 'max_tokens';
}

function compatibilitySummary(config) {
  const compat = normalizeProviderCompatibility(config);
  const detected = detectedCompatibilityPreset(config);
  const preset = compat.preset === 'auto'
    ? t('st.providers.compat.auto_detected', { preset: prettyCompatibilityValue(detected) })
    : prettyCompatibilityValue(compat.preset);
  const reasoning = compat.reasoningEffort === 'auto'
    ? t('st.providers.compat.provider_default')
    : prettyCompatibilityValue(compat.reasoningEffort);
  const role = compat.systemPromptRole === 'auto'
    ? prettyCompatibilityValue('system')
    : prettyCompatibilityValue(compat.systemPromptRole);
  const tokens = compat.maxTokensField === 'auto' ? automaticTokenField(config) : compat.maxTokensField;
  const extraCount = config.extraBody && typeof config.extraBody === 'object' && !Array.isArray(config.extraBody)
    ? Object.keys(config.extraBody).length
    : 0;
  const extra = extraCount
    ? t(extraCount === 1 ? 'st.providers.compat.summary_extra' : 'st.providers.compat.summary_extra_plural', { count: extraCount })
    : '';
  return t('st.providers.compat.summary', { preset, reasoning, role, tokens, extra });
}

function currentProviderCompatibilityConfig(id) {
  const source = providersData[id] || {};
  const config = { ...source, compat: { ...(source.compat || {}) } };
  document.querySelectorAll(`.provider-compatibility [data-provider="${id}"]`).forEach((input) => {
    if (input.dataset.type === 'json') {
      try { config.extraBody = parseProviderExtraBodyJson(input.value); } catch { config.extraBody = {}; }
      return;
    }
    setProviderConfigValue(config, input.dataset.key, providerInputValue(input));
  });
  const modelInput = document.querySelector(`input[data-provider="${id}"][data-key="model"]`);
  const baseUrlInput = document.querySelector(`input[data-provider="${id}"][data-key="baseUrl"]`);
  if (modelInput) config.model = modelInput.value;
  if (baseUrlInput) config.baseUrl = baseUrlInput.value;
  return config;
}

function refreshProviderCompatibilitySummary(id) {
  const details = document.querySelector(`.provider-compatibility[data-provider-id="${id}"]`);
  if (!details) return;
  const textarea = details.querySelector('textarea[data-type="json"]');
  const validation = details.querySelector('.provider-compatibility-validation');
  let error = '';
  if (textarea) {
    try { parseProviderExtraBodyJson(textarea.value); } catch (e) { error = e.message; }
    textarea.setAttribute('aria-invalid', error ? 'true' : 'false');
  }
  if (validation) validation.textContent = error;
  const summary = details.querySelector('.provider-compatibility-summary');
  if (summary) summary.textContent = compatibilitySummary(currentProviderCompatibilityConfig(id));
}

function renderProviderCompatibilitySettings(id, config) {
  if (!supportsProviderCompatibilitySettings(id, config)) return '';
  const compat = normalizeProviderCompatibility(config);
  const extraBody = providerCompatibilityJsonDrafts.has(id)
    ? providerCompatibilityJsonDrafts.get(id)
    : providerExtraBodyText(config.extraBody);
  const options = (items, current) => items.map(([value, label]) => (
    `<option value="${value}"${value === current ? ' selected' : ''}>${escapeHtml(label)}</option>`
  )).join('');
  const valueLabel = (value) => prettyCompatibilityValue(value);
  return `
    <details class="provider-compatibility" data-provider-id="${id}">
      <summary>
        <span class="provider-compatibility-title">${escapeHtml(t('st.providers.compat.title'))}</span>
        <span class="provider-compatibility-summary">${escapeHtml(compatibilitySummary(config))}</span>
      </summary>
      <div class="provider-compatibility-body">
        <p>${escapeHtml(t('st.providers.compat.blurb'))}</p>
        <div class="provider-compatibility-grid">
          <div class="field">
            <label>${escapeHtml(t('st.providers.compat.preset'))}</label>
            <select data-provider="${id}" data-key="compat.preset" data-type="select">
              ${options([['auto', valueLabel('auto')], ['openai', valueLabel('openai')], ['qwen', valueLabel('qwen')], ['deepseek', valueLabel('deepseek')], ['openrouter', valueLabel('openrouter')], ['custom', valueLabel('custom')]], compat.preset)}
            </select>
          </div>
          <div class="field">
            <label>${escapeHtml(t('st.providers.compat.reasoning'))}</label>
            <select data-provider="${id}" data-key="compat.reasoningEffort" data-type="select">
              ${options([['auto', valueLabel('auto')], ['off', valueLabel('off')], ['minimal', valueLabel('minimal')], ['low', valueLabel('low')], ['medium', valueLabel('medium')], ['high', valueLabel('high')], ['xhigh', valueLabel('xhigh')], ['max', valueLabel('max')]], compat.reasoningEffort)}
            </select>
          </div>
          <div class="field">
            <label>${escapeHtml(t('st.providers.compat.system_role'))}</label>
            <select data-provider="${id}" data-key="compat.systemPromptRole" data-type="select">
              ${options([['auto', valueLabel('auto')], ['system', valueLabel('system')], ['developer', valueLabel('developer')]], compat.systemPromptRole)}
            </select>
          </div>
          <div class="field">
            <label>${escapeHtml(t('st.providers.compat.token_field'))}</label>
            <select data-provider="${id}" data-key="compat.maxTokensField" data-type="select">
              ${options([['auto', valueLabel('auto')], ['max_tokens', 'max_tokens'], ['max_completion_tokens', 'max_completion_tokens']], compat.maxTokensField)}
            </select>
          </div>
        </div>
        <div class="field provider-compatibility-json">
          <label>${escapeHtml(t('st.providers.compat.extra_body'))}</label>
          <textarea data-provider="${id}" data-key="extraBody" data-type="json" spellcheck="false"
                    aria-invalid="false" placeholder="${escapeHtml(t('st.providers.compat.extra_body_placeholder'))}">${escapeHtml(extraBody)}</textarea>
          <div class="provider-compatibility-help">${escapeHtml(t('st.providers.compat.extra_body_help'))}</div>
        </div>
        <div class="provider-compatibility-footer">
          <button type="button" class="btn-secondary btn-reset-compatibility" data-provider="${id}">${escapeHtml(t('st.providers.compat.reset'))}</button>
          <span class="provider-compatibility-validation" role="status"></span>
        </div>
      </div>
    </details>
  `;
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

function providerSearchTextForEntry(id, config, fieldDefs) {
  const fieldText = fieldDefs.flatMap((field) => [
    field.key,
    field.labelKey ? t(field.labelKey) : field.label,
    field.placeholderKey ? t(field.placeholderKey) : field.placeholder,
    ...(field.suggestions || []),
    ...(field.options || []).flatMap((option) => [
      option.value,
      option.labelKey ? t(option.labelKey) : option.label,
    ]),
  ]).filter(Boolean).join(' ');
  return normalizeGeneralSearchText([
    id,
    config.label,
    config.type,
    config.category,
    config.model,
    config.baseUrl,
    fieldText,
    supportsProviderCompatibilitySettings(id, config)
      ? 'advanced model compatibility reasoning thinking system developer max tokens custom request body json'
      : '',
  ].filter(Boolean).join(' '));
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
        { key: 'model', labelKey: 'st.provider.field.model', type: 'text', placeholder: 'qwen3.6:35b-a3b' },
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
        { key: 'model', labelKey: 'st.provider.field.model', type: 'text', placeholder: 'gemma-4-12b-qat' },
        CONTEXT_WINDOW_FIELD,
        { key: 'supportsVision', labelKey: 'st.provider.field.supports_vision', type: 'checkbox' },
        PROMPT_TIER_FIELD,
      ],
    },
    vllm: {
      fields: [
        { key: 'baseUrl', labelKey: 'st.provider.field.server_url', type: 'text', placeholder: 'http://localhost:8000/v1' },
        { key: 'apiKey', labelKey: 'st.provider.field.api_key', type: 'password', placeholder: 'optional' },
        { key: 'model', labelKey: 'st.provider.field.model', type: 'text', placeholder: 'gemma/gemma4-31b-qat' },
        CONTEXT_WINDOW_FIELD,
        { key: 'supportsVision', labelKey: 'st.provider.field.supports_vision', type: 'checkbox' },
        PROMPT_TIER_FIELD,
      ],
    },
    sglang: {
      fields: [
        { key: 'baseUrl', labelKey: 'st.provider.field.server_url', type: 'text', placeholder: 'http://localhost:30000/v1' },
        { key: 'apiKey', labelKey: 'st.provider.field.api_key', type: 'password', placeholder: 'optional' },
        { key: 'model', labelKey: 'st.provider.field.model', type: 'text', placeholder: 'gemma/gemma4-31b-qat' },
        CONTEXT_WINDOW_FIELD,
        { key: 'supportsVision', labelKey: 'st.provider.field.supports_vision', type: 'checkbox' },
        PROMPT_TIER_FIELD,
      ],
    },
    localai: {
      fields: [
        { key: 'baseUrl', labelKey: 'st.provider.field.server_url', type: 'text', placeholder: 'http://localhost:8080/v1' },
        { key: 'apiKey', labelKey: 'st.provider.field.api_key', type: 'password', placeholder: 'optional' },
        { key: 'model', labelKey: 'st.provider.field.model', type: 'text', placeholder: 'gpt-4' },
        CONTEXT_WINDOW_FIELD,
        { key: 'supportsVision', labelKey: 'st.provider.field.supports_vision', type: 'checkbox' },
        PROMPT_TIER_FIELD,
      ],
    },
    azure_openai: {
      fields: [
        { key: 'baseUrl', labelKey: 'st.provider.field.api_base_url', type: 'text', placeholder: 'https://{resource}.openai.azure.com' },
        { key: 'apiKey', labelKey: 'st.provider.field.api_key', type: 'password', placeholder: 'Azure API key' },
        { key: 'model', labelKey: 'st.provider.field.deployment_name', type: 'text', placeholder: 'my-deployment' },
        { key: 'apiVersion', labelKey: 'st.provider.field.api_version', type: 'text', placeholder: '2024-10-21' },
        { key: 'supportsVision', labelKey: 'st.provider.field.supports_vision', type: 'checkbox' },
        ...COST_ESTIMATE_FIELDS,
        ],
    },
    aws_bedrock: {
      fields: [
        { key: 'region', labelKey: 'st.provider.field.aws_region', type: 'text', placeholder: 'us-east-1' },
        { key: 'accessKeyId', labelKey: 'st.provider.field.aws_access_key_id', type: 'text', placeholder: 'AKIA...' },
        { key: 'secretAccessKey', labelKey: 'st.provider.field.aws_secret_access_key', type: 'password', placeholder: '********' },
        { key: 'sessionToken', labelKey: 'st.provider.field.aws_session_token', type: 'password', placeholder: 'optional (STS)' },
        { key: 'model', labelKey: 'st.provider.field.bedrock_model_id', type: 'text', placeholder: 'anthropic.claude-3-sonnet-20240229-v1:0' },
        ...COST_ESTIMATE_FIELDS,
      ],
    },
    openai: {
      fields: [
        { key: 'apiKey', labelKey: 'st.provider.field.api_key', type: 'password', placeholder: 'sk-...' },
        { key: 'model', labelKey: 'st.provider.field.model', type: 'text', placeholder: 'gpt-5.6-terra',
          suggestions: ['gpt-5.6-terra', 'gpt-5.6-sol', 'gpt-5.6-luna', 'gpt-5.6', 'gpt-5.5', 'gpt-5.4', 'gpt-5.2', 'gpt-5.3-codex'] },
        { key: 'baseUrl', labelKey: 'st.provider.field.api_base_url', type: 'text', placeholder: 'https://api.openai.com/v1' },
        ...COST_ESTIMATE_FIELDS,
      ],
    },
    openrouter: {
      fields: [
        { key: 'apiKey', labelKey: 'st.provider.field.api_key', type: 'password', placeholder: 'sk-or-...' },
        { key: 'model', labelKey: 'st.provider.field.model', type: 'text', placeholder: 'openrouter/free',
          suggestions: ['openrouter/free', 'minimax/minimax-m3', 'stepfun/step-3.7-flash', 'qwen/qwen3.7-max', 'xiaomi/mimo-v2.5-pro'] },
        { key: 'baseUrl', labelKey: 'st.provider.field.api_base_url', type: 'text', placeholder: 'https://openrouter.ai/api/v1' },
        PROMPT_TIER_FIELD,
      ],
    },
    huggingface: {
      fields: [
        { key: 'apiKey', labelKey: 'st.provider.field.api_key', type: 'password', placeholder: 'hf_...' },
        { key: 'model', labelKey: 'st.provider.field.model', type: 'text', placeholder: 'zai-org/GLM-5.2',
          suggestions: ['zai-org/GLM-5.2', 'Qwen/Qwen3.6-27B'] },
        { key: 'baseUrl', labelKey: 'st.provider.field.api_base_url', type: 'text', placeholder: 'https://router.huggingface.co/v1' },
        // Hugging Face's catalog is huge and open-ended — unlike curated
        // routers, model-name sniffing (openai.js supportsVision) can't
        // reliably tell VLMs from text-only models, so expose an explicit
        // toggle like the local providers do.
        { key: 'supportsVision', labelKey: 'st.provider.field.supports_vision', type: 'checkbox' },
        PROMPT_TIER_FIELD,
      ],
    },
    fireworks: {
      fields: [
        { key: 'apiKey', labelKey: 'st.provider.field.api_key', type: 'password', placeholder: 'fw_...' },
        { key: 'model', labelKey: 'st.provider.field.model', type: 'text', placeholder: 'accounts/fireworks/models/llama-v3p3-70b-instruct',
          suggestions: [
            'accounts/fireworks/models/llama-v3p3-70b-instruct',
            'accounts/fireworks/models/llama4-scout-instruct-basic',
            'accounts/fireworks/models/qwen3-235b-a22b',
            'accounts/fireworks/models/deepseek-v3',
          ] },
        { key: 'baseUrl', labelKey: 'st.provider.field.api_base_url', type: 'text', placeholder: 'https://api.fireworks.ai/inference/v1' },
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
    cloudflare: {
      fields: [
        { key: 'apiKey', labelKey: 'st.provider.field.api_key', type: 'password', placeholder: 'API token' },
        { key: 'accountId', label: 'Cloudflare Account ID', type: 'text', placeholder: '0123456789abcdef0123456789abcdef' },
        { key: 'model', labelKey: 'st.provider.field.model', type: 'text', placeholder: '@cf/zai-org/glm-5.2',
          suggestions: ['@cf/zai-org/glm-5.2'] },
        { key: 'baseUrl', labelKey: 'st.provider.field.api_base_url', type: 'text', placeholder: 'https://api.cloudflare.com/client/v4/accounts/{account_id}/ai/v1' },
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
          suggestions: ['minimax-m2.7', 'minimax-m3'] },
        { key: 'baseUrl', labelKey: 'st.provider.field.api_base_url', type: 'text', placeholder: 'https://api.minimax.chat/v1' },
        ...COST_ESTIMATE_FIELDS,
      ],
    },
    kimi: {
      fields: [
        { key: 'apiKey', labelKey: 'st.provider.field.api_key', type: 'password', placeholder: 'sk-...' },
        { key: 'model', labelKey: 'st.provider.field.model', type: 'text', placeholder: 'kimi-k2.5',
          suggestions: ['kimi-k2.5', 'kimi-k3', 'kimi-k2.7-code', 'kimi-k2.7-code-highspeed', 'kimi-k2.6'] },
        { key: 'baseUrl', labelKey: 'st.provider.field.api_base_url', type: 'text', placeholder: 'https://api.moonshot.ai/v1' },
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
    together: {
      fields: [
        { key: 'apiKey', labelKey: 'st.provider.field.api_key', type: 'password', placeholder: 'tgp_...' },
        { key: 'model', labelKey: 'st.provider.field.model', type: 'text', placeholder: 'meta-llama/Llama-3.3-70B-Instruct-Turbo',
          suggestions: [
            'meta-llama/Llama-3.3-70B-Instruct-Turbo',
            'meta-llama/Meta-Llama-3.1-70B-Instruct-Turbo',
            'Qwen/Qwen2.5-72B-Instruct-Turbo',
            'deepseek-ai/DeepSeek-V3',
          ] },
        { key: 'baseUrl', labelKey: 'st.provider.field.api_base_url', type: 'text', placeholder: 'https://api.together.xyz/v1' },
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
  };

  // Filter pill row above the providers list.
  providersContainer.appendChild(renderProviderFilterBar());

  const entries = Object.entries(providersData);
  const providerQuery = normalizeGeneralSearchText(providerSearchQuery);
  let visibleCount = 0;
  for (const [id, config] of entries) {
    const isSelected = id === activeProviderId;
    const isConfigured = id !== 'webbrain_cloud' && config.configured === true;
    const fieldDefs = providerConfigs[id]?.fields || [];

    const category = config.category || 'cloud';
    if (providerFilter !== 'all' && category !== providerFilter && !isSelected) continue;
    if (providerQuery && !providerSearchTextForEntry(id, config, fieldDefs).includes(providerQuery)) continue;
    visibleCount++;

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
        const localModelProviders = ['llamacpp', 'ollama', 'lmstudio', 'jan', 'vllm', 'sglang', 'localai'];
        const canLoadModels = localModelProviders.includes(id) && field.key === 'model';
        const listAttr = canLoadModels ? `list="models-${id}"` : '';
        const datalistHTML = canLoadModels ? `<datalist id="models-${id}"></datalist>` : '';
        const loadedModelsDialogHTML = canLoadModels
          ? `<dialog class="loaded-model-dialog" data-loaded-models-for="${id}"
                     aria-labelledby="loaded-model-dialog-title-${id}">
              <div class="loaded-model-dialog-panel">
                <div class="loaded-model-dialog-header">
                  <h3 id="loaded-model-dialog-title-${id}">${escapeHtml(t('st.providers.select_loaded_model'))}</h3>
                  <button type="button" class="loaded-model-dialog-close"
                          aria-label="${escapeHtml(t('sp.schedule_form.cancel'))}">&times;</button>
                </div>
                <div class="loaded-model-options" role="listbox"
                     aria-label="${escapeHtml(t('st.providers.select_loaded_model'))}"></div>
              </div>
            </dialog>`
          : '';
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
            ${loadedModelsDialogHTML}
          </div>
        `;
      }
    }

    const subscribeHref = id === 'webbrain_cloud' ? webbrainSubscribeUrl(config.deviceGuid) : '';
    const accountHref = id === 'webbrain_cloud' ? webbrainAccountUrl(config.deviceGuid) : '';
    const billingButton = id === 'webbrain_cloud'
      ? `<button class="btn-secondary btn-manage-billing" data-href="${escapeHtml(accountHref)}"${config.deviceGuid ? '' : ' disabled'}>${escapeHtml(t('st.account.manage_billing'))}</button>`
      : '';
    let providerNote = '';
    if (id === 'webbrain_cloud') {
      const linkStyle = 'color:var(--accent,#4A90D9);text-decoration:none;';
      const privacyLink = `<a href="https://webbrain.one/privacy" target="_blank" rel="noopener noreferrer"
              style="${linkStyle}">${escapeHtml(t('st.providers.webbrain_note.privacy_link'))}</a>`;
      const subscribeLink = `<a href="${escapeHtml(subscribeHref)}" target="_blank" rel="noopener noreferrer"
              style="${linkStyle}">webbrain.one/subscribe</a>`;
      const accountLink = `<a href="${escapeHtml(accountHref)}" target="_blank" rel="noopener noreferrer"
              style="${linkStyle}">api.webbrain.one/account</a>`;
      providerNote = `<div style="margin-top:10px;padding:10px 12px;border-radius:6px;
                  background:rgba(74,144,217,0.08);border:1px solid rgba(74,144,217,0.22);
                  font-size:12px;color:var(--text2);line-height:1.5;">
           ${t('st.providers.webbrain_data_use.body', { privacyLink, subscribeLink, accountLink })}
         </div>`;
    }
    const extensionOrigin = browser.runtime.getURL('').replace(/\/$/, '');
    const ollamaWarning = id === 'ollama'
      ? `<aside class="provider-warning provider-ollama-warning" role="note"
                aria-labelledby="ollama-warning-title">
           <div class="provider-warning-label">${escapeHtml(t('st.providers.ollama_warning.label'))}</div>
           <strong class="provider-warning-title" id="ollama-warning-title">${escapeHtml(t('st.providers.ollama_warning.title'))}</strong>
           <p>${escapeHtml(t('st.providers.ollama_warning.body'))}</p>
           <p>${escapeHtml(t('st.providers.ollama_warning.restart'))}</p>
           <pre><code>OLLAMA_ORIGINS="${escapeHtml(extensionOrigin)}" ollama serve</code></pre>
           <p>${escapeHtml(t('st.providers.ollama_warning.base_url'))}</p>
           <a href="https://www.webbrain.one/blog/ollama-launch-handoff"
              target="_blank" rel="noopener noreferrer">${escapeHtml(t('st.providers.ollama_warning.link'))} ↗</a>
         </aside>`
      : '';
    const compatibilitySettings = renderProviderCompatibilitySettings(id, config);

    const body = `
      ${fieldsHTML}
      ${providerNote}
      ${ollamaWarning}
      ${compatibilitySettings}
      <div class="btn-row">
        <button class="btn-primary btn-save" data-provider="${id}">${escapeHtml(t('st.providers.save'))}</button>
        <button class="btn-secondary btn-test" data-provider="${id}">${escapeHtml(t('st.providers.test'))}</button>
        ${billingButton}
        ${!isSelected ? `<button class="btn-secondary btn-activate" data-provider="${id}">${escapeHtml(t('st.providers.select_for_chat'))}</button>` : ''}
      </div>
      <div class="test-result" id="test-${id}"></div>
    `;

    providersContainer.appendChild(wrapCollapsibleCard(id, config, isSelected, isConfigured, body));
  }

  if (visibleCount === 0) {
    const empty = document.createElement('div');
    empty.className = 'provider-filter-empty';
    empty.textContent = providerQuery
      ? t('st.providers.search.empty')
      : t('st.providers.filter.empty');
    providersContainer.appendChild(empty);
  }

  restoreProviderApiKeyWarnings();

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
  document.querySelectorAll('.btn-manage-billing').forEach(btn => {
    btn.addEventListener('click', () => {
      const href = btn.dataset.href || '';
      if (!href) return;
      window.open(href, '_blank', 'noopener,noreferrer');
    });
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
      refreshProviderCompatibilitySummary(providerId);
    });
  });
  document.querySelectorAll('.provider-compatibility select[data-provider], .provider-compatibility textarea[data-provider]').forEach((input) => {
    const eventName = input.tagName === 'TEXTAREA' ? 'input' : 'change';
    input.addEventListener(eventName, () => {
      if (input.tagName === 'TEXTAREA') {
        providerCompatibilityJsonDrafts.set(input.dataset.provider, input.value);
      }
      refreshProviderCompatibilitySummary(input.dataset.provider);
    });
  });
  document.querySelectorAll('input[data-key="model"], input[data-key="baseUrl"]').forEach((input) => {
    input.addEventListener('input', () => refreshProviderCompatibilitySummary(input.dataset.provider));
  });
  document.querySelectorAll('.btn-reset-compatibility').forEach((button) => {
    button.addEventListener('click', () => {
      const id = button.dataset.provider;
      const details = button.closest('.provider-compatibility');
      details?.querySelectorAll('select[data-provider]').forEach((select) => { select.value = 'auto'; });
      const textarea = details?.querySelector('textarea[data-type="json"]');
      if (textarea) {
        textarea.value = '';
        providerCompatibilityJsonDrafts.set(id, '');
      }
      refreshProviderCompatibilitySummary(id);
    });
  });
  document.querySelectorAll('.provider-compatibility[data-provider-id]').forEach((details) => {
    refreshProviderCompatibilitySummary(details.dataset.providerId);
  });
  document.querySelectorAll('.loaded-model-dialog').forEach(dialog => {
    dialog.addEventListener('click', (event) => {
      if (event.target === dialog || event.target.closest('.loaded-model-dialog-close')) {
        closeLoadedModelDialog(dialog);
        return;
      }
      const option = event.target.closest('.loaded-model-option');
      if (!option) return;
      const providerId = dialog.dataset.loadedModelsFor;
      const input = document.querySelector(`input[data-provider="${providerId}"][data-key="model"]`);
      if (!input) return;
      const selectedModel = option.dataset.model || '';
      input.value = selectedModel;
      void saveProvider(providerId, { showFlash: false })
        .then(() => detectProviderContextWindowForModel(providerId, selectedModel))
        .catch(() => {});
      closeLoadedModelDialog(dialog);
    });
  });
}

/**
 * Build the filter pill row. See chrome/settings.js for the canonical doc.
 */
function renderProviderFilterBar() {
  const bar = document.createElement('div');
  bar.className = 'provider-filter-bar';
  const pills = document.createElement('div');
  pills.className = 'provider-filter-pills';
  // Small mono SVGs — category cues, not brand logos. Keep stroke icons so
  // they track text color (including the active accent state).
  const filterIcons = {
    all: '<svg class="provider-filter-pill-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/></svg>',
    local: '<svg class="provider-filter-pill-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8"/><path d="M12 17v4"/></svg>',
    cloud: '<svg class="provider-filter-pill-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z"/></svg>',
    router: '<svg class="provider-filter-pill-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="2"/><path d="M16.24 7.76a6 6 0 0 1 0 8.49"/><path d="M7.76 16.24a6 6 0 0 1 0-8.49"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/><path d="M4.93 19.07a10 10 0 0 1 0-14.14"/></svg>',
  };
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
    btn.innerHTML = `${filterIcons[f.key] || ''}<span>${escapeHtml(t(f.labelKey))}</span>`;
    btn.addEventListener('click', async () => {
      if (providerFilter === f.key) return;
      // Snapshot whatever the user has typed but not yet saved BEFORE we
      // rebuild the DOM — otherwise input values for the currently-rendered
      // cards are lost (e.g. typed an API key, then clicked a filter pill
      // to compare two providers).
      syncInputsIntoProvidersData();
      providerFilter = f.key;
      await browser.storage.local.set({ providerFilter: f.key }).catch(() => {});
      renderProviders();
    });
    pills.appendChild(btn);
  }
  const search = document.createElement('div');
  search.className = 'provider-search settings-search';
  const input = document.createElement('input');
  input.type = 'search';
  input.id = 'input-provider-search';
  input.autocomplete = 'off';
  input.spellcheck = false;
  input.placeholder = t('st.providers.search.placeholder');
  input.value = providerSearchQuery;
  let providerSearchComposing = false;
  const applyProviderSearchInput = () => {
    const selectionStart = input.selectionStart ?? input.value.length;
    const selectionEnd = input.selectionEnd ?? input.value.length;
    syncInputsIntoProvidersData();
    providerSearchQuery = input.value;
    renderProviders();
    const next = document.getElementById('input-provider-search');
    if (!next) return;
    next.focus();
    try { next.setSelectionRange(selectionStart, selectionEnd); } catch { /* ignore */ }
  };
  input.addEventListener('compositionstart', () => {
    providerSearchComposing = true;
  });
  input.addEventListener('compositionend', () => {
    providerSearchComposing = false;
    applyProviderSearchInput();
  });
  input.addEventListener('input', (event) => {
    providerSearchQuery = input.value;
    if (event.isComposing || providerSearchComposing) return;
    applyProviderSearchInput();
  });
  search.appendChild(input);
  bar.appendChild(pills);
  bar.appendChild(search);
  return bar;
}

/**
 * Wrap a provider card body in a collapsible shell. See chrome/settings.js
 * for the design notes.
 */
function wrapCollapsibleCard(id, config, isSelected, isConfigured, bodyHtml) {
  const expanded = isSelected || expandedProviders.has(id);
  const card = document.createElement('div');
  card.className = `provider-card ${isSelected ? 'selected' : ''} ${isConfigured ? 'configured' : ''} ${expanded ? 'expanded' : 'collapsed'}`;
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
  const label = config.label || id;
  header.innerHTML = `
    <div class="provider-header-left">
      <span class="provider-chevron" aria-hidden="true">${expanded ? '▾' : '▸'}</span>
      ${providerIconHtml(id, label)}
      <span class="provider-name">${escapeHtml(label)}</span>
      <span class="provider-type">${escapeHtml(config.type)}</span>
      ${config.category ? `<span class="provider-category-badge provider-category-${escapeHtml(config.category)}">${escapeHtml(config.category)}</span>` : ''}
      ${modelStr ? `<span class="provider-model" title="${escapeHtml(modelStr)}">${escapeHtml(modelStr)}</span>` : ''}
    </div>
    <span class="provider-status-badges">
      ${isConfigured ? `<span class="provider-status-badge active">${escapeHtml(t('st.providers.active'))}</span>` : ''}
      ${isSelected ? `<span class="provider-status-badge selected">${escapeHtml(t('st.providers.selected'))}</span>` : ''}
    </span>
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

function setProviderLoadModelsStatus(id, message, color = 'var(--text2)') {
  const statusEl = document.querySelector(`.load-models-status[data-provider="${id}"]`);
  if (!statusEl) return null;
  statusEl.textContent = message;
  statusEl.style.color = color;
  return statusEl;
}

function providerModelLoadErrorMessage(resultOrError) {
  if (resultOrError?.errorKey) return t(resultOrError.errorKey);
  const message = String(typeof resultOrError === 'string' ? resultOrError : resultOrError?.error || '').trim();
  if (/^HTTP\s+404\b/i.test(message) && /<!doctype\s+html|<html[\s>]|file not found/i.test(message)) {
    return t('ob.tokens.none_status');
  }
  return message || 'Failed to load models';
}

function applyProviderBaseUrl(id, baseUrl) {
  if (!baseUrl) return;
  if (providersData[id]) providersData[id].baseUrl = baseUrl;
  const input = document.querySelector(`input[data-provider="${id}"][data-key="baseUrl"]`);
  if (input && input.value !== baseUrl) input.value = baseUrl;
}

function applyProviderContextWindow(id, contextWindow) {
  const n = Number(contextWindow);
  if (!Number.isFinite(n) || n <= 0) return;
  if (providersData[id]) providersData[id].contextWindow = n;
  const input = document.querySelector(`input[data-provider="${id}"][data-key="contextWindow"]`);
  if (input && input.value !== String(n)) input.value = String(n);
}

async function detectProviderContextWindowForModel(id, model) {
  const value = String(model || '').trim();
  if (!value) return;
  try {
    const res = await sendToBackground('detect_provider_context_window', { providerId: id, model: value });
    if (res?.ok) applyProviderContextWindow(id, res.contextWindow);
  } catch {
    // Model picking should still succeed if the backend cannot report a window.
  }
}

function closeLoadedModelDialog(dialog) {
  if (!dialog) return;
  if (typeof dialog.close === 'function') dialog.close();
  else dialog.removeAttribute('open');
}

function openLoadedModelDialog(dialog) {
  if (!dialog) return;
  if (dialog.open) return;
  if (typeof dialog.showModal === 'function') dialog.showModal();
  else dialog.setAttribute('open', '');
}

function clearProviderLoadedModels(id) {
  const loadedDialogEl = document.querySelector(`.loaded-model-dialog[data-loaded-models-for="${id}"]`);
  if (loadedDialogEl) {
    const optionsEl = loadedDialogEl.querySelector('.loaded-model-options');
    if (optionsEl) optionsEl.innerHTML = '';
    closeLoadedModelDialog(loadedDialogEl);
  }
  const datalistEl = document.getElementById(`models-${id}`);
  if (datalistEl) datalistEl.innerHTML = '';
}

async function loadProviderModels(id) {
  let datalistEl = document.getElementById(`models-${id}`);
  if (!datalistEl) return;
  clearProviderLoadedModels(id);
  try {
    await saveProvider(id, { showFlash: false, markConfigured: false });
  } catch (e) {
    setProviderLoadModelsStatus(id, providerModelLoadErrorMessage(e.message), 'var(--danger, #c33)');
    return;
  }

  setProviderLoadModelsStatus(id, t('st.providers.loading'));
  let res;
  try {
    res = await sendToBackground('list_provider_models', { providerId: id });
  } catch (e) {
    setProviderLoadModelsStatus(id, providerModelLoadErrorMessage(e.message), 'var(--danger, #c33)');
    return;
  }

  datalistEl = document.getElementById(`models-${id}`);
  if (!datalistEl) return;
  if (res?.ok) {
    applyProviderBaseUrl(id, res.baseUrl);
    applyProviderContextWindow(id, res.contextWindow);
    const loadedDialogEl = document.querySelector(`.loaded-model-dialog[data-loaded-models-for="${id}"]`);
    datalistEl.innerHTML = res.models
      .map((m) => `<option value="${escapeHtml(m)}"></option>`)
      .join('');
    if (loadedDialogEl) {
      const optionsEl = loadedDialogEl.querySelector('.loaded-model-options');
      if (optionsEl) {
        optionsEl.innerHTML = res.models
          .map((m) => `<button type="button" class="loaded-model-option" role="option" data-model="${escapeHtml(m)}">${escapeHtml(m)}</button>`)
          .join('');
      }
      if (res.models.length) openLoadedModelDialog(loadedDialogEl);
    }
    setProviderLoadModelsStatus(id, t('st.providers.models_loaded', { count: res.models.length }));
  } else {
    setProviderLoadModelsStatus(id, providerModelLoadErrorMessage(res), 'var(--danger, #c33)');
  }
}

function setProviderTestResult(id, className, message, color) {
  const testEl = document.getElementById(`test-${id}`);
  if (!testEl) return null;
  testEl.className = `test-result show${className ? ` ${className}` : ''}`;
  testEl.textContent = message;
  testEl.style.color = color || '';
  return testEl;
}

async function saveProvider(id, { showFlash = true, markConfigured = true } = {}) {
  const inputs = document.querySelectorAll(`input[data-provider="${id}"], select[data-provider="${id}"], textarea[data-provider="${id}"]`);
  const config = {};
  let apiKeyWarning = '';

  try {
    inputs.forEach(input => {
      const value = input.dataset.type === 'json'
        ? parseProviderExtraBodyJson(input.value)
        : providerInputValue(input);
      setProviderConfigValue(config, input.dataset.key, value);
    });
    apiKeyWarning = providerApiKeyWarning(id, config);
    await sendToBackground('update_provider', { providerId: id, config, markConfigured });
  } catch (e) {
    if (showFlash) setProviderTestResult(id, 'fail', t('st.providers.failed', { error: e.message }));
    throw e;
  }
  providerCompatibilityJsonDrafts.delete(id);
  if (providersData[id]) {
    Object.assign(providersData[id], config);
    if (markConfigured) providersData[id].configured = id !== 'webbrain_cloud';
  }
  refreshProviderCardStatus(id);

  if (showFlash) {
    if (apiKeyWarning) {
      setProviderTestResult(id, 'warn', apiKeyWarning);
    } else {
      const testEl = setProviderTestResult(id, 'ok', t('st.providers.saved'));
      if (testEl) setTimeout(() => testEl.classList.remove('show'), 2000);
    }
  }
}

function refreshProviderCardStatus(id) {
  const card = document.querySelector(`.provider-card[data-provider-id="${id}"]`);
  if (!card) return;
  const isConfigured = id !== 'webbrain_cloud' && providersData[id]?.configured === true;
  const isSelected = id === activeProviderId;
  card.classList.toggle('configured', isConfigured);
  card.classList.toggle('selected', isSelected);
  const badges = card.querySelector('.provider-status-badges');
  if (!badges) return;
  badges.innerHTML = `
    ${isConfigured ? `<span class="provider-status-badge active">${escapeHtml(t('st.providers.active'))}</span>` : ''}
    ${isSelected ? `<span class="provider-status-badge selected">${escapeHtml(t('st.providers.selected'))}</span>` : ''}
  `;
}

async function testProvider(id) {
  // Skip the save-flash so its 2s auto-hide doesn't blank out the test result
  // mid-flight on slow endpoints.
  try {
    await saveProvider(id, { showFlash: false, markConfigured: false });
  } catch (e) {
    setProviderTestResult(id, 'fail', t('st.providers.failed', { error: e.message }));
    return;
  }

  if (!setProviderTestResult(id, '', t('st.providers.testing'), 'var(--text2)')) return;

  try {
    const res = await sendToBackground('test_provider', { providerId: id });
    if (res.ok) {
      applyProviderBaseUrl(id, res.baseUrl);
      applyProviderContextWindow(id, res.contextWindow);
      setProviderTestResult(id, 'ok', t('st.providers.connected', { model: res.model || t('st.providers.unknown_model') }));
    } else {
      setProviderTestResult(id, 'fail', t('st.providers.failed', { error: res.error }));
    }
  } catch (e) {
    setProviderTestResult(id, 'fail', t('st.providers.failed', { error: e.message }));
  }
}

function syncInputsIntoProvidersData() {
  document.querySelectorAll('input[data-provider], select[data-provider], textarea[data-provider]').forEach((input) => {
    const id = input.dataset.provider;
    const key = input.dataset.key;
    if (!id || !key || !providersData[id]) return;
    // Keep extraBody as a parsed object in memory (matches saveProvider and
    // mergeProviderRequestBody). Invalid draft JSON is left unchanged so a
    // partial edit does not corrupt the last-known-good object.
    if (input.dataset.type === 'json') {
      providerCompatibilityJsonDrafts.set(id, input.value);
      try {
        setProviderConfigValue(providersData[id], key, parseProviderExtraBodyJson(input.value));
      } catch {
        /* keep previous value */
      }
      return;
    }
    setProviderConfigValue(providersData[id], key, providerInputValue(input));
  });
}

async function activateProvider(id) {
  syncInputsIntoProvidersData();
  requestedActiveProviderId = id;
  const requestId = ++providerActivationRequestId;
  try {
    await saveProvider(id, { showFlash: false });
    if (requestId !== providerActivationRequestId || requestedActiveProviderId !== id) return;
    await sendToBackground('set_active_provider', { providerId: id });
  } catch (e) {
    if (requestId === providerActivationRequestId && requestedActiveProviderId === id) {
      setProviderTestResult(id, 'fail', t('st.providers.failed', { error: e.message }));
    }
    return;
  }
  if (requestId !== providerActivationRequestId || requestedActiveProviderId !== id) {
    const latestProviderId = requestedActiveProviderId;
    if (latestProviderId) {
      sendToBackground('set_active_provider', { providerId: latestProviderId }).catch(() => {});
    }
    return;
  }
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

init();
