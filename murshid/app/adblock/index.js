'use strict';

// Built-in ad and tracker blocking, on by default (Settings > "Block ads and
// trackers").
//
// The matching is Ghostery's adblocker library (@ghostery/adblocker, MPL-2.0)
// with EasyList, EasyPrivacy and uBlock's "Unbreak" list (app/adblock/engine.js).
// The library's own Electron wrapper is not used: its enableBlockingInSession()
// sets the session's onBeforeRequest and onHeadersReceived listeners, and
// Electron keeps only one of each, which app/identity.js already owns (for
// WebBrain's chrome.webRequest and the client hints). Those listeners ask this
// module instead: blockRequest() says which requests to cancel, and
// responseHeaders() adds a list's Content-Security-Policy to a page.
// Element hiding uses the library's Electron preload
// (@ghostery/adblocker-electron-preload, top frames only), answered by the IPC
// handlers below; scriptlets and procedural selectors are not applied.
//
// Lists: a serialized engine ships in app/adblock/engine.bin.gz (rebuilt with
// `npm run adblock`), so blocking works offline from the first run. Murshid
// downloads the lists again at most once a day, builds the engine in a utility
// process and keeps it in <profile>/adblock/.
//
// Never filtered: the page's own navigation, addresses that are not http(s) or
// ws(s), requests Murshid makes itself (no page or worker behind them: search
// suggestions, downloads, these list updates), and anything from Murshid's own
// pages, extensions (WebBrain's worker, side panel, offscreen documents and new
// tab page) or devtools. Sites the user allowed from the ⋮ menu are left alone.

const fs = require('node:fs');
const path = require('node:path');
const { ipcMain, session, utilityProcess } = require('electron');
const { Request } = require('@ghostery/adblocker');
const lists = require('./engine');

const DAY = 24 * 60 * 60 * 1000;
const FIRST_CHECK_DELAY = 60 * 1000; // after startup, before the first refresh
const RETRY_DELAY = 60 * 60 * 1000; // after a failed refresh
const BUNDLED = { file: path.join(__dirname, 'engine.bin.gz'), meta: path.join(__dirname, 'lists.json') };
const PRELOAD = require.resolve('@ghostery/adblocker-electron-preload');
// The channels the library's preload calls.
const INJECT_CHANNEL = '@ghostery/adblocker/inject-cosmetic-filters';
const OBSERVE_CHANNEL = '@ghostery/adblocker/is-mutation-observer-enabled';
const MAX_FEATURES = 20000; // ids, classes or hrefs per element-hiding update

const FILTERED_URL = /^(https?|wss?):/i;
const WEB_PAGE = /^https?:/i;
const OWN_PAGE = /^(murshid|chrome-extension|chrome|devtools):/i;

function hostOf(url) {
  try { return new URL(url).hostname; } catch { return ''; }
}

/** The address of the tab page (top frame) a request belongs to; '' when there is none. */
function pageOf(details) {
  if (details.resourceType === 'mainFrame') return details.url;
  try {
    const top = details.frame?.top;
    if (top?.url) return top.url;
  } catch {} // the frame is gone
  try {
    const wc = details.webContents;
    if (wc && !wc.isDestroyed() && wc.getURL()) return wc.getURL();
  } catch {}
  // A site's service or shared worker has no frame, only its origin.
  return details.initiatorOrigin && details.initiatorOrigin !== 'null' ? `${details.initiatorOrigin}/` : '';
}

/** The document that made a request, for the lists' third-party and $domain rules. */
function sourceOf(details, page) {
  if (details.resourceType === 'mainFrame') return details.url;
  if (details.initiatorOrigin && details.initiatorOrigin !== 'null') return `${details.initiatorOrigin}/`;
  try {
    if (details.frame?.url) return details.frame.url;
  } catch {}
  return details.referrer || page;
}

class Adblock {
  /** `engine` replaces the stored one (tests). */
  constructor({ settings, userData, engine = null }) {
    this.settings = settings;
    this.dir = userData ? path.join(userData, 'adblock') : null;
    this.engine = engine;
    this.meta = engine ? { updated: Date.now() } : null;
    this.ses = null;
    this.timer = null;
    this.refreshing = null;
    this.listSession = null;
    this.allowedSites = new Set(settings.get('adblockAllowedSites') || []);
    settings.on('changed', (key) => {
      if (key === 'adblockAllowedSites') this.allowedSites = new Set(settings.get(key) || []);
      if (key !== 'adblock') return;
      if (this.enabled) {
        this.load();
        this.schedule(FIRST_CHECK_DELAY);
      } else {
        clearTimeout(this.timer);
      }
    });
  }

