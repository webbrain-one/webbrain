'use strict';

// Murshid's browsing history: one entry per URL with its title, favicon, visit
// and typed counts and the time of the last visit. It feeds the address bar's
// suggestions and never leaves this computer (<profile>/murshid-history.json).
// Writes are debounced and atomic, like settings.js.

const { app } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const MAX_ENTRIES = 5000;
const PRUNE_TO = 4000;
const MAX_URL = 4096;
const MAX_TITLE = 300;
const DAY = 24 * 60 * 60 * 1000;

function recencyWeight(lastVisit, now) {
  const age = (now - lastVisit) / DAY;
  if (age < 4) return 1;
  if (age < 14) return 0.7;
  if (age < 31) return 0.5;
  if (age < 90) return 0.3;
  return 0.12;
}

/** How much an entry deserves to be suggested: often, deliberately and lately visited. */
function frecency(entry, now = Date.now()) {
  return (entry.visits + entry.typed * 5) * recencyWeight(entry.lastVisit, now);
}

function recordable(url) {
  if (typeof url !== 'string' || url.length > MAX_URL || !/^https?:\/\//i.test(url)) return false;
  try {
    return !new URL(url).hostname.endsWith('.chromiumapp.org');
  } catch {
    return false;
  }
}

function cleanTitle(title) {
  return typeof title === 'string' ? title.trim().slice(0, MAX_TITLE) : '';
}

class History {
  /** @param {{searchQueryOf?: (url: string) => string | null}} [options] */
  constructor({ searchQueryOf } = {}) {
    this.file = path.join(app.getPath('userData'), 'murshid-history.json');
    this.searchQueryOf = searchQueryOf || (() => null);
    /** @type {Map<string, {url: string, title: string, favicon: string | null, visits: number, typed: number, lastVisit: number, query: string | null}>} */
    this.entries = new Map();
    this.version = 0; // bumped on every change, so readers can cache indexes
    this.timer = null;
    this.load();
  }

  load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      for (const e of Array.isArray(raw?.entries) ? raw.entries : []) {
        if (!e || !recordable(e.url)) continue;
        this.entries.set(e.url, {
          url: e.url,
          title: cleanTitle(e.title),
          favicon: typeof e.favicon === 'string' && /^https?:/i.test(e.favicon) ? e.favicon : null,
          visits: Math.max(0, Math.floor(Number(e.visits) || 0)),
          typed: Math.max(0, Math.floor(Number(e.typed) || 0)),
          lastVisit: Number(e.lastVisit) || 0,
          query: typeof e.query === 'string' && e.query ? e.query : null,
        });
      }
    } catch {
      // First run, or an unreadable file: start empty.
    }
  }

  changed() {
    this.version += 1;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), 1500);
  }

  flush() {
    clearTimeout(this.timer);
    this.timer = null;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ version: 1, entries: [...this.entries.values()] }));
      fs.renameSync(tmp, this.file);
    } catch (error) {
      console.error('[murshid] could not save history:', error);
    }
  }

  /**
   * @param {string} url
   * @param {{title?: string, typed?: boolean}} [details] title is only a
   *   fallback for an entry that has none yet; page-title-updated sets the real one.
   */
  recordVisit(url, { title, typed = false } = {}) {
    if (!recordable(url)) return;
    let entry = this.entries.get(url);
    if (!entry) {
      entry = { url, title: '', favicon: null, visits: 0, typed: 0, lastVisit: 0, query: this.searchQueryOf(url) };
      this.entries.set(url, entry);
    } else {
      // Map order is insertion order; keep the most recent visit last.
      this.entries.delete(url);
      this.entries.set(url, entry);
    }
    entry.visits += 1;
    if (typed) entry.typed += 1;
    entry.lastVisit = Date.now();
    if (title && !entry.title) entry.title = cleanTitle(title);
    if (this.entries.size > MAX_ENTRIES) this.prune();
    this.changed();
  }

  setTitle(url, title) {
    const entry = this.entries.get(url);
    const clean = cleanTitle(title);
    if (!entry || !clean || entry.title === clean) return;
    entry.title = clean;
    this.changed();
  }

  setFavicon(url, favicon) {
    const entry = this.entries.get(url);
    if (!entry || typeof favicon !== 'string' || !/^https?:/i.test(favicon) || favicon.length > MAX_URL) return;
    if (entry.favicon === favicon) return;
    entry.favicon = favicon;
    this.changed();
  }

  /** Remove one URL, or every results page of a past search. */
  remove({ url, query } = {}) {
    let removed = 0;
    if (url && this.entries.delete(url)) removed += 1;
    if (query) {
      const q = String(query).toLowerCase();
      for (const [key, entry] of this.entries) {
        if (entry.query && entry.query.toLowerCase() === q) {
          this.entries.delete(key);
          removed += 1;
        }
      }
    }
    if (removed) this.changed();
    return removed;
  }

  clear() {
    this.entries.clear();
    this.version += 1;
    this.flush();
  }

  count() {
    return this.entries.size;
  }

  prune() {
    const now = Date.now();
    const ranked = [...this.entries.values()].sort((a, b) => frecency(a, now) - frecency(b, now));
    for (const entry of ranked.slice(0, this.entries.size - PRUNE_TO)) this.entries.delete(entry.url);
  }
}

module.exports = { History, frecency };
