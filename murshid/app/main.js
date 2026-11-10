'use strict';

// Murshid — a Chromium browser (Electron) with WebBrain built in: the WebBrain
// extension and its new tab page are preinstalled, the WebBrain side panel is
// part of the window, and WebBrain Companion runs in the system tray.

const { app, BrowserWindow, ipcMain, nativeImage, session, webContents: allWebContents } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { ElectronChromeExtensions } = require('electron-chrome-extensions');

const paths = require('./paths');
const { Settings, SEARCH_ENGINES, LANGUAGES, searchQueryOf } = require('./settings');
const i18n = require('./i18n');
const { History } = require('./history');
const { Omnibox } = require('./omnibox');
const { MurshidWindow } = require('./window');
const { CrxBridge, extIdFromUrl } = require('./crx/bridge');
const { Downloads } = require('./downloads');
const { createCommands } = require('./commands');
const { installAppMenu, popupMainMenu, popupTabMenu } = require('./menu');
const { showContextMenu } = require('./context-menu');
const { Companion } = require('./companion');
const { installPermissions } = require('./permissions');
const { registerSchemes, handleProtocol } = require('./protocol');
const { resolveInput } = require('./url');
const { urlsFromArgs } = require('./open-arguments');
const identity = require('./identity');
const { Adblock } = require('./adblock');
const { Updates } = require('./updates');

const PERSISTENT_PARTITION = 'persist:murshid';
const TEMPORARY_PARTITION = 'murshid-temporary';
const DEBUG = process.argv.includes('--murshid-devtools') || process.env.MURSHID_DEBUG === '1';

app.setName('Murshid');
if (process.env.MURSHID_PROFILE) app.setPath('userData', path.resolve(process.env.MURSHID_PROFILE));
if (process.platform === 'win32') app.setAppUserModelId('one.webbrain.murshid');
// A language picked in Settings also becomes Chromium's locale, so native menus
// and dialogs lay out right to left for Arabic and Persian. (On macOS the system
// language still decides those.) "Automatic" leaves Chromium on the system's.
const pickedLanguage = i18n.savedLanguage(app.getPath('userData'));
if (pickedLanguage) app.commandLine.appendSwitch('lang', pickedLanguage);
registerSchemes();

// Sites see Chrome's reduced user agent string; "Electron" in it gets some
// sign-in pages to refuse the browser. The client hints that name Murshid (or
// Google Chrome) are added in app/identity.js.
app.userAgentFallback = identity.userAgent(app.userAgentFallback);

let startupComplete = false;
const pendingUrls = [];
function openDestinations(urls) {
  if (!startupComplete) { pendingUrls.push(...urls); return; }
  if (!urls.length) return;
  const w = ctx.lastFocusedWindow() || ctx.createWindow({ empty: true });
  if (w.win.isMinimized()) w.win.restore();
  w.win.focus();
  urls.forEach((url) => w.addTab({ url }));
}
app.on('open-url', (event, url) => {
  event.preventDefault();
  if (/^https?:/i.test(url)) openDestinations([url]);
});
app.on('open-file', (event, file) => {
  event.preventDefault();
  if (/\.html?$/i.test(file)) openDestinations([pathToFileURL(path.resolve(file)).href]);
});

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_event, argv) => {
    const urls = urlsFromArgs(argv);
    if (urls.length) openDestinations(urls);
    else if (startupComplete) (ctx.lastFocusedWindow() || ctx.createWindow({ empty: true })).addTab({});
  });
  app.whenReady().then(start).catch((error) => {
    console.error('[murshid] failed to start:', error);
    app.exit(1);
  });
}

