'use strict';

// A Murshid browser window. The window's own webContents is the browser chrome
// (tab strip, toolbar, side panel header), drawn by app/ui. Tabs and the side
// panel are WebContentsViews laid over it.

const { BrowserWindow, WebContentsView, nativeTheme, screen } = require('electron');
const path = require('node:path');
const { Tab } = require('./tab');
const { displayUrl } = require('./url');

const DEFAULT_CHROME_HEIGHT = 80;
const PANEL_HEADER_HEIGHT = 40;
const SPLITTER_WIDTH = 5;
const PANEL_MIN = 320;
const PANEL_MAX_FRACTION = 0.6;

const THEME = {
  dark: { strip: '#140f0d', symbol: '#f1e6d0' },
  light: { strip: '#ece2cf', symbol: '#2a1d16' },
};

function themeColors() {
  return nativeTheme.shouldUseDarkColors ? THEME.dark : THEME.light;
}

class MurshidWindow {
  /**
   * @param {object} ctx shared app context (session, extensions, settings, ...)
   * @param {{bounds?: Electron.Rectangle}} [options]
   */
  constructor(ctx, { bounds } = {}) {
    this.ctx = ctx;
    this.tabs = [];
    this.activeTab = null;
    this.chromeHeight = DEFAULT_CHROME_HEIGHT;
    this.htmlFullscreen = false;
    this.panelViews = new Map(); // key -> { view, url }
    this.visiblePanelKey = null;
    this.closedTabs = [];
    this.stateTimer = null;
    this.uiReady = false;

    const isMac = process.platform === 'darwin';
    const colors = themeColors();
    const saved = bounds || this.ctx.settings.get('windowBounds');
    const area = screen.getPrimaryDisplay().workArea;
    const width = Math.min(saved?.width || 1360, area.width);
    const height = Math.min(saved?.height || 880, area.height);

    this.win = new BrowserWindow({
      width,
      height,
      ...(saved && Number.isFinite(saved.x) ? { x: saved.x, y: saved.y } : {}),
      minWidth: 520,
      minHeight: 380,
      show: false,
      title: 'Murshid',
      icon: ctx.icon,
      backgroundColor: colors.strip,
      titleBarStyle: isMac ? 'hiddenInset' : 'hidden',
      ...(isMac
        ? { trafficLightPosition: { x: 14, y: 12 } }
        : { titleBarOverlay: { color: colors.strip, symbolColor: colors.symbol, height: 38 } }),
      webPreferences: {
        preload: path.join(__dirname, 'ui', 'preload.js'),
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        spellcheck: false,
      },
    });
    this.id = this.win.id;
    this.ui = this.win.webContents;
    this.ui.loadFile(path.join(__dirname, 'ui', 'index.html'), {
      query: { platform: process.platform },
    });
    this.ui.on('before-input-event', (event, input) => this.ctx.commands.handleInput(event, input, this));
    this.ui.setWindowOpenHandler(() => ({ action: 'deny' }));
    this.ui.on('will-navigate', (event) => event.preventDefault());

    this.win.once('ready-to-show', () => this.win.show());
    this.win.on('resize', () => this.layout());
    this.win.on('maximize', () => this.scheduleState());
    this.win.on('unmaximize', () => this.scheduleState());
    this.win.on('enter-full-screen', () => { this.layout(); this.scheduleState(); });
    this.win.on('leave-full-screen', () => { this.htmlFullscreen = false; this.layout(); this.scheduleState(); });
    this.win.on('focus', () => {
      if (this.activeTab) this.ctx.extensions.selectTab(this.activeTab.wc);
      this.ctx.onWindowFocused?.(this);
    });
    this.win.on('close', () => this.rememberBounds());
    this.win.on('closed', () => this.onClosed());

    this.onTheme = () => {
      if (!isMac) {
        const c = themeColors();
        try { this.win.setTitleBarOverlay({ color: c.strip, symbolColor: c.symbol }); } catch {}
      }
    };
    nativeTheme.on('updated', this.onTheme);
  }

  // ---------------------------------------------------------------- tabs

  /**
   * @param {{url?: string, active?: boolean, after?: Tab, index?: number,
   *          webContents?: Electron.WebContents, webPreferences?: object}} options
   */
  addTab({ url, active = true, after, index, webContents, webPreferences } = {}) {
    const tab = new Tab(this, { url: webContents ? undefined : (url || 'murshid://newtab'), webContents, webPreferences });
    let at = this.tabs.length;
    if (Number.isInteger(index)) at = Math.max(0, Math.min(index, this.tabs.length));
    else if (after && this.tabs.includes(after)) at = this.tabs.indexOf(after) + 1;
    this.tabs.splice(at, 0, tab);
    this.ctx.extensions.addTab(tab.wc, this.win);
    tab.wc.once('destroyed', () => this.forgetTab(tab));
    if (active || !this.activeTab) this.selectTab(tab);
    else this.scheduleState();
    return tab;
  }

  getTab(id) {
    return this.tabs.find((tab) => tab.id === id) || null;
  }

