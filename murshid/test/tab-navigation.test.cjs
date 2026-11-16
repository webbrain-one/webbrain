'use strict';
// Back, Forward and Reload around Murshid's load-error page, and beforeunload in
// window.open popups. Electron is faked; FakeWebContents follows Chromium's order:
// a failed main-frame load commits Chromium's own error entry for the address
// first, then did-fail-load fires.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const { EventEmitter } = require('node:events');

function loadWithElectron(file, mock) {
  const original = Module._load;
  Module._load = function (name, ...args) { return name === 'electron' ? mock : original.call(this, name, ...args); };
  try { delete require.cache[require.resolve(file)]; return require(file); } finally { Module._load = original; }
}

const dialogAnswers = [];
const dialogCalls = [];
const electron = {
  WebContentsView: class { constructor(options) { this.webContents = options.webContents; } setBackgroundColor() {} },
  dialog: { showMessageBoxSync(parent, options) { dialogCalls.push({ parent, options }); return dialogAnswers.shift() ?? 1; } },
  Menu: class {
    constructor() { this.items = []; }
    append(item) { this.items.push(item); }
    popup() { electron.lastMenu = this; }
    static buildFromTemplate(items) { const menu = new electron.Menu(); items.forEach((item) => menu.append(item)); return menu; }
  },
  MenuItem: class { constructor(options) { Object.assign(this, options); } },
  clipboard: {},
  shell: {},
};
const { Tab, dropStandInEntries, errorPageTarget } = loadWithElectron('../app/tab', electron);
const { showContextMenu } = loadWithElectron('../app/context-menu', electron);
const { popupTabMenu } = loadWithElectron('../app/menu', electron);
const { createCommands } = require('../app/commands');
const { t } = require('../app/i18n');

const A = 'https://example.com/';
const MISSING = 'https://missing.example/';
const NOT_RESOLVED = -105;

// Chromium gives standard-scheme URLs a path: murshid://error?… commits as murshid://error/?….
const canonical = (url) => (url.startsWith('murshid:') ? url.replace(/^(murshid:\/\/[a-z]+)\?/, '$1/?') : new URL(url).href);

class FakeHistory {
  constructor(wc) { this.wc = wc; this.entries = []; this.index = -1; }
  getActiveIndex() { return this.index; }
  getEntryAtIndex(index) { return this.entries[index] ? { url: this.entries[index], title: '' } : null; }
  length() { return this.entries.length; }
  canGoBack() { return this.index > 0; }
  canGoForward() { return this.index < this.entries.length - 1; }
  goBack() { this.wc.start(this.entries[this.index - 1], this.index - 1); }
  goForward() { this.wc.start(this.entries[this.index + 1], this.index + 1); }
  removeEntryAtIndex(index) {
    if (index === this.index || index < 0 || index >= this.entries.length) return false;
    this.entries.splice(index, 1);
    if (this.index > index) this.index -= 1;
    return true;
  }
}

class FakeWebContents extends EventEmitter {
  constructor() {
    super();
    this.id = 7;
    this.navigationHistory = new FakeHistory(this);
    this.down = new Set(); // hosts that do not answer
    this.inflight = 0;
    this.reloads = 0;
  }
  getURL() { return this.navigationHistory.entries[this.navigationHistory.index] || ''; }
  setWindowOpenHandler() {}
  isAudioMuted() { return false; }
  getZoomFactor() { return 1; }
  isDestroyed() { return false; }
  loadURL(url) { return this.start(canonical(url)); }
  reload() { this.reloads += 1; this.start(this.getURL(), this.navigationHistory.index); }
  reloadIgnoringCache() { this.reload(); }
  start(url, historyIndex) {
    this.inflight += 1;
    return new Promise((resolve) => setImmediate(() => {
      try { this.commit(url, historyIndex); } finally { this.inflight -= 1; resolve(); }
    }));
  }
  commit(url, historyIndex) {
    this.emit('did-start-navigation', { url, isMainFrame: true, isSameDocument: false });
    const history = this.navigationHistory;
    if (historyIndex !== undefined) history.index = historyIndex;
    else { history.entries.splice(history.index + 1, Infinity, url); history.index = history.entries.length - 1; }
    if (/^https?:/.test(url) && this.down.has(new URL(url).host)) {
      // Chromium has committed its own error entry for the address by now.
      this.emit('did-fail-load', {}, NOT_RESOLVED, 'ERR_NAME_NOT_RESOLVED', url, true);
      return;
    }
    this.emit('did-navigate', {}, url, 200);
    this.emit('page-title-updated', {}, url.startsWith('murshid://error') ? 'Page didn\'t load' : `Title of ${new URL(url).host}`);
    this.emit('did-finish-load');
  }
  async idle() { while (this.inflight) await new Promise((resolve) => setImmediate(resolve)); }
}