const ctx = {
  ses: null,
  adblock: null,
  extensions: null,
  crx: null,
  downloads: null,
  companion: null,
  updates: null,
  commands: null,
  settings: null,
  icon: null,
  userData: null,
  windows: [],
  focusOrder: [],
  webBrainId: null,
  webBrain: null,
  quitting: false,

  newTabUrl() {
    const override = this.webBrain?.manifest?.chrome_url_overrides?.newtab;
    return this.webBrainId && override ? `chrome-extension://${this.webBrainId}/${override}` : 'murshid://newtab/';
  },
  newTabUrls() {
    const list = ['murshid://newtab/', 'murshid://newtab'];
    const override = this.webBrain?.manifest?.chrome_url_overrides?.newtab;
    if (this.webBrainId && override) list.push(`chrome-extension://${this.webBrainId}/${override}`);
    return list;
  },
  webBrainInfo() {
    if (!this.webBrain) return { loaded: false, version: null, icon: null };
    if (this.webBrainIcon === undefined) {
      const icon = path.join(this.webBrain.path, 'icons', 'icon48.png');
      this.webBrainIcon = fs.existsSync(icon) ? pathToFileURL(icon).href : null;
    }
    return { loaded: true, version: this.webBrain.version, icon: this.webBrainIcon };
  },

  createWindow({ url, empty = false, bounds } = {}) {
    const w = new MurshidWindow(this, { bounds });
    this.windows.push(w);
    this.focusOrder.unshift(w);
    if (!empty) w.addTab({ url: url || 'murshid://newtab' });
    return w;
  },
  lastFocusedWindow() {
    const focused = BrowserWindow.getFocusedWindow();
    const hit = focused && this.windows.find((w) => w.win === focused);
    return hit || this.focusOrder.find((w) => !w.win.isDestroyed()) || null;
  },
  onWindowFocused(w) {
    this.focusOrder = [w, ...this.focusOrder.filter((x) => x !== w)];
  },
  onWindowClosed(w) {
    this.windows = this.windows.filter((x) => x !== w);
    this.focusOrder = this.focusOrder.filter((x) => x !== w);
    if (!this.windows.length && process.platform !== 'darwin') app.quit();
  },
  windowForTab(tabId) {
    return this.windows.find((w) => w.tabs.some((t) => t.id === tabId)) || null;
  },
  windowsForTab(tabId) {
    const w = this.windowForTab(tabId);
    return w ? [w] : [];
  },
  windowForContents(wc) {
    if (!wc) return null;
    return this.windows.find((w) => w.ui === wc || w.tabs.some((t) => t.wc === wc)
      || [...w.panelViews.values()].some((p) => p.view.webContents === wc)) || null;
  },
  contextMenu(tab, params, contents) {
    showContextMenu(this, tab, params, contents);
  },
  refreshAllWindows() {
    this.windows.forEach((w) => w.scheduleState());
  },
  sendExtensionCommand(w, name) {
    if (!this.webBrainId || !w?.activeTab) return;
    const details = this.extensions.ctx?.store?.tabDetailsCache?.get(w.activeTab.id);
    this.extensions.ctx?.router?.sendEvent(this.webBrainId, 'commands.onCommand', name, details);
  },
  rememberSession() {},
  quit() {
    this.quitting = true;
    app.quit();
  },
};

