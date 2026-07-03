/**
 * WebBrain Side Panel — Chat UI logic.
 * Default: human-friendly compact output. Verbose mode: full tool debug.
 */

import { t, getLocale, setLocale, LANGUAGES, applyDOMTranslations } from './i18n.js';
import { sanitizeMarkdownLinks } from './markdown-link.js';
import { applyMode, loadMode, watch } from './theme.js';
import { buildRecommendedActions } from './recommended-actions.js';
import { createContextMenuPromptHandler } from './context-menu-prompts.js';

// Hydrate the theme from chrome.storage.local (the inline <head> bootstrap
// only sees localStorage; if the user changes the theme on another device
// or page, sync it in here) and subscribe to live changes so the panel
// re-paints when the Settings page flips it.
let currentThemeMode = 'system';
loadMode().then((mode) => {
  currentThemeMode = mode;
  applyMode(mode, { syncStorage: false });
});
watch(() => currentThemeMode);
// Keep currentThemeMode in sync when storage changes from elsewhere.
if (globalThis.chrome?.storage?.onChanged) {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.themeMode) {
      currentThemeMode = changes.themeMode.newValue || 'system';
    }
  });
}

// ─── Onboarding (first-launch wizard) ───────────────────────────────
(async function initOnboarding() {
  const stored = await chrome.storage.local.get('onboardingComplete');
  if (stored.onboardingComplete) return;

  const overlay = document.getElementById('onboarding');
  if (!overlay) return;

  applyDOMTranslations(overlay);
  overlay.classList.remove('hidden');

  const steps = overlay.querySelectorAll('.ob-step');
  const dots = overlay.querySelectorAll('.ob-step-dot');
  const nextBtn = document.getElementById('ob-next');
  const backBtn = document.getElementById('ob-back');
  const settingsBtn = document.getElementById('ob-open-settings');
  const skipBtn = document.getElementById('ob-skip');
  const providerBody = document.getElementById('ob-provider-body');
  const providerStatus = document.getElementById('ob-provider-status');
  const providerList = document.getElementById('ob-provider-list');
  const localModels = document.getElementById('ob-local-models');
  const localModelSelect = document.getElementById('ob-local-model-select');
  const totalSteps = steps.length;
  const LOCAL_PROVIDER_ORDER = ['jan', 'lmstudio', 'ollama', 'llamacpp', 'vllm', 'sglang'];
  let current = 0;
  let localScanStarted = false;
  let localModelChoices = [];
  let cloudReady = false;

  async function dismissOnboarding() {
    await chrome.storage.local.set({ onboardingComplete: true }).catch(() => {});
    overlay.classList.add('hidden');
  }

  function setProviderStatus(key, params) {
    if (providerStatus) providerStatus.textContent = t(key, params);
  }

  function openProviderSettings() {
    try {
      chrome.tabs.create({ url: chrome.runtime.getURL('src/ui/settings.html#providers') });
    } catch {
      chrome.runtime.openOptionsPage();
    }
  }

  function providerSortIndex(id) {
    const idx = LOCAL_PROVIDER_ORDER.indexOf(id);
    return idx === -1 ? LOCAL_PROVIDER_ORDER.length : idx;
  }

  function withTimeout(promise, timeoutMs) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Timed out')), timeoutMs);
      promise.then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (err) => {
          clearTimeout(timer);
          reject(err);
        }
      );
    });
  }

  function showProviderFallback(statusKey = 'ob.tokens.none_status') {
    cloudReady = false;
    localModelChoices = [];
    if (providerBody) providerBody.textContent = t('ob.tokens.body');
    providerList?.classList.remove('hidden');
    localModels?.classList.add('hidden');
    setProviderStatus(statusKey);
    settingsBtn.textContent = t('ob.btn.settings');
    settingsBtn.disabled = false;
  }

  function showLocalChoices(choices) {
    cloudReady = false;
    localModelChoices = choices;
    if (providerBody) providerBody.textContent = t('ob.tokens.local_body');
    if (localModelSelect) {
      localModelSelect.innerHTML = '';
      choices.forEach((choice, index) => {
        const opt = document.createElement('option');
        opt.value = String(index);
        opt.textContent = `${choice.providerLabel}: ${choice.model}`;
        localModelSelect.appendChild(opt);
      });
    }
    providerList?.classList.add('hidden');
    localModels?.classList.remove('hidden');
    setProviderStatus('ob.tokens.local_status', { count: choices.length });
    settingsBtn.textContent = t('ob.btn.use_local');
    settingsBtn.disabled = false;
  }

  function showCloudReady() {
    cloudReady = true;
    localModelChoices = [];
    if (providerBody) {
      providerBody.textContent = 'WebBrain Cloud is ready with a free daily allowance. Requests go through api.webbrain.one; debug and quota logs store metadata only by default, not prompt text, screenshots, or responses.';
    }
    if (providerStatus) {
      providerStatus.textContent = '';
      const changeLink = document.createElement('a');
      changeLink.href = chrome.runtime.getURL('src/ui/settings.html#providers');
      changeLink.target = '_blank';
      changeLink.rel = 'noopener noreferrer';
      changeLink.textContent = 'Change';
      changeLink.addEventListener('click', async (event) => {
        event.preventDefault();
        openProviderSettings();
        await dismissOnboarding();
      });
      providerStatus.append(
        document.createTextNode('Using WebBrain Cloud. '),
        changeLink,
        document.createTextNode('.')
      );
    }
    providerList?.classList.add('hidden');
    localModels?.classList.add('hidden');
    settingsBtn.textContent = 'Start';
    settingsBtn.disabled = false;
  }

  async function scanLocalModels() {
    localModelChoices = [];
    settingsBtn.disabled = true;
    settingsBtn.textContent = t('ob.btn.detecting');
    providerList?.classList.add('hidden');
    localModels?.classList.add('hidden');
    if (providerBody) providerBody.textContent = t('ob.tokens.body');
    setProviderStatus('ob.tokens.scanning');

    try {
      const { providers = {}, active } = await sendToBackground('get_providers');
      if (active === 'webbrain_cloud' && providers.webbrain_cloud?.enabled !== false) {
        showCloudReady();
        return;
      }
      const localProviderIds = Object.keys(providers)
        .filter((id) => providers[id]?.category === 'local' || LOCAL_PROVIDER_ORDER.includes(id))
        .sort((a, b) => providerSortIndex(a) - providerSortIndex(b) || a.localeCompare(b));

      const detected = await Promise.all(localProviderIds.map(async (providerId) => {
        try {
          // Upper bound only — this does NOT freeze the UI. Probes run in
          // parallel: a reachable server answers in well under a second, and a
          // closed port fails fast (connection refused). 5s just caps the rare
          // case of a cold offscreen-proxy round-trip or a server that accepts
          // the connection but stalls. (The original "no models" bug was a
          // service-worker dynamic import in providers/manager.js, since fixed;
          // the old 2.5s was also too tight for a cold proxy.)
          const res = await withTimeout(
            sendToBackground('list_provider_models', { providerId }),
            5000
          );
          if (res?.ok && Array.isArray(res.models)) {
            const choices = res.models
              .map((model) => (typeof model === 'string' ? model.trim() : ''))
              .filter(Boolean)
              .map((model) => ({
                providerId,
                providerLabel: providers[providerId]?.label || providerId,
                model,
              }));
            return { choices, error: null };
          }
          return { choices: [], error: res?.error || 'unknown error' };
        } catch (e) {
          return { choices: [], error: e?.message || String(e || 'timeout') };
        }
      }));

      const choices = detected.flatMap((d) => d.choices);
      const errors = detected.map((d) => d.error).filter(Boolean);
      if (choices.length > 0) {
        showLocalChoices(choices);
      } else if (errors.length > 0) {
        // A local server was probed but unreadable. By far the most common
        // cause is CORS being disabled on the local server (Jan / LM Studio /
        // Ollama / llama.cpp / vLLM / SGLang): curl works but the browser blocks the
        // cross-origin request. The browser reports "blocked" and "not
        // running" as the same generic network error, so we can't tell them
        // apart — the hint is phrased conditionally. Log the real underlying
        // errors so they're visible in the console for debugging.
        console.warn('[WebBrain] onboarding local-model scan failed:', errors);
        showProviderFallback('ob.tokens.none_blocked');
      } else {
        showProviderFallback();
      }
    } catch {
      showProviderFallback('ob.tokens.detect_failed');
    }
  }

  function goTo(idx) {
    steps[current].classList.remove('active');
    dots[current].classList.remove('active');
    dots[current].classList.add('done');

    current = idx;

    steps[current].classList.add('active');
    dots.forEach((d, i) => {
      d.classList.toggle('active', i === current);
      d.classList.toggle('done', i < current);
    });

    const isLast = current === totalSteps - 1;
    backBtn.classList.toggle('hidden', current === 0);
    nextBtn.classList.toggle('hidden', isLast);
    settingsBtn.classList.toggle('hidden', !isLast);
    skipBtn.classList.toggle('hidden', !isLast);
    if (!isLast) nextBtn.textContent = t('ob.btn.next');
    if (isLast && !localScanStarted) {
      localScanStarted = true;
      scanLocalModels();
    }
  }

  nextBtn.addEventListener('click', () => {
    if (current < totalSteps - 1) goTo(current + 1);
  });

  backBtn.addEventListener('click', () => {
    if (current > 0) goTo(current - 1);
  });

  settingsBtn.addEventListener('click', async () => {
    if (cloudReady) {
      await dismissOnboarding();
      inputEl?.focus();
      return;
    }

    if (localModelChoices.length > 0) {
      const selectedIndex = Number(localModelSelect?.value || 0);
      const choice = localModelChoices[selectedIndex] || localModelChoices[0];
      settingsBtn.disabled = true;
      settingsBtn.textContent = t('ob.btn.enabling');
      setProviderStatus('ob.tokens.enabling');
      try {
        await sendToBackground('update_provider', {
          providerId: choice.providerId,
          config: { enabled: true, model: choice.model },
        });
        await sendToBackground('set_active_provider', { providerId: choice.providerId });
        await loadProviders();
        if (providerSelect) providerSelect.value = choice.providerId;
        await testConnection({ providerId: choice.providerId });
        dismissOnboarding();
        inputEl?.focus();
      } catch (e) {
        settingsBtn.disabled = false;
        settingsBtn.textContent = t('ob.btn.use_local');
        setProviderStatus('ob.tokens.enable_failed', { error: e?.message || String(e || 'unknown error') });
      }
      return;
    }

    openProviderSettings();
    await dismissOnboarding();
  });

  skipBtn.addEventListener('click', async () => {
    await dismissOnboarding();
  });
})();

const messagesEl = document.getElementById('messages');
const inputEl = document.getElementById('user-input');
const inputHighlightEl = document.getElementById('input-highlight');
const sendBtn = document.getElementById('btn-send');
const micBtn = document.getElementById('btn-mic');
const clearBtn = document.getElementById('btn-clear');
const settingsBtn = document.getElementById('btn-settings');
const verboseBtn = document.getElementById('btn-verbose');
const providerSelect = document.getElementById('provider-select');
const statusDot = document.getElementById('status-dot');
const agentActivity = document.getElementById('agent-activity');
const activityText = document.getElementById('activity-text');
const modeAskBtn = document.getElementById('btn-mode-ask');
const modeActBtn = document.getElementById('btn-mode-act');
const actWarning = document.getElementById('act-warning');
const inputArea = document.getElementById('input-area');
const slashCommandMenuEl = document.getElementById('slash-command-menu');
const queuedMessagesEl = document.getElementById('queued-messages');
const recommendedActionsEl = document.getElementById('recommended-actions');
const recommendedActionsToggleEl = document.getElementById('recommended-actions-toggle');
const recommendedActionsListEl = document.getElementById('recommended-actions-list');
const scheduledJobsEl = document.getElementById('scheduled-jobs');
const stopBtn = document.getElementById('btn-stop');
const RECOMMENDED_ACTIONS_COLLAPSED_KEY = 'recommendedActionsCollapsed';
const PLACEHOLDER_ROTATION_INTERVAL_MS = 10_000;
const ASK_PLACEHOLDER_KEYS = [
  'sp.input.ask_placeholder',
  'sp.input.placeholder_tip.help',
  'sp.input.placeholder_tip.record',
];
const SLASH_COMMANDS = [
  { value: '/help', descriptionKey: 'sp.slash.help' },
  { value: '/schedule', descriptionKey: 'sp.slash.schedule' },
  { value: '/list-schedules', descriptionKey: 'sp.slash.list_schedules' },
  { value: '/show-scratchpad', descriptionKey: 'sp.slash.show_scratchpad' },
  { value: '/edit-scratchpad', descriptionKey: 'sp.slash.edit_scratchpad' },
  { value: '/clear-scratchpad', descriptionKey: 'sp.slash.clear_scratchpad' },
  { value: '/allow-api', descriptionKey: 'sp.slash.allow_api' },
  { value: '/dangerously-skip-permissions', descriptionKey: 'sp.slash.dangerously_skip_permissions' },
  { value: '/compact', descriptionKey: 'sp.slash.compact' },
  { value: '/verbose', descriptionKey: 'sp.slash.verbose' },
  { value: '/reset', descriptionKey: 'sp.slash.reset' },
  { value: '/screenshot', descriptionKey: 'sp.slash.screenshot' },
  { value: '/full-page-screenshot', descriptionKey: 'sp.slash.full_page_screenshot' },
  { value: '/record-full-screen', descriptionKey: 'sp.slash.record_full_screen' },
  { value: '/record', descriptionKey: 'sp.slash.record' },
  { value: '/export', descriptionKey: 'sp.slash.export' },
  { value: '/profile', descriptionKey: 'sp.slash.profile' },
  { value: '/vision', descriptionKey: 'sp.slash.vision' },
  { value: '/ask', descriptionKey: 'sp.slash.ask' },
  { value: '/plan', descriptionKey: 'sp.slash.plan' },
];
const OUT_OF_BAND_SLASH_COMMANDS = new Set([
  '/help',
  '/show-scratchpad',
  '/list-schedules',
  '/dangerously-skip-permissions',
  '/screenshot',
  '/export',
  '/verbose',
]);

function normalizeScreenshotRequestText(text) {
  return String(text || '')
    .trim()
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\u0131/g, 'i')
    .replace(/[.!?]+$/g, '')
    .replace(/\s+/g, ' ');
}

function isPlainScreenshotRequest(text) {
  const s = normalizeScreenshotRequestText(text);
  if (!s || s.startsWith('/')) return false;
  return /^(?:please |pls )?(?:screenshot|screen ?shot)(?: (?:please|pls))?$/.test(s)
    || /^(?:please |pls |can you |could you |would you )?(?:take|capture|grab|show|get) (?:a |the |this |current )?(?:screen ?shot|screenshot)(?: (?:of|for) (?:the |this |current )?(?:page|tab|screen|window))?$/.test(s)
    || /^(?:lutfen )?(?:screenshot|screen ?shot|ekran goruntusu)(?: (?:al|cek|goster|at))?$/.test(s)
    || /^(?:lutfen )?(?:bu |mevcut |aktif )?(?:sekmenin|sayfanin|ekranin) ekran goruntusunu (?:al|cek|goster|at)$/.test(s);
}

function isPlainFullPageScreenshotRequest(text) {
  const s = normalizeScreenshotRequestText(text);
  if (!s || s.startsWith('/')) return false;
  return /^(?:please |pls )?(?:(?:full|whole|entire|complete) page|fullpage|long) (?:screenshot|screen ?shot)(?: (?:please|pls))?$/.test(s)
    || /^(?:please |pls |can you |could you |would you )?(?:take|capture|grab|show|get) (?:a |the |this )?(?:(?:full|whole|entire|complete) page|fullpage|long) (?:screenshot|screen ?shot)(?: (?:of|for) (?:the |this |current )?(?:page|tab|screen|window))?$/.test(s)
    || /^(?:lutfen )?(?:tam sayfa|butun sayfa|tum sayfa|uzun) ekran goruntusu(?: (?:al|cek|goster|at))?$/.test(s)
    || /^(?:lutfen )?(?:bu |mevcut |aktif )?(?:sayfanin|sekmenin) (?:tam|butun|tum) ekran goruntusunu (?:al|cek|goster|at)$/.test(s);
}

function normalizeScreenshotCommandText(text) {
  if (isPlainFullPageScreenshotRequest(text)) return '/full-page-screenshot';
  if (isPlainScreenshotRequest(text)) return '/screenshot';
  return text;
}

const SLASH_COMMAND_OPTION_ID_PREFIX = 'slash-command-option-';
const BUSY_SLASH_NOTICE_COOLDOWN_MS = 3000;
let placeholderRotationIndex = 0;
let placeholderRotationTimer = null;
// Tab Recorder (v7.4) — recording is user-driven via slash commands. The
// `/record` tab-capture path shows this live red banner; `/record-full-screen`
// deliberately does not, so the selected browser window is less likely to
// include WebBrain UI in the recording.
const recordingBanner = document.getElementById('recording-banner');
const recordingTimerEl = document.getElementById('recording-timer');
const recordingStopBtn = document.getElementById('btn-recording-stop');

let currentTabId = null;
let renderedTabId = null;
let pendingTabSwitch = null; // tab the user switched to while isProcessing was true
let tabSwitchTransitionId = null;
let queuedTabSwitchMessages = [];
const pendingAttachmentsByTab = new Map(); // tabId -> [{ kind: 'image'|'document'|'text', name, dataUrl?, textContent? }]
const attachmentReadCountsByTab = new Map();
const attachmentGenerationByTab = new Map();
let isProcessing = false;
let currentAssistantEl = null;
let verboseMode = false;
let agentMode = 'ask'; // 'ask' or 'act'
let abortRequested = false;
let recommendationsRequestId = 0;
let providerSelectionRequestId = 0;
let providerTestRequestId = 0;
let recommendedActionsCollapsed = false;
let slashCommandMatches = [];
let slashCommandSelectedIndex = 0;
let busySlashNoticeLastShownAt = 0;
const {
  acceptContextMenuPrompt,
  drainQueuedContextMenuPrompts,
  consumePendingContextMenuPrompt,
  clearQueuedForTab,
} = createContextMenuPromptHandler({
  getCurrentTabId: () => currentTabId,
  getIsProcessing: () => isProcessing,
  getAgentMode: () => agentMode,
  setMode,
  getInputEl: () => inputEl,
  autoResizeInput,
  sendMessage,
  sendToBackground,
});
// Completion notification + success celebration. Default on; togglable via Settings.
let notifySoundEnabled = true;
let completionConfettiEnabled = true;
let notifyAudio = null;
let completionConfettiTimer = null;
chrome.storage.local.get(['notifySound', 'completionConfetti']).then((stored) => {
  if (stored && stored.notifySound === false) notifySoundEnabled = false;
  if (stored && stored.completionConfetti === false) completionConfettiEnabled = false;
}).catch(() => {});
chrome.storage.onChanged.addListener((changes) => {
  if (changes.notifySound) {
    notifySoundEnabled = changes.notifySound.newValue !== false;
  }
  if (changes.completionConfetti) {
    completionConfettiEnabled = changes.completionConfetti.newValue !== false;
  }
});

// Act-mode risk banner is only meaningful when the permission gate is OFF.
// With "Ask before consequential actions" ON (the default) the user is
// prompted per consequential action, so the standing banner is redundant —
// only surface it in Act mode when the gate is disabled.
const PERMISSION_GATE_KEY = 'askBeforeConsequentialActions';
let askBeforeConsequential = true; // gate ON by default
chrome.storage.local.get(PERMISSION_GATE_KEY).then((stored) => {
  if (stored && stored[PERMISSION_GATE_KEY] === false) askBeforeConsequential = false;
  updateActWarning();
}).catch(() => {});
chrome.storage.onChanged.addListener((changes) => {
  if (changes[PERMISSION_GATE_KEY]) {
    askBeforeConsequential = changes[PERMISSION_GATE_KEY].newValue !== false;
    updateActWarning();
  }
});

function updateActWarning() {
  if (!actWarning) return;
  const show = agentMode === 'act' && !askBeforeConsequential;
  actWarning.classList.toggle('hidden', !show);
}

/**
 * Play a short chime when the agent finishes a task. Lazy-creates the Audio
 * element the first time and reuses it after that — sidepanel.html is an
 * extension page so loading /assets/notification.mp3 works without any
 * web_accessible_resources entry. Best-effort: if autoplay is blocked (very
 * occasional first-load case in Chrome) we just swallow the error.
 */
function playCompletionSound() {
  if (!notifySoundEnabled) return;
  try {
    if (!notifyAudio) {
      notifyAudio = new Audio(chrome.runtime.getURL('assets/notification.mp3'));
      notifyAudio.volume = 0.6;
    }
    notifyAudio.currentTime = 0;
    const p = notifyAudio.play();
    if (p && typeof p.catch === 'function') p.catch(() => {});
  } catch { /* ignore */ }
}

function triggerCompletionConfetti() {
  if (!completionConfettiEnabled) return;
  if (globalThis.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches) return;
  try {
    document.querySelector('.completion-confetti')?.remove();
    if (completionConfettiTimer) {
      clearTimeout(completionConfettiTimer);
      completionConfettiTimer = null;
    }

    const layer = document.createElement('div');
    layer.className = 'completion-confetti';
    layer.setAttribute('aria-hidden', 'true');
    const colors = ['#4caf50', '#6c63ff', '#ffb703', '#ef476f', '#00b4d8', '#f77f00'];
    for (let i = 0; i < 42; i += 1) {
      const piece = document.createElement('span');
      piece.className = 'confetti-piece';
      piece.style.setProperty('--x', `${Math.random() * 100}%`);
      piece.style.setProperty('--drift', `${Math.round((Math.random() - 0.5) * 160)}px`);
      piece.style.setProperty('--delay', `${Math.random() * 0.28}s`);
      piece.style.setProperty('--duration', `${1.55 + Math.random() * 0.95}s`);
      piece.style.setProperty('--rotation', `${Math.round(240 + Math.random() * 600)}deg`);
      const size = 5 + Math.random() * 5;
      piece.style.setProperty('--size', `${size}px`);
      piece.style.setProperty('--height', `${size * 1.7}px`);
      piece.style.backgroundColor = colors[i % colors.length];
      layer.appendChild(piece);
    }
    document.body.appendChild(layer);
    completionConfettiTimer = setTimeout(() => {
      layer.remove();
      completionConfettiTimer = null;
    }, 3000);
  } catch { /* ignore */ }
}

function notifyCompletion({ success = false } = {}) {
  playCompletionSound();
  if (success) triggerCompletionConfetti();
}

