'use strict';

// Main-process side of the extension APIs Electron and electron-chrome-extensions
// do not provide, but WebBrain needs: chrome.sidePanel, chrome.debugger,
// chrome.alarms, chrome.offscreen, chrome.tabGroups, chrome.identity,
// chrome.search, chrome.downloads, chrome.tabs.captureVisibleTab / group.
//
// Extension contexts call in with ipcRenderer.invoke('murshid-crx', name, ...args)
// from app/crx/preload-pre.js and preload-post.js; events go back out as
// 'murshid-crx-event' messages to the extension's service worker and pages.

const { BrowserWindow, ipcMain, shell, webContents: allWebContents } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { mapInternal } = require('../url');

const CHANNEL = 'murshid-crx';
const EVENT_CHANNEL = 'murshid-crx-event';

class CrxBridge {
  constructor(ctx) {
    this.ctx = ctx;
    this.ses = ctx.ses;
    this.workers = new WeakSet();
    this.keepAlive = new Map(); // extensionId -> { worker, task }

    // chrome.sidePanel
    this.panelBehavior = new Map(); // extId -> { openPanelOnActionClick }
    this.panelDefault = new Map(); // extId -> { path, enabled }
    this.panelTab = new Map(); // tabId -> { extId, path, enabled }
    this.panelOpenTabs = new Map(); // tabId -> extId
    this.panelOpenWindows = new Map(); // windowId -> extId
    this.panelContents = new Map(); // webContents id -> { win, key }

    // chrome.debugger
    this.debuggerSessions = new Map(); // tabId -> { extId, wc, onMessage, onDetach }

    // chrome.alarms
    this.alarmsFile = path.join(ctx.userData, 'murshid-alarms.json');
    this.alarms = new Map(); // `${extId}\n${name}` -> alarm
    this.alarmTimers = new Map();

    // chrome.offscreen
    this.offscreen = new Map(); // extId -> BrowserWindow
    this.offscreenIdentity = new Map(); // extId -> { win, generation, documentId, pending }
    this.offscreenRequests = new Map();
    this.requestEventAcks = new Map();

    // chrome.tabGroups (Murshid has no tab groups UI yet; ids are kept so callers work)
    this.groups = new Map(); // groupId -> { id, title, color, collapsed, windowId, tabIds:Set }
    this.nextGroupId = 1;

    // Settles once WebBrain's worker has written Murshid's first-run defaults,
    // so the first new tab does not read storage before they are there.
    this.defaultsReady = new Promise((resolve) => { this.resolveDefaults = resolve; });

    this.loadAlarms();
    this.listen();
  }

  // ---------------------------------------------------------------- wiring

  listen() {
    ipcMain.handle(CHANNEL, (event, name, ...args) => this.dispatch(event.sender, null, name, args));
    const attach = (versionId) => {
      const worker = this.ses.serviceWorkers.getWorkerFromVersionID(versionId);
      if (!worker || this.workers.has(worker) || !worker.scope?.startsWith('chrome-extension://')) return;
      this.workers.add(worker);
      worker.ipc.handle(CHANNEL, (_event, name, ...args) => this.dispatch(null, worker, name, args));
      this.holdWorker(worker);
    };
    this.ses.serviceWorkers.on('running-status-changed', ({ versionId, runningStatus }) => {
      if (runningStatus === 'starting' || runningStatus === 'running') attach(versionId);
    });
    for (const versionId of Object.keys(this.ses.serviceWorkers.getAllRunning())) attach(Number(versionId));
  }

  /**
   * Keep the extension's worker alive while Murshid runs. Chrome stops idle
   * workers after 30 s; an agent waiting on a model reply must not lose its run.
   */
  holdWorker(worker) {
    const extId = extIdFromUrl(worker.scope);
    if (!extId) return;
    const held = this.keepAlive.get(extId);
    if (held && held.worker === worker && !worker.isDestroyed()) return;
    try { held?.task?.end(); } catch {}
    try {
      this.keepAlive.set(extId, { worker, task: worker.startTask() });
    } catch {
      // Worker went away while starting.
    }
  }

  async dispatch(sender, worker, name, args) {
    const origin = worker ? worker.scope : safeUrl(sender);
    const extId = extIdFromUrl(origin);
    if (!extId || !this.ses.extensions.getExtension(extId)) {
      return { error: `Murshid: ${name} is only available to extensions.` };
    }
    const handler = this.handlers[name];
    if (!handler) return { error: `Murshid: ${name} is not supported.` };
    try {
      const clean = args.map((arg) => (arg === null ? undefined : arg));
      const value = await handler.call(this, { extId, sender, worker }, ...clean);
      return { value: value === undefined ? null : value };
    } catch (error) {
      return { error: String(error?.message || error) };
    }
  }

  /** Send an extension event to the extension's worker and its open pages. */
  async emit(extId, name, args, { wake = false } = {}) {
    const scope = `chrome-extension://${extId}/`;
    for (const wc of allWebContents.getAllWebContents()) {
      if (wc.isDestroyed() || wc.session !== this.ses) continue;
      let url = '';
      try { url = wc.getURL(); } catch {}
      if (url.startsWith(scope)) wc.send(EVENT_CHANNEL, name, args);
    }
    let worker = this.runningWorker(scope);
    if (!worker && wake) {
      try { worker = await this.ses.serviceWorkers.startWorkerForScope(scope); } catch {}
    }
    if (worker && !worker.isDestroyed()) {
      try { worker.send(EVENT_CHANNEL, name, args); } catch {}
    }
  }