async function start() {
  ctx.userData = app.getPath('userData');
  ctx.settings = new Settings();
  i18n.setLocale(i18n.resolve(ctx.settings.get('language'), app.getLocale(), app.getPreferredSystemLanguages()));
  i18n.setFrameLocale(app.getLocale());
  // The browser chrome and murshid:// pages ask for their strings from their
  // preloads, before anything is drawn.
  ipcMain.on('murshid-i18n', (event) => { event.returnValue = i18n.bundle(); });
  ctx.history = new History({ searchQueryOf, persist: ctx.settings.get('persistBrowserSession') !== false });
  ctx.icon = nativeImage.createFromPath(paths.appIcon());
  if (ctx.icon.isEmpty()) ctx.icon = undefined;

  const ses = session.fromPartition(ctx.settings.get('persistBrowserSession') === false
    ? TEMPORARY_PARTITION : PERSISTENT_PARTITION);
  ctx.ses = ses;
  ses.setUserAgent(app.userAgentFallback);
  ctx.adblock = new Adblock({ settings: ctx.settings, userData: ctx.userData });
  identity.install(ses, ctx.settings, ctx);
  ctx.adblock.install(ses);
  handleProtocol(ses);

  // Order matters: Murshid's "pre" preload adds APIs before
  // electron-chrome-extensions freezes `chrome`; the "post" one patches after.
  ses.registerPreloadScript({ id: 'murshid-crx-pre-frame', type: 'frame', filePath: path.join(__dirname, 'crx', 'preload-pre.js') });
  ses.registerPreloadScript({ id: 'murshid-crx-pre-sw', type: 'service-worker', filePath: path.join(__dirname, 'crx', 'preload-pre.js') });

  ctx.extensions = new ElectronChromeExtensions({
    license: 'GPL-3.0',
    session: ses,
    createTab: async (details) => {
      let w = typeof details.windowId === 'number' ? ctx.windows.find((x) => x.id === details.windowId) : null;
      w = w || ctx.lastFocusedWindow() || ctx.createWindow({ empty: true });
      const tab = w.addTab({ url: details.url || 'murshid://newtab', active: details.active !== false, index: details.index });
      return [tab.wc, w.win];
    },
    selectTab: (wc) => {
      const w = ctx.windowForTab(wc.id);
      const tab = w?.getTab(wc.id);
      if (tab && w.activeTab !== tab) w.selectTab(tab);
    },
    removeTab: (wc) => {
      const w = ctx.windowForTab(wc.id);
      const tab = w?.getTab(wc.id);
      if (tab && !wc.isDestroyed()) w.closeTab(tab);
    },
    createWindow: async (details) => {
      const urls = [].concat(details.url || []);
      const w = ctx.createWindow({ url: urls[0], empty: false });
      urls.slice(1).forEach((url) => w.addTab({ url, active: false }));
      return w.win;
    },
    removeWindow: (browserWindow) => {
      if (!browserWindow.isDestroyed()) browserWindow.close();
    },
    assignTabDetails: (details, wc) => {
      if (!ctx.crx) return;
      let groupId = -1;
      for (const group of ctx.crx.groups.values()) if (group.tabIds.has(wc.id)) groupId = group.id;
      details.groupId = groupId;
    },
  });

  ses.registerPreloadScript({ id: 'murshid-crx-post-frame', type: 'frame', filePath: path.join(__dirname, 'crx', 'preload-post.js') });
  ses.registerPreloadScript({ id: 'murshid-crx-post-sw', type: 'service-worker', filePath: path.join(__dirname, 'crx', 'preload-post.js') });
  ses.registerPreloadScript({ id: 'murshid-pages', type: 'frame', filePath: path.join(__dirname, 'pages', 'preload.js') });

  ctx.crx = new CrxBridge(ctx);
  ctx.omnibox = new Omnibox(ctx);
  ctx.downloads = new Downloads(ctx);
  ctx.downloads.on('update', () => ctx.refreshAllWindows());
  ctx.commands = createCommands(ctx);
  ctx.companion = new Companion(ctx);
  const { autoUpdater, shell } = require('electron');
  ctx.updates = new Updates({ version: app.getVersion(), packaged: app.isPackaged,
    nativeUpdater: autoUpdater, openExternal: url => shell.openExternal(url) });
  ctx.updates.on('change', () => ctx.refreshAllWindows());
  autoUpdater.on('before-quit-for-update', () => {
    ctx.quitting = true; ctx.settings?.flush(); ctx.history?.flush();
  });
  installPermissions(ctx);
  installAppMenu(ctx);
  installUiIpc();
  installPageIpc();
  installLogging(ses);

  // Electron only supports extensions in persistent sessions.
  if (ctx.settings.get('persistBrowserSession') !== false) await loadWebBrain(ses);
  if (ctx.webBrainId) await Promise.race([ctx.crx.defaultsReady, new Promise((r) => setTimeout(r, 2500))]);

  const urls = [...urlsFromArgs(process.argv), ...pendingUrls.splice(0)];
  if (!ctx.windows.length) {
    const w = ctx.createWindow({ url: urls[0] });
    urls.slice(1).forEach((url) => w.addTab({ url, active: false }));
  } else {
    // WebBrain's first-run page already opened a window.
    const w = ctx.windows[0];
    urls.forEach((url) => w.addTab({ url }));
  }
  startupComplete = true;
  openDestinations(pendingUrls.splice(0));

  ctx.companion.ensureRunning().catch(() => {});
  if (app.isPackaged && ctx.settings.get('checkUpdates') !== false) ctx.updates.start();

  app.on('activate', () => {
    if (!ctx.windows.length) ctx.createWindow({});
  });
}

