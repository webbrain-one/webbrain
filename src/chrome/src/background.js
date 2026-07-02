import { ProviderManager } from './providers/manager.js';
import { Agent } from './agent/agent.js';
import {
  CUSTOM_SKILLS_STORAGE_KEY,
  DEFAULT_SKILL_SOURCES,
  DEFAULT_SKILLS_REMOVED_STORAGE_KEY,
  DEFAULT_SKILLS_SEEDED_STORAGE_KEY,
  MAX_CUSTOM_SKILLS,
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
import { buildContextMenuPrompt, createContextMenuStorage } from './context-menu-storage.js';
// (ensureOffscreen + transcribeAudio used to be imported here; both are
// now consumed inside src/recorder/host.js, which background.js calls into.)
import {
  startTabRecording,
  stopTabRecording,
  getRecordingStateFresh,
  setProviderManager as setRecorderProviderManager,
} from './recorder/host.js';

/**
 * WebBrain Service Worker (Background Script)
 * Routes messages between side panel, content scripts, and the agent.
 */

const providerManager = new ProviderManager();
const agent = new Agent(providerManager);
const scheduler = new ScheduledJobManager({
  api: chrome,
  agent,
  loadProviders: async () => {
    await customSkillsReady;
    if (providerManager.providers.size === 0) await providerManager.load();
  },
  sendUpdate: (tabId, type, data) => {
    chrome.runtime.sendMessage({
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

// Wire the recorder to our provider manager so its transcription path
// can look up the user's configured Whisper-compatible provider. Must
// happen AFTER providerManager is constructed.
setRecorderProviderManager(providerManager);

const MAX_AGENT_STEPS_DEFAULT = 130;
const MAX_AGENT_STEPS_UNLIMITED_SENTINEL = 200;
const CONTEXT_MENU_ASK_SELECTION_ID = 'webbrain-ask-selection';

function getContextMenuPromptStore() {
  return chrome.storage?.session || chrome.storage?.local || null;
}

const contextMenuStorage = createContextMenuStorage(getContextMenuPromptStore);

function createContextMenus() {
  if (!chrome.contextMenus?.create) return;
  chrome.contextMenus.remove(CONTEXT_MENU_ASK_SELECTION_ID, () => {
    // Nonexistent menu IDs set lastError; that is expected on first install.
    void chrome.runtime.lastError;
    chrome.contextMenus.create({
      id: CONTEXT_MENU_ASK_SELECTION_ID,
      title: 'Ask WebBrain about this',
      contexts: ['selection'],
    }, () => {
      const err = chrome.runtime.lastError;
      if (err && !/duplicate/i.test(String(err.message || err))) {
        console.warn('[WebBrain] Failed to create context menu:', err.message || err);
      }
    });
  });
}

function normalizeMaxAgentSteps(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return MAX_AGENT_STEPS_DEFAULT;
  if (n === 0 || n >= MAX_AGENT_STEPS_UNLIMITED_SENTINEL) return Infinity;
  return n >= 5 ? Math.floor(n) : MAX_AGENT_STEPS_DEFAULT;
}

// Load maxSteps setting
async function loadMaxSteps() {
  const stored = await chrome.storage.local.get('maxAgentSteps');
  agent.maxSteps = normalizeMaxAgentSteps(stored.maxAgentSteps);
  if (Number(stored.maxAgentSteps) >= MAX_AGENT_STEPS_UNLIMITED_SENTINEL) {
    await chrome.storage.local.set({ maxAgentSteps: 0 });
  }
}
loadMaxSteps();

async function loadAutoScreenshot() {
  const stored = await chrome.storage.local.get('autoScreenshot');
  if (stored.autoScreenshot != null) agent.autoScreenshot = stored.autoScreenshot;
}
loadAutoScreenshot();

async function loadSiteAdapters() {
  const stored = await chrome.storage.local.get('useSiteAdapters');
  if (stored.useSiteAdapters != null) agent.useSiteAdapters = stored.useSiteAdapters;
}
loadSiteAdapters();

async function loadStrictSecretMode() {
  const stored = await chrome.storage.local.get('strictSecretMode');
  if (stored.strictSecretMode != null) agent.strictSecretMode = !!stored.strictSecretMode;
}
loadStrictSecretMode();

// Profile auto-fill: user-provided text (name, email, etc.) that gets
// appended to the system prompt when enabled. Plaintext in storage —
// security warning lives in the settings UI.
async function loadProfile() {
  const stored = await chrome.storage.local.get(['profileEnabled', 'profileText']);
  if (stored.profileEnabled != null) agent.profileEnabled = !!stored.profileEnabled;
  if (typeof stored.profileText === 'string') agent.profileText = stored.profileText;
  // No need to refresh live conversations on initial load — they don't
  // exist yet. Refresh only fires on user-initiated setting changes below.
}
loadProfile();

async function loadDefaultSkillRecords() {
  const records = [];
  for (const source of DEFAULT_SKILL_SOURCES) {
    const response = await fetch(chrome.runtime.getURL(source.path));
    if (!response.ok) {
      throw new Error(`Default skill ${source.id} failed to load: HTTP ${response.status}`);
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

async function refreshDefaultSkillRecords(skills) {
  const existingBuiltIns = skills.filter((skill) => skill.sourceType === 'built-in');
  if (existingBuiltIns.length === 0) return { skills, changed: false };

  const defaults = new Map((await loadDefaultSkillRecords()).map((skill) => [skill.id, skill]));
  let changed = false;
  const refreshed = skills.map((skill) => {
    const current = defaults.get(skill.id);
    if (!current || skill.sourceType !== 'built-in') return skill;
    const result = refreshBuiltInSkillRecord(skill, current);
    if (result.changed) changed = true;
    return result.skill;
  });
  return { skills: changed ? normalizeCustomSkills(refreshed) : skills, changed };
}

async function loadCustomSkills() {
  const stored = await chrome.storage.local.get([
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
      await chrome.storage.local.set(update);
    }
  } catch (e) {
    console.warn('[WebBrain] Default skills could not be loaded', e);
  }
  try {
    const refreshed = await refreshDefaultSkillRecords(skills);
    if (refreshed.changed) {
      skills = refreshed.skills;
      await chrome.storage.local.set({ [CUSTOM_SKILLS_STORAGE_KEY]: skills });
    }
  } catch (e) {
    console.warn('[WebBrain] Default skills could not be refreshed', e);
  }
  agent.setCustomSkills(skills);
}
const customSkillsReady = loadCustomSkills();

// CapSolver opt-in. We only need the toggle here — the API key is read at
// call time inside the agent's solve_captcha handler so rotating it via
// the settings page is picked up without a restart.
async function loadCaptchaSolver() {
  const stored = await chrome.storage.local.get('captchaSolverEnabled');
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
  const stored = await chrome.storage.local.get(['planBeforeActMode', 'planBeforeAct']);
  applyPlanBeforeActMode(normalizePlanBeforeActMode(stored));
}
// Hydrate once at SW boot. handleMessage awaits this promise so the first chat
// can't race ahead of hydration, but it does NOT re-read storage per message —
// the storage.onChanged listener below keeps the planner mode in sync. (#5)
const planBeforeActReady = loadPlanBeforeAct();

// Initialize on install
chrome.runtime.onInstalled.addListener(async () => {
  createContextMenus();
  await providerManager.load();
  await loadMaxSteps();
  console.log('[WebBrain] Extension installed, providers loaded.');
});

// Also load on startup
chrome.runtime.onStartup?.addListener(async () => {
  createContextMenus();
  await providerManager.load();
  await loadMaxSteps();
});

// Listen for setting changes
chrome.storage.onChanged.addListener((changes) => {
  if (changes.maxAgentSteps) {
    agent.maxSteps = normalizeMaxAgentSteps(changes.maxAgentSteps.newValue);
  }
  if (changes.autoScreenshot) {
    agent.autoScreenshot = changes.autoScreenshot.newValue;
  }
  // Any change that affects the composed system prompt needs to refresh
  // already-open conversations so the next turn sees the update — without
  // wiping the chat history.
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
    // note text — both are rebuilt at turn-start, so no system-prompt
    // refresh is needed. (System prompt content itself doesn't change.)
  }
  if (changes.profileEnabled) {
    agent.profileEnabled = !!changes.profileEnabled.newValue;
    refreshPrompts = true;
  }
  if (changes.profileText) {
    agent.profileText = changes.profileText.newValue || '';
    refreshPrompts = true;
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
  if (refreshPrompts) agent._refreshSystemPrompts();
});

// ────────────────────────────────────────────────────────────────────────
// Side-panel visibility model — Claude-for-Chrome style
//
// We tie the side panel to a per-window "WebBrain" tab group rather than to
// individual tabs. When the user clicks the action, the source tab joins
// (or seeds) a tab group; the panel is enabled only for tabs in that group.
// Switch to any tab outside the group → panel disabled → Chrome hides it.
//
// Why this and not a per-tab Set?
//
// Chrome's `sidePanel.setOptions({enabled: false})` doesn't actively close
// an already-open panel — it only prevents future opens. With a per-tab Set
// the panel was visible on every tab the user had ever clicked the action
// on, which mounted up across a session. Group membership is observable to
// the user (they see the colored group label) and matches the agent's own
// `_addToWebBrainGroup` behaviour for `new_tab` calls — so a sidebar
// session, an explicitly-opened new_tab, and a target=_blank redirect all
// land in the same group.
//
// `panelTabs` survives as a fallback for old Chromes without `tabGroups`
// (pre-89, very rare). On modern Chrome the group map is the source of truth.
// ────────────────────────────────────────────────────────────────────────

// Legacy per-tab fallback (used only if chrome.tabGroups is unavailable).
const panelTabs = new Set();
const PANEL_TABS_KEY = 'panelTabs';

async function loadPanelTabs() {
  try {
    const stored = await chrome.storage.session.get(PANEL_TABS_KEY);
    if (Array.isArray(stored[PANEL_TABS_KEY])) {
      stored[PANEL_TABS_KEY].forEach(id => panelTabs.add(id));
    }
  } catch (e) { /* session storage not available */ }
}
function savePanelTabs() {
  chrome.storage.session?.set({ [PANEL_TABS_KEY]: Array.from(panelTabs) }).catch(() => {});
}
loadPanelTabs();

// (Tab recorder state + Whisper-transcription helpers moved to
// src/recorder/host.js so the agent's prompt-driven tools can share
// the exact same orchestration with the sidepanel button. background.js
// just exposes routes that call into the module.)

// Per-window WebBrain group ID. windowId -> tabGroups groupId.
const webBrainGroupByWindow = new Map();
const WB_GROUPS_KEY = 'webBrainGroupByWindow';

async function loadWebBrainGroups() {
  if (!chrome.tabGroups) return;
  try {
    const stored = await chrome.storage.session.get(WB_GROUPS_KEY);
    const arr = stored[WB_GROUPS_KEY];
    if (Array.isArray(arr)) {
      // Validate each group still exists before re-adopting — Chrome may
      // have closed some between sessions / service-worker restarts.
      for (const [windowId, groupId] of arr) {
        try {
          await chrome.tabGroups.get(groupId);
          webBrainGroupByWindow.set(windowId, groupId);
        } catch { /* group gone, skip */ }
      }
    }
  } catch { /* session storage unavailable */ }
}
function saveWebBrainGroups() {
  chrome.storage.session?.set({
    [WB_GROUPS_KEY]: Array.from(webBrainGroupByWindow.entries()),
  }).catch(() => {});
}
loadWebBrainGroups();

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false }).catch(() => {});

// Panel visibility model — opt-in per tab (Cmd+T no longer leaks the panel).
//
// We deliberately do NOT keep `side_panel.default_path` in the manifest and
// we do NOT proactively call setOptions on tab activation. Both of those
// would re-enable the panel on every tab and recreate the "Cmd+T opens a
// new tab and the running agent's progress paints into it" bug.
//
// Enablement happens only on explicit user/agent intent:
//
//   * `chrome.action.onClicked`  — user clicked the toolbar icon on tab X.
//     The handler fires a fire-and-forget `setOptions({tabId:X, enabled:true})`
//     and `sidePanel.open({tabId:X})` back-to-back to keep the user gesture
//     alive for `open()`.
//   * `agent.new_tab`            — agent created tab Y. The tool handler
//     also calls `setOptions({tabId:Y, enabled:true})` so if the user
//     switches to Y manually, the panel is there.
//
// We do NOT have a "tab left the WebBrain group → disable panel" path,
// even though the WB group is still maintained for visual cohesion. That
// path is exactly what raced with `action.onClicked` in the original
// version: a fresh enable+open pair couldn't beat a recent disable, so
// the first click would silently no-op. Skipping the disable entirely
// avoids the race — the trade-off is that a tab the user manually drags
// out of the WB group keeps its panel until they close it.
//
// Claude's official browser extension uses the same pattern (no
// `default_path`, never disable, only enable on demand). Verified at
// https://docs.google.com/...claude_chrome.sidepanel — short version:
// the race only happens if you actively flip a tab from enabled → disabled
// → enabled. Stay in the no-default + only-enable lane and there is no
// race to fight.

/**
 * Make sure `tab.windowId` has a WebBrain group AND that `tab` is in it.
 * Returns the group ID, or -1 on failure / unsupported. Called from the
 * action.onClicked handler so the sidebar's source tab is always grouped
 * before the user can switch tabs and break visibility.
 */
async function ensureWebBrainGroup(tab) {
  if (!chrome.tabGroups || !tab?.id || tab.windowId == null) return -1;
  try {
    let groupId = webBrainGroupByWindow.get(tab.windowId);

    // Validate the cached group still exists in Chrome (user may have
    // ungrouped it manually, or the service worker restarted with a
    // stale stored ID).
    if (groupId != null) {
      try {
        await chrome.tabGroups.get(groupId);
      } catch {
        groupId = null;
        webBrainGroupByWindow.delete(tab.windowId);
        saveWebBrainGroups();
      }
    }

    if (groupId == null) {
      // Always create a FRESH WebBrain group for this window, even if the
      // source tab is currently in some other (user-owned) group. The
      // earlier behaviour adopted the source's existing group and renamed
      // it to "WebBrain" — surprising for users who had a "Dev" or
      // "Research" group of their own. Calling chrome.tabs.group with no
      // groupId moves the source tab out of any old group into the new
      // one; the user's old group keeps its other tabs untouched.
      groupId = await chrome.tabs.group({ tabIds: [tab.id] });
      try {
        await chrome.tabGroups.update(groupId, {
          title: 'WebBrain', color: 'blue', collapsed: false,
        });
      } catch { /* ignore styling failure */ }
      webBrainGroupByWindow.set(tab.windowId, groupId);
      saveWebBrainGroups();
    } else if (tab.groupId !== groupId) {
      // Group exists for this window but source tab isn't in it. Add it.
      try {
        await chrome.tabs.group({ groupId, tabIds: [tab.id] });
      } catch { /* tab might already be moving; ignore */ }
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
  chrome.runtime.sendMessage(msg).catch(() => {});
  const timerId = setTimeout(() => {
    pendingContextMenuNotifications.delete(tabId);
    chrome.runtime.sendMessage(msg).catch(() => {});
  }, 250);
  pendingContextMenuNotifications.set(tabId, timerId);
}

function openSidePanelForContextMenu(tab) {
  if (!tab?.id) return;
  panelTabs.add(tab.id);
  savePanelTabs();
  chrome.sidePanel.setOptions({
    tabId: tab.id,
    path: 'src/ui/sidepanel.html',
    enabled: true,
  });
  chrome.sidePanel.open({ tabId: tab.id });
  ensureWebBrainGroup(tab).catch(() => {});
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

  // sidePanel.open() must run before the first await in this user gesture.
  // Otherwise Chrome may accept the saved prompt but silently refuse to open
  // the panel, leaving the run visible only after the user opens it manually.
  openSidePanelForContextMenu(tab);
  try {
    await contextMenuStorage.save(tab.id, payload);
  } catch {}
  notifySidePanelOfContextMenuPrompt(payload);
}

chrome.contextMenus?.onClicked?.addListener?.((info, tab) => {
  handleContextMenuAsk(info, tab).catch(() => {});
});

// (See the panel visibility comment above for why we no longer
// pre-disable or re-assert-enable on tab events.)

// ────────────────────────────────────────────────────────────────────────
// Agent visual indicator (content-script bridge)
//
// While an agent run is in flight, we ask the page's content script to
// render a pulsing purple inset glow around the viewport plus a
// "Stop WebBrain" floating button. The chat / chat_stream / continue
// handlers wrap their await with sendIndicatorMessage(tabId, 'SHOW' / 'HIDE').
// agent.js fires HIDE_FOR_TOOL_USE / SHOW_AFTER_TOOL_USE around screenshot
// capture so the agent doesn't see its own border in the pixels it sends
// to the vision model.
// ────────────────────────────────────────────────────────────────────────

/**
 * Tell a tab's content script to show/hide the agent indicator. Best-
 * effort: silently no-ops on chrome:// / chrome-extension:// tabs (no
 * content script there) and on tabs that haven't loaded yet. We don't
 * await — these are decorative and shouldn't block the run.
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
    chrome.tabs.sendMessage(tabId, { type }).catch(() => { /* expected */ });
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

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo?.status === 'complete') {
    reassertIndicatorIfActive(tabId);
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  activeIndicatorTabs.delete(tabId);
});

function sendAgentRunComplete(tabId) {
  if (tabId == null) return;
  chrome.runtime.sendMessage({
    target: 'sidepanel',
    action: 'agent_update',
    tabId,
    type: 'run_complete',
    data: {},
  }).catch(() => {});
}

// Stop button on the page → abort the agent run for that tab. Mirrors
// the sidepanel's Stop button.
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type !== 'WB_STOP_AGENT') return; // not ours
  const tabId = sender?.tab?.id;
  if (tabId != null) {
    try { agent.abort(tabId); } catch { /* ignore */ }
  }
  sendResponse({ ok: true });
  // Synchronous response — return undefined.
});

// IMPORTANT: must be a sync handler with no awaits before sidePanel.open(),
// otherwise the user-gesture token expires across the await and Chrome
// silently refuses to open the panel.
chrome.action.onClicked.addListener((tab) => {
  if (!tab?.id) return;
  // Legacy fallback: keep panelTabs in sync for browsers without tabGroups.
  panelTabs.add(tab.id);
  savePanelTabs();
  // Fire-and-forget; do NOT await — preserves user gesture for open() below.
  // This pair (setOptions + open with no await between) is the same pattern
  // Claude's browser extension uses; it works because we never proactively
  // flip this tab to enabled:false elsewhere, so the open() call doesn't
  // observe a stale "disabled" state and silently no-op.
  chrome.sidePanel.setOptions({
    tabId: tab.id,
    path: 'src/ui/sidepanel.html',
    enabled: true,
  });
  chrome.sidePanel.open({ tabId: tab.id });
  // Now group the source tab so the visibility scope is established
  // before the user can switch tabs. Async — we already lost the user-
  // gesture window for sidePanel.open, but ensureWebBrainGroup doesn't
  // need it.
  ensureWebBrainGroup(tab).catch(() => {});
});

// (Was: chrome.tabs.onActivated + chrome.tabs.onUpdated listeners that
// re-asserted enabled:true on every tab switch / group change. Removed
// because that was the bug — it made the panel auto-enable on Cmd+T'd
// tabs, leaking a running agent's progress into unrelated tabs. Chrome
// already preserves per-tab panel state across tab switches; we don't
// need to re-assert it.)

// User ungrouped (or Chrome auto-collapsed) the WebBrain group entirely.
// Forget the mapping for that window so the next action click can seed
// a fresh group rather than try to reuse a dead ID.
chrome.tabGroups?.onRemoved?.addListener?.((group) => {
  for (const [windowId, gid] of webBrainGroupByWindow) {
    if (gid === group.id) {
      webBrainGroupByWindow.delete(windowId);
      saveWebBrainGroups();
      break;
    }
  }
});

// Window closed — drop the per-window mapping.
chrome.windows?.onRemoved?.addListener?.((windowId) => {
  if (webBrainGroupByWindow.has(windowId)) {
    webBrainGroupByWindow.delete(windowId);
    saveWebBrainGroups();
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  panelTabs.delete(tabId);
  clearTimeout(pendingContextMenuNotifications.get(tabId));
  pendingContextMenuNotifications.delete(tabId);
  contextMenuStorage.cleanup(tabId);
  savePanelTabs();
  chrome.storage.session?.remove(`tabChat:${tabId}`).catch(() => {});
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
  chrome.runtime.sendMessage({
    target: 'sidepanel',
    action: 'context_menu_tab_navigated',
    tabId,
  }).catch(() => {});
}

// SPA navigation tracking. Many sites change route via History API without
// a full page load — content scripts and any cached element snapshots become
// stale. We record per-tab timestamps for both full and history-only
// navigations and expose them on globalThis so cdpClient.resolveSelector can
// extend its retry budget when a click/type fires soon after a nav (the new
// route may still be hydrating).
const lastNavByTab = new Map(); // tabId -> { ts, type, url }
globalThis.__webbrainLastNav = lastNavByTab;

function recordNav(tabId, type, url) {
  if (tabId == null) return;
  lastNavByTab.set(tabId, { ts: Date.now(), type, url: url || '' });
}

chrome.webNavigation?.onHistoryStateUpdated?.addListener((details) => {
  if (details.frameId !== 0) return;
  recordNav(details.tabId, 'history', details.url);
  invalidateContextMenuForTab(details.tabId);
});
chrome.webNavigation?.onReferenceFragmentUpdated?.addListener((details) => {
  if (details.frameId !== 0) return;
  recordNav(details.tabId, 'fragment', details.url);
  invalidateContextMenuForTab(details.tabId);
});
chrome.webNavigation?.onCommitted?.addListener((details) => {
  if (details.frameId !== 0) return;
  recordNav(details.tabId, 'committed', details.url);
  invalidateContextMenuForTab(details.tabId);
});
chrome.webNavigation?.onCompleted?.addListener((details) => {
  if (details.frameId === 0) recordNav(details.tabId, 'completed', details.url);
});

chrome.tabs.onRemoved.addListener((tabId) => lastNavByTab.delete(tabId));

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
  const onBeforeRequest = chrome.webRequest?.onBeforeRequest;
  const onBeforeSendHeaders = chrome.webRequest?.onBeforeSendHeaders;
  if (!onBeforeRequest) return;
  if (shouldEnable && !apiMutationObserverRegistered) {
    onBeforeRequest.addListener(recordApiRequest, { urls: ['<all_urls>'], types: ['xmlhttprequest'] }, ['requestBody']);
    onBeforeSendHeaders?.addListener(
      recordApiRequestHeaders,
      { urls: ['<all_urls>'], types: ['xmlhttprequest'] },
      ['requestHeaders', 'extraHeaders']
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
    const stored = await chrome.storage.local.get({ [API_MUTATION_OBSERVER_KEY]: API_MUTATION_OBSERVER_DEFAULT });
    setApiMutationObserverEnabled(stored[API_MUTATION_OBSERVER_KEY] === true);
  } catch (e) {
    setApiMutationObserverEnabled(API_MUTATION_OBSERVER_DEFAULT);
  }
}

loadApiMutationObserverSetting();

chrome.tabs.onRemoved.addListener((tabId) => {
  apiRequestsByTab.delete(tabId);
  for (const [id, replay] of apiRequestReplayById.entries()) {
    if (replay?.tabId === tabId) apiRequestReplayById.delete(id);
  }
});

/**
 * Central message handler.
 */
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.target !== 'background') return;

  handleMessage(msg, sender)
    .then(sendResponse)
    .catch(e => sendResponse({ error: e.message }));

  return true; // async response
});

async function handleMessage(msg, sender) {
  // Ensure providers are loaded
  if (providerManager.providers.size === 0) {
    await providerManager.load();
  }
  // Agent toggles and prompt add-ons hydrate once at SW boot — await those
  // promises so the first chat can't race ahead of hydration, without a
  // storage round-trip on every message.
  await Promise.all([planBeforeActReady, customSkillsReady]);

  switch (msg.action) {
    // --- Chat / Agent ---
    case 'chat': {
      const tabId = msg.tabId || sender.tab?.id;
      if (!tabId) throw new Error('No tab ID');
      const mode = msg.mode || 'ask';

      // /allow-api flag is per-conversation. The sidebar tracks it locally
      // but sends it on every chat call so the agent stays in sync after a
      // service worker restart.
      if (msg.apiMutationsAllowed) agent.setApiMutationsAllowed(tabId, true);

      // Show the on-page glow + Stop button while the run is in flight.
      // Best-effort: silently no-ops on tabs where the content script
      // isn't present (chrome://, chrome-extension://, etc.).
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
          chrome.runtime.sendMessage({
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
          chrome.runtime.sendMessage({
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
          chrome.runtime.sendMessage({
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
        try { tab = await chrome.tabs.get(tabId); } catch {}
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

    // --- Provider Management ---
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
      // Settings UI "Check balance" button. Uses the key from the request
      // rather than re-reading storage so the user gets feedback before
      // they've clicked Save.
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
    // The actual flow runs in the background script (not the settings
    // page) so the chrome.tabs.onUpdated listener doesn't disappear if
    // the user switches away from settings mid-flow. The settings page
    // just dispatches start/signout/status and re-renders on the result.
    //
    // No proactive refresh-alarm: AnthropicOAuthProvider does lazy
    // refresh on every chat call (token expiry check + a 401-retry
    // safety net). Skipping the alarm avoids adding the `alarms`
    // permission and the re-permission prompt that would trigger.
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
      // "Test connection" button. Round-trip a 1-token chat through
      // the active provider config (not through providerManager.testProvider
      // because the OAuth provider may not be the active provider yet).
      try {
        await refreshClaudeAccessToken();
        return { ok: true };
      } catch (e) {
        return { ok: false, error: e.message };
      }
    }
    // ── Tab Recorder routes (v7.4) ────────────────────────────────
    // Thin wrappers around src/recorder/host.js. Same module is also
    // imported by agent.js so the prompt-driven `record_tab` and
    // `stop_recording` tools share the exact same orchestration.
    case 'start_tab_recording': {
      const tabId = msg.tabId || sender.tab?.id;
      return await startTabRecording(tabId, msg.options || {});
    }
    case 'stop_tab_recording': {
      return await stopTabRecording();
    }
    case 'get_recording_state': {
      return { ok: true, state: await getRecordingStateFresh() };
    }

    case 'capture_full_page_screenshot': {
      const tabId = msg.tabId || sender.tab?.id;
      return await agent.captureFullPageScreenshotForUser(tabId);
    }

    // --- Page Info (quick, no agent loop) ---
    case 'get_page_info': {
      const tabId = msg.tabId || sender.tab?.id;
      try {
        const response = await chrome.tabs.sendMessage(tabId, {
          target: 'content',
          action: 'get_page_info',
        });
        return response;
      } catch {
        // Try injecting content script. accessibility-tree.js must load
        // first so content.js's a11y-tree handlers can reach the builder.
        await chrome.scripting.executeScript({
          target: { tabId },
          files: [
            'src/content/accessibility-tree.js',
            'src/content/content.js',
            'src/content/agent-visual-indicator.js',
          ],
        });
        return await chrome.tabs.sendMessage(tabId, {
          target: 'content',
          action: 'get_page_info',
        });
      }
    }

    default:
      throw new Error(`Unknown action: ${msg.action}`);
  }
}