function makeTab() {
  const wc = new FakeWebContents();
  const titles = [];
  const ctx = {
    ses: {},
    newTabUrl: () => 'murshid://newtab/',
    newTabUrls: () => ['murshid://newtab/', 'murshid://newtab'],
    history: { recordVisit() {}, setTitle: (url, title) => titles.push([url, title]), setFavicon() {} },
    commands: { handleInput() {} },
    contextMenu() {},
    extensions: { getContextMenuItems: () => [] },
    crx: {},
    settings: {},
    lastFocusedWindow: () => null,
  };
  const owner = { ctx, win: { id: 'main window' }, scheduleState() {}, tabs: [], closedTabs: [] };
  const tab = new Tab(owner, { webContents: wc });
  owner.tabs.push(tab);
  return { tab, wc, ctx, owner, titles };
}

/** A tab that loaded example.com, then failed to load missing.example. */
async function failedTab() {
  const made = makeTab();
  made.wc.down.add('missing.example');
  made.tab.load(A); await made.wc.idle();
  made.tab.load(MISSING); await made.wc.idle();
  return made;
}

const back = async (tab, wc) => { createCommands({}).run.back({ activeTab: tab }); await wc.idle(); };
const forward = async (tab, wc) => { createCommands({}).run.forward({ activeTab: tab }); await wc.idle(); };
// Error pages show as error:<address>; parsed here, not with tab.js, so this also runs against old code.
const historyUrls = (wc) => wc.navigationHistory.entries.map((url) => (url.startsWith('murshid://error') ? `error:${new URL(url).searchParams.get('url')}` : url));

test('the load-error page replaces the failed entry, so Back leaves it', async () => {
  const { tab, wc, titles } = await failedTab();
  assert.equal(tab.url, MISSING);
  assert.equal(tab.title, 'missing.example');
  assert.match(wc.getURL(), /^murshid:\/\/error\/\?/);
  assert.deepEqual(historyUrls(wc), [A, `error:${MISSING}`]);
  assert.equal(tab.state().canGoBack, true);
  // The error page's own title must not become the failed site's history title.
  assert.deepEqual(titles.filter(([url]) => url === MISSING), []);

  await back(tab, wc);
  assert.equal(tab.url, A);
  assert.equal(tab.errorFor, null);
  assert.equal(wc.navigationHistory.index, 0);
});

test('Forward onto the error page shows the failed address, and Reload tries it again', async () => {
  const { tab, wc } = await failedTab();
  await back(tab, wc);
  await forward(tab, wc);
  assert.equal(tab.errorFor, MISSING);
  assert.equal(tab.url, MISSING);
  assert.equal(tab.title, 'missing.example');

  wc.down.clear();
  createCommands({}).run.reload({ activeTab: tab });
  await wc.idle();
  assert.equal(tab.url, MISSING);
  assert.equal(tab.errorFor, null);
  assert.equal(wc.reloads, 0);
  // The page that loaded takes the error page's place.
  assert.deepEqual(historyUrls(wc), [A, MISSING]);
});

test('retrying while the site is still down does not stack error pages', async () => {
  const { tab, wc } = await failedTab();
  for (let i = 0; i < 3; i += 1) { createCommands({}).run.reload({ activeTab: tab }); await wc.idle(); }
  createCommands({}).run.hardReload({ activeTab: tab }); await wc.idle();
  assert.equal(wc.reloads, 0);
  assert.equal(tab.errorFor, MISSING);
  assert.deepEqual(historyUrls(wc), [A, `error:${MISSING}`]);
  await back(tab, wc);
  assert.equal(tab.url, A);
});

