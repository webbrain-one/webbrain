import { ProviderManager } from './providers/manager.js';
import { Agent } from './agent/agent.js';
import {
  startClaudeOAuth,
  refreshClaudeAccessToken,
  signOutClaude,
  getClaudeOAuthStatus,
} from './providers/oauth-claude.js';
import { getBalance as capsolverGetBalance } from './agent/captcha-solver.js';
// (ensureOffscreen + transcribeAudio used to be imported here; both are
// now consumed inside src/recorder/host.js, which background.js calls into.)
import {
  startTabRecording,
  stopTabRecording,
  getRecordingState,
  setProviderManager as setRecorderProviderManager,
} from './recorder/host.js';

/**
 * WebBrain Service Worker (Background Script)
 * Routes messages between side panel, content scripts, and the agent.
 */

const providerManager = new ProviderManager();
const agent = new Agent(providerManager);

// Wire the recorder to our provider manager so its transcription path
// can look up the user's configured Whisper-compatible provider. Must
// happen AFTER providerManager is constructed.
setRecorderProviderManager(providerManager);

// Load maxSteps setting
async function loadMaxSteps() {
  const stored = await chrome.storage.local.get('maxAgentSteps');
  if (stored.maxAgentSteps) agent.maxSteps = stored.maxAgentSteps;
}

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

// Initialize on install
chrome.runtime.onInstalled.addListener(async () => {
  await providerManager.load();
  await loadMaxSteps();
  console.log('[WebBrain] Extension installed, providers loaded.');
});

// Also load on startup
chrome.runtime.onStartup?.addListener(async () => {
  await providerManager.load();
  await loadMaxSteps();
});

// Listen for setting changes
chrome.storage.onChanged.addListener((changes) => {
  if (changes.maxAgentSteps) {
    agent.maxSteps = changes.maxAgentSteps.newValue;
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
  if (changes.captchaSolverEnabled) {
    agent.captchaSolverEnabled = !!changes.captchaSolverEnabled.newValue;
    refreshPrompts = true;
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
function sendIndicatorMessage(tabId, type) {
  if (tabId == null || !type) return;
  try {
    chrome.tabs.sendMessage(tabId, { type }).catch(() => { /* expected */ });
  } catch { /* ignore */ }
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
  savePanelTabs();
  // Also clear any persisted chat state for that tab.
  chrome.storage.session?.remove(`tabChat:${tabId}`).catch(() => {});
  // Drop per-tab agent state (last interaction rect, etc.) so stale data
  // can't resurface if Chrome recycles the tab id for a new tab.
  try { agent._lastInteractionRect?.delete(tabId); } catch { /* ignore */ }
});

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
  if (details.frameId === 0) recordNav(details.tabId, 'history', details.url);
});
chrome.webNavigation?.onReferenceFragmentUpdated?.addListener((details) => {
  if (details.frameId === 0) recordNav(details.tabId, 'fragment', details.url);
});
chrome.webNavigation?.onCommitted?.addListener((details) => {
  if (details.frameId === 0) recordNav(details.tabId, 'committed', details.url);
});
chrome.webNavigation?.onCompleted?.addListener((details) => {
  if (details.frameId === 0) recordNav(details.tabId, 'completed', details.url);
});

chrome.tabs.onRemoved.addListener((tabId) => lastNavByTab.delete(tabId));

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
        sendIndicatorMessage(tabId, 'WB_HIDE_AGENT_INDICATORS');
      }
    }

    case 'clear_conversation': {
      const tabId = msg.tabId || sender.tab?.id;
      if (tabId) agent.clearConversation(tabId);
      return { ok: true };
    }

    case 'abort': {
      const tabId = msg.tabId || sender.tab?.id;
      if (tabId) agent.abort(tabId);
      return { ok: true };
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
      const matched = agent.submitClarifyResponse(tabId, clarifyId, answer, msg.source || 'user');
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
      return { ok: true, state: getRecordingState() };
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
          files: ['src/content/accessibility-tree.js', 'src/content/content.js'],
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
