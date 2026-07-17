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
  refreshBuiltInSkillRecord,
} from './agent/skills.js';
import { ScheduledJobManager } from './agent/scheduler.js';
import {
  startClaudeOAuth,
  refreshClaudeAccessToken,
  signOutClaude,
  getClaudeOAuthStatus,
} from './providers/oauth-claude.js';
import { getBalance as capsolverGetBalance } from './agent/captcha-solver.js';
import {
  SELECTION_TRANSLATION_LANGUAGES,
  buildContextMenuPrompt,
  buildSelectionPrompt,
  createContextMenuStorage,
} from './context-menu-storage.js';
import { normalizeOllamaLaunchHandoff } from './ollama-handoff.js';
import { RunUiJournal } from './run-ui-journal.js';
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
import {
  CONFIG_STORAGE_KEYS,
  createConfigExport,
  parseConfigImport,
} from './config-transfer.js';
import { RUN_CAPTURE_START_ERROR_PREFIX, createRunCaptureController } from './run-capture.js';

/**
 * WebBrain Background Script (Firefox)
 * Routes messages between sidebar, content scripts, and the agent.
 */

const providerManager = new ProviderManager();
const agent = new Agent(providerManager);
const userMemoryStore = createUserMemoryStore(browser.storage.local);
const profileSync = new ProfileSyncManager(browser.storage.local);
const runCaptureController = createRunCaptureController({
  api: browser,
  unsupportedRecordingMessage: 'Tab recording is not supported in Firefox.',
});
const scheduler = new ScheduledJobManager({
  api: browser,
  agent,
  loadProviders: async () => {
    await customSkillsReady;
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
  },
  showIndicator: (tabId) => sendIndicatorMessage(tabId, 'WB_SHOW_AGENT_INDICATORS'),
  hideIndicator: (tabId) => sendIndicatorMessage(tabId, 'WB_HIDE_AGENT_INDICATORS'),
});
agent.setScheduler(scheduler);
scheduler.start();

const MAX_AGENT_STEPS_DEFAULT = 130;
const MAX_AGENT_STEPS_UNLIMITED_SENTINEL = 200;
const CONTEXT_MENU_ASK_SELECTION_ID = 'webbrain-ask-selection';
const CONTEXT_MENU_OPEN_CHAT_ID = 'webbrain-selection-open-chat';
const CONTEXT_MENU_ACTION_PREFIX = 'webbrain-selection-action-';
const CONTEXT_MENU_TRANSLATE_ID = 'webbrain-selection-translate';
const CONTEXT_MENU_TRANSLATE_PREFIX = 'webbrain-selection-translate-';
const CONTEXT_MENU_GENERIC_ASK_ID = 'webbrain-selection-generic-ask';

function getContextMenuApi() {
  return browser.contextMenus || browser.menus || null;
}

function getContextMenuPromptStore() {
  return browser.storage?.session || browser.storage?.local || null;
}

const contextMenuStorage = createContextMenuStorage(getContextMenuPromptStore);