  get enabled() {
    return this.settings.get('adblock') !== false;
  }

  /** Filter `ses` (the browsing session): element hiding and list refreshes. Requests come through app/identity.js. */
  install(ses) {
    this.ses = ses;
    if (this.enabled) this.load();
    ses.registerPreloadScript({ id: 'murshid-adblock', type: 'frame', filePath: PRELOAD });
    ipcMain.handle(INJECT_CHANNEL, (event, _url, update) => this.injectCosmetics(event, update));
    ipcMain.handle(OBSERVE_CHANNEL, (event) => Boolean(this.cosmeticPage(event)));
    this.schedule(FIRST_CHECK_DELAY);
  }

  // ------------------------------------------------------------------ the engine

  files() {
    return this.dir ? { file: path.join(this.dir, 'engine.bin.gz'), meta: path.join(this.dir, 'lists.json') } : null;
  }

  /** Load the newest stored engine that this library version can read: the profile's, else the bundled one. */
  load() {
    if (this.engine) return this.engine;
    const stored = [this.files(), BUNDLED].filter(Boolean).map((source) => {
      try { return { ...source, updated: JSON.parse(fs.readFileSync(source.meta, 'utf8')).updated || 0 }; } catch { return null; }
    }).filter(Boolean).sort((a, b) => b.updated - a.updated);
    for (const source of stored) {
      try {
        ({ engine: this.engine, meta: this.meta } = lists.readEngine(source.file, source.meta));
        return this.engine;
      } catch (error) {
        console.warn(`[murshid] could not load the filter lists from ${source.file}: ${error.message}`);
      }
    }
    return null;
  }

  /** Refresh the lists once they are a day old (no sooner than `delay` from now). */
  schedule(delay) {
    clearTimeout(this.timer);
    this.timer = null;
    if (!this.enabled || !this.dir) return;
    const age = Date.now() - (this.meta?.updated || 0);
    this.timer = setTimeout(() => {
      this.refresh().then(() => this.schedule(0), (error) => {
        console.warn(`[murshid] could not update the filter lists: ${error.message}`);
        this.schedule(RETRY_DELAY);
      });
    }, Math.max(delay, DAY - age));
    this.timer.unref?.();
  }

  /** Download the lists, build an engine from them and switch to it. */
  refresh() {
    if (!this.refreshing) {
      this.refreshing = (async () => {
        const texts = await Promise.all(lists.LISTS.map((list) => this.download(list.url)));
        const { file, meta } = this.files();
        await this.build(texts, file, meta);
        ({ engine: this.engine, meta: this.meta } = lists.readEngine(file, meta));
      })().finally(() => { this.refreshing = null; });
    }
    return this.refreshing;
  }

  /** One list's text, fetched in a session of its own: no cookies, and not filtered by itself. */
  async download(url) {
    this.listSession ||= session.fromPartition('murshid-filter-lists', { cache: false });
    const response = await this.listSession.fetch(url, { cache: 'no-store', credentials: 'omit', signal: AbortSignal.timeout(60000) });
    if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
    const text = await response.text();
    if (!lists.looksLikeList(text)) throw new Error(`${url} is not a filter list`);
    return text;
  }

  /** Parse and store the lists in a utility process (about a second of work that would otherwise stall the browser). */
  build(texts, file, meta) {
    return new Promise((resolve, reject) => {
      const child = utilityProcess.fork(path.join(__dirname, 'build-worker.js'), [], { serviceName: 'Murshid filter lists', stdio: 'ignore' });
      const timer = setTimeout(() => { child.kill(); reject(new Error('building the engine timed out')); }, 120000);
      child.once('spawn', () => child.postMessage({ texts, file, meta, updated: Date.now() }));
      child.once('message', (result) => {
        clearTimeout(timer);
        child.kill();
        if (result?.ok) resolve();
        else reject(new Error(result?.error || 'building the engine failed'));
      });
      child.once('exit', (code) => {
        clearTimeout(timer);
        reject(new Error(`the engine builder exited (${code})`)); // no-op once settled
      });
    });
  }

  // --------------------------------------------------------------- per-site choice

  /** The site (host name) the ⋮ menu offers a choice for, or null for pages that are not filtered. */
  siteOf(url) {
    return WEB_PAGE.test(url || '') ? hostOf(url) || null : null;
  }