async function loadWebBrain(ses) {
  const dir = paths.webBrainExtensionDir();
  if (!dir) {
    console.warn('[murshid] WebBrain extension not found; starting without it.');
    return;
  }
  try {
    const extension = await ses.extensions.loadExtension(dir, { allowFileAccess: true });
    ctx.webBrainId = extension.id;
    ctx.webBrain = extension;
    console.log(`[murshid] WebBrain ${extension.version} loaded as ${extension.id} from ${dir}`);
  } catch (error) {
    console.error('[murshid] could not load WebBrain:', error);
  }
}

function installLogging(ses) {
  const logDir = path.join(ctx.userData, 'logs');
  fs.mkdirSync(logDir, { recursive: true });
  const logFile = path.join(logDir, 'extensions.log');
  const stream = fs.createWriteStream(logFile, { flags: 'w' });
  const levelName = (level) => (typeof level === 'string' ? level : ['debug', 'info', 'warning', 'error'][level] || String(level));
  ses.serviceWorkers.on('console-message', (_event, details) => {
    const level = levelName(details.level);
    // electron-chrome-extensions logs every API call at info level; keep warnings and errors.
    if (!DEBUG && (level === 'debug' || level === 'info' || level === 'log')) return;
    const line = `[sw ${level}] ${details.message} (${details.sourceUrl || ''}:${details.lineNumber || ''})`;
    stream.write(`${new Date().toISOString()} ${line}\n`);
    if (DEBUG) console.log(line);
  });
  app.on('web-contents-created', (_event, wc) => {
    if (wc.session !== ses) return;
    wc.on('console-message', (details) => {
      let url = '';
      try { url = wc.getURL(); } catch {}
      if (!url.startsWith('chrome-extension://')) return;
      const level = levelName(details.level);
      if (!DEBUG && level !== 'warning' && level !== 'error') return;
      stream.write(`${new Date().toISOString()} [page ${level}] ${details.message} (${details.sourceId || url}:${details.lineNumber || ''})\n`);
    });
    wc.on('preload-error', (_e, preloadPath, error) => {
      stream.write(`${new Date().toISOString()} [preload-error] ${preloadPath}: ${error?.stack || error}\n`);
    });
  });
}

// ------------------------------------------------------------------- chrome UI IPC