function isSuccessfulDoneUpdate(update) {
  const result = update?.data?.result;
  return update?.type === 'tool_result' &&
    update?.data?.name === 'done' &&
    result?.done === true &&
    result?.outcome === 'success' &&
    result?.success !== false &&
    !result?.error &&
    !result?.blockedDone;
}

function updatesContainSuccessfulDone(updates) {
  return Array.isArray(updates) && updates.some(isSuccessfulDoneUpdate);
}

// Per-tab chat history (stores innerHTML of messages container).
// Also mirrored to chrome.storage.session keyed `tabChat:<tabId>` so the
// conversation survives the side panel being closed and reopened.
const tabChats = new Map();
const TAB_CHAT_PREFIX = 'tabChat:';
const tabChatOperations = new Map();
const tabInputDrafts = new Map();
const queuedComposerMessagesByTab = new Map();
let queuedComposerMessageSeq = 0;

function enqueueTabChatOperation(tabId, fn) {
  const numericTabId = Number(tabId);
  if (!Number.isFinite(numericTabId)) return Promise.resolve({ ok: true });
  const previous = tabChatOperations.get(numericTabId) || Promise.resolve();
  const operation = previous.catch(() => {}).then(() => fn(numericTabId));
  tabChatOperations.set(numericTabId, operation);
  operation.finally(() => {
    if (tabChatOperations.get(numericTabId) === operation) tabChatOperations.delete(numericTabId);
  }).catch(() => {});
  return operation;
}

async function loadTabChat(tabId) {
  const numericTabId = Number(tabId);
  if (!Number.isFinite(numericTabId)) return null;
  if (!tabChatOperations.has(numericTabId) && tabChats.has(numericTabId)) return tabChats.get(numericTabId);
  try {
    return await enqueueTabChatOperation(numericTabId, async (queuedTabId) => {
      if (tabChats.has(queuedTabId)) return tabChats.get(queuedTabId);
      const key = TAB_CHAT_PREFIX + queuedTabId;
      const stored = await chrome.storage.session.get(key);
      const html = stored?.[key];
      if (typeof html === 'string') {
        tabChats.set(queuedTabId, html);
        return html;
      }
      return null;
    });
  } catch (e) { /* ignore */ }
  return null;
}

function persistTabChat(tabId, html) {
  if (tabId == null) return;
  return enqueueTabChatOperation(tabId, async (numericTabId) => {
    tabChats.set(numericTabId, html);
    const key = TAB_CHAT_PREFIX + numericTabId;
    try {
      await chrome.storage.session.set({ [key]: html }).catch(() => {});
    } catch (e) { /* ignore */ }
    return { ok: true };
  });
}

async function flushRenderedTabChat() {
  const tabId = renderedTabId;
  if (tabId == null) return;
  if (persistTimer && persistTimerTabId === tabId) {
    clearTimeout(persistTimer);
    persistTimer = null;
    persistTimerTabId = null;
  }
  await persistTabChat(tabId, messagesEl.innerHTML);
}

function clearCachedTabChat(tabId) {
  if (tabId == null) return;
  if (persistTimer && persistTimerTabId === tabId) {
    clearTimeout(persistTimer);
    persistTimer = null;
    persistTimerTabId = null;
  }
  tabChats.delete(tabId);
  return enqueueTabChatOperation(tabId, async (numericTabId) => {
    tabChats.delete(numericTabId);
    try {
      await chrome.storage.session?.remove(TAB_CHAT_PREFIX + numericTabId).catch(() => {});
    } catch (e) { /* ignore */ }
    return { ok: true };
  });
}

function saveInputDraftForTab(tabId, text) {
  const numericTabId = Number(tabId);
  if (!Number.isFinite(numericTabId)) return;
  const draft = String(text || '');
  if (draft.trim()) {
    tabInputDrafts.set(numericTabId, draft);
  } else {
    tabInputDrafts.delete(numericTabId);
  }
}

function captureInputDraftForTab(tabId) {
  if (!inputEl) return;
  saveInputDraftForTab(tabId, inputEl.value || '');
}

function restoreInputDraftForTab(tabId) {
  if (!inputEl) return;
  const numericTabId = Number(tabId);
  const draft = Number.isFinite(numericTabId) ? tabInputDrafts.get(numericTabId) || '' : '';
  inputEl.value = draft;
  autoResizeInput();
  updateSlashCommandAutocomplete();
  syncSendButtonState();
}

function sameTabId(a, b) {
  return a != null && b != null && String(a) === String(b);
}

function getQueuedComposerMessages(tabId) {
  const numericTabId = Number(tabId);
  if (!Number.isFinite(numericTabId)) return [];
  return queuedComposerMessagesByTab.get(numericTabId) || [];
}

function setQueuedComposerMessages(tabId, messages) {
  const numericTabId = Number(tabId);
  if (!Number.isFinite(numericTabId)) return;
  if (messages.length) {
    queuedComposerMessagesByTab.set(numericTabId, messages);
  } else {
    queuedComposerMessagesByTab.delete(numericTabId);
  }
  if (sameTabId(currentTabId, numericTabId)) renderQueuedComposerMessages(numericTabId);
}

