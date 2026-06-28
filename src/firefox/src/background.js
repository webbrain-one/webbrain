import { ProviderManager } from './providers/manager.js';
import { Agent } from './agent/agent.js';
import { ScheduledJobManager } from './agent/scheduler.js';
import {
  startClaudeOAuth,
  refreshClaudeAccessToken,
  signOutClaude,
  getClaudeOAuthStatus,
} from './providers/oauth-claude.js';
import { getBalance as capsolverGetBalance } from './agent/captcha-solver.js';
import { buildContextMenuPrompt, createContextMenuStorage } from './context-menu-storage.js';

/**
 * WebBrain Background Script (Firefox)
 * Routes messages between sidebar, content scripts, and the agent.
 */

const providerManager = new ProviderManager();
const agent = new Agent(providerManager);
const scheduler = new ScheduledJobManager({
  api: browser,
  agent,
  loadProviders: async () => {
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

  const create = () => {
    try {
      const result = api.create({
        id: CONTEXT_MENU_ASK_SELECTION_ID,
        title: 'Ask WebBrain about this',
        contexts: ['selection'],
      });
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

  try {
    Promise.resolve(api.remove(CONTEXT_MENU_ASK_SELECTION_ID))
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
  return 'off';
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
// Hydrate once at SW boot. handleMessage awaits this promise so the first chat
// can't race ahead of hydration, but it does NOT re-read storage per message —
// the storage.onChanged listener below keeps the planner mode in sync. (#5)
const planBeforeActReady = loadPlanBeforeAct();

// Initialize on install
browser.runtime.onInstalled.addListener(async () => {
  createContextMenus();
  await providerManager.load();
  await loadMaxSteps();
  await loadAutoScreenshot();
  console.log('[WebBrain] Extension installed, providers loaded.');
});

browser.runtime.onStartup?.addListener?.(() => {
  createContextMenus();
});

// Listen for setting changes
browser.storage.onChanged.addListener((changes) => {
  if (changes.maxAgentSteps) {
    agent.maxSteps = normalizeMaxAgentSteps(changes.maxAgentSteps.newValue);
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
    // The setting only flips the `done` tool description and the credential
    // note text — both rebuild at turn-start, so no system-prompt refresh.
  }
  if (changes.profileEnabled) {
    agent.profileEnabled = !!changes.profileEnabled.newValue;
    refreshPrompts = true;
  }
  if (changes.profileText) {
    agent.profileText = changes.profileText.newValue || '';
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
  if (info?.menuItemId !== CONTEXT_MENU_ASK_SELECTION_ID || !tab?.id) return;
  const text = buildContextMenuPrompt(info.selectionText);
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
  clearTimeout(pendingContextMenuNotifications.get(tabId));
  pendingContextMenuNotifications.delete(tabId);
  contextMenuStorage.cleanup(tabId);
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
});

function sendAgentRunComplete(tabId) {
  if (tabId == null) return;
  browser.runtime.sendMessage({
    target: 'sidepanel',
    action: 'agent_update',
    tabId,
    type: 'run_complete',
    data: {},
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
  // Hydrate planBeforeAct once at boot (not per message); onChanged keeps it
  // in sync afterward.
  await planBeforeActReady;

  switch (msg.action) {
    case 'chat': {
      const tabId = msg.tabId || sender.tab?.id;
      if (!tabId) throw new Error('No tab ID');
      const mode = msg.mode || 'ask';

      if (msg.apiMutationsAllowed) agent.setApiMutationsAllowed(tabId, true);

      sendIndicatorMessage(tabId, 'WB_SHOW_AGENT_INDICATORS');

      // Clear any linked context-menu prompt from storage here — after the
      // background has received the message (so a pre-acceptance crash leaves
      // the prompt recoverable) but before the agent run starts (so a
      // mid-run panel close does not replay the prompt on reopen).
      if (msg.contextMenuClear?.tabId != null) {
        await contextMenuStorage.clear(msg.contextMenuClear.tabId, msg.contextMenuClear.promptId);
      }

      const updates = [];
      try {
        const result = await agent.processMessage(tabId, msg.text, (type, data) => {
          updates.push({ type, data });
          browser.runtime.sendMessage({
            target: 'sidepanel',
            action: 'agent_update',
            tabId,          // see sidepanel onMessage — filters out cross-tab leak
            type,
            data,
          }).catch(() => {});
        }, mode);

        return { content: result, updates };
      } finally {
        sendAgentRunComplete(tabId);
        sendIndicatorMessage(tabId, 'WB_HIDE_AGENT_INDICATORS');
      }
    }

    case 'chat_stream': {
      const tabId = msg.tabId || sender.tab?.id;
      if (!tabId) throw new Error('No tab ID');
      const mode = msg.mode || 'ask';

      if (msg.apiMutationsAllowed) agent.setApiMutationsAllowed(tabId, true);

      sendIndicatorMessage(tabId, 'WB_SHOW_AGENT_INDICATORS');
      try {
        const result = await agent.processMessageStream(tabId, msg.text, (type, data) => {
          browser.runtime.sendMessage({
            target: 'sidepanel',
            action: 'agent_update',
            tabId,          // see sidepanel onMessage — filters out cross-tab leak
            type,
            data,
          }).catch(() => {});
        }, mode);

        return { content: result };
      } finally {
        sendAgentRunComplete(tabId);
        sendIndicatorMessage(tabId, 'WB_HIDE_AGENT_INDICATORS');
      }
    }

    case 'continue': {
      const tabId = msg.tabId || sender.tab?.id;
      if (!tabId) throw new Error('No tab ID');
      const mode = msg.mode || 'ask';

      sendIndicatorMessage(tabId, 'WB_SHOW_AGENT_INDICATORS');
      try {
        const result = await agent.continueProcessing(tabId, (type, data) => {
          browser.runtime.sendMessage({
            target: 'sidepanel',
            action: 'agent_update',
            tabId,          // see sidepanel onMessage — filters out cross-tab leak
            type,
            data,
          }).catch(() => {});
        }, mode);

        return { content: result };
      } finally {
        sendAgentRunComplete(tabId);
        sendIndicatorMessage(tabId, 'WB_HIDE_AGENT_INDICATORS');
      }
    }

    case 'clear_conversation': {
      const tabId = msg.tabId || sender.tab?.id;
      if (tabId) {
        const conversationId = await agent.getConversationId(tabId);
        await scheduler.cancelForConversation(tabId, conversationId);
        agent.clearConversation(tabId);
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

    case 'get_scratchpad': {
      const tabId = msg.tabId || sender.tab?.id;
      if (!tabId) return { ok: false, error: 'No tab ID' };
      return { ok: true, ...(await agent.getScratchpad(tabId)) };
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
      const matched = agent.submitClarifyResponse(tabId, clarifyId, answer, msg.source || 'user');
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

    case 'set_active_provider': {
      await providerManager.setActive(msg.providerId);
      return { ok: true };
    }

    case 'update_provider': {
      await providerManager.updateProvider(msg.providerId, msg.config);
      return { ok: true };
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