function installUiIpc() {
  const windowOf = (sender) => ctx.windows.find((w) => w.ui === sender
    || w.shield?.webContents === sender
    || w.omniPopup?.owns(sender));
  ipcMain.handle('murshid-ui', (event, command, ...args) => {
    const w = windowOf(event.sender);
    if (!w) return null;
    const tab = w.activeTab;
    const byId = (id) => w.getTab(Number(id));
    switch (command) {
      case 'ready':
        w.uiReady = true;
        w.pushState();
        if (w.focusOmniboxWhenReady) {
          w.focusOmniboxWhenReady = false;
          w.focusOmnibox();
        }
        return { searchEngine: SEARCH_ENGINES[ctx.settings.get('searchEngine')]?.name };
      case 'layout':
        w.setChromeHeight(args[0]);
        return null;
      case 'newTab':
        w.addTab({});
        return null;
      case 'closeTab':
        w.closeTab(byId(args[0]));
        return null;
      case 'selectTab':
        w.selectTab(byId(args[0]));
        return null;
      case 'moveTab':
        w.moveTab(byId(args[0]), Number(args[1]));
        return null;
      case 'mute': {
        const t = byId(args[0]);
        if (t) t.wc.setAudioMuted(!t.wc.isAudioMuted());
        w.scheduleState();
        return null;
      }
      case 'navigate': {
        // kind: 'input' (typed text), 'url' (a suggestion's address) or 'search' (a query).
        const [text, options] = args;
        const raw = String(text || '');
        const url = options?.kind === 'search'
          ? ctx.settings.searchUrl(raw.trim())
          : resolveInput(raw, (q) => ctx.settings.searchUrl(q));
        w.omniPopup.hide();
        if (options?.newTab || !tab) {
          w.addTab({ url, after: tab || undefined }).typedPending = true;
          return null;
        }
        tab.typedPending = true; // the visit this starts counts as typed in history
        tab.load(url);
        tab.wc.focus();
        return null;
      }
      case 'suggest':
        return ctx.omnibox.suggest(w, args[0], args[1] || {});
      case 'omniboxFocus':
        w.omniPopup.ensure(); // load the list's page before the first keystroke
        return null;
      case 'omniboxBlur':
        // The address bar lost focus. If it went to the suggestion list (a click
        // there), keep editing; the list hands focus back or picks a row.
        if (w.omniPopup.isFocused()) return true;
        w.omniPopup.hide();
        return false;
      case 'popupRender':
        w.omniPopup.show(args[0] || {});
        return null;
      case 'popupHide':
        w.omniPopup.hide();
        return null;
      case 'popupPick':
        w.ui.send('murshid:popup-pick', { index: Number(args[0]) || 0, newTab: Boolean(args[1]?.newTab) });
        return null;
      case 'popupRefocus':
        w.ui.focus();
        w.ui.send('murshid:omnibox-refocus');
        return null;
      case 'switchToTab': {
        const id = Number(args[0]);
        const target = ctx.windowForTab(id);
        const t = target?.getTab(id);
        w.omniPopup.hide();
        if (!t) return false;
        target.selectTab(t);
        if (target !== w) target.win.focus();
        return true;
      }
      case 'historyRemove': {
        const { url, query } = args[0] || {};
        return ctx.history.remove({ url: url ? String(url) : undefined, query: query ? String(query) : undefined });
      }
      case 'back': return ctx.commands.run.back(w);
      case 'forward': return ctx.commands.run.forward(w);
      case 'reload': return ctx.commands.run.reload(w);
      case 'stop': return ctx.commands.run.stop(w);
      case 'home': return ctx.commands.run.home(w);
      case 'webBrain':
        ctx.crx.togglePanelForActiveTab(w);
        return null;
      case 'panelClose':
        ctx.crx.closePanelInWindow(w);
        return null;
      case 'panelResizeStart':
        startPanelDrag(w);
        return null;
      case 'panelResize':
        w.resizePanel(Number(args[0]));
        return null;
      case 'panelResizeEnd':
        endPanelDrag(w);
        return null;
      case 'updates':
        ctx.commands.run.updates(w);
        return null;
      case 'mainMenu':
        popupMainMenu(ctx, w, args[0] || { x: 0, y: 0 });
        return null;
      case 'tabMenu': {
        const t = byId(args[0]);
        if (t) popupTabMenu(ctx, w, t, args[1] || { x: 0, y: 0 });
        return null;
      }
      case 'downloadsMenu':
        popupDownloadsMenu(w, args[0] || { x: 0, y: 0 });
        return null;
      case 'find': {
        const [text, options] = args;
        if (!tab) return null;
        if (!text) {
          tab.wc.stopFindInPage('clearSelection');
          return null;
        }
        tab.wc.findInPage(String(text), { forward: options?.forward !== false, findNext: Boolean(options?.findNext), matchCase: false });
        return null;
      }
      case 'findStop': {
        const options = args[1] || {};
        const findTab = options.tabId == null ? tab : byId(options.tabId);
        findTab?.wc.stopFindInPage(args[0] === 'activate' ? 'activateSelection' : 'clearSelection');
        if (options.focusContent !== false) findTab?.wc.focus();
        return null;
      }
      case 'focusContent':
        tab?.wc.focus();
        return null;
      case 'windowControl':
        if (args[0] === 'minimize') w.win.minimize();
        else if (args[0] === 'maximize') (w.win.isMaximized() ? w.win.unmaximize() : w.win.maximize());
        else if (args[0] === 'close') w.win.close();
        return null;
      default:
        return null;
    }
  });
}