function queuedComposerButton(className, action, queueId, labelKey, svgPath) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = `queued-message-action ${className}`;
  btn.dataset.queueAction = action;
  btn.dataset.queueId = queueId;
  btn.title = t(labelKey);
  btn.setAttribute('aria-label', t(labelKey));
  btn.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${svgPath}</svg>`;
  return btn;
}

function renderQueuedComposerMessages(tabId = currentTabId) {
  if (!queuedMessagesEl) return;
  const messages = getQueuedComposerMessages(tabId);
  queuedMessagesEl.replaceChildren();
  queuedMessagesEl.classList.toggle('hidden', messages.length === 0);
  if (!messages.length) return;

  messages.forEach((item, index) => {
    const row = document.createElement('div');
    row.className = 'queued-message';
    row.dataset.queueId = item.id;
    row.setAttribute('role', 'listitem');

    const label = document.createElement('span');
    label.className = 'queued-message-label';
    label.textContent = messages.length > 1
      ? t('sp.queue.label_numbered', { index: index + 1 })
      : t('sp.queue.label');

    const text = document.createElement('span');
    text.className = 'queued-message-text';
    text.textContent = item.text;
    text.title = item.text;

    const edit = queuedComposerButton(
      'queued-message-edit',
      'edit',
      item.id,
      'sp.queue.edit',
      '<path d="M12 19V5"></path><path d="M5 12l7-7 7 7"></path>',
    );
    const remove = queuedComposerButton(
      'queued-message-delete',
      'delete',
      item.id,
      'sp.queue.delete',
      '<path d="M18 6L6 18"></path><path d="M6 6l12 12"></path>',
    );

    row.append(label, text, edit, remove);
    queuedMessagesEl.appendChild(row);
  });
}

function shiftQueuedComposerMessage(tabId) {
  const queue = getQueuedComposerMessages(tabId);
  if (!queue.length) return null;
  const [item, ...remaining] = queue;
  setQueuedComposerMessages(tabId, remaining);
  return item;
}

function removeQueuedComposerMessage(tabId, queueId) {
  const queue = getQueuedComposerMessages(tabId);
  const index = queue.findIndex((item) => item.id === queueId);
  if (index === -1) return null;
  const nextQueue = queue.slice();
  const [item] = nextQueue.splice(index, 1);
  setQueuedComposerMessages(tabId, nextQueue);
  return item;
}

function enqueueQueuedComposerMessage(tabId, text) {
  const numericTabId = Number(tabId);
  const queuedText = String(text || '').trim();
  if (!Number.isFinite(numericTabId) || !queuedText) return false;
  const queue = getQueuedComposerMessages(numericTabId).slice();
  queue.push({
    id: `queued-${Date.now()}-${++queuedComposerMessageSeq}`,
    text: queuedText,
  });
  setQueuedComposerMessages(numericTabId, queue);
  if (sameTabId(currentTabId, numericTabId)) {
    saveInputDraftForTab(numericTabId, '');
    hideSlashCommandAutocomplete();
    inputEl.value = '';
    autoResizeInput();
    syncSendButtonState();
  }
  return true;
}

function editQueuedComposerMessage(tabId, queueId) {
  if (!sameTabId(currentTabId, tabId)) return;
  const item = removeQueuedComposerMessage(tabId, queueId);
  if (!item) return;
  inputEl.value = item.text;
  saveInputDraftForTab(tabId, item.text);
  autoResizeInput();
  updateSlashCommandAutocomplete();
  syncSendButtonState();
  inputEl.focus();
  inputEl.setSelectionRange(inputEl.value.length, inputEl.value.length);
}

function editLastQueuedComposerMessageForCurrentTab() {
  if (!inputEl || currentTabId == null) return false;
  const atStart = inputEl.selectionStart === 0 && inputEl.selectionEnd === 0;
  if (inputEl.value.trim() || !atStart) return false;
  const queue = getQueuedComposerMessages(currentTabId);
  const item = queue[queue.length - 1];
  if (!item) return false;
  editQueuedComposerMessage(currentTabId, item.id);
  return true;
}

function deleteQueuedComposerMessage(tabId, queueId) {
  removeQueuedComposerMessage(tabId, queueId);
}

function clearQueuedComposerMessagesForTab(tabId) {
  const numericTabId = Number(tabId);
  if (!Number.isFinite(numericTabId)) return;
  queuedComposerMessagesByTab.delete(numericTabId);
  if (sameTabId(currentTabId, numericTabId)) renderQueuedComposerMessages(numericTabId);
}

function drainQueuedComposerMessageForCurrentTab() {
  if (isProcessing || currentTabId == null || renderedTabId !== currentTabId) return false;
  if (inputEl.value.trim()) return false;
  const item = shiftQueuedComposerMessage(currentTabId);
  if (!item) return false;
  inputEl.value = item.text;
  autoResizeInput();
  updateSlashCommandAutocomplete();
  syncSendButtonState();
  Promise.resolve().then(() => sendMessage()).catch((e) => {
    addMessage('error', t('sp.error_prefix', { msg: e?.message || String(e) }));
  });
  return true;
}

function renderClearedConversationForTab(tabId) {
  clearCachedTabChat(tabId);
  saveInputDraftForTab(tabId, '');
  clearPendingAttachmentsForTab(tabId);
  clearQueuedComposerMessagesForTab(tabId);
  setApiMutationsAllowedForTab(tabId, false);
  if (currentTabId !== tabId) return;
  renderedTabId = tabId;
  messagesEl.innerHTML = '';
  inputEl.value = '';
  autoResizeInput();
  syncSendButtonState();
  addMessage('system', t('sp.cleared_message'));
  refreshScheduledJobs({ tabId });
  refreshRecommendedActions();
}

// Save current tab's chat to storage on a debounced cadence — we don't want
// to thrash storage on every keystroke / streamed token.
let persistTimer = null;
let persistTimerTabId = null;
function schedulePersist() {
  if (persistTimer) clearTimeout(persistTimer);
  const tabId = renderedTabId;
  const html = messagesEl.innerHTML;
  persistTimerTabId = tabId;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    persistTimerTabId = null;
    if (tabId != null) persistTabChat(tabId, html);
  }, 400);
}

// Observe the messages container so any DOM mutation (new message, streamed
// delta, tool step update) eventually gets persisted.
const persistObserver = new MutationObserver(schedulePersist);

// Tool names → i18n key for the human-friendly label. Resolved at render
// time so language changes take effect without a reload.
const TOOL_KEYS = {
  read_page: 'tool.read_page',
  get_interactive_elements: 'tool.get_interactive_elements',
  click: 'tool.click',
  type_text: 'tool.type_text',
  scroll: 'tool.scroll',
  navigate: 'tool.navigate',
  go_back: 'tool.go_back',
  go_forward: 'tool.go_forward',
  extract_data: 'tool.extract_data',
  inspect_element_styles: 'tool.inspect_element_styles',
  read_page_source: 'tool.read_page_source',
  wait_for_element: 'tool.wait_for_element',
  get_selection: 'tool.get_selection',
  new_tab: 'tool.new_tab',
  schedule_resume: 'tool.schedule_resume',
  schedule_task: 'tool.schedule_task',
  done: 'tool.done',
};

function friendlyToolLabel(name, args) {
  // Add context from args where it makes sense
  if (name === 'click' && args?.selector) return t('tool.click.selector', { selector: truncate(args.selector, 30) });
  if (name === 'click' && args?.index != null) return t('tool.click.index', { index: args.index });
  if (name === 'type_text' && args?.text) return t('tool.type_text.text', { text: truncate(args.text, 25) });
  if (name === 'navigate' && args?.url) return t('tool.navigate.url', { url: truncate(args.url, 35) });
  if (name === 'new_tab' && args?.url) return t('tool.new_tab.url', { url: truncate(args.url, 35) });
  if (name === 'scroll') return t('tool.scroll.direction', { direction: args?.direction || 'down' });
  if (name === 'extract_data') return t('tool.extract_data.type', { type: args?.type || 'data' });
  if (name === 'wait_for_element' && args?.selector) return t('tool.wait_for_element.selector', { selector: truncate(args.selector, 30) });
  const key = TOOL_KEYS[name];
  return key ? t(key) : name;
}

function formatScheduledTime(value) {
  const ms = Date.parse(value || '');
  if (!Number.isFinite(ms)) return t('sp.scheduled.time_unknown');
  try {
    return new Intl.DateTimeFormat(undefined, {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    }).format(new Date(ms));
  } catch {
    return new Date(ms).toLocaleString();
  }
}

function scheduledStatusLabel(status) {
  return t(`sp.scheduled.status.${status || 'pending'}`);
}

function scheduledJobTitle(job) {
  return String(job?.title || (job?.kind === 'resume' ? t('sp.scheduled.resume_title') : t('sp.scheduled.task_title')));
}

function scheduledJobMeta(job) {
  const parts = [scheduledStatusLabel(job.status)];
  if (job.nextRunAt && ['pending', 'queued', 'paused'].includes(job.status)) {
    parts.push(t('sp.scheduled.next', { time: formatScheduledTime(job.nextRunAt) }));
  }
  if (job.schedule?.type === 'recurring' && job.schedule?.interval_minutes) {
    parts.push(t('sp.scheduled.recurring', { minutes: job.schedule.interval_minutes }));
  }
  if (job.status === 'needs_user_input' && job.pendingClarify?.question) {
    parts.push(truncate(String(job.pendingClarify.question), 80));
  }
  if (job.status === 'completed' && job.lastResult) {
    parts.push(truncate(String(job.lastResult), 80));
  }
  if (job.lastError) {
    parts.push(truncate(String(job.lastError), 80));
  }
  return parts.filter(Boolean).join(' · ');
}

function scheduledJobActions(job) {
  const actions = [];
  if (job.status === 'paused') {
    actions.push(['resume', t('sp.scheduled.resume')], ['delete', t('sp.scheduled.delete')]);
  } else if (['pending', 'queued', 'needs_user_input'].includes(job.status)) {
    actions.push(['run', t('sp.scheduled.run_now')], ['pause', t('sp.scheduled.pause')], ['cancel', t('sp.scheduled.cancel')]);
  } else if (job.status === 'running') {
    actions.push(['cancel', t('sp.scheduled.cancel')]);
  } else if (['failed', 'completed', 'cancelled'].includes(job.status)) {
    actions.push(['delete', t('sp.scheduled.delete')]);
  }
  return actions;
}

const SCHEDULED_VISIBLE_STATUSES = new Set(['pending', 'queued', 'paused', 'running', 'needs_user_input', 'failed', 'completed']);
const COMPLETED_SCHEDULED_JOB_AUTO_HIDE_MS = 15 * 1000;
const crossPanelScheduledJobIds = new Set();
const pinnedCompletedScheduledJobIds = new Set();
let scheduledJobAutoHideTimer = null;

function visibleScheduledJobs(jobs = []) {
  const now = Date.now();
  return jobs.filter((job) => {
    if (!SCHEDULED_VISIBLE_STATUSES.has(job.status)) return false;
    if (job.status !== 'completed') return true;
    if (pinnedCompletedScheduledJobIds.has(String(job.id || ''))) return true;
    const completedAt = Date.parse(job?.completedAt || job?.updatedAt || job?.lastRunAt || '');
    if (!Number.isFinite(completedAt)) return true;
    return now - completedAt < COMPLETED_SCHEDULED_JOB_AUTO_HIDE_MS;
  });
}

function scheduleCompletedJobAutoHide(jobs = []) {
  if (scheduledJobAutoHideTimer) {
    clearTimeout(scheduledJobAutoHideTimer);
    scheduledJobAutoHideTimer = null;
  }
  const now = Date.now();
  let nextDelay = Infinity;
  for (const job of jobs) {
    if (job?.status !== 'completed') continue;
    if (pinnedCompletedScheduledJobIds.has(String(job.id || ''))) continue;
    const completedAt = Date.parse(job?.completedAt || job?.updatedAt || job?.lastRunAt || '');
    if (!Number.isFinite(completedAt)) continue;
    const remaining = COMPLETED_SCHEDULED_JOB_AUTO_HIDE_MS - (now - completedAt);
    if (remaining > 0) nextDelay = Math.min(nextDelay, remaining);
  }
  if (Number.isFinite(nextDelay)) {
    scheduledJobAutoHideTimer = setTimeout(() => {
      scheduledJobAutoHideTimer = null;
      refreshScheduledJobs();
    }, Math.max(0, Math.ceil(nextDelay)));
  }
}

function scheduledJobTabId(job) {
  const tabId = job?.tabId ?? job?.target?.tabId ?? null;
  if (tabId == null) return null;
  const numeric = Number(tabId);
  return Number.isFinite(numeric) ? numeric : tabId;
}

function isUrlTargetScheduledJob(job) {
  return job?.kind === 'task' && job?.target?.type === 'url';
}

function findScheduledClarifyCard(jobId, clarifyId) {
  for (const card of messagesEl?.querySelectorAll?.('.clarify-card[data-scheduled-job-id]') || []) {
    if (card.dataset.scheduledJobId === String(jobId) && card.dataset.clarifyId === String(clarifyId)) {
      return card;
    }
  }
  return null;
}

function findScheduledClarifyCardForJob(jobId) {
  for (const card of messagesEl?.querySelectorAll?.('.clarify-card[data-scheduled-job-id]') || []) {
    if (card.dataset.scheduledJobId === String(jobId)) return card;
  }
  return null;
}

function findScheduledAssistantMessageForJob(jobId) {
  const id = String(jobId || '');
  if (!id) return null;
  for (const msgEl of messagesEl?.querySelectorAll?.('.message.assistant[data-scheduled-job-id]') || []) {
    if (msgEl.dataset.scheduledJobId === id) return msgEl;
  }
  const card = findScheduledClarifyCardForJob(id);
  const msgEl = card?.closest?.('.message.assistant');
  if (msgEl) return msgEl;
  if (currentAssistantEl?.dataset?.scheduledJobId === id) return currentAssistantEl;
  return null;
}

function ensureScheduledTerminalMessage(job) {
  const jobId = job?.id ? String(job.id) : '';
  if (!jobId || !isUrlTargetScheduledJob(job)) return null;
  const existing = findScheduledAssistantMessageForJob(jobId);
  if (existing) return existing;
  const msgEl = addMessage('assistant', '');
  msgEl.dataset.scheduledJobId = jobId;
  return msgEl;
}

function ensureScheduledClarifyCards(jobs = []) {
  if (!messagesEl) return;
  for (const job of jobs) {
    const pending = job?.pendingClarify;
    if (job?.status !== 'needs_user_input' || !pending?.clarifyId) continue;
    const jobTabId = scheduledJobTabId(job);
    if (!isUrlTargetScheduledJob(job) && jobTabId != null && currentTabId != null && String(jobTabId) !== String(currentTabId)) continue;
    if (findScheduledClarifyCard(job.id, pending.clarifyId)) continue;
    const isCrossPanel = isUrlTargetScheduledJob(job) && jobTabId != null && currentTabId != null && String(jobTabId) !== String(currentTabId);
    if (isCrossPanel) crossPanelScheduledJobIds.add(String(job.id));
    renderClarifyCard({
      ...pending,
      scheduledJobId: job.id,
      scheduledTabId: jobTabId,
      forceNewScheduledCard: true,
    });
  }
}

function renderScheduledJobs(jobs = []) {
  if (!scheduledJobsEl) return;
  const visible = visibleScheduledJobs(jobs);
  scheduleCompletedJobAutoHide(jobs);
  scheduledJobsEl.replaceChildren();
  scheduledJobsEl.classList.toggle('hidden', visible.length === 0);
  for (const job of visible) {
    const card = document.createElement('div');
    card.className = 'scheduled-job-card';
    card.dataset.jobId = job.id;
    card.dataset.status = job.status;

    const title = document.createElement('div');
    title.className = 'scheduled-job-title';
    title.textContent = scheduledJobTitle(job);
    card.appendChild(title);

    const actions = document.createElement('div');
    actions.className = 'scheduled-job-actions';
    for (const [action, label] of scheduledJobActions(job)) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.dataset.action = action;
      btn.dataset.jobId = job.id;
      btn.textContent = label;
      actions.appendChild(btn);
    }
    card.appendChild(actions);

    const meta = document.createElement('div');
    meta.className = 'scheduled-job-meta';
    meta.textContent = scheduledJobMeta(job);
    card.appendChild(meta);

    scheduledJobsEl.appendChild(card);
  }
  ensureScheduledClarifyCards(visible);
}

async function refreshScheduledJobs({ tabId = null } = {}) {
  if (!scheduledJobsEl) return;
  try {
    const response = await sendToBackground('list_scheduled_jobs', { all: true });
    const jobs = response?.jobs || [];
    if (tabId != null && currentTabId !== tabId) return jobs;
    renderScheduledJobs(jobs);
    return jobs;
  } catch (e) {
    console.warn('[WebBrain] failed to refresh scheduled jobs:', e);
    return [];
  }
}

async function scheduledJobAction(action, jobId) {
  const actionMap = {
    run: 'run_scheduled_job_now',
    pause: 'pause_scheduled_job',
    resume: 'resume_scheduled_job',
    cancel: 'cancel_scheduled_job',
    delete: 'delete_scheduled_job',
  };
  const bgAction = actionMap[action];
  if (!bgAction || !jobId) return;
  const tabId = currentTabId;
  try {
    const response = await sendToBackground(bgAction, { jobId });
    if (response && (response.ok === false || response.success === false)) {
      if (currentTabId === tabId) {
        addMessage('error', t('sp.error_prefix', { msg: response.error || 'Scheduled job action failed.' }));
      }
    }
    await refreshScheduledJobs({ tabId });
  } catch (e) {
    if (currentTabId === tabId) {
      addMessage('error', t('sp.error_prefix', { msg: e.message }));
    }
  }
}

async function drainQueuedContextMenuPromptsAfterPendingTabSwitch() {
  if (drainQueuedComposerMessageForCurrentTab()) return;
  if (pendingTabSwitch == null) {
    drainQueuedContextMenuPrompts();
    return;
  }
  const pending = pendingTabSwitch;
  pendingTabSwitch = null;
  try {
    await switchToTab(pending);
  } catch {
    // Still drain any queued prompt for the current tab; tab activation can fail
    // when the underlying browser tab disappears during run settlement.
  }
  if (drainQueuedComposerMessageForCurrentTab()) return;
  drainQueuedContextMenuPrompts();
}

function queueAgentUpdateDuringTabSwitch(msg) {
  const tabId = msg?.tabId;
  if (tabSwitchTransitionId == null || tabId == null || tabId !== tabSwitchTransitionId) return false;
  queuedTabSwitchMessages.push(msg);
  return true;
}

function drainQueuedAgentUpdatesForTab(tabId) {
  if (!queuedTabSwitchMessages.length) return;
  const replay = [];
  const remaining = [];
  for (const msg of queuedTabSwitchMessages) {
    if (msg?.tabId === tabId) replay.push(msg);
    else remaining.push(msg);
  }
  queuedTabSwitchMessages = remaining;
  replay.forEach((msg) => handleAgentUpdateMessage(msg));
}

async function settleScheduledRun(event, job) {
  if (job?.id) crossPanelScheduledJobIds.delete(String(job.id));
  const assistantEl = job?.id ? findScheduledAssistantMessageForJob(job.id) : currentAssistantEl;
  if (assistantEl) {
    finalizeSteps(assistantEl);
    const textEl = assistantEl.querySelector('.message-text');
    if (textEl && !textEl.textContent.trim() && event === 'completed' && job?.lastResult) {
      textEl.innerHTML = formatMarkdown(job.lastResult);
      addMessageCopyButton(assistantEl);
    }
  }
  const ownsActiveRun = !currentAssistantEl || currentAssistantEl === assistantEl;
  if (ownsActiveRun) {
    isProcessing = false;
    syncSendButtonState();
    hideActivity();
    if (currentAssistantEl === assistantEl) currentAssistantEl = null;
    abortRequested = false;
    if (renderedTabId != null) await flushRenderedTabChat();
    await drainQueuedContextMenuPromptsAfterPendingTabSwitch();
  }
  if (event === 'completed') notifyCompletion({ success: job?.lastOutcome === 'success' });
}

async function handleScheduledJobEvent(data, tabId) {
  refreshScheduledJobs({ tabId: currentTabId });
  const event = data?.event;
  const job = data?.job;
  if (!event || !job) return;

  const sameTab = tabId == null || tabId === currentTabId;
  const jobId = job?.id ? String(job.id) : '';
  const terminalScheduledEvent = ['completed', 'failed'].includes(event);
  const crossPanelScheduledEvent = isUrlTargetScheduledJob(job) && (
    event === 'needs_user_input' ||
    terminalScheduledEvent
  );
  if (!sameTab && !crossPanelScheduledEvent) return;

  const title = scheduledJobTitle(job);
  if (event === 'created') {
    addMessage('system', systemHtml(tSystemHtml('sp.scheduled.created', { title, time: formatScheduledTime(job.nextRunAt || job.scheduledAt) })));
  } else if (event === 'running') {
    isProcessing = true;
    abortRequested = false;
    syncSendButtonState();
    currentAssistantEl = addMessage('assistant', '');
    if (jobId) currentAssistantEl.dataset.scheduledJobId = jobId;
    showActivity(t('sp.scheduled.running', { title }));
  } else if (event === 'completed') {
    ensureScheduledTerminalMessage(job);
    await settleScheduledRun(event, job);
  } else if (event === 'failed') {
    addMessage('error', t('sp.scheduled.failed', { title, msg: job.lastError || t('sp.scheduled.unknown_error') }));
    await settleScheduledRun(event, job);
  } else if (event === 'needs_user_input') {
    ensureScheduledClarifyCards([job]);
    hideActivity();
    abortRequested = false;
    if (currentAssistantEl) {
      isProcessing = true;
      syncSendButtonState();
    } else {
      isProcessing = false;
      syncSendButtonState();
      addMessage('system', systemHtml(tSystemHtml('sp.scheduled.needs_user_input', { title })));
      drainQueuedContextMenuPromptsAfterPendingTabSwitch();
    }
  }
}

if (scheduledJobsEl) {
  scheduledJobsEl.addEventListener('click', (e) => {
    const card = e.target.closest('.scheduled-job-card[data-job-id]');
    if (card?.dataset.status === 'completed') {
      pinnedCompletedScheduledJobIds.add(String(card.dataset.jobId || ''));
    }
    const btn = e.target.closest('button[data-action][data-job-id]');
    if (!btn) return;
    scheduledJobAction(btn.dataset.action, btn.dataset.jobId);
  });
}

function datetimeLocalValue(ms) {
  const d = new Date(ms);
  const local = new Date(d.getTime() - d.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 16);
}

function isHttpScheduleUrl(value) {
  try {
    const url = new URL(String(value || ''));
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

async function getCurrentScheduleUrl(tabId = currentTabId) {
  if (tabId == null) return '';
  try {
    const tab = await chrome.tabs.get(tabId);
    return tab?.url || '';
  } catch {
    return '';
  }
}

function addScheduleField(form, labelText, control) {
  const label = document.createElement('label');
  label.className = 'schedule-field';
  const span = document.createElement('span');
  span.textContent = labelText;
  label.appendChild(span);
  label.appendChild(control);
  form.appendChild(label);
  return label;
}

function getScheduleComposerControls(form) {
  return {
    titleInput: form?.querySelector('.schedule-title'),
    promptInput: form?.querySelector('.schedule-prompt'),
    scheduleType: form?.querySelector('.schedule-type'),
    timeMode: form?.querySelector('.schedule-time-mode'),
    afterInput: form?.querySelector('.schedule-after'),
    runAtInput: form?.querySelector('.schedule-run-at'),
    intervalInput: form?.querySelector('.schedule-interval'),
    targetType: form?.querySelector('.schedule-target-type'),
    urlInput: form?.querySelector('.schedule-url'),
    modeInput: form?.querySelector('.schedule-mode'),
    errorEl: form?.querySelector('.schedule-error'),
    submit: form?.querySelector('.schedule-submit'),
    cancel: form?.querySelector('.schedule-cancel'),
  };
}

function getScheduleComposerTabId(form) {
  const rawTabId = form?.dataset?.tabId;
  const parsed = rawTabId != null && rawTabId !== '' ? Number(rawTabId) : currentTabId;
  return Number.isFinite(parsed) ? parsed : currentTabId;
}

function updateScheduleComposerVisibility(form) {
  const { scheduleType, timeMode, afterInput, runAtInput, intervalInput, targetType, urlInput } = getScheduleComposerControls(form);
  afterInput?.closest('.schedule-field')?.classList.toggle('hidden', timeMode?.value !== 'after');
  runAtInput?.closest('.schedule-field')?.classList.toggle('hidden', timeMode?.value !== 'at');
  intervalInput?.closest('.schedule-field')?.classList.toggle('hidden', scheduleType?.value !== 'recurring');
  urlInput?.closest('.schedule-field')?.classList.toggle('hidden', targetType?.value !== 'url');
}

async function submitScheduleComposer(e, form) {
  e.preventDefault();
  const {
    titleInput,
    promptInput,
    scheduleType,
    timeMode,
    afterInput,
    runAtInput,
    intervalInput,
    targetType,
    urlInput,
    modeInput,
    errorEl,
    submit,
  } = getScheduleComposerControls(form);
  const tabId = getScheduleComposerTabId(form);
  if (tabId == null || !promptInput || !scheduleType || !timeMode || !afterInput || !runAtInput || !intervalInput || !targetType || !urlInput || !modeInput || !errorEl || !submit) {
    return;
  }

  errorEl.textContent = '';
  const prompt = promptInput.value.trim();
  if (!prompt) {
    errorEl.textContent = t('sp.schedule_form.error_prompt');
    return;
  }

  const schedule = { type: scheduleType.value };
  if (timeMode.value === 'after') {
    const minutes = Number(afterInput.value);
    if (!Number.isFinite(minutes) || minutes < 0) {
      errorEl.textContent = t('sp.schedule_form.error_time');
      return;
    }
    schedule.after_seconds = Math.round(minutes * 60);
  } else {
    const runAtMs = Date.parse(runAtInput.value);
    if (!Number.isFinite(runAtMs)) {
      errorEl.textContent = t('sp.schedule_form.error_time');
      return;
    }
    schedule.run_at = new Date(runAtMs).toISOString();
  }
  if (schedule.type === 'recurring') {
    const interval = Number(intervalInput.value);
    if (!Number.isFinite(interval) || interval < 1) {
      errorEl.textContent = t('sp.schedule_form.error_interval');
      return;
    }
    schedule.interval_minutes = Math.floor(interval);
  }

  const target = { type: targetType.value };
  if (target.type === 'url') {
    const url = urlInput.value.trim();
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('bad protocol');
      target.url = parsed.href;
    } catch {
      errorEl.textContent = t('sp.schedule_form.error_url');
      return;
    }
  }

  submit.disabled = true;
  try {
    const title = titleInput?.value?.trim() || prompt.slice(0, 80) || t('sp.scheduled.task_title');
    const res = await sendToBackground('create_scheduled_job', {
      tabId,
      job: { title, prompt, schedule, target, mode: modeInput.value },
    });
    if (res?.success === false || res?.ok === false || !res?.scheduledAt) {
      throw new Error(res?.error || 'Could not create scheduled job.');
    }
    const createdHtml = tSystemHtml('sp.schedule_form.created', {
      title,
      time: formatScheduledTime(res.scheduledAt),
    });
    if (currentTabId !== tabId) {
      replaceCachedScheduleComposer(tabId, form.dataset.composerId, createdHtml);
      return;
    }
    const msgEl = form.closest('.message');
    form.remove();
    const textEl = msgEl?.querySelector('.message-text');
    if (textEl) {
      textEl.innerHTML = createdHtml;
    }
    await refreshScheduledJobs({ tabId });
  } catch (err) {
    if (currentTabId !== tabId) {
      updateCachedScheduleComposerError(tabId, form.dataset.composerId, err.message);
      return;
    }
    submit.disabled = false;
    errorEl.textContent = err.message;
  }
}

function bindScheduleComposer(form) {
  if (!form || form.dataset.bound) return;
  const { scheduleType, timeMode, targetType, cancel } = getScheduleComposerControls(form);
  form.dataset.bound = 'true';
  scheduleType?.addEventListener('change', () => updateScheduleComposerVisibility(form));
  timeMode?.addEventListener('change', () => updateScheduleComposerVisibility(form));
  targetType?.addEventListener('change', () => updateScheduleComposerVisibility(form));
  updateScheduleComposerVisibility(form);
  cancel?.addEventListener('click', () => form.closest('.message')?.remove());
  form.addEventListener('submit', (e) => submitScheduleComposer(e, form));
}

function replaceCachedScheduleComposer(tabId, composerId, html) {
  const cached = tabChats.get(tabId);
  if (typeof cached !== 'string' || !composerId) return;
  const wrapper = document.createElement('div');
  wrapper.innerHTML = cached;
  const form = wrapper.querySelector(`form.schedule-composer[data-composer-id="${composerId}"]`);
  const textEl = form?.closest('.message')?.querySelector('.message-text');
  if (!form || !textEl) return;
  form.remove();
  textEl.innerHTML = html;
  persistTabChat(tabId, wrapper.innerHTML);
}

function updateCachedScheduleComposerError(tabId, composerId, message) {
  const cached = tabChats.get(tabId);
  if (typeof cached !== 'string' || !composerId) return;
  const wrapper = document.createElement('div');
  wrapper.innerHTML = cached;
  const form = wrapper.querySelector(`form.schedule-composer[data-composer-id="${composerId}"]`);
  const submit = form?.querySelector('.schedule-submit');
  const errorEl = form?.querySelector('.schedule-error');
  if (!form || !submit || !errorEl) return;
  submit.disabled = false;
  errorEl.textContent = message || '';
  persistTabChat(tabId, wrapper.innerHTML);
}

async function renderScheduleComposer(prefillPrompt = '', tabId = currentTabId) {
  if (tabId == null) return;
  const initialScheduleUrl = await getCurrentScheduleUrl(tabId);
  if (currentTabId !== tabId) return;

  const msgEl = addMessage('system', t('sp.schedule_form.opened'));
  const content = msgEl.querySelector('.message-content');
  const form = document.createElement('form');
  form.className = 'schedule-composer';
  form.dataset.tabId = String(tabId);
  form.dataset.composerId = `schedule-${Date.now()}-${Math.random().toString(36).slice(2)}`;

  const titleInput = document.createElement('input');
  titleInput.type = 'text';
  titleInput.className = 'schedule-title';
  titleInput.maxLength = 200;
  titleInput.placeholder = t('sp.schedule_form.title_placeholder');
  addScheduleField(form, t('sp.schedule_form.title'), titleInput);

  const promptInput = document.createElement('textarea');
  promptInput.className = 'schedule-prompt';
  promptInput.rows = 4;
  promptInput.required = true;
  promptInput.maxLength = 8000;
  promptInput.placeholder = t('sp.schedule_form.prompt_placeholder');
  promptInput.value = prefillPrompt;
  addScheduleField(form, t('sp.schedule_form.prompt'), promptInput);

  const row = document.createElement('div');
  row.className = 'schedule-row';

  const scheduleType = document.createElement('select');
  scheduleType.className = 'schedule-type';
  scheduleType.innerHTML = `<option value="once">${escapeHtml(t('sp.schedule_form.once'))}</option><option value="recurring">${escapeHtml(t('sp.schedule_form.recurring'))}</option>`;
  addScheduleField(row, t('sp.schedule_form.type'), scheduleType);

  const timeMode = document.createElement('select');
  timeMode.className = 'schedule-time-mode';
  timeMode.innerHTML = `<option value="after">${escapeHtml(t('sp.schedule_form.in_minutes'))}</option><option value="at">${escapeHtml(t('sp.schedule_form.at_time'))}</option>`;
  addScheduleField(row, t('sp.schedule_form.when'), timeMode);
  form.appendChild(row);

  const afterInput = document.createElement('input');
  afterInput.type = 'number';
  afterInput.min = '0';
  afterInput.max = '10080';
  afterInput.step = '1';
  afterInput.value = '10';
  afterInput.className = 'schedule-after';
  addScheduleField(form, t('sp.schedule_form.after_minutes'), afterInput);

  const runAtInput = document.createElement('input');
  runAtInput.type = 'datetime-local';
  runAtInput.value = datetimeLocalValue(Date.now() + 10 * 60 * 1000);
  runAtInput.className = 'schedule-run-at';
  addScheduleField(form, t('sp.schedule_form.run_at'), runAtInput);

  const intervalInput = document.createElement('input');
  intervalInput.type = 'number';
  intervalInput.min = '1';
  intervalInput.step = '1';
  intervalInput.value = '60';
  intervalInput.className = 'schedule-interval';
  addScheduleField(form, t('sp.schedule_form.interval_minutes'), intervalInput);

  const targetType = document.createElement('select');
  targetType.className = 'schedule-target-type';
  targetType.innerHTML = `<option value="current_tab">${escapeHtml(t('sp.schedule_form.current_tab'))}</option><option value="url">${escapeHtml(t('sp.schedule_form.url'))}</option>`;
  addScheduleField(form, t('sp.schedule_form.target'), targetType);

  const urlInput = document.createElement('input');
  urlInput.type = 'url';
  urlInput.className = 'schedule-url';
  urlInput.placeholder = 'https://example.com/';
  addScheduleField(form, t('sp.schedule_form.target_url'), urlInput);
  if (isHttpScheduleUrl(initialScheduleUrl)) {
    urlInput.value = initialScheduleUrl;
    targetType.value = 'url';
  }

  const modeInput = document.createElement('select');
  modeInput.className = 'schedule-mode';
  modeInput.innerHTML = `<option value="act">${escapeHtml(t('sp.mode.act'))}</option><option value="ask">${escapeHtml(t('sp.mode.ask'))}</option>`;
  modeInput.value = agentMode === 'ask' ? 'ask' : 'act';
  addScheduleField(form, t('sp.schedule_form.mode'), modeInput);

  const errorEl = document.createElement('div');
  errorEl.className = 'schedule-error';
  form.appendChild(errorEl);

  const actions = document.createElement('div');
  actions.className = 'schedule-form-actions';
  const submit = document.createElement('button');
  submit.type = 'submit';
  submit.className = 'schedule-submit';
  submit.textContent = t('sp.schedule_form.create');
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'schedule-cancel';
  cancel.textContent = t('sp.schedule_form.cancel');
  actions.appendChild(submit);
  actions.appendChild(cancel);
  form.appendChild(actions);

  bindScheduleComposer(form);
  content.appendChild(form);
  promptInput.focus();
  scrollToBottom();
}

async function showScratchpad(tabId = currentTabId) {
  try {
    const res = await sendToBackground('get_scratchpad', { tabId });
    if (currentTabId !== tabId) return;
    const body = String(res?.body || '').trim();
    if (!res?.exists || !body || body === '(empty)') {
      addMessage('system', t('sp.scratchpad.empty'));
      return;
    }
    const msgEl = addMessage('system', systemHtml(`${t('sp.scratchpad.title_html')}<pre class="scratchpad-dump">${escapeHtml(body)}</pre>`));
    addScratchpadCopyButton(msgEl);
  } catch (e) {
    if (currentTabId !== tabId) return;
    addMessage('system', systemHtml(tSystemHtml('sp.scratchpad.error', { msg: e.message })));
  }
}

async function editScratchpad(note, tabId = currentTabId) {
  const text = String(note || '').trim();
  if (!text) {
    if (currentTabId !== tabId) return;
    addMessage('system', t('sp.scratchpad.edit_empty'));
    return;
  }
  try {
    const res = await sendToBackground('write_scratchpad', { tabId, text });
    if (currentTabId !== tabId) return;
    if (!res?.ok && !res?.success) {
      addMessage('system', systemHtml(tSystemHtml('sp.scratchpad.error', { msg: res?.error || 'unknown error' })));
      return;
    }
    addMessage('system', t('sp.scratchpad.updated'));
  } catch (e) {
    if (currentTabId !== tabId) return;
    addMessage('system', systemHtml(tSystemHtml('sp.scratchpad.error', { msg: e.message })));
  }
}

function clearScratchpad(tabId = currentTabId) {
  sendToBackground('clear_scratchpad', { tabId })
    .then((res) => {
      if (currentTabId !== tabId) return;
      if (!res?.ok && !res?.success) {
        addMessage('system', systemHtml(tSystemHtml('sp.scratchpad.error', { msg: res?.error || 'unknown error' })));
        return;
      }
      addMessage('system', t('sp.scratchpad.cleared'));
    })
    .catch((e) => {
      if (currentTabId !== tabId) return;
      addMessage('system', systemHtml(tSystemHtml('sp.scratchpad.error', { msg: e.message })));
    });
}


// --- Initialization ---

async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  currentTabId = tab?.id;
  renderedTabId = currentTabId;

  chrome.tabs.onActivated.addListener(async (info) => {
    switchToTab(info.tabId);
  });

  // Also handle window focus changes
  chrome.windows.onFocusChanged.addListener(async (windowId) => {
    if (windowId === chrome.windows.WINDOW_ID_NONE) return;
    const [tab] = await chrome.tabs.query({ active: true, windowId });
    if (tab?.id && tab.id !== currentTabId) {
      switchToTab(tab.id);
    }
  });

  chrome.tabs.onUpdated?.addListener?.((tabId, changeInfo) => {
    if (tabId !== currentTabId || isProcessing) return;
    if (changeInfo.status === 'complete' || changeInfo.url || changeInfo.title) {
      refreshRecommendedActions();
    }
  });

  // Load verbose setting
  const stored = await chrome.storage.local.get('verboseMode');
  verboseMode = stored.verboseMode || false;

  // Restore prior conversation for this tab (if any) — survives close/reopen.
  const restoreTabId = currentTabId;
  if (restoreTabId != null) {
    const html = await loadTabChat(restoreTabId);
    if (currentTabId === restoreTabId && html) {
      messagesEl.innerHTML = html;
      messagesEl.querySelectorAll('[data-bound]').forEach(el => delete el.dataset.bound);
      rebindRestoredMessageControls();
      scrollToBottom();
    }
  }

  // Start observing the messages container for changes to persist.
  persistObserver.observe(messagesEl, { childList: true, subtree: true, characterData: true });

  await loadProviders();
  await testConnection({ skipWebBrainCloud: true });
  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (activeTab?.id && activeTab.id !== currentTabId) {
    await switchToTab(activeTab.id);
  }
  refreshScheduledJobs({ tabId: currentTabId });
  refreshRecommendedActions();
  await consumePendingContextMenuPrompt();
  drainQueuedContextMenuPrompts();

  // Reflect initial verbose state in the button.
  if (verboseBtn) verboseBtn.classList.toggle('active', verboseMode);

  // Listen for setting changes (from options page)
  chrome.storage.onChanged.addListener((changes) => {
    if (changes.verboseMode) {
      verboseMode = changes.verboseMode.newValue;
      if (verboseBtn) verboseBtn.classList.toggle('active', verboseMode);
    }
  });
}

// Verbose toggle button: persists the choice via the same storage key the
// settings page uses, so the two stay in sync.
if (verboseBtn) {
  verboseBtn.addEventListener('click', async (e) => {
    // Shift+click → dump deep debug log to DevTools console (hidden feature)
    if (e.shiftKey) {
      try {
        const response = await sendToBackground('get_debug_log');
        if (response?.log?.length) {
          console.group('%c[WebBrain Deep Verbose] %d entries', 'color:#7c3aed;font-weight:bold', response.log.length);
          for (const entry of response.log) {
            const label = entry.type || 'unknown';
            const ts = entry.timestamp || '';
            if (label.includes('request')) {
              console.groupCollapsed(`%c→ ${label} %c[step ${entry.step}] ${ts}`, 'color:#2563eb;font-weight:bold', 'color:#6b7280');
              console.log('Provider:', entry.provider);
              console.log('Messages:', entry.messages);
              console.log('Options:', entry.options);
              console.groupEnd();
            } else if (label.includes('response')) {
              console.groupCollapsed(`%c← ${label} %c[step ${entry.step}] ${ts}`, 'color:#059669;font-weight:bold', 'color:#6b7280');
              console.log('Content:', entry.content);
              console.log('Tool calls:', entry.toolCalls);
              console.groupEnd();
            } else if (label.includes('error')) {
              console.log(`%c✗ ${label} [step ${entry.step}] ${ts}: %c${entry.error}`, 'color:#dc2626;font-weight:bold', 'color:#dc2626');
            } else {
              console.log(`${label} [step ${entry.step}] ${ts}`, entry);
            }
          }
          console.groupEnd();
        } else {
          console.log('%c[WebBrain Deep Verbose] No entries yet — run a query first.', 'color:#7c3aed');
        }
      } catch (err) {
        console.error('[WebBrain Deep Verbose] Failed to fetch debug log:', err);
      }
      return; // don't toggle verbose mode
    }

    // Normal click → toggle verbose mode
    verboseMode = !verboseMode;
    verboseBtn.classList.toggle('active', verboseMode);
    await chrome.storage.local.set({ verboseMode }).catch(() => {});
  });
}

async function switchToTab(newTabId) {
  if (newTabId === currentTabId && renderedTabId === newTabId) { pendingTabSwitch = null; return; }
  if (isProcessing) {
    pendingTabSwitch = newTabId; // apply after the run ends
    return;
  }
  pendingTabSwitch = null;
  tabSwitchTransitionId = newTabId;

  try {
    // Save the tab currently represented by the DOM. During an async restore,
    // currentTabId may already point at the target while the DOM is still older.
    if (renderedTabId != null) {
      await flushRenderedTabChat();
      if (isProcessing) {
        pendingTabSwitch = newTabId;
        return;
      }
      captureInputDraftForTab(renderedTabId);
    }

    currentTabId = newTabId;
    syncApiMutationsAllowedForCurrentTab();

    // Restore new tab's chat from memory or storage.
    const html = await loadTabChat(newTabId);
    if (currentTabId !== newTabId) return;
    renderedTabId = newTabId;
    if (html) {
      messagesEl.innerHTML = html;
      messagesEl.querySelectorAll('[data-bound]').forEach(el => delete el.dataset.bound);
      rebindRestoredMessageControls();
    } else {
      messagesEl.innerHTML = '';
      addMessage('system', t('sp.help_message'));
    }
    restoreInputDraftForTab(newTabId);
    renderAttachmentPreviews();
    renderQueuedComposerMessages(newTabId);
    scrollToBottom();
    refreshScheduledJobs({ tabId: newTabId });
    refreshRecommendedActions();
  } finally {
    if (tabSwitchTransitionId === newTabId) tabSwitchTransitionId = null;
  }
  drainQueuedAgentUpdatesForTab(newTabId);
  consumePendingContextMenuPrompt().then(() => drainQueuedContextMenuPrompts()).catch(() => {});
}

function hideRecommendedActions() {
  if (!recommendedActionsEl || !recommendedActionsListEl) return;
  recommendedActionsListEl.replaceChildren();
  recommendedActionsEl.classList.add('hidden');
}

function updateRecommendedActionsCollapsedState() {
  if (!recommendedActionsEl) return;
  recommendedActionsEl.classList.toggle('collapsed', recommendedActionsCollapsed);
  if (!recommendedActionsToggleEl) return;

  const labelKey = recommendedActionsCollapsed ? 'sp.recommended.expand' : 'sp.recommended.collapse';
  const label = t(labelKey);
  recommendedActionsToggleEl.dataset.i18nTitle = labelKey;
  recommendedActionsToggleEl.dataset.i18nAriaLabel = labelKey;
  recommendedActionsToggleEl.title = label;
  recommendedActionsToggleEl.setAttribute('aria-label', label);
  recommendedActionsToggleEl.setAttribute('aria-expanded', String(!recommendedActionsCollapsed));
}

function setRecommendedActionsCollapsed(collapsed, { persist = true } = {}) {
  recommendedActionsCollapsed = Boolean(collapsed);
  updateRecommendedActionsCollapsedState();
  if (persist) {
    void chrome.storage.local.set({ [RECOMMENDED_ACTIONS_COLLAPSED_KEY]: recommendedActionsCollapsed }).catch(() => {});
  }
}

if (recommendedActionsToggleEl) {
  recommendedActionsToggleEl.addEventListener('click', async () => {
    const next = !recommendedActionsCollapsed;
    setRecommendedActionsCollapsed(next, { persist: false });
    await chrome.storage.local.set({ [RECOMMENDED_ACTIONS_COLLAPSED_KEY]: next }).catch(() => {});
  });
}

chrome.storage.local.get(RECOMMENDED_ACTIONS_COLLAPSED_KEY).then((stored) => {
  setRecommendedActionsCollapsed(stored?.[RECOMMENDED_ACTIONS_COLLAPSED_KEY] === true, { persist: false });
}).catch(() => updateRecommendedActionsCollapsedState());

chrome.storage.onChanged.addListener((changes, area) => {
  if (area && area !== 'local') return;
  if (changes[RECOMMENDED_ACTIONS_COLLAPSED_KEY]) {
    setRecommendedActionsCollapsed(changes[RECOMMENDED_ACTIONS_COLLAPSED_KEY].newValue === true, { persist: false });
  }
});

document.addEventListener('wb-locale-changed', updateRecommendedActionsCollapsedState);

async function refreshRecommendedActions() {
  const requestId = ++recommendationsRequestId;
  if (!recommendedActionsEl || !recommendedActionsListEl || currentTabId == null || isProcessing) {
    hideRecommendedActions();
    return;
  }

  const tabId = currentTabId;
  try {
    const pageInfo = await sendToBackground('get_page_info', { tabId });
    if (requestId !== recommendationsRequestId || currentTabId !== tabId || isProcessing) return;
    const actions = buildRecommendedActions(pageInfo, { max: 4 });
    recommendedActionsListEl.replaceChildren();
    actions.forEach((action) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'recommended-action-chip';
      btn.textContent = action.label;
      btn.dataset.prompt = action.prompt;
      btn.addEventListener('click', () => runRecommendedAction(action));
      recommendedActionsListEl.appendChild(btn);
    });
    recommendedActionsEl.classList.toggle('hidden', actions.length === 0);
  } catch {
    if (requestId === recommendationsRequestId) hideRecommendedActions();
  }
}

async function runRecommendedAction(action) {
  const prompt = typeof action === 'string' ? action : action?.prompt;
  const tabId = currentTabId;
  if (!prompt || tabId == null || isProcessing) return;
  if (action?.mode === 'act') {
    const ok = await ensureActMode();
    if (!ok || currentTabId !== tabId || isProcessing) return;
  }
  inputEl.value = prompt;
  autoResizeInput();
  sendMessage();
}

// After restoring innerHTML the copy buttons need their click handlers re-bound,
// since serialized HTML loses listeners.
function rebindCopyButtons() {
  document.querySelectorAll('.msg-copy-btn').forEach(btn => {
    bindMessageCopyButton(btn);
  });
  document.querySelectorAll('.code-copy-btn').forEach(btn => {
    if (btn.dataset.bound) return;
    btn.dataset.bound = 'true';
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const wrapper = btn.closest('.code-block-wrapper');
      const codeEl = wrapper?.querySelector('pre code');
      if (codeEl) {
        navigator.clipboard.writeText(codeEl.textContent).then(() => {
          btn.textContent = t('sp.copied');
          btn.classList.add('copied');
          setTimeout(() => { btn.textContent = t('sp.copy'); btn.classList.remove('copied'); }, 1500);
        });
      }
    });
  });
}

function rebindContinueButtons() {
  document.querySelectorAll('.continue-btn').forEach(btn => {
    if (btn.dataset.bound) return;
    btn.dataset.bound = 'true';
    btn.addEventListener('click', continueAgent);
  });
}

function rebindClarifyCards() {
  document.querySelectorAll('.clarify-card').forEach(card => {
    if (card.classList.contains('clarify-answered')) return;
    const clarifyId = String(card.dataset.clarifyId || '');
    if (!clarifyId) return;
    const rawTabId = card.dataset.scheduledTabId ?? card.dataset.tabId;
    const tabId = rawTabId != null && rawTabId !== '' ? Number(rawTabId) : currentTabId;
    if (tabId == null || Number.isNaN(tabId)) return;

    card.querySelectorAll('.clarify-option').forEach(btn => {
      if (btn.dataset.bound) return;
      btn.dataset.bound = 'true';
      btn.addEventListener('click', () => {
        submitClarify(card, tabId, clarifyId, btn.dataset.value || btn.textContent, 'option');
      });
    });

    card.querySelectorAll('.clarify-input').forEach(input => {
      if (input.dataset.bound) return;
      input.dataset.bound = 'true';
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && input.value.trim()) {
          e.preventDefault();
          submitClarify(card, tabId, clarifyId, input.value.trim(), 'text');
        }
      });
    });

    card.querySelectorAll('.clarify-submit').forEach(btn => {
      if (btn.dataset.bound) return;
      btn.dataset.bound = 'true';
      btn.addEventListener('click', () => {
        const input = card.querySelector('.clarify-input');
        const value = input?.value?.trim();
        if (value) submitClarify(card, tabId, clarifyId, value, 'text');
      });
    });
  });
}

function bindPlanReviewCard(card) {
  if (!card || card.classList.contains('plan-reviewed')) return;
  const planId = String(card.dataset.planId || '');
  if (!planId) return;
  const rawTabId = card.dataset.tabId;
  const tabId = rawTabId != null && rawTabId !== '' ? Number(rawTabId) : currentTabId;
  if (tabId == null || Number.isNaN(tabId)) return;

  const textarea = card.querySelector('.plan-review-edit');
  const originalMarkdown = String(textarea?.defaultValue || textarea?.value || '').trim();
  const markdownMode = String(card.dataset.planMarkdownMode || 'compact');

  // A <textarea>'s live `.value` is NOT captured when the conversation is
  // persisted via innerHTML (only its defaultValue / child text is), so edits
  // made before a tab switch would be lost on restore — and silently pinned
  // un-edited on approval. Mirror live edits into a data attribute on the card
  // (which DOES survive the persist→restore round-trip) and rehydrate the
  // textarea from it on rebind. (#3)
  if (textarea) {
    const saved = card.dataset.editedText;
    if (saved != null && saved !== '') textarea.value = saved;
    if (!textarea.dataset.bound) {
      textarea.dataset.bound = 'true';
      textarea.addEventListener('input', () => {
        card.dataset.editedText = textarea.value;
        // The persist observer only watches childList/characterData, not
        // attributes, so the data attribute above won't trigger a save on its
        // own — schedule one so the edit reaches storage before a panel reload.
        schedulePersist();
      });
    }
  }

  const approveBtn = card.querySelector('.plan-review-approve');
  if (approveBtn && !approveBtn.dataset.bound) {
    approveBtn.dataset.bound = 'true';
    approveBtn.addEventListener('click', () => {
      const current = String(textarea?.value || '').trim();
      const editedText = current && (current !== originalMarkdown || markdownMode === 'verbose') ? current : '';
      submitPlanReview(card, tabId, planId, 'approve', editedText);
    });
  }

  const cancelBtn = card.querySelector('.plan-review-cancel');
  if (cancelBtn && !cancelBtn.dataset.bound) {
    cancelBtn.dataset.bound = 'true';
    cancelBtn.addEventListener('click', () => {
      submitPlanReview(card, tabId, planId, 'reject', '');
    });
  }
}

function reattachPlanReviewActiveRun(card) {
  const assistantEl = card?.closest?.('.message.assistant');
  if (!assistantEl) return null;
  currentAssistantEl = assistantEl;
  isProcessing = true;
  abortRequested = false;
  sendBtn.disabled = true;
  hideRecommendedActions();
  showActivity(t('sp.activity.thinking'));
  return assistantEl;
}

function clearPlanReviewActiveRun(assistantEl) {
  if (currentAssistantEl === assistantEl) currentAssistantEl = null;
  isProcessing = false;
  sendBtn.disabled = false;
  hideActivity();
  drainQueuedContextMenuPromptsAfterPendingTabSwitch();
  refreshRecommendedActions();
}

function rebindPlanReviewCards() {
  document.querySelectorAll('.plan-review-card').forEach(card => {
    bindPlanReviewCard(card);
  });
}

function rebindScheduleComposers() {
  document.querySelectorAll('form.schedule-composer').forEach(form => {
    bindScheduleComposer(form);
  });
}

function rebindSubscribeButtons() {
  document.querySelectorAll('.subscribe-btn').forEach(btn => {
    if (btn.dataset.bound) return;
    btn.dataset.bound = 'true';
    btn.addEventListener('click', () => openSubscribeUrl(btn.dataset.subscribeUrl));
  });
}

function rebindRestoredMessageControls() {
  rebindCopyButtons();
  rebindContinueButtons();
  rebindClarifyCards();
  rebindPlanReviewCards();
  rebindScheduleComposers();
  rebindSubscribeButtons();
}

async function loadProviders() {
  try {
    const res = await sendToBackground('get_providers');
    providerSelect.innerHTML = '';
    for (const [id, config] of Object.entries(res.providers)) {
      const opt = document.createElement('option');
      opt.value = id;
      opt.textContent = config.label || id;
      if (id === res.active) opt.selected = true;
      providerSelect.appendChild(opt);
    }
  } catch (e) {
    console.error('Failed to load providers:', e);
  }
}

function isWebBrainCloudProviderSelected() {
  return providerSelect?.value === 'webbrain_cloud';
}

function markSelectedProviderUntested() {
  statusDot.className = 'status-dot';
  statusDot.title = providerSelect?.selectedOptions?.[0]?.textContent || providerSelect?.value || '';
}

function markSelectedProviderFailed(error) {
  const msg = error?.message || t('sp.status.failed');
  statusDot.className = 'status-dot offline';
  statusDot.title = t('sp.status.error', { msg });
}

async function testConnection(options = {}) {
  const providerId = options.providerId || providerSelect.value;
  const requestId = ++providerTestRequestId;
  if (options.skipWebBrainCloud && providerId === 'webbrain_cloud') {
    if (requestId === providerTestRequestId && providerSelect.value === providerId) {
      markSelectedProviderUntested();
    }
    return;
  }
  statusDot.className = 'status-dot connecting';
  try {
    const res = await sendToBackground('test_provider', {
      providerId,
    });
    if (requestId !== providerTestRequestId || providerSelect.value !== providerId) return;
    statusDot.className = `status-dot ${res.ok ? 'online' : 'offline'}`;
    statusDot.title = res.ok
      ? t('sp.status.connected', { model: res.model || providerId })
      : t('sp.status.error', { msg: res.error });
  } catch {
    if (requestId !== providerTestRequestId || providerSelect.value !== providerId) return;
    statusDot.className = 'status-dot offline';
    statusDot.title = t('sp.status.failed');
  }
}

function getSlashCommandQuery() {
  if (!inputEl) return null;
  const value = inputEl.value;
  const selectionStart = inputEl.selectionStart ?? value.length;
  const selectionEnd = inputEl.selectionEnd ?? selectionStart;
  if (selectionStart !== selectionEnd) return null;

  const beforeCursor = value.slice(0, selectionStart);
  const afterCursor = value.slice(selectionStart);
  if (!/^\/[a-z-]*$/i.test(beforeCursor)) return null;
  if (afterCursor.trim()) return null;
  return beforeCursor.toLowerCase();
}

function getRecognizedSlashCommandPrefix(value) {
  const leadingWhitespace = value.match(/^\s*/)?.[0] || '';
  const text = value.slice(leadingWhitespace.length);
  const lowerText = text.toLowerCase();
  const command = SLASH_COMMANDS.find((candidate) => {
    if (!lowerText.startsWith(candidate.value)) return false;
    const next = text.charAt(candidate.value.length);
    return !next || /\s/.test(next);
  });
  if (!command) return null;
  return {
    start: leadingWhitespace.length,
    end: leadingWhitespace.length + command.value.length,
  };
}

function syncSlashCommandHighlightScroll() {
  if (!inputEl || !inputHighlightEl) return;
  inputHighlightEl.scrollTop = inputEl.scrollTop;
  inputHighlightEl.scrollLeft = inputEl.scrollLeft;
}

function updateSlashCommandHighlight() {
  if (!inputEl || !inputHighlightEl) return;
  const value = inputEl.value;
  const commandRange = getRecognizedSlashCommandPrefix(value);
  if (!commandRange) {
    inputHighlightEl.textContent = value;
    syncSlashCommandHighlightScroll();
    return;
  }

  const before = escapeHtml(value.slice(0, commandRange.start));
  const command = escapeHtml(value.slice(commandRange.start, commandRange.end));
  const after = escapeHtml(value.slice(commandRange.end));
  inputHighlightEl.innerHTML = `${before}<span class="input-highlight-command">${command}</span>${after}`;
  syncSlashCommandHighlightScroll();
}

function scrollSlashCommandOptionIntoView(option) {
  if (!slashCommandMenuEl || !option) return;

  const menuRect = slashCommandMenuEl.getBoundingClientRect();
  const optionRect = option.getBoundingClientRect();
  if (optionRect.top < menuRect.top) {
    slashCommandMenuEl.scrollTop -= menuRect.top - optionRect.top;
  } else if (optionRect.bottom > menuRect.bottom) {
    slashCommandMenuEl.scrollTop += optionRect.bottom - menuRect.bottom;
  }
}

function updateSlashCommandActiveOption() {
  const options = slashCommandMenuEl?.querySelectorAll('.slash-command-option') || [];
  let selectedOption = null;
  options.forEach((option, index) => {
    const selected = index === slashCommandSelectedIndex;
    option.classList.toggle('selected', selected);
    option.setAttribute('aria-selected', String(selected));
    if (selected) selectedOption = option;
  });
  const activeId = `${SLASH_COMMAND_OPTION_ID_PREFIX}${slashCommandSelectedIndex}`;
  inputEl?.setAttribute('aria-activedescendant', activeId);
  scrollSlashCommandOptionIntoView(selectedOption);
}

function renderSlashCommandAutocomplete() {
  if (!slashCommandMenuEl || !inputEl || slashCommandMatches.length === 0) return;
  slashCommandMenuEl.replaceChildren();
  slashCommandMenuEl.setAttribute('aria-label', t('sp.slash.commands_label'));

  slashCommandMatches.forEach((command, index) => {
    const option = document.createElement('button');
    option.type = 'button';
    option.id = `${SLASH_COMMAND_OPTION_ID_PREFIX}${index}`;
    option.className = 'slash-command-option';
    option.setAttribute('role', 'option');
    option.setAttribute('aria-selected', String(index === slashCommandSelectedIndex));

    const name = document.createElement('span');
    name.className = 'slash-command-name';
    name.textContent = command.value;

    const description = document.createElement('span');
    description.className = 'slash-command-description';
    description.textContent = t(command.descriptionKey);

    option.append(name, description);
    option.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      applySlashCommandCompletion(index);
    });
    option.addEventListener('mousemove', () => setSlashCommandSelectedIndex(index));
    slashCommandMenuEl.appendChild(option);
  });

  slashCommandMenuEl.classList.remove('hidden');
  inputEl.setAttribute('aria-autocomplete', 'list');
  inputEl.setAttribute('aria-controls', slashCommandMenuEl.id);
  inputEl.setAttribute('aria-expanded', 'true');
  updateSlashCommandActiveOption();
}

function hideSlashCommandAutocomplete() {
  slashCommandMatches = [];
  slashCommandSelectedIndex = 0;
  slashCommandMenuEl?.classList.add('hidden');
  slashCommandMenuEl?.replaceChildren();
  inputEl?.setAttribute('aria-expanded', 'false');
  inputEl?.removeAttribute('aria-activedescendant');
}

function updateSlashCommandAutocomplete() {
  const query = getSlashCommandQuery();
  if (!query) {
    hideSlashCommandAutocomplete();
    return;
  }

  const previouslySelected = slashCommandMatches[slashCommandSelectedIndex]?.value;
  const matches = SLASH_COMMANDS.filter((command) => command.value.startsWith(query));
  if (matches.length === 0) {
    hideSlashCommandAutocomplete();
    return;
  }

  slashCommandMatches = matches;
  const selectedIndex = matches.findIndex((command) => command.value === previouslySelected);
  slashCommandSelectedIndex = selectedIndex >= 0 ? selectedIndex : 0;
  renderSlashCommandAutocomplete();
}

function setSlashCommandSelectedIndex(index) {
  if (slashCommandMatches.length === 0) return;
  slashCommandSelectedIndex = (index + slashCommandMatches.length) % slashCommandMatches.length;
  updateSlashCommandActiveOption();
}

function applySlashCommandCompletion(index = slashCommandSelectedIndex) {
  const command = slashCommandMatches[index];
  if (!command || !inputEl) return false;
  inputEl.value = `${command.value} `;
  inputEl.setSelectionRange(inputEl.value.length, inputEl.value.length);
  hideSlashCommandAutocomplete();
  autoResizeInput();
  syncSendButtonState();
  inputEl.focus();
  return true;
}

function isExactSlashCommandQuery() {
  const query = getSlashCommandQuery();
  return !!query && SLASH_COMMANDS.some((command) => command.value === query);
}

function handleSlashCommandKeydown(e) {
  if (!slashCommandMatches.length || slashCommandMenuEl?.classList.contains('hidden')) {
    return false;
  }

  if (e.key === 'ArrowDown') {
    e.preventDefault();
    setSlashCommandSelectedIndex(slashCommandSelectedIndex + 1);
    return true;
  }
  if (e.key === 'ArrowUp') {
    e.preventDefault();
    setSlashCommandSelectedIndex(slashCommandSelectedIndex - 1);
    return true;
  }
  if (e.key === 'Tab') {
    e.preventDefault();
    return applySlashCommandCompletion();
  }
  if (e.key === 'Enter' && !isExactSlashCommandQuery()) {
    e.preventDefault();
    return applySlashCommandCompletion();
  }
  if (e.key === 'Escape') {
    e.preventDefault();
    hideSlashCommandAutocomplete();
    return true;
  }
  return false;
}

function handleInput() {
  autoResizeInput();
  updateSlashCommandAutocomplete();
  syncSendButtonState();
}

// --- Message Sending ---

// Per-conversation flag for API mutation override (set via /allow-api).
// Reset on clearConversation. Visible to the user in the chat as a system
// message and as a sticky badge near the input area.
let apiMutationsAllowed = false;
const apiMutationsAllowedByTab = new Map();

function isApiMutationsAllowedForTab(tabId) {
  return tabId != null && apiMutationsAllowedByTab.get(tabId) === true;
}

function setApiMutationsAllowedForTab(tabId, allowed) {
  if (tabId == null) return;
  if (allowed) {
    apiMutationsAllowedByTab.set(tabId, true);
  } else {
    apiMutationsAllowedByTab.delete(tabId);
  }
  if (currentTabId === tabId) syncApiMutationsAllowedForCurrentTab();
}

function syncApiMutationsAllowedForCurrentTab() {
  apiMutationsAllowed = isApiMutationsAllowedForTab(currentTabId);
  updateApiBadge();
}

function getLeadingSlashCommand(value) {
  const text = String(value || '').trimStart();
  const lowerText = text.toLowerCase();
  const command = SLASH_COMMANDS.find((candidate) => {
    if (!lowerText.startsWith(candidate.value)) return false;
    const next = text.charAt(candidate.value.length);
    return !next || /\s/.test(next);
  });
  return command?.value || null;
}

function isOutOfBandSlashDraft(value) {
  const command = getLeadingSlashCommand(value);
  return !!command && OUT_OF_BAND_SLASH_COMMANDS.has(command);
}

function syncSendButtonState() {
  if (!sendBtn) return;
  const draft = normalizeScreenshotCommandText(inputEl?.value || '').trim();
  if (!isProcessing) {
    sendBtn.disabled = isAttachmentReadPendingForTab();
    return;
  }
  if (!draft) {
    sendBtn.disabled = true;
    return;
  }
  sendBtn.disabled = draft.startsWith('/') && !isOutOfBandSlashDraft(draft);
}

function showBusySlashCommandNotice() {
  const now = Date.now();
  if (now - busySlashNoticeLastShownAt < BUSY_SLASH_NOTICE_COOLDOWN_MS) return;
  busySlashNoticeLastShownAt = now;
  addMessage('system', t('sp.slash.busy_only_oob'));
}

function resolvePendingPermissionPromptsForTab(tabId) {
  if (tabId == null) return 0;
  const targetTabId = String(tabId);
  let resolved = 0;
  for (const card of document.querySelectorAll('.clarify-card[data-permission="1"]')) {
    if (card.classList.contains('clarify-answered')) continue;
    if (String(card.dataset.tabId || '') !== targetTabId) continue;
    const clarifyId = String(card.dataset.clarifyId || '');
    if (!clarifyId) continue;
    submitClarify(card, tabId, clarifyId, 'once', 'slash-command');
    resolved += 1;
  }
  return resolved;
}

/**
 * Parse leading slash commands out of the user's message.
 * Returns the cleaned text (empty string if fully consumed).
 * May trigger async UI side effects (screenshot, export, etc.).
 */
async function parseSlashCommands(text, tabId = currentTabId) {
  // /help — list all available slash commands
  if (/^\/help\b\s*/i.test(text)) {
    addMessage('system', systemHtml(t('sp.help_html')));
    return '';
  }

  // /list-schedules — refresh the scheduled job strip
  if (/^\/list-schedules\b\s*/i.test(text)) {
    const jobs = await refreshScheduledJobs({ tabId });
    if (currentTabId !== tabId) return '';
    addMessage('system', visibleScheduledJobs(jobs).length
      ? t('sp.schedule_form.list_refreshed')
      : t('sp.schedule_form.none'));
    return '';
  }

  // /show-scratchpad — dump the current tab's agent scratchpad
  if (/^\/show-scratchpad\b\s*/i.test(text)) {
    await showScratchpad(tabId);
    return '';
  }

  // /edit-scratchpad — append text after the command to the scratchpad
  const mEditScratchpad = text.match(/^\/edit-scratchpad\b\s*/i);
  if (mEditScratchpad) {
    await editScratchpad(text.slice(mEditScratchpad[0].length), tabId);
    return '';
  }

  // /clear-scratchpad — clear the current tab's agent scratchpad
  if (/^\/clear-scratchpad\b\s*/i.test(text)) {
    clearScratchpad(tabId);
    return '';
  }

  // /schedule — open a deterministic scheduled-task composer
  const mSchedule = text.match(/^\/schedule\b\s*/i);
  if (mSchedule) {
    renderScheduleComposer(text.slice(mSchedule[0].length).trim(), tabId);
    return '';
  }

  // /allow-api — enable API mutation override
  const mApi = text.match(/^\/allow-api\b\s*/i);
  if (mApi) {
    const wasAlreadyAllowed = isApiMutationsAllowedForTab(tabId);
    setApiMutationsAllowedForTab(tabId, true);
    if (!wasAlreadyAllowed) {
      addMessage('system', systemHtml(t('sp.api.enabled_html')));
    }
    return text.slice(mApi[0].length).trim();
  }

  // /dangerously-skip-permissions — disable the master permission prompt gate
  const mSkipPermissions = text.match(/^\/dangerously-skip-permissions\b\s*/i);
  if (mSkipPermissions) {
    await chrome.storage.local.set({ [PERMISSION_GATE_KEY]: false }).catch(() => {});
    askBeforeConsequential = false;
    updateActWarning();
    resolvePendingPermissionPromptsForTab(tabId);
    addMessage('system', systemHtml(t('sp.permissions.disabled_html')));
    return text.slice(mSkipPermissions[0].length).trim();
  }

  // /compact — force context compaction for this conversation
  const mCompact = text.match(/^\/compact\b\s*/i);
  if (mCompact) {
    const remainder = text.slice(mCompact[0].length).trim();
    const res = await sendToBackground('compact_conversation', { tabId });
    if (currentTabId !== tabId) return remainder;
    if (res?.ok && res.compacted) {
      addContextCompactedNote({ ...res, manual: true });
    } else if (res?.ok && res.reason === 'busy') {
      addMessage('system', t('sp.compact.busy'));
    } else if (res?.ok) {
      addMessage('system', t('sp.compact.nothing_to_compact'));
    } else {
      addMessage('system', systemHtml(tSystemHtml('sp.compact.failed', { error: res?.error || 'unknown error' })));
    }
    return remainder;
  }

  // /verbose — toggle verbose/compact tool display
  if (/^\/verbose\b\s*/i.test(text)) {
    verboseMode = !verboseMode;
    if (verboseBtn) verboseBtn.classList.toggle('active', verboseMode);
    await chrome.storage.local.set({ verboseMode }).catch(() => {});
    if (currentTabId !== tabId) return '';
    addMessage('system', verboseMode
      ? t('sp.compact.verbose_on')
      : t('sp.compact.verbose_off'));
    return '';
  }

  // /reset — clear conversation (same as clear button)
  if (/^\/reset\b\s*/i.test(text)) {
    await sendToBackground('clear_conversation', { tabId });
    renderClearedConversationForTab(tabId);
    return '';
  }

  // /screenshot — capture visible tab and display in chat
  if (/^\/screenshot\b\s*/i.test(text)) {
    try {
      const tab = tabId == null ? null : await chrome.tabs.get(tabId);
      if (currentTabId !== tabId || !tab?.active) return '';
      const windowId = tab?.windowId;
      if (windowId != null) {
        const dataUrl = await chrome.tabs.captureVisibleTab(windowId, { format: 'png' });
        if (currentTabId !== tabId) return '';
        const imgHtml = `<img src="${dataUrl}" style="max-width:100%;border-radius:6px;margin:4px 0;" alt="Screenshot"/>`;
        addMessage('system', systemHtml(imgHtml));
      }
    } catch (e) {
      if (currentTabId !== tabId) return '';
      addMessage('system', systemHtml(tSystemHtml('sp.screenshot.error', { msg: e.message })));
    }
    return '';
  }

  // /full-page-screenshot — capture the full scrollable page and display in chat
  if (/^\/full-page-screenshot\b\s*/i.test(text)) {
    try {
      const res = await sendToBackground('capture_full_page_screenshot', { tabId });
      if (currentTabId !== tabId) return '';
      if (!res?.ok || !res.dataUrl) {
        addMessage('system', systemHtml(tSystemHtml('sp.screenshot.error', { msg: res?.error || 'unknown error' })));
        return '';
      }
      const imgHtml = `<img src="${res.dataUrl}" style="max-width:100%;max-height:70vh;object-fit:contain;object-position:top;border-radius:6px;margin:4px 0;" alt="Full-page screenshot"/>`;
      addMessage('system', systemHtml(imgHtml));
    } catch (e) {
      if (currentTabId !== tabId) return '';
      addMessage('system', systemHtml(tSystemHtml('sp.screenshot.error', { msg: e.message })));
    }
    return '';
  }

  // /record-full-screen — start a screen/window recording without LLM involvement
  const mRecordFullScreen = text.match(/^\/record-full-screen(?:\s|$)/i);
  if (mRecordFullScreen) {
    await startFullScreenRecording(tabId, parseRecordingSlashOptions(text, mRecordFullScreen));
    return '';
  }

  // /record — start recording the current tab without LLM involvement
  const mRecord = text.match(/^\/record(?:\s|$)/i);
  if (mRecord) {
    const recordOptions = parseRecordingSlashOptions(text, mRecord);
    try {
      const res = await sendToBackground('start_tab_recording', {
        tabId,
        options: {
          video: true,
          mic: true,
          showBanner: true,
          transcribeAfter: recordOptions.transcribeAfter,
        },
      });
      if (currentTabId !== tabId) return '';
      if (!res?.ok) {
        addMessage('system', systemHtml(tSystemHtml('sp.record.error', { error: res?.error || 'unknown' })));
      } else if (res.state && res.state.hasMic === false && res.state.micError) {
        addMessage('system', systemHtml(tSystemHtml('sp.record.mic_unavailable', { error: res.state.micError })));
      }
    } catch (e) {
      if (currentTabId !== tabId) return '';
      addMessage('system', systemHtml(tSystemHtml('sp.record.error', { error: e.message })));
    }
    return '';
  }

  // /export — export conversation as markdown
  if (/^\/export\b\s*/i.test(text)) {
    const messages = messagesEl.querySelectorAll('.message');
    let md = '# WebBrain Conversation\n\n';
    for (const msg of messages) {
      const textEl = msg.querySelector('.message-text');
      if (!textEl) continue;
      const content = textEl.textContent.trim();
      if (!content) continue;
      if (msg.classList.contains('user')) {
        md += `**You:** ${content}\n\n`;
      } else if (msg.classList.contains('assistant')) {
        md += `**WebBrain:** ${content}\n\n`;
      } else if (msg.classList.contains('system')) {
        md += `*${content}*\n\n`;
      }
    }
    const blob = new Blob([md], { type: 'text/markdown' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `webbrain-chat-${Date.now()}.md`;
    document.body.appendChild(a);
    try {
      a.click();
    } finally {
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 7000);
    }
    addMessage('system', t('sp.export.done'));
    return '';
  }

  // /profile — toggle profile auto-fill on/off
  if (/^\/profile\b\s*/i.test(text)) {
    const stored = await chrome.storage.local.get(['profileEnabled', 'profileText']);
    const newState = !stored.profileEnabled;
    await chrome.storage.local.set({ profileEnabled: newState });
    if (currentTabId !== tabId) return '';
    addMessage('system', newState
      ? t('sp.profile.on')
      : t('sp.profile.off'));
    return '';
  }

  // /ask — switch to Ask mode, then send remaining text
  const mAsk = text.match(/^\/ask\b\s*/i);
  if (mAsk) {
    setMode('ask');
    return text.slice(mAsk[0].length).trim();
  }

  // /plan — switch to Ask mode with explicit planning intent
  const mPlan = text.match(/^\/plan\b\s*/i);
  if (mPlan) {
    setMode('ask');
    const rest = text.slice(mPlan[0].length).trim();
    return rest ? `Plan the following step by step: ${rest}` : '';
  }

  // /vision — toggle vision support on active provider
  if (/^\/vision\b\s*/i.test(text)) {
    try {
      const { providers, active } = await sendToBackground('get_providers');
      const config = providers[active];
      if (config) {
        const newVision = !config.supportsVision;
        await sendToBackground('update_provider', {
          providerId: active,
          config: { ...config, supportsVision: newVision },
        });
        if (currentTabId !== tabId) return '';
        addMessage('system', newVision
          ? t('sp.vision.on')
          : t('sp.vision.off'));
      }
    } catch (e) {
      if (currentTabId !== tabId) return '';
      addMessage('system', systemHtml(tSystemHtml('sp.vision.error', { msg: e.message })));
    }
    return '';
  }

  return text;
}

function parseRecordingSlashOptions(text, commandMatch) {
  const args = text.slice(commandMatch?.[0]?.length || 0);
  return {
    transcribeAfter: /(?:^|\s)--transcribe(?:\s|$)/i.test(args),
  };
}

async function startFullScreenRecording(tabId = currentTabId, recordOptions = {}) {
  try {
    const prep = await sendToBackground('prepare_recording_host');
    if (!prep?.ok) {
      addMessage('system', systemHtml(tSystemHtml('sp.record.error', { error: prep?.error || 'unknown' })));
      return;
    }
    const res = await sendToBackground('start_display_recording', {
      tabId,
      options: {
        video: true,
        audio: true,
        mic: true,
        showBanner: false,
        transcribeAfter: !!recordOptions.transcribeAfter,
      },
    });
    if (currentTabId !== tabId) return;
    if (!res?.ok) {
      addMessage('system', systemHtml(tSystemHtml('sp.record.error', { error: res?.error || 'unknown' })));
      return;
    }
    recordingStartedAt = res.state?.startedAt || Date.now();
    setRecordingUI(true, res.state || { source: 'display', showBanner: false });
    addMessage('system', systemHtml(t('sp.record.full_screen_started_html')));
    if (res.state?.hasMic === false && res.state?.micError) {
      addMessage('system', systemHtml(tSystemHtml('sp.record.mic_unavailable', { error: res.state.micError })));
    }
  } catch (e) {
    if (currentTabId !== tabId) return;
    addMessage('system', systemHtml(tSystemHtml('sp.record.error', { error: e?.message || 'unknown' })));
  }
}

function updateApiBadge() {
  let badge = document.getElementById('api-badge');
  if (apiMutationsAllowed) {
    if (!badge) {
      badge = document.createElement('div');
      badge.id = 'api-badge';
      badge.className = 'api-badge';
      badge.innerHTML = t('sp.api.badge_html');
      const inputArea = document.getElementById('input-area');
      inputArea?.parentNode?.insertBefore(badge, inputArea);
    }
  } else if (badge) {
    badge.remove();
  }
}

async function sendMessage(extraChatParams) {
  stopListening();
  let text = inputEl.value.trim();
  if (!text) return;
  const tabId = currentTabId;
  text = normalizeScreenshotCommandText(text);
  if (!isProcessing && isAttachmentReadPendingForTab(tabId)) {
    syncSendButtonState();
    return false;
  }
  if (isProcessing) {
    if (isOutOfBandSlashDraft(text)) {
      saveInputDraftForTab(tabId, '');
      hideSlashCommandAutocomplete();
      inputEl.value = '';
      autoResizeInput();
      syncSendButtonState();
      await parseSlashCommands(text, tabId);
      if (currentTabId === tabId) {
        if (!inputEl.value.trim() || inputEl.value.trim() === text) {
          inputEl.value = '';
          autoResizeInput();
        }
        syncSendButtonState();
      }
      return true;
    }
    if (text.startsWith('/')) {
      showBusySlashCommandNotice();
      return false;
    }
    return enqueueQueuedComposerMessage(tabId, text);
  }
  const modeForSend = /^\/(?:ask|plan)\b/i.test(text) ? 'ask' : agentMode;
  const apiMutationsAllowedForSend = isApiMutationsAllowedForTab(tabId) || /^\/allow-api\b/i.test(text);
  saveInputDraftForTab(tabId, '');
  hideSlashCommandAutocomplete();

  // Clear input early so slash commands don't linger visually.
  if (text.startsWith('/')) {
    inputEl.value = '';
    autoResizeInput();
    syncSendButtonState();
  }

  // Parse any leading slash command. parseSlashCommands may strip the
  // command from `text` and toggle apiMutationsAllowed as a side effect.
  text = await parseSlashCommands(text, tabId);
  const renderToCurrentTab = currentTabId === tabId;
  if (!renderToCurrentTab) {
    if (text) saveInputDraftForTab(tabId, text);
    return false;
  }
  // If the entire message was just the slash command, there's nothing
  // left to send to the agent — bail out after the side effect.
  if (!text) {
    inputEl.value = '';
    autoResizeInput();
    syncSendButtonState();
    return;
  }

  let assistantEl = null;
  const attachmentsForSend = getPendingAttachmentsForTab(tabId, { create: false }).slice();
  if (renderToCurrentTab) {
    isProcessing = true;
    abortRequested = false;
    inputEl.value = '';
    autoResizeInput();
    syncSendButtonState();
    hideRecommendedActions();
    clearPendingAttachmentsForTab(tabId);
    renderAttachmentPreviews();
    addMessage('user', text);
    showActivity(t('sp.activity.thinking'));
    assistantEl = addMessage('assistant', '');
    currentAssistantEl = assistantEl;
  }

  let accepted = false;
  let completedSuccessfully = false;
  try {
    const res = await sendToBackground('chat', {
      tabId,
      text,
      mode: modeForSend,
      apiMutationsAllowed: apiMutationsAllowedForSend,
      ...(attachmentsForSend.length ? { attachments: attachmentsForSend } : {}),
      ...extraChatParams,
    });
    accepted = true;
    completedSuccessfully = updatesContainSuccessfulDone(res?.updates);

    // An unsupported-attachment rejection never records the turn in history;
    // the agent signals it via a structured 'attachment_rejected' update (not
    // by matching the error copy, which could false-positive on a genuine
    // assistant answer). We optimistically cleared the chips on send, so
    // re-add them here — otherwise "switch providers and try again" is
    // impossible without re-picking every file.
    if (attachmentsForSend.length && currentTabId === tabId
        && res?.updates?.some(u => u?.type === 'attachment_rejected')) {
      const pending = getPendingAttachmentsForTab(tabId);
      pending.unshift(...attachmentsForSend.filter(att => !pending.includes(att)));
      // Restore the prompt only if the user hasn't started typing a new one
      // while the rejected turn was in flight.
      if (!inputEl.value.trim()) {
        inputEl.value = text;
        saveInputDraftForTab(tabId, text);
        autoResizeInput();
        updateSlashCommandAutocomplete();
      }
      renderAttachmentPreviews();
      syncSendButtonState();
    }

    if (renderToCurrentTab && currentTabId === tabId && abortRequested) {
      // Agent was stopped — show what we got so far
      const textEl = assistantEl?.querySelector('.message-text');
      if (textEl && !textEl.textContent.trim()) {
        textEl.innerHTML = formatMarkdown(res?.content || t('sp.stopped_by_user'));
        addMessageCopyButton(assistantEl);
      }
    } else if (renderToCurrentTab && currentTabId === tabId && res?.content && assistantEl) {
      const textEl = assistantEl.querySelector('.message-text');
      if (textEl && !textEl.textContent.trim()) {
        if (!renderSubscribeError(textEl, res.content)) {
          textEl.innerHTML = formatMarkdown(res.content);
        }
        addMessageCopyButton(assistantEl);
      }
    }
  } catch (e) {
    if (renderToCurrentTab && currentTabId === tabId && !abortRequested) {
      addMessage('error', t('sp.error_prefix', { msg: e.message }));
    }
  } finally {
    if (renderToCurrentTab && currentTabId === tabId) finalizeSteps(assistantEl);
    // Chime the user when the agent finishes. We play on both success and
    // error completion — anything that wasn't an explicit user abort. The
    // sound is what takes them from "glance back at the tab" to "know it's
    // done" without having to sit and watch the sidebar.
    const wasAborted = abortRequested;
    if (renderToCurrentTab) {
      isProcessing = false;
      abortRequested = false;
      syncSendButtonState();
      hideActivity();
    }
    if (currentAssistantEl === assistantEl) currentAssistantEl = null;
    if (renderToCurrentTab && currentTabId === tabId) scrollToBottom();
    if (renderToCurrentTab && renderedTabId === tabId) await flushRenderedTabChat();
    if (renderToCurrentTab && !wasAborted) notifyCompletion({ success: currentTabId === tabId && completedSuccessfully });
    if (renderToCurrentTab && currentTabId === tabId) refreshRecommendedActions();
    await drainQueuedContextMenuPromptsAfterPendingTabSwitch();
  }
  return accepted;
}

// ─── Tab Recorder (v7.4) ────────────────────────────────────────────
// State: idle ↔ recording. Slash commands flip the panel into recording mode
// via background broadcasts. `/record` shows the banner Stop button;
// `/record-full-screen` stays visually quiet and relies on double Escape or
// Chrome's Stop sharing control. The visible banner timer is driven off
// recordingState.startedAt (received from background), so it survives remount.

let recordingTimerInterval = null;
let recordingStartedAt = null;
let recordingActive = false;
let recordingShowsBanner = false;
let recordingEscapeArmedUntil = 0;
const RECORDING_DOUBLE_ESCAPE_MS = 1400;

function formatRecordTimer(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = String(Math.floor(total / 60)).padStart(2, '0');
  const s = String(total % 60).padStart(2, '0');
  return `${m}:${s}`;
}

function shouldShowRecordingBanner(state) {
  return state?.showBanner !== false;
}

function setRecordingUI(active, state = null) {
  recordingActive = !!active;
  recordingShowsBanner = !!active && shouldShowRecordingBanner(state || {});
  recordingEscapeArmedUntil = 0;
  if (recordingBanner) recordingBanner.classList.toggle('hidden', !recordingShowsBanner);
  if (active) {
    if (!recordingTimerInterval) {
      recordingTimerInterval = setInterval(() => {
        if (recordingStartedAt) {
          const elapsed = Date.now() - recordingStartedAt;
          if (recordingShowsBanner && recordingTimerEl) {
            recordingTimerEl.textContent = formatRecordTimer(elapsed);
          }
        }
      }, 1000);
    }
    if (recordingShowsBanner && recordingTimerEl && recordingStartedAt) {
      recordingTimerEl.textContent = formatRecordTimer(Date.now() - recordingStartedAt);
    } else if (recordingTimerEl) {
      recordingTimerEl.textContent = '00:00';
    }
  } else {
    if (recordingTimerInterval) {
      clearInterval(recordingTimerInterval);
      recordingTimerInterval = null;
    }
    if (recordingTimerEl) recordingTimerEl.textContent = '00:00';
    recordingStartedAt = null;
    recordingActive = false;
    recordingShowsBanner = false;
    recordingEscapeArmedUntil = 0;
  }
}

async function hydrateRecordingFromBackground() {
  try {
    const res = await sendToBackground('get_recording_state');
    if (res?.state?.active) {
      recordingStartedAt = res.state.startedAt;
      setRecordingUI(true, res.state);
    } else {
      setRecordingUI(false);
    }
  } catch { /* background not ready yet, ignore */ }
}

async function stopRecording() {
  if (recordingStopBtn) recordingStopBtn.disabled = true;
  try {
    const res = await sendToBackground('stop_tab_recording');
    // Always tear down the banner. Whether the stop saved a file, cleared a
    // stale/orphaned recording, or failed outright, the user pressed Stop —
    // the banner must go away so they're never trapped (see the stuck-for-hours
    // report). Errors are surfaced but no longer block the UI from clearing.
    setRecordingUI(false);
    if (!res?.ok) {
      alert(t('sp.record.error', { error: res?.error || 'unknown' }));
    }
  } catch (e) {
    setRecordingUI(false);
    alert(t('sp.record.error', { error: e?.message || 'unknown' }));
  } finally {
    if (recordingStopBtn) recordingStopBtn.disabled = false;
  }
}

if (recordingStopBtn) recordingStopBtn.addEventListener('click', stopRecording);

// Hydrate on panel boot — the agent may have started a recording before
// this panel even mounted (Cmd+T to a new tab, then switch back).
hydrateRecordingFromBackground();

// --- Listen for Agent Updates ---

// Recorder broadcasts — independent of the per-tab agent_update flow.
// These are intentionally NOT scoped by tabId because the recording banner
// is global (a panel on any tab in the window should reflect that a record
// is in progress on tab X).
// Holds the latest finished recording result (filename + optional
// transcript) so Phase 3's "Summarize" CTA can read it.
let lastRecordingResult = null;
let lastTranscript = null;

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.target !== 'sidepanel' || msg.action !== 'context_menu_prompt') return;
  acceptContextMenuPrompt(msg.prompt || msg);
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.target !== 'sidepanel' || msg.action !== 'context_menu_tab_navigated') return;
  clearQueuedForTab(msg.tabId);
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.target !== 'sidepanel' || msg.action !== 'recording_update') return;
  if (msg.event === 'started') {
    recordingStartedAt = msg.state?.startedAt || Date.now();
    setRecordingUI(true, msg.state || {});
  } else if (msg.event === 'stopped') {
    setRecordingUI(false);
    lastRecordingResult = msg.result || null;
    if (lastRecordingResult && lastRecordingResult.ok === false) {
      // The recorder couldn't be finalized (lost/evicted recorder, or a
      // MediaRecorder/download error). host.js still cleared the stuck state,
      // but no .webm was saved — surface that instead of silently dropping it.
      showRecordingStatus(
        t('sp.record.error', { error: lastRecordingResult.error || 'unknown' }),
        { autoHide: 8000 }
      );
    } else if (lastRecordingResult?.transcribeAfter) {
      showRecordingStatus(t('sp.record.transcribing'));
    } else if (lastRecordingResult?.filename) {
      showRecordingStatus(t('sp.record.saved', { filename: lastRecordingResult.filename }), { autoHide: 6000 });
    }
  } else if (msg.event === 'transcribing') {
    showRecordingStatus(t('sp.record.transcribing'));
  } else if (msg.event === 'transcribed') {
    if (msg.result?.ok) {
      lastTranscript = msg.result.text || null;
      showRecordingStatus(
        t('sp.record.transcribed', { filename: msg.result.transcriptFilename || 'transcript.txt' }),
        { autoHide: 8000, summarizable: true }
      );
    } else {
      showRecordingStatus(t('sp.record.transcribe_failed', { error: msg.result?.error || 'unknown' }), { autoHide: 8000 });
    }
  }
});

// Minimal status strip just below the (now-hidden) recording banner.
// Carries post-recording notifications: "saved to Downloads", "transcribing…",
// "transcript ready" + optional Summarize CTA (Phase 3).
function showRecordingStatus(text, opts = {}) {
  let el = document.getElementById('recording-status');
  if (!el) {
    el = document.createElement('div');
    el.id = 'recording-status';
    el.className = 'recording-status';
    const banner = document.getElementById('recording-banner');
    if (banner && banner.parentNode) {
      banner.parentNode.insertBefore(el, banner.nextSibling);
    } else {
      document.body.appendChild(el);
    }
  }
  el.innerHTML = ''; // reset
  const span = document.createElement('span');
  span.textContent = text;
  el.appendChild(span);
  if (opts.summarizable && lastTranscript) {
    const btn = document.createElement('button');
    btn.textContent = t('sp.record.summarize');
    btn.className = 'btn-summarize-recording';
    btn.addEventListener('click', () => summarizeLastTranscript());
    el.appendChild(btn);
  }
  el.classList.remove('hidden');
  if (opts.autoHide) {
    clearTimeout(el._hideTimer);
    el._hideTimer = setTimeout(() => el.classList.add('hidden'), opts.autoHide);
  }
}

// Phase 3 placeholder — wired below when we add the summarize message
// handoff. Defined here so showRecordingStatus can reference it.
function summarizeLastTranscript() {
  if (!lastTranscript) return;
  // The sidepanel's send-message path expects a user-typed string. Drop the
  // transcript in as if the user pasted it with a summary instruction.
  const prompt =
    `I just recorded a tab. Here is the Whisper transcript — please summarize it ` +
    `in 5-8 bullet points and extract any action items, decisions, and open ` +
    `questions. Be concise.\n\n----- TRANSCRIPT -----\n${lastTranscript}\n----- END TRANSCRIPT -----`;
  if (inputEl) {
    inputEl.value = prompt;
    inputEl.dispatchEvent(new Event('input', { bubbles: true }));
  }
  if (sendBtn) sendBtn.click();
}

function handleAgentUpdateMessage(msg) {
  if (msg.type === 'scheduled_job') {
    handleScheduledJobEvent(msg.data, msg.tabId).catch((err) => {
      console.warn('[WebBrain] failed to handle scheduled job event:', err);
    });
    return;
  }

  // Drop updates that belong to a different tab's run. agent_update is a
  // window-wide broadcast (chrome.runtime.sendMessage has no per-tab
  // targeting from the service worker), and the side panel mounts a
  // fresh instance on every tab — so without this guard, an agent run
  // still in flight on tab A would render its "thinking…" / tool steps
  // / final text into a brand-new Cmd+T tab B's panel the moment B's
  // panel finished mounting. `msg.tabId == null` keeps backward compat
  // for any in-flight events from a pre-tabId background build.
  if (msg.tabId != null && msg.tabId !== currentTabId) return;

  const { type, data } = msg;

  switch (type) {
    case 'thinking':
      if (data?.note) {
        // Keep the step indicator alongside the note when there's real
        // progress (step > 0) so a slow call still shows movement; the planner
        // emits step 0, so it shows just "Planning…". (#4)
        const note = String(data.note);
        showActivity(
          data.step
            ? `${note} · ${t('sp.activity.thinking_step', { step: data.step })}`
            : note,
        );
      } else {
        showActivity(t('sp.activity.thinking_step', { step: data.step }));
      }
      break;

    case 'text':
      // Empty content means "the model returned nothing new at this step".
      // Don't wipe any previously-rendered assistant text — earlier steps
      // may already have put useful intermediate prose in the bubble.
      if (currentAssistantEl && data.content) {
        const textEl = currentAssistantEl.querySelector('.message-text');
        if (textEl) {
          if (verboseMode) {
            // Verbose mode: append each turn's reasoning as its own
            // paragraph so intermediate prose ("I'll click X", "the modal
            // is still open", "page changed, retrying") is preserved
            // alongside the steps log instead of being overwritten by the
            // next turn's blurb.
            const para = document.createElement('div');
            para.className = 'reasoning-step';
            para.innerHTML = formatMarkdown(data.content);
            textEl.appendChild(para);
          } else {
            // Compact mode keeps only the latest blurb. Replacing is
            // intentional here — most pre-tool reasoning is "I'll click X"
            // boilerplate that becomes obsolete once X is clicked, and the
            // steps log already captures what was done. Toggle Verbose
            // (V button) to retain the full reasoning trail.
            textEl.innerHTML = formatMarkdown(data.content);
          }
          // Add copy button if not already present
          if (!currentAssistantEl.querySelector('.msg-copy-btn')) {
            addMessageCopyButton(currentAssistantEl);
          }
        }
      }
      break;

    case 'text_delta':
      if (currentAssistantEl) {
        const textEl = currentAssistantEl.querySelector('.message-text');
        if (textEl && textEl.dataset.suppressToolCallStream !== 'true') {
          const nextText = textEl.textContent + data.content;
          if (looksLikeRawToolCallText(nextText)) {
            textEl.textContent = '';
            textEl.dataset.suppressToolCallStream = 'true';
          } else {
            textEl.textContent = nextText;
          }
        }
      }
      scrollToBottom();
      break;

    case 'tool_call':
      showActivity(friendlyToolLabel(data.name, data.args));
      showInspectionBanner(data.name);
      if (currentAssistantEl) {
        clearTransientAssistantTextForToolCall();
        if (verboseMode) {
          appendVerboseToolCall(data.name, data.args);
        } else {
          appendCompactStep(data.name, data.args);
        }
      }
      scrollToBottom();
      break;

    case 'tool_result':
      if (currentAssistantEl) {
        if (verboseMode) {
          appendVerboseToolResult(data.name, data.result);
        } else {
          markLastStepDone(data.name, data.result);
        }
      }
      scrollToBottom();
      break;

    case 'error':
      hideActivity();
      if (currentAssistantEl) markLastStepFailed();
      addMessage('error', t('sp.error_prefix', { msg: data.message }));
      break;

    case 'max_steps_reached':
      hideActivity();
      // Don't gate on currentAssistantEl — this event sometimes arrives
      // after the chat sendResponse has resolved and the finally block has
      // already nulled out currentAssistantEl. The continue bar attaches to
      // the messages container, not to a specific message, so it's fine to
      // show unconditionally.
      showContinueButton();
      break;

    case 'warning':
      hideActivity();
      break;

    case 'run_complete':
      if (currentAssistantEl) finalizeSteps(currentAssistantEl);
      // When a local send is still in flight (isProcessing), its own finally
      // resets run state and refreshes recommended actions *after* the final
      // text renders — so only finalize the steps visually here and let that
      // owner tear down, avoiding a premature double refresh/drain. When nothing
      // is processing locally (e.g. the panel remounted on a tab switch away and
      // back mid-run), run_complete is the sole finalizer and must tear down. (#4)
      if (!isProcessing) clearPlanReviewActiveRun(currentAssistantEl);
      scrollToBottom();
      break;

    case 'context_compacted':
      // The agent auto-summarized older turns to stay within the model's
      // context window. Show a subtle inline separator so the user knows
      // earlier history was compacted (not lost to a bug).
      addContextCompactedNote(data);
      break;

    case 'clarify':
      // Agent paused to ask the user a question. Render an inline card in
      // the current assistant bubble; the user picks an option or types a
      // custom answer, and we post `clarify_response` back to the bg.
      renderClarifyCard(data);
      break;

    case 'plan_review':
      renderPlanReviewCard(data);
      break;
  }
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.target !== 'sidepanel' || msg.action !== 'agent_update') return;
  if (queueAgentUpdateDuringTabSwitch(msg)) return;
  handleAgentUpdateMessage(msg);
});

/**
 * Render a clarify() prompt inside the current assistant message. Shows the
 * question, optional "reason" hint, suggested-option buttons, and a free-
 * text input. First submit (option click OR text submit) disables the card
 * and routes the answer to the background. UI stays visible after answering
 * so the user can see what they chose.
 */
function renderClarifyCard(data) {
  hideActivity();
  const tabId = data?.scheduledTabId ?? data?.tabId ?? currentTabId;
  if (tabId == null) return;
  const scheduledJobId = data?.scheduledJobId ? String(data.scheduledJobId) : '';
  let assistantEl = currentAssistantEl;
  if (scheduledJobId && data.forceNewScheduledCard) {
    assistantEl = addMessage('assistant', '');
  } else if (scheduledJobId && !assistantEl) {
    assistantEl = addMessage('assistant', '');
    currentAssistantEl = assistantEl;
  } else if (!assistantEl) {
    return;
  }
  if (scheduledJobId) {
    assistantEl.dataset.scheduledJobId = scheduledJobId;
  }
  const clarifyId = String(data.clarifyId || '');
  if (!clarifyId) return;

  const content = assistantEl.querySelector('.message-content');
  if (!content) return;

  const card = document.createElement('div');
  card.className = 'clarify-card';
  card.dataset.clarifyId = clarifyId;
  card.dataset.tabId = String(tabId);
  if (scheduledJobId) {
    card.dataset.scheduledJobId = scheduledJobId;
  }
  if (data.scheduledTabId != null) {
    card.dataset.scheduledTabId = String(data.scheduledTabId);
  }

  const qEl = document.createElement('div');
  qEl.className = 'clarify-question';
  qEl.textContent = String(data.question || '').slice(0, 600);
  card.appendChild(qEl);

  // Permission-prompt mode: localized question + three fixed choices that
  // return a stable VALUE ('once'/'always'/'deny'), and NO free-text input —
  // so there's nothing to parse and no English/locale dependency.
  if (data.permission && data.permission.capability) {
    card.dataset.permission = '1';
    const host = String(data.permission.host || '');
    const cap = String(data.permission.capability || '');
    const verb = t('sp.perm.verb.' + cap);
    qEl.textContent = t('sp.perm.question', { verb, host });

    const reasonEl = document.createElement('div');
    reasonEl.className = 'clarify-reason';
    reasonEl.textContent = t('sp.perm.reason');
    card.appendChild(reasonEl);

    const optionsEl = document.createElement('div');
    optionsEl.className = 'clarify-options';
    const choices = [
      ['once', t('sp.perm.allow_once')],
      ['always', t('sp.perm.always_allow', { host })],
      ['deny', t('sp.perm.dont_allow')],
    ];
    for (const [value, label] of choices) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'clarify-option';
      b.textContent = String(label).slice(0, 200);
      b.dataset.value = value;
      b.addEventListener('click', () => submitClarify(card, tabId, clarifyId, value, 'option'));
      optionsEl.appendChild(b);
    }
    card.appendChild(optionsEl);
    content.appendChild(card);
    scrollToBottom();
    return;
  }

  if (data.reason) {
    const reasonEl = document.createElement('div');
    reasonEl.className = 'clarify-reason';
    reasonEl.textContent = String(data.reason).slice(0, 400);
    card.appendChild(reasonEl);
  }

  const options = Array.isArray(data.options) ? data.options.slice(0, 4) : [];
  const optionsEl = options.length ? document.createElement('div') : null;
  if (optionsEl) {
    optionsEl.className = 'clarify-options';
    for (const opt of options) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'clarify-option';
      b.textContent = String(opt).slice(0, 200);
      b.addEventListener('click', () => submitClarify(card, tabId, clarifyId, b.textContent, 'option'));
      optionsEl.appendChild(b);
    }
    card.appendChild(optionsEl);
  }

  const row = document.createElement('div');
  row.className = 'clarify-row';
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'clarify-input';
  input.placeholder = options.length
    ? (typeof t === 'function' ? t('sp.clarify.input_placeholder_with_options') : 'Or type a different answer…')
    : (typeof t === 'function' ? t('sp.clarify.input_placeholder') : 'Type your answer…');
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && input.value.trim()) {
      e.preventDefault();
      submitClarify(card, tabId, clarifyId, input.value.trim(), 'text');
    }
  });
  const submitBtn = document.createElement('button');
  submitBtn.type = 'button';
  submitBtn.className = 'clarify-submit';
  submitBtn.textContent = typeof t === 'function' ? t('sp.clarify.submit') : 'Send';
  submitBtn.addEventListener('click', () => {
    const v = input.value.trim();
    if (v) submitClarify(card, tabId, clarifyId, v, 'text');
  });
  row.appendChild(input);
  row.appendChild(submitBtn);
  card.appendChild(row);

  content.appendChild(card);
  scrollToBottom();
  try { input.focus(); } catch {}
}

/**
 * Render a planner gate card — structured plan with approve/cancel.
 */
function renderPlanReviewCard(data) {
  hideActivity();
  const tabId = data?.tabId ?? currentTabId;
  if (tabId == null) return;
  let assistantEl = currentAssistantEl;
  if (!assistantEl) {
    assistantEl = addMessage('assistant', '');
    currentAssistantEl = assistantEl;
  }

  const planId = String(data.planId || '');
  if (!planId) return;

  const content = assistantEl.querySelector('.message-content');
  if (!content) return;

  const card = document.createElement('div');
  card.className = 'plan-review-card';
  card.dataset.planId = planId;
  card.dataset.tabId = String(tabId);

  const titleEl = document.createElement('div');
  titleEl.className = 'plan-review-title';
  titleEl.textContent = typeof t === 'function' ? t('sp.plan.title') : 'Review plan';
  card.appendChild(titleEl);

  // Match the agent-side scratchpad cap (formatPlanScratchpad keeps up to 8000
  // chars). A lower display cap would silently drop the plan's tail the moment
  // the user edits a long plan, since the edited textarea becomes the pinned
  // text. (#5)
  const compactMarkdown = String(data.markdown || data.plan?.summary || '').slice(0, 8000);
  const verboseMarkdown = String(data.verboseMarkdown || compactMarkdown).slice(0, 8000);
  const useVerbosePlan = verboseMode && !!data.verboseMarkdown;
  const originalMarkdown = useVerbosePlan ? verboseMarkdown : compactMarkdown;
  card.dataset.planMarkdownMode = useVerbosePlan ? 'verbose' : 'compact';

  const editHint = document.createElement('div');
  editHint.className = 'plan-review-hint';
  editHint.textContent = typeof t === 'function' ? t('sp.plan.edit_hint') : 'Optional: edit the plan before approving';
  card.appendChild(editHint);

  const textarea = document.createElement('textarea');
  textarea.className = 'plan-review-edit';
  textarea.rows = useVerbosePlan ? 8 : 5;
  textarea.value = originalMarkdown;
  textarea.defaultValue = originalMarkdown;
  card.appendChild(textarea);

  const actions = document.createElement('div');
  actions.className = 'plan-review-actions';

  const approveBtn = document.createElement('button');
  approveBtn.type = 'button';
  approveBtn.className = 'plan-review-approve';
  approveBtn.textContent = typeof t === 'function' ? t('sp.plan.approve') : 'Approve & run';

  const cancelBtn = document.createElement('button');
  cancelBtn.type = 'button';
  cancelBtn.className = 'plan-review-cancel';
  cancelBtn.textContent = typeof t === 'function' ? t('sp.plan.cancel') : 'Cancel';

  actions.appendChild(approveBtn);
  actions.appendChild(cancelBtn);
  card.appendChild(actions);
  bindPlanReviewCard(card);

  content.appendChild(card);
  scrollToBottom();
}

function submitPlanReview(card, tabId, planId, action, editedText) {
  if (card.classList.contains('plan-reviewed')) return;
  const activeAssistantEl = action === 'approve' ? reattachPlanReviewActiveRun(card) : null;
  const markdownMode = String(card.dataset.planMarkdownMode || 'compact') === 'verbose' ? 'verbose' : 'compact';
  card.classList.add('plan-reviewed');
  if (action !== 'approve') {
    card.remove();
    scrollToBottom();
    sendToBackground('plan_response', { tabId, planId, decision: action, editedText, markdownMode }).catch(() => {});
    return;
  }
  for (const el of card.querySelectorAll('button, textarea')) {
    el.disabled = true;
  }
  const note = document.createElement('div');
  note.className = 'plan-review-note';
  const expiredText = () => (typeof t === 'function' ? t('sp.plan.expired') : 'This plan is no longer awaiting review — the run was cancelled.');

  sendToBackground('plan_response', { tabId, planId, decision: action, editedText, markdownMode })
    .then((res) => {
      if (action !== 'approve') return;
      if (res?.matched) {
        card.remove();
      } else {
        note.textContent = expiredText();
        card.appendChild(note);
        if (activeAssistantEl) clearPlanReviewActiveRun(activeAssistantEl);
      }
      scrollToBottom();
    })
    .catch(() => {
      if (action === 'approve') {
        note.textContent = expiredText();
        card.appendChild(note);
        if (activeAssistantEl) clearPlanReviewActiveRun(activeAssistantEl);
        scrollToBottom();
      }
    });
}

function submitClarify(card, tabId, clarifyId, answer, source) {
  // Lock the card so the user can't double-submit and so it's visually
  // clear what was chosen. The pending Promise on the agent side only
  // accepts the first response anyway, but UI feedback matters.
  if (card.classList.contains('clarify-answered')) return;
  card.classList.add('clarify-answered');

  // Permission cards are transient: once the user chooses, remove the card
  // entirely so it doesn't linger at the bottom of the conversation (it could
  // otherwise render below the run's final result). General clarify cards stay
  // visible, locked, with the chosen answer shown.
  if (card.dataset.permission === '1') {
    card.remove();
  } else {
    for (const el of card.querySelectorAll('button, input')) {
      el.disabled = true;
    }
    const answered = document.createElement('div');
    answered.className = 'clarify-your-answer';
    answered.textContent = (typeof t === 'function' ? t('sp.clarify.your_answer') : 'Your answer:') + ' ' + answer;
    card.appendChild(answered);
    scrollToBottom();
  }

  // IMPORTANT: include `target: 'background'`. Without it, background's
  // message router (chrome.runtime.onMessage in background.js) silently
  // drops the message — the very first line is
  //   if (msg.target !== 'background') return;
  // …and the agent's pending clarify Promise hangs forever, leaving the
  // run stuck in `status: "running"` even after the user answers. Use
  // sendToBackground() rather than chrome.runtime.sendMessage directly
  // so the target field is always injected.
  const isScheduledClarify = !!card.dataset.scheduledJobId;
  if (isScheduledClarify) {
    const msgEl = card.closest('.message.assistant');
    const scheduledJobId = card.dataset.scheduledJobId;
    if (msgEl && (!currentAssistantEl || currentAssistantEl.dataset?.scheduledJobId === scheduledJobId)) {
      currentAssistantEl = msgEl;
    }
    isProcessing = true;
    syncSendButtonState();
    showActivity(t('sp.activity.thinking'));
  }
  sendToBackground('clarify_response', { tabId, clarifyId, answer, source })
    .catch(() => {
      if (isScheduledClarify) {
        isProcessing = false;
        syncSendButtonState();
        hideActivity();
        drainQueuedContextMenuPromptsAfterPendingTabSwitch();
      }
      /* background may be torn down — clarify state already lives there */
    });
}


// ==========================================================================
// COMPACT MODE (default) — shows tool steps as a tidy activity log
// ==========================================================================

function getOrCreateStepsContainer() {
  if (!currentAssistantEl) return null;
  const content = currentAssistantEl.querySelector('.message-content');
  let container = content.querySelector('.steps-container');
  if (!container) {
    container = document.createElement('div');
    container.className = 'steps-container';
    // Insert before the text element
    const textEl = content.querySelector('.message-text');
    content.insertBefore(container, textEl);
  }
  return container;
}

function appendCompactStep(toolName, args) {
  const container = getOrCreateStepsContainer();
  if (!container) return;

  // Mark previous active step as done if still spinning
  const prev = container.querySelector('.step-item.active');
  if (prev) {
    prev.classList.remove('active');
    prev.classList.add('done');
    const icon = prev.querySelector('.step-icon');
    if (icon) { icon.className = 'step-icon check'; icon.textContent = '\u2713'; }
  }

  const step = document.createElement('div');
  step.className = 'step-item active';
  step.dataset.tool = toolName;

  const icon = document.createElement('span');
  icon.className = 'step-icon spinning';
  icon.textContent = '';

  const label = document.createElement('span');
  label.className = 'step-label';
  label.textContent = friendlyToolLabel(toolName, args);

  // Small toggle to peek at details
  const toggle = document.createElement('button');
  toggle.className = 'step-details-toggle';
  toggle.textContent = t('sp.step.details');
  toggle.addEventListener('click', (e) => {
    e.stopPropagation();
    const details = step.nextElementSibling;
    if (details && details.classList.contains('step-details')) {
      details.classList.toggle('open');
    }
  });

  step.appendChild(icon);
  step.appendChild(label);
  step.appendChild(toggle);
  container.appendChild(step);

  // Hidden details panel (populated when result arrives)
  const details = document.createElement('div');
  details.className = 'step-details';
  details.innerHTML = `<div class="detail-label">${escapeHtml(t('sp.step.input_label'))}</div><div class="detail-args">${escapeHtml(JSON.stringify(args, null, 2))}</div>`;
  container.appendChild(details);
}

function markLastStepDone(toolName, result) {
  const container = getOrCreateStepsContainer();
  if (!container) return;

  const active = container.querySelector('.step-item.active');
  if (active) {
    active.classList.remove('active');
    active.classList.add('done');
    const icon = active.querySelector('.step-icon');
    if (icon) {
      const success = !result?.error;
      icon.className = success ? 'step-icon check' : 'step-icon fail';
      icon.textContent = success ? '\u2713' : '\u2717';
    }

    // Append result to the details panel
    const details = active.nextElementSibling;
    if (details && details.classList.contains('step-details')) {
      const resultDiv = document.createElement('div');
      resultDiv.className = 'detail-result';
      resultDiv.innerHTML = `<div class="detail-label">${escapeHtml(t('sp.step.result_label'))}</div>${escapeHtml(truncate(JSON.stringify(result), 300))}`;
      details.appendChild(resultDiv);
    }
  }
}

function markLastStepFailed() {
  const container = getOrCreateStepsContainer();
  if (!container) return;
  const active = container.querySelector('.step-item.active');
  if (active) {
    active.classList.remove('active');
    active.classList.add('done');
    const icon = active.querySelector('.step-icon');
    if (icon) { icon.className = 'step-icon fail'; icon.textContent = '\u2717'; }
  }
}

function finalizeSteps(assistantEl = currentAssistantEl) {
  if (!assistantEl) return;
  const actives = assistantEl.querySelectorAll('.step-item.active');
  actives.forEach(step => {
    step.classList.remove('active');
    step.classList.add('done');
    const icon = step.querySelector('.step-icon');
    if (icon) { icon.className = 'step-icon check'; icon.textContent = '\u2713'; }
  });
}

function looksLikeRawToolCallText(text) {
  return /<\/?(?:tool_call|function|parameter)\b|<\|\/?tool_call|ref_id\s*["']?\s*[:=]\s*["']?ref_\d+/i.test(String(text || ''));
}

function clearTransientAssistantTextForToolCall() {
  if (!currentAssistantEl) return;
  const textEl = currentAssistantEl.querySelector('.message-text');
  if (!textEl) return;
  const text = textEl.textContent || '';
  if (!text.trim()) {
    delete textEl.dataset.suppressToolCallStream;
    return;
  }
  if (!verboseMode || looksLikeRawToolCallText(text)) {
    textEl.textContent = '';
  }
  delete textEl.dataset.suppressToolCallStream;
}


// ==========================================================================
// VERBOSE MODE (opt-in) — full tool call + result blocks
// ==========================================================================

function appendVerboseToolCall(name, args) {
  if (!currentAssistantEl) return;
  const content = currentAssistantEl.querySelector('.message-content');

  const el = document.createElement('div');
  el.className = 'tool-call';

  const header = document.createElement('div');
  header.className = 'tool-call-header';
  const icon = document.createElement('span');
  icon.className = 'icon';
  icon.textContent = '\u26A1';
  header.append(icon, document.createTextNode(` ${name || ''}`));

  const body = document.createElement('div');
  body.className = 'tool-call-body';
  body.textContent = JSON.stringify(args, null, 2);

  el.appendChild(header);
  el.appendChild(body);

  const textEl = content.querySelector('.message-text');
  content.insertBefore(el, textEl);
}

function appendVerboseToolResult(name, result) {
  if (!currentAssistantEl) return;
  const content = currentAssistantEl.querySelector('.message-content');
  const lastTool = content.querySelector('.tool-call:last-of-type');
  if (lastTool) {
    const resultEl = document.createElement('div');
    resultEl.className = 'tool-result';
    resultEl.textContent = truncate(JSON.stringify(result), 200);
    lastTool.appendChild(resultEl);
  }
}


// ==========================================================================
// UI Helpers
// ==========================================================================

// WebBrain Cloud returns a 402 with a trailing "Subscribe for more usage: <url>"
// line once the free daily allowance runs out. Detect that shape so we can turn
// the bare URL into a real Subscribe button instead of making the user copy it.
const SUBSCRIBE_ERROR_RE = /Subscribe for more usage:\s*(https?:\/\/\S+)/i;

function parseSubscribeError(content) {
  if (typeof content !== 'string') return null;
  const m = content.match(SUBSCRIBE_ERROR_RE);
  if (!m) return null;
  // Strip trailing punctuation that markdown/markup might have appended.
  const url = m[1].replace(/[)\].,"'>]+$/, '');
  const message = content.slice(0, m.index).replace(/\s+$/, '').trim();
  return { url, message };
}

function openSubscribeUrl(url) {
  if (!url) return;
  try { chrome.tabs.create({ url }); }
  catch { window.open(url, '_blank', 'noopener'); }
}

// Render the quota error as a card with a one-click Subscribe button. Returns
// true when `content` matched and the card was rendered into `textEl`, so the
// caller can skip its normal markdown rendering. The URL is stashed on the
// button's dataset so it survives chat-history restore (messagesEl.innerHTML),
// where the click closure is lost and rebindSubscribeButtons re-attaches it.
function renderSubscribeError(textEl, content) {
  const parsed = parseSubscribeError(content);
  if (!parsed) return false;

  textEl.replaceChildren();
  textEl.classList.add('subscribe-error');

  const msg = document.createElement('div');
  msg.className = 'subscribe-error-text';
  msg.textContent = parsed.message || t('sp.subscribe.allowance_used');
  textEl.appendChild(msg);

  const btn = document.createElement('button');
  btn.className = 'subscribe-btn';
  btn.textContent = t('sp.subscribe.btn');
  btn.dataset.subscribeUrl = parsed.url;
  btn.dataset.bound = 'true';
  btn.addEventListener('click', () => openSubscribeUrl(btn.dataset.subscribeUrl));
  textEl.appendChild(btn);
  return true;
}

function addMessage(role, content) {
  const msgEl = document.createElement('div');
  msgEl.className = `message ${role}`;

  const contentEl = document.createElement('div');
  contentEl.className = 'message-content';

  const textEl = document.createElement('div');
  textEl.className = 'message-text';
  if (role === 'user') {
    textEl.textContent = content;
  } else if (role === 'system') {
    if (isSystemHtml(content)) textEl.innerHTML = content.__systemHtml;
    else textEl.textContent = content || '';
  } else if (!renderSubscribeError(textEl, content)) {
    textEl.innerHTML = content ? formatMarkdown(content) : '';
  }

  contentEl.appendChild(textEl);
  msgEl.appendChild(contentEl);
  messagesEl.appendChild(msgEl);

  // Add copy button to assistant messages
  if (role === 'assistant' && content) {
    addMessageCopyButton(msgEl);
  }

  scrollToBottom();

  return msgEl;
}

/**
 * Render the "Context automatically compacted" notice as a centered inline
 * separator in the conversation. Fired by the agent's onUpdate('context_compacted')
 * when older turns were summarized to stay within the model's context window.
 */
function addContextCompactedNote(data) {
  const note = document.createElement('div');
  note.className = 'context-compacted-note';
  note.textContent = t(data?.manual ? 'sp.context_compacted_manual' : 'sp.context_compacted');
  if (data && data.summarized != null && data.remaining != null) {
    note.title = t('sp.context_compacted_detail', {
      summarized: data.summarized,
      remaining: data.remaining,
    });
  }
  // Insert into the active assistant bubble's steps log so the separator lands
  // at the actual compaction point, interleaved with the tool steps. Appending
  // to messagesEl would drop it *after* the still-open bubble — i.e. before the
  // text/tool output that the same bubble keeps receiving post-compaction.
  const stepsContainer = getOrCreateStepsContainer();
  if (stepsContainer) {
    stepsContainer.appendChild(note);
  } else {
    messagesEl.appendChild(note);
  }
  scrollToBottom();
}

const MAX_AGENT_STEPS_UNLIMITED_SENTINEL = 200;

function displayMaxAgentSteps(value) {
  const n = Number(value);
  if (Number.isFinite(n) && (n === 0 || n >= MAX_AGENT_STEPS_UNLIMITED_SENTINEL)) return '∞';
  return Number.isFinite(n) && n > 0 ? String(Math.floor(n)) : '130';
}

function showContinueButton() {
  // Remove any existing continue button
  document.querySelectorAll('.continue-bar').forEach(el => el.remove());

  const bar = document.createElement('div');
  bar.className = 'continue-bar';
  bar.innerHTML = `
    <span class="continue-text">${escapeHtml(t('sp.continue_bar', { steps: displayMaxAgentSteps(agent_maxSteps) }))}</span>
    <button class="continue-btn" id="btn-continue">${escapeHtml(t('sp.continue_btn'))}</button>
  `;
  messagesEl.appendChild(bar);
  scrollToBottom();

  document.getElementById('btn-continue').addEventListener('click', continueAgent);
}

async function continueAgent() {
  const tabId = currentTabId;
  const modeForSend = agentMode;
  // Remove the continue bar
  document.querySelectorAll('.continue-bar').forEach(el => el.remove());

  isProcessing = true;
  abortRequested = false;
  syncSendButtonState();

  const assistantEl = addMessage('assistant', '');
  currentAssistantEl = assistantEl;
  showActivity(t('sp.activity.continuing'));

  try {
    const res = await sendToBackground('continue', {
      tabId,
      mode: modeForSend,
    });

    if (currentTabId === tabId && res?.content && assistantEl) {
      const textEl = assistantEl.querySelector('.message-text');
      if (textEl && !textEl.textContent.trim()) {
        if (!renderSubscribeError(textEl, res.content)) {
          textEl.innerHTML = formatMarkdown(res.content);
        }
        addMessageCopyButton(assistantEl);
      }
    }
  } catch (e) {
    if (currentTabId === tabId && !abortRequested) {
      addMessage('error', t('sp.error_prefix', { msg: e.message }));
    }
  } finally {
    if (currentTabId === tabId) finalizeSteps(assistantEl);
    isProcessing = false;
    abortRequested = false;
    syncSendButtonState();
    hideActivity();
    if (currentAssistantEl === assistantEl) currentAssistantEl = null;
    if (currentTabId === tabId) scrollToBottom();
    if (currentTabId === tabId && renderedTabId === tabId) await flushRenderedTabChat();
    await drainQueuedContextMenuPromptsAfterPendingTabSwitch();
  }
}

// Track max steps for display in continue bar
let agent_maxSteps = 130;
chrome.storage.local.get('maxAgentSteps').then(s => { agent_maxSteps = s.maxAgentSteps ?? 130; });
chrome.storage.onChanged.addListener((changes) => {
  if (changes.maxAgentSteps) agent_maxSteps = changes.maxAgentSteps.newValue;
});

// Page inspection banner — shown when agent starts interacting with the page
const PAGE_TOOLS = new Set(['read_page', 'read_page_source', 'get_interactive_elements', 'click', 'type_text', 'scroll', 'extract_data', 'inspect_element_styles', 'wait_for_element', 'get_selection']);
let inspectionBannerShown = false;

function showInspectionBanner(toolName) {
  return; // stop
  if (inspectionBannerShown || !PAGE_TOOLS.has(toolName)) return;
  inspectionBannerShown = true;

  const banner = document.getElementById('inspection-banner');
  if (banner) {
    banner.classList.remove('hidden');
  }

  // Set extension badge
  chrome.action?.setBadgeText?.({ text: '🔍' }).catch(() => {});
  chrome.action?.setBadgeBackgroundColor?.({ color: '#6c63ff' }).catch(() => {});
}

function hideInspectionBanner() {
  return;
  inspectionBannerShown = false;
  const banner = document.getElementById('inspection-banner');
  if (banner) {
    banner.classList.add('hidden');
  }
  chrome.action?.setBadgeText?.({ text: '' }).catch(() => {});
}

function showActivity(text) {
  agentActivity.classList.remove('hidden');
  activityText.textContent = text;
}

function hideActivity() {
  agentActivity.classList.add('hidden');
  hideInspectionBanner();
}

function scrollToBottom() {
  const container = document.getElementById('chat-container');
  container.scrollTop = container.scrollHeight;
}

// Debounce math rendering so streaming updates don't re-walk the DOM
// on every token.
let _mathRenderTimer = null;
function scheduleMathRender() {
  if (_mathRenderTimer) return;
  _mathRenderTimer = setTimeout(() => {
    _mathRenderTimer = null;
    try {
      if (typeof window.renderMathInElement !== 'function') return;
      const target = document.getElementById('messages');
      if (!target) return;
      window.renderMathInElement(target, {
        // Delimiters in order of precedence. We deliberately do NOT enable
        // single-`$...$` as an inline-math delimiter: LLM responses very
        // often contain dollar amounts ("$1,263 ... $2,526") and KaTeX
        // would pair them up and italicize the prose between them. Users
        // who genuinely want inline math can use \\( ... \\) or $$...$$.
        delimiters: [
          { left: '$$', right: '$$', display: true },
          { left: '\\[', right: '\\]', display: true },
          { left: '\\(', right: '\\)', display: false },
        ],
        // Don't crash the whole message on a bad expression — show the raw
        // source in red instead.
        throwOnError: false,
        errorColor: '#f44336',
        // Skip rendering inside code blocks and already-rendered math.
        ignoredTags: ['script', 'noscript', 'style', 'textarea', 'pre', 'code'],
        ignoredClasses: ['katex', 'code-block-wrapper'],
      });
    } catch (e) {
      console.warn('[webbrain] math render failed:', e);
    }
  }, 50);
}

function formatMarkdown(text) {
  if (!text) return '';

  // 1. Extract fenced code blocks BEFORE escaping HTML
  const codeBlocks = [];
  text = text.replace(/```(\w*)\n?([\s\S]*?)```/g, (_match, lang, code) => {
    const id = `__CODEBLOCK_${codeBlocks.length}__`;
    codeBlocks.push({ lang: lang || '', code });
    return id;
  });

  // 2. Extract inline code before escaping
  const inlineCodes = [];
  text = text.replace(/`([^`\n]+)`/g, (_match, code) => {
    const id = `__INLINE_${inlineCodes.length}__`;
    inlineCodes.push(code);
    return id;
  });

  // 3. Escape HTML in the remaining text
  text = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  // 4. Inline formatting (bold + italic), then markdown link sanitization,
  // then newline → <br>. Links are handled by the dedicated markdown-link
  // module (unit-tested in test/run.js) — see that file for the rationale
  // and threat model.
  text = text
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>');
  text = sanitizeMarkdownLinks(text);
  text = text.replace(/\n/g, '<br>');

  // 5. Restore inline code
  inlineCodes.forEach((code, i) => {
    const escaped = code.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    // Function replacer: a string replacement would interpret `$&`, `$\``, etc.
    // in code that contains literal `$` sequences (shell, jQuery, regex), mangling it.
    text = text.replace(`__INLINE_${i}__`, () => `<code>${escaped}</code>`);
  });

  // 6. Restore fenced code blocks with copy button
  codeBlocks.forEach((block, i) => {
    const escaped = block.code.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const langLabel = block.lang ? `<span class="code-lang">${escapeHtml(block.lang)}</span>` : '';
    const copyBtn = `<button class="code-copy-btn" data-code-index="${i}" title="${escapeHtml(t('sp.copy.code.title'))}">${escapeHtml(t('sp.copy'))}</button>`;
    const header = `<div class="code-block-header">${langLabel}${copyBtn}</div>`;
    text = text.replace(
      `__CODEBLOCK_${i}__`,
      () => `<div class="code-block-wrapper">${header}<pre><code>${escaped}</code></pre></div>`
    );
  });

  // Schedule KaTeX rendering of any math expressions in the messages area.
  // auto-render walks text nodes and replaces $...$, $$...$$, \(...\), \[...\]
  // with rendered spans. It's idempotent (rendered spans are skipped on
  // subsequent passes) so we can safely call it after every innerHTML write.
  scheduleMathRender();

  // Store raw code for copy buttons to use
  if (codeBlocks.length > 0) {
    setTimeout(() => {
      document.querySelectorAll('.code-copy-btn').forEach(btn => {
        if (btn.dataset.bound) return;
        btn.dataset.bound = 'true';
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          // Get the code from the adjacent pre>code element
          const wrapper = btn.closest('.code-block-wrapper');
          const codeEl = wrapper?.querySelector('pre code');
          if (codeEl) {
            navigator.clipboard.writeText(codeEl.textContent).then(() => {
              btn.textContent = t('sp.copied');
              btn.classList.add('copied');
              setTimeout(() => { btn.textContent = t('sp.copy'); btn.classList.remove('copied'); }, 1500);
            });
          }
        });
      });
    }, 0);
  }

  return text;
}