function createContextMenus() {
  const api = getContextMenuApi();
  if (!api?.create) return;

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
      title: 'Ask WebBrain about this',
      contexts: ['selection'],
    });
    createItem({ id: CONTEXT_MENU_OPEN_CHAT_ID, parentId: CONTEXT_MENU_ASK_SELECTION_ID, title: 'Open sidebar to chat', contexts: ['selection'] });
    createItem({ id: 'webbrain-selection-separator-1', parentId: CONTEXT_MENU_ASK_SELECTION_ID, type: 'separator', contexts: ['selection'] });
    for (const [action, title] of [
      ['summarize', 'Summarize'],
      ['explain', 'Explain'],
      ['quiz', 'Quiz me'],
      ['proofread', 'Proofread'],
    ]) {
      createItem({ id: `${CONTEXT_MENU_ACTION_PREFIX}${action}`, parentId: CONTEXT_MENU_ASK_SELECTION_ID, title, contexts: ['selection'] });
    }
    createItem({ id: CONTEXT_MENU_TRANSLATE_ID, parentId: CONTEXT_MENU_ASK_SELECTION_ID, title: 'Translate to', contexts: ['selection'] });
    for (const [code, title] of Object.entries(SELECTION_TRANSLATION_LANGUAGES)) {
      createItem({ id: `${CONTEXT_MENU_TRANSLATE_PREFIX}${code}`, parentId: CONTEXT_MENU_TRANSLATE_ID, title, contexts: ['selection'] });
    }
    createItem({ id: 'webbrain-selection-separator-2', parentId: CONTEXT_MENU_ASK_SELECTION_ID, type: 'separator', contexts: ['selection'] });
    createItem({ id: CONTEXT_MENU_GENERIC_ASK_ID, parentId: CONTEXT_MENU_ASK_SELECTION_ID, title: 'Ask about this', contexts: ['selection'] });
  };

  try {
    Promise.resolve(api.removeAll())
      .catch(() => {})
      .then(create);
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

async function loadStrictSecretMode() {
  const stored = await browser.storage.local.get('strictSecretMode');
  if (stored.strictSecretMode != null) agent.strictSecretMode = !!stored.strictSecretMode;
}
loadStrictSecretMode();

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
  const stored = await browser.storage.local.get([
    USER_MEMORY_ENABLED_KEY,
    USER_MEMORY_AUTO_CAPTURE_KEY,
  ]);
  return stored[USER_MEMORY_ENABLED_KEY] !== false
    && stored[USER_MEMORY_AUTO_CAPTURE_KEY] === true;
}

async function isUserMemoryFormCaptureEnabled() {
  const stored = await browser.storage.local.get(USER_MEMORY_FORM_CAPTURE_KEY);
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
        if (applied.changed) await syncAgentUserMemoryFromStorage();
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
  ]);
  let skills = normalizeCustomSkills(stored[CUSTOM_SKILLS_STORAGE_KEY]);
  const removedDefaultIds = new Set(normalizeDefaultSkillRemovalIds(stored[DEFAULT_SKILLS_REMOVED_STORAGE_KEY]));
  try {
    const existingIds = new Set(skills.map((skill) => skill.id));
    const room = Math.max(0, MAX_CUSTOM_SKILLS - skills.length);
    const defaultSkills = (await loadDefaultSkillRecords())
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

// CapSolver opt-in. API key itself is read at solve time so rotating
// keys via Settings doesn't need a restart.
async function loadCaptchaSolver() {
  const stored = await browser.storage.local.get('captchaSolverEnabled');
  if (stored.captchaSolverEnabled != null) {
    agent.captchaSolverEnabled = !!stored.captchaSolverEnabled;
  }
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
  createContextMenus();
  await providerManager.load();
  await loadMaxSteps();
  await loadClarifyTimeout();
  await loadAutoScreenshot();
  await syncAgentUserMemoryFromStorage().catch(() => {});
  scheduleUserMemoryExtractionDrain(5000);
  console.log('[WebBrain] Extension installed, providers loaded.');
});

browser.runtime.onStartup?.addListener?.(() => {
  createContextMenus();
  syncAgentUserMemoryFromStorage().catch(() => {});
  scheduleUserMemoryExtractionDrain(5000);
});