test('a failed Back while offline still moves back instead of looping', async () => {
  const made = makeTab();
  const { tab, wc } = made;
  for (const url of ['https://one.example/', 'https://two.example/', A]) { tab.load(url); await wc.idle(); }
  wc.down.add('two.example');
  await back(tab, wc);
  assert.equal(tab.url, 'https://two.example/');
  assert.deepEqual(historyUrls(wc), ['https://one.example/', 'error:https://two.example/']);
  await back(tab, wc);
  assert.equal(tab.url, 'https://one.example/');
});

test('page and tab menu Reload retry the failed address', async () => {
  for (const open of [
    ({ ctx, tab }) => { showContextMenu(ctx, tab, { mediaType: 'none', editFlags: {} }); return t('context.reload'); },
    ({ ctx, owner, tab }) => { popupTabMenu(ctx, owner, tab, { x: 0, y: 0 }); return t('tabMenu.reload'); },
  ]) {
    const made = await failedTab();
    made.wc.down.clear();
    const label = open(made);
    electron.lastMenu.items.find((item) => item.label === label).click();
    await made.wc.idle();
    assert.equal(made.wc.reloads, 0, label);
    assert.equal(made.tab.errorFor, null, label);
    assert.deepEqual(historyUrls(made.wc), [A, MISSING], label);
  }
});

test('a murshid://error address this tab did not make is only a page', async () => {
  const { tab, wc } = makeTab();
  tab.load(`murshid://error?${new URLSearchParams({ url: 'https://other.example/', code: '-105', description: 'ERR_NAME_NOT_RESOLVED' })}`);
  await wc.idle();
  assert.equal(tab.errorFor, null);
  assert.match(tab.url, /^murshid:\/\/error\//);
  createCommands({}).run.reload({ activeTab: tab }); await wc.idle();
  assert.equal(wc.reloads, 1);
});

test('dropStandInEntries removes only stand-ins for the same address', () => {
  const page = (url) => canonical(`murshid://error?${new URLSearchParams({ url, code: '-105', description: 'ERR_NAME_NOT_RESOLVED' })}`);
  const history = (entries) => { const h = new FakeHistory(null); h.entries = [...entries]; h.index = entries.length - 1; return h; };
  const X = 'https://x.example/';
  // A fresh error page: Chromium's entry for X goes, an earlier real visit to X stays.
  let h = history([A, X, X, page(X)]);
  assert.equal(dropStandInEntries(h, page(X), { fresh: true }), 1);
  assert.deepEqual(h.entries, [A, X, page(X)]);
  // Coming back to an error page through history removes nothing.
  h = history([X, page(X)]);
  assert.equal(dropStandInEntries(h, page(X)), 0);
  // Earlier error pages for the same address go; one for another address stays.
  h = history([page(MISSING), page(X), X, page(X)]);
  assert.equal(dropStandInEntries(h, page(X), { fresh: true }), 2);
  assert.deepEqual(h.entries, [page(MISSING), page(X)]);
  // A page that loads replaces the error page for its own address only.
  h = history([page(MISSING), page(X), X]);
  assert.equal(dropStandInEntries(h, X), 1);
  assert.deepEqual(h.entries, [page(MISSING), X]);
  h = history([page(X)]);
  assert.equal(dropStandInEntries(h, page(X), { fresh: true }), 0);
  assert.equal(errorPageTarget('murshid://settings/?url=https://x.example/'), null);
});

test('a popup with beforeunload asks before closing, and so do popups it opens', () => {
  const { wc, ctx } = makeTab();
  const popup = { webContents: new EventEmitter() };
  wc.emit('did-create-window', popup, { disposition: 'new-window' });
  const unload = (target) => {
    let prevented = false;
    target.webContents.emit('will-prevent-unload', { preventDefault: () => { prevented = true; } });
    return prevented;
  };
  dialogCalls.length = 0;
  dialogAnswers.push(0);
  assert.equal(unload(popup), true, 'Leave lets the popup close');
  assert.equal(dialogCalls[0].parent, popup);
  assert.equal(dialogCalls[0].options.message, t('leave.message'));
  ctx.quitting = true;
  dialogAnswers.push(1);
  assert.equal(unload(popup), false, 'Stay keeps it open');
  assert.equal(ctx.quitting, false);
  const child = { webContents: new EventEmitter() };
  popup.webContents.emit('did-create-window', child, { disposition: 'new-window' });
  dialogAnswers.push(0);
  assert.equal(unload(child), true);
  assert.equal(dialogCalls.length, 3);
});