/** Adds a copy button to an entire assistant message (for non-code text) */
function addMessageCopyButton(msgEl) {
  if (!msgEl) return;
  const content = msgEl.querySelector('.message-content');
  if (!content) return;
  const btn = document.createElement('button');
  btn.className = 'msg-copy-btn';
  btn.textContent = t('sp.copy');
  btn.title = t('sp.copy.code.title');
  bindMessageCopyButton(btn);
  content.appendChild(btn);
}

function addScratchpadCopyButton(msgEl) {
  if (!msgEl) return;
  const content = msgEl.querySelector('.message-content');
  const pre = content?.querySelector('pre.scratchpad-dump');
  if (!content || !pre) return;
  const btn = document.createElement('button');
  btn.className = 'msg-copy-btn scratchpad-copy-btn';
  btn.textContent = t('sp.copy');
  btn.title = t('sp.copy.code.title');
  bindMessageCopyButton(btn);
  content.appendChild(btn);
}

function getMessageCopyText(btn) {
  const content = btn?.closest('.message-content');
  if (!content) return null;
  if (btn.classList.contains('scratchpad-copy-btn')) {
    return content.querySelector('pre.scratchpad-dump')?.textContent || '';
  }
  return content.querySelector('.message-text')?.innerText || null;
}

function bindMessageCopyButton(btn) {
  if (!btn || btn.__wbCopyBound) return;
  btn.__wbCopyBound = true;
  btn.addEventListener('click', () => {
    const text = getMessageCopyText(btn);
    if (text == null) return;
    navigator.clipboard.writeText(text).then(() => {
      btn.textContent = t('sp.copied');
      btn.classList.add('copied');
      setTimeout(() => { btn.textContent = t('sp.copy'); btn.classList.remove('copied'); }, 1500);
    });
  });
}

