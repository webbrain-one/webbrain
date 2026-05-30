import { AGENT_TOOLS, AGENT_TOOL_NAMES, getToolsForMode } from '../agent/tools.js';
import { CAPABILITY_LABEL, capabilitiesFor } from '../agent/permission-gate.js';

const DEFAULT_PORT = 17362;
const RECONNECT_MIN_MS = 1000;
const RECONNECT_MAX_MS = 15000;

/**
 * Connect the running browser extension to a local WebBrain MCP bridge.
 *
 * The MCP server itself speaks stdio to agent hosts. This browser-side half
 * only opens an outbound localhost WebSocket, which lets WebBrain operate on
 * the user's real browser/profile instead of launching a disposable browser.
 */
export function startMcpBridge({
  browserApi,
  browserName,
  agent,
  providerManager,
  sendIndicatorMessage,
}) {
  const api = browserApi;
  let socket = null;
  let reconnectTimer = null;
  let reconnectDelay = RECONNECT_MIN_MS;
  let stopped = false;

  async function getConfig() {
    try {
      const stored = await api.storage.local.get(['mcpBridgeEnabled', 'mcpBridgePort']);
      return {
        enabled: stored.mcpBridgeEnabled !== false,
        port: Number.isFinite(Number(stored.mcpBridgePort))
          ? Math.max(1, Math.min(65535, Number(stored.mcpBridgePort)))
          : DEFAULT_PORT,
      };
    } catch {
      return { enabled: true, port: DEFAULT_PORT };
    }
  }

  function scheduleReconnect() {
    if (stopped || reconnectTimer) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect().catch(() => scheduleReconnect());
    }, reconnectDelay);
    reconnectDelay = Math.min(RECONNECT_MAX_MS, Math.round(reconnectDelay * 1.6));
  }

  function send(message) {
    if (!socket || socket.readyState !== WebSocket.OPEN) return false;
    socket.send(JSON.stringify(message));
    return true;
  }

  async function connect() {
    const { enabled, port } = await getConfig();
    if (!enabled || stopped) return;
    if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) return;

    socket = new WebSocket(`ws://127.0.0.1:${port}/webbrain`);
    socket.addEventListener('open', () => {
      reconnectDelay = RECONNECT_MIN_MS;
      const manifest = api.runtime.getManifest?.() || {};
      send({
        type: 'hello',
        browser: browserName,
        extensionName: manifest.name || 'WebBrain',
        extensionVersion: manifest.version || '',
        protocolVersion: 1,
        capabilities: ['tabs', 'chat', 'tools'],
      });
    });
    socket.addEventListener('message', (event) => {
      handleWireMessage(event.data).catch((error) => {
        send({ type: 'error', error: error.message || String(error) });
      });
    });
    socket.addEventListener('close', () => {
      socket = null;
      scheduleReconnect();
    });
    socket.addEventListener('error', () => {
      try { socket?.close(); } catch { /* ignore */ }
    });
  }

  async function handleWireMessage(raw) {
    let message;
    try {
      message = JSON.parse(String(raw));
    } catch {
      send({ type: 'error', error: 'Invalid JSON from MCP bridge.' });
      return;
    }
    if (message?.type !== 'request') return;

    try {
      const result = await dispatchBridgeAction(message.action, message.params || {}, message.id);
      send({ type: 'response', id: message.id, result });
    } catch (error) {
      send({
        type: 'response',
        id: message.id,
        error: {
          message: error.message || String(error),
          stack: error.stack || undefined,
        },
      });
    }
  }

  async function dispatchBridgeAction(action, params, requestId) {
    await ensureProvidersLoaded();
    switch (action) {
      case 'status':
        return await status();
      case 'list_tabs':
        return { tabs: await listTabs(params) };
      case 'active_tab':
        return { tab: await getActiveTab() };
      case 'tool_catalog':
        return toolCatalog(params);
      case 'chat':
        return await chat(params, requestId);
      case 'continue':
        return await continueChat(params, requestId);
      case 'abort':
        return await abort(params);
      case 'clear_conversation':
        return await clearConversation(params);
      case 'call_tool':
        return await callTool(params, requestId);
      default:
        throw new Error(`Unknown MCP bridge action: ${action}`);
    }
  }

  async function ensureProvidersLoaded() {
    if (providerManager?.providers?.size === 0) {
      await providerManager.load();
    }
  }

  async function status() {
    const manifest = api.runtime.getManifest?.() || {};
    return {
      ok: true,
      browser: browserName,
      extensionName: manifest.name || 'WebBrain',
      extensionVersion: manifest.version || '',
      activeProvider: providerManager?.activeProviderId || null,
      activeTab: await getActiveTab().catch(() => null),
      toolCount: AGENT_TOOLS.length,
    };
  }

  function tabSummary(tab) {
    if (!tab) return null;
    return {
      id: tab.id,
      windowId: tab.windowId,
      index: tab.index,
      active: !!tab.active,
      highlighted: !!tab.highlighted,
      title: tab.title || '',
      url: tab.url || '',
      favIconUrl: tab.favIconUrl || '',
      status: tab.status || '',
      groupId: tab.groupId ?? null,
    };
  }

  async function listTabs(params = {}) {
    const query = {};
    if (params.currentWindow === true) query.currentWindow = true;
    if (Number.isInteger(params.windowId)) query.windowId = params.windowId;
    if (params.activeOnly === true) query.active = true;
    const tabs = await api.tabs.query(query);
    return (tabs || []).map(tabSummary);
  }

  async function getActiveTab() {
    let tabs = await api.tabs.query({ active: true, lastFocusedWindow: true });
    if (!tabs || tabs.length === 0) {
      tabs = await api.tabs.query({ active: true, currentWindow: true });
    }
    return tabSummary(tabs?.[0]);
  }

  async function resolveTabId(tabId) {
    if (Number.isInteger(tabId) && tabId > 0) return tabId;
    const tab = await getActiveTab();
    if (!tab?.id) throw new Error('No active browser tab found. Open WebBrain in the target browser/profile first.');
    return tab.id;
  }

  function toolCatalog(params = {}) {
    const mode = params.mode === 'ask' || params.mode === 'act' ? params.mode : 'all';
    const tools = mode === 'all'
      ? AGENT_TOOLS
      : getToolsForMode(mode, { strictSecretMode: !!agent.strictSecretMode });
    return {
      mode,
      tools: tools.map((tool) => ({
        name: tool.function.name,
        description: tool.function.description,
        parameters: tool.function.parameters || { type: 'object', properties: {} },
      })),
    };
  }

  function emitUpdate(tabId, type, data, requestId) {
    try {
      send({
        type: 'event',
        event: 'agent_update',
        requestId,
        data: { tabId, type, data },
      });
    } catch { /* bridge events are best-effort */ }

    try {
      const p = api.runtime.sendMessage({
        target: 'sidepanel',
        action: 'agent_update',
        tabId,
        type,
        data,
      });
      if (p?.catch) p.catch(() => {});
    } catch { /* side panel may be closed */ }
  }

  async function chat(params = {}, requestId) {
    const tabId = await resolveTabId(params.tabId);
    const text = String(params.text || '').trim();
    if (!text) throw new Error('chat requires a non-empty text argument.');
    const mode = params.mode === 'act' ? 'act' : 'ask';
    const updates = [];

    if (params.apiMutationsAllowed) agent.setApiMutationsAllowed(tabId, true);
    sendIndicatorMessage?.(tabId, 'WB_SHOW_AGENT_INDICATORS');
    try {
      const content = await agent.processMessage(tabId, text, (type, data) => {
        updates.push({ type, data });
        emitUpdate(tabId, type, data, requestId);
      }, mode);
      return { tabId, mode, content, updates };
    } finally {
      sendIndicatorMessage?.(tabId, 'WB_HIDE_AGENT_INDICATORS');
    }
  }

  async function continueChat(params = {}, requestId) {
    const tabId = await resolveTabId(params.tabId);
    const mode = params.mode === 'act' ? 'act' : 'ask';
    const updates = [];

    sendIndicatorMessage?.(tabId, 'WB_SHOW_AGENT_INDICATORS');
    try {
      const content = await agent.continueProcessing(tabId, (type, data) => {
        updates.push({ type, data });
        emitUpdate(tabId, type, data, requestId);
      }, mode);
      return { tabId, mode, content, updates };
    } finally {
      sendIndicatorMessage?.(tabId, 'WB_HIDE_AGENT_INDICATORS');
    }
  }

  async function abort(params = {}) {
    const tabId = await resolveTabId(params.tabId);
    agent.abort(tabId);
    return { ok: true, tabId };
  }

  async function clearConversation(params = {}) {
    const tabId = await resolveTabId(params.tabId);
    agent.clearConversation(tabId);
    return { ok: true, tabId };
  }

  async function callTool(params = {}, requestId) {
    const tabId = await resolveTabId(params.tabId);
    const name = String(params.name || params.toolName || '').trim();
    if (!AGENT_TOOL_NAMES.has(name)) {
      throw new Error(`Unknown WebBrain tool: ${name || '(empty)'}`);
    }
    if (name === 'clarify') {
      throw new Error('Direct MCP tool calls cannot use clarify because there is no guaranteed user reply path. Use webbrain_chat instead.');
    }

    const args = params.args && typeof params.args === 'object' ? params.args : {};
    const capabilities = capabilitiesFor(name, args);
    const allowPrivileged = params.allowPrivilegedBrowserAction === true
      || params.allowConsequentialActions === true;
    if (capabilities.length && !allowPrivileged) {
      return {
        success: false,
        denied: true,
        error: 'This direct WebBrain tool call can affect browser state, local files, or authenticated network data. Retry with allowPrivilegedBrowserAction:true only if the MCP caller is allowed to perform that action in the user profile.',
        requiredCapabilities: capabilities.map((capability) => ({
          capability,
          label: CAPABILITY_LABEL[capability] || capability,
        })),
      };
    }

    const updates = [];
    sendIndicatorMessage?.(tabId, 'WB_SHOW_AGENT_INDICATORS');
    try {
      const result = await agent.executeTool(tabId, name, args, (type, data) => {
        updates.push({ type, data });
        emitUpdate(tabId, type, data, requestId);
      });
      const cleaned = omitAttachments(result, params.includeAttachments === true);
      return { tabId, tool: name, args, result: cleaned, updates };
    } finally {
      sendIndicatorMessage?.(tabId, 'WB_HIDE_AGENT_INDICATORS');
    }
  }

  function omitAttachments(value, includeAttachments) {
    if (includeAttachments || !value || typeof value !== 'object') return value;
    const copy = Array.isArray(value) ? [...value] : { ...value };
    if (copy._attachImage) {
      delete copy._attachImage;
      copy.attachmentOmitted = {
        type: 'image',
        reason: 'Pass includeAttachments:true to return the raw data URL.',
      };
    }
    if (copy._attachDocument) {
      delete copy._attachDocument;
      copy.attachmentOmitted = {
        type: 'document',
        reason: 'Pass includeAttachments:true to return the raw document block.',
      };
    }
    return copy;
  }

  try {
    api.storage?.onChanged?.addListener?.((changes, area) => {
      if (area && area !== 'local') return;
      if (!changes.mcpBridgeEnabled && !changes.mcpBridgePort) return;
      try { socket?.close(); } catch { /* ignore */ }
      socket = null;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      reconnectTimer = null;
      reconnectDelay = RECONNECT_MIN_MS;
      scheduleReconnect();
    });
  } catch { /* storage change listener is optional */ }

  connect().catch(() => scheduleReconnect());

  return {
    stop() {
      stopped = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      reconnectTimer = null;
      try { socket?.close(); } catch { /* ignore */ }
      socket = null;
    },
  };
}
