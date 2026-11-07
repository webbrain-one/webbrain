'use strict';

// The address bar's suggestions: an inline completion and the dropdown rows.
// What you typed, history (pages and past searches) and open tabs are matched
// here, on this computer. Search suggestions come from the search engine, and
// only while the "Show search suggestions" setting is on.

const { frecency } = require('./history');
const { resolveInput } = require('./url');
const { SEARCH_ENGINES } = require('./settings');

const MAX_ROWS = 9;
const LIMITS = { tabs: 2, history: 5, pastSearches: 3, remote: 5 };
const REMOTE_DELAY = 70;
const REMOTE_TIMEOUT = 4000;
const CACHE_SIZE = 60;

const SCHEME_RE = /^[a-z][a-z0-9+.-]*:\/\//i;
const HAS_SCHEME_RE = /^[a-z][a-z0-9+.-]*:/i;
const WORD_CHAR = /[\p{L}\p{N}]/u;

const stripScheme = (text) => text.replace(SCHEME_RE, '');
const stripWww = (text) => text.replace(/^www\./i, '');
const urlKey = (url) => `url:${url.split('#')[0].replace(/\/$/, '').toLowerCase()}`;
const searchKey = (query) => `search:${query.trim().toLowerCase()}`;

/** How a URL reads in the dropdown: no scheme, no www., no lone trailing slash, readable escapes. */
function displayOf(url) {
  let text = /^https?:\/\//i.test(url) ? stripWww(stripScheme(url)) : url;
  try { text = decodeURI(text); } catch {}
  return text.replace(/^([^/?#]+)\/$/, '$1');
}

/** What the address bar shows while a URL row is highlighted; typing on from it must still resolve to the URL. */
function fillOf(url) {
  return url.replace(/^https:\/\//i, '').replace(/^([^/?#]+)\/$/, '$1');
}

/** True when `term` starts a word somewhere in `text`. */
function wordStart(text, term) {
  let i = text.indexOf(term);
  while (i !== -1) {
    if (i === 0 || !WORD_CHAR.test(text[i - 1])) return true;
    i = text.indexOf(term, i + 1);
  }
  return false;
}

function pageIndex(url, title) {
  let host = '';
  try { host = new URL(url).host.toLowerCase(); } catch { return null; }
  const lower = url.toLowerCase();
  const noScheme = stripScheme(lower);
  return { lower, noScheme, bare: stripWww(noScheme), title: (title || '').toLowerCase(), host: stripWww(host) };
}

/**
 * How well a page matches what was typed: 5 when its URL starts with the input;
 * otherwise each term multiplies in a host prefix (x2.5), a word prefix in the
 * URL or title (x1.6) or, for 3+ characters, any substring (x0.7). A term that
 * matches nowhere rules the page out.
 */
function matchQuality(ix, terms, input) {
  if (ix.bare.startsWith(input) || ix.noScheme.startsWith(input) || ix.lower.startsWith(input)) return 5;
  let quality = 1;
  for (const term of terms) {
    if (ix.host.startsWith(term)) quality *= 2.5;
    else if (wordStart(ix.bare, term) || wordStart(ix.title, term)) quality *= 1.6;
    else if (term.length >= 3 && (ix.bare.includes(term) || ix.title.includes(term))) quality *= 0.7;
    else return 0;
  }
  return quality;
}

/** Inputs whose text should not be sent to a search engine. */
function wantsRemote(text) {
  const t = text.trim();
  if (!t || t.length > 120) return false;
  if (HAS_SCHEME_RE.test(t) && !/\s/.test(t)) return false; // https://…, about:…, localhost:3000
  if (/^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|0\.0\.0\.0|\[)/i.test(t)) return false;
  if (/^([a-z]:[\\/]|\\\\|\/|~\/)/i.test(t)) return false; // file paths
  if (/^[^\s/]+\.(local|localhost|test|internal|lan|home|corp|intranet)(:\d+)?([/?#]|$)/i.test(t)) return false;
  return true;
}

function urlItem(url, title, extra = {}) {
  return { type: 'url', key: urlKey(url), url, title: title || '', display: displayOf(url), fill: fillOf(url), ...extra };
}

function searchItem(type, query, extra = {}) {
  return { type, key: searchKey(query), query, fill: query, ...extra };
}

class Omnibox {
  constructor(ctx) {
    this.ctx = ctx;
    this.index = null;
    this.indexVersion = -1;
    this.cache = new Map(); // `${engineId}\n${text}` -> string[], least recently used first
    this.states = new WeakMap(); // MurshidWindow -> per-window request state
  }

  stateFor(w) {
    let st = this.states.get(w);
    if (!st) {
      st = { request: null, timer: null, controller: null, lastRemote: null };
      this.states.set(w, st);
    }
    return st;
  }

  /** History sorted into pages, past searches and hosts; rebuilt only when history changed. */
  buildIndex() {
    const history = this.ctx.history;
    if (this.index && this.indexVersion === history.version) return this.index;
    const pages = [];
    const searches = [];
    const hosts = new Map();
    for (const e of history.entries.values()) {
      if (e.query) {
        searches.push({ e, q: e.query.toLowerCase() });
        continue;
      }
      let u;
      try { u = new URL(e.url); } catch { continue; }
      const ix = pageIndex(e.url, e.title);
      ix.e = e;
      pages.push(ix);
      const host = u.host.toLowerCase();
      let h = hosts.get(host);
      if (!h) {
        h = { host, https: false, visits: 0, typed: 0, entries: [], root: null };
        hosts.set(host, h);
      }
      h.visits += e.visits;
      h.typed += e.typed;
      h.entries.push(e);
      if (u.protocol === 'https:') h.https = true;
      if (u.pathname === '/' && !u.search) h.root = e;
    }
    this.index = { pages, searches, hosts: [...hosts.values()] };
    this.indexVersion = history.version;
    return this.index;
  }

  /**
   * @param {import('./window').MurshidWindow} w
   * @param {string} text what is in the address bar, without any inline completion
   * @param {{seq?: number, allowInline?: boolean}} options
   */
  suggest(w, text, { seq = 0, allowInline = false } = {}) {
    const request = { text: String(text || '').replace(/^\s+/, '').slice(0, 2048), seq, allowInline: Boolean(allowInline) };
    this.stateFor(w).request = request;
    const result = this.compute(w, request);
    this.scheduleRemote(w, request);
    return result;
  }

  compute(w, { text, seq, allowInline }) {
    const settings = this.ctx.settings;
    const engine = settings.engine();
    const trimmed = text.trim();
    const input = trimmed.toLowerCase();
    if (!input) return { seq, items: [], inline: null, engine: engine.name };

    const now = Date.now();
    const index = this.buildIndex();
    const terms = input.split(/\s+/).filter(Boolean);
    const searchUrl = (q) => settings.searchUrl(q);
    const typedUrl = resolveInput(trimmed, searchUrl);
    const typedIsSearch = typedUrl === searchUrl(trimmed);
    const hasScheme = HAS_SCHEME_RE.test(trimmed);

    // Row 0: what Enter does.
    const inline = allowInline && !/\s/.test(text) ? this.inlineFor(index, input, now) : null;
    let first;
    if (inline) {
      first = urlItem(inline.url, inline.title, { fill: text + inline.completion, favicon: inline.favicon, default: true });
    } else {
      const exact = !hasScheme && !typedIsSearch ? this.exactMatch(index, input, now) : null;
      if (exact) first = urlItem(exact.url, exact.title, { fill: trimmed, favicon: exact.favicon, default: true });
      else if (!typedIsSearch) first = urlItem(typedUrl, '', { fill: trimmed, default: true });
      else first = searchItem('search', trimmed, { default: true });
    }

    const seen = new Set([first.key]);
    const take = (candidates, limit) => {
      const out = [];
      for (const item of candidates) {
        if (out.length >= limit) break;
        if (seen.has(item.key)) continue;
        seen.add(item.key);
        out.push(item);
      }
      return out;
    };

    const typedSearch = first.type === 'url' && !hasScheme ? take([searchItem('search', trimmed)], 1) : [];

    // Open tabs (other than this one), anywhere in Murshid.
    const tabMatches = [];
    for (const win of this.ctx.windows) {
      for (const tab of win.tabs) {
        if (win === w && tab === w.activeTab) continue;
        const url = tab.url;
        if (!/^(https?|file):/i.test(url)) continue;
        const ix = pageIndex(url, tab.title);
        const quality = ix && matchQuality(ix, terms, input);
        if (!quality) continue;
        tabMatches.push({
          quality,
          item: {
            type: 'tab',
            key: urlKey(url),
            tabId: tab.id,
            url,
            title: tab.title || '',
            display: displayOf(url),
            fill: fillOf(url),
            favicon: tab.favicon || null,
          },
        });
      }
    }
    tabMatches.sort((a, b) => b.quality - a.quality);
    const tabs = take(tabMatches.map((m) => m.item), LIMITS.tabs);

    // History pages.
    const pageMatches = [];
    for (const ix of index.pages) {
      const quality = matchQuality(ix, terms, input);
      if (quality) pageMatches.push({ score: frecency(ix.e, now) * quality, e: ix.e });
    }
    pageMatches.sort((a, b) => b.score - a.score);
    const pages = take(
      pageMatches.map(({ e }) => urlItem(e.url, e.title, { favicon: e.favicon, removable: true })),
      LIMITS.history,
    );

    // Past searches (results pages in history), one row per query.
    const past = new Map();
    for (const s of index.searches) {
      const quality = s.q.startsWith(input) ? 3 : terms.every((t) => wordStart(s.q, t)) ? 1.5 : 0;
      if (!quality) continue;
      const prev = past.get(s.q);
      const score = (prev?.score || 0) + frecency(s.e, now) * quality;
      past.set(s.q, { score, e: prev && prev.e.lastVisit > s.e.lastVisit ? prev.e : s.e });
    }
    const pastSearches = take(
      [...past.values()].sort((a, b) => b.score - a.score)
        .map(({ e }) => searchItem('history-search', e.query, { url: e.url, removable: true })),
      LIMITS.pastSearches,
    );

    const remote = take(this.remoteFor(w, text).map((q) => searchItem('suggest', q)), LIMITS.remote);

    // An address: places first, then searches. Words: searches first, but open
    // tabs ahead of the engine's suggestions, and room kept for two history pages.
    let groups;
    if (inline || !typedIsSearch) {
      groups = [typedSearch, tabs, pages, pastSearches, remote];
    } else {
      const keptPages = pages.slice(0, 2);
      const remoteRoom = Math.max(0, MAX_ROWS - 1 - pastSearches.length - tabs.length - keptPages.length);
      groups = [pastSearches, tabs, remote.slice(0, remoteRoom), pages];
    }
    const items = [first, ...groups.flat()].slice(0, MAX_ROWS);
    return { seq, items, inline: inline ? { completion: inline.completion } : null, engine: engine.name };
  }

  /**
   * The inline completion for `input`: with no "/" yet, a host someone has gone
   * to before (scheme://host, host or host without www.); after a "/", a page.
   * Only places typed at least once or visited twice qualify; the most frecent wins.
   */
  inlineFor(index, input, now) {
    let best = null;
    if (!stripScheme(input).includes('/')) {
      for (const h of index.hosts) {
        if (h.typed < 1 && h.visits < 2) continue;
        const scheme = h.https ? 'https://' : 'http://';
        const form = [scheme + h.host, h.host, stripWww(h.host)].find((f) => f.startsWith(input) && f.length > input.length);
        if (!form) continue;
        const score = h.entries.reduce((sum, e) => sum + frecency(e, now), 0);
        if (best && score <= best.score) continue;
        best = {
          score,
          completion: form.slice(input.length),
          url: h.root?.url || `${scheme}${h.host}/`,
          title: h.root?.title || '',
          favicon: h.root?.favicon || null,
        };
      }
      return best;
    }
    for (const ix of index.pages) {
      const { e } = ix;
      if (e.typed < 1 && e.visits < 2) continue;
      const forms = [
        [ix.lower, e.url],
        [ix.noScheme, stripScheme(e.url)],
        [ix.bare, stripWww(stripScheme(e.url))],
      ];
      const hit = forms.find(([lower]) => lower.startsWith(input) && lower.length > input.length);
      if (!hit) continue;
      const score = frecency(e, now);
      if (best && score <= best.score) continue;
      const [lower, original] = hit;
      // Keep the page's own capitals unless lowercasing changed the length.
      const source = original.length === lower.length ? original : lower;
      best = { score, completion: source.slice(input.length), url: e.url, title: e.title, favicon: e.favicon };
    }
    return best;
  }

  /** A history page whose address is exactly what was typed (give or take scheme, www. and a trailing slash). */
  exactMatch(index, input, now) {
    const wanted = stripWww(stripScheme(input)).replace(/\/$/, '');
    let best = null;
    for (const ix of index.pages) {
      if (ix.bare.replace(/\/$/, '') !== wanted) continue;
      if (!best || frecency(ix.e, now) > frecency(best, now)) best = ix.e;
    }
    return best;
  }

  // ------------------------------------------------------- search suggestions

  remoteFor(w, text) {
    const settings = this.ctx.settings;
    if (!settings.get('searchSuggestions') || !wantsRemote(text)) return [];
    const engineId = settings.get('searchEngine');
    const cached = this.cache.get(`${engineId}\n${text.toLowerCase()}`);
    if (cached) return cached;
    // While the answer for this text is on its way, keep showing the previous
    // answer's suggestions that still fit, so the list does not flicker.
    const last = this.stateFor(w).lastRemote;
    if (!last || last.engineId !== engineId) return [];
    const prefix = text.toLowerCase();
    return last.list.filter((s) => s.toLowerCase().startsWith(prefix));
  }

  scheduleRemote(w, request) {
    const st = this.stateFor(w);
    clearTimeout(st.timer);
    st.timer = null;
    st.controller?.abort();
    st.controller = null;

    const settings = this.ctx.settings;
    if (!settings.get('searchSuggestions') || !wantsRemote(request.text)) return;
    const engineId = settings.get('searchEngine');
    const engine = SEARCH_ENGINES[engineId];
    if (!engine?.suggest) return;
    const key = `${engineId}\n${request.text.toLowerCase()}`;
    if (this.cache.has(key)) {
      st.lastRemote = { engineId, list: this.cache.get(key) };
      return;
    }

    st.timer = setTimeout(async () => {
      st.timer = null;
      const controller = new AbortController();
      st.controller = controller;
      const timeout = setTimeout(() => controller.abort(), REMOTE_TIMEOUT);
      let list = null;
      try {
        list = await this.fetchSuggestions(engine, request.text, controller.signal);
      } catch (error) {
        if (!controller.signal.aborted) console.warn(`[murshid] search suggestions from ${engine.name} failed:`, error.message);
      } finally {
        clearTimeout(timeout);
        if (st.controller === controller) st.controller = null;
      }
      if (!list) return;
      this.remember(key, list);
      st.lastRemote = { engineId, list };
      if (st.request !== request || w.win.isDestroyed() || !w.uiReady) return;
      w.ui.send('murshid:suggest-update', this.compute(w, request));
    }, REMOTE_DELAY);
  }

  async fetchSuggestions(engine, text, signal) {
    const url = engine.suggest.replace('%s', encodeURIComponent(text));
    // No cookies: suggestions should not be tied to whoever is signed in to the engine.
    const response = await this.ctx.ses.fetch(url, {
      signal,
      credentials: 'omit',
      headers: { accept: 'application/x-suggestions+json, application/json;q=0.9, */*;q=0.5' },
    });
    if (!response.ok) return [];
    const data = JSON.parse(await response.text());
    const list = Array.isArray(data) && Array.isArray(data[1]) ? data[1] : [];
    return list
      .filter((s) => typeof s === 'string')
      .map((s) => s.replace(/\s+/g, ' ').trim())
      .filter((s) => s && s.length <= 200)
      .slice(0, 10);
  }

  remember(key, list) {
    this.cache.delete(key);
    this.cache.set(key, list);
    while (this.cache.size > CACHE_SIZE) this.cache.delete(this.cache.keys().next().value);
  }
}

module.exports = { Omnibox, displayOf, matchQuality, wantsRemote };
