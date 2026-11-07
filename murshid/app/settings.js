'use strict';

// A small JSON settings file in the profile folder. Writes are debounced and
// atomic (write to a temp file, then rename) so a crash never leaves half a file.

const { app } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { SUPPORTED, SETTINGS_FILE } = require('./i18n');

const LANGUAGES = ['auto', ...SUPPORTED];

// `suggest` endpoints all answer in the OpenSearch suggestions format:
// ["what was typed", ["suggestion", ...]].
const SEARCH_ENGINES = {
  google: {
    name: 'Google',
    url: 'https://www.google.com/search?q=%s',
    suggest: 'https://suggestqueries.google.com/complete/search?client=firefox&ie=utf-8&oe=utf-8&q=%s',
  },
  duckduckgo: { name: 'DuckDuckGo', url: 'https://duckduckgo.com/?q=%s', suggest: 'https://duckduckgo.com/ac/?type=list&q=%s' },
  bing: { name: 'Bing', url: 'https://www.bing.com/search?q=%s', suggest: 'https://www.bing.com/osjson.aspx?query=%s' },
  brave: { name: 'Brave Search', url: 'https://search.brave.com/search?q=%s', suggest: 'https://search.brave.com/api/suggest?q=%s' },
  startpage: { name: 'Startpage', url: 'https://www.startpage.com/do/search?q=%s', suggest: 'https://www.startpage.com/osuggestions?q=%s' },
  kagi: { name: 'Kagi', url: 'https://kagi.com/search?q=%s', suggest: 'https://kagi.com/api/autosuggest?q=%s' },
};

// Where each engine's results pages live, to recognise past searches in history.
const RESULT_PAGES = Object.values(SEARCH_ENGINES).map((engine) => {
  const u = new URL(engine.url.replace('%s', 'x'));
  const param = [...u.searchParams.entries()].find(([, v]) => v === 'x')?.[0] || 'q';
  return { host: u.hostname.replace(/^www./, ''), path: u.pathname, param };
});
RESULT_PAGES.push({ host: 'startpage.com', path: '/sp/search', param: 'query' });

/** The query of a search results page from one of the engines, else null. */
function searchQueryOf(url) {
  let u;
  try { u = new URL(url); } catch { return null; }
  const host = u.hostname.replace(/^www./, '');
  for (const page of RESULT_PAGES) {
    if (page.host !== host || page.path !== u.pathname) continue;
    const query = (u.searchParams.get(page.param) || '').trim();
    return query || null;
  }
  return null;
}

const DEFAULTS = {
  // 'auto' follows the system; otherwise one of i18n.SUPPORTED. Applied at
  // startup (app/main.js), so a change needs a restart.
  language: 'auto',
  searchEngine: 'google',
  searchSuggestions: true,
  startCompanion: true,
  // Off: sites see Murshid in the client hints, as Brave shows Brave. On: they
  // see Google Chrome, as Vivaldi does. See app/identity.js.
  identifyAsChrome: false,
  persistBrowserSession: true,
  sidePanelWidth: 420,
  restoreLastSession: false,
  lastSession: [],
  windowBounds: null,
};

class Settings extends EventEmitter {
  constructor() {
    super();
    this.file = path.join(app.getPath('userData'), SETTINGS_FILE);
    this.data = { ...DEFAULTS };
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (raw && typeof raw === 'object') this.data = { ...DEFAULTS, ...raw };
    } catch {
      // First run, or an unreadable file: start from the defaults.
    }
    if (!SEARCH_ENGINES[this.data.searchEngine]) this.data.searchEngine = DEFAULTS.searchEngine;
    if (!LANGUAGES.includes(this.data.language)) this.data.language = DEFAULTS.language;
    this.timer = null;
  }

  get(key) {
    return this.data[key];
  }

  set(key, value) {
    if (this.data[key] === value) return;
    this.data[key] = value;
    this.emit('changed', key, value);
    this.scheduleWrite();
  }

  scheduleWrite() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), 400);
  }

  flush() {
    clearTimeout(this.timer);
    this.timer = null;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
      fs.renameSync(tmp, this.file);
    } catch (error) {
      console.error('[murshid] could not save settings:', error);
    }
  }

  engine() {
    return SEARCH_ENGINES[this.data.searchEngine] || SEARCH_ENGINES.google;
  }

  searchUrl(text) {
    return this.engine().url.replace('%s', encodeURIComponent(text));
  }
}

module.exports = { Settings, SEARCH_ENGINES, LANGUAGES, searchQueryOf };