function escapeHtml(str) {
  return String(str == null ? '' : str).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[c]));
}

function systemHtml(html) {
  return { __systemHtml: String(html == null ? '' : html) };
}

function isSystemHtml(content) {
  return !!content && typeof content === 'object' && Object.prototype.hasOwnProperty.call(content, '__systemHtml');
}

function tSystemHtml(key, params) {
  const safeParams = {};
  for (const [name, value] of Object.entries(params || {})) {
    safeParams[name] = escapeHtml(value);
  }
  return t(key, safeParams);
}

function truncate(str, len) {
  return str.length > len ? str.slice(0, len) + '...' : str;
}

function autoResizeInput() {
  inputEl.style.height = 'auto';
  inputEl.style.height = Math.min(inputEl.scrollHeight, 120) + 'px';
  updateSlashCommandHighlight();
}

function getInputPlaceholderKeys() {
  return agentMode === 'ask' ? ASK_PLACEHOLDER_KEYS : ['sp.input.act_placeholder'];
}

function updateInputPlaceholder() {
  const keys = getInputPlaceholderKeys();
  const key = keys[placeholderRotationIndex % keys.length];
  inputEl.placeholder = t(key);
  // Keep this attribute aligned with the currently visible placeholder so the
  // generic i18n pass can refresh it after locale changes without disabling
  // the rotating tip behavior.
  inputEl.dataset.i18nPlaceholder = key;
}

