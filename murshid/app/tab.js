'use strict';

// One browser tab: a WebContentsView in the browsing session, plus the bits of
// state the tab strip and address bar draw from it.

const { WebContentsView, dialog } = require('electron');
const { mapInternal } = require('./url');
const { t } = require('./i18n');

const ERROR_ABORTED = -3;
const ERROR_PAGE = 'murshid://error';
const MAX_ERROR_PAGES = 32;

/** The address a murshid://error page reports, or null for any other URL. */
function errorPageTarget(url) {
  if (typeof url !== 'string' || !url.startsWith(ERROR_PAGE)) return null;
  try {
    return new URL(url).searchParams.get('url') || null;
  } catch {
    return null;
  }
}

/**
 * Call when a main-frame page commits. Removes the history entries right behind
 * it that only stood in for the same address, so Back leaves a load error instead
 * of landing on it again:
 * - fresh (a murshid://error page Murshid just loaded for a failed address):
 *   Chromium's own entry for that address. Chromium commits it, with its own
 *   error document, before did-fail-load fires. Going Back to it retries the
 *   address, which fails the same way and brings the error page straight back.
 * - earlier murshid://error pages for the same address: a retry that failed
 *   again, or one that has now loaded.
 * Returns how many entries it removed.
 *
 * @param {Electron.NavigationHistory} history
 * @param {string} committedUrl
 * @param {{fresh?: boolean}} [options]
 */
function dropStandInEntries(history, committedUrl, { fresh = false } = {}) {
  const failed = errorPageTarget(committedUrl);
  const target = failed || committedUrl;
  let removed = 0;
  // Removes the entry right behind the active one if isStandIn(its url) holds.
  const dropBehind = (isStandIn) => {
    const index = history.getActiveIndex() - 1;
    if (index < 0 || !isStandIn(history.getEntryAtIndex(index)?.url)) return false;
    if (!history.removeEntryAtIndex(index)) return false;
    removed += 1;
    return history.getActiveIndex() === index; // the active entry moved down one, as it should
  };
  if (fresh && failed) dropBehind((url) => url === failed);
  let more = true;
  while (more) more = dropBehind((url) => errorPageTarget(url) === target);
  return removed;
}

/** Asks whether to leave a page whose beforeunload handler wants to stay. */
function confirmLeave(parent) {
  return dialog.showMessageBoxSync(parent, {
    type: 'question', buttons: [t('leave.leave'), t('leave.stay')], defaultId: 1, cancelId: 1,
    title: t('leave.title'), message: t('leave.message'), noLink: true,
  }) === 0;
}

/**
 * A window.open popup with window features is a plain BrowserWindow (see the
 * window open handler below). Electron treats a beforeunload prompt that nobody
 * answers as "stay", so without this the popup could not be closed and quitting
 * Murshid would stop at it. Popups it opens get the same.
 */
function guardPopup(ctx, win) {
  const wc = win?.webContents;
  if (!wc) return;
  wc.on('will-prevent-unload', (event) => {
    if (confirmLeave(win)) event.preventDefault();
    else ctx.quitting = false;
  });
  wc.on('did-create-window', (child) => guardPopup(ctx, child));
}

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
    this.errorPages = new Set(); // addresses this tab has shown murshid://error for
    this.freshErrorFor = null; // the address whose murshid://error page is loading now
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

  /** Reloads the page; on the load-error page, tries the failed address again. */
  reload(hard = false) {
    if (this.errorFor) this.load(this.errorFor);
    else if (hard) this.wc.reloadIgnoringCache();
    else this.wc.reload();
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
      // The load-error page keeps the failed site's name as its title, and its
      // own title must not land in that site's history entry.
      if (this.errorFor) return;
      this.title = title;
      this.ctx.history?.setTitle(this.url, title);
      this.changed();
    });
    wc.on('page-favicon-updated', (_event, favicons) => {
      this.favicon = favicons?.find((href) => /^(https?|data):/i.test(href)) || null;
      if (this.favicon) this.ctx.history?.setFavicon(this.url, this.favicon);
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
    wc.on('did-navigate', (_event, url, httpResponseCode) => {
      this.initialUrl = '';
      const failed = errorPageTarget(url);
      const fresh = Boolean(failed) && failed === this.freshErrorFor;
      this.freshErrorFor = null;
      try {
        dropStandInEntries(wc.navigationHistory, url, { fresh });
      } catch (error) {
        console.warn('[murshid] could not tidy tab history:', error);
      }
      // Only error pages this tab made stand for their address (Back and Forward
      // can bring one back); any other murshid://error URL is just a page.
      this.errorFor = failed && this.errorPages.has(failed) ? failed : null;
      if (this.errorFor) this.title = this.errorFor.replace(/^https?:\/\//, '').split('/')[0];
      // typedPending is set by the address bar; the first commit after it is the typed visit.
      const typed = Boolean(this.typedPending);
      this.typedPending = false;
      if (!(httpResponseCode >= 400)) this.ctx.history?.recordVisit(url, { typed });
      this.lastVisitUrl = url;
      this.changed();
    });
    wc.on('did-navigate-in-page', (_event, url, isMainFrame) => {
      if (!isMainFrame) return;
      // Single-page apps change the URL without loading; a new #fragment alone is not a visit.
      const withoutHash = (u) => String(u || '').split('#')[0];
      if (withoutHash(url) !== withoutHash(this.lastVisitUrl)) this.ctx.history?.recordVisit(url, { title: this.title });
      this.lastVisitUrl = url;
      this.changed();
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
      // did-navigate for the error page sets errorFor and tidies the history.
      this.errorPages.delete(validatedURL);
      this.errorPages.add(validatedURL);
      if (this.errorPages.size > MAX_ERROR_PAGES) this.errorPages.delete(this.errorPages.values().next().value);
      this.freshErrorFor = validatedURL;
      this.wc.loadURL(`${ERROR_PAGE}?${query}`).catch(() => {});
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
      if (confirmLeave(this.owner.win)) event.preventDefault();
      else if (this.pendingClose) {
        const pending = this.pendingClose;
        this.pendingClose = null;
        pending.resolve(false);
      }
    });
    wc.on('did-create-window', (win) => guardPopup(this.ctx, win));
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

module.exports = { Tab, tabWebPreferences, errorPageTarget, dropStandInEntries };