// Listen for setting changes
browser.storage.onChanged.addListener((changes) => {
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
  if (changes.useSiteAdapters) {
    agent.useSiteAdapters = changes.useSiteAdapters.newValue;
    refreshPrompts = true;
  }
  if (changes[API_MUTATION_OBSERVER_KEY]) {
    setApiMutationObserverEnabled(changes[API_MUTATION_OBSERVER_KEY].newValue === true);
  }
  if (changes.strictSecretMode) {
    agent.strictSecretMode = !!changes.strictSecretMode.newValue;
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
    agent.customSkills = normalizeCustomSkills(changes[CUSTOM_SKILLS_STORAGE_KEY].newValue);
    refreshPrompts = true;
  }
  if (changes.captchaSolverEnabled) {
    agent.captchaSolverEnabled = !!changes.captchaSolverEnabled.newValue;
    refreshPrompts = true;
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

// ────────────────────────────────────────────────────────────────────────
// Tab grouping (visual scope for a WebBrain session)
//
// Same UX shape as the Chrome build (see src/chrome/src/background.js):
// when the user clicks the browser action, the source tab joins (or
// seeds) a colored "WebBrain" tab group for that window. Agent-spawned
// tabs (new_tab tool, target=_blank redirects) auto-join the same group
// via agent.js's `_addToWebBrainGroup`. The group label is what tells
// the user at a glance "this is part of a WebBrain session".
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
 * Make sure `tab.windowId` has a "WebBrain" group AND that `tab` is in
 * it. Always creates a fresh group rather than rebranding the user's
 * existing group (Option 2 from the Chrome PR — strictly less invasive).
 */
async function ensureWebBrainGroup(tab) {
  if (!browser.tabGroups || !tab?.id || tab.windowId == null) return -1;
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
  if (menuItemId === CONTEXT_MENU_OPEN_CHAT_ID) {
    openSidebarForContextMenu(tab);
    return;
  }

  let text = '';
  if (menuItemId === CONTEXT_MENU_GENERIC_ASK_ID) {
    text = buildContextMenuPrompt(info.selectionText);
  } else if (menuItemId.startsWith(CONTEXT_MENU_ACTION_PREFIX)) {
    text = buildSelectionPrompt(info.selectionText, menuItemId.slice(CONTEXT_MENU_ACTION_PREFIX.length));
  } else if (menuItemId.startsWith(CONTEXT_MENU_TRANSLATE_PREFIX)) {
    text = buildSelectionPrompt(info.selectionText, 'translate', '', menuItemId.slice(CONTEXT_MENU_TRANSLATE_PREFIX.length));
  }
  if (!text) return;

  const payload = {
    id: `ctx-${tab.id}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    tabId: tab.id,
    text,
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

// Firefox does not treat a click in an injected page UI as an authorized
// sidebarAction.open() gesture. Persist and notify the existing sidebar when
// it is open; otherwise startup recovery will consume the prompt after the
// user opens WebBrain manually.
browser.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type !== 'WB_SELECTION_SHORTCUT_SUBMIT') return;
  const tab = sender?.tab;
  const text = buildSelectionPrompt(msg.selectionText, msg.action, msg.question, msg.language);
  if (!tab?.id || !text) {
    sendResponse({ ok: false, queued: false, requiresManualOpen: true, error: 'Invalid selection shortcut request.' });
    return;
  }

  const payload = {
    id: `selection-${tab.id}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    tabId: tab.id,
    text,
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
  browser.storage.session?.remove(`tabChat:${tabId}`).catch(() => {});
  scheduler.cancelForTab(tabId).catch(() => {});
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

browser.webNavigation?.onCommitted?.addListener?.((details) => {
  if (details.frameId === 0) invalidateContextMenuForTab(details.tabId);
});
browser.webNavigation?.onHistoryStateUpdated?.addListener?.((details) => {
  if (details.frameId === 0) invalidateContextMenuForTab(details.tabId);
});
browser.webNavigation?.onReferenceFragmentUpdated?.addListener?.((details) => {
  if (details.frameId === 0) invalidateContextMenuForTab(details.tabId);
});

// Background API call observer (issue #189). Watches XHR/fetch requests the
// page itself fires — e.g. clicking "Next Page" — so the agent can later spot
// a repeated UI action and shortcut to calling the underlying API directly.
// Strict matching only: same tab, exact method/url captured as-is — no
// param-pattern fuzzing yet. Replay material is kept behind opaque ids so CSRF
// tokens and form bodies do not get printed into model context.
const API_REQUESTS_PER_TAB_LIMIT = 40;
const API_MUTATION_OBSERVER_KEY = 'apiMutationObserverEnabled';
const API_MUTATION_OBSERVER_DEFAULT = false;
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
    setApiMutationObserverEnabled(API_MUTATION_OBSERVER_DEFAULT);
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

function sendIndicatorMessage(tabId, type) {
  if (tabId == null || !type) return;
  if (type === 'WB_SHOW_AGENT_INDICATORS') {
    activeIndicatorTabs.add(tabId);
  } else if (type === 'WB_HIDE_AGENT_INDICATORS') {
    activeIndicatorTabs.delete(tabId);
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
  clearRunUiSnapshot(tabId);
});

const RUN_UI_PREFIX = 'runUi:';
const runUiJournal = new RunUiJournal({
  onChange(tabId, snapshot) {
    try { browser.storage.session?.set({ [RUN_UI_PREFIX + tabId]: snapshot }).catch(() => {}); } catch {}
  },
});

function beginRunUiSnapshot(tabId, requestId) {
  return runUiJournal.begin(tabId, requestId);
}

function recordRunUiEvent(tabId, requestId, type, data) {
  return runUiJournal.record(tabId, requestId, type, data, agent.currentRunId.get(tabId));
}

function terminalRunUiStatus(content, updates = [], error = null) {
  if (error) return 'failed';
  const text = String(content || '');
  if (/stopped by user|aborted by user/i.test(text)) return 'stopped';
  if (/before executing requested tool calls/i.test(text)) return 'cancelled';
  if (updates.some(update => update?.type === 'error')) return 'failed';
  return 'completed';
}

function finishRunUiSnapshot(tabId, requestId, status, finalContent = '') {
  return runUiJournal.finish(tabId, requestId, status, finalContent, agent.currentRunId.get(tabId));
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
  runUiJournal.clear(tabId);
  try { browser.storage.session?.remove(RUN_UI_PREFIX + tabId).catch(() => {}); } catch {}
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
  if (agent.activeRunState(tabId)?.running) {
    throw new Error('A run is already active for this tab.');
  }
}

function sendAgentRunComplete(tabId, snapshot = null) {
  if (tabId == null || !snapshot) return;
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
    },
  }).catch(() => {});
}

// Stop button on the page → abort the agent run for that tab. Mirrors
// the sidepanel's Stop button.
browser.runtime.onMessage.addListener((msg, sender) => {
  if (msg?.type !== 'WB_STOP_AGENT') return; // not ours
  const tabId = sender?.tab?.id;
  if (tabId != null) {
    try { agent.abort(tabId); } catch { /* ignore */ }
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
  if (providerManager.providers.size === 0) {
    await providerManager.load();
  }
  // Hydrate agent toggles and prompt add-ons once at boot (not per message);
  // onChanged keeps them in sync afterward.
  await Promise.all([planBeforeActReady, planReviewReady, customSkillsReady, userMemoryReady]);
  await screenshotRedactionReady;

  switch (msg.action) {
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
      const settings = await browser.storage.local.get([
        USER_MEMORY_ENABLED_KEY,
        USER_MEMORY_AUTO_CAPTURE_KEY,
        USER_MEMORY_FORM_CAPTURE_KEY,
        USER_MEMORY_MAX_PROMPT_CHARS_KEY,
      ]);
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

    case 'ensure_conversation_id': {
      const tabId = msg.tabId || sender.tab?.id;
      if (!tabId) throw new Error('No tab ID');
      return {
        ok: true,
        conversationId: await agent.ensureConversationId(tabId, msg.mode || 'ask'),
      };
    }

    case 'chat': {
      const tabId = msg.tabId || sender.tab?.id;
      if (!tabId) throw new Error('No tab ID');
      assertNoActiveTabRun(tabId);
      const mode = msg.mode || 'ask';
      const runUi = beginRunUiSnapshot(tabId, msg.requestId);

      if (msg.apiMutationsAllowed) agent.setApiMutationsAllowed(tabId, true);

      sendIndicatorMessage(tabId, 'WB_SHOW_AGENT_INDICATORS');

      const updates = [];
      let userMemoryTurnContextTaken = false;
      let runCaptureState = null;
      let result = '';
      let runError = null;
      try {
        // Capture belongs to the background run lifecycle so it survives the
        // sidebar closing or reloading while the agent is still working.
        runCaptureState = await runCaptureController.start(msg.runCapture, tabId);

        // Clear any linked context-menu prompt only after capture preflight
        // succeeds, but before the agent run starts.
        if (msg.contextMenuClear?.tabId != null) {
          await contextMenuStorage.clear(msg.contextMenuClear.tabId, msg.contextMenuClear.promptId);
        }

        const runOptions = msg.recommendedAction ? { recommendedAction: msg.recommendedAction } : {};
        result = await agent.processMessage(tabId, msg.text, (type, data) => {
          updates.push({ type, data });
          sendAgentUpdate(tabId, runUi.requestId, type, data);
        }, mode, msg.attachments, runOptions);

        const userMemoryPayload = takeUserMemoryTurnExtractionPayload(tabId, {
          userText: msg.text,
          assistantText: result,
          mode,
          succeeded: !updates.some((update) => update?.type === 'error'),
        });
        userMemoryPayload.conversationId = await agent.getConversationId(tabId);
        userMemoryTurnContextTaken = true;
        enqueueUserMemoryExtractionAfterTurn(userMemoryPayload);
        return { content: result, updates, requestId: runUi.requestId, conversationId: await agent.getConversationId(tabId) };
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
          const snapshot = finishRunUiSnapshot(tabId, runUi.requestId, terminalRunUiStatus(result, updates, runError), result || (runError ? `Error: ${runError.message}` : ''));
          sendAgentRunComplete(tabId, snapshot);
        }
        sendIndicatorMessage(tabId, 'WB_HIDE_AGENT_INDICATORS');
      }
    }

    case 'chat_stream': {
      const tabId = msg.tabId || sender.tab?.id;
      if (!tabId) throw new Error('No tab ID');
      assertNoActiveTabRun(tabId);
      const mode = msg.mode || 'ask';
      const runUi = beginRunUiSnapshot(tabId, msg.requestId);

      if (msg.apiMutationsAllowed) agent.setApiMutationsAllowed(tabId, true);

      sendIndicatorMessage(tabId, 'WB_SHOW_AGENT_INDICATORS');
      let userMemoryTurnContextTaken = false;
      let userMemoryTurnHadError = false;
      let result = '';
      let runError = null;
      try {
        const runOptions = msg.recommendedAction ? { recommendedAction: msg.recommendedAction } : {};
        result = await agent.processMessageStream(tabId, msg.text, (type, data) => {
          if (type === 'error') userMemoryTurnHadError = true;
          sendAgentUpdate(tabId, runUi.requestId, type, data);
        }, mode, runOptions);

        const userMemoryPayload = takeUserMemoryTurnExtractionPayload(tabId, {
          userText: msg.text,
          assistantText: result,
          mode,
          succeeded: !userMemoryTurnHadError,
        });
        userMemoryPayload.conversationId = await agent.getConversationId(tabId);
        userMemoryTurnContextTaken = true;
        enqueueUserMemoryExtractionAfterTurn(userMemoryPayload);
        return { content: result, requestId: runUi.requestId, conversationId: await agent.getConversationId(tabId) };
      } catch (error) {
        runError = error;
        throw error;
      } finally {
        if (!userMemoryTurnContextTaken) clearUserMemoryTurnContext(tabId);
        const snapshot = finishRunUiSnapshot(tabId, runUi.requestId, terminalRunUiStatus(result, userMemoryTurnHadError ? [{ type: 'error' }] : [], runError), result || (runError ? `Error: ${runError.message}` : ''));
        sendAgentRunComplete(tabId, snapshot);
        sendIndicatorMessage(tabId, 'WB_HIDE_AGENT_INDICATORS');
      }
    }

    case 'continue': {
      const tabId = msg.tabId || sender.tab?.id;
      if (!tabId) throw new Error('No tab ID');
      assertNoActiveTabRun(tabId);
      const mode = msg.mode || 'ask';
      const runUi = beginRunUiSnapshot(tabId, msg.requestId);

      sendIndicatorMessage(tabId, 'WB_SHOW_AGENT_INDICATORS');
      let userMemoryTurnContextTaken = false;
      let userMemoryTurnHadError = false;
      let result = '';
      let runError = null;
      try {
        result = await agent.continueProcessing(tabId, (type, data) => {
          if (type === 'error') userMemoryTurnHadError = true;
          sendAgentUpdate(tabId, runUi.requestId, type, data);
        }, mode);

        const userMemoryPayload = takeUserMemoryTurnExtractionPayload(tabId, {
          userText: 'Please continue from where you left off.',
          assistantText: result,
          mode,
          succeeded: !userMemoryTurnHadError,
        });
        userMemoryPayload.conversationId = await agent.getConversationId(tabId);
        userMemoryTurnContextTaken = true;
        enqueueUserMemoryExtractionAfterTurn(userMemoryPayload);
        return { content: result, requestId: runUi.requestId, conversationId: await agent.getConversationId(tabId) };
      } catch (error) {
        runError = error;
        throw error;
      } finally {
        if (!userMemoryTurnContextTaken) clearUserMemoryTurnContext(tabId);
        const snapshot = finishRunUiSnapshot(tabId, runUi.requestId, terminalRunUiStatus(result, userMemoryTurnHadError ? [{ type: 'error' }] : [], runError), result || (runError ? `Error: ${runError.message}` : ''));
        sendAgentRunComplete(tabId, snapshot);
        sendIndicatorMessage(tabId, 'WB_HIDE_AGENT_INDICATORS');
      }
    }

    case 'clear_conversation': {
      const tabId = msg.tabId || sender.tab?.id;
      if (tabId) {
        const conversationId = await agent.getConversationId(tabId);
        await scheduler.cancelForConversation(tabId, conversationId);
        agent.clearConversation(tabId);
        clearRunUiSnapshot(tabId);
      }
      return { ok: true };
    }

    case 'compact_conversation': {
      const tabId = msg.tabId || sender.tab?.id;
      if (!tabId) return { ok: false, error: 'No tab ID' };
      return { ok: true, ...(await agent.compactConversation(tabId)) };
    }

    case 'abort': {
      const tabId = msg.tabId || sender.tab?.id;
      if (tabId) agent.abort(tabId);
      return { ok: true };
    }

    case 'agent_run_state': {
      const tabId = msg.tabId || sender.tab?.id;
      if (!tabId) return { ok: false, error: 'No tab ID' };
      return { ok: true, ...agent.activeRunState(tabId), runUi: await getRunUiSnapshot(tabId) };
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

    case 'import_config': {
      const imported = parseConfigImport(msg.json);
      await browser.storage.local.set(imported.settings);
      await providerManager.load();
      await Promise.all([
        loadMaxSteps(),
        loadClarifyTimeout(),
        loadAutoScreenshot(),
        loadSiteAdapters(),
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
        settingCount: CONFIG_STORAGE_KEYS.length,
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

    case 'clear_context_menu_prompt': {
      const tabId = msg.tabId || sender.tab?.id;
      return await contextMenuStorage.clear(tabId, msg.promptId);
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

    case 'get_page_info': {
      const tabId = msg.tabId || sender.tab?.id;
      try {
        return await browser.tabs.sendMessage(tabId, {
          target: 'content',
          action: 'get_page_info',
        });
      } catch {
        await browser.tabs.executeScript(tabId, {
          file: 'src/content/accessibility-tree.js',
        });
        await browser.tabs.executeScript(tabId, {
          file: 'src/content/content.js',
        });
        await browser.tabs.executeScript(tabId, {
          file: 'src/content/agent-visual-indicator.js',
        });
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
