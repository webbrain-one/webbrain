import { installSafeSocialBackground } from './safesocial/background.js';
import { createSafeSocialHost } from './safesocial/host.js';
import { firefoxBidi } from './bidi/client.js';
import { ProviderManager } from './providers/manager.js';
import { Agent } from './agent/agent.js';
import {
  CUSTOM_SKILLS_STORAGE_KEY,
  DEFAULT_SKILL_SOURCES,
  DEFAULT_SKILLS_REMOVED_STORAGE_KEY,
  DEFAULT_SKILLS_SEEDED_STORAGE_KEY,
  MAX_CUSTOM_SKILLS,
  PACKAGED_SKILL_SOURCES,
  normalizeCustomSkills,
  normalizeDefaultSkillRemovalIds,
  removeRetiredPackagedSkills,
  refreshBuiltInSkillRecord,
} from './agent/skills.js';
import { ScheduledJobManager } from './agent/scheduler.js';
import { APOCALYPSE_DOWNLOAD_ALARM, APOCALYPSE_UPDATE_ALARM, createApocalypseController, sweepOpfsSwapFiles } from './agent/apocalypse-mode.js';
import { createEmergencyDownloadController } from './agent/emergency-download-controller.js';
import { createHostedOfflineRagIndexClient } from './agent/offline-rag-index-host.js';
import { getSharedOfflineSemanticReranker } from './agent/offline-semantic-runtime.js';
import { EMERGENCY_DOWNLOAD_ACTION } from './ui/emergency-download-client.js';
import { readPdfResponseBytes } from './agent/pdf-stream.js';
import {
  compileWorkflowFromDemonstration,
  compileLatestSuccessfulWorkflow,
  createSavedWorkflowStore,
  exportPortableWorkflowDefinition,
  finalizeSavedWorkflowDraft,
  importPortableWorkflowDefinition,
} from './agent/workflows.js';
import { createTeacherRunInterlock, createTeacherSessionStore } from './agent/teacher-mode.js';
import * as workflowTrace from './trace/recorder.js';
import {
  startClaudeOAuth,
  refreshClaudeAccessToken,
  signOutClaude,
  getClaudeOAuthStatus,
} from './providers/oauth-claude.js';
import { getBalance as capsolverGetBalance } from './agent/captcha-solver.js';
import { isCapsolverEnabled } from './agent/capsolver-config.js';
import { testImageGenProvider } from './agent/fal-media.js';
import { createSystemOneJudge } from './agent/systemone-judge.js';
import {
  SELECTION_CONTEXT_SOURCE_GROUNDING,
  SELECTION_ONLY_SOURCE_GROUNDING,
  SELECTION_TRANSLATION_LANGUAGES,
  buildContextMenuPrompt,
  buildFullContextSelectionPrompt,
  buildSelectionPrompt,
  normalizeSelectionAction,
  normalizeSelectionSourceGrounding,
  createContextMenuStorage,
} from './context-menu-storage.js';
import {
  getSelectionShortcutLocalization,
  normalizeSelectionShortcutLocale,
  selectionTranslationLanguageLabel,
} from './selection-shortcut-i18n.js';
import { createTabChatHandoffCoordinator } from './ui/tab-chat-persistence.js';
import { clearStagedScreenshots } from './ui/staged-screenshot-store.js';
import {
  loadUiScale,
  nextUiScale,
  saveUiScale,
  uiScaleCommandAction,
} from './ui/ui-scale.js';
import { normalizeOllamaLaunchHandoff } from './ollama-handoff.js';
import { RunUiJournal, RunUiPersistenceScheduler, compactRunUiSnapshotForPersist, runUiSnapshotForRequest } from './run-ui-journal.js';
import {
  USER_MEMORY_AUTO_CAPTURE_KEY,
  USER_MEMORY_ENABLED_KEY,
  USER_MEMORY_EXTRACTION_QUEUE_KEY,
  USER_MEMORY_FORM_CAPTURE_KEY,
  USER_MEMORY_MAX_PROMPT_CHARS_KEY,
  USER_MEMORY_STORAGE_KEY,
  applyUserMemoryExtractionOperations,
  buildUserMemoryExtractionMessages,
  createUserMemoryStore,
  looksLikeSensitiveMemoryText,
  normalizeUserMemoryExtractionSourceContext,
  normalizeUserMemoryMaxPromptChars,
  normalizeUserMemoryStore,
  normalizeUserMemoryText,
  parseUserMemoryExtractionResult,
} from './agent/user-memory.js';
import { PROFILE_SYNC_DATA_KEYS, PROFILE_SYNC_KEYS, ProfileSyncManager } from './profile-sync.js';
import { shouldAutoGroupTabs } from './tab-group-preference.js';
import {
  SHORTCUT_COMMAND_STORAGE_KEY,
  shortcutCommandEnvelope,
} from './shortcut-command.js';
import {
  CONFIG_STORAGE_KEYS,
  createConfigExport,
  mergeConfigPatchSettings,
  parseConfigImport,
  parseConfigPatchImport,
} from './config-transfer.js';
import { RUN_CAPTURE_START_ERROR_PREFIX, createRunCaptureController } from './run-capture.js';
import { playWatchAlert } from './watch-alert.js';
import {
  getChromeWebStoreOAuthStatus,
  signOutChromeWebStoreOAuth,
  startChromeWebStoreOAuth,
} from './chrome-web-store-release.js';

/**
 * WebBrain Background Script (Firefox)
 * Routes messages between sidebar, content scripts, and the agent.
 */

const safeSocialHost = createSafeSocialHost();
installSafeSocialBackground(browser, (command, payload) => safeSocialHost.handle(command, payload));

const providerManager = new ProviderManager();
const apocalypseController = createApocalypseController(browser);
let emergencyDownloads = null;
// The stale-run repair scan waits a beat after wake so a run resuming from
// eviction registers its in-memory state first; the Traces page can also
// request an immediate scan via WB_TRACE_REPAIR_STALE_RUNS.
const TRACE_REPAIR_STARTUP_DELAY_MS = 15_000;
setTimeout(() => { void workflowTrace.repairStaleRuns().catch(() => {}); }, TRACE_REPAIR_STARTUP_DELAY_MS);

function emergencyDownloadController() {
  if (!emergencyDownloads) {
    emergencyDownloads = createEmergencyDownloadController({
      indexClient: createHostedOfflineRagIndexClient(),
      semanticReranker: getSharedOfflineSemanticReranker(),
    });
  }
  return emergencyDownloads;
}
Promise.all([
  apocalypseController.syncUpdateSchedule(),
  apocalypseController.syncDownloadSchedule(),
  // Reclaim `.crswap` files left behind by writable streams that never closed
  // (background page torn down mid-write, cancelled download, crashed tab).
  // OPFS does not garbage collect these, and with keepExistingData: true each
  // one is a full copy of the archive it was writing.
  sweepOpfsSwapFiles().then(({ removed, bytes }) => {
    if (removed > 0) {
      console.info(`[WebBrain] Reclaimed ${removed} orphaned OPFS swap file(s), ${(bytes / 1024 ** 3).toFixed(2)} GB.`);
    }
  }),
]).catch((error) => {
  console.warn('[WebBrain] Apocalypse Mode schedules could not be restored:', error);
});
const agent = new Agent(providerManager);
agent.strictSecretMode = false;
const ALWAYS_ALLOW_API_MUTATIONS_KEY = 'alwaysAllowApiMutations';
const alwaysAllowApiMutationsReady = browser.storage.local
  .get({ [ALWAYS_ALLOW_API_MUTATIONS_KEY]: true })
  .then((stored) => {
    agent.setAlwaysAllowApiMutations(stored[ALWAYS_ALLOW_API_MUTATIONS_KEY] === true);
  })
  .catch(() => {
    // An unreadable setting must not bypass a stored opt-out.
    agent.setAlwaysAllowApiMutations(false);
  });
agent.setConversationScopeChangeListener((tabId, state) => {
  browser.runtime.sendMessage({
    target: 'sidepanel',
    action: 'agent_update',
    tabId,
    type: 'conversation_scope',
    data: state,
  }).catch(() => {});
});
const userMemoryStore = createUserMemoryStore(browser.storage.local);
const savedWorkflowStore = createSavedWorkflowStore(browser.storage.local);
const teacherSessionStore = createTeacherSessionStore(browser.storage.session);
const teacherRunInterlock = createTeacherRunInterlock(teacherSessionStore, {
  automationOwnsTab: (tabId) => agent.isRunning(tabId)
    || detachedRunStarts.has(tabId)
    || scheduler.isRunning(tabId),
});
agent.setRunStartGuard((tabId) => teacherRunInterlock.guardRunStart(tabId));
const profileSync = new ProfileSyncManager(browser.storage.local);
const runCaptureController = createRunCaptureController({
  api: browser,
  unsupportedRecordingMessage: 'Tab recording is not supported in Firefox.',
});
const scheduler = new ScheduledJobManager({
  api: browser,
  agent,
  systemOneJudge: createSystemOneJudge(),
  loadProviders: async () => {
    await customSkillsReady;
    await alwaysAllowApiMutationsReady;
    await strictSecretModeReady;
    if (providerManager.providers.size === 0) await providerManager.load();
  },
  sendUpdate: (tabId, type, data) => {
    browser.runtime.sendMessage({
      target: 'sidepanel',
      action: 'agent_update',
      tabId,
      type,
      data,
    }).catch(() => {});
    maybeFlashScheduledTerminalEvent(tabId, type, data);
  },
  showIndicator: (tabId) => sendIndicatorMessage(tabId, 'WB_SHOW_AGENT_INDICATORS'),
  hideIndicator: (tabId) => sendIndicatorMessage(tabId, 'WB_HIDE_AGENT_INDICATORS'),
  playWatchAlert: (payload) => playWatchAlert(browser, payload),
});
agent.setScheduler(scheduler);
scheduler.start();

const MAX_AGENT_STEPS_DEFAULT = 130;
const MAX_AGENT_STEPS_UNLIMITED_SENTINEL = 200;
const CONTEXT_MENU_ASK_SELECTION_ID = 'webbrain-ask-selection';
const CONTEXT_MENU_OPEN_CHAT_ID = 'webbrain-selection-open-chat';
const CONTEXT_MENU_OPEN_PDF_VIEWER_ID = 'webbrain-open-pdf-viewer';
const CONTEXT_MENU_ACTION_PREFIX = 'webbrain-selection-action-';
const CONTEXT_MENU_TRANSLATE_ID = 'webbrain-selection-translate';
const CONTEXT_MENU_TRANSLATE_PREFIX = 'webbrain-selection-translate-';
const CONTEXT_MENU_GENERIC_ASK_ID = 'webbrain-selection-generic-ask';
const pdfResponseTabs = new Set();
const pdfOcrRequests = new Map();
function resolveStoredSelectionShortcutLocale(value) {
  return normalizeSelectionShortcutLocale(
    value || (typeof navigator !== 'undefined' ? navigator.language : 'en'),
  );
}

let selectionShortcutLocale = resolveStoredSelectionShortcutLocale('');
const selectionShortcutLocaleReady = browser.storage.local.get({ wbLocale: '' })
  .then((stored) => {
    selectionShortcutLocale = resolveStoredSelectionShortcutLocale(stored?.wbLocale);
  })
  .catch(() => {});

function getContextMenuApi() {
  return browser.contextMenus || browser.menus || null;
}

function getContextMenuPromptStore() {
  return browser.storage?.session || browser.storage?.local || null;
}

function safeOnlinePdfUrl(value) {
  try {
    const url = new URL(String(value || ''));
    return ['http:', 'https:'].includes(url.protocol) ? url.href : '';
  } catch {
    return '';
  }
}

function isPdfUrl(value) {
  try {
    const url = new URL(String(value || ''));
    return ['http:', 'https:'].includes(url.protocol) && /\.pdf$/i.test(url.pathname);
  } catch {
    return false;
  }
}

function trackPdfResponse(details) {
  if (!Number.isInteger(details?.tabId) || details.tabId < 0) return;
  const contentType = (details.responseHeaders || [])
    .find(header => String(header?.name || '').toLowerCase() === 'content-type')?.value;
  if (/^application\/pdf(?:\s*;|$)/i.test(String(contentType))) pdfResponseTabs.add(details.tabId);
  else pdfResponseTabs.delete(details.tabId);
}

function getPdfHandlerBaseUrl() {
  try {
    return browser.runtime.getURL('src/ui/pdf-handler.html');
  } catch {
    return '';
  }
}

// The PDF viewer is an extension page, so sender.tab is empty. Scope the
// request to the handler that sent it: the sender must be our viewer and,
// when the sender URL carries an explicit tabId, it must match msg.tabId.
function isPdfHandlerSender(sender, tabId) {
  if (!sender || sender.id !== browser.runtime.id) return false;
  const senderUrl = String(sender?.url || '');
  const base = getPdfHandlerBaseUrl();
  if (!base || !senderUrl.startsWith(base)) return false;
  try {
    const senderTabId = new URL(senderUrl).searchParams.get('tabId');
    if (senderTabId != null && Number(senderTabId) !== tabId) return false;
  } catch {
    return false;
  }
  return true;
}

async function fetchPdfDocumentForViewer(url) {
  const maxPdfBytes = 64 * 1024 * 1024;
  const response = await fetch(url, { credentials: 'include', redirect: 'follow' });
  if (!response.ok) throw new Error(`Firefox PDF fetch returned HTTP ${response.status}.`);
  // Require the proxied URL to actually be a PDF so the credentialed
  // fetch cannot be pointed at arbitrary HTML the viewer did not open.
  const contentType = String(response.headers.get('content-type') || '');
  if (!/^application\/pdf(?:\s*;|$)/i.test(contentType)) {
    throw new Error('The requested URL did not return a PDF document.');
  }
  const bytes = await readPdfResponseBytes(response, {
    maxBytes: maxPdfBytes,
    emptyMessage: 'Firefox returned an empty PDF stream.',
    unreadableMessage: 'Firefox PDF stream could not be read safely.',
  });
  return { ok: true, bytes: bytes.buffer };
}

const contextMenuStorage = createContextMenuStorage(getContextMenuPromptStore);
const tabChatHandoff = createTabChatHandoffCoordinator(browser.storage.session, {
  requestHandoff: async (tabId, { ownerId, generation }) => {
    try {
      return await browser.runtime.sendMessage({
        target: 'sidepanel',
        action: 'tab_chat_handoff_request',
        tabId,
        ownerId,
        generation,
      });
    } catch {
      return null;
    }
  },
});

async function createContextMenus() {
  await selectionShortcutLocaleReady;
  const api = getContextMenuApi();
  if (!api?.create) return;
  const localization = getSelectionShortcutLocalization(selectionShortcutLocale);
  const strings = localization.strings;

  const createItem = (item) => {
    try {
      const result = api.create(item);
      Promise.resolve(result).catch((e) => {
        if (!/duplicate/i.test(String(e?.message || e))) {
          console.warn('[WebBrain] Failed to create context menu:', e?.message || e);
        }
      });
    } catch (e) {
      if (!/duplicate/i.test(String(e?.message || e))) {
        console.warn('[WebBrain] Failed to create context menu:', e?.message || e);
      }
    }
  };

  const create = () => {
    createItem({
      id: CONTEXT_MENU_ASK_SELECTION_ID,
      title: strings.askSelection,
      contexts: ['selection'],
    });
    createItem({ id: CONTEXT_MENU_OPEN_CHAT_ID, parentId: CONTEXT_MENU_ASK_SELECTION_ID, title: strings.openChat, contexts: ['selection'] });
    createItem({ id: 'webbrain-selection-separator-1', parentId: CONTEXT_MENU_ASK_SELECTION_ID, type: 'separator', contexts: ['selection'] });
    for (const [action, key] of [
      ['summarize', 'summarize'],
      ['explain', 'explain'],
      ['quiz', 'quiz'],
      ['proofread', 'proofread'],
      ['humanize', 'humanize'],
    ]) {
      createItem({ id: `${CONTEXT_MENU_ACTION_PREFIX}${action}`, parentId: CONTEXT_MENU_ASK_SELECTION_ID, title: strings[key], contexts: ['selection'] });
    }
    createItem({ id: CONTEXT_MENU_TRANSLATE_ID, parentId: CONTEXT_MENU_ASK_SELECTION_ID, title: strings.translateTo, contexts: ['selection'] });
    for (const [code, title] of Object.entries(SELECTION_TRANSLATION_LANGUAGES)) {
      createItem({
        id: `${CONTEXT_MENU_TRANSLATE_PREFIX}${code}`,
        parentId: CONTEXT_MENU_TRANSLATE_ID,
        title: selectionTranslationLanguageLabel(code, localization.locale) || title,
        contexts: ['selection'],
      });
    }
    createItem({ id: 'webbrain-selection-separator-2', parentId: CONTEXT_MENU_ASK_SELECTION_ID, type: 'separator', contexts: ['selection'] });
    createItem({ id: CONTEXT_MENU_GENERIC_ASK_ID, parentId: CONTEXT_MENU_ASK_SELECTION_ID, title: strings.askAbout, contexts: ['selection'] });
    createItem({
      id: CONTEXT_MENU_OPEN_PDF_VIEWER_ID,
      title: 'Open PDF with WebBrain',
      contexts: ['page'],
      visible: false,
    });
  };

  try {
    await Promise.resolve(api.removeAll()).catch(() => {});
    create();
  } catch {
    create();
  }
}

function normalizeMaxAgentSteps(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return MAX_AGENT_STEPS_DEFAULT;
  if (n === 0 || n >= MAX_AGENT_STEPS_UNLIMITED_SENTINEL) return Infinity;
  return n >= 5 ? Math.floor(n) : MAX_AGENT_STEPS_DEFAULT;
}

// Load maxSteps setting
async function loadMaxSteps() {
  const stored = await browser.storage.local.get('maxAgentSteps');
  agent.maxSteps = normalizeMaxAgentSteps(stored.maxAgentSteps);
  if (Number(stored.maxAgentSteps) >= MAX_AGENT_STEPS_UNLIMITED_SENTINEL) {
    await browser.storage.local.set({ maxAgentSteps: 0 });
  }
}
loadMaxSteps();

// Stored slider: 0 = Instant, 1–1200 = wait N s, >1200 (1205) = Off.
// Runtime agent value: 0 = Instant, 1–1200 = wait, -1 = Off.
const CLARIFY_TIMEOUT_OFF_SLIDER = 1205;

function normalizeClarifyTimeoutSec(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return 60;
  const sec = Math.floor(n);
  if (sec > 1200) return -1;
  return Math.min(1200, sec);
}