function startPanelDrag(w) {
  const { WebContentsView } = require('electron');
  if (w.shield) return;
  const shield = new WebContentsView({
    webPreferences: { preload: path.join(__dirname, 'ui', 'preload.js'), contextIsolation: true, sandbox: true },
  });
  shield.setBackgroundColor('#00000000');
  const { width, height } = w.win.getContentBounds();
  shield.setBounds({ x: 0, y: 0, width, height });
  w.win.contentView.addChildView(shield);
  shield.webContents.loadFile(path.join(__dirname, 'ui', 'shield.html'));
  shield.webContents.on('before-input-event', (event, input) => {
    if (input.type === 'keyDown' && input.key === 'Escape') {
      event.preventDefault();
      endPanelDrag(w);
    }
  });
  w.shield = shield;
}

function endPanelDrag(w) {
  const shield = w.shield;
  if (!shield) return;
  w.shield = null;
  try { w.win.contentView.removeChildView(shield); } catch {}
  try { shield.webContents.close(); } catch {}
}

function popupDownloadsMenu(w, { x, y }) {
  const { Menu, shell } = require('electron');
  const summary = ctx.downloads.summary();
  const items = summary.recent.map((d) => {
    const resumable = d.state === 'interrupted' && d.canResume;
    const status = d.state === 'in_progress'
      ? (d.progress !== null ? i18n.percent(Math.round(d.progress * 100)) : i18n.t('downloads.downloading'))
      : d.state === 'complete' ? '' : resumable ? i18n.t('downloads.interrupted') : i18n.t('downloads.failed');
    return {
      label: status ? i18n.t('downloads.status', { name: d.name, status }) : d.name,
      submenu: [
        { label: i18n.t('downloads.open'), enabled: d.state === 'complete', click: () => ctx.downloads.open(d.id).catch(() => {}) },
        { label: i18n.t('downloads.showInFolder'), enabled: d.state !== 'in_progress', click: () => ctx.downloads.show(d.id) },
        { label: i18n.t(d.paused || resumable ? 'downloads.resume' : 'downloads.pause'), visible: d.state === 'in_progress' || resumable, click: () => ctx.downloads.control(d.id, d.paused || resumable ? 'resume' : 'pause') },
        { label: i18n.t('downloads.cancel'), visible: d.state === 'in_progress' || resumable, click: () => ctx.downloads.control(d.id, 'cancel') },
      ],
    };
  });
  if (!items.length) items.push({ label: i18n.t('downloads.none'), enabled: false });
  items.push({ type: 'separator' }, { label: i18n.t('downloads.openFolder'), click: () => shell.openPath(ctx.downloads.folder()) });
  Menu.buildFromTemplate(items).popup({ window: w.win, x: Math.round(x), y: Math.round(y) });
}

// ---------------------------------------------------------------- murshid:// page IPC