function resetInputPlaceholderRotation() {
  placeholderRotationIndex = 0;
  updateInputPlaceholder();
}

function startInputPlaceholderRotation() {
  if (placeholderRotationTimer) return;
  placeholderRotationTimer = setInterval(() => {
    placeholderRotationIndex += 1;
    updateInputPlaceholder();
  }, PLACEHOLDER_ROTATION_INTERVAL_MS);
}

// --- Communication ---

function sendToBackground(action, data = {}) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(
      { target: 'background', action, ...data },
      (response) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
        } else if (response == null) {
          reject(new Error(`No response from WebBrain background for "${action}". The background script may have restarted or crashed; reload the sidebar/extension and check the extension console for the original error.`));
        } else if (response?.error) {
          reject(new Error(response.error));
        } else {
          resolve(response);
        }
      }
    );
  });
}

// --- Keyboard shortcuts ---

function handleRecordingEscapeKey(e) {
  if (e.key !== 'Escape' || !recordingActive || !e.isTrusted) return false;
  e.preventDefault();
  e.stopPropagation();
  const now = Date.now();
  if (now <= recordingEscapeArmedUntil) {
    recordingEscapeArmedUntil = 0;
    stopRecording();
    return true;
  }
  recordingEscapeArmedUntil = now + RECORDING_DOUBLE_ESCAPE_MS;
  return true;
}