async function loadClarifyTimeout() {
  const stored = await browser.storage.local.get(['clarifyTimeoutSec', 'clarifyTimeoutSemanticsV2']);
  // One-shot: old 0 meant Off; new 0 means Instant and Off is >1200.
  if (!stored.clarifyTimeoutSemanticsV2) {
    const updates = { clarifyTimeoutSemanticsV2: true };
    if (Number(stored.clarifyTimeoutSec) === 0) {
      updates.clarifyTimeoutSec = CLARIFY_TIMEOUT_OFF_SLIDER;
      stored.clarifyTimeoutSec = CLARIFY_TIMEOUT_OFF_SLIDER;
    }
    await browser.storage.local.set(updates).catch(() => {});
  }
  agent.clarifyTimeoutSec = normalizeClarifyTimeoutSec(
    stored.clarifyTimeoutSec != null ? stored.clarifyTimeoutSec : 60,
  );
}
loadClarifyTimeout();

async function loadAutoScreenshot() {
  const stored = await browser.storage.local.get('autoScreenshot');
  if (stored.autoScreenshot != null) agent.autoScreenshot = stored.autoScreenshot;
}
loadAutoScreenshot();

async function loadSiteAdapters() {
  const stored = await browser.storage.local.get('useSiteAdapters');
  if (stored.useSiteAdapters != null) agent.useSiteAdapters = stored.useSiteAdapters;
}
loadSiteAdapters();

async function loadResearchEscalation() {
  const stored = await browser.storage.local.get(['researchEscalationEnabled', 'researchEscalationEngine']);
  agent.researchEscalationEnabled = stored.researchEscalationEnabled === true;
  agent.researchEscalationEngine = String(stored.researchEscalationEngine || 'chatgpt');
}
const researchEscalationReady = loadResearchEscalation().catch(() => {});

async function loadStrictSecretMode() {
  const stored = await browser.storage.local.get('strictSecretMode').catch(() => ({}));
  agent.strictSecretMode = stored?.strictSecretMode === true;
}
const strictSecretModeReady = loadStrictSecretMode().catch(() => {});

async function loadProfile() {
  const stored = await browser.storage.local.get(['profileEnabled', 'profileText']);
  if (stored.profileEnabled != null) agent.profileEnabled = !!stored.profileEnabled;
  if (typeof stored.profileText === 'string') agent.profileText = stored.profileText;
}
loadProfile();

// Local screenshot redaction (issue #312): when on, screenshots are pixelated
// over DOM-detected PII (form fields + email/phone text) BEFORE leaving the
// extension for a Vision endpoint. OFF by default.
async function loadScreenshotRedaction() {
  const stored = await browser.storage.local.get('screenshotRedaction');
  if (stored.screenshotRedaction != null) agent.screenshotRedaction = !!stored.screenshotRedaction;
}
const screenshotRedactionReady = loadScreenshotRedaction().catch(() => {});

// Image budget (issue #311): screenshot quality + how many screenshots the
// agent may capture per turn, and the max image dimension. Defaults preserve
// the previous behavior (auto detail, unlimited screenshots, 1568px cap).
async function loadImageBudget() {
  const stored = await browser.storage.local.get(['imageDetail', 'maxScreenshotsPerTurn', 'maxImageDimension']);
  agent.applyImageBudgetFromStorage(stored);
}
const imageBudgetReady = loadImageBudget().catch(() => {});

async function syncAgentUserMemoryFromStorage() {
  const [store, settings] = await Promise.all([
    userMemoryStore.load(),
    browser.storage.local.get([
      USER_MEMORY_ENABLED_KEY,
      USER_MEMORY_MAX_PROMPT_CHARS_KEY,
    ]),
  ]);
  agent.setUserMemory({
    enabled: settings[USER_MEMORY_ENABLED_KEY] !== false,
    records: store.records,
    maxPromptChars: normalizeUserMemoryMaxPromptChars(settings[USER_MEMORY_MAX_PROMPT_CHARS_KEY]),
  });
  return store;
}
const userMemoryReady = syncAgentUserMemoryFromStorage().catch(() => {});

const USER_MEMORY_EXTRACTION_MAX_QUEUE = 10;
const USER_MEMORY_EXTRACTION_DELAY_MS = 1200;
// Long enough for a transient network/provider blip to clear, short enough
// that the timer fires before Chrome's ~30s idle service-worker teardown.
const USER_MEMORY_EXTRACTION_RETRY_DELAY_MS = 3000;
const USER_MEMORY_CLARIFICATION_BUFFER_LIMIT = 6;
let userMemoryExtractionDrainPromise = null;
let userMemoryExtractionTimer = null;
let userMemoryExtractionQueueLock = Promise.resolve();
let userMemoryStoreLock = Promise.resolve();
let savedWorkflowStoreLock = Promise.resolve();
const userMemoryTurnContextByTab = new Map();

function userMemoryTurnContextKey(tabId) {
  return String(tabId || '');
}

function getUserMemoryTurnContext(tabId) {
  const key = userMemoryTurnContextKey(tabId);
  if (!key) return { clarifications: [], formCompletion: false };
  const existing = userMemoryTurnContextByTab.get(key);
  if (existing) return existing;
  const created = { clarifications: [], formCompletion: false };
  userMemoryTurnContextByTab.set(key, created);
  return created;
}

function recordClarificationMemoryCandidate(tabId, question, answer) {
  const normalizedAnswer = normalizeUserMemoryText(answer, 500);
  if (!normalizedAnswer) return;
  const normalizedQuestion = normalizeUserMemoryText(question, 500);
  if (looksLikeSensitiveMemoryText(normalizedAnswer)
      || (normalizedQuestion && looksLikeSensitiveMemoryText(normalizedQuestion))) {
    return;
  }
  const context = getUserMemoryTurnContext(tabId);
  context.clarifications.push({
    question: normalizedQuestion,
    answer: normalizedAnswer,
  });
  if (context.clarifications.length > USER_MEMORY_CLARIFICATION_BUFFER_LIMIT) {
    context.clarifications = context.clarifications.slice(-USER_MEMORY_CLARIFICATION_BUFFER_LIMIT);
  }
}

function recordFormCompletionMemoryCandidate(tabId, answer) {
  const normalizedAnswer = String(answer || '').trim().toLowerCase();
  if (!['once', 'always', 'yes', 'submit'].includes(normalizedAnswer)) return;
  getUserMemoryTurnContext(tabId).formCompletion = true;
}

function formatClarificationMemoryText(clarifications = []) {
  return clarifications
    .map((item) => {
      const answer = normalizeUserMemoryText(item?.answer, 500);
      if (!answer) return '';
      const question = normalizeUserMemoryText(item?.question, 500);
      return question
        ? `Clarification answer: ${question} -> ${answer}`
        : `Clarification answer: ${answer}`;
    })
    .filter(Boolean)
    .join('\n');
}

function takeUserMemoryTurnExtractionPayload(tabId, payload = {}) {
  const key = userMemoryTurnContextKey(tabId);
  const context = key ? userMemoryTurnContextByTab.get(key) : null;
  if (key) userMemoryTurnContextByTab.delete(key);
  const clarificationText = formatClarificationMemoryText(context?.clarifications);
  return {
    ...payload,
    clarificationText,
    formCompletion: context?.formCompletion === true,
    sourceContext: context?.formCompletion === true
      ? 'form_completion'
      : clarificationText
        ? 'clarification_response'
        : payload.sourceContext,
  };
}

function clearUserMemoryTurnContext(tabId) {
  const key = userMemoryTurnContextKey(tabId);
  if (key) userMemoryTurnContextByTab.delete(key);
}

async function loadUserMemoryExtractionQueue() {
  const stored = await browser.storage.local.get(USER_MEMORY_EXTRACTION_QUEUE_KEY);
  const queue = Array.isArray(stored[USER_MEMORY_EXTRACTION_QUEUE_KEY])
    ? stored[USER_MEMORY_EXTRACTION_QUEUE_KEY]
    : [];
  return queue.slice(-USER_MEMORY_EXTRACTION_MAX_QUEUE);
}

async function saveUserMemoryExtractionQueue(queue) {
  await browser.storage.local.set({
    [USER_MEMORY_EXTRACTION_QUEUE_KEY]: Array.isArray(queue)
      ? queue.slice(-USER_MEMORY_EXTRACTION_MAX_QUEUE)
      : [],
  });
}

async function isUserMemoryExtractionEnabled() {
  const stored = await browser.storage.local.get({
    [USER_MEMORY_ENABLED_KEY]: true,
    [USER_MEMORY_AUTO_CAPTURE_KEY]: true,
  });
  return stored[USER_MEMORY_ENABLED_KEY] !== false
    && stored[USER_MEMORY_AUTO_CAPTURE_KEY] === true;
}

async function isUserMemoryFormCaptureEnabled() {
  const stored = await browser.storage.local.get({ [USER_MEMORY_FORM_CAPTURE_KEY]: true });
  return stored[USER_MEMORY_FORM_CAPTURE_KEY] === true;
}

async function withUserMemoryExtractionQueueLock(task) {
  const run = userMemoryExtractionQueueLock.then(task, task);
  userMemoryExtractionQueueLock = run.catch(() => {});
  return run;
}

async function updateUserMemoryExtractionQueue(updater) {
  return withUserMemoryExtractionQueueLock(async () => {
    const queue = await loadUserMemoryExtractionQueue();
    const nextQueue = await updater(queue);
    await saveUserMemoryExtractionQueue(Array.isArray(nextQueue) ? nextQueue : queue);
    return nextQueue;
  });
}

async function clearUserMemoryExtractionQueue() {
  await updateUserMemoryExtractionQueue(() => []);
}

function shouldClearUserMemoryExtractionQueueForChanges(changes) {
  return changes[USER_MEMORY_ENABLED_KEY]?.newValue === false
    || (changes[USER_MEMORY_AUTO_CAPTURE_KEY] && changes[USER_MEMORY_AUTO_CAPTURE_KEY].newValue !== true);
}

async function claimUserMemoryExtractionJob(jobId) {
  if (!jobId) return false;
  let claimed = false;
  await updateUserMemoryExtractionQueue((queue) => {
    const index = queue.findIndex((job) => job?.id === jobId);
    if (index >= 0) {
      queue.splice(index, 1);
      claimed = true;
    }
    return queue;
  });
  return claimed;
}

async function peekUserMemoryExtractionJob() {
  let job = null;
  await withUserMemoryExtractionQueueLock(async () => {
    const queue = await loadUserMemoryExtractionQueue();
    job = queue[0] || null;
  });
  return job;
}

async function removeUserMemoryExtractionJob(jobId) {
  if (!jobId) return;
  await updateUserMemoryExtractionQueue((queue) => {
    return queue.filter((job) => job?.id !== jobId);
  });
}

async function markUserMemoryExtractionJobFailed(jobId) {
  if (!jobId) return;
  await updateUserMemoryExtractionQueue((queue) => {
    return queue.map((job) => {
      if (job?.id !== jobId) return job;
      const attempts = Number(job.attempts || 0);
      if (attempts >= 1) return null;
      return { ...job, attempts: attempts + 1 };
    }).filter(Boolean);
  });
}

async function withUserMemoryStoreLock(task) {
  const run = userMemoryStoreLock.then(task, task);
  userMemoryStoreLock = run.catch(() => {});
  return run;
}

async function withSavedWorkflowStoreLock(task) {
  const run = savedWorkflowStoreLock.then(task, task);
  savedWorkflowStoreLock = run.catch(() => {});
  return run;
}

async function withTeacherSessionStoreLock(task) {
  return teacherRunInterlock.withLock(task);
}

function publicTeacherSession(session) {
  return session ? {
    active: true,
    name: session.name,
    actionCount: session.actions?.length || 0,
    startedAt: session.startedAt,
  } : { active: false };
}

async function notifyTeacherState(tabId, session) {
  if (tabId == null) return false;
  try {
    const response = await browser.tabs.sendMessage(tabId, {
      target: 'content',
      action: 'teacher_state',
      state: publicTeacherSession(session),
    });
    return response?.teacherCaptureReady === true;
  } catch {
    return false;
  }
}

async function applyUserMemoryExtractionOperationsToCurrentStore(jobId, operations) {
  return withUserMemoryStoreLock(async () => {
    if (!await isUserMemoryExtractionEnabled()) {
      await clearUserMemoryExtractionQueue();
      return { changed: false, claimed: false, disabled: true };
    }
    if (!await claimUserMemoryExtractionJob(jobId)) return { changed: false, claimed: false };
    const latestStore = await userMemoryStore.load();
    const applied = applyUserMemoryExtractionOperations(latestStore, operations);
    if (applied.changed) applied.store = await userMemoryStore.save(applied.store);
    return { ...applied, claimed: true };
  });
}

function notifyUserMemoryCreated() {
  browser.runtime.sendMessage({
    target: 'sidepanel',
    action: 'user_memory_created',
  }).catch(() => {});
}

function scheduleUserMemoryExtractionDrain(delayMs = USER_MEMORY_EXTRACTION_DELAY_MS) {
  if (userMemoryExtractionTimer) clearTimeout(userMemoryExtractionTimer);
  userMemoryExtractionTimer = setTimeout(() => {
    userMemoryExtractionTimer = null;
    drainUserMemoryExtractionQueue().catch((error) => {
      console.warn('[WebBrain] user-memory extraction failed:', error);
    });
  }, delayMs);
}