  selectTab(tab) {
    if (!tab || !this.tabs.includes(tab)) return;
    const previous = this.activeTab;
    this.activeTab = tab;
    if (previous && previous !== tab && !previous.wc.isDestroyed()) {
      try { this.win.contentView.removeChildView(previous.view); } catch {}
    }
    this.win.contentView.addChildView(tab.view);
    this.ctx.extensions.selectTab(tab.wc);
    this.syncPanel();
    this.layout();
    this.scheduleState();
    if (tab.isNewTabPage()) this.focusOmnibox();
    else tab.wc.focus();
  }

  closeTab(tab) {
    if (!tab || !this.tabs.includes(tab)) return;
    const url = tab.url;
    if (url && !tab.isNewTabPage()) {
      this.closedTabs.push({ url, index: this.tabs.indexOf(tab) });
      if (this.closedTabs.length > 25) this.closedTabs.shift();
    }
    if (this.tabs.length === 1) {
      // Closing the last tab closes the window, like Chrome.
      this.forgetTab(tab);
      tab.destroy();
      this.win.close();
      return;
    }
    const idx = this.tabs.indexOf(tab);
    if (tab === this.activeTab) {
      const next = this.tabs[idx + 1] || this.tabs[idx - 1];
      this.selectTab(next);
    }
    this.forgetTab(tab);
    tab.destroy();
  }

  forgetTab(tab) {
    const idx = this.tabs.indexOf(tab);
    if (idx === -1) return;
    this.tabs.splice(idx, 1);
    try { this.win.contentView.removeChildView(tab.view); } catch {}
    try { if (!tab.wc.isDestroyed()) this.ctx.extensions.removeTab(tab.wc); } catch {}
    this.ctx.crx?.onTabRemoved(tab.id);
    this.destroyPanel(`tab:${tab.id}`);
    if (this.activeTab === tab) {
      this.activeTab = null;
      const next = this.tabs[Math.min(idx, this.tabs.length - 1)];
      if (next) this.selectTab(next);
    }
    this.scheduleState();
  }

  reopenClosedTab() {
    const entry = this.closedTabs.pop();
    if (entry) this.addTab({ url: entry.url, index: entry.index });
  }

  moveTab(tab, toIndex) {
    const from = this.tabs.indexOf(tab);
    if (from === -1) return;
    this.tabs.splice(from, 1);
    this.tabs.splice(Math.max(0, Math.min(toIndex, this.tabs.length)), 0, tab);
    this.scheduleState();
  }

  cycleTab(delta) {
    if (!this.activeTab || this.tabs.length < 2) return;
    const idx = this.tabs.indexOf(this.activeTab);
    this.selectTab(this.tabs[(idx + delta + this.tabs.length) % this.tabs.length]);
  }

  selectTabIndex(n) {
    const tab = n === 9 ? this.tabs[this.tabs.length - 1] : this.tabs[n - 1];
    if (tab) this.selectTab(tab);
  }

  // -------------------------------------------------------------- layout

  setChromeHeight(height) {
    const value = Math.max(0, Math.min(200, Math.round(height)));
    if (value === this.chromeHeight) return;
    this.chromeHeight = value;
    this.layout();
  }

  setHtmlFullscreen(on) {
    this.htmlFullscreen = on;
    this.win.setFullScreen(on);
    this.layout();
    this.scheduleState();
  }

  panelWidth(totalWidth) {
    const max = Math.max(PANEL_MIN, Math.floor(totalWidth * PANEL_MAX_FRACTION));
    return Math.max(PANEL_MIN, Math.min(max, this.ctx.settings.get('sidePanelWidth') || 420));
  }

  layout() {
    if (this.win.isDestroyed()) return;
    const { width, height } = this.win.getContentBounds();
    const panel = this.visiblePanelKey ? this.panelViews.get(this.visiblePanelKey) : null;
    if (this.htmlFullscreen) {
      this.activeTab?.view.setBounds({ x: 0, y: 0, width, height });
      if (panel) panel.view.setVisible(false);
      return;
    }
    const top = this.chromeHeight;
    const panelW = panel ? this.panelWidth(width) : 0;
    const contentW = panel ? width - panelW - SPLITTER_WIDTH : width;
    this.activeTab?.view.setBounds({ x: 0, y: top, width: Math.max(0, contentW), height: Math.max(0, height - top) });
    if (panel) {
      panel.view.setVisible(true);
      panel.view.setBounds({
        x: width - panelW,
        y: top + PANEL_HEADER_HEIGHT,
        width: panelW,
        height: Math.max(0, height - top - PANEL_HEADER_HEIGHT),
      });
    }
    this.panelGeometry = panel ? { width: panelW, splitter: SPLITTER_WIDTH, header: PANEL_HEADER_HEIGHT } : null;
  }

  // ----------------------------------------------------------- side panel