  isAllowed(site) {
    return this.allowedSites.has(site);
  }

  /** Allow ads on `site` (stop filtering its pages), or block them again. */
  setAllowed(site, allowed) {
    if (!site || this.isAllowed(site) === allowed) return;
    const sites = (this.settings.get('adblockAllowedSites') || []).filter((s) => s !== site);
    if (allowed) sites.push(site);
    this.settings.set('adblockAllowedSites', sites);
  }

  // -------------------------------------------------------- network (identity.js)

  /** The library's view of a request, or null when Murshid doesn't filter it. */
  requestFor(details) {
    if (!this.enabled || !this.engine || !FILTERED_URL.test(details.url || '')) return null;
    if (OWN_PAGE.test(details.initiatorOrigin || '')) return null;
    const page = pageOf(details);
    if (!page || OWN_PAGE.test(page) || this.allowedSites.has(hostOf(page))) return null;
    return Request.fromRawDetails({
      requestId: String(details.id),
      url: details.url,
      sourceUrl: sourceOf(details, page),
      type: details.resourceType || 'other',
      tabId: details.webContentsId,
    });
  }

  /**
   * For onBeforeRequest: { cancel: true } when a list blocks the request, else null.
   * A $redirect match is cancelled too: the library's stand-in is a data: URL,
   * which Chromium refuses as a redirect target (net::ERR_UNSAFE_REDIRECT).
   */
  blockRequest(details) {
    if (details.resourceType === 'mainFrame') return null; // pages themselves always load
    try {
      const request = this.requestFor(details);
      if (!request) return null;
      return this.engine.match(request).match ? { cancel: true } : null;
    } catch (error) {
      console.warn('[murshid] filter error:', error);
      return null;
    }
  }

  /**
   * For onHeadersReceived: a page's response headers plus a list's
   * Content-Security-Policy ($csp, which the library applies to top-level pages
   * only), or null to leave them. The list's policy is a separate header, so the
   * site's own policies still apply in full.
   */
  responseHeaders(details) {
    if (details.resourceType !== 'mainFrame') return null;
    try {
      const request = this.requestFor(details);
      const csp = request && this.engine.getCSPDirectives(request);
      if (!csp) return null;
      const headers = { ...(details.responseHeaders || {}) };
      const name = Object.keys(headers).find((k) => k.toLowerCase() === 'content-security-policy') || 'Content-Security-Policy';
      headers[name] = [...[].concat(headers[name] || []), csp];
      return headers;
    } catch (error) {
      console.warn('[murshid] filter error:', error);
      return null;
    }
  }

  // ----------------------------------------------------------- element hiding (IPC)

  /** The top-frame web page an element-hiding request comes from, if it is filtered. */
  cosmeticPage(event) {
    if (!this.enabled || !this.engine) return null;
    const wc = event.sender;
    let frame;
    try { frame = event.senderFrame; } catch {}
    if (!wc || wc.isDestroyed?.() || wc.session !== this.ses || !frame || frame.parent) return null;
    const url = frame.url;
    if (!WEB_PAGE.test(url || '')) return null;
    const { hostname, domain } = Request.fromRawDetails({ url });
    if (this.allowedSites.has(hostname)) return null;
    return { url, hostname, domain };
  }

  /** The preload asks once at document start (`update` undefined), then with ids and classes new to the DOM. */
  injectCosmetics(event, update) {
    try {
      const page = this.cosmeticPage(event);
      if (!page) return;
      const first = update == null;
      const strings = (list) => (Array.isArray(list) ? list.filter((s) => typeof s === 'string').slice(0, MAX_FEATURES) : []);
      const { active, styles } = this.engine.getCosmeticsFilters({
        ...page,
        classes: first ? undefined : strings(update.classes),
        hrefs: first ? undefined : strings(update.hrefs),
        ids: first ? undefined : strings(update.ids),
        getBaseRules: first,
        getRulesFromHostname: first,
        getRulesFromDOM: !first,
        getInjectionRules: false,
        getExtendedRules: false,
      });
      if (active && styles && event.sender.mainFrame?.url === page.url) {
        Promise.resolve(event.sender.insertCSS(styles, { cssOrigin: 'user' })).catch(() => {});
      }
    } catch (error) {
      console.warn('[murshid] element hiding error:', error);
    }
  }
}

module.exports = { Adblock, pageOf, sourceOf };