  isWebBrain(extId) {
    if (extId === this.ctx.webBrainId) return true;
    const ext = this.ses.extensions.getExtension(extId);
    const dir = require('../paths').webBrainExtensionDir();
    return Boolean(ext && dir && path.resolve(ext.path) === path.resolve(dir));
  }

  runningWorker(scope) {
    for (const [versionId, info] of Object.entries(this.ses.serviceWorkers.getAllRunning())) {
      if (info.scope === scope) {
        const worker = this.ses.serviceWorkers.getWorkerFromVersionID(Number(versionId));
        if (worker && !worker.isDestroyed()) return worker;
      }
    }
    return null;
  }

  // Electron's session webRequest listener takes precedence over the native
  // extension events. Bridge browser-tab events and separately validate the
  // current offscreen document; the worker acknowledges delivery before proceeding.
  async forwardWebRequest(event, details) {
    const tab = this.ctx.windows.flatMap((win) => win.tabs).find((tab) => tab.wc.id === details.webContentsId);
    if (!tab) {
      if (details.initiatorOrigin === `chrome-extension://${this.ctx.webBrainId}` && !details.frame && details.webContentsId == null
          && details.resourceType === 'xhr' && ['onBeforeRedirect', 'onResponseStarted', 'onErrorOccurred'].includes(event)) {
        const extId = this.ctx.webBrainId;
        const manifest = extId && this.ses.extensions.getExtension(extId)?.manifest;
        if (!this.isWebBrain(extId) || !/^https?:/i.test(details.url)
            || !manifest?.permissions?.includes('webRequest') || !manifest?.host_permissions?.includes('<all_urls>')) return;
        return this.deliverWebRequest(extId, event, { requestId: String(details.id), tabId: -1, frameId: -1,
          parentFrameId: -1, url: details.url, method: details.method, type: 'xmlhttprequest',
          timeStamp: details.timestamp, initiator: details.initiatorOrigin, ip: details.ip, error: details.error,
          redirectUrl: details.redirectURL, statusCode: details.statusCode });
      }
      return this.forwardOffscreenRequest(event, details);
    }
    const extId = this.ctx.webBrainId;
    const manifest = extId && this.ses.extensions.getExtension(extId)?.manifest;
    if (tab.wc.isDestroyed() || tab.wc.session !== this.ses || !/^https?:/i.test(details.url)
      || !manifest?.permissions?.includes('webRequest') || !manifest?.host_permissions?.includes('<all_urls>')) return;
    const frame = details.frame;
    const frameId = !frame ? -1 : frame === tab.wc.mainFrame ? 0 : frame.frameTreeNodeId;
    const types = { mainFrame: 'main_frame', subFrame: 'sub_frame', xhr: 'xmlhttprequest', webSocket: 'websocket', cspReport: 'csp_report' };
    const payload = {
      requestId: String(details.id), tabId: tab.id, frameId,
      parentFrameId: frameId <= 0 ? -1 : frame.parent === tab.wc.mainFrame ? 0 : (frame.parent?.frameTreeNodeId ?? -1),
      url: details.url, method: details.method, type: types[details.resourceType] || details.resourceType,
      timeStamp: details.timestamp, initiator: details.initiatorOrigin,
    };
    if (event === 'onBeforeRequest' && details.uploadData?.length) {
      payload.requestBody = { raw: (await Promise.all(details.uploadData.map(async (part) => {
        const bytes = part.bytes || (part.blobUUID ? await this.ses.getBlobData(part.blobUUID) : null);
        if (bytes) return [{ bytes: Uint8Array.from(bytes).buffer }];
        if (part.file) return [{ file: part.file }];
        return [];
      }))).flat() };
    }
    if (event === 'onBeforeSendHeaders') {
      payload.requestHeaders = Object.entries(details.requestHeaders || {}).map(([name, value]) => ({ name, value }));
    }
    if (event === 'onHeadersReceived') {
      payload.statusCode = details.statusCode;
      payload.statusLine = details.statusLine;
      payload.responseHeaders = Object.entries(details.responseHeaders || {}).flatMap(([name, values]) => [].concat(values).map((value) => ({ name, value })));
    }
    if (['onBeforeRedirect', 'onResponseStarted', 'onErrorOccurred'].includes(event)) {
      payload.ip = details.ip;
      payload.error = details.error;
      payload.redirectUrl = details.redirectURL;
      payload.statusCode = details.statusCode;
    }
    return this.deliverWebRequest(extId, event, payload);
  }

  discardOffscreenRequest(id) {
    const key = String(id);
    const binding = this.offscreenRequests.get(key);
    if (binding) clearTimeout(binding.timer);
    this.offscreenRequests.delete(key);
  }