function installPageIpc() {
  ipcMain.handle('murshid-page', (event, command, ...args) => {
    let url = '';
    try { url = event.senderFrame?.url || event.sender.getURL(); } catch {}
    if (!url.startsWith('murshid://')) return null;
    const w = ctx.windowForContents(event.sender);
    const tab = w?.tabs.find((t) => t.wc === event.sender);
    // Update actions belong only to an owned, top-level Updates page.
    if (['updateStatus', 'checkUpdates', 'downloadUpdate', 'installUpdate'].includes(command)) {
      if (!tab || event.senderFrame !== event.sender.mainFrame || new URL(url).hostname !== 'updates') return null;
      if (command === 'updateStatus') return ctx.updates.snapshot();
      if (command === 'checkUpdates') return ctx.updates.check();
      if (command === 'downloadUpdate') return ctx.updates.download();
      return ctx.updates.install();
    }
    switch (command) {
      case 'info':
        return {
          version: app.getVersion(),
          chrome: process.versions.chrome,
          electron: process.versions.electron,
          node: process.versions.node,
          v8: process.versions.v8,
          platform: `${process.platform} ${process.arch}`,
          webBrain: ctx.webBrain ? { id: ctx.webBrainId, version: ctx.webBrain.version, path: ctx.webBrain.path } : null,
          companion: ctx.companion.status(),
          profile: ctx.userData,
          userAgent: app.userAgentFallback,
        };
      case 'settings':
        return {
          values: {
            language: ctx.settings.get('language'),
            searchEngine: ctx.settings.get('searchEngine'),
            searchSuggestions: ctx.settings.get('searchSuggestions'),
            startCompanion: ctx.settings.get('startCompanion'),
            identifyAsChrome: ctx.settings.get('identifyAsChrome'),
            adblock: ctx.settings.get('adblock'),
            persistBrowserSession: ctx.settings.get('persistBrowserSession'),
            checkUpdates: ctx.settings.get('checkUpdates'),
          },
          historyCount: ctx.history.count(),
          searchEngines: Object.entries(SEARCH_ENGINES).map(([id, e]) => ({ id, name: e.name })),
          languages: LANGUAGES.map((id) => ({
            id,
            name: id === 'auto' ? i18n.t('page.settings.languageAuto') : i18n.NATIVE_NAMES[id],
            lang: id === 'auto' ? i18n.locale() : id,
          })),
        };
      case 'setSetting': {
        const [key, value] = args;
        if (key === 'language' && LANGUAGES.includes(value)) {
          ctx.settings.set(key, value);
          ctx.settings.flush();
        }
        if (key === 'searchEngine' && SEARCH_ENGINES[value]) ctx.settings.set(key, value);
        if (key === 'startCompanion' || key === 'searchSuggestions') ctx.settings.set(key, Boolean(value));
        if (key === 'identifyAsChrome' || key === 'adblock') ctx.settings.set(key, Boolean(value));
        if (key === 'checkUpdates' && typeof value === 'boolean') {
          ctx.settings.set(key, value); ctx.settings.flush();
          if (app.isPackaged) { if (value) ctx.updates.start(); else ctx.updates.stop(); }
        }
        if (key === 'persistBrowserSession' && typeof value === 'boolean') {
          ctx.settings.set(key, value);
          ctx.settings.flush();
        }
        return true;
      }
      case 'clearHistory':
        ctx.history.clear();
        return ctx.history.count();
      case 'navigate': {
        const target = resolveInput(String(args[0] || ''), (q) => ctx.settings.searchUrl(q));
        if (tab) tab.load(target);
        return null;
      }
      case 'openWebBrain':
        if (w) ctx.crx.clickAction(w);
        return null;
      case 'companion':
        ctx.companion.openPanel(w);
        return null;
      default:
        return null;
    }
  });
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin' || ctx.quitting) app.quit();
});

app.on('before-quit', () => {
  ctx.updates?.stop();
  ctx.quitting = true;
  ctx.settings?.flush();
  ctx.history?.flush();
});

// Keep a handle on extension IDs for debugging from the console.
module.exports = { ctx, extIdFromUrl, allWebContents };