async function enqueueUserMemoryExtraction(payload = {}) {
  if (!await isUserMemoryExtractionEnabled()) return { queued: false, reason: 'disabled' };
  const clarificationText = normalizeUserMemoryText(payload.clarificationText, 1000);
  const sourceContext = normalizeUserMemoryExtractionSourceContext(payload.sourceContext);
  const formCompletionTurn = sourceContext === 'form_completion';
  // Deliberate privacy stance: form-completion turns never forward raw turn
  // text — the typed message and assistant reply may embed form values — so a
  // form turn without sanitized clarification answers is skipped entirely,
  // even if the user also typed a durable preference. /memory --add still works.
  if (formCompletionTurn) {
    if (!await isUserMemoryFormCaptureEnabled()) {
      return { queued: false, reason: 'form_capture_disabled' };
    } else if (!clarificationText) {
      return { queued: false, reason: 'form_capture_empty' };
    }
  }
  const userText = normalizeUserMemoryText([
    formCompletionTurn ? '' : payload.userText,
    clarificationText,
  ].filter(Boolean).join('\n'), 2000);
  const assistantText = normalizeUserMemoryText(
    formCompletionTurn ? 'Completed form task; explicit clarification answers recorded.' : payload.assistantText,
    2000,
  );
  if (!userText || !assistantText) return { queued: false, reason: 'empty' };
  await updateUserMemoryExtractionQueue((queue) => {
    queue.push({
      id: `memjob_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      userText,
      assistantText,
      mode: ['ask', 'act', 'dev'].includes(payload.mode) ? payload.mode : 'ask',
      succeeded: payload.succeeded !== false,
      sourceContext,
      conversationId: normalizeUserMemoryText(payload.conversationId, 200),
      attempts: 0,
      createdAt: Date.now(),
    });
    return queue;
  });
  scheduleUserMemoryExtractionDrain();
  return { queued: true };
}

function enqueueUserMemoryExtractionAfterTurn(payload) {
  queueMicrotask(() => {
    enqueueUserMemoryExtraction(payload).catch((error) => {
      console.warn('[WebBrain] failed to enqueue user-memory extraction:', error);
    });
  });
}

async function drainUserMemoryExtractionQueue() {
  if (userMemoryExtractionDrainPromise) return userMemoryExtractionDrainPromise;
  userMemoryExtractionDrainPromise = (async () => {
    while (true) {
      if (!await isUserMemoryExtractionEnabled()) return;
      const job = await peekUserMemoryExtractionJob();
      if (!job) return;
      if (job.sourceContext === 'form_completion' && !await isUserMemoryFormCaptureEnabled()) {
        await removeUserMemoryExtractionJob(job.id);
        continue;
      }

      try {
        await customSkillsReady;
        if (providerManager.providers.size === 0) await providerManager.load();
        const store = await userMemoryStore.load();
        const provider = providerManager.getActive();
        const costState = agent._newCostRunState();
        const result = await agent._chatWithCostAllowance(provider, buildUserMemoryExtractionMessages({
          userText: job.userText,
          assistantText: job.assistantText,
          memories: store.records,
          mode: job.mode,
          succeeded: job.succeeded,
          sourceContext: job.sourceContext,
        }), { maxTokens: 600, temperature: 0 }, costState, {
          conversationId: job.conversationId || null,
          generationName: 'memory',
        });
        const operations = parseUserMemoryExtractionResult(result?.content || '');
        const applied = await applyUserMemoryExtractionOperationsToCurrentStore(job.id, operations);
        if (applied.changed) {
          await syncAgentUserMemoryFromStorage();
          if (applied.created) notifyUserMemoryCreated();
        }
      } catch (error) {
        if (agent._isCostAllowanceError?.(error)) {
          await removeUserMemoryExtractionJob(job.id);
          return;
        }
        await markUserMemoryExtractionJobFailed(job.id);
        scheduleUserMemoryExtractionDrain(USER_MEMORY_EXTRACTION_RETRY_DELAY_MS);
        return;
      }
    }
  })().finally(() => {
    userMemoryExtractionDrainPromise = null;
  });
  return userMemoryExtractionDrainPromise;
}

async function loadPackagedSkillRecords(sources = PACKAGED_SKILL_SOURCES) {
  const records = [];
  for (const source of sources) {
    const response = await fetch(browser.runtime.getURL(source.path));
    if (!response.ok) {
      throw new Error(`Packaged skill ${source.id} failed to load: HTTP ${response.status}`);
    }
    records.push({
      id: source.id,
      name: source.name,
      sourceType: 'built-in',
      sourceUrl: source.path,
      content: await response.text(),
      createdAt: 0,
    });
  }
  return records;
}

async function loadDefaultSkillRecords() {
  return loadPackagedSkillRecords(DEFAULT_SKILL_SOURCES);
}

async function refreshPackagedSkillRecords(skills) {
  const existingBuiltIns = skills.filter((skill) => skill.sourceType === 'built-in');
  if (existingBuiltIns.length === 0) return { skills, changed: false };

  const packaged = new Map((await loadPackagedSkillRecords()).map((skill) => [skill.id, skill]));
  let changed = false;
  const refreshed = skills.map((skill) => {
    const current = packaged.get(skill.id);
    if (!current || skill.sourceType !== 'built-in') return skill;
    const result = refreshBuiltInSkillRecord(skill, current);
    if (result.changed) changed = true;
    return result.skill;
  });
  return { skills: changed ? normalizeCustomSkills(refreshed) : skills, changed };
}

async function loadCustomSkills() {
  const stored = await browser.storage.local.get([
    CUSTOM_SKILLS_STORAGE_KEY,
    DEFAULT_SKILLS_REMOVED_STORAGE_KEY,
    DEFAULT_SKILLS_SEEDED_STORAGE_KEY,
    'enableAllPackagedSkills',
  ]);
  const storedSkills = Array.isArray(stored[CUSTOM_SKILLS_STORAGE_KEY])
    ? stored[CUSTOM_SKILLS_STORAGE_KEY]
    : [];
  const retainedSkills = removeRetiredPackagedSkills(storedSkills);
  let skills = normalizeCustomSkills(retainedSkills);
  if (retainedSkills.length !== storedSkills.length) {
    try {
      await browser.storage.local.set({ [CUSTOM_SKILLS_STORAGE_KEY]: skills });
    } catch (error) {
      console.warn('[WebBrain] Retired packaged skills could not be removed', error);
    }
  }
  const removedDefaultIds = new Set(normalizeDefaultSkillRemovalIds(stored[DEFAULT_SKILLS_REMOVED_STORAGE_KEY]));
  try {
    const existingIds = new Set(skills.map((skill) => skill.id));
    const room = Math.max(0, MAX_CUSTOM_SKILLS - skills.length);
    const packagedSources = stored.enableAllPackagedSkills
      ? PACKAGED_SKILL_SOURCES
      : DEFAULT_SKILL_SOURCES;
    const defaultSkills = (await loadPackagedSkillRecords(packagedSources))
      .filter((skill) => !existingIds.has(skill.id) && !removedDefaultIds.has(skill.id))
      .slice(0, room);
    if (defaultSkills.length || !stored[DEFAULT_SKILLS_SEEDED_STORAGE_KEY]) {
      skills = normalizeCustomSkills([...defaultSkills, ...skills]);
      const update = {
        [CUSTOM_SKILLS_STORAGE_KEY]: skills,
        [DEFAULT_SKILLS_SEEDED_STORAGE_KEY]: true,
      };
      const normalizedRemoved = normalizeDefaultSkillRemovalIds(stored[DEFAULT_SKILLS_REMOVED_STORAGE_KEY]);
      if (JSON.stringify(normalizedRemoved) !== JSON.stringify(stored[DEFAULT_SKILLS_REMOVED_STORAGE_KEY] || [])) {
        update[DEFAULT_SKILLS_REMOVED_STORAGE_KEY] = normalizedRemoved;
      }
      await browser.storage.local.set(update);
    }
  } catch (e) {
    console.warn('[WebBrain] Default skills could not be loaded', e);
  }
  try {
    const refreshed = await refreshPackagedSkillRecords(skills);
    if (refreshed.changed) {
      skills = refreshed.skills;
      await browser.storage.local.set({ [CUSTOM_SKILLS_STORAGE_KEY]: skills });
    }
  } catch (e) {
    console.warn('[WebBrain] Packaged skills could not be refreshed', e);
  }
  agent.setCustomSkills(skills);
}
const customSkillsReady = loadCustomSkills();

// A valid key plus explicit consent enables CapSolver. Requiring the existing
// boolean preserves legacy profiles that saved a key while the old switch was
// off; pressing Save Key in the new UI sets consent to true.
async function loadCaptchaSolver() {
  const stored = await browser.storage.local.get(['capsolverApiKey', 'captchaSolverEnabled']);
  agent.captchaSolverEnabled = isCapsolverEnabled(
    stored.capsolverApiKey,
    stored.captchaSolverEnabled,
  );
}
loadCaptchaSolver();

function normalizePlanBeforeActMode(stored = {}) {
  if (stored.planBeforeActMode === 'try' || stored.planBeforeActMode === 'strict' || stored.planBeforeActMode === 'off') {
    return stored.planBeforeActMode;
  }
  if (stored.planBeforeAct === true) return 'strict';
  if (stored.planBeforeAct === false) return 'off';
  return 'try';
}

function applyPlanBeforeActMode(mode) {
  if (typeof agent.setPlanBeforeActMode === 'function') {
    agent.setPlanBeforeActMode(mode);
    return;
  }
  agent.planBeforeActMode = mode;
  agent.planBeforeAct = mode !== 'off';
}

async function loadPlanBeforeAct() {
  const stored = await browser.storage.local.get(['planBeforeActMode', 'planBeforeAct']);
  applyPlanBeforeActMode(normalizePlanBeforeActMode(stored));
}

function normalizePlanReviewMode(stored = {}) {
  return stored.planReviewMode === 'always' || stored.planReviewMode === 'never' || stored.planReviewMode === 'confidence'
    ? stored.planReviewMode
    : 'confidence';
}

function normalizePlanReviewConfidenceThreshold(stored = {}) {
  let threshold = Number(stored.planReviewConfidenceThreshold);
  if (!Number.isFinite(threshold)) threshold = 0.9;
  if (threshold > 1 && threshold <= 100) threshold /= 100;
  // Match the settings slider's [50%, 99%] range so an out-of-band stored
  // value can't disable the review gate while the UI shows an in-range value.
  return Math.max(0.5, Math.min(0.99, threshold));
}

function applyPlanReviewSettings(stored = {}) {
  const settings = {
    mode: normalizePlanReviewMode(stored),
    confidenceThreshold: normalizePlanReviewConfidenceThreshold(stored),
  };
  if (typeof agent.setPlanReviewSettings === 'function') {
    agent.setPlanReviewSettings(settings);
    return;
  }
  agent.planReviewMode = settings.mode;
  agent.planReviewConfidenceThreshold = settings.confidenceThreshold;
}

async function loadPlanReviewSettings() {
  const stored = await browser.storage.local.get(['planReviewMode', 'planReviewConfidenceThreshold']);
  applyPlanReviewSettings(stored);
}
// Hydrate once at SW boot. handleMessage awaits this promise so the first chat
// can't race ahead of hydration, but it does NOT re-read storage per message —
// the storage.onChanged listener below keeps the planner mode in sync. (#5)
const planBeforeActReady = loadPlanBeforeAct();
const planReviewReady = loadPlanReviewSettings();

function showFirstInstallGuide(details) {
  if (details?.reason !== 'install') return;
  browser.tabs.create({
    url: browser.runtime.getURL('src/ui/install.html'),
    active: true,
  }).catch((error) => {
    console.warn('[WebBrain] Could not open the first-install pinning guide:', error);
  });
}

// Initialize on install
browser.runtime.onInstalled.addListener(async (details) => {
  showFirstInstallGuide(details);
  await createContextMenus();
  await providerManager.load();
  await loadMaxSteps();
  await loadClarifyTimeout();
  await loadAutoScreenshot();
  await syncAgentUserMemoryFromStorage().catch(() => {});
  scheduleUserMemoryExtractionDrain(5000);
  console.log('[WebBrain] Extension installed, providers loaded.');
});

browser.runtime.onStartup?.addListener?.(async () => {
  await createContextMenus();
  syncAgentUserMemoryFromStorage().catch(() => {});
  scheduleUserMemoryExtractionDrain(5000);
});

// Listen for setting changes
browser.storage.onChanged.addListener((changes) => {
  if (changes.wbLocale) {
    selectionShortcutLocale = normalizeSelectionShortcutLocale(changes.wbLocale.newValue);
    createContextMenus().catch(() => {});
  }
  if (PROFILE_SYNC_DATA_KEYS.some((key) => changes[key])) profileSync.noteChanges(changes).catch(() => {});
  if (changes.providers || changes.activeProvider || changes.helpImproveWebBrain) providerManager.load().catch(() => {});
  if (changes.maxAgentSteps) {
    agent.maxSteps = normalizeMaxAgentSteps(changes.maxAgentSteps.newValue);
  }
  if (changes.clarifyTimeoutSec) {
    agent.clarifyTimeoutSec = normalizeClarifyTimeoutSec(changes.clarifyTimeoutSec.newValue);
  }
  if (changes.autoScreenshot) {
    agent.autoScreenshot = changes.autoScreenshot.newValue;
  }
  let refreshPrompts = false;
  if (changes[ALWAYS_ALLOW_API_MUTATIONS_KEY]) {
    const value = changes[ALWAYS_ALLOW_API_MUTATIONS_KEY].newValue;
    agent.setAlwaysAllowApiMutations(value === undefined || value === true);
    refreshPrompts = true;
  }
  if (changes.useSiteAdapters) {
    agent.useSiteAdapters = changes.useSiteAdapters.newValue;
    refreshPrompts = true;
  }
  if (changes.researchEscalationEnabled || changes.researchEscalationEngine) {
    if (changes.researchEscalationEnabled) {
      agent.researchEscalationEnabled = changes.researchEscalationEnabled.newValue === true;
    }
    if (changes.researchEscalationEngine) {
      agent.researchEscalationEngine = String(changes.researchEscalationEngine.newValue || 'chatgpt');
    }
    refreshPrompts = true;
  }
  if (changes[API_MUTATION_OBSERVER_KEY]) {
    const value = changes[API_MUTATION_OBSERVER_KEY].newValue;
    setApiMutationObserverEnabled(value === undefined || value === true);
  }
  if (changes.strictSecretMode) {
    agent.strictSecretMode = changes.strictSecretMode.newValue === true;
    // Strict mode also appends a global system note after enabled skills, so
    // refresh live conversations immediately as well as rebuilding at turn start.
    refreshPrompts = true;
  }
  if (changes.profileEnabled) {
    agent.profileEnabled = !!changes.profileEnabled.newValue;
    refreshPrompts = true;
  }
  if (changes.screenshotRedaction) {
    agent.screenshotRedaction = !!changes.screenshotRedaction.newValue;
  }
  if (changes.imageDetail || changes.maxScreenshotsPerTurn || changes.maxImageDimension) {
    agent.applyImageBudgetFromStorage({
      imageDetail: changes.imageDetail ? changes.imageDetail.newValue : undefined,
      maxScreenshotsPerTurn: changes.maxScreenshotsPerTurn ? changes.maxScreenshotsPerTurn.newValue : undefined,
      maxImageDimension: changes.maxImageDimension ? changes.maxImageDimension.newValue : undefined,
    });
  }
  if (changes.profileText) {
    agent.profileText = changes.profileText.newValue || '';
    refreshPrompts = true;
  }
  if (changes[USER_MEMORY_ENABLED_KEY] || changes[USER_MEMORY_MAX_PROMPT_CHARS_KEY] || changes[USER_MEMORY_STORAGE_KEY]) {
    const memoryUpdate = {};
    if (changes[USER_MEMORY_ENABLED_KEY]) {
      memoryUpdate.enabled = changes[USER_MEMORY_ENABLED_KEY].newValue !== false;
    }
    if (changes[USER_MEMORY_MAX_PROMPT_CHARS_KEY]) {
      memoryUpdate.maxPromptChars = normalizeUserMemoryMaxPromptChars(changes[USER_MEMORY_MAX_PROMPT_CHARS_KEY].newValue);
    }
    if (changes[USER_MEMORY_STORAGE_KEY]) {
      memoryUpdate.records = normalizeUserMemoryStore(changes[USER_MEMORY_STORAGE_KEY].newValue).records;
    }
    agent.setUserMemory(memoryUpdate);
  }
  if (shouldClearUserMemoryExtractionQueueForChanges(changes)) {
    clearUserMemoryExtractionQueue().catch((error) => {
      console.warn('[WebBrain] failed to clear user-memory extraction queue:', error);
    });
  }
  if (changes[CUSTOM_SKILLS_STORAGE_KEY]) {
    const storedSkills = Array.isArray(changes[CUSTOM_SKILLS_STORAGE_KEY].newValue)
      ? changes[CUSTOM_SKILLS_STORAGE_KEY].newValue
      : [];
    const retainedSkills = removeRetiredPackagedSkills(storedSkills);
    agent.customSkills = normalizeCustomSkills(retainedSkills);
    if (retainedSkills.length !== storedSkills.length) {
      browser.storage.local.set({ [CUSTOM_SKILLS_STORAGE_KEY]: agent.customSkills }).catch((error) => {
        console.warn('[WebBrain] Retired packaged skills could not be removed', error);
      });
    }
    refreshPrompts = true;
  }
  if (changes.capsolverApiKey || changes.captchaSolverEnabled) {
    loadCaptchaSolver()
      .then(() => agent._refreshSystemPrompts())
      .catch((error) => console.warn('[WebBrain] CapSolver setting could not be refreshed', error));
  }
  if (changes.planBeforeActMode || changes.planBeforeAct) {
    applyPlanBeforeActMode(normalizePlanBeforeActMode({
      planBeforeActMode: changes.planBeforeActMode?.newValue,
      planBeforeAct: changes.planBeforeAct?.newValue,
    }));
  }
  if (changes.planReviewMode || changes.planReviewConfidenceThreshold) {
    applyPlanReviewSettings({
      planReviewMode: changes.planReviewMode?.newValue ?? agent.planReviewMode,
      planReviewConfidenceThreshold: changes.planReviewConfidenceThreshold?.newValue ?? agent.planReviewConfidenceThreshold,
    });
  }
  if (refreshPrompts) agent._refreshSystemPrompts();
});

browser.alarms.onAlarm.addListener((alarm) => {
  if (alarm?.name === APOCALYPSE_DOWNLOAD_ALARM) {
    apocalypseController.manager.processNext().catch((error) => {
      console.warn('[WebBrain] Apocalypse Mode archive download failed:', error);
    });
  } else if (alarm?.name === APOCALYPSE_UPDATE_ALARM) {
    apocalypseController.checkForUpdates().catch((error) => {
      console.warn('[WebBrain] Apocalypse Mode update check failed:', error);
    });
  }
});

// ────────────────────────────────────────────────────────────────────────
// Tab grouping (visual scope for a WebBrain session)
//
// Same UX shape as the Chrome build (see src/chrome/src/background.js):
// when automatic grouping is enabled and the user clicks the browser
// action, the source tab joins (or seeds) a colored "WebBrain" tab group
// for that window. Internal helper tabs and target=_blank redirects auto-join
// the same group via agent.js's `_addToWebBrainGroup`.
//
// What we DON'T do on Firefox: scope the sidebar's visibility to group
// membership. browser.sidebarAction is window-level, not per-tab —
// there's no clean equivalent of Chrome's `setOptions({tabId, enabled})`.
// The Firefox sidebar stays where the user puts it (closed/open via
// toggle), which is fine because Firefox already has user-driven control.
// ────────────────────────────────────────────────────────────────────────

const webBrainGroupByWindow = new Map(); // windowId -> tabGroups groupId
const WB_GROUPS_KEY = 'webBrainGroupByWindow';

async function loadWebBrainGroups() {
  if (!browser.tabGroups) return; // Firefox <142 — graceful skip
  try {
    const stored = await browser.storage.session?.get(WB_GROUPS_KEY);
    const arr = stored?.[WB_GROUPS_KEY];
    if (Array.isArray(arr)) {
      for (const [windowId, groupId] of arr) {
        // Validate each cached group still exists; user may have
        // ungrouped or browser may have been closed between sessions.
        try {
          await browser.tabGroups.get(groupId);
          webBrainGroupByWindow.set(windowId, groupId);
        } catch { /* group gone, drop */ }
      }
    }
  } catch { /* session storage unavailable on this profile */ }
}
function saveWebBrainGroups() {
  browser.storage.session?.set({
    [WB_GROUPS_KEY]: Array.from(webBrainGroupByWindow.entries()),
  }).catch(() => {});
}
loadWebBrainGroups();

/**
 * When automatic grouping is enabled, make sure `tab.windowId` has a
 * "WebBrain" group AND that `tab` is in it. Always creates a fresh group
 * rather than rebranding the user's existing group.
 */
async function ensureWebBrainGroup(tab) {
  if (!browser.tabGroups || !tab?.id || tab.windowId == null) return -1;
  if (!await shouldAutoGroupTabs(browser.storage.local)) return -1;
  try {
    let groupId = webBrainGroupByWindow.get(tab.windowId);

    // Validate cached group is still alive in the browser.
    if (groupId != null) {
      try {
        await browser.tabGroups.get(groupId);
      } catch {
        groupId = null;
        webBrainGroupByWindow.delete(tab.windowId);
        saveWebBrainGroups();
      }
    }

    if (groupId == null) {
      // Create a fresh group with just this tab. Calling browser.tabs.group
      // with no groupId moves the tab out of any prior user group into a
      // new one — the user's old group keeps its other tabs intact.
      groupId = await browser.tabs.group({ tabIds: [tab.id] });
      try {
        await browser.tabGroups.update(groupId, {
          title: 'WebBrain', color: 'blue', collapsed: false,
        });
      } catch { /* style update can fail on locked groups; skip */ }
      webBrainGroupByWindow.set(tab.windowId, groupId);
      saveWebBrainGroups();
    } else if (tab.groupId !== groupId) {
      // Group exists but source tab not in it. Add it.
      try {
        await browser.tabs.group({ groupId, tabIds: [tab.id] });
      } catch { /* tab might be moving; ignore */ }
    }
    return groupId;
  } catch {
    return -1;
  }
}

// The install page opens the sidebar directly from its click handler, then
// reports the successful open here so first-run tabs use the same visual
// WebBrain grouping as browser-action opens.
browser.runtime.onMessage.addListener((msg, sender) => {
  if (msg?.type !== 'WB_INSTALL_PANEL_OPENED') return;

  const installGuideUrl = browser.runtime.getURL('src/ui/install.html');
  const senderUrl = String(sender?.url || sender?.tab?.url || '');
  const tabId = Number(msg.tabId);
  if (
    sender?.id !== browser.runtime.id
    || senderUrl !== installGuideUrl
    || !Number.isInteger(tabId)
    || tabId < 0
    || (sender?.tab?.id != null && sender.tab.id !== tabId)
  ) {
    return;
  }

  browser.tabs.get(tabId).then((tab) => {
    if (tab?.url !== installGuideUrl) return;
    ensureWebBrainGroup(tab).catch(() => {});
  }).catch(() => {});
});

// Tracks the pending 250 ms retry timer per tab so it can be cancelled if the
// tab navigates before the timer fires.
const pendingContextMenuNotifications = new Map();

function notifySidePanelOfContextMenuPrompt(payload) {
  const tabId = payload.tabId;
  const msg = {
    target: 'sidepanel',
    action: 'context_menu_prompt',
    tabId,
    prompt: payload,
  };
  clearTimeout(pendingContextMenuNotifications.get(tabId));
  browser.runtime.sendMessage(msg).catch(() => {});
  const timerId = setTimeout(() => {
    pendingContextMenuNotifications.delete(tabId);
    browser.runtime.sendMessage(msg).catch(() => {});
  }, 250);
  pendingContextMenuNotifications.set(tabId, timerId);
}

function openSidebarForContextMenu(tab) {
  if (browser.sidebarAction?.open) {
    browser.sidebarAction.open().catch(() => {});
  } else {
    browser.sidebarAction?.toggle?.().catch(() => {});
  }
  if (tab?.id) ensureWebBrainGroup(tab).catch(() => {});
}

async function handleContextMenuAsk(info, tab) {
  if (!tab?.id) return;
  const menuItemId = String(info?.menuItemId || '');
  if (menuItemId === CONTEXT_MENU_OPEN_PDF_VIEWER_ID) {
    const pdfUrl = safeOnlinePdfUrl(tab.url);
    if (!pdfUrl || (!pdfResponseTabs.has(tab.id) && !isPdfUrl(pdfUrl))) return;
    const viewerUrl = browser.runtime.getURL(
      `src/ui/pdf-handler.html?url=${encodeURIComponent(pdfUrl)}&tabId=${encodeURIComponent(tab.id)}`,
    );
    await browser.tabs.update(tab.id, { url: viewerUrl });
    return;
  }
  if (menuItemId === CONTEXT_MENU_OPEN_CHAT_ID) {
    openSidebarForContextMenu(tab);
    return;
  }

  let text = '';
  let selectionAction = '';
  if (menuItemId === CONTEXT_MENU_GENERIC_ASK_ID) {
    text = buildContextMenuPrompt(info.selectionText, selectionShortcutLocale);
  } else if (menuItemId.startsWith(CONTEXT_MENU_ACTION_PREFIX)) {
    selectionAction = normalizeSelectionAction(menuItemId.slice(CONTEXT_MENU_ACTION_PREFIX.length));
    text = buildSelectionPrompt(info.selectionText, selectionAction, '', selectionShortcutLocale);
  } else if (menuItemId.startsWith(CONTEXT_MENU_TRANSLATE_PREFIX)) {
    selectionAction = 'translate';
    text = buildSelectionPrompt(info.selectionText, 'translate', '', menuItemId.slice(CONTEXT_MENU_TRANSLATE_PREFIX.length));
  }
  if (!text) return;

  const payload = {
    id: `ctx-${tab.id}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    tabId: tab.id,
    text,
    sourceGrounding: SELECTION_ONLY_SOURCE_GROUNDING,
    ...(selectionAction ? { selectionAction } : {}),
    createdAt: Date.now(),
  };

  // Keep the programmatic sidebar open inside the original user gesture.
  // Prompt storage still completes before the explicit panel notification.
  openSidebarForContextMenu(tab);
  try {
    await contextMenuStorage.save(tab.id, payload);
  } catch {}
  notifySidePanelOfContextMenuPrompt(payload);
}

getContextMenuApi()?.onClicked?.addListener?.((info, tab) => {
  handleContextMenuAsk(info, tab).catch(() => {});
});
getContextMenuApi()?.onShown?.addListener?.((info, tab) => {
  const menuApi = getContextMenuApi();
  const tabId = Number(tab?.id);
  const visible = Number.isInteger(tabId) && tabId >= 0
    && (pdfResponseTabs.has(tabId) || isPdfUrl(info?.pageUrl || tab?.url));
  (async () => {
    try {
      await menuApi?.update?.(CONTEXT_MENU_OPEN_PDF_VIEWER_ID, { visible });
      await menuApi?.refresh?.();
    } catch {}
  })();
});
browser.tabs.onRemoved?.addListener?.((tabId) => pdfResponseTabs.delete(tabId));

// Only this instance knows which runs are live in memory, so it owns the
// stale-run repair whenever it is reachable.
browser.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type !== 'WB_TRACE_REPAIR_STALE_RUNS') return;
  workflowTrace.repairStaleRuns()
    .then(repaired => sendResponse({ ok: true, repaired }))
    .catch(error => sendResponse({ ok: false, error: error?.message || String(error) }));
  return true;
});

