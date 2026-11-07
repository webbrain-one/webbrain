'use strict';

// One browser tab: a WebContentsView in the browsing session, plus the bits of
// state the tab strip and address bar draw from it.

const { WebContentsView, dialog } = require('electron');
const { mapInternal } = require('./url');
const { t } = require('./i18n');

const ERROR_ABORTED = -3;

function tabWebPreferences(ses, inherited = {}) {
  return {
    ...inherited,
    session: ses,
    partition: undefined,
    sandbox: true,
    contextIsolation: true,
    nodeIntegration: false,
    nodeIntegrationInSubFrames: false,
    webviewTag: false,
    spellcheck: true,
    preload: undefined,
  };
}

class Tab {
  /**
   * @param {import('./window').MurshidWindow} owner
   * @param {{url?: string, webContents?: Electron.WebContents, webPreferences?: object}} options
   */
  constructor(owner, { url, webContents, webPreferences } = {}) {
    this.owner = owner;
    this.ctx = owner.ctx;
    this.view = new WebContentsView({
      webPreferences: tabWebPreferences(this.ctx.ses, webPreferences),
      ...(webContents ? { webContents } : {}),
    });
    this.view.setBackgroundColor('#00000000');
    this.wc = this.view.webContents;
    this.id = this.wc.id;
    this.title = '';
    this.favicon = null;
    this.loading = false;
    this.audible = false;
    this.crashed = false;
    this.errorFor = null; // URL whose load failed; the address bar keeps showing it.
    this.initialUrl = url ? (mapInternal(url) === 'murshid://newtab' ? this.ctx.newTabUrl() : mapInternal(url)) : '';
    this.zoomShown = false;
    this.wire();
    if (url) this.load(url);
  }

  load(url) {
    const target = mapInternal(url) || 'murshid://newtab';
    this.errorFor = null;
    this.crashed = false;
    const resolved = target === 'murshid://newtab' ? this.ctx.newTabUrl() : target;
    this.wc.loadURL(resolved).catch(() => {
      // Navigation errors surface through did-fail-load.
    });
  }

  get url() {
    if (this.errorFor) return this.errorFor;
    try {
      return this.wc.getURL() || this.initialUrl;
    } catch {
      return '';
    }
  }

  isNewTabPage() {
    const base = this.url.split(/[?#]/)[0];
    return this.ctx.newTabUrls().includes(base);
  }

  state() {
    const wc = this.wc;
    const isNewTab = this.isNewTabPage();
    const history = wc.navigationHistory;
    return {
      id: this.id,
      title: this.title || (isNewTab ? t('tab.newTab') : this.url || t('tab.newTab')),
      url: this.url,
      isNewTab,
      favicon: isNewTab ? 'murshid' : this.favicon,
      loading: this.loading,
      audible: this.audible,
      muted: wc.isAudioMuted(),
      crashed: this.crashed,
      canGoBack: history.canGoBack(),
      canGoForward: history.canGoForward(),
      zoom: Math.round(wc.getZoomFactor() * 100),
      secure: /^https:/i.test(this.url) || /^(murshid|chrome-extension):/i.test(this.url),
    };
  }

  changed() {
    this.owner.scheduleState();
  }

  wire() {
    const wc = this.wc;
    wc.on('page-title-updated', (_event, title) => {
      this.title = title;
      this.changed();
    });
    wc.on('page-favicon-updated', (_event, favicons) => {
      this.favicon = favicons?.find((href) => /^(https?|data):/i.test(href)) || null;
      this.changed();
    });
    wc.on('did-start-loading', () => {
      this.loading = true;
      this.changed();
    });
    wc.on('did-stop-loading', () => {
      this.loading = false;
      this.changed();
    });
    wc.on('did-start-navigation', (details) => {
      if (details.isMainFrame && !details.isSameDocument) {
        if (!details.url.startsWith('murshid://error')) this.errorFor = null;
        this.favicon = null;
      }
    });
    wc.on('did-navigate', () => { this.initialUrl = ''; this.changed(); });
    wc.on('did-navigate-in-page', (_event, _url, isMainFrame) => {
      if (isMainFrame) this.changed();
    });
    wc.on('audio-state-changed', (event) => {
      this.audible = Boolean(event.audible);
      this.changed();
    });
    wc.on('zoom-changed', (_event, direction) => {
      const level = wc.getZoomLevel() + (direction === 'in' ? 0.5 : -0.5);
      wc.setZoomLevel(Math.max(-8, Math.min(9, level)));
      this.changed();
    });
    wc.on('did-fail-load', (_event, code, description, validatedURL, isMainFrame) => {
      if (!isMainFrame || code === ERROR_ABORTED) return;
      if (validatedURL.startsWith('murshid://')) return;
      const query = new URLSearchParams({ url: validatedURL, code: String(code), description });
      this.wc.loadURL(`murshid://error?${query}`).then(() => {
        this.errorFor = validatedURL;
        this.title = validatedURL.replace(/^https?:\/\//, '').split('/')[0];
        this.changed();
      }).catch(() => {});
    });
    wc.on('render-process-gone', (_event, details) => {
      if (details.reason === 'clean-exit') return;
      this.crashed = true;
      this.loading = false;
      this.changed();
    });
    wc.on('enter-html-full-screen', () => this.owner.setHtmlFullscreen(true));
    wc.on('leave-html-full-screen', () => this.owner.setHtmlFullscreen(false));
    wc.on('found-in-page', (_event, result) => this.owner.sendFindResult(this, result));
    wc.on('context-menu', (_event, params) => this.ctx.contextMenu(this, params));
    wc.on('will-prevent-unload', (event) => {
      const response = dialog.showMessageBoxSync(this.owner.win, {
        type: 'question', buttons: [t('leave.leave'), t('leave.stay')], defaultId: 1, cancelId: 1,
        title: t('leave.title'), message: t('leave.message'), noLink: true,
      });
      if (response === 0) event.preventDefault();
      else if (this.pendingClose) {
        const pending = this.pendingClose;
        this.pendingClose = null;
        pending.resolve(false);
      }
    });
    wc.on('before-input-event', (event, input) => this.ctx.commands.handleInput(event, input, this.owner));
    wc.on('will-navigate', (event) => {
      if (/^chrome:\/\//i.test(event.url)) {
        event.preventDefault();
        this.load(event.url);
      }
    });

    wc.setWindowOpenHandler((details) => {
      const url = mapInternal(details.url);
      if (/^chrome:/i.test(url) || /^javascript:/i.test(url)) return { action: 'deny' };
      if (url !== details.url) {
        this.owner.addTab({ url, active: details.disposition !== 'background-tab', after: this });
        return { action: 'deny' };
      }
      if (details.disposition === 'new-window') {
        // A popup with window features (sign-in windows, payment flows): give it a
        // real window so window.opener keeps working.
        return {
          action: 'allow',
          overrideBrowserWindowOptions: {
            autoHideMenuBar: true,
            icon: this.ctx.icon,
            backgroundColor: '#ffffff',
            webPreferences: tabWebPreferences(this.ctx.ses),
          },
        };
      }
      return {
        action: 'allow',
        createWindow: (options) => {
          const tab = this.owner.addTab({
            webContents: options.webContents,
            webPreferences: options.webPreferences,
            active: details.disposition !== 'background-tab',
            after: this,
          });
          return tab.wc;
        },
      };
    });
  }

  destroy() {
    try {
      if (!this.wc.isDestroyed()) this.wc.close({ waitForBeforeUnload: false });
    } catch {
      // Already gone.
    }
  }
}

module.exports = { Tab, tabWebPreferences };
