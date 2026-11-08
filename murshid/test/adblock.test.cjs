'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const { EventEmitter } = require('node:events');
const { FiltersEngine, ENGINE_VERSION } = require('@ghostery/adblocker');
const lists = require('../app/adblock/engine');

// identity.js reads Chromium's version and the OS version, which plain Node lacks.
if (!process.versions.chrome) Object.defineProperty(process.versions, 'chrome', { value: '142.0.7444.0', enumerable: true });
if (!process.getSystemVersion) process.getSystemVersion = () => '10.0.0';

const handlers = new Map();
const electron = {
  ipcMain: { on() {}, handle(channel, fn) { handlers.set(channel, fn); } },
  session: { fromPartition() { throw new Error('tests do not download lists'); } },
  utilityProcess: {},
};
function loadWithElectron(file) {
  const original = Module._load;
  Module._load = function (name, ...args) { return name === 'electron' ? electron : original.call(this, name, ...args); };
  try { delete require.cache[require.resolve(file)]; return require(file); } finally { Module._load = original; }
}
const { Adblock } = loadWithElectron('../app/adblock');
const identity = loadWithElectron('../app/identity');

class FakeSettings extends EventEmitter {
  constructor(data) { super(); this.data = { identifyAsChrome: false, adblock: true, adblockAllowedSites: [], ...data }; }
  get(key) { return this.data[key]; }
  set(key, value) { this.data[key] = value; this.emit('changed', key, value); }
}

const FILTERS = [
  '||ads.example^',
  '@@||ads.example/allowed.js',
  '||tracker.test^$third-party',
  '||only-in-these-tests.test^',
  "||csp.test^$csp=script-src 'none'",
  '||noop.test/x.js$script,redirect=noop.js',
  '##.generic-ad',
  'shop.test##.sponsored',
].join('\n');
const testEngine = () => FiltersEngine.parse(FILTERS, lists.OPTIONS);

const WEBBRAIN = `chrome-extension://${'a'.repeat(32)}`;
const page = (url, more = {}) => ({
  id: 1, method: 'GET', resourceType: 'script', referrer: url, webContentsId: 5,
  initiatorOrigin: new URL(url).origin, frame: { url, top: { url } }, ...more,
});

/** Murshid's real webRequest listeners (app/identity.js) on a fake session, with the blocker wired in. */
function browser({ settings = new FakeSettings(), engine = testEngine() } = {}) {
  const listeners = {};
  const ses = {
    webRequest: new Proxy({}, { get: (_, name) => (fn) => { listeners[name] = fn; } }),
    preloads: [],
    registerPreloadScript(script) { this.preloads.push(script); },
  };
  const forwarded = [];
  const adblock = new Adblock({ settings, engine });
  const ctx = {
    adblock,
    crx: { forwardWebRequest: async (event, details) => { forwarded.push([event, details.url]); }, discardOffscreenRequest() {} },
  };
  identity.install(ses, settings, ctx);
  adblock.install(ses);
  clearTimeout(adblock.timer);
  const before = (details) => new Promise((resolve) => listeners.onBeforeRequest(details, resolve));
  const headers = (details) => new Promise((resolve) => listeners.onHeadersReceived(details, resolve));
  return { ses, settings, adblock, forwarded, before, headers };
}

test('onBeforeRequest cancels what the lists block and still forwards it to WebBrain', async () => {
  const { before, forwarded, ses } = browser();
  const news = 'https://news.test/article';
  assert.deepEqual(await before(page(news, { url: 'https://ads.example/banner.js' })), { cancel: true });
  assert.deepEqual(forwarded.at(-1), ['onBeforeRequest', 'https://ads.example/banner.js']);
  assert.deepEqual(await before(page(news, { url: 'https://ads.example/allowed.js' })), {});
  assert.deepEqual(await before(page(news, { url: 'https://news.test/app.js' })), {});
  // $third-party: blocked on other sites, not on its own.
  assert.deepEqual(await before(page(news, { url: 'https://tracker.test/pixel.gif', resourceType: 'image' })), { cancel: true });
  assert.deepEqual(await before(page('https://tracker.test/', { url: 'https://tracker.test/pixel.gif', resourceType: 'image' })), {});
  // Ads in a frame count for the tab's page.
  const frame = { url: 'https://embed.test/player', top: { url: news } };
  assert.deepEqual(await before(page(news, { url: 'https://ads.example/in-frame.js', initiatorOrigin: 'https://embed.test', frame })), { cancel: true });
  // A site's service worker has no frame, only its origin.
  assert.deepEqual(await before({ id: 2, url: 'https://ads.example/sw.js', resourceType: 'xhr', referrer: '', initiatorOrigin: 'https://news.test', frame: null }), { cancel: true });
  // $redirect is cancelled: Chromium refuses the library's data: stand-ins.
  assert.deepEqual(await before(page(news, { url: 'https://noop.test/x.js' })), { cancel: true });
  assert.equal(forwarded.length, 8);
  assert.deepEqual(ses.preloads.map((p) => p.id), ['murshid-identity', 'murshid-adblock']);
  assert.equal(ses.preloads[1].filePath, require.resolve('@ghostery/adblocker-electron-preload'));
});