browser.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type !== 'WB_SELECTION_SHORTCUT_LOCALIZATION') return;
  sendResponse({ ok: true, ...getSelectionShortcutLocalization(msg.locale) });
});

// Firefox does not treat a click in an injected page UI as an authorized
// sidebarAction.open() gesture. Persist and notify the existing sidebar when
// it is open; otherwise startup recovery will consume the prompt after the
// user opens WebBrain manually.
function queueFirefoxSelectionShortcutPrompt(msg, tab, sendResponse) {
  const selectionAction = normalizeSelectionAction(msg.action);
  const includePageContext = selectionAction === 'custom' && msg.includePageContext === true;
  const sourceGrounding = includePageContext
    ? ''
    : selectionAction === 'custom'
      ? SELECTION_CONTEXT_SOURCE_GROUNDING
      : SELECTION_ONLY_SOURCE_GROUNDING;
  const text = includePageContext
    ? buildFullContextSelectionPrompt(msg.selectionText, msg.question)
    : buildSelectionPrompt(
      msg.selectionText,
      msg.action,
      msg.question,
      msg.language,
      sourceGrounding,
    );
  if (!tab?.id || !text) {
    sendResponse({ ok: false, queued: false, requiresManualOpen: true, error: 'Invalid selection shortcut request.' });
    return false;
  }
  const payload = {
    id: `selection-${tab.id}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    tabId: tab.id,
    text,
    ...(sourceGrounding ? {
      sourceGrounding,
      ...(selectionAction ? { selectionAction } : {}),
    } : {}),
    ...(includePageContext ? { restoreSelectionScope: true } : {}),
    createdAt: Date.now(),
  };

  (async () => {
    try {
      await contextMenuStorage.save(tab.id, payload);
    } catch {}
    notifySidePanelOfContextMenuPrompt(payload);
    return { ok: true, queued: true, requiresManualOpen: true };
  })().then(sendResponse).catch((error) => {
    sendResponse({ ok: false, queued: false, requiresManualOpen: true, error: error?.message || String(error) });
  });
  return true;
}

browser.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type !== 'WB_SELECTION_SHORTCUT_SUBMIT') return;
  return queueFirefoxSelectionShortcutPrompt(msg, sender?.tab, sendResponse);
});

// The explicit Firefox viewer is an extension page, so sender.tab is not a
// reliable source of scope. Resolve the live tab from the handler-provided id
// before handing the selected OCR/PDF text to the normal prompt storage path.
browser.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type !== 'WB_PDF_SELECTION_SHORTCUT_SUBMIT') return;
  const tabId = Number(msg.tabId);
  if (!Number.isInteger(tabId) || tabId < 0) {
    sendResponse({ ok: false, queued: false, requiresManualOpen: true, error: 'Invalid PDF selection tab.' });
    return;
  }
  if (!isPdfHandlerSender(sender, tabId)) {
    sendResponse({ ok: false, queued: false, requiresManualOpen: true, error: 'Invalid PDF selection sender.' });
    return;
  }
  browser.tabs.get(tabId)
    .then(tab => queueFirefoxSelectionShortcutPrompt(msg, tab, sendResponse))
    .catch(error => sendResponse({
      ok: false,
      queued: false,
      requiresManualOpen: true,
      error: error?.message || 'The PDF tab is no longer available.',
    }));
  return true;
});

// Forget the per-window mapping when the user manually ungroups.
browser.tabGroups?.onRemoved?.addListener?.((group) => {
  for (const [windowId, gid] of webBrainGroupByWindow) {
    if (gid === group.id) {
      webBrainGroupByWindow.delete(windowId);
      saveWebBrainGroups();
      break;
    }
  }
});

// Window closed — drop the mapping.
browser.windows?.onRemoved?.addListener?.((windowId) => {
  if (webBrainGroupByWindow.has(windowId)) {
    webBrainGroupByWindow.delete(windowId);
    saveWebBrainGroups();
  }
});

// Clean up per-tab agent state when a tab is closed.
browser.tabs.onRemoved.addListener((tabId) => {
  clearUserMemoryTurnContext(tabId);
  clearTimeout(pendingContextMenuNotifications.get(tabId));
  pendingContextMenuNotifications.delete(tabId);
  contextMenuStorage.cleanup(tabId);
  tabChatHandoff.clear(tabId).catch(() => {});
  clearStagedScreenshots(browser.storage.local, tabId).catch(() => {});
  scheduler.cancelForTab(tabId).catch(() => {});
  withTeacherSessionStoreLock(() => teacherSessionStore.clear(tabId)).catch(() => {});
  try { agent._cleanupTab(tabId); } catch { /* ignore */ }
});

// Invalidate pending context-menu prompts on any navigation (full page load or
// SPA history/fragment change) so a prompt recorded on page A is never
// submitted in the context of page B.
function invalidateContextMenuForTab(tabId) {
  clearTimeout(pendingContextMenuNotifications.get(tabId));
  pendingContextMenuNotifications.delete(tabId);
  contextMenuStorage.cleanup(tabId);
  browser.runtime.sendMessage({
    target: 'sidepanel',
    action: 'context_menu_tab_navigated',
    tabId,
  }).catch(() => {});
}

function recordTeacherNavigation(tabId, url, options) {
  teacherRunInterlock.navigation(tabId, url, options).catch(() => {});
}

const TEACHER_EXPLICIT_NAVIGATION_TYPES = new Set([
  'typed', 'auto_bookmark', 'generated', 'keyword', 'keyword_generated',
]);

browser.webNavigation?.onCommitted?.addListener?.((details) => {
  if (details.frameId !== 0) return;
  agent.clearLastTypeFieldIdent(details.tabId);
  agent.observeCloudflareManagedChallengeNavigation(details).catch(() => {});
  recordTeacherNavigation(details.tabId, details.url, {
    force: TEACHER_EXPLICIT_NAVIGATION_TYPES.has(details.transitionType),
  });
  invalidateContextMenuForTab(details.tabId);
});
browser.webNavigation?.onHistoryStateUpdated?.addListener?.((details) => {
  if (details.frameId !== 0) return;
  agent.clearLastTypeFieldIdent(details.tabId);
  agent.observeCloudflareManagedChallengeNavigation(details).catch(() => {});
  recordTeacherNavigation(details.tabId, details.url);
  invalidateContextMenuForTab(details.tabId);
});
browser.webNavigation?.onReferenceFragmentUpdated?.addListener?.((details) => {
  if (details.frameId !== 0) return;
  agent.clearLastTypeFieldIdent(details.tabId);
  agent.observeCloudflareManagedChallengeNavigation(details).catch(() => {});
  invalidateContextMenuForTab(details.tabId);
});

// Cloudflare Challenge Pages replace the requested top-level document and
// expose a response-only signal. Observe only main-frame response headers;
// challenge-platform requests alone are not sufficient because ordinary bot
// detection and embedded widgets may use the same managed endpoint.
const observeCloudflareManagedChallengeResponse = details => {
  trackPdfResponse(details);
  agent.observeCloudflareManagedChallengeResponse(details).catch(() => {});
};
const observeCloudflareChallengePlatformRequest = details => {
  agent.observeCloudflareChallengePlatformRequest(details).catch(() => {});
};
browser.webRequest?.onHeadersReceived?.addListener?.(
  observeCloudflareManagedChallengeResponse,
  { urls: ['<all_urls>'], types: ['main_frame'] },
  ['responseHeaders'],
);
browser.webRequest?.onBeforeRequest?.addListener?.(
  observeCloudflareChallengePlatformRequest,
  { urls: ['*://*/cdn-cgi/challenge-platform/*'] },
);

// Background API call observer (issue #189). Watches XHR/fetch requests the
// page itself fires — e.g. clicking "Next Page" — so the agent can later spot
// a repeated UI action and shortcut to calling the underlying API directly.
// Strict matching only: same tab, exact method/url captured as-is — no
// param-pattern fuzzing yet. Replay material is kept behind opaque ids so CSRF
// tokens and form bodies do not get printed into model context.
const API_REQUESTS_PER_TAB_LIMIT = 40;
const API_MUTATION_OBSERVER_KEY = 'apiMutationObserverEnabled';
const API_MUTATION_OBSERVER_DEFAULT = true;
const API_REPLAY_BODY_LIMIT = 16000;
const apiRequestsByTab = new Map(); // tabId -> [{ url, method, ts, replayRequestId, ... }]
const apiRequestReplayById = new Map(); // replayRequestId -> captured same-origin replay options
globalThis.__webbrainApiRequests = apiRequestsByTab;
globalThis.__webbrainApiRequestReplay = apiRequestReplayById;
let apiMutationObserverRegistered = false;

function apiReplayId(tabId, requestId) {
  return `api_${tabId}_${String(requestId || Date.now()).replace(/[^\w.-]/g, '_')}`;
}

function extractApiReplayBody(requestBody) {
  if (!requestBody) return null;
  try {
    if (Array.isArray(requestBody.raw) && requestBody.raw.length) {
      const chunks = [];
      for (const part of requestBody.raw) {
        if (part?.bytes) chunks.push(new Uint8Array(part.bytes));
      }
      const total = chunks.reduce((n, chunk) => n + chunk.byteLength, 0);
      if (!total || total > API_REPLAY_BODY_LIMIT) return null;
      const merged = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) {
        merged.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return new TextDecoder().decode(merged);
    }
    if (requestBody.formData && typeof requestBody.formData === 'object') {
      const params = new URLSearchParams();
      for (const [key, values] of Object.entries(requestBody.formData)) {
        const list = Array.isArray(values) ? values : [values];
        for (const value of list) params.append(key, String(value));
      }
      const text = params.toString();
      return text.length <= API_REPLAY_BODY_LIMIT ? text : null;
    }
  } catch (_) {}
  return null;
}

function filterApiReplayHeaders(requestHeaders = []) {
  const allowed = new Set([
    'accept',
    'content-type',
    'x-requested-with',
    'x-csrf-token',
    'x-xsrf-token',
    'x-github-requested-with',
    'x-turbo-request-id',
  ]);
  const headers = {};
  for (const header of requestHeaders || []) {
    const name = String(header?.name || '').toLowerCase();
    if (!allowed.has(name)) continue;
    const value = header?.value;
    if (value != null) headers[name] = String(value);
  }
  return headers;
}

function pruneApiReplayStore() {
  const liveIds = new Set();
  for (const list of apiRequestsByTab.values()) {
    for (const item of list) {
      if (item?.replayRequestId) liveIds.add(item.replayRequestId);
    }
  }
  for (const id of apiRequestReplayById.keys()) {
    if (!liveIds.has(id)) apiRequestReplayById.delete(id);
  }
}

function recordApiRequest(details) {
  const { tabId, url, method, requestId } = details;
  if (tabId == null || tabId < 0) return;
  const replayRequestId = apiReplayId(tabId, requestId);
  const body = extractApiReplayBody(details.requestBody);
  const entry = {
    requestId,
    replayRequestId,
    url,
    method,
    ts: Date.now(),
    hasBody: body != null,
    headerNames: [],
  };
  const list = apiRequestsByTab.get(tabId) || [];
  list.push(entry);
  if (list.length > API_REQUESTS_PER_TAB_LIMIT) list.shift();
  apiRequestsByTab.set(tabId, list);
  apiRequestReplayById.set(replayRequestId, {
    tabId,
    requestId,
    url,
    method,
    body,
    headers: {},
  });
  pruneApiReplayStore();
}

function recordApiRequestHeaders(details) {
  const { tabId, requestId } = details;
  if (tabId == null || tabId < 0 || !requestId) return;
  const list = apiRequestsByTab.get(tabId) || [];
  const entry = [...list].reverse().find(item => item?.requestId === requestId);
  if (!entry) return;
  const headers = filterApiReplayHeaders(details.requestHeaders);
  entry.headerNames = Object.keys(headers);
  const replay = apiRequestReplayById.get(entry.replayRequestId);
  if (replay) replay.headers = headers;
}

function setApiMutationObserverEnabled(enabled) {
  const shouldEnable = enabled === true;
  const onBeforeRequest = browser.webRequest?.onBeforeRequest;
  const onBeforeSendHeaders = browser.webRequest?.onBeforeSendHeaders;
  if (!onBeforeRequest) return;
  if (shouldEnable && !apiMutationObserverRegistered) {
    onBeforeRequest.addListener(recordApiRequest, { urls: ['<all_urls>'], types: ['xmlhttprequest'] }, ['requestBody']);
    onBeforeSendHeaders?.addListener(
      recordApiRequestHeaders,
      { urls: ['<all_urls>'], types: ['xmlhttprequest'] },
      ['requestHeaders']
    );
    apiMutationObserverRegistered = true;
  } else if (!shouldEnable && apiMutationObserverRegistered) {
    onBeforeRequest.removeListener(recordApiRequest);
    onBeforeSendHeaders?.removeListener(recordApiRequestHeaders);
    apiMutationObserverRegistered = false;
    apiRequestsByTab.clear();
    apiRequestReplayById.clear();
  } else if (!shouldEnable) {
    apiRequestsByTab.clear();
    apiRequestReplayById.clear();
  }
}

async function loadApiMutationObserverSetting() {
  try {
    const stored = await browser.storage.local.get({ [API_MUTATION_OBSERVER_KEY]: API_MUTATION_OBSERVER_DEFAULT });
    setApiMutationObserverEnabled(stored[API_MUTATION_OBSERVER_KEY] === true);
  } catch (e) {
    // Do not capture requests when a stored opt-out cannot be read.
    setApiMutationObserverEnabled(false);
  }
}

loadApiMutationObserverSetting();

browser.tabs.onRemoved.addListener((tabId) => {
  apiRequestsByTab.delete(tabId);
  for (const [id, replay] of apiRequestReplayById.entries()) {
    if (replay?.tabId === tabId) apiRequestReplayById.delete(id);
  }
});

// Action click: toggle sidebar (existing UX) AND ensure source tab is
// in the WebBrain group so the colored label appears immediately.
browser.browserAction.onClicked.addListener((tab) => {
  browser.sidebarAction.toggle();
  // Async — sidebar toggle doesn't need to wait on grouping.
  if (tab?.id) ensureWebBrainGroup(tab).catch(() => {});
});

// ────────────────────────────────────────────────────────────────────────
// Agent visual indicator (content-script bridge)
//
// While an agent run is in flight, ask the page's content script to
// render a pulsing purple inset glow around the viewport plus a "Stop
// WebBrain" floating button. The chat / chat_stream / continue handlers
// wrap their await in a try/finally that calls sendIndicatorMessage.
// agent.js fires HIDE_FOR_TOOL_USE / SHOW_AFTER_TOOL_USE around screenshot
// capture so the agent doesn't see its own border in the pixels it sends
// to the vision model.
// ────────────────────────────────────────────────────────────────────────

/**
 * Tell a tab's content script to show/hide the agent indicator. Best-
 * effort: silently no-ops on about:* / file:// pages without our
 * content script and on tabs that haven't loaded yet.
 */
const activeIndicatorTabs = new Set();
const indicatorHeartbeatTimers = new Map();
const INDICATOR_HEARTBEAT_INTERVAL_MS = 20_000;

function stopIndicatorHeartbeat(tabId) {
  const timer = indicatorHeartbeatTimers.get(tabId);
  if (timer != null) clearInterval(timer);
  indicatorHeartbeatTimers.delete(tabId);
}

function startIndicatorHeartbeat(tabId) {
  if (indicatorHeartbeatTimers.has(tabId)) return;
  const timer = setInterval(() => {
    if (!activeIndicatorTabs.has(tabId)) {
      stopIndicatorHeartbeat(tabId);
      return;
    }
    try {
      browser.tabs.sendMessage(tabId, { type: 'WB_AGENT_INDICATOR_HEARTBEAT' })
        .then((response) => {
          // The page lease may have expired while the tab/browser was frozen.
          // Restore the indicator only if this run is still active; a late
          // heartbeat response after HIDE must never resurrect stale UI.
          if (response?.active === false && activeIndicatorTabs.has(tabId)) {
            sendIndicatorMessage(tabId, 'WB_SHOW_AGENT_INDICATORS');
          }
        })
        .catch(() => {});
    } catch {}
  }, INDICATOR_HEARTBEAT_INTERVAL_MS);
  indicatorHeartbeatTimers.set(tabId, timer);
}

function sendIndicatorMessage(tabId, type) {
  if (tabId == null || !type) return;
  if (type === 'WB_SHOW_AGENT_INDICATORS') {
    activeIndicatorTabs.add(tabId);
    startIndicatorHeartbeat(tabId);
  } else if (type === 'WB_HIDE_AGENT_INDICATORS') {
    activeIndicatorTabs.delete(tabId);
    stopIndicatorHeartbeat(tabId);
  }
  try {
    browser.tabs.sendMessage(tabId, { type }).catch(() => { /* expected */ });
  } catch { /* ignore */ }
}

function reassertIndicatorIfActive(tabId) {
  if (!activeIndicatorTabs.has(tabId)) return;
  sendIndicatorMessage(tabId, 'WB_SHOW_AGENT_INDICATORS');
  setTimeout(() => {
    if (activeIndicatorTabs.has(tabId)) {
      sendIndicatorMessage(tabId, 'WB_SHOW_AGENT_INDICATORS');
    }
  }, 500);
}

browser.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo?.status === 'complete') {
    reassertIndicatorIfActive(tabId);
  }
});

browser.tabs.onRemoved.addListener((tabId) => {
  activeIndicatorTabs.delete(tabId);
  stopIndicatorHeartbeat(tabId);
  clearRunUiSnapshot(tabId);
  clearDetachedRunFailure(tabId);
  flashedBadgeTabs.delete(tabId);
});

// ─── Completion attention flash ─────────────────────────────────────
// When a run settles on a background tab, the side panel asks us to make
// that tab noticeable. The preferred path blinks the page title/favicon
// via the content script; when no receiver answers (restricted pages,
// discarded tabs, …) we fall back to a per-tab toolbar badge that clears
// as soon as the user activates the tab.
const flashedBadgeTabs = new Set();

// Per-tab toolbar badges are only visible while their tab is selected, so
// restricted/discarded targets additionally get a system notification (the
// only fallback visible while another tab is selected). Clicking it focuses
// the finished tab. The chime has already played, so notifications stay
// silent and auto-clear.
const COMPLETION_NOTIFICATION_VISIBLE_MS = 12000;
const completionNotificationFocusHandlers = new Map();

browser.notifications.onClicked.addListener((notificationId) => {
  const focus = completionNotificationFocusHandlers.get(notificationId);
  if (!focus) return;
  completionNotificationFocusHandlers.delete(notificationId);
  void focus();
});
browser.notifications.onClosed.addListener((notificationId) => {
  completionNotificationFocusHandlers.delete(notificationId);
});

async function showCompletionNotification(tabId, success) {
  let tab = null;
  try {
    tab = await browser.tabs.get(tabId);
  } catch { return; }
  const message = tab?.title || tab?.url || 'A background task finished.';
  let notificationId = null;
  try {
    notificationId = await browser.notifications.create({
      type: 'basic',
      iconUrl: browser.runtime.getURL('icons/icon48.png'),
      title: `WebBrain — ${success ? 'Task finished' : 'Task needs attention'}`,
      message,
      silent: true,
    });
  } catch { return; }
  if (!notificationId) return;
  setTimeout(() => {
    completionNotificationFocusHandlers.delete(notificationId);
    browser.notifications.clear(notificationId).catch(() => {});
  }, COMPLETION_NOTIFICATION_VISIBLE_MS);
  if (Number.isInteger(tabId)) {
    completionNotificationFocusHandlers.set(notificationId, async () => {
      try {
        const target = await browser.tabs.get(tabId);
        if (target?.windowId != null) await browser.windows.update(target.windowId, { focused: true });
        await browser.tabs.update(tabId, { active: true });
      } catch { /* tab may be gone */ }
    });
  }
}

browser.tabs.onActivated.addListener(({ tabId } = {}) => {
  flashedBadgeTabs.delete(tabId);
  // Clear unconditionally so badge cleanup never depends on volatile state.
  // Resetting the per-tab override is idempotent and restores any global badge.
  browser.browserAction.setBadgeText({ tabId, text: '' }).catch(() => {});
});

// Focusing a window does not fire tabs.onActivated for its already-active
// tab, so badges set on restricted tabs in unfocused windows would linger
// after the user returns to that window. Clear the focused window's active
// tab badge as well — unconditionally, like the activation handler above,
// so cleanup never depends on volatile state.
browser.windows.onFocusChanged.addListener(async (windowId) => {
  if (windowId == null || windowId === browser.windows.WINDOW_ID_NONE) return;
  try {
    const [activeTab] = await browser.tabs.query({ active: true, windowId });
    const activeTabId = Number(activeTab?.id);
    if (!Number.isInteger(activeTabId)) return;
    flashedBadgeTabs.delete(activeTabId);
    await browser.browserAction.setBadgeText({ tabId: activeTabId, text: '' });
  } catch { /* best-effort cleanup */ }
});

// Scheduled jobs keep running even when no side panel is mounted, so the
// background owns their attention flash: terminal events trigger it here
// and the panel never duplicates it. flashTabAttention itself honors the
// stored setting and suppresses the signal while the finished tab is being
// actively watched.
async function maybeFlashScheduledTerminalEvent(_tabId, type, data) {
  if (type !== 'scheduled_job') return;
  const event = data?.event;
  const job = data?.job;
  // clarification_required is terminal for unattended runs and waits on the
  // user — they must be told, or the task stalls unnoticed forever.
  if ((event !== 'completed' && event !== 'failed' && event !== 'clarification_required')
    || job?.source === 'watch') return;
  try {
    const jobTabId = Number(job.tabId ?? job.target?.tabId ?? _tabId);
    // lastOutcome is an explicit verdict: the scheduler classifies Ask runs
    // at the source, so no null-outcome guessing happens here.
    await flashTabAttention({
      tabId: jobTabId,
      success: event === 'completed' && job?.lastOutcome === 'success',
    });
  } catch { /* best-effort */ }
}

async function flashTabAttention(msg) {
  try {
    const stored = await browser.storage.local.get('completionFlashTab');
    if (stored?.completionFlashTab === false) return { ok: true, mode: 'disabled' };
  } catch { /* setting defaults to on */ }
  const tabId = Number(msg?.tabId);
  const success = msg?.success !== false;
  if (!Number.isInteger(tabId) || tabId < 0) {
    return { ok: false, error: 'flash_tab_attention requires a valid tabId.' };
  }
  try {
    await browser.tabs.get(tabId);
  } catch {
    return { ok: false, error: `Tab ${tabId} no longer exists.` };
  }
  // Discarded/unloaded tabs and pages whose content script declines to
  // blink (document already visible) both fall through to the badge
  // fallback — which works without touching the page and survives until
  // the user actually looks at the tab.
  let flashAccepted = false;
  try {
    const response = await browser.tabs.sendMessage(tabId, {
      target: 'content',
      action: 'attention_flash_start',
      params: { success },
    });
    flashAccepted = response?.started === true;
  } catch {
    flashAccepted = false;
  }
  if (flashAccepted) return { ok: true, mode: 'title-flash' };
  // No content-script receiver (or it declined) — fall back to a per-tab
  // toolbar badge. But re-check first whether the user is actually looking
  // at the tab: "active" only means selected within its own window, so an
  // active tab in an unfocused window (user works elsewhere) still deserves
  // the badge. The activation/focus listeners have already cleared any
  // stale badge, and no further event would fire for an already-active tab.
  let tabIsWatched = false;
  try {
    const fresh = await browser.tabs.get(tabId);
    if (fresh?.active) {
      const tabWindow = fresh.windowId != null
        ? await browser.windows.get(fresh.windowId)
        : null;
      tabIsWatched = tabWindow?.focused === true;
    }
  } catch {
    return { ok: false, error: `Tab ${tabId} no longer exists.` };
  }
  if (tabIsWatched) return { ok: true, mode: 'skipped-tab-watched' };
  try {
    await browser.browserAction.setBadgeText({ tabId, text: success ? '✓' : '!' });
    await browser.browserAction.setBadgeBackgroundColor({
      tabId,
      color: success ? '#22c55e' : '#ef4444',
    });
    flashedBadgeTabs.add(tabId);
    // The badge itself is invisible while another tab is selected — pair it
    // with a system notification so the completion is discoverable anyway.
    await showCompletionNotification(tabId, success);
    return { ok: true, mode: 'badge+notification' };
  } catch (error) {
    return { ok: false, error: String(error?.message || error) };
  }
}

const RUN_UI_PREFIX = 'runUi:';
const runUiPersistenceQueues = new Map();
const runUiPersistenceFailures = new Map();

function cloneRunUiSnapshot(snapshot) {
  try {
    return structuredClone(snapshot);
  } catch {
    return JSON.parse(JSON.stringify(snapshot));
  }
}

function persistRunUiSnapshot(tabId, snapshot) {
  const requestId = String(snapshot?.requestId || '');
  if (runUiPersistenceFailures.get(tabId) === requestId) return Promise.resolve(false);
  const stableSnapshot = compactRunUiSnapshotForPersist(cloneRunUiSnapshot(snapshot));
  const previous = runUiPersistenceQueues.get(tabId) || Promise.resolve(true);
  const write = previous.catch(() => false).then(async () => {
    if (runUiPersistenceFailures.get(tabId) === requestId) return false;
    try {
      await browser.storage.session.set({ [RUN_UI_PREFIX + tabId]: stableSnapshot });
      return true;
    } catch {
      try {
        await browser.storage.session.set({
          [RUN_UI_PREFIX + tabId]: compactRunUiSnapshotForPersist(stableSnapshot, { tight: true }),
        });
        return true;
      } catch {
        runUiPersistenceFailures.set(tabId, requestId);
        return false;
      }
    }
  });
  runUiPersistenceQueues.set(tabId, write);
  write.finally(() => {
    if (runUiPersistenceQueues.get(tabId) === write) runUiPersistenceQueues.delete(tabId);
  }).catch(() => {});
  return write;
}

const runUiSnapshotPersistence = new RunUiPersistenceScheduler({
  persist: persistRunUiSnapshot,
});

function flushRunUiSnapshot(tabId, requestId) {
  const pending = runUiSnapshotPersistence.flush(tabId) || runUiPersistenceQueues.get(tabId);
  if (pending) return pending;
  return Promise.resolve(runUiPersistenceFailures.get(tabId) !== String(requestId || ''));
}

const runUiJournal = new RunUiJournal({
  onChange(tabId, snapshot, change) {
    if (change?.eventType === 'text_delta') {
      runUiSnapshotPersistence.defer(tabId, snapshot);
      return;
    }
    void runUiSnapshotPersistence.persistNow(tabId, snapshot);
  },
});

function beginRunUiSnapshot(tabId, requestId, metadata = {}) {
  runUiPersistenceFailures.delete(tabId);
  return runUiJournal.begin(tabId, requestId, metadata);
}

async function beginContinuationRunUiSnapshot(tabId, requestId, metadata = {}) {
  const existing = await getRunUiSnapshot(tabId);
  const sameNonTerminalRun = existing
    && String(existing.requestId || '') === String(requestId || '')
    && !['completed', 'stopped', 'failed', 'cancelled', 'clarification_required'].includes(existing.status);
  if (sameNonTerminalRun) return runUiJournal.resume(tabId, requestId, metadata);
  return beginRunUiSnapshot(tabId, requestId, metadata);
}

function recordRunUiEvent(tabId, requestId, type, data) {
  return runUiJournal.record(tabId, requestId, type, data, agent.currentRunId.get(tabId));
}

function isClarificationRequiredRunUpdate(update) {
  return update?.type === 'run_status'
    && update?.data?.status === 'clarification_required';
}

function isPlannerRequestFailureUpdate(update) {
  return update?.type === 'warning'
    && update?.data?.code === 'planner_request_failed';
}

function isPersistenceDegradedRunUpdate(update) {
  return update?.type === 'run_status'
    && update?.data?.status === 'persistence_degraded';
}

function runUpdatesSucceeded(updates = []) {
  return !updates.some(update => (
    update?.type === 'error'
    || isClarificationRequiredRunUpdate(update)
    || isPersistenceDegradedRunUpdate(update)
    || isPlannerRequestFailureUpdate(update)
  ));
}

function terminalRunUiStatus(content, updates = [], error = null) {
  if (error) return 'failed';
  const text = String(content || '');
  if (/stopped by user|aborted by user/i.test(text)) return 'stopped';
  if (/before executing requested tool calls/i.test(text)) return 'cancelled';
  if (updates.some(update => update?.type === 'error'
    || isPlannerRequestFailureUpdate(update) || isPersistenceDegradedRunUpdate(update))) return 'failed';
  if (updates.some(isClarificationRequiredRunUpdate)) return 'clarification_required';
  return 'completed';
}

function finishRunUiSnapshot(tabId, requestId, status, finalContent = '', askSucceeded = false) {
  const snapshot = runUiJournal.finish(tabId, requestId, status, finalContent, agent.currentRunId.get(tabId));
  if (snapshot) {
    // The journal carries an exact successful-'done' predicate for Act runs;
    // Ask replies are classified by the caller and OR-ed in for badge styling.
    snapshot.runSucceeded = snapshot.successfulDone === true || askSucceeded === true;
  }
  return snapshot;
}

// Mirror the sidepanel's successful-Ask classification for badge styling
// only: non-empty content with no error/attachment/max-steps update and no
// billing terminal (subscribe / cost-allowance messages are actionable
// failures, not successes).
const BADGE_SUBSCRIBE_ERROR_RE = /(Subscribe for more usage|Upgrade to WebBrain Plus):\s*(https?:\/\/\S+)/i;
const BADGE_COST_ALLOWANCE_ERROR_RE = /Cloud cost allowance reached:\s*(this session|total cloud\/router usage)\s+is\s+\$[\d.]+\s+against\s+the\s+\$([\d.]+)\s+limit\./i;
function askCompletionSucceededForBadge(result, updates = [], error = null) {
  if (error) return false;
  if (updates.some(update => (
    update?.type === 'error'
    || update?.type === 'attachment_rejected'
    || update?.type === 'max_steps_reached'
    || update?.error
    || update?.data?.error
  ))) return false;
  const content = String(result ?? '').trim();
  if (!content) return false;
  if (BADGE_SUBSCRIBE_ERROR_RE.test(content)) return false;
  if (BADGE_COST_ALLOWANCE_ERROR_RE.test(content)) return false;
  return true;
}

async function getRunUiSnapshot(tabId) {
  const live = runUiJournal.get(tabId);
  if (live) return live;
  try {
    const key = RUN_UI_PREFIX + tabId;
    const stored = await browser.storage.session?.get(key);
    const snapshot = stored?.[key];
    if (snapshot && typeof snapshot === 'object') {
      return runUiJournal.restore(tabId, snapshot);
    }
  } catch {}
  return null;
}

function clearRunUiSnapshot(tabId) {
  runUiSnapshotPersistence.cancel(tabId);
  runUiJournal.clear(tabId);
  runUiPersistenceFailures.delete(tabId);
  const previous = runUiPersistenceQueues.get(tabId) || Promise.resolve();
  const removal = previous.catch(() => {}).then(() => browser.storage.session?.remove(RUN_UI_PREFIX + tabId));
  runUiPersistenceQueues.set(tabId, removal);
  removal.finally(() => {
    if (runUiPersistenceQueues.get(tabId) === removal) runUiPersistenceQueues.delete(tabId);
  }).catch(() => {});
}

function sendAgentUpdate(tabId, requestId, type, data) {
  const event = recordRunUiEvent(tabId, requestId, type, data);
  if (!event) return;
  browser.runtime.sendMessage({
    target: 'sidepanel', action: 'agent_update', tabId, requestId,
    runId: event?.runId || agent.currentRunId.get(tabId) || null,
    seq: event?.seq || null, type, data: event?.data ?? data,
  }).catch(() => {});
}

function assertNoActiveTabRun(tabId) {
  if (agent.activeRunState(tabId)?.running || detachedRunStarts.has(tabId)) {
    throw new Error('A run is already active for this tab.');
  }
}

async function activateForegroundCompatibilityTab(tabId) {
  const tab = await browser.tabs.get(tabId);
  await browser.tabs.update(tabId, { active: true });
  if (tab?.windowId != null) {
    await browser.windows.update(tab.windowId, { focused: true });
  }
}

const detachedRunStarts = new Map();
const detachedRunFailures = new Map();
const RUN_KEEPALIVE_INTERVAL_MS = 20_000;
const DETACHED_RUN_FAILURE_TTL_MS = 60_000;
const CONVERSATION_CLEAR_STOP_TIMEOUT_MS = 10_000;

function clearDetachedRunFailure(tabId) {
  const failure = detachedRunFailures.get(tabId);
  if (failure?.expiryTimer) clearTimeout(failure.expiryTimer);
  detachedRunFailures.delete(tabId);
}

function rememberDetachedRunFailure(tabId, requestId, error) {
  clearDetachedRunFailure(tabId);
  const failure = {
    requestId,
    message: String(error?.message || error || 'Detached run failed.'),
    expiryTimer: null,
  };
  failure.expiryTimer = setTimeout(() => {
    if (detachedRunFailures.get(tabId) === failure) detachedRunFailures.delete(tabId);
  }, DETACHED_RUN_FAILURE_TTL_MS);
  detachedRunFailures.set(tabId, failure);
}

function assertRunCanStart(tabId, msg) {
  assertDetachedRunStartNotCancelled(tabId, msg);
  const reserved = detachedRunStarts.get(tabId);
  const internalRequestId = String(msg?.__detachedRunRequestId || '');
  if (reserved) {
    if (!internalRequestId || internalRequestId !== reserved.requestId) {
      throw new Error('A run is already active for this tab.');
    }
  }
  if (agent.activeRunState(tabId)?.running) {
    throw new Error('A run is already active for this tab.');
  }
}

function isDetachedRunStartCancelled(tabId, msg) {
  const internalRequestId = String(msg?.__detachedRunRequestId || '');
  const reserved = detachedRunStarts.get(tabId);
  return !!internalRequestId
    && reserved?.requestId === internalRequestId
    && reserved.cancelled === true;
}

function assertDetachedRunStartNotCancelled(tabId, msg) {
  if (isDetachedRunStartCancelled(tabId, msg)) {
    throw new Error('Run stopped by user before it started.');
  }
}

function cancelDetachedRunStart(tabId) {
  const reserved = detachedRunStarts.get(tabId);
  if (!reserved) return false;
  reserved.cancelled = true;
  return true;
}

async function stopActiveRunBeforeConversationClear(tabId) {
  const activeStart = detachedRunStarts.get(tabId) || null;
  const running = agent.activeRunState(tabId)?.running === true;
  if (!activeStart && !running) return false;

  cancelDetachedRunStart(tabId);
  try { agent.abort(tabId); } catch { /* best effort */ }

  let timedOut = false;
  let timeoutId = null;
  const unwind = (async () => {
    // Keep the old conversation alive until its run has unwound. Clearing it
    // first leaves the per-tab run guard active while the UI already looks like
    // a fresh chat, so the next send fails with "run already in progress".
    if (activeStart?.promise) {
      await activeStart.promise.catch(() => {});
    }
    // Direct chat/chat_stream callers do not have a detached-start promise.
    // Do not clear their conversation until processMessage's finally block has
    // released the agent's per-tab run guard.
    while (!timedOut && agent.activeRunState(tabId)?.running) {
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  })();
  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      timedOut = true;
      reject(new Error('The active run did not stop within 10 seconds. The conversation was left intact to avoid mixing it with a still-running task. Reload the extension to recover a permanently stuck run.'));
    }, CONVERSATION_CLEAR_STOP_TIMEOUT_MS);
  });
  try {
    await Promise.race([unwind, timeout]);
  } finally {
    if (timeoutId != null) clearTimeout(timeoutId);
  }
  return true;
}

function acquireRunKeepalive() {
  let released = false;
  const touch = () => {
    try {
      browser.runtime.getPlatformInfo().catch(() => {});
    } catch {}
  };
  touch();
  const timer = setInterval(touch, RUN_KEEPALIVE_INTERVAL_MS);
  return () => {
    if (released) return;
    released = true;
    clearInterval(timer);
  };
}

function launchDetachedRun(action, msg, sender) {
  const tabId = msg.tabId || sender.tab?.id;
  if (!tabId) throw new Error('No tab ID');
  assertNoActiveTabRun(tabId);
  clearDetachedRunFailure(tabId);
  const requestId = String(msg.requestId || `req_${tabId}_${Date.now()}`);
  const entry = { requestId, promise: null, cancelled: false };
  detachedRunStarts.set(tabId, entry);
  const task = Promise.resolve().then(() => {
    const detachedMessage = {
      ...msg,
      action,
      requestId,
      __detachedRunRequestId: requestId,
    };
    assertDetachedRunStartNotCancelled(tabId, detachedMessage);
    return handleMessage(detachedMessage, sender);
  });
  entry.promise = task;
  task.catch((error) => {
    rememberDetachedRunFailure(tabId, requestId, error);
    console.warn(`[WebBrain] detached ${action} run failed:`, error);
  }).finally(() => {
    if (detachedRunStarts.get(tabId) === entry) detachedRunStarts.delete(tabId);
  });
  return { ok: true, accepted: true, requestId };
}

async function sendAgentRunComplete(tabId, snapshot = null) {
  if (tabId == null || !snapshot) return;
  // Live runs continue in the background even if their side panel is closed
  // or reloaded mid-run (and continuations settle here too), so terminal
  // attention flashes are owned here rather than by the panel. User stops
  // and cancellations never flash; the setting is honored inside
  // flashTabAttention.
  const liveStatus = String(snapshot.status || '');
  if (liveStatus !== 'stopped' && liveStatus !== 'cancelled') {
    // Badge styling uses the run's recorded outcome (successful done update
    // or successful Ask reply), not just the terminal status — a completed
    // status alone can still mean max-steps were reached without success.
    flashTabAttention({
      tabId,
      success: liveStatus === 'completed' && snapshot.runSucceeded === true,
    }).catch(() => {});
  }
  const submittedTurnDurable = snapshot.kind === 'continue'
    || await agent.hasDurableSubmittedTurn(
      tabId,
      snapshot.requestId,
    ).catch(() => false);
  const attachmentCount = Math.max(0, Number(snapshot.attachmentCount || 0));
  const attachmentDeliveryState = attachmentCount
    ? (snapshot.attachmentDeliveryState === 'not-sent'
      ? 'not-sent'
      : submittedTurnDurable ? 'included' : 'unknown')
    : '';
  if (attachmentDeliveryState) {
    snapshot = runUiJournal.setAttachmentDeliveryState(
      tabId,
      snapshot.requestId,
      attachmentDeliveryState,
    ) || snapshot;
    await flushRunUiSnapshot(tabId, snapshot.requestId);
  }
  browser.runtime.sendMessage({
    target: 'sidepanel',
    action: 'agent_update',
    tabId,
    requestId: snapshot.requestId,
    runId: snapshot.runId || null,
    seq: snapshot.seq,
    type: 'run_complete',
    data: {
      status: snapshot.status || 'completed',
      finalContent: snapshot.finalContent || '',
      endedAt: snapshot.endedAt || Date.now(),
      submittedTurnDurable,
      attachmentDeliveryState,
    },
  }).catch(() => {});
}

// Stop button on the page → abort the agent run for that tab. Mirrors
// the sidepanel's Stop button.
browser.runtime.onMessage.addListener((msg, sender) => {
  if (msg?.type !== 'WB_STOP_AGENT') return; // not ours
  const tabId = sender?.tab?.id;
  if (tabId != null) {
    cancelDetachedRunStart(tabId);
    try { agent.abort(tabId); } catch { /* ignore */ }
    // Always clear the sender tab's page-owned indicator, even when the run
    // already ended or this background lost its in-memory run state.
    sendIndicatorMessage(tabId, 'WB_HIDE_AGENT_INDICATORS');
  }
  return Promise.resolve({ ok: true });
});

/**
 * Central message handler.
 */
browser.runtime.onMessage.addListener((msg, sender) => {
  if (msg.target !== 'background') return;

  return handleMessage(msg, sender).catch(e => ({ error: e.message }));
});

async function handleMessage(msg, sender) {
  const lightweightAction = [
    'persist_tab_chat',
    'load_tab_chat',
    'clear_tab_chat',
    'release_context_menu_prompt_claim',
    'capture_screenshot_redaction_snapshot',
    'fetch_pdf_document',
    'cancel_pdf_ocr',
    EMERGENCY_DOWNLOAD_ACTION,
    'flash_tab_attention',
  ].includes(msg.action);
  if (!lightweightAction) {
    if (providerManager.providers.size === 0) {
      await providerManager.load();
    }
    // Hydrate agent toggles and prompt add-ons once at boot (not per message);
    // onChanged keeps them in sync afterward.
    await Promise.all([planBeforeActReady, planReviewReady, customSkillsReady, userMemoryReady]);
    await alwaysAllowApiMutationsReady;
    await strictSecretModeReady;
    await screenshotRedactionReady;
    await imageBudgetReady;
    await researchEscalationReady;
  }

  switch (msg.action) {
    case 'apocalypse_mode':
      return await apocalypseController.handle(msg.command, msg);
    case EMERGENCY_DOWNLOAD_ACTION:
      return await emergencyDownloadController().handle(msg.command, msg);
    case 'profile_sync_state': return { ok: true, ...(await profileSync.state()) };
    case 'profile_sync_auth_start': return { ok: true, ...(await profileSync.authStart(String(msg.email || '').trim())) };
    case 'profile_sync_auth_status': return { ok: true, ...(await profileSync.authStatus(msg.challengeId, msg.verifier)) };
    case 'profile_sync_unlock': { const previous = await browser.storage.local.get(PROFILE_SYNC_KEYS.enabled); await browser.storage.local.set({ [PROFILE_SYNC_KEYS.enabled]: true }); let state; try { state = await profileSync.unlock(String(msg.password || ''), !!msg.create); await browser.storage.local.set({ [PROFILE_SYNC_KEYS.everEnabled]: true }); } catch (error) { await browser.storage.local.set({ [PROFILE_SYNC_KEYS.enabled]: previous[PROFILE_SYNC_KEYS.enabled] === true }); throw error; } await providerManager.load(); return { ok: true, ...state }; }
    case 'profile_sync_now': { const state = await profileSync.sync(); await providerManager.load(); return { ok: true, ...state }; }
    case 'profile_sync_lock': profileSync.lock(); return { ok: true, ...(await profileSync.state()) };
    case 'profile_sync_change_password': return { ok: true, ...(await profileSync.changePassword(String(msg.oldPassword || ''), String(msg.newPassword || ''))) };
    case 'profile_sync_disable': await profileSync.disable(); return { ok: true };
    case 'profile_sync_reset': return { ok: true, ...(await profileSync.reset(String(msg.password || ''))) };
    case 'get_user_memory': {
      const store = await userMemoryStore.load();
      const settings = await browser.storage.local.get({
        [USER_MEMORY_ENABLED_KEY]: true,
        [USER_MEMORY_AUTO_CAPTURE_KEY]: true,
        [USER_MEMORY_FORM_CAPTURE_KEY]: true,
        [USER_MEMORY_MAX_PROMPT_CHARS_KEY]: normalizeUserMemoryMaxPromptChars(),
      });
      return {
        ok: true,
        store,
        records: store.records,
        enabled: settings[USER_MEMORY_ENABLED_KEY] !== false,
        autoCaptureEnabled: settings[USER_MEMORY_AUTO_CAPTURE_KEY] === true,
        formCaptureEnabled: settings[USER_MEMORY_FORM_CAPTURE_KEY] === true,
        maxPromptChars: normalizeUserMemoryMaxPromptChars(settings[USER_MEMORY_MAX_PROMPT_CHARS_KEY]),
      };
    }

    case 'add_user_memory': {
      const result = await withUserMemoryStoreLock(() => userMemoryStore.add(msg.text, {
        kind: msg.kind,
        scope: msg.scope,
        source: 'manual',
        confidence: 1,
      }));
      if (result.changed) await syncAgentUserMemoryFromStorage();
      return { ok: !!result.record, ...result };
    }

    case 'update_user_memory': {
      const result = await withUserMemoryStoreLock(() => userMemoryStore.update(String(msg.id || ''), {
        text: msg.text,
        kind: msg.kind,
        scope: msg.scope,
        confidence: msg.confidence,
      }));
      if (result.changed) await syncAgentUserMemoryFromStorage();
      return { ok: result.changed, ...result };
    }

    case 'delete_user_memory': {
      const result = await withUserMemoryStoreLock(() => userMemoryStore.delete(String(msg.id || '')));
      if (result.changed) await syncAgentUserMemoryFromStorage();
      return { ok: result.changed, ...result };
    }

    case 'clear_user_memory': {
      const store = await withUserMemoryStoreLock(async () => {
        await clearUserMemoryExtractionQueue();
        return userMemoryStore.clear();
      });
      await syncAgentUserMemoryFromStorage();
      return { ok: true, store };
    }

    case 'export_user_memory': {
      const store = await userMemoryStore.load();
      return { ok: true, store, json: JSON.stringify(store, null, 2) };
    }

    case 'import_user_memory': {
      let payload = msg.store || msg.json || {};
      if (typeof payload === 'string') payload = JSON.parse(payload);
      const store = await withUserMemoryStoreLock(() => userMemoryStore.replace(payload));
      await syncAgentUserMemoryFromStorage();
      return { ok: true, store };
    }

    case 'enqueue_user_memory_extraction': {
      const result = await enqueueUserMemoryExtraction({
        userText: msg.userText,
        assistantText: msg.assistantText,
        mode: msg.mode,
        succeeded: msg.succeeded,
        sourceContext: msg.sourceContext,
        clarificationText: msg.clarificationText,
        conversationId: msg.conversationId,
      });
      return { ok: true, ...result };
    }

    case 'get_teacher_mode': {
      const tabId = msg.tabId || sender.tab?.id;
      if (!tabId) return { ok: false, reason: 'tab_required', session: { active: false } };
      const session = await teacherSessionStore.get(tabId);
      return { ok: true, session: publicTeacherSession(session) };
    }

    case 'start_teacher_mode': {
      const tabId = msg.tabId || sender.tab?.id;
      if (!tabId) return { ok: false, reason: 'tab_required' };
      if (agent.isRunning(tabId) || detachedRunStarts.has(tabId)) {
        return { ok: false, reason: 'agent_running' };
      }
      const tab = await browser.tabs.get(tabId).catch(() => null);
      const result = await teacherRunInterlock.start(tabId, {
        name: msg.name,
        url: tab?.url,
        webbrainVersion: browser.runtime.getManifest().version,
      });
      if (result.changed && !await notifyTeacherState(tabId, result.session)) {
        await withTeacherSessionStoreLock(() => teacherSessionStore.clear(tabId));
        return { ok: false, reason: 'capture_unavailable', session: { active: false } };
      }
      return { ok: result.changed, reason: result.reason, session: publicTeacherSession(result.session) };
    }

    case 'record_teacher_action': {
      const tabId = sender.tab?.id;
      if (!tabId || (sender.frameId != null && sender.frameId !== 0)) {
        return { ok: false, reason: 'tab_required' };
      }
      const result = await teacherRunInterlock.record(tabId, msg.teacherAction);
      return {
        ok: result.changed || ['duplicate', 'unsafe_target'].includes(result.reason),
        reason: result.reason,
        session: publicTeacherSession(result.session),
      };
    }

    case 'end_teacher_mode': {
      const tabId = msg.tabId || sender.tab?.id;
      if (!tabId) return { ok: false, reason: 'tab_required' };
      const response = await withTeacherSessionStoreLock(async () => {
        let session = await teacherSessionStore.get(tabId);
        if (!session) return { ok: false, reason: 'no_active_session', stopped: false };
        const flushed = await browser.tabs.sendMessage(tabId, {
          target: 'content',
          action: 'flush_teacher_capture',
        }).catch(() => null);
        if (flushed?.teacherAction) {
          await teacherSessionStore.record(tabId, flushed.teacherAction);
          session = await teacherSessionStore.get(tabId);
        }
        let result;
        try {
          const compiled = compileWorkflowFromDemonstration(session);
          if (!compiled.workflow) {
            result = { ok: false, ...compiled };
          } else {
            const saved = await withSavedWorkflowStoreLock(() => savedWorkflowStore.put(compiled.workflow));
            result = {
              ok: saved.changed,
              workflow: saved.workflow,
              warnings: compiled.warnings,
              reason: saved.reason || '',
            };
          }
        } catch (error) {
          result = { ok: false, reason: 'save_failed', error: error?.message || String(error) };
        } finally {
          await teacherSessionStore.clear(tabId);
        }
        return { ...result, stopped: true };
      });
      if (response.stopped) await notifyTeacherState(tabId, null);
      return response;
    }

    case 'list_saved_workflows':
      return { ok: true, workflows: await savedWorkflowStore.list() };

    case 'get_saved_workflow': {
      const workflow = await savedWorkflowStore.get(String(msg.id || ''));
      return workflow ? { ok: true, workflow } : { ok: false, reason: 'not_found' };
    }

    case 'export_saved_workflow': {
      const workflow = await savedWorkflowStore.get(String(msg.id || ''));
      if (!workflow) return { ok: false, reason: 'not_found' };
      const portable = exportPortableWorkflowDefinition(workflow);
      return portable.workflow
        ? { ok: true, workflow: portable.workflow }
        : { ok: false, reason: portable.reason };
    }

    case 'import_saved_workflow': {
      const portable = importPortableWorkflowDefinition(msg.definition);
      if (!portable.workflow) return { ok: false, reason: portable.reason };
      const saved = await withSavedWorkflowStoreLock(() => savedWorkflowStore.put(portable.workflow));
      return { ok: saved.changed, workflow: saved.workflow, reason: saved.reason || '' };
    }

    case 'save_latest_workflow': {
      const tabId = msg.tabId || sender.tab?.id;
      if (!tabId) return { ok: false, reason: 'tab_required' };
      const conversationId = await agent.getConversationId(tabId);
      const draft = await agent.getLatestWorkflowDraft(tabId);
      const compiled = draft?.conversationId === conversationId
        ? finalizeSavedWorkflowDraft(draft, { name: msg.name })
        : await compileLatestSuccessfulWorkflow(workflowTrace, {
            conversationId,
            name: msg.name,
          });
      if (!compiled.workflow) return { ok: false, ...compiled };
      const saved = await withSavedWorkflowStoreLock(() => savedWorkflowStore.put(compiled.workflow));
      return { ok: saved.changed, workflow: saved.workflow, warnings: compiled.warnings, reason: saved.reason || '' };
    }

    case 'rename_saved_workflow': {
      const result = await withSavedWorkflowStoreLock(() => savedWorkflowStore.rename(
        String(msg.id || ''),
        msg.name,
      ));
      return { ok: result.changed, ...result };
    }

    case 'delete_saved_workflow': {
      const result = await withSavedWorkflowStoreLock(() => savedWorkflowStore.delete(String(msg.id || '')));
      return { ok: result.changed, ...result };
    }

    case 'ensure_conversation_id': {
      const tabId = msg.tabId || sender.tab?.id;
      if (!tabId) throw new Error('No tab ID');
      return {
        ok: true,
        ...(await agent.getConversationState(tabId, msg.mode || 'ask')),
      };
    }

    case 'chat_start': {
      const claim = msg.contextMenuClaim;
      if (!claim?.promptId || !claim?.claimantId) {
        return launchDetachedRun('chat', msg, sender);
      }
      const tabId = msg.tabId || sender.tab?.id;
      try {
        const reservation = await contextMenuStorage.reserve(
          tabId,
          claim.promptId,
          claim.claimantId,
          () => launchDetachedRun('chat', msg, sender),
        );
        if (reservation?.reserved) return reservation;
        return {
          ok: false,
          accepted: false,
          code: 'context-menu-reservation-rejected',
          reason: reservation?.reason || 'claim-lost',
          leaseExpiresAt: reservation?.leaseExpiresAt,
          retryAfterMs: reservation?.reason === 'run-active' ? 1_000 : undefined,
        };
      } catch (error) {
        if (/run is already active/i.test(String(error?.message || ''))) {
          return {
            ok: false,
            accepted: false,
            code: 'context-menu-reservation-rejected',
            reason: 'run-active',
            retryAfterMs: 1_000,
          };
        }
        throw error;
      }
    }

    case 'continue_start':
      return launchDetachedRun('continue', msg, sender);

    case 'chat': {
      const tabId = msg.tabId || sender.tab?.id;
      if (!tabId) throw new Error('No tab ID');
      if (msg.standaloneChat === true && msg.workflowId) {
        throw new Error('Saved workflows are unavailable in standalone Ask mode.');
      }
      assertRunCanStart(tabId, msg);
      const isWorkflowRun = !!msg.workflowId;
      const mode = isWorkflowRun ? 'act' : (msg.mode || 'ask');
      const runUi = await beginContinuationRunUiSnapshot(tabId, msg.requestId, {
        mode,
        kind: 'chat',
        foreground: msg.foreground === true,
        attachmentCount: isWorkflowRun
          ? 0
          : Array.isArray(msg.attachments) ? msg.attachments.length : 0,
      });
      const releaseRunKeepalive = acquireRunKeepalive();

      if (msg.apiMutationsAllowed) agent.setApiMutationsAllowed(tabId, true);

      sendIndicatorMessage(tabId, 'WB_SHOW_AGENT_INDICATORS');

      const updates = [];
      let userMemoryTurnContextTaken = false;
      let runCaptureState = null;
      let result = '';
      let runError = null;
      try {
        if (msg.foreground) await activateForegroundCompatibilityTab(tabId);

        // Capture belongs to the background run lifecycle so it survives the
        // sidebar closing or reloading while the agent is still working.
        runCaptureState = await runCaptureController.start(msg.runCapture, tabId);

        // Clear any linked context-menu prompt only after capture preflight
        // succeeds, but before the agent run starts.
        if (msg.contextMenuClear?.tabId != null) {
          await contextMenuStorage.clear(msg.contextMenuClear.tabId, msg.contextMenuClear.promptId);
        }
        if (msg.restoreSelectionScope === true && !normalizeSelectionSourceGrounding(msg.sourceGrounding)) {
          await agent.restoreSelectionGroundingScope(tabId);
        }

        const askStreamingSettings = await browser.storage.local.get('openaiAskStreamingEnabled').catch(() => ({}));
        const runOptions = {
          ...(isWorkflowRun ? { independentRun: true } : {}),
          ...(msg.recommendedAction ? { recommendedAction: msg.recommendedAction } : {}),
          ...(msg.foreground ? { foreground: true } : {}),
          ...(msg.standaloneChat === true ? { standaloneChat: true } : {}),
          ...(normalizeSelectionSourceGrounding(msg.sourceGrounding)
            ? {
              sourceGrounding: normalizeSelectionSourceGrounding(msg.sourceGrounding),
              ...(normalizeSelectionAction(msg.selectionAction)
                ? { selectionAction: normalizeSelectionAction(msg.selectionAction) }
                : {}),
            }
            : {}),
          locale: msg.locale,
          intentFailureMessage: msg.intentFailureMessage,
          interactiveChat: true,
          askStreamingEnabled: askStreamingSettings.openaiAskStreamingEnabled !== false,
          detachedRequestId: runUi.requestId,
          isDetachedStartCancelled: () => isDetachedRunStartCancelled(tabId, msg),
          beforeConsequentialTool: () => flushRunUiSnapshot(tabId, runUi.requestId),
          afterConsequentialTool: async ({ name } = {}) => {
            runUiJournal.settleToolCall(tabId, runUi.requestId, name);
            return flushRunUiSnapshot(tabId, runUi.requestId);
          },
        };
        const publishUpdate = (type, data) => {
          updates.push({ type, data });
          sendAgentUpdate(tabId, runUi.requestId, type, data);
        };
        if (isWorkflowRun) {
          const workflow = await savedWorkflowStore.get(String(msg.workflowId || ''));
          if (!workflow) throw new Error('Saved workflow not found.');
          const replay = await agent.replaySavedWorkflow(
            tabId,
            workflow,
            msg.workflowParameters && typeof msg.workflowParameters === 'object' ? msg.workflowParameters : {},
            publishUpdate,
            runOptions,
          );
          result = replay.summary || '';
          if (Array.isArray(replay.healings) && replay.healings.length) {
            const healed = await withSavedWorkflowStoreLock(() => savedWorkflowStore.healTargets(
              workflow.id,
              { expectedUpdatedAt: workflow.updatedAt, healings: replay.healings },
            ));
            publishUpdate(healed.changed ? 'workflow_healed' : 'workflow_healing_not_saved', {
              workflowId: workflow.id,
              workflowName: workflow.name,
              count: healed.healedStepCount || 0,
              reason: healed.reason || '',
            });
          }
          if (replay.status === 'fallback') {
            publishUpdate('workflow_fallback', {
              workflowId: workflow.id,
              stepIndex: replay.stepIndex,
              reason: replay.reason,
            });
            result = await agent.processMessage(tabId, replay.prompt, publishUpdate, 'act', [], {
              ...runOptions,
              preserveRichTextToolbarAudit: true,
            });
          }
        } else {
          result = await agent.processMessage(tabId, msg.text, publishUpdate, mode, msg.attachments, runOptions);
        }

        if (isWorkflowRun) {
          clearUserMemoryTurnContext(tabId);
          userMemoryTurnContextTaken = true;
        } else {
          const userMemoryPayload = takeUserMemoryTurnExtractionPayload(tabId, {
            userText: msg.text,
            assistantText: result,
            mode,
            succeeded: runUpdatesSucceeded(updates),
          });
          userMemoryPayload.conversationId = await agent.getConversationId(tabId);
          userMemoryTurnContextTaken = true;
          enqueueUserMemoryExtractionAfterTurn(userMemoryPayload);
        }
        return {
          content: result,
          updates,
          requestId: runUi.requestId,
          ...(await agent.getConversationState(tabId)),
        };
      } catch (error) {
        runError = error;
        throw error;
      } finally {
        if (runCaptureState) {
          try {
            const captureResult = await runCaptureController.finish(runCaptureState, tabId);
            sendAgentUpdate(tabId, runUi.requestId, 'run_capture_complete', captureResult);
          } catch (error) {
            console.warn('[WebBrain] trailing run capture failed to finish:', error);
            sendAgentUpdate(tabId, runUi.requestId, 'run_capture_error', {
              kind: runCaptureState.kind,
              message: error?.message || String(error),
            });
          }
        }
        if (!userMemoryTurnContextTaken) clearUserMemoryTurnContext(tabId);
        if (runError && String(runError.message || '').startsWith(RUN_CAPTURE_START_ERROR_PREFIX)) {
          clearRunUiSnapshot(tabId);
        } else {
          const snapshot = finishRunUiSnapshot(tabId, runUi.requestId, terminalRunUiStatus(result, updates, runError), result || (runError ? `Error: ${runError.message}` : ''), mode === 'ask' ? askCompletionSucceededForBadge(result, updates, runError) : false);
          await sendAgentRunComplete(tabId, snapshot);
        }
        sendIndicatorMessage(tabId, 'WB_HIDE_AGENT_INDICATORS');
        releaseRunKeepalive();
      }
    }

    case 'chat_stream': {
      const tabId = msg.tabId || sender.tab?.id;
      if (!tabId) throw new Error('No tab ID');
      assertNoActiveTabRun(tabId);
      const mode = msg.mode || 'ask';
      const runUi = beginRunUiSnapshot(tabId, msg.requestId, {
        mode,
        kind: 'chat',
        foreground: msg.foreground === true,
      });
      const releaseRunKeepalive = acquireRunKeepalive();

      if (msg.apiMutationsAllowed) agent.setApiMutationsAllowed(tabId, true);

      sendIndicatorMessage(tabId, 'WB_SHOW_AGENT_INDICATORS');
      let userMemoryTurnContextTaken = false;
      const updates = [];
      let result = '';
      let runError = null;
      try {
        if (msg.foreground) await activateForegroundCompatibilityTab(tabId);

        const runOptions = {
          ...(msg.recommendedAction ? { recommendedAction: msg.recommendedAction } : {}),
          ...(msg.foreground ? { foreground: true } : {}),
          ...(msg.standaloneChat === true ? { standaloneChat: true } : {}),
          ...(normalizeSelectionSourceGrounding(msg.sourceGrounding)
            ? {
              sourceGrounding: normalizeSelectionSourceGrounding(msg.sourceGrounding),
              ...(normalizeSelectionAction(msg.selectionAction)
                ? { selectionAction: normalizeSelectionAction(msg.selectionAction) }
                : {}),
            }
            : {}),
          locale: msg.locale,
          intentFailureMessage: msg.intentFailureMessage,
        };
        result = await agent.processMessageStream(tabId, msg.text, (type, data) => {
          updates.push({ type, data });
          sendAgentUpdate(tabId, runUi.requestId, type, data);
        }, mode, runOptions);

        const userMemoryPayload = takeUserMemoryTurnExtractionPayload(tabId, {
          userText: msg.text,
          assistantText: result,
          mode,
          succeeded: runUpdatesSucceeded(updates),
        });
        userMemoryPayload.conversationId = await agent.getConversationId(tabId);
        userMemoryTurnContextTaken = true;
        enqueueUserMemoryExtractionAfterTurn(userMemoryPayload);
        return {
          content: result,
          requestId: runUi.requestId,
          ...(await agent.getConversationState(tabId)),
        };
      } catch (error) {
        runError = error;
        throw error;
      } finally {
        if (!userMemoryTurnContextTaken) clearUserMemoryTurnContext(tabId);
        const snapshot = finishRunUiSnapshot(tabId, runUi.requestId, terminalRunUiStatus(result, updates, runError), result || (runError ? `Error: ${runError.message}` : ''), mode === 'ask' ? askCompletionSucceededForBadge(result, updates, runError) : false);
        await sendAgentRunComplete(tabId, snapshot);
        sendIndicatorMessage(tabId, 'WB_HIDE_AGENT_INDICATORS');
        releaseRunKeepalive();
      }
    }

    case 'continue': {
      const tabId = msg.tabId || sender.tab?.id;
      if (!tabId) throw new Error('No tab ID');
      assertRunCanStart(tabId, msg);
      const mode = msg.mode || 'ask';
      const runUi = await beginContinuationRunUiSnapshot(tabId, msg.requestId, {
        mode,
        kind: 'continue',
        foreground: msg.foreground === true,
      });
      const releaseRunKeepalive = acquireRunKeepalive();

      sendIndicatorMessage(tabId, 'WB_SHOW_AGENT_INDICATORS');
      let userMemoryTurnContextTaken = false;
      const updates = [];
      let result = '';
      let runError = null;
      try {
        if (msg.foreground) await activateForegroundCompatibilityTab(tabId);

        result = await agent.continueProcessing(tabId, (type, data) => {
          updates.push({ type, data });
          sendAgentUpdate(tabId, runUi.requestId, type, data);
        }, mode, {
          ...(msg.foreground ? { foreground: true } : {}),
          detachedRequestId: runUi.requestId,
          isDetachedStartCancelled: () => isDetachedRunStartCancelled(tabId, msg),
          beforeConsequentialTool: () => flushRunUiSnapshot(tabId, runUi.requestId),
          afterConsequentialTool: async ({ name } = {}) => {
            runUiJournal.settleToolCall(tabId, runUi.requestId, name);
            return flushRunUiSnapshot(tabId, runUi.requestId);
          },
        });

        const userMemoryPayload = takeUserMemoryTurnExtractionPayload(tabId, {
          userText: 'Please continue from where you left off.',
          assistantText: result,
          mode,
          succeeded: runUpdatesSucceeded(updates),
        });
        userMemoryPayload.conversationId = await agent.getConversationId(tabId);
        userMemoryTurnContextTaken = true;
        enqueueUserMemoryExtractionAfterTurn(userMemoryPayload);
        return {
          content: result,
          requestId: runUi.requestId,
          ...(await agent.getConversationState(tabId)),
        };
      } catch (error) {
        runError = error;
        throw error;
      } finally {
        if (!userMemoryTurnContextTaken) clearUserMemoryTurnContext(tabId);
        const snapshot = finishRunUiSnapshot(tabId, runUi.requestId, terminalRunUiStatus(result, updates, runError), result || (runError ? `Error: ${runError.message}` : ''), mode === 'ask' ? askCompletionSucceededForBadge(result, updates, runError) : false);
        await sendAgentRunComplete(tabId, snapshot);
        sendIndicatorMessage(tabId, 'WB_HIDE_AGENT_INDICATORS');
        releaseRunKeepalive();
      }
    }

    case 'clear_conversation': {
      const tabId = msg.tabId || sender.tab?.id;
      let clearedContextMenuPromptId = null;
      if (tabId) {
        const conversationId = await agent.getConversationId(tabId);
        await stopActiveRunBeforeConversationClear(tabId);
        const commitSchedulerClear = async () => {
          await scheduler.cancelForConversation(tabId, conversationId);
        };
        const tabChatClearResult = msg.clearContextMenuPrompt === true
          ? await contextMenuStorage.clearAlongside(
            tabId,
            additionalKeys => tabChatHandoff.clear(tabId, {
              additionalKeys,
              commitAfterRemove: commitSchedulerClear,
            }),
          )
          : await tabChatHandoff.clear(tabId, { commitAfterRemove: commitSchedulerClear });
        if (!tabChatClearResult?.ok || tabChatClearResult.skipped) {
          throw new Error('Could not durably clear the tab transcript.');
        }
        clearedContextMenuPromptId = tabChatClearResult.clearedContextMenuPromptId || null;
        agent.clearConversation(tabId);
        clearRunUiSnapshot(tabId);
        browser.runtime.sendMessage({
          target: 'sidepanel',
          action: 'tab_chat_cleared',
          tabId,
          handoffOwnerId: tabChatClearResult.handoffOwnerId,
          handoffGeneration: tabChatClearResult.handoffGeneration,
          clearedContextMenuPromptId,
        }).catch(() => {});
      }
      return { ok: true, clearedContextMenuPromptId };
    }

    case 'restore_selection_scope': {
      const tabId = msg.tabId || sender.tab?.id;
      if (!tabId) return { ok: false, error: 'No tab ID' };
      if (detachedRunStarts.has(tabId) || agent.activeRunState(tabId)?.running) {
        return { ok: false, error: 'Wait for the current response to finish before restoring the full conversation.' };
      }
      const restored = await agent.restoreSelectionGroundingScope(tabId);
      return { ok: true, restored, ...(await agent.getConversationState(tabId)) };
    }

    case 'compact_conversation': {
      const tabId = msg.tabId || sender.tab?.id;
      if (!tabId) return { ok: false, error: 'No tab ID' };
      return { ok: true, ...(await agent.compactConversation(tabId)) };
    }

    case 'abort': {
      const tabId = msg.tabId || sender.tab?.id;
      if (tabId) {
        const sourceTabId = agent.researchEscalationSourceTab(tabId);
        cancelDetachedRunStart(tabId);
        if (sourceTabId) cancelDetachedRunStart(sourceTabId);
        agent.abort(sourceTabId || tabId);
      }
      return { ok: true };
    }

    case 'agent_run_state': {
      const tabId = msg.tabId || sender.tab?.id;
      if (!tabId) return { ok: false, error: 'No tab ID' };
      const starting = detachedRunStarts.get(tabId) || null;
      const requestedRequestId = String(msg.requestId || '');
      const failure = detachedRunFailures.get(tabId) || null;
      const detachedError = requestedRequestId && failure?.requestId === requestedRequestId
        ? { requestId: failure.requestId, message: failure.message }
        : null;
      const runUiSnapshot = await getRunUiSnapshot(tabId);
      const requestedRunUi = runUiSnapshotForRequest(runUiSnapshot, requestedRequestId);
      const durabilityRequestId = requestedRequestId || String(requestedRunUi?.requestId || '');
      const submittedTurnDurable = requestedRunUi?.kind === 'continue'
        || (durabilityRequestId
          ? await agent.hasDurableSubmittedTurn(tabId, durabilityRequestId)
          : false);
      const conversationState = await agent.getConversationState(tabId);
      const activeState = agent.activeRunState(tabId);
      const runUiDurable = !runUiSnapshot
        || runUiPersistenceFailures.get(tabId) !== String(runUiSnapshot.requestId || '');
      return {
        ok: true,
        ...conversationState,
        ...activeState,
        starting: !!starting,
        startingRequestId: starting?.requestId || null,
        submittedTurnDurable,
        runUiDurable: runUiDurable,
        persistenceDegraded: activeState.persistenceDegraded === true || !runUiDurable,
        persistenceDegradedReason: activeState.persistenceDegradedReason || (!runUiDurable ? 'run_ui' : null),
        detachedError,
        runUi: requestedRunUi,
      };
    }

    case 'agent_run_ack': {
      const tabId = msg.tabId || sender.tab?.id;
      if (!tabId) return { ok: false, error: 'No tab ID' };
      return { ok: !!runUiJournal.acknowledge(tabId, String(msg.requestId || ''), msg.seq) };
    }

    case 'get_scratchpad': {
      const tabId = msg.tabId || sender.tab?.id;
      if (!tabId) return { ok: false, error: 'No tab ID' };
      return { ok: true, ...(await agent.getScratchpad(tabId)) };
    }

    case 'export_traces': {
      const tabId = msg.tabId || sender.tab?.id;
      if (!tabId) return { ok: false, error: 'No tab ID' };
      return { ok: true, ...(await agent.exportTraces(tabId)) };
    }

    case 'export_config': {
      const stored = await browser.storage.local.get(CONFIG_STORAGE_KEYS);
      const config = createConfigExport(stored, {
        locale: msg.locale,
        webbrainVersion: browser.runtime.getManifest().version,
      });
      return {
        ok: true,
        json: JSON.stringify(config, null, 2),
        settingCount: CONFIG_STORAGE_KEYS.length,
      };
    }

    case 'import_config':
    case 'import_config_patch': {
      const imported = msg.action === 'import_config_patch'
        ? parseConfigPatchImport(msg.json)
        : parseConfigImport(msg.json);
      const settings = msg.action === 'import_config_patch'
        ? mergeConfigPatchSettings(
          await browser.storage.local.get(['providers']),
          imported.settings,
        )
        : imported.settings;
      await browser.storage.local.set(settings);
      await providerManager.load();
      await Promise.all([
        loadMaxSteps(),
        loadClarifyTimeout(),
        loadAutoScreenshot(),
        loadSiteAdapters(),
        loadResearchEscalation(),
        loadScreenshotRedaction(),
        loadStrictSecretMode(),
        loadProfile(),
        syncAgentUserMemoryFromStorage(),
        loadCustomSkills(),
        loadCaptchaSolver(),
        loadPlanBeforeAct(),
        loadPlanReviewSettings(),
        loadApiMutationObserverSetting(),
        agent._ensureGateSetting({ force: true }),
      ]);
      agent._refreshSystemPrompts();
      return {
        ok: true,
        settingCount: Object.keys(settings).length,
        ignoredKeys: imported.ignoredKeys,
      };
    }

    case 'get_progress': {
      const tabId = msg.tabId || sender.tab?.id;
      if (!tabId) return { ok: false, error: 'No tab ID' };
      return { ok: true, ...(await agent.getProgress(tabId, msg.args || {})) };
    }

    case 'write_scratchpad': {
      const tabId = msg.tabId || sender.tab?.id;
      if (!tabId) return { ok: false, error: 'No tab ID' };
      const result = await agent.writeScratchpad(tabId, msg.text, { replace: !!msg.replace });
      return { ok: !!result?.success, ...result };
    }

    case 'clear_scratchpad': {
      const tabId = msg.tabId || sender.tab?.id;
      if (!tabId) return { ok: false, error: 'No tab ID' };
      await agent.getScratchpad(tabId);
      const result = agent.clearScratchpad(tabId);
      return { ok: !!result?.success, ...result };
    }

    case 'consume_context_menu_prompt': {
      const tabId = msg.tabId || sender.tab?.id;
      return await contextMenuStorage.consume(tabId);
    }

    case 'claim_context_menu_prompt': {
      const tabId = msg.tabId || sender.tab?.id;
      if (!tabId) return { ok: false, claimed: false, error: 'No tab ID' };
      return await contextMenuStorage.claim(
        tabId,
        msg.promptId,
        msg.claimantId,
        () => agent.activeRunState(tabId)?.running || detachedRunStarts.has(tabId),
      );
    }

    case 'release_context_menu_prompt_claim': {
      const tabId = msg.tabId || sender.tab?.id;
      const result = await contextMenuStorage.release(
        tabId,
        msg.promptId,
        msg.claimantId,
      );
      if (result?.released && result.prompt?.text) {
        notifySidePanelOfContextMenuPrompt(result.prompt);
      }
      return result;
    }

    case 'clear_context_menu_prompt': {
      const tabId = msg.tabId || sender.tab?.id;
      return await contextMenuStorage.clear(tabId, msg.promptId);
    }

    case 'persist_tab_chat':
      return await tabChatHandoff.save(msg.tabId || sender.tab?.id, msg.html, {
        ownerId: msg.handoffOwnerId,
        handoffGeneration: msg.handoffGeneration,
      });

    case 'flash_tab_attention':
      return await flashTabAttention(msg);

    case 'load_tab_chat':
      return await tabChatHandoff.load(msg.tabId || sender.tab?.id, {
        waitForHandoff: msg.waitForHandoff === true,
        claimantId: msg.handoffOwnerId,
      });

    case 'clear_tab_chat': {
      const tabId = msg.tabId || sender.tab?.id;
      const result = await tabChatHandoff.clear(tabId, {
        ownerId: msg.handoffOwnerId,
        handoffGeneration: msg.handoffGeneration,
      });
      if (result?.ok && !result.skipped) {
        browser.runtime.sendMessage({
          target: 'sidepanel',
          action: 'tab_chat_cleared',
          tabId,
          handoffOwnerId: result.handoffOwnerId,
          handoffGeneration: result.handoffGeneration,
        }).catch(() => {});
      }
      return result;
    }

    case 'list_scheduled_jobs': {
      const tabId = msg.tabId || sender.tab?.id || null;
      return { ok: true, jobs: await scheduler.listJobs({ tabId: msg.all ? null : tabId }) };
    }

    case 'create_scheduled_job': {
      const tabId = msg.tabId || sender.tab?.id || null;
      let tab = null;
      if (tabId != null) {
        try { tab = await browser.tabs.get(tabId); } catch {}
      }
      return await scheduler.createTaskJob({
        tabId,
        conversationId: tabId != null ? await agent.getConversationId(tabId) : null,
        args: msg.job || msg.args || {},
        source: 'user',
        currentUrl: tab?.url || '',
        currentTitle: tab?.title || '',
      });
    }

    case 'create_watch_job': {
      const tabId = msg.tabId || sender.tab?.id || null;
      let tab = null;
      if (tabId != null) {
        try { tab = await browser.tabs.get(tabId); } catch {}
      }
      return await scheduler.createWatchJob({
        args: msg.watch || msg.args || {},
        currentUrl: tab?.url || '',
        currentTitle: tab?.title || '',
      });
    }

    case 'cancel_scheduled_job':
      return await scheduler.cancelJob(msg.jobId, 'cancelled by user');

    case 'pause_scheduled_job':
      return await scheduler.pauseJob(msg.jobId);

    case 'resume_scheduled_job':
      return await scheduler.resumeJob(msg.jobId);

    case 'delete_scheduled_job':
      return await scheduler.deleteJob(msg.jobId);

    case 'run_scheduled_job_now':
      return await scheduler.runNow(msg.jobId);

    case 'clarify_input_activity': {
      // Keep a waited clarify open while the user is composing the custom
      // "Something else" answer. The agent owns the authoritative timer.
      const tabId = msg.tabId || sender.tab?.id;
      if (!tabId) return { ok: false, error: 'No tab ID' };
      const clarifyId = String(msg.clarifyId || '');
      if (!clarifyId) return { ok: false, error: 'clarifyId required' };
      const update = agent.noteClarifyInputActivity(tabId, clarifyId);
      return { ok: !!update, matched: !!update, ...update };
    }

    case 'clarify_response': {
      // Side panel posts the user's answer to a pending clarify() tool
      // call. The agent's executeTool() handler is awaiting this exact
      // (tabId, clarifyId) pair and resumes the run when we resolve it.
      const tabId = msg.tabId || sender.tab?.id;
      if (!tabId) return { ok: false, error: 'No tab ID' };
      const clarifyId = String(msg.clarifyId || '');
      const answer = String(msg.answer || '').trim();
      if (!clarifyId) return { ok: false, error: 'clarifyId required' };
      if (!answer) return { ok: false, error: 'answer required' };
      const source = String(msg.source || 'user');
      const matched = agent.submitClarifyResponse(tabId, clarifyId, answer, source);
      // Waited-timeout and Instant auto-selects are not user-authored preferences.
      const isAutoClarify = source === 'timeout' || source === 'auto';
      if (matched && !isAutoClarify && msg.memorySource === 'clarification_response') {
        recordClarificationMemoryCandidate(tabId, msg.question, answer);
      } else if (matched && !isAutoClarify && msg.memorySource === 'form_confirmation') {
        recordFormCompletionMemoryCandidate(tabId, answer);
      }
      return { ok: matched, matched };
    }

    case 'upload_picker_response': {
      const tabId = msg.tabId || sender.tab?.id;
      if (!tabId) return { ok: false, error: 'No tab ID' };
      const pickerId = String(msg.pickerId || '');
      if (!pickerId) return { ok: false, error: 'pickerId required' };
      const matched = agent.submitUploadPickerResponse(tabId, pickerId, msg);
      return { ok: matched, matched };
    }

    case 'plan_response': {
      const tabId = msg.tabId || sender.tab?.id;
      if (!tabId) return { ok: false, error: 'No tab ID' };
      const planId = String(msg.planId || '');
      const decision = String(msg.decision || 'reject');
      const editedText = String(msg.editedText || '');
      const markdownMode = msg.markdownMode === 'verbose' ? 'verbose' : 'compact';
      if (!planId) return { ok: false, error: 'planId required' };
      const matched = agent.submitPlanResponse(tabId, planId, decision, editedText, markdownMode);
      const snapshot = await getRunUiSnapshot(tabId);
      if (matched && snapshot?.requestId) {
        sendAgentUpdate(tabId, snapshot.requestId, 'plan_resolved', { planId, decision });
      }
      return { ok: matched, matched };
    }

    case 'get_debug_log': {
      return { log: agent.getDebugLog() };
    }

    case 'clear_debug_log': {
      agent.clearDebugLog();
      return { ok: true };
    }

    case 'set_help_improve_preference': {
      if (typeof msg.enabled !== 'boolean') throw new Error('enabled must be a boolean');
      const stored = await browser.storage.local.get('helpImproveWebBrain');
      const previousEnabled = stored.helpImproveWebBrain !== false;
      await browser.storage.local.set({ helpImproveWebBrain: msg.enabled });
      try {
        await providerManager.load();
      } catch (error) {
        if (previousEnabled !== msg.enabled) {
          await browser.storage.local.set({ helpImproveWebBrain: previousEnabled }).catch(() => {});
        }
        throw error;
      }
      return { ok: true, enabled: msg.enabled };
    }

    case 'get_providers': {
      return { providers: providerManager.getAll(), active: providerManager.activeProviderId };
    }

    case 'get_active_prompt_tier': {
      const provider = providerManager.getActive();
      return {
        ok: true,
        providerId: providerManager.activeProviderId,
        tier: provider?.promptTier || 'full',
        name: provider?.name || provider?.config?.model || providerManager.activeProviderId,
      };
    }

    case 'set_active_provider': {
      await providerManager.setActive(msg.providerId);
      return { ok: true };
    }

    case 'update_provider': {
      await providerManager.updateProvider(msg.providerId, msg.config, {
        markConfigured: msg.markConfigured !== false,
      });
      return { ok: true };
    }

    case 'duplicate_provider':
      return await providerManager.duplicateProvider(msg.providerId);

    case 'remove_duplicate_provider':
      return await providerManager.removeDuplicateProvider(msg.providerId);

    case 'ollama_launch_handoff': {
      const handoff = normalizeOllamaLaunchHandoff(msg.handoff || {});
      await providerManager.updateProvider(handoff.providerId, handoff.config);
      await providerManager.setActive(handoff.providerId);
      return {
        ok: true,
        providerId: handoff.providerId,
        model: handoff.model,
        baseUrl: handoff.baseUrl,
        contextWindow: handoff.contextWindow,
      };
    }

    case 'test_provider': {
      return await providerManager.testProvider(msg.providerId);
    }

    case 'test_vision_provider': {
      return await providerManager.testVisionProvider();
    }

    case 'test_transcription_provider': {
      return await providerManager.testTranscriptionProvider();
    }

    case 'test_image_gen_provider': {
      return await testImageGenProvider();
    }

    case 'test_system_one': {
      await strictSecretModeReady;
      try {
        const result = await agent.evaluateSystemOne(null, createSystemOneJudge({ maxRetries: 0 }), {
          apiKey: msg.apiKey, state: { color: 'blue' },
          questions: { test: { type: 'noul', instructions: 'Is the color blue?' } },
        });
        return { success: true, model: result.model };
      } catch (error) { return { success: false, error: error.message }; }
    }

    case 'test_capsolver_balance': {
      try {
        const key = String(msg.apiKey || '').trim();
        if (!key) return { ok: false, error: 'No API key provided' };
        const res = await capsolverGetBalance(key);
        return { ok: true, balance: res.balance, packages: res.packages };
      } catch (e) {
        return { ok: false, error: e.message };
      }
    }

    case 'chrome_web_store_oauth_start': {
      try {
        await startChromeWebStoreOAuth(msg.config || {});
        return { ok: true };
      } catch (e) {
        return { ok: false, error: e.message };
      }
    }
    case 'chrome_web_store_oauth_status': {
      return { ok: true, ...(await getChromeWebStoreOAuthStatus()) };
    }
    case 'chrome_web_store_oauth_signout': {
      await signOutChromeWebStoreOAuth();
      return { ok: true };
    }

    case 'list_provider_models': {
      return await providerManager.listProviderModels(msg.providerId);
    }

    case 'list_ollama_models': {
      return await providerManager.listProviderModels(msg.providerId);
    }

    case 'detect_provider_context_window': {
      return await providerManager.detectProviderContextWindow(msg.providerId, msg.model);
    }

    // ── Claude Pro/Max OAuth ─────────────────────────────────────────
    // OAuth flow runs in the background script so the
    // browser.tabs.onUpdated listener stays alive even if the user
    // navigates away from settings mid-flow. Lazy-refresh on every
    // chat call (in AnthropicOAuthProvider) makes a proactive alarm
    // unnecessary, which keeps us off the `alarms` permission and
    // avoids a re-permission prompt at update.
    case 'claude_oauth_start': {
      try {
        await startClaudeOAuth();
        return { ok: true };
      } catch (e) {
        return { ok: false, error: e.message };
      }
    }
    case 'claude_oauth_signout': {
      await signOutClaude();
      return { ok: true };
    }
    case 'claude_oauth_status': {
      return await getClaudeOAuthStatus();
    }
    case 'claude_oauth_test': {
      try {
        await refreshClaudeAccessToken();
        return { ok: true };
      } catch (e) {
        return { ok: false, error: e.message };
      }
    }

    case 'start_tab_recording':
    case 'stop_tab_recording':
      return { ok: false, error: 'Tab recording is not supported in Firefox. This feature requires Chrome\'s tabCapture and OffscreenDocument APIs.' };
    case 'get_recording_state':
      return { ok: true, state: { recording: false, supported: false } };

    case 'capture_viewport_screenshot': {
      const tabId = msg.tabId || sender.tab?.id;
      return await agent.captureViewportScreenshotForUser(tabId);
    }
    case 'ocr_pdf_page': {
      const tabId = Number(msg.tabId);
      if (!Number.isInteger(tabId) || tabId < 0) {
        return { success: false, error: 'Invalid PDF OCR tab.' };
      }
      if (!isPdfHandlerSender(sender, tabId)) {
        return { success: false, error: 'Invalid PDF OCR sender.' };
      }
      const tab = await browser.tabs.get(tabId).catch(() => null);
      if (!tab) return { success: false, error: 'The PDF tab is no longer available.' };
      const requestId = String(msg.requestId || '').trim();
      const controller = new AbortController();
      if (requestId) pdfOcrRequests.set(requestId, controller);
      try {
        return await agent.ocrPdfPageWithVision(tabId, msg.imageDataUrl, msg.pageNumber, controller.signal);
      } finally {
        if (requestId && pdfOcrRequests.get(requestId) === controller) pdfOcrRequests.delete(requestId);
      }
    }
    case 'cancel_pdf_ocr': {
      const requestId = String(msg.requestId || '').trim();
      const controller = pdfOcrRequests.get(requestId);
      if (!controller) return { ok: false, error: 'The PDF OCR request is no longer active.' };
      const reason = new Error('PDF OCR cancelled by the user.');
      reason.code = 'pdf_ocr_cancelled';
      controller.abort(reason);
      return { ok: true };
    }
    case 'fetch_pdf_document': {
      const tabId = Number(msg.tabId);
      const url = safeOnlinePdfUrl(msg.url);
      if (!Number.isInteger(tabId) || tabId < 0 || !url) {
        return { ok: false, error: 'Invalid Firefox PDF viewer request.' };
      }
      if (!isPdfHandlerSender(sender, tabId)) {
        return { ok: false, error: 'Invalid Firefox PDF viewer sender.' };
      }
      const tab = await browser.tabs.get(tabId).catch(() => null);
      if (!tab) return { ok: false, error: 'The PDF tab is no longer available.' };
      try {
        return await fetchPdfDocumentForViewer(url);
      } catch (error) {
        return { ok: false, error: error?.message || String(error) };
      }
    }
    case 'capture_screenshot_redaction_snapshot': {
      const tabId = msg.tabId || sender.tab?.id;
      return await agent.captureScreenshotRedactionSnapshotForUser(tabId, {
        coordinateSpace: msg.coordinateSpace,
      });
    }

    case 'get_page_info': {
      const tabId = msg.tabId || sender.tab?.id;
      try {
        return await browser.tabs.sendMessage(tabId, {
          target: 'content',
          action: 'get_page_info',
        });
      } catch {
        await agent._injectCoreContentScripts(tabId);
        return await browser.tabs.sendMessage(tabId, {
          target: 'content',
          action: 'get_page_info',
        });
      }
    }

    default:
      throw new Error(`Unknown action: ${msg.action}`);
  }
}

// --- Keyboard shortcuts (browser.commands) ---
// Firefox requires a "commands" manifest entry for browser-level keyboard shortcuts
// to work. Custom commands fire here in the background script; we dispatch them via
// storage.onChanged so the side panel (and any other extension page) can react
// reliably — runtime.sendMessage can miss a sidepanel that isn't fully loaded.
let uiScaleCommandQueue = Promise.resolve();
browser.commands.onCommand.addListener(async (command, tab) => {
  // _execute_sidebar_action is handled natively by Firefox — no need to forward
  if (command === '_execute_sidebar_action') return;
  const scaleAction = uiScaleCommandAction(command);
  if (scaleAction) {
    uiScaleCommandQueue = uiScaleCommandQueue.then(async () => {
      const current = await loadUiScale(browser.storage.local);
      await saveUiScale(browser.storage.local, nextUiScale(current, scaleAction));
    }).catch((error) => {
      console.error('[WebBrain] failed to update UI scale:', command, error);
    });
    await uiScaleCommandQueue;
    return;
  }
  const envelope = shortcutCommandEnvelope(command, tab);
  if (!envelope) return;
  try {
    await browser.storage.local.set({ [SHORTCUT_COMMAND_STORAGE_KEY]: envelope });
  } catch (err) {
    console.error('[WebBrain] failed to dispatch command:', command, err);
  }
});

// Connection controls belong only to the packaged Settings page, never a tab.
browser.runtime.onMessage.addListener((message, sender) => {
  if (message?.type !== 'WB_BIDI_CONNECT' && message?.type !== 'WB_BIDI_DISCONNECT') return;
  if (sender.id !== browser.runtime.id || sender.url !== browser.runtime.getURL('src/ui/settings.html')) return;
  if (message.type === 'WB_BIDI_DISCONNECT') { firefoxBidi.disconnect(); return Promise.resolve({ success: true }); }
  return firefoxBidi.connect().then(() => ({ success: true }), error => ({ success: false, error: error.message }));
});
browser.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && ['firefoxBidiEnabled', 'firefoxBidiPort'].some(key => changes[key] && changes[key].oldValue !== changes[key].newValue)) firefoxBidi.disconnect();
});