  async forwardOffscreenRequest(event, details) {
    if (event !== 'onBeforeRequest' && event !== 'onHeadersReceived') return;
    if (details.resourceType !== 'xhr' || !details.frame || !details.initiatorOrigin) return;
    const extId = extIdFromUrl(`${details.initiatorOrigin}/`);
    const state = extId && this.offscreenIdentity.get(extId);
    const manifest = extId && this.ses.extensions.getExtension(extId)?.manifest;
    if (!extId || !this.isWebBrain(extId) || !manifest?.permissions?.includes('webRequest')
      || !manifest?.host_permissions?.includes('<all_urls>')) return;
    if (!state?.documentId || state.win.isDestroyed() || state.win.webContents.id !== details.webContentsId
      || details.initiatorOrigin !== `chrome-extension://${extId}`
      || details.frame.frameToken !== state.win.webContents.mainFrame.frameToken
      || details.frame.url !== state.win.webContents.getURL()) return;
    const key = String(details.id);
    if (event === 'onBeforeRequest') {
      if (this.offscreenRequests.size >= 1024 && !this.offscreenRequests.has(key)) return;
      const old = this.offscreenRequests.get(key);
      if (old) clearTimeout(old.timer);
      const binding = { extId, state, generation: state.generation, documentId: state.documentId, url: details.url };
      binding.timer = setTimeout(() => this.offscreenRequests.delete(key), 24 * 60 * 60 * 1000);
      binding.timer.unref();
      this.offscreenRequests.set(key, binding);
    } else {
      const binding = this.offscreenRequests.get(key);
      if (!binding || binding.state !== state || binding.generation !== state.generation
        || binding.documentId !== state.documentId || binding.url !== details.url) return;
      clearTimeout(binding.timer);
      this.offscreenRequests.delete(key);
    }
    const payload = {
      requestId: key, url: details.url, method: details.method, type: 'xmlhttprequest',
      tabId: -1, frameId: 0, parentFrameId: -1, timeStamp: details.timestamp,
      documentId: state.documentId, initiator: details.initiatorOrigin,
      ...(event === 'onHeadersReceived' ? {
        statusCode: details.statusCode,
        // Redirect validation needs Location only; do not relay cookies or
        // unrelated response headers through this supplemental path.
        responseHeaders: Object.entries(details.responseHeaders || {}).filter(([name]) => name.toLowerCase() === 'location').flatMap(([name, values]) => [].concat(values).map((value) => ({ name, value }))),
      } : {}),
    };
    return this.deliverWebRequest(extId, event, payload);
  }

  async deliverWebRequest(extId, event, payload) {
    const worker = this.runningWorker(`chrome-extension://${extId}/`);
    if (!worker || worker.isDestroyed() || this.requestEventAcks.size >= 512) return;
    const ticket = randomUUID();
    await new Promise((resolve) => {
      const timer = setTimeout(() => { this.requestEventAcks.delete(ticket); resolve(); }, 2000);
      this.requestEventAcks.set(ticket, { extId, resolve: () => { clearTimeout(timer); resolve(); } });
      try { worker.send(EVENT_CHANNEL, `murshid.webRequest.${event}`, [payload, ticket]); }
      catch { clearTimeout(timer); this.requestEventAcks.delete(ticket); resolve(); }
    });
  }

  // ------------------------------------------------------------ side panel

  /** Which panel (if any) the window should show for its active tab. */
  panelFor(win) {
    const tab = win.activeTab;
    if (tab && this.panelOpenTabs.has(tab.id)) {
      const extId = this.panelOpenTabs.get(tab.id);
      const opts = this.panelTab.get(tab.id);
      const def = this.panelDefault.get(extId);
      const panelPath = opts?.path || def?.path;
      if (opts?.enabled !== false && panelPath) {
        return { key: `tab:${tab.id}`, url: `chrome-extension://${extId}/${stripSlash(panelPath)}`, extId, tabId: tab.id };
      }
    }
    if (this.panelOpenWindows.has(win.id)) {
      const extId = this.panelOpenWindows.get(win.id);
      const def = this.panelDefault.get(extId);
      const tabOpts = tab && this.panelTab.get(tab.id);
      if (def?.path && def.enabled !== false && tabOpts?.enabled !== false) {
        return { key: `window:${win.id}`, url: `chrome-extension://${extId}/${stripSlash(def.path)}`, extId, windowId: win.id };
      }
    }
    return null;
  }