test('pages themselves, Murshid, WebBrain and other extensions are never blocked', async () => {
  const { before, forwarded } = browser();
  const ad = 'https://ads.example/banner.js';
  // Navigating to a listed site still loads it.
  assert.deepEqual(await before({ ...page('https://ads.example/'), resourceType: 'mainFrame', url: 'https://ads.example/' }), {});
  // WebBrain's service worker (no frame) and its side panel page.
  assert.deepEqual(await before({ id: 3, url: ad, resourceType: 'xhr', referrer: '', initiatorOrigin: WEBBRAIN, frame: null }), {});
  assert.deepEqual(await before(page(`${WEBBRAIN}/sidepanel.html`, { url: ad, initiatorOrigin: WEBBRAIN })), {});
  // WebBrain's new tab page, in a tab.
  assert.deepEqual(await before(page(`${WEBBRAIN}/newtab.html`, { url: ad, initiatorOrigin: WEBBRAIN })), {});
  // Murshid's own pages and its own requests (search suggestions, downloads).
  assert.deepEqual(await before({ ...page('https://x.test/'), url: ad, initiatorOrigin: 'murshid://settings', frame: { url: 'murshid://settings/', top: { url: 'murshid://settings/' } } }), {});
  assert.deepEqual(await before({ id: 4, url: ad, resourceType: 'xhr', referrer: '' }), {});
  // Only web addresses are filtered.
  assert.deepEqual(await before(page('https://news.test/', { url: `${WEBBRAIN}/ads.example.js` })), {});
  // A frame that is already gone: fall back to the tab, then to nothing.
  const gone = { get top() { throw new Error('Render frame was disposed'); }, get url() { throw new Error('disposed'); } };
  assert.deepEqual(await before(page('https://news.test/', { url: ad, frame: gone, webContents: { isDestroyed: () => false, getURL: () => 'https://news.test/' } })), { cancel: true });
  assert.equal(forwarded.length, 8);
});

test('the Settings switch and the per-site choice turn blocking off', async () => {
  const settings = new FakeSettings({ adblockAllowedSites: ['allowed.test'] });
  const { before, adblock } = browser({ settings });
  const ad = (site) => page(`https://${site}/`, { url: 'https://ads.example/banner.js' });
  assert.deepEqual(await before(ad('allowed.test')), {});
  assert.deepEqual(await before(ad('news.test')), { cancel: true });
  settings.set('adblock', false);
  assert.equal(adblock.enabled, false);
  assert.deepEqual(await before(ad('news.test')), {});
  settings.set('adblock', true);
  assert.deepEqual(await before(ad('news.test')), { cancel: true });
  clearTimeout(adblock.timer);
  assert.equal(adblock.siteOf('https://news.test/a?b'), 'news.test');
  assert.equal(adblock.siteOf('murshid://settings/'), null);
  assert.equal(adblock.siteOf(undefined), null);
  adblock.setAllowed('news.test', true);
  assert.deepEqual(settings.get('adblockAllowedSites'), ['allowed.test', 'news.test']);
  assert.equal(adblock.isAllowed('news.test'), true);
  assert.deepEqual(await before(ad('news.test')), {});
  adblock.setAllowed('news.test', false);
  assert.deepEqual(settings.get('adblockAllowedSites'), ['allowed.test']);
  assert.deepEqual(await before(ad('news.test')), { cancel: true });
});

test('onHeadersReceived adds a list\'s Content-Security-Policy as a policy of its own', async () => {
  const { headers, forwarded } = browser();
  const doc = (url, responseHeaders, resourceType = 'mainFrame') => ({ ...page(url), url, resourceType, statusCode: 200, responseHeaders });
  const result = await headers(doc('https://csp.test/', { 'content-security-policy': ["default-src 'self'"], 'Content-Type': ['text/html'] }));
  assert.deepEqual(result.responseHeaders['content-security-policy'], ["default-src 'self'", "script-src 'none'"]);
  assert.deepEqual(result.responseHeaders['Content-Type'], ['text/html']);
  const fresh = await headers(doc('https://csp.test/other', { 'Content-Type': ['text/html'] }));
  assert.deepEqual(fresh.responseHeaders['Content-Security-Policy'], ["script-src 'none'"]);
  assert.deepEqual(await headers(doc('https://news.test/', { 'Content-Type': ['text/html'] })), {});
  // The library applies $csp to top-level pages only.
  assert.deepEqual(await headers({ ...doc('https://csp.test/embed', {}, 'subFrame'), frame: { url: 'https://csp.test/embed', top: { url: 'https://news.test/' } } }), {});
  assert.deepEqual(await headers(doc('https://csp.test/app.js', {}, 'script')), {});
  assert.deepEqual(forwarded.map(([event]) => event), Array(5).fill('onHeadersReceived'));
});