  /** Show whichever panel the side panel state says belongs to the active tab. */
  syncPanel() {
    const want = this.ctx.crx?.panelFor(this) || null; // { key, url } | null
    if (!want) {
      this.hidePanel();
      return;
    }
    let entry = this.panelViews.get(want.key);
    if (!entry) {
      const view = new WebContentsView({
        webPreferences: {
          session: this.ctx.ses,
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
          spellcheck: true,
        },
      });
      view.setBackgroundColor(nativeTheme.shouldUseDarkColors ? '#1d1714' : '#fbf7ef');
      view.webContents.on('before-input-event', (event, input) => this.ctx.commands.handleInput(event, input, this));
      view.webContents.on('context-menu', (_event, params) => this.ctx.contextMenu(null, params, view.webContents));
      view.webContents.setWindowOpenHandler(({ url }) => {
        this.addTab({ url, active: true });
        return { action: 'deny' };
      });
      view.webContents.on('page-title-updated', () => this.scheduleState());
      entry = { view, url: null, key: want.key };
      this.panelViews.set(want.key, entry);
      this.ctx.crx?.trackPanelContents(view.webContents, this, want);
    }
    if (entry.url !== want.url) {
      entry.url = want.url;
      entry.view.webContents.loadURL(want.url).catch(() => {});
    }
    if (this.visiblePanelKey && this.visiblePanelKey !== want.key) {
      const old = this.panelViews.get(this.visiblePanelKey);
      if (old) try { this.win.contentView.removeChildView(old.view); } catch {}
    }
    if (this.visiblePanelKey !== want.key) {
      this.win.contentView.addChildView(entry.view);
      this.visiblePanelKey = want.key;
    }
    this.layout();
    this.scheduleState();
  }

  hidePanel() {
    if (!this.visiblePanelKey) return;
    const entry = this.panelViews.get(this.visiblePanelKey);
    if (entry) try { this.win.contentView.removeChildView(entry.view); } catch {}
    this.visiblePanelKey = null;
    this.layout();
    this.scheduleState();
  }

  destroyPanel(key) {
    const entry = this.panelViews.get(key);
    if (!entry) return;
    if (this.visiblePanelKey === key) this.hidePanel();
    this.panelViews.delete(key);
    try { entry.view.webContents.close(); } catch {}
  }

  panelContents() {
    const entry = this.visiblePanelKey && this.panelViews.get(this.visiblePanelKey);
    return entry ? entry.view.webContents : null;
  }

  resizePanel(clientX) {
    const { width } = this.win.getContentBounds();
    const next = Math.round(width - clientX - SPLITTER_WIDTH / 2);
    const max = Math.max(PANEL_MIN, Math.floor(width * PANEL_MAX_FRACTION));
    this.ctx.settings.set('sidePanelWidth', Math.max(PANEL_MIN, Math.min(max, next)));
    this.layout();
    this.scheduleState();
  }

  // ------------------------------------------------------------- UI state

  focusOmnibox() {
    if (!this.uiReady) {
      this.focusOmniboxWhenReady = true;
      return;
    }
    this.ui.focus();
    this.ui.send('murshid:focus-omnibox');
  }

  sendFindResult(tab, result) {
    if (tab === this.activeTab) this.ui.send('murshid:find-result', result);
  }

  scheduleState() {
    if (this.stateTimer) return;
    this.stateTimer = setTimeout(() => {
      this.stateTimer = null;
      this.pushState();
    }, 16);
  }

  pushState() {
    if (this.win.isDestroyed() || !this.uiReady) return;
    const newTabUrls = this.ctx.newTabUrls();
    const panelEntry = this.visiblePanelKey && this.panelViews.get(this.visiblePanelKey);
    let panelTitle = 'WebBrain';
    try { panelTitle = panelEntry?.view.webContents.getTitle() || 'WebBrain'; } catch {}
    this.ui.send('murshid:state', {
      platform: process.platform,
      maximized: this.win.isMaximized(),
      fullscreen: this.win.isFullScreen(),
      htmlFullscreen: this.htmlFullscreen,
      activeId: this.activeTab?.id ?? null,
      tabs: this.tabs.map((tab) => {
        const s = tab.state();
        return { ...s, displayUrl: displayUrl(s.url, newTabUrls) };
      }),
      panel: this.panelGeometry ? { ...this.panelGeometry, title: /^chrome-extension:/.test(panelTitle) ? 'WebBrain' : panelTitle } : null,
      webBrain: this.ctx.webBrainInfo(),
      downloads: this.ctx.downloads?.summary() || null,
    });
  }

  rememberBounds() {
    if (this.win.isDestroyed() || this.win.isFullScreen() || this.win.isMinimized()) return;
    if (!this.win.isMaximized()) this.ctx.settings.set('windowBounds', this.win.getBounds());
    this.ctx.rememberSession?.(this);
  }

  onClosed() {
    nativeTheme.off('updated', this.onTheme);
    for (const tab of [...this.tabs]) {
      this.ctx.crx?.onTabRemoved(tab.id);
      tab.destroy();
    }
    for (const key of [...this.panelViews.keys()]) this.destroyPanel(key);
    this.tabs = [];
    this.ctx.onWindowClosed(this);
  }
}

module.exports = { MurshidWindow, PANEL_HEADER_HEIGHT };