  trackPanelContents(wc, win, want) {
    this.panelContents.set(wc.id, { win, key: want.key });
    wc.once('destroyed', () => this.panelContents.delete(wc.id));
    this.emit(want.extId, 'sidePanel.onOpened', [{ path: want.url.replace(/^chrome-extension:\/\/[^/]+\//, ''), tabId: want.tabId, windowId: win.id }]);
  }

  /** The user closed the panel from Murshid's panel header. */
  closePanelInWindow(win) {
    const key = win.visiblePanelKey;
    if (!key) return;
    const [kind, rawId] = key.split(':');
    const id = Number(rawId);
    let extId;
    if (kind === 'tab') {
      extId = this.panelOpenTabs.get(id);
      this.panelOpenTabs.delete(id);
    } else {
      extId = this.panelOpenWindows.get(id);
      this.panelOpenWindows.delete(id);
    }
    win.destroyPanel(key);
    win.syncPanel();
    if (extId) this.emit(extId, 'sidePanel.onClosed', [{ windowId: win.id, ...(kind === 'tab' ? { tabId: id } : {}) }]);
  }

  togglePanelForActiveTab(win) {
    if (win.visiblePanelKey) {
      this.closePanelInWindow(win);
      return;
    }
    this.clickAction(win);
  }

  /** What clicking the toolbar's WebBrain button does: the extension's action. */
  clickAction(win, extId = this.ctx.webBrainId) {
    const tab = win.activeTab;
    if (!extId || !tab) return;
    const behavior = this.panelBehavior.get(extId);
    if (behavior?.openPanelOnActionClick) {
      this.panelOpenTabs.set(tab.id, extId);
      this.ctx.windowsForTab(tab.id).forEach((w) => w.syncPanel());
      return;
    }
    const api = this.ctx.extensions.api?.browserAction;
    if (api?.activateClick) {
      try {
        api.activateClick({ extensionId: extId, tabId: tab.id });
        return;
      } catch (error) {
        console.warn('[murshid] action click failed:', error);
      }
    }
  }

  onTabRemoved(tabId) {
    this.panelTab.delete(tabId);
    this.panelOpenTabs.delete(tabId);
    for (const group of this.groups.values()) group.tabIds.delete(tabId);
    const session = this.debuggerSessions.get(tabId);
    if (session) this.endDebuggerSession(tabId, 'target_closed');
  }

  refreshPanels() {
    for (const win of this.ctx.windows) win.syncPanel();
  }

  // ------------------------------------------------------------- helpers

  tabContents(tabId) {
    const wc = allWebContents.fromId(Number(tabId));
    if (!wc || wc.isDestroyed()) throw new Error(`No tab with id: ${tabId}.`);
    const win = this.ctx.windowForTab(wc.id);
    if (!win) throw new Error(`No tab with id: ${tabId}.`);
    return { wc, win };
  }

  windowFor(windowId) {
    if (typeof windowId === 'number' && windowId >= 0) {
      const win = this.ctx.windows.find((w) => w.id === windowId);
      if (!win) throw new Error(`No window with id: ${windowId}.`);
      return win;
    }
    return this.ctx.lastFocusedWindow();
  }

  // ---------------------------------------------------------- debugger

  endDebuggerSession(tabId, reason) {
    const session = this.debuggerSessions.get(tabId);
    if (!session) return;
    this.debuggerSessions.delete(tabId);
    try { session.wc.debugger.off('message', session.onMessage); } catch {}
    try { session.wc.debugger.off('detach', session.onDetach); } catch {}
    if (reason !== 'self') {
      try { if (session.wc.debugger.isAttached()) session.wc.debugger.detach(); } catch {}
      this.emit(session.extId, 'debugger.onDetach', [{ tabId }, reason || 'target_closed'], { wake: true });
    }
  }

  // ------------------------------------------------------------- alarms

  loadAlarms() {
    try {
      const list = JSON.parse(fs.readFileSync(this.alarmsFile, 'utf8'));
      for (const alarm of list) {
        if (alarm && alarm.extId && typeof alarm.name === 'string') this.alarms.set(`${alarm.extId}\n${alarm.name}`, alarm);
      }
    } catch {}
    for (const key of this.alarms.keys()) this.armAlarm(key);
  }

  saveAlarms() {
    try {
      fs.writeFileSync(this.alarmsFile, JSON.stringify([...this.alarms.values()]));
    } catch {}
  }

  armAlarm(key) {
    clearTimeout(this.alarmTimers.get(key));
    const alarm = this.alarms.get(key);
    if (!alarm) return;
    const delay = Math.max(0, alarm.scheduledTime - Date.now());
    // setTimeout caps at ~24.8 days; re-arm in steps for anything longer.
    const step = Math.min(delay, 2 ** 31 - 1);
    this.alarmTimers.set(key, setTimeout(() => {
      if (Date.now() + 5 < alarm.scheduledTime) {
        this.armAlarm(key);
        return;
      }
      this.fireAlarm(key);
    }, step));
  }

  fireAlarm(key) {
    const alarm = this.alarms.get(key);
    if (!alarm) return;
    const payload = { name: alarm.name, scheduledTime: alarm.scheduledTime, ...(alarm.periodInMinutes ? { periodInMinutes: alarm.periodInMinutes } : {}) };
    if (alarm.periodInMinutes) {
      const period = alarm.periodInMinutes * 60_000;
      let next = alarm.scheduledTime + period;
      if (next <= Date.now()) next = Date.now() + period;
      alarm.scheduledTime = next;
      this.armAlarm(key);
    } else {
      this.alarms.delete(key);
      this.alarmTimers.delete(key);
    }
    this.saveAlarms();
    this.emit(alarm.extId, 'alarms.onAlarm', [payload], { wake: true });
  }

  publicAlarm(alarm) {
    return { name: alarm.name, scheduledTime: alarm.scheduledTime, ...(alarm.periodInMinutes ? { periodInMinutes: alarm.periodInMinutes } : {}) };
  }
}

// ---------------------------------------------------------------- handlers

CrxBridge.prototype.handlers = {
  'murshid.ackWebRequest'({ extId, worker }, ticket) {
    const pending = this.requestEventAcks.get(ticket);
    if (!worker || !pending || pending.extId !== extId) return;
    this.requestEventAcks.delete(ticket);
    pending.resolve();
  },
  'murshid.registerOffscreenIdentity'({ extId, worker }, identity = {}) {
    const state = this.offscreenIdentity.get(extId);
    const pending = state?.pending;
    if (!worker || !pending || pending.nonce !== identity.nonce || pending.generation !== state.generation
      || state.win.isDestroyed() || this.offscreen.get(extId) !== state.win
      || identity.frameId !== 0 || identity.url !== pending.url || state.win.webContents.getURL() !== pending.url
      || typeof identity.documentId !== 'string' || !/^(?:[0-9a-f]{32}|[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})$/i.test(identity.documentId)) {
      throw new Error('Offscreen document identity is unavailable or stale.');
    }
    state.documentId = identity.documentId;
    state.pending = null;
    pending.resolve();
    return true;
  },
  // Murshid first-run defaults ------------------------------------------------
  'murshid.defaults'({ extId }) {
    // The worker can ask before loadExtension() has resolved, so match by folder too.
    if (!this.isWebBrain(extId)) return {};
    // The WebBrain new tab page is part of Murshid, so it starts switched on.
    // Murshid starts WebBrain Companion itself, so the new tab's "Get
    // Companion" promo starts dismissed.
    return { newTabEnabled: true, wbNewtabCompanionPromoDismissed: Date.now() };
  },
  'murshid.defaultsApplied'({ extId }) {
    if (this.isWebBrain(extId)) this.resolveDefaults?.();
  },

  // chrome.sidePanel --------------------------------------------------------
  'sidePanel.setPanelBehavior'({ extId }, behavior = {}) {
    this.panelBehavior.set(extId, { openPanelOnActionClick: Boolean(behavior.openPanelOnActionClick) });
  },
  'sidePanel.getPanelBehavior'({ extId }) {
    return this.panelBehavior.get(extId) || { openPanelOnActionClick: false };
  },
  'sidePanel.setOptions'({ extId }, options = {}) {
    if (typeof options.tabId === 'number') {
      const current = this.panelTab.get(options.tabId) || { extId };
      this.panelTab.set(options.tabId, {
        extId,
        path: options.path ?? current.path,
        enabled: options.enabled ?? current.enabled ?? true,
      });
      if (options.enabled === false) this.panelOpenTabs.delete(options.tabId);
    } else {
      const current = this.panelDefault.get(extId) || {};
      this.panelDefault.set(extId, { path: options.path ?? current.path, enabled: options.enabled ?? current.enabled ?? true });
    }
    this.refreshPanels();
  },
  'sidePanel.getOptions'({ extId }, { tabId } = {}) {
    if (typeof tabId === 'number' && this.panelTab.has(tabId)) {
      const { path: p, enabled } = this.panelTab.get(tabId);
      return { tabId, path: p, enabled };
    }
    const def = this.panelDefault.get(extId) || {};
    return { path: def.path, enabled: def.enabled ?? Boolean(def.path) };
  },
  'sidePanel.open'({ extId }, options = {}) {
    if (typeof options.tabId === 'number') {
      const { win } = this.tabContents(options.tabId);
      this.panelOpenTabs.set(options.tabId, extId);
      win.syncPanel();
      return;
    }
    const win = this.windowFor(options.windowId);
    if (!win) throw new Error('No window to open the side panel in.');
    this.panelOpenWindows.set(win.id, extId);
    win.syncPanel();
  },
  'sidePanel.close'({ extId }, options = {}) {
    if (typeof options.tabId === 'number') {
      this.panelOpenTabs.delete(options.tabId);
      const win = this.ctx.windowForTab(options.tabId);
      win?.destroyPanel(`tab:${options.tabId}`);
      win?.syncPanel();
      this.emit(extId, 'sidePanel.onClosed', [{ tabId: options.tabId, windowId: win?.id }]);
      return;
    }
    const win = this.windowFor(options.windowId);
    this.panelOpenWindows.delete(win.id);
    win.destroyPanel(`window:${win.id}`);
    win.syncPanel();
    this.emit(extId, 'sidePanel.onClosed', [{ windowId: win.id }]);
  },
  'sidePanel.getLayout'() {
    return { side: 'right' };
  },
  'sidePanel.isOpen'(_ctx, { tabId, windowId } = {}) {
    if (typeof tabId === 'number') {
      const win = this.ctx.windowForTab(tabId);
      return Boolean(win && win.activeTab?.id === tabId && win.visiblePanelKey);
    }
    const win = this.windowFor(windowId);
    return Boolean(win?.visiblePanelKey);
  },

  // chrome.debugger --------------------------------------------------------
  'debugger.attach'({ extId }, target = {}, version = '1.3') {
    const tabId = target.tabId;
    if (typeof tabId !== 'number') throw new Error('Murshid can attach the debugger to tabs only.');
    const { wc } = this.tabContents(tabId);
    if (this.debuggerSessions.has(tabId) || wc.debugger.isAttached()) {
      throw new Error(`Another debugger is already attached to the tab with id: ${tabId}.`);
    }
    wc.debugger.attach(version || '1.3');
    const onMessage = (_event, method, params, sessionId) => {
      this.emit(extId, 'debugger.onEvent', [{ tabId, ...(sessionId ? { sessionId } : {}) }, method, params]);
    };
    const onDetach = (_event, reason) => {
      this.endDebuggerSession(tabId, 'self');
      this.emit(extId, 'debugger.onDetach', [{ tabId }, reason === 'target closed' ? 'target_closed' : 'canceled_by_user'], { wake: true });
    };
    wc.debugger.on('message', onMessage);
    wc.debugger.on('detach', onDetach);
    this.debuggerSessions.set(tabId, { extId, wc, onMessage, onDetach });
  },
  'debugger.detach'({ extId }, target = {}) {
    const session = this.debuggerSessions.get(target.tabId);
    if (!session || session.extId !== extId) throw new Error(`Debugger is not attached to the tab with id: ${target.tabId}.`);
    this.debuggerSessions.delete(target.tabId);
    try { session.wc.debugger.off('message', session.onMessage); } catch {}
    try { session.wc.debugger.off('detach', session.onDetach); } catch {}
    try { session.wc.debugger.detach(); } catch {}
  },
  async 'debugger.sendCommand'({ extId }, target = {}, method, params) {
    const session = this.debuggerSessions.get(target.tabId);
    if (!session || session.extId !== extId) throw new Error(`Debugger is not attached to the tab with id: ${target.tabId}.`);
    return session.wc.debugger.sendCommand(method, params || {}, target.sessionId);
  },
  'debugger.getTargets'() {
    const targets = [];
    for (const win of this.ctx.windows) {
      for (const tab of win.tabs) {
        targets.push({
          type: 'page',
          id: String(tab.id),
          tabId: tab.id,
          title: tab.title,
          url: tab.url,
          faviconUrl: tab.favicon || undefined,
          attached: this.debuggerSessions.has(tab.id),
        });
      }
    }
    return targets;
  },

  // chrome.alarms ------------------------------------------------------------
  'alarms.create'({ extId }, name = '', info = {}) {
    const now = Date.now();
    let when = typeof info.when === 'number' ? info.when : null;
    const delay = typeof info.delayInMinutes === 'number' ? info.delayInMinutes : null;
    const period = typeof info.periodInMinutes === 'number' ? info.periodInMinutes : null;
    if (when === null) when = now + (delay ?? period ?? 0) * 60_000;
    const key = `${extId}\n${name}`;
    this.alarms.set(key, { extId, name, scheduledTime: when, ...(period ? { periodInMinutes: Math.max(period, 0.5) } : {}) });
    this.saveAlarms();
    this.armAlarm(key);
  },
  'alarms.get'({ extId }, name = '') {
    const alarm = this.alarms.get(`${extId}\n${name}`);
    return alarm ? this.publicAlarm(alarm) : undefined;
  },
  'alarms.getAll'({ extId }) {
    return [...this.alarms.values()].filter((a) => a.extId === extId).map((a) => this.publicAlarm(a));
  },
  'alarms.clear'({ extId }, name = '') {
    const key = `${extId}\n${name}`;
    const had = this.alarms.delete(key);
    clearTimeout(this.alarmTimers.get(key));
    this.alarmTimers.delete(key);
    this.saveAlarms();
    return had;
  },
  'alarms.clearAll'({ extId }) {
    let had = false;
    for (const [key, alarm] of [...this.alarms]) {
      if (alarm.extId !== extId) continue;
      had = true;
      this.alarms.delete(key);
      clearTimeout(this.alarmTimers.get(key));
      this.alarmTimers.delete(key);
    }
    this.saveAlarms();
    return had;
  },

  // chrome.offscreen ---------------------------------------------------------
  async 'offscreen.createDocument'({ extId }, params = {}) {
    const existing = this.offscreen.get(extId);
    if (existing && !existing.isDestroyed()) throw new Error('Only a single offscreen document may be created.');
    if (!params.url) throw new Error('offscreen.createDocument needs a url.');
    const url = new URL(params.url, `chrome-extension://${extId}/`).href;
    if (!url.startsWith(`chrome-extension://${extId}/`)) throw new Error('The offscreen document must be part of the extension.');
    const win = new BrowserWindow({
      show: false,
      width: 800,
      height: 600,
      skipTaskbar: true,
      webPreferences: { session: this.ses, sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
    });
    win.webContents.setAudioMuted(false);
    this.offscreen.set(extId, win);
    const state = { win, generation: 0, documentId: null, pending: null, ready: Promise.resolve() };
    this.offscreenIdentity.set(extId, state);
    win.webContents.on('did-start-navigation', (details) => {
      if (!details.isMainFrame || details.isSameDocument) return;
      state.generation += 1;
      state.documentId = null;
      state.pending?.resolve();
      state.pending = null;
      for (const [id, binding] of this.offscreenRequests) if (binding.state === state) this.discardOffscreenRequest(id);
    });
    win.webContents.on('did-finish-load', () => {
      const generation = state.generation;
      const pageUrl = win.webContents.getURL();
      if (!pageUrl.startsWith(`chrome-extension://${extId}/`)) return;
      const nonce = randomUUID();
      let settle;
      const registered = new Promise((resolve) => { settle = resolve; });
      state.pending = { nonce, generation, url: pageUrl, resolve: settle };
      const code = `chrome.runtime.sendMessage(${JSON.stringify({ type: 'murshid-offscreen-document-identity', nonce })})`;
      let timer;
      state.ready = Promise.race([
        registered,
        new Promise((resolve) => { timer = setTimeout(resolve, 5000); }),
      ]).finally(() => {
        clearTimeout(timer);
        if (state.pending?.nonce === nonce) state.pending = null;
      });
      win.webContents.executeJavaScript(code).catch(() => {});
    });
    win.on('closed', () => {
      state.pending?.resolve();
      for (const [id, binding] of this.offscreenRequests) if (binding.state === state) this.discardOffscreenRequest(id);
      if (this.offscreen.get(extId) === win) this.offscreen.delete(extId);
      if (this.offscreenIdentity.get(extId) === state) this.offscreenIdentity.delete(extId);
    });
    try {
      await win.loadURL(url);
      await state.ready;
    } catch (error) {
      if (!win.isDestroyed()) win.destroy();
      throw error;
    }
  },
  'offscreen.closeDocument'({ extId }) {
    const win = this.offscreen.get(extId);
    if (!win || win.isDestroyed()) throw new Error('No current offscreen document.');
    this.offscreen.delete(extId);
    this.offscreenIdentity.delete(extId);
    win.destroy();
  },
  'offscreen.hasDocument'({ extId }) {
    const win = this.offscreen.get(extId);
    return Boolean(win && !win.isDestroyed());
  },

  // chrome.runtime.getContexts (missing in Electron) ----------------------------
  'runtime.getContexts'({ extId }, filter = {}) {
    const prefix = `chrome-extension://${extId}/`;
    const contexts = [];
    if (this.runningWorker(prefix)) {
      contexts.push({ contextType: 'BACKGROUND', contextId: `bg-${extId}`, tabId: -1, windowId: -1, frameId: -1, incognito: false, documentUrl: undefined, documentOrigin: undefined });
    }
    for (const wc of allWebContents.getAllWebContents()) {
      if (wc.isDestroyed() || wc.session !== this.ses) continue;
      let url = '';
      try { url = wc.getURL(); } catch {}
      if (!url.startsWith(prefix)) continue;
      const win = this.ctx.windowForTab(wc.id);
      const panel = this.panelContents.get(wc.id);
      const offscreen = [...this.offscreen.values()].some((w) => !w.isDestroyed() && w.webContents === wc);
      const contextType = offscreen ? 'OFFSCREEN_DOCUMENT' : panel ? 'SIDE_PANEL' : win ? 'TAB' : 'POPUP';
      contexts.push({
        contextType,
        contextId: `wc-${wc.id}`,
        tabId: win ? wc.id : -1,
        windowId: (win || panel?.win)?.id ?? -1,
        frameId: 0,
        documentUrl: url,
        documentOrigin: prefix.slice(0, -1),
        ...(offscreen && this.offscreenIdentity.get(extId)?.win.webContents === wc && this.offscreenIdentity.get(extId)?.documentId
          ? { documentId: this.offscreenIdentity.get(extId).documentId } : {}),
        incognito: false,
      });
    }
    return contexts.filter((c) => {
      if (Array.isArray(filter.contextTypes) && !filter.contextTypes.includes(c.contextType)) return false;
      if (Array.isArray(filter.documentUrls) && !filter.documentUrls.includes(c.documentUrl)) return false;
      if (Array.isArray(filter.tabIds) && !filter.tabIds.includes(c.tabId)) return false;
      if (Array.isArray(filter.windowIds) && !filter.windowIds.includes(c.windowId)) return false;
      return true;
    });
  },

  // chrome.tabs additions -------------------------------------------------------
  async 'tabs.captureVisibleTab'(_ctx, windowId, options = {}) {
    const win = this.windowFor(typeof windowId === 'number' ? windowId : undefined);
    const tab = win?.activeTab;
    if (!tab) throw new Error('No active tab to capture.');
    const image = await tab.wc.capturePage();
    if (options?.format === 'png') return image.toDataURL();
    const quality = Number.isFinite(options?.quality) ? Math.max(0, Math.min(100, options.quality)) : 92;
    return `data:image/jpeg;base64,${image.toJPEG(quality).toString('base64')}`;
  },
  'tabs.group'(_ctx, options = {}) {
    const tabIds = [].concat(options.tabIds ?? []).map(Number).filter(Number.isFinite);
    let group = typeof options.groupId === 'number' ? this.groups.get(options.groupId) : null;
    if (!group) {
      const first = tabIds[0];
      const win = first !== undefined ? this.ctx.windowForTab(first) : this.ctx.lastFocusedWindow();
      group = { id: this.nextGroupId++, title: '', color: 'grey', collapsed: false, windowId: win?.id ?? -1, tabIds: new Set() };
      this.groups.set(group.id, group);
    }
    for (const id of tabIds) {
      for (const other of this.groups.values()) other.tabIds.delete(id);
      group.tabIds.add(id);
    }
    return group.id;
  },
  'tabs.ungroup'(_ctx, tabIds) {
    for (const id of [].concat(tabIds ?? []).map(Number)) {
      for (const group of this.groups.values()) group.tabIds.delete(id);
    }
  },
  'tabs.groupOf'(_ctx, tabId) {
    for (const group of this.groups.values()) if (group.tabIds.has(tabId)) return group.id;
    return -1;
  },
  // chrome:// targets an extension asks for. "The browser's own new tab page"
  // (what WebBrain's new tab gate falls back to when it is switched off) is
  // Murshid's plain start page, never the WebBrain override again.
  'tabs.navigateInternal'(_ctx, tabId, url) {
    const { win } = this.tabContents(tabId);
    win.getTab(Number(tabId))?.load(internalTarget(url));
  },
  'tabs.createInternal'(_ctx, url, active = true) {
    const win = this.ctx.lastFocusedWindow() || this.ctx.createWindow({ empty: true });
    const tab = win.addTab({ url: internalTarget(url), active });
    return tab.id;
  },

  // chrome.tabGroups --------------------------------------------------------------
  'tabGroups.get'(_ctx, groupId) {
    const group = this.groups.get(groupId);
    if (!group) throw new Error(`No group with id: ${groupId}.`);
    return publicGroup(group);
  },
  'tabGroups.query'(_ctx, info = {}) {
    return [...this.groups.values()]
      .filter((g) => g.tabIds.size > 0)
      .filter((g) => (info.title === undefined || g.title === info.title)
        && (info.color === undefined || g.color === info.color)
        && (info.collapsed === undefined || g.collapsed === info.collapsed)
        && (info.windowId === undefined || info.windowId === -2 || g.windowId === info.windowId))
      .map(publicGroup);
  },
  'tabGroups.update'(_ctx, groupId, props = {}) {
    const group = this.groups.get(groupId);
    if (!group) throw new Error(`No group with id: ${groupId}.`);
    for (const key of ['title', 'color', 'collapsed']) if (props[key] !== undefined) group[key] = props[key];
    return publicGroup(group);
  },
  'tabGroups.move'(_ctx, groupId) {
    const group = this.groups.get(groupId);
    if (!group) throw new Error(`No group with id: ${groupId}.`);
    return publicGroup(group);
  },

  // chrome.downloads ------------------------------------------------------------------
  'downloads.download'(_ctx, options) { return this.ctx.downloads.start(options); },
  'downloads.search'(_ctx, query) { return this.ctx.downloads.search(query); },
  'downloads.pause'(_ctx, id) { return this.ctx.downloads.control(id, 'pause'); },
  'downloads.resume'(_ctx, id) { return this.ctx.downloads.control(id, 'resume'); },
  'downloads.cancel'(_ctx, id) { return this.ctx.downloads.control(id, 'cancel'); },
  'downloads.erase'(_ctx, query) { return this.ctx.downloads.erase(query); },
  'downloads.removeFile'(_ctx, id) { return this.ctx.downloads.removeFile(id); },
  'downloads.open'(_ctx, id) { return this.ctx.downloads.open(id); },
  'downloads.show'(_ctx, id) { return this.ctx.downloads.show(id); },
  'downloads.showDefaultFolder'() { shell.openPath(this.ctx.downloads.folder()); },
  'downloads.getFileIcon'(_ctx, id, options) { return this.ctx.downloads.icon(id, options); },
  'downloads.acceptDanger'() {},
  'downloads.setUiOptions'() {},
  'downloads.setShelfEnabled'() {},

  // chrome.identity -------------------------------------------------------------------
  'identity.launchWebAuthFlow'({ extId }, details = {}) {
    return launchWebAuthFlow(this, extId, details);
  },

  // chrome.search ----------------------------------------------------------------------
  'search.query'(_ctx, info = {}) {
    const url = this.ctx.settings.searchUrl(String(info.text || ''));
    const disposition = info.disposition || 'CURRENT_TAB';
    if (typeof info.tabId === 'number' && disposition === 'CURRENT_TAB') {
      const { win } = this.tabContents(info.tabId);
      win.getTab(info.tabId)?.load(url);
      return;
    }
    if (disposition === 'NEW_WINDOW') {
      this.ctx.createWindow({ url });
      return;
    }
    const win = this.ctx.lastFocusedWindow() || this.ctx.createWindow({ empty: true });
    if (disposition === 'NEW_TAB') win.addTab({ url });
    else if (win.activeTab) win.activeTab.load(url);
    else win.addTab({ url });
  },

  // chrome.tabCapture ------------------------------------------------------------------
  'tabCapture.getMediaStreamId'() {
    throw new Error('Tab capture is not available in Murshid yet.');
  },
};

function internalTarget(url) {
  const mapped = mapInternal(url);
  if (mapped === 'murshid://newtab') return 'murshid://newtab/';
  return /^murshid:/.test(mapped) ? mapped : 'murshid://newtab/';
}

function publicGroup(group) {
  return { id: group.id, title: group.title, color: group.color, collapsed: group.collapsed, windowId: group.windowId };
}

function launchWebAuthFlow(bridge, extId, { url, interactive = false } = {}) {
  return new Promise((resolve, reject) => {
    if (!url) {
      reject(new Error('launchWebAuthFlow needs a url.'));
      return;
    }
    const redirectPrefix = `https://${extId}.chromiumapp.org/`;
    const parent = bridge.ctx.lastFocusedWindow()?.win;
    const popup = new BrowserWindow({
      width: 520,
      height: 700,
      show: false,
      parent,
      modal: false,
      autoHideMenuBar: true,
      icon: bridge.ctx.icon,
      webPreferences: { session: bridge.ses, sandbox: true, contextIsolation: true },
    });
    let done = false;
    const finish = (error, responseUrl) => {
      if (done) return;
      done = true;
      if (!popup.isDestroyed()) popup.destroy();
      if (error) reject(error);
      else resolve(responseUrl);
    };
    const check = (event, target) => {
      if (target && target.startsWith(redirectPrefix)) {
        event?.preventDefault?.();
        finish(null, target);
      }
    };
    popup.webContents.on('will-redirect', (event) => check(event, event.url));
    popup.webContents.on('will-navigate', (event) => check(event, event.url));
    popup.webContents.on('did-fail-load', (_e, _c, _d, validatedURL) => check(null, validatedURL));
    popup.webContents.on('did-finish-load', () => {
      if (interactive && !popup.isDestroyed() && !done) popup.show();
    });
    popup.on('closed', () => finish(new Error('The user did not approve access.')));
    if (!interactive) {
      setTimeout(() => finish(new Error('User interaction required.')), 15_000);
    }
    popup.loadURL(url).catch(() => {});
  });
}

function safeUrl(wc) {
  try {
    return wc?.getURL() || '';
  } catch {
    return '';
  }
}

function extIdFromUrl(url) {
  const match = /^chrome-extension:\/\/([a-p]{32})\//.exec(url || '');
  return match ? match[1] : null;
}

function stripSlash(p) {
  return String(p).replace(/^\/+/, '');
}

module.exports = { CrxBridge, extIdFromUrl };
