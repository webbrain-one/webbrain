import { ProviderManager } from './providers/manager.js';
import { Agent } from './agent/agent.js';
import {
  startClaudeOAuth,
  refreshClaudeAccessToken,
  signOutClaude,
  getClaudeOAuthStatus,
} from './providers/oauth-claude.js';
import { getBalance as capsolverGetBalance } from './agent/captcha-solver.js';

/**
 * WebBrain Background Script (Firefox)
 * Routes messages between sidebar, content scripts, and the agent.
 */

const providerManager = new ProviderManager();
const agent = new Agent(providerManager);

// Load maxSteps setting
async function loadMaxSteps() {
  const stored = await browser.storage.local.get('maxAgentSteps');
  if (stored.maxAgentSteps) agent.maxSteps = stored.maxAgentSteps;
}

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

// Initialize on install
browser.runtime.onInstalled.addListener(async () => {
  await providerManager.load();
  await loadMaxSteps();
  await loadAutoScreenshot();
  console.log('[WebBrain] Extension installed, providers loaded.');
});

// Listen for setting changes
browser.storage.onChanged.addListener((changes) => {
  if (changes.maxAgentSteps) {
    agent.maxSteps = changes.maxAgentSteps.newValue;
  }
  if (changes.autoScreenshot) {
    agent.autoScreenshot = changes.autoScreenshot.newValue;
  }
  let refreshPrompts = false;
  if (changes.useSiteAdapters) {
    agent.useSiteAdapters = changes.useSiteAdapters.newValue;
    refreshPrompts = true;
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
  try { agent._cleanupTab(tabId); } catch { /* ignore */ }
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
function sendIndicatorMessage(tabId, type) {
  if (tabId == null || !type) return;
  try {
    browser.tabs.sendMessage(tabId, { type }).catch(() => { /* expected */ });
  } catch { /* ignore */ }
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

  switch (msg.action) {
    case 'chat': {
      const tabId = msg.tabId || sender.tab?.id;
      if (!tabId) throw new Error('No tab ID');
      const mode = msg.mode || 'ask';

      if (msg.apiMutationsAllowed) agent.setApiMutationsAllowed(tabId, true);

      sendIndicatorMessage(tabId, 'WB_SHOW_AGENT_INDICATORS');

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
