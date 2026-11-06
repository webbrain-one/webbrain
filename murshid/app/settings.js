'use strict';

// A small JSON settings file in the profile folder. Writes are debounced and
// atomic (write to a temp file, then rename) so a crash never leaves half a file.

const { app } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const SEARCH_ENGINES = {
  google: { name: 'Google', url: 'https://www.google.com/search?q=%s' },
  duckduckgo: { name: 'DuckDuckGo', url: 'https://duckduckgo.com/?q=%s' },
  bing: { name: 'Bing', url: 'https://www.bing.com/search?q=%s' },
  brave: { name: 'Brave Search', url: 'https://search.brave.com/search?q=%s' },
  startpage: { name: 'Startpage', url: 'https://www.startpage.com/do/search?q=%s' },
  kagi: { name: 'Kagi', url: 'https://kagi.com/search?q=%s' },
};

const DEFAULTS = {
  searchEngine: 'google',
  startCompanion: true,
  sidePanelWidth: 420,
  restoreLastSession: false,
  lastSession: [],
  windowBounds: null,
};

class Settings extends EventEmitter {
  constructor() {
    super();
    this.file = path.join(app.getPath('userData'), 'murshid-settings.json');
    this.data = { ...DEFAULTS };
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (raw && typeof raw === 'object') this.data = { ...DEFAULTS, ...raw };
    } catch {
      // First run, or an unreadable file: start from the defaults.
    }
    if (!SEARCH_ENGINES[this.data.searchEngine]) this.data.searchEngine = DEFAULTS.searchEngine;
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

  searchUrl(text) {
    const engine = SEARCH_ENGINES[this.data.searchEngine] || SEARCH_ENGINES.google;
    return engine.url.replace('%s', encodeURIComponent(text));
  }
}

module.exports = { Settings, SEARCH_ENGINES };