test('element hiding answers the library\'s preload for top frames of filtered pages', async () => {
  const { ses, settings } = browser();
  const inserted = [];
  const event = (url, { parent = null, session = ses } = {}) => ({
    sender: { session, isDestroyed: () => false, mainFrame: { url }, insertCSS: async (css, opts) => { inserted.push([css, opts]); } },
    senderFrame: { url, parent },
  });
  const inject = handlers.get('@ghostery/adblocker/inject-cosmetic-filters');
  const observe = handlers.get('@ghostery/adblocker/is-mutation-observer-enabled');
  await inject(event('https://shop.test/'), 'ignored');
  assert.equal(inserted.length, 1);
  assert.match(inserted[0][0], /\.sponsored/);
  assert.deepEqual(inserted[0][1], { cssOrigin: 'user' });
  await inject(event('https://shop.test/'), 'ignored', { classes: ['generic-ad', 42], ids: 'not a list', hrefs: [] });
  assert.match(inserted.at(-1)[0], /\.generic-ad/);
  assert.equal(await observe(event('https://shop.test/')), true);
  const before = inserted.length;
  await inject(event('https://shop.test/', { parent: {} }));
  await inject(event('https://shop.test/', { session: {} }));
  await inject(event(`${WEBBRAIN}/sidepanel.html`));
  await inject(event('murshid://newtab/'));
  settings.set('adblockAllowedSites', ['shop.test']);
  await inject(event('https://shop.test/'));
  assert.equal(await observe(event('https://shop.test/')), false);
  assert.equal(inserted.length, before);
});

test('the bundled engine loads with the installed library and blocks known ads and trackers', () => {
  const meta = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'app', 'adblock', 'lists.json'), 'utf8'));
  assert.equal(meta.engineVersion, ENGINE_VERSION, 'run `npm run adblock` after upgrading @ghostery/adblocker');
  assert.deepEqual(meta.lists.map((l) => l.url), lists.LISTS.map((l) => l.url));
  const adblock = new Adblock({ settings: new FakeSettings() });
  assert.ok(adblock.load());
  for (const url of ['https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js', 'https://www.google-analytics.com/analytics.js', 'https://securepubads.g.doubleclick.net/tag/js/gpt.js']) {
    assert.deepEqual(adblock.blockRequest(page('https://www.example.com/', { url })), { cancel: true }, url);
  }
  assert.equal(adblock.blockRequest(page('https://www.example.com/', { url: 'https://www.example.com/app.js' })), null);
});

test('a refreshed engine in the profile is used while it is newer than the bundled one', () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'murshid-adblock-'));
  try {
    const dir = path.join(profile, 'adblock');
    const store = (updated) => lists.writeEngine(path.join(dir, 'engine.bin.gz'), path.join(dir, 'lists.json'), lists.pack(testEngine().serialize()), { engineVersion: ENGINE_VERSION, updated, lists: [] });
    const blocksTestAds = () => {
      const adblock = new Adblock({ settings: new FakeSettings(), userData: profile });
      adblock.load();
      return Boolean(adblock.blockRequest(page('https://news.test/', { url: 'https://only-in-these-tests.test/x.js' })));
    };
    store(Date.now());
    assert.equal(blocksTestAds(), true);
    store(1);
    assert.equal(blocksTestAds(), false);
    store(Date.now());
    fs.writeFileSync(path.join(dir, 'engine.bin.gz'), 'not an engine');
    assert.equal(blocksTestAds(), false);
  } finally {
    fs.rmSync(profile, { recursive: true, force: true });
  }
});

test('a download that is not a filter list is never turned into the engine', () => {
  const list = `[Adblock Plus 2.0]\n! Version: 202611080000\n${'||x.test^\n'.repeat(200)}`;
  assert.equal(lists.looksLikeList(list), true);
  assert.equal(lists.looksLikeList('<!DOCTYPE html><html>Captive portal</html>'.padEnd(2000)), false);
  assert.equal(lists.looksLikeList(''), false);
  assert.equal(lists.listVersion(list), '202611080000');
  assert.equal(lists.listVersion('! Title: x\n! Last modified: Fri, 06 Nov 2026\n'), 'Fri, 06 Nov 2026');
  assert.throws(() => lists.buildEngine([list, list]), /expected 3 lists/);
  assert.throws(() => lists.buildEngine([list, list, '<html>'.padEnd(2000)]), /does not look like a filter list/);
  assert.throws(() => lists.buildEngine([list, list, list]), /only \d+ network filters/);
});