async function handleGlobalKeydown(e) {
  if (e.defaultPrevented) return;

  // Don't steal shortcuts from other input elements (e.g. schedule form fields)
  const tag = e.target?.tagName;
  const isOtherFormField = e.target !== inputEl && (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT');

  if (e.key === 'Escape') {
    const slashMenuOpen = !!slashCommandMenuEl && !slashCommandMenuEl.classList.contains('hidden');
    if (slashMenuOpen) return;
    if (isProcessing) {
      e.preventDefault();
      abortRun();
      return;
    }
    if (isOtherFormField) return;
    if (handleRecordingEscapeKey(e)) return;
  }

  if (isOtherFormField) return;

  const mod = e.ctrlKey || e.metaKey;

  // Ctrl+/ (Cmd+/ on Mac): focus input
  if (mod && e.key === '/') {
    e.preventDefault();
    inputEl.focus();
    inputEl.setSelectionRange(inputEl.value.length, inputEl.value.length);
    return;
  }
  // Ctrl+Shift+A: switch to Ask mode (blocked while agent is running)
  if (mod && e.shiftKey && e.key === 'A' && !isProcessing) {
    e.preventDefault();
    setMode('ask');
    return;
  }
  // Ctrl+Shift+X: switch to Act mode (blocked while agent is running)
  if (mod && e.shiftKey && e.key === 'X' && !isProcessing) {
    e.preventDefault();
    await ensureActMode();
    return;
  }
}

// --- Mode Toggle ---

function setMode(mode) {
  agentMode = mode;

  if (mode === 'ask') {
    modeAskBtn.classList.add('active');
    modeAskBtn.classList.remove('act');
    modeActBtn.classList.remove('active', 'act');
    updateActWarning();
    inputArea.classList.remove('act-mode');
    resetInputPlaceholderRotation();
  } else {
    modeActBtn.classList.add('active', 'act');
    modeAskBtn.classList.remove('active');
    updateActWarning();
    inputArea.classList.add('act-mode');
    resetInputPlaceholderRotation();
  }
}

async function ensureActMode() {
  if (agentMode === 'act') return true;
  // Show a confirmation dialog the very first time the user enables Act
  // mode on this install — tracked via chrome.storage.local so it only
  // happens once, not on every click. Recommended action chips share this
  // path so they cannot silently bypass the Act-mode warning.
  try {
    const stored = await chrome.storage.local.get('actConfirmed');
    if (!stored.actConfirmed) {
      const ok = confirm(t('sp.mode.act.confirm'));
      if (!ok) return false;
      await chrome.storage.local.set({ actConfirmed: true }).catch(() => {});
    }
  } catch (e) { /* storage unavailable, fall through */ }
  setMode('act');
  return true;
}

modeAskBtn.addEventListener('click', () => setMode('ask'));

modeActBtn.addEventListener('click', async () => {
  await ensureActMode();
});


// --- Stop / Abort ---

async function abortRun() {
  if (!isProcessing) return;
  abortRequested = true;
  showActivity(t('sp.activity.stopping'));

  try {
    await sendToBackground('abort', { tabId: currentTabId });
  } catch {
    // Best effort
  }

  // Force UI to settle even if background doesn't respond cleanly
  setTimeout(async () => {
    if (abortRequested) {
      finalizeSteps();
      if (currentAssistantEl) {
        const textEl = currentAssistantEl.querySelector('.message-text');
        if (textEl && !textEl.textContent.trim()) {
          textEl.innerHTML = t('sp.stopped_by_user_html');
        }
      }
      isProcessing = false;
      syncSendButtonState();
      hideActivity();
      currentAssistantEl = null;
      abortRequested = false;
      await flushRenderedTabChat();
      await drainQueuedContextMenuPromptsAfterPendingTabSwitch();
    }
  }, 3000); // safety timeout if background takes too long
}

stopBtn.addEventListener('click', abortRun);

// --- Voice input (mic dictation, issue #210) ---
// Web Speech API: well-supported in Chrome, absent in stock Firefox (which
// lacks window.SpeechRecognition entirely). The mic button stays visible
// either way — a hidden button gives the user no signal as to WHY voice
// input doesn't work. Instead it's shown grayed out with a tooltip and an
// in-chat message on click explaining the reason: unsupported browser, or
// disabled via the "Voice input" toggle in Settings.
const SpeechRecognitionImpl = window.SpeechRecognition || window.webkitSpeechRecognition;
let speechRecognition = null;
let isListening = false;
let micInterimText = ''; // the interim transcript tail we last appended to the input
let voiceInputSettingEnabled = true; // mirrors storage 'voiceInputEnabled', on by default
let micDisabledReason = null; // null | 'unsupported' | 'settings' | 'permission_denied'
let micPermissionDenied = false; // latched when Chrome denies mic; cleared by permissionchange
let micRequestInFlight = false; // prevents concurrent requestMicAndStart() calls

function setMicIdleIcon() {
  if (!micBtn) return;
  micBtn.innerHTML = `<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M12 14a3 3 0 0 0 3-3V6a3 3 0 0 0-6 0v5a3 3 0 0 0 3 3z"/><path d="M19 11a7 7 0 0 1-14 0" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="M12 18v3" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>`;
}

function updateMicButtonState() {
  if (!micBtn) return;
  micDisabledReason = !SpeechRecognitionImpl ? 'unsupported'
    : !voiceInputSettingEnabled ? 'settings'
    : micPermissionDenied ? 'permission_denied'
    : null;
  micBtn.classList.toggle('mic-disabled', !!micDisabledReason);
  micBtn.title = micDisabledReason === 'unsupported' ? t('sp.mic.unsupported')
    : micDisabledReason === 'settings' ? t('sp.mic.disabled_settings')
    : micDisabledReason === 'permission_denied' ? t('sp.mic.permission_denied')
    : (isListening ? t('sp.btn.mic_stop') : t('sp.btn.mic'));
}

function stopListening() {
  if (!isListening) return;
  isListening = false;
  if (micBtn) {
    micBtn.classList.remove('listening');
    setMicIdleIcon();
  }
  updateMicButtonState();
  // Detach handlers before stop(): the engine can fire a trailing
  // onresult/onend *after* stop() for buffered audio. Left attached, that
  // late onresult would repaint the input (resurrecting just-sent text), and
  // a stale onend would clobber the state of a freshly-started session.
  const recognition = speechRecognition;
  speechRecognition = null;
  micInterimText = '';
  if (recognition) {
    recognition.onresult = null;
    recognition.onerror = null;
    recognition.onend = null;
    try { recognition.stop(); } catch { /* ignore */ }
  }
}

function startListening() {
  if (!SpeechRecognitionImpl || !inputEl) return;
  const recognition = new SpeechRecognitionImpl();
  speechRecognition = recognition;
  recognition.lang = getLocale();
  recognition.continuous = true;
  recognition.interimResults = true;
  micInterimText = '';

  // Append transcripts to whatever is currently in the box, replacing only
  // the interim tail we ourselves appended. This preserves text the user
  // types by hand during dictation instead of overwriting it.
  recognition.onresult = (e) => {
    if (!isListening || speechRecognition !== recognition) return;
    // Strip our previous interim tail only if it's still the suffix — a
    // manual edit after it means the user took over, so leave it alone.
    if (micInterimText && inputEl.value.endsWith(micInterimText)) {
      inputEl.value = inputEl.value.slice(0, inputEl.value.length - micInterimText.length);
    }
    let interimTranscript = '';
    let finalTranscript = '';
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const transcript = e.results[i][0].transcript;
      if (e.results[i].isFinal) finalTranscript += transcript;
      else interimTranscript += transcript;
    }
    if (finalTranscript) {
      const sep = inputEl.value && !/\s$/.test(inputEl.value) ? ' ' : '';
      inputEl.value += sep + finalTranscript;
    }
    if (interimTranscript) {
      const sep = inputEl.value && !/\s$/.test(inputEl.value) ? ' ' : '';
      micInterimText = sep + interimTranscript;
      inputEl.value += micInterimText;
    } else {
      micInterimText = '';
    }
    handleInput();
  };

  recognition.onerror = (e) => {
    stopListening();
    if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
      if (!micPermissionDenied) {
        micPermissionDenied = true;
        updateMicButtonState();
        addMessage('system', t('sp.mic.permission_denied'));
      }
    }
  };
  recognition.onend = () => {
    if (speechRecognition !== recognition) return; // superseded by a newer session
    isListening = false;
    speechRecognition = null;
    micInterimText = '';
    if (micBtn) {
      micBtn.classList.remove('listening');
      setMicIdleIcon();
    }
    updateMicButtonState();
  };

  isListening = true;
  if (micBtn) {
    micBtn.classList.add('listening');
    micBtn.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><rect x="4" y="4" width="16" height="16" rx="3"/></svg>`;
  }
  updateMicButtonState();
  recognition.start();
}

// Chrome's side panel context never surfaces the getUserMedia permission
// dialog — it silently rejects. A real popup window does trigger it.
// On first failure we open a small popup, wait for the user to click Allow,
// then start listening once the permission is cached on the extension origin.
function openMicPermissionPopup() {
  return new Promise((resolve) => {
    let popupId = null;
    let settled = false;
    const settle = (granted) => {
      if (settled) return;
      settled = true;
      chrome.runtime.onMessage.removeListener(onMsg);
      chrome.windows.onRemoved.removeListener(onRemoved);
      resolve(granted);
    };
    const onMsg = (msg) => {
      if (msg.type === 'mic-permission-granted') settle(true);
      else if (msg.type === 'mic-permission-denied') settle(false);
    };
    const onRemoved = (id) => { if (id === popupId) settle(false); };
    chrome.runtime.onMessage.addListener(onMsg);
    chrome.windows.onRemoved.addListener(onRemoved);
    chrome.windows.create({
      url: chrome.runtime.getURL('src/ui/mic-permission.html'),
      type: 'popup',
      width: 380,
      height: 240,
    }, (win) => { popupId = win?.id ?? null; });
  });
}

async function requestMicAndStart() {
  if (micRequestInFlight) return;
  micRequestInFlight = true;
  try {
    let granted = false;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach(t => t.stop());
      granted = true;
    } catch {
      // Side panel can't show the permission dialog — delegate to a popup window.
      granted = await openMicPermissionPopup();
    }
    if (!granted) {
      micPermissionDenied = true;
      updateMicButtonState();
      addMessage('system', t('sp.mic.permission_denied'));
      return;
    }
    // "Allow this time" only grants access to the popup window, not the side
    // panel. Verify the permission carried over before starting.
    try {
      const s = await navigator.mediaDevices.getUserMedia({ audio: true });
      s.getTracks().forEach(t => t.stop());
    } catch {
      addMessage('system', t('sp.mic.use_allow_site'));
      return;
    }
    startListening();
  } finally {
    micRequestInFlight = false;
  }
}

if (micBtn) {
  chrome.storage.local.get('voiceInputEnabled').then((stored) => {
    voiceInputSettingEnabled = stored?.voiceInputEnabled ?? true;
    updateMicButtonState();
  }).catch(() => {});
  chrome.storage.onChanged.addListener((changes) => {
    if (changes.voiceInputEnabled) {
      voiceInputSettingEnabled = changes.voiceInputEnabled.newValue ?? true;
      if (!voiceInputSettingEnabled) stopListening();
      updateMicButtonState();
    }
  });
  micBtn.addEventListener('click', async () => {
    if (micDisabledReason === 'unsupported') {
      addMessage('system', t('sp.mic.unsupported'));
      return;
    }
    if (micDisabledReason === 'settings') {
      addMessage('system', t('sp.mic.disabled_settings'));
      return;
    }
    if (micDisabledReason === 'permission_denied') return; // tooltip already explains; no spam
    if (isListening) stopListening();
    else await requestMicAndStart();
  });
  // Re-enable button automatically if the user grants mic from browser settings.
  try {
    const micPermissionQuery = navigator.permissions?.query?.({ name: 'microphone' });
    if (micPermissionQuery) {
      micPermissionQuery.then((micPerm) => {
        micPerm.addEventListener('change', () => {
          micPermissionDenied = micPerm.state === 'denied';
          updateMicButtonState();
        });
      }).catch(() => { /* permissions API unavailable */ });
    }
  } catch { /* permissions API unavailable */ }
  updateMicButtonState();
}

// --- File attachments (+ button, issue #220) ---
// Images go through the OpenAI-style image_url content block (works with any
// vision-capable provider, validated in agent.js against provider.supportsVision).
// PDFs go through Anthropic's {type:'document'} block (Anthropic-only —
// agent.js returns a clear chat error for other providers via
// provider.supportsDocuments). Both are read client-side as data URLs and
// sent as-is; agent.js strips the data: prefix when building the PDF block.
const attachBtn = document.getElementById('btn-attach');
const fileAttachInput = document.getElementById('file-attach-input');
const attachmentPreviewList = document.getElementById('attachment-preview-list');
const MAX_ATTACHMENT_BYTES = 16 * 1024 * 1024; // matches PDF_PASSTHROUGH_MAX_BYTES (pdf-tools.js)
// Text files are injected VERBATIM into the prompt as a text block (no
// server-side processing like PDFs), so the 16MB binary cap would blow any
// context window — cap them far lower.
const MAX_TEXT_ATTACHMENT_BYTES = 512 * 1024;

function normalizeAttachmentTabId(tabId = renderedTabId ?? currentTabId) {
  if (tabId == null || tabId === '') return null;
  const numericTabId = Number(tabId);
  return Number.isFinite(numericTabId) ? numericTabId : null;
}

function getPendingAttachmentsForTab(tabId = renderedTabId ?? currentTabId, { create = true } = {}) {
  const numericTabId = normalizeAttachmentTabId(tabId);
  if (numericTabId == null) return [];
  let attachments = pendingAttachmentsByTab.get(numericTabId);
  if (!attachments && create) {
    attachments = [];
    pendingAttachmentsByTab.set(numericTabId, attachments);
  }
  return attachments || [];
}

function getAttachmentGeneration(tabId) {
  const numericTabId = normalizeAttachmentTabId(tabId);
  if (numericTabId == null) return 0;
  return attachmentGenerationByTab.get(numericTabId) || 0;
}

function bumpAttachmentGeneration(tabId) {
  const numericTabId = normalizeAttachmentTabId(tabId);
  if (numericTabId == null) return;
  attachmentGenerationByTab.set(numericTabId, getAttachmentGeneration(numericTabId) + 1);
}

function isAttachmentReadPendingForTab(tabId = renderedTabId ?? currentTabId) {
  const numericTabId = normalizeAttachmentTabId(tabId);
  return numericTabId != null && (attachmentReadCountsByTab.get(numericTabId) || 0) > 0;
}

function updateAttachmentReadCount(tabId, delta) {
  const numericTabId = normalizeAttachmentTabId(tabId);
  if (numericTabId == null) return;
  const next = Math.max(0, (attachmentReadCountsByTab.get(numericTabId) || 0) + delta);
  if (next) attachmentReadCountsByTab.set(numericTabId, next);
  else attachmentReadCountsByTab.delete(numericTabId);
  if (normalizeAttachmentTabId() === numericTabId) syncSendButtonState();
}

function clearPendingAttachmentsForTab(tabId) {
  const numericTabId = normalizeAttachmentTabId(tabId);
  if (numericTabId == null) return;
  pendingAttachmentsByTab.delete(numericTabId);
  bumpAttachmentGeneration(numericTabId);
  if (normalizeAttachmentTabId() === numericTabId) {
    renderAttachmentPreviews();
    syncSendButtonState();
  }
}

function renderAttachmentPreviews() {
  if (!attachmentPreviewList) return;
  const previewTabId = normalizeAttachmentTabId();
  const pendingAttachments = getPendingAttachmentsForTab(previewTabId, { create: false });
  attachmentPreviewList.innerHTML = '';
  attachmentPreviewList.classList.toggle('hidden', pendingAttachments.length === 0);
  pendingAttachments.forEach((att, i) => {
    const chip = document.createElement('div');
    chip.className = 'attachment-chip';
    const label = document.createElement('span');
    label.className = 'attachment-chip-name';
    label.textContent = att.name;
    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'attachment-chip-remove';
    removeBtn.setAttribute('aria-label', t('sp.attach.remove'));
    removeBtn.textContent = '×';
    removeBtn.addEventListener('click', () => {
      const attachments = getPendingAttachmentsForTab(previewTabId, { create: false });
      attachments.splice(i, 1);
      if (attachments.length === 0 && previewTabId != null) pendingAttachmentsByTab.delete(previewTabId);
      renderAttachmentPreviews();
      syncSendButtonState();
    });
    chip.append(label, removeBtn);
    attachmentPreviewList.appendChild(chip);
  });
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

function readFileAsText(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsText(file);
  });
}

async function handleAttachedFiles(fileList, tabId = renderedTabId ?? currentTabId) {
  const numericTabId = normalizeAttachmentTabId(tabId);
  if (numericTabId == null) return;
  const files = Array.from(fileList || []);
  if (!files.length) return;
  const generation = getAttachmentGeneration(numericTabId);
  updateAttachmentReadCount(numericTabId, 1);
  try {
    for (const file of files) {
      const isImage = file.type.startsWith('image/');
      const isPdf = file.type === 'application/pdf';
      // The reported MIME type for text files is OS-registry dependent and
      // often empty — fall back to the extension.
      const isTextFile = file.type === 'application/json'
        || file.type === 'text/plain'
        || file.type === 'text/csv'
        || (!isImage && !isPdf && /\.(json|txt|csv)$/i.test(file.name || ''));
      if (!isImage && !isPdf && !isTextFile) {
        if (normalizeAttachmentTabId() === numericTabId) {
          addMessage('system', systemHtml(tSystemHtml('sp.attach.unsupported_type', { name: file.name })));
        }
        continue;
      }
      const maxBytes = isTextFile ? MAX_TEXT_ATTACHMENT_BYTES : MAX_ATTACHMENT_BYTES;
      if (file.size > maxBytes) {
        if (normalizeAttachmentTabId() === numericTabId) {
          addMessage('system', systemHtml(tSystemHtml('sp.attach.too_large', { name: file.name, max: isTextFile ? '512KB' : '16MB' })));
        }
        continue;
      }
      try {
        if (isTextFile) {
          const textContent = await readFileAsText(file);
          if (generation !== getAttachmentGeneration(numericTabId)) continue;
          getPendingAttachmentsForTab(numericTabId).push({ kind: 'text', name: file.name, textContent });
        } else {
          const dataUrl = await readFileAsDataUrl(file);
          if (generation !== getAttachmentGeneration(numericTabId)) continue;
          getPendingAttachmentsForTab(numericTabId).push({ kind: isImage ? 'image' : 'document', name: file.name, dataUrl });
        }
      } catch {
        if (generation === getAttachmentGeneration(numericTabId) && normalizeAttachmentTabId() === numericTabId) {
          addMessage('system', systemHtml(tSystemHtml('sp.attach.read_failed', { name: file.name })));
        }
      }
    }
  } finally {
    updateAttachmentReadCount(numericTabId, -1);
    if (generation === getAttachmentGeneration(numericTabId) && normalizeAttachmentTabId() === numericTabId) {
      renderAttachmentPreviews();
    }
  }
}

if (attachBtn && fileAttachInput) {
  attachBtn.addEventListener('click', () => fileAttachInput.click());
  fileAttachInput.addEventListener('change', () => {
    // Bind to renderedTabId: while a run is in flight the user can switch
    // tabs (currentTabId moves ahead), but the conversation on screen — the
    // one they picked files for — is still the rendered tab's. Sends are
    // gated while processing, and renderedTabId catches up to currentTabId
    // before the next send, so chips and sent attachments stay consistent.
    handleAttachedFiles(fileAttachInput.files, renderedTabId ?? currentTabId);
    fileAttachInput.value = ''; // allow re-selecting the same file
  });
}

// --- Event Listeners ---

sendBtn.addEventListener('click', sendMessage);

document.addEventListener('keydown', handleGlobalKeydown, true);

queuedMessagesEl?.addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-queue-action][data-queue-id]');
  if (!btn) return;
  const action = btn.dataset.queueAction;
  const queueId = btn.dataset.queueId;
  if (action === 'edit') {
    editQueuedComposerMessage(currentTabId, queueId);
  } else if (action === 'delete') {
    deleteQueuedComposerMessage(currentTabId, queueId);
  }
});

inputEl.addEventListener('keydown', (e) => {
  if (handleSlashCommandKeydown(e)) return;
  if (e.key === 'ArrowUp' && editLastQueuedComposerMessageForCurrentTab()) {
    e.preventDefault();
    return;
  }
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
    return;
  }
});

inputEl.addEventListener('input', handleInput);
inputEl.addEventListener('scroll', syncSlashCommandHighlightScroll);
inputEl.addEventListener('focus', updateSlashCommandAutocomplete);
inputEl.addEventListener('blur', () => setTimeout(hideSlashCommandAutocomplete, 120));
document.addEventListener('wb-locale-changed', () => {
  if (slashCommandMatches.length) renderSlashCommandAutocomplete();
  renderQueuedComposerMessages();
});

clearBtn.addEventListener('click', async () => {
  const tabId = currentTabId;
  await sendToBackground('clear_conversation', { tabId });
  renderClearedConversationForTab(tabId);
});

providerSelect.addEventListener('change', async () => {
  const providerId = providerSelect.value;
  const requestId = ++providerSelectionRequestId;
  providerTestRequestId += 1;
  try {
    await sendToBackground('set_active_provider', { providerId });
  } catch (e) {
    if (requestId === providerSelectionRequestId && providerSelect.value === providerId) {
      markSelectedProviderFailed(e);
    }
    return;
  }
  if (requestId !== providerSelectionRequestId || providerSelect.value !== providerId) {
    const latestProviderId = providerSelect.value;
    if (latestProviderId && latestProviderId !== providerId) {
      sendToBackground('set_active_provider', { providerId: latestProviderId }).catch(() => {});
    }
    return;
  }
  await testConnection({ providerId });
});

settingsBtn.addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
});

// --- Language selector (globe icon in header) ---
const languageSelect = document.getElementById('language-select');
if (languageSelect) {
  languageSelect.innerHTML = LANGUAGES
    .map((l) => `<option value="${l.code}">${l.label}</option>`)
    .join('');
  languageSelect.value = getLocale();
  languageSelect.addEventListener('change', async () => {
    await setLocale(languageSelect.value);
    applyDOMTranslations(document);
    updateInputPlaceholder();
  });
  document.addEventListener('wb-locale-changed', () => {
    languageSelect.value = getLocale();
    updateInputPlaceholder();
  });
}

// --- Start ---
startInputPlaceholderRotation();
init();
