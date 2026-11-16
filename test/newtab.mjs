import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const nt = (...p) => path.join(root, 'newtab', 'src', ...p);
const load = (file) => import(pathToFileURL(file).href);

const { createNamespacedStorage, NAMESPACE_PREFIX } = await load(nt('lib/storage-namespace.js'));
const { buildHandoff, toNavigableUrl, submitTask, openAskChat, TAB_CHAT_PATH, HANDOFF_TARGET_PANEL, HANDOFF_TARGET_TAB_CHAT, handoffKey, HANDOFF_PREFIX, isHandoffPending, whenClaimed, adoptPendingHandoff, pendingHandoffText } = await load(nt('features/agent/handoff.js'));
const { getTitleFromUrl } = await load(nt('utils/links/getTitleFromUrl.js'));
const { normalizeLinkUrl } = await load(nt('utils/links/normalizeLinkUrl.js'));
const { chatBackdropSnapshot, saveChatBackdrop, setShownBackground, CHAT_BACKDROP_KEY } = await load(nt('features/background/api/chatBackdrop.js'));
const vm = await import('node:vm');

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function memoryStorage(seed = {}) {
  const map = new Map(Object.entries(seed));
  return {
    get length() { return map.size; },
    key: (i) => [...map.keys()][i] ?? null,
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
    removeItem: (k) => { map.delete(k); },
    clear: () => map.clear(),
    _map: map,
  };
}

test('new tab storage is namespaced and cannot touch WebBrain keys', () => {
  const real = memoryStorage({ wbLocale: 'fr', apiKey: 'secret' });
  const ls = createNamespacedStorage(real);
  ls.setItem('theme', 'dark');
  assert.equal(real.getItem(`${NAMESPACE_PREFIX}theme`), 'dark');
  assert.equal(ls.getItem('wbLocale'), null);
  assert.equal(ls.getItem('theme'), 'dark');
  ls.clear();
  assert.equal(real.getItem('wbLocale'), 'fr');
  assert.equal(real.getItem('apiKey'), 'secret');
  assert.equal(ls.length, 0);
});

test('toNavigableUrl only accepts http(s) and bare hosts', () => {
  assert.equal(toNavigableUrl('https://example.com/a'), 'https://example.com/a');
  assert.equal(toNavigableUrl('example.com'), 'https://example.com/');
  assert.equal(toNavigableUrl('localhost:3000/x'), 'http://localhost:3000/x', 'local hosts open over http, as from the address bar');
  assert.equal(toNavigableUrl('javascript:alert(1)'), null);
  assert.equal(toNavigableUrl('data:text/html,hi'), null);
  assert.equal(toNavigableUrl('chrome://settings'), null);
  assert.equal(toNavigableUrl('file:///etc/passwd'), null);
  assert.equal(toNavigableUrl('how do i cook rice'), null);
  assert.equal(toNavigableUrl(''), null);
});

// What a user types into the box on its own: an address opens, anything else
// is a prompt. Names need a real top-level domain (tlds.js, from IANA).
test('toNavigableUrl opens an address typed alone and leaves look-alike prompts', async () => {
  for (const [input, url] of [
    ['example.com', 'https://example.com/'],
    ['www.example.com/path?q=1#top', 'https://www.example.com/path?q=1#top'],
    ['mastoturk.org/home', 'https://mastoturk.org/home'],
    ['github.io', 'https://github.io/'],
    ['Example.COM/A', 'https://example.com/A'],
    ['http://example.com', 'http://example.com/'],
    ['HTTPS://example.com/x', 'https://example.com/x'],
    ['türkiye.gov.tr', 'https://xn--trkiye-3ya.gov.tr/'],
    ['пример.рф', 'https://xn--e1afmkfd.xn--p1ai/'],
    ['8.8.8.8', 'https://8.8.8.8/'],
    ['localhost', 'http://localhost/'],
    ['localhost:5173', 'http://localhost:5173/'],
    ['127.0.0.1:8080/api', 'http://127.0.0.1:8080/api'],
    ['192.168.1.1', 'http://192.168.1.1/'],
    ['[::1]:3000', 'http://[::1]:3000/'],
    ['printer.local', 'http://printer.local/'],
    ['app.test:8000/x', 'http://app.test:8000/x'],
  ]) {
    assert.equal(toNavigableUrl(input), url, input);
  }
  for (const input of [
    'node.js', 'next.js', 'notes.txt', 'config.yaml', 'package.json', 'index.html',
    'summarize example.com', 'what is example.com?', 'open example.com',
    'john@example.com', 'example.com@evil.com', 'mailto:a@b.com', 'ftp://example.com',
    '1.2.30', '3.14', 'v2.0', 'e.g.', 'example', 'example.com.', '999.1.1.1', 'localhost:99999',
  ]) {
    assert.equal(toNavigableUrl(input), null, input);
  }
  const { TLDS, TLDS_VERSION } = await load(nt('features/agent/tlds.js'));
  assert.match(TLDS_VERSION, /^\d{10}$/);
  assert.ok(TLDS.size > 1000, 'the whole IANA list');
  assert.ok([...TLDS].every((tld) => /^(?:[a-z]{2,63}|xn--[a-z0-9-]+)$/.test(tld)), 'lower-case ASCII and punycode, as URL#hostname gives them');
});

// A bracketed IPv6 address needs no top-level domain. Like IPv4, a public one
// opens over https and this computer or the local network over http.
test('toNavigableUrl opens a bracketed IPv6 address typed alone', () => {
  for (const [input, url] of [
    ['[2001:db8::1]', 'https://[2001:db8::1]/'],
    ['[2606:4700:4700::1111]/dns-query?x=1', 'https://[2606:4700:4700::1111]/dns-query?x=1'],
    ['[2001:DB8:0:0:0:0:0:1]:8443', 'https://[2001:db8::1]:8443/'],
    ['[::ffff:8.8.8.8]', 'https://[::ffff:808:808]/'],
    ['[fec0::1]', 'https://[fec0::1]/'],
    ['[fbff::1]', 'https://[fbff::1]/'],
    ['[::1]', 'http://[::1]/'],
    ['[::]:8000', 'http://[::]:8000/'],
    ['[fe80::1]:8080', 'http://[fe80::1]:8080/'],
    ['[FE80::1]', 'http://[fe80::1]/'],
    ['[febf::1]', 'http://[febf::1]/'],
    ['[fe80::]', 'http://[fe80::]/'],
    ['[fc00::1]', 'http://[fc00::1]/'],
    ['[fd12:3456::7]/admin', 'http://[fd12:3456::7]/admin'],
    ['[::ffff:127.0.0.1]:3000', 'http://[::ffff:7f00:1]:3000/'],
    ['[::ffff:192.168.1.1]', 'http://[::ffff:c0a8:101]/'],
  ]) {
    assert.equal(toNavigableUrl(input), url, input);
  }
  for (const input of [
    '[1::2::3]', '[12345::1]', '[dead:beef]', '[gg::1]', '[1]', '[::1', '[::1]x',
    '[fe80::1%eth0]', '[::1]:99999', '[2001:db8::1] is down?',
  ]) {
    assert.equal(toNavigableUrl(input), null, input);
  }
});

test('the task box opens a typed address in every mode instead of handing it to WebBrain', () => {
  const src = readFileSync(nt('features/agent/TaskBox.jsx'), 'utf8');
  const submit = src.slice(src.indexOf('const onSubmit'), src.indexOf('return (\n'));
  const check = submit.indexOf('const address = toNavigableUrl(value);');
  assert.ok(check > 0, 'onSubmit checks for an address');
  assert.match(submit, /if \(address\) \{\s*window\.location\.assign\(address\);\s*return;\s*\}/);
  for (const later of ["if (mode === 'search')", 'const handOver =']) {
    assert.ok(submit.indexOf(later) > check, `the address check comes before ${later}`);
  }
});

test('buildHandoff clamps text and defaults to ask', () => {
  const h = buildHandoff({ text: 'x'.repeat(9000), mode: 'whatever', tabId: 7, now: 1000 });
  assert.equal(h.text.length, 4000);
  assert.equal(h.mode, 'ask');
  assert.equal(h.tabId, 7);
  assert.equal(buildHandoff({ text: 'a', mode: 'act', tabId: 1 }).mode, 'act');
});

test('submitTask stores the task, opens the panel from the same tick, then announces it', async () => {
  const calls = [];
  const api = {
    storage: { local: { set: (v) => { calls.push(['set', v]); return Promise.resolve(); } } },
    sidePanel: {
      setOptions: () => { calls.push(['setOptions']); return Promise.resolve(); },
      open: (o) => { calls.push(['open', o]); return Promise.resolve(); },
    },
    runtime: { sendMessage: (m) => { calls.push(['msg', m]); return Promise.resolve(); } },
  };
  const p = submitTask({ text: 'hello', mode: 'act' }, api, { id: 42 });
  // Everything needed for the user gesture must have happened synchronously.
  assert.deepEqual(calls.map((c) => c[0]), ['set', 'setOptions', 'open']);
  assert.equal(calls[0][1][handoffKey(42)].mode, 'act');
  assert.deepEqual(calls[2][1], { tabId: 42 });
  await p;
  assert.deepEqual(calls.at(-1)[1], { type: 'WB_NEWTAB_PANEL_OPENED', tabId: 42 });
  await assert.rejects(() => submitTask({ text: 'x', mode: 'ask' }, api, null));
});

test('Ask stores the task for this tab, then turns the tab into the full-page chat', async () => {
  const calls = [];
  const api = {
    storage: { local: { set: async (v) => { calls.push(['set', v]); }, get: async () => ({}) } },
    runtime: { getURL: (p) => `chrome-extension://wb/${p}` },
  };
  await openAskChat({ text: 'what is a murshid?' }, api, { id: 31 }, (url) => calls.push(['navigate', url]));
  assert.deepEqual(calls.map((c) => c[0]), ['set', 'navigate'], 'the task is stored before the page is left');
  const record = calls[0][1][handoffKey(31)];
  assert.equal(record.mode, 'ask');
  assert.equal(record.tabId, 31);
  assert.equal(record.text, 'what is a murshid?');
  assert.equal(calls[1][1], 'chrome-extension://wb/src/ui/sidepanel.html?mode=ask&standalone=true&tab=1');
  // No side panel is involved: nothing asks to open one or announces one.
  assert.equal(api.sidePanel, undefined);
  await assert.rejects(() => openAskChat({ text: 'x' }, api, null, () => {}));
});

test('Ask that cannot store its task stays on the new tab and unlocks', async () => {
  let navigated = false;
  const api = {
    storage: { local: { set: async () => { throw new Error('quota'); } } },
    runtime: { getURL: (p) => p },
  };
  await assert.rejects(() => openAskChat({ text: 'x' }, api, { id: 32 }, () => { navigated = true; }), /quota/);
  assert.equal(navigated, false);
  assert.equal(isHandoffPending(32), false);
});

test('the full-page chat path is the one the side panel page treats as a tab chat', () => {
  const params = new URL(`chrome-extension://wb/${TAB_CHAT_PATH}`).searchParams;
  assert.equal(params.get('standalone'), 'true');
  assert.equal(params.get('tab'), '1');
  assert.equal(params.get('mode'), 'ask');
  for (const browserDir of ['chrome', 'firefox']) {
    const src = readFileSync(path.join(root, 'src', browserDir, 'src', 'ui', 'sidepanel.js'), 'utf8');
    assert.match(src, /const isTabChat = isStandaloneWindow && _btwParams\.get\('tab'\) === '1';/, browserDir);
    // Bound to its own tab, never retargeted by tab switches.
    assert.match(src, /const ownTab = isTabChat \? await (chrome|browser)\.tabs\.getCurrent\(\)/, browserDir);
    assert.match(src, /const windowScope = isBtwWindow \|\| isTabChat \? null : createSidePanelWindowScope\(/, browserDir);
  }
  // On Chrome it must not report itself as the window's side panel either.
  const chromeSrc = readFileSync(path.join(root, 'src', 'chrome', 'src', 'ui', 'sidepanel.js'), 'utf8');
  assert.match(chromeSrc, /const presenceReportedEarly = !isBtwWindow && !isTabChat && initialWindowId != null;/);
  assert.match(chromeSrc, /if \(!isBtwWindow && !isTabChat && !presenceReportedEarly\)/);
});

test('the task box sends Ask to the full-page chat and Act to the side panel', () => {
  const src = readFileSync(nt('features/agent/TaskBox.jsx'), 'utf8');
  assert.match(src, /const handOver = mode === 'ask' \? openAskChat : submitTask;/);
});

// ---- The full-page chat keeps the new tab's background ----

const NEWTAB_BASE = 'chrome-extension://wb/newtab/index.html';

test('the chat backdrop describes the background on screen and never copies an upload', () => {
  const snap = (data, settings = {}) => chatBackdropSnapshot(data, { storage: memoryStorage(settings), base: NEWTAB_BASE });
  // A bundled photo, with the new tab's effects.
  assert.deepEqual(
    snap({ url: 'src/assets/offline-images/3.webp', photoInfo: { offline: true } },
      { blur: '6', brightness: '70', backgroundFilter: 'sepia', backgroundFilterAmount: '40' }),
    { v: 1, image: 'chrome-extension://wb/newtab/src/assets/offline-images/3.webp', blur: 6, brightness: 70, filter: 'sepia', filterAmount: 40 },
  );
  assert.deepEqual(snap({ url: 'https://example.com/a.jpg', photoInfo: { colour: '#123456' } }),
    { v: 1, image: 'https://example.com/a.jpg', colour: '#123456', blur: 0, brightness: 100 });
  // Out-of-range numbers are bounded and an unknown filter is dropped.
  assert.deepEqual(snap({ url: 'https://example.com/a.jpg', photoInfo: {} }, { blur: '500', brightness: '-3', backgroundFilter: 'hue-rotate' }),
    { v: 1, image: 'https://example.com/a.jpg', blur: 100, brightness: 0 });
  // An upload goes by its id in the new tab's database; the picture itself stays behind.
  const upload = snap({ url: 'data:image/png;base64,AAAA', photoInfo: { customId: 7 } });
  assert.deepEqual(upload, { v: 1, customId: 7, blur: 0, brightness: 100 });
  assert.equal(snap({ url: 'data:image/png;base64,AAAA', photoInfo: {} }), null, 'an inline picture without an id is not copied');
  assert.equal(snap({ url: 'blob:chrome-extension://wb/1', photoInfo: {} }), null, 'a blob address dies with the new tab');
  // Colours and gradients go as their CSS value, never anything that loads something. The new
  // tab's effect overlay covers them too, so their effects go along.
  assert.deepEqual(snap({ url: '', style: 'background: rgb(10, 120, 90)' }), { v: 1, background: 'rgb(10, 120, 90)', blur: 0, brightness: 100 });
  assert.deepEqual(snap({ url: '', style: 'background:linear-gradient(to right, #abcdef, #123456);' }, { brightness: '30', backgroundFilter: 'invert', backgroundFilterAmount: '100' }),
    { v: 1, background: 'linear-gradient(to right, #abcdef, #123456)', blur: 0, brightness: 30, filter: 'invert', filterAmount: 100 });
  assert.equal(snap({ url: '', style: 'background: url(https://example.com/x.png)' }), null);
  // Nothing to carry over.
  assert.equal(snap({ url: 'https://example.com/v.mp4', video: true, photoInfo: {} }), null, 'videos are not carried over');
  assert.equal(snap({ url: 'https://example.com/a.jpg', photoInfo: {} }, { background: 'false' }), null, 'backgrounds turned off');
  assert.equal(snap({ url: '', style: '' }), null);
  assert.equal(snap(null), null);
});

test('the new tab remembers what it shows, and uploads carry their id', () => {
  setShownBackground({ url: 'https://example.com/b.jpg', photoInfo: {} });
  assert.equal(chatBackdropSnapshot(undefined, { storage: memoryStorage(), base: NEWTAB_BASE }).image, 'https://example.com/b.jpg');
  setShownBackground(null);
  assert.equal(chatBackdropSnapshot(undefined, { storage: memoryStorage(), base: NEWTAB_BASE }), null);
  const background = readFileSync(nt('features/background/Background.jsx'), 'utf8');
  assert.match(background, /useEffect\(\(\) => setShownBackground\(backgroundData\), \[backgroundData\]\);/);
  const loader = readFileSync(nt('features/background/api/backgroundLoader.js'), 'utf8');
  assert.match(loader, /photoInfo: \{[\s\S]*?\{ customId: selected\.id \}[\s\S]*?\}/, 'custom backgrounds keep their database id');
});

test('saving the chat backdrop writes this tab\'s copy and never throws', () => {
  const session = memoryStorage();
  assert.equal(saveChatBackdrop(session, { v: 1, background: 'red' }), true);
  assert.deepEqual(JSON.parse(session.getItem(CHAT_BACKDROP_KEY)), { v: 1, background: 'red' });
  assert.equal(saveChatBackdrop(session, null), false);
  assert.equal(session.getItem(CHAT_BACKDROP_KEY), null, 'nothing to carry over clears an older one');
  assert.equal(saveChatBackdrop({ setItem() { throw new Error('quota'); }, removeItem() {} }, { v: 1 }), false);
  assert.equal(saveChatBackdrop(undefined, { v: 1 }), false);
});

test('Ask leaves the backdrop for the chat right before it navigates', async () => {
  const calls = [];
  const api = {
    storage: { local: { set: async () => { calls.push('set'); }, get: async () => ({}) } },
    runtime: { getURL: (p) => p },
  };
  await openAskChat({ text: 'q' }, api, { id: 61 }, () => calls.push('navigate'), () => calls.push('backdrop'));
  assert.deepEqual(calls, ['set', 'backdrop', 'navigate']);
  // It is cosmetic: failing to save it never stops the hand-off.
  let navigated = false;
  await openAskChat({ text: 'q' }, api, { id: 62 }, () => { navigated = true; }, () => { throw new Error('blocked'); });
  assert.equal(navigated, true);
  // A task that could not be stored leaves no backdrop behind either.
  let remembered = false;
  const failing = { storage: { local: { set: async () => { throw new Error('quota'); } } }, runtime: { getURL: (p) => p } };
  await assert.rejects(() => openAskChat({ text: 'q' }, failing, { id: 63 }, () => {}, () => { remembered = true; }));
  assert.equal(remembered, false);
});

function fakeIdb({ listed = true, record = () => undefined } = {}) {
  const opened = [];
  return {
    opened,
    databases: async () => (listed ? [{ name: 'MueCustomBackgrounds' }] : []),
    open(name) {
      opened.push(name);
      const request = {};
      setTimeout(() => {
        request.result = {
          objectStoreNames: { contains: (store) => store === 'backgrounds' },
          close() {},
          transaction: () => ({
            objectStore: () => ({
              get(id) {
                const get = {};
                setTimeout(() => { get.result = record(id); get.onsuccess?.(); }, 0);
                return get;
              },
            }),
          }),
        };
        request.onsuccess?.();
      }, 0);
      return request;
    },
  };
}

function runChatBackdrop(browserDir, { search = '?mode=ask&standalone=true&tab=1', stored, supports = () => true, indexedDB } = {}) {
  const src = readFileSync(path.join(root, 'src', browserDir, 'src', 'ui', 'tab-chat-backdrop.js'), 'utf8');
  const attrs = new Map();
  const props = new Map();
  const seed = stored === undefined ? {} : { [CHAT_BACKDROP_KEY]: typeof stored === 'string' ? stored : JSON.stringify(stored) };
  vm.runInNewContext(src, {
    document: { documentElement: { setAttribute: (k, v) => attrs.set(k, String(v)), style: { setProperty: (k, v) => props.set(k, String(v)) } } },
    window: { location: { search, origin: 'chrome-extension://wb' }, sessionStorage: memoryStorage(seed) },
    URL,
    URLSearchParams,
    CSS: { supports },
    indexedDB,
    setTimeout,
  });
  return { attrs, props };
}

test('the full-page chat paints the new tab background it is given, and checks it first', async () => {
  for (const browserDir of ['chrome', 'firefox']) {
    const bundled = 'chrome-extension://wb/newtab/src/assets/offline-images/3.webp';
    let { attrs, props } = runChatBackdrop(browserDir, {
      stored: { v: 1, image: bundled, colour: '#123456', blur: 6, brightness: 70, filter: 'sepia', filterAmount: 40 },
    });
    assert.equal(attrs.get('data-tab-chat'), 'true', browserDir);
    assert.equal(attrs.get('data-tab-chat-backdrop'), 'image', browserDir);
    assert.equal(props.get('--tab-chat-backdrop-image'), `url("${bundled}")`, browserDir);
    assert.equal(props.get('--tab-chat-backdrop-colour'), '#123456', browserDir);
    // The new tab's order: blur and the effect first, then darkened (brightness last). With
    // brightness 0 and invert the new tab is black, and so must the chat be.
    assert.equal(props.get('--tab-chat-backdrop-filter'), 'blur(6px) sepia(40%) brightness(70%)', browserDir);
    assert.equal(props.get('--tab-chat-backdrop-bleed'), '-12px', browserDir);
    ({ props } = runChatBackdrop(browserDir, { stored: { v: 1, image: bundled, brightness: 0, filter: 'invert', filterAmount: 100 } }));
    assert.equal(props.get('--tab-chat-backdrop-filter'), 'invert(100%) brightness(0%)', browserDir);

    ({ props } = runChatBackdrop(browserDir, { stored: { v: 1, image: 'https://example.com/a.jpg', blur: 999, brightness: -5, filter: 'url(x)' } }));
    assert.equal(props.get('--tab-chat-backdrop-filter'), 'blur(100px) brightness(0%)', `${browserDir}: numbers are bounded, unknown filters dropped`);
    ({ props } = runChatBackdrop(browserDir, { stored: { v: 1, image: 'https://example.com/a.jpg' } }));
    assert.equal(props.get('--tab-chat-backdrop-filter'), 'none', browserDir);

    ({ attrs, props } = runChatBackdrop(browserDir, { stored: { v: 1, background: 'linear-gradient(to right, #abcdef, #123456)' } }));
    assert.equal(attrs.get('data-tab-chat-backdrop'), 'colour', browserDir);
    assert.equal(props.get('--tab-chat-backdrop-background'), 'linear-gradient(to right, #abcdef, #123456)', browserDir);
    assert.equal(props.get('--tab-chat-backdrop-filter'), 'none', browserDir);
    ({ attrs, props } = runChatBackdrop(browserDir, { stored: { v: 1, background: 'rgb(10, 120, 90)', brightness: 30, filter: 'grayscale', filterAmount: 50 } }));
    assert.equal(attrs.get('data-tab-chat-backdrop'), 'colour', browserDir);
    assert.equal(props.get('--tab-chat-backdrop-filter'), 'grayscale(50%) brightness(30%)', `${browserDir}: colours keep their effects`);

    // Anything else leaves the column on its plain surround.
    for (const stored of [
      { v: 1, image: 'javascript:alert(1)' },
      { v: 1, image: 'file:///C:/secret.jpg' },
      { v: 1, image: 'chrome-extension://other/x.webp' },
      { v: 1, image: 'data:image/png;base64,AAAA' },
      { v: 1, background: 'url(https://example.com/x.png)' },
      { v: 1, background: 'red'.padEnd(400, ' ') },
      { v: 2, image: bundled },
      '{not json',
      undefined,
    ]) {
      ({ attrs } = runChatBackdrop(browserDir, { stored }));
      assert.equal(attrs.get('data-tab-chat'), 'true', `${browserDir}: ${JSON.stringify(stored)}`);
      assert.equal(attrs.has('data-tab-chat-backdrop'), false, `${browserDir}: ${JSON.stringify(stored)}`);
    }
    ({ attrs } = runChatBackdrop(browserDir, { stored: { v: 1, background: 'nonsense' }, supports: () => false }));
    assert.equal(attrs.has('data-tab-chat-backdrop'), false, `${browserDir}: a value the browser rejects is not used`);

    // Only the full-page chat: the side panel and the standalone window keep their layout.
    for (const search of ['', '?mode=ask&standalone=true', '?tab=1']) {
      ({ attrs } = runChatBackdrop(browserDir, { search, stored: { v: 1, image: bundled } }));
      assert.equal(attrs.size, 0, `${browserDir}: ${search || 'side panel'}`);
    }

    // An upload is read from the new tab's own database, by id.
    const idb = fakeIdb({ record: (id) => (id === 4 ? { url: 'data:image/png;base64,AAAA' } : undefined) });
    ({ attrs, props } = runChatBackdrop(browserDir, { stored: { v: 1, customId: 4 }, indexedDB: idb }));
    for (let i = 0; i < 5; i += 1) await flush();
    assert.equal(attrs.get('data-tab-chat-backdrop'), 'image', browserDir);
    assert.equal(props.get('--tab-chat-backdrop-image'), 'url("data:image/png;base64,AAAA")', browserDir);
    // ... but never opened when it does not exist (opening would create an empty one the new tab could not use).
    const missing = fakeIdb({ listed: false });
    ({ attrs } = runChatBackdrop(browserDir, { stored: { v: 1, customId: 4 }, indexedDB: missing }));
    for (let i = 0; i < 5; i += 1) await flush();
    assert.deepEqual(missing.opened, [], browserDir);
    assert.equal(attrs.has('data-tab-chat-backdrop'), false, browserDir);
    // A record that is not a picture is ignored.
    const odd = fakeIdb({ record: () => ({ url: 'javascript:alert(1)' }) });
    ({ attrs } = runChatBackdrop(browserDir, { stored: { v: 1, customId: 4 }, indexedDB: odd }));
    for (let i = 0; i < 5; i += 1) await flush();
    assert.equal(attrs.has('data-tab-chat-backdrop'), false, browserDir);
  }
});

test('the chat backdrop script is loaded before first paint and matches the new tab', () => {
  const read = (browserDir, ...p) => readFileSync(path.join(root, 'src', browserDir, ...p), 'utf8');
  const script = read('chrome', 'src', 'ui', 'tab-chat-backdrop.js');
  assert.equal(read('firefox', 'src', 'ui', 'tab-chat-backdrop.js'), script, 'Chrome and Firefox copies are identical');
  assert.match(script, new RegExp(`var KEY = '${CHAT_BACKDROP_KEY}';`), 'the chat reads the key the new tab writes');
  const effects = readFileSync(nt('features/background/options/optionTypes/backgroundImageEffects.js'), 'utf8');
  const offered = [...effects.matchAll(/value: '([a-z-]+)'/g)].map((m) => m[1]).filter((v) => v !== 'none');
  assert.deepEqual(JSON.parse(/var FILTERS = (\[[^\]]*\])/.exec(script)[1].replace(/'/g, '"')), offered, 'every new tab filter is understood');
  for (const browserDir of ['chrome', 'firefox']) {
    const html = read(browserDir, 'src', 'ui', 'sidepanel.html');
    assert.match(html, /<script src="theme-bootstrap\.js"><\/script>[\s\S]*?<script src="tab-chat-backdrop\.js"><\/script>[\s\S]*?<link rel="stylesheet" href="\.\.\/\.\.\/styles\/sidepanel\.css">/, browserDir);
    const css = read(browserDir, 'styles', 'sidepanel.css');
    assert.match(css, /html\[data-tab-chat="true"\] body \{[^}]*max-width: 880px;[^}]*margin-inline: auto;/, browserDir);
    assert.match(css, /html\[data-tab-chat-backdrop\]::before \{[^}]*position: fixed;[^}]*z-index: -1;[^}]*filter: var\(--tab-chat-backdrop-filter, none\);/, `${browserDir}: effects apply to every backdrop kind`);
    // The surround needs its own background, or the column's would spread to the whole page.
    assert.match(css, /html\[data-tab-chat="true"\] \{[^}]*background:/, browserDir);
  }
});

function failingApi({ open, withSidePanel = true } = {}) {
  const store = new Map();
  const listeners = [];
  const api = {
    storage: {
      local: {
        set: async (v) => { for (const [k, val] of Object.entries(v)) store.set(k, val); },
        get: async (k) => (store.has(k) ? { [k]: store.get(k) } : {}),
        remove: async (k) => { store.delete(k); },
      },
    },
    runtime: { sendMessage: async () => {} },
    _store: store,
    _claim(tabId) {
      const key = handoffKey(tabId);
      const oldValue = store.get(key);
      store.delete(key);
      [...listeners].forEach((fn) => fn({ [key]: { oldValue } }, 'local'));
    },
  };
  api.storage.onChanged = {
    addListener: (fn) => listeners.push(fn),
    removeListener: (fn) => { const i = listeners.indexOf(fn); if (i >= 0) listeners.splice(i, 1); },
  };
  if (withSidePanel) api.sidePanel = { setOptions: async () => {}, open };
  return api;
}

test('a failed panel open removes the stored task so it cannot be sent later', async () => {
  const rejected = failingApi({ open: () => Promise.reject(new Error('no gesture')) });
  await assert.rejects(() => submitTask({ text: 'secret plan', mode: 'ask' }, rejected, { id: 1 }), /no gesture/);
  assert.equal(rejected._store.has(handoffKey(1)), false);

  const threw = failingApi({ open: () => { throw new Error('sync failure'); } });
  await assert.rejects(() => submitTask({ text: 'x', mode: 'ask' }, threw, { id: 1 }), /sync failure/);
  assert.equal(threw._store.has(handoffKey(1)), false);
});

test('an unavailable side panel API never stores the task', async () => {
  const api = failingApi({ withSidePanel: false });
  await assert.rejects(() => submitTask({ text: 'x', mode: 'ask' }, api, { id: 1 }));
  assert.equal(api._store.has(handoffKey(1)), false);
});

test('cleanup never removes a newer task written by another submit', async () => {
  const api = failingApi({
    open: async () => {
      api._store.set(handoffKey(1), { id: 'newer', tabId: 1, text: 'later', mode: 'ask', createdAt: Date.now() });
      throw new Error('late failure');
    },
  });
  await assert.rejects(() => submitTask({ text: 'first', mode: 'ask' }, api, { id: 1 }));
  assert.equal(api._store.get(handoffKey(1))?.id, 'newer');
});

test('two submits in the same tick: the second is refused before anything is written', async () => {
  const writes = [];
  const api = {
    storage: {
      local: {
        set: (v) => { writes.push(v); return new Promise(() => {}); }, // never settles: the first submit is still in flight
        get: async () => ({}),
        remove: async () => {},
      },
    },
    sidePanel: { setOptions: async () => {}, open: () => new Promise(() => {}) },
    runtime: { sendMessage: async () => {} },
  };
  const tab = { id: 88 };
  submitTask({ text: 'first', mode: 'ask' }, api, tab);
  assert.equal(isHandoffPending(88), true, 'locked synchronously');
  await assert.rejects(() => submitTask({ text: 'second', mode: 'ask' }, api, tab), /still being handed over/);
  assert.equal(writes.length, 1, 'only the first task was written');
});

test('a failed submit releases the lock so the next one can go through', async () => {
  const api = failingApi({ open: () => Promise.reject(new Error('blocked')) });
  await assert.rejects(() => submitTask({ text: 'a', mode: 'ask' }, api, { id: 91 }));
  assert.equal(isHandoffPending(91), false);
  api.sidePanel.open = async () => {};
  await submitTask({ text: 'b', mode: 'ask' }, api, { id: 91 });
  assert.equal(api._store.get(handoffKey(91)).text, 'b');
  api._claim(91);
  await whenClaimed({ id: 91 });
  assert.equal(isHandoffPending(91), false);
});

test('a second submit from the same tab waits until the first task has been claimed', async () => {
  const store = new Map();
  const listeners = [];
  const api = {
    storage: {
      local: {
        set: async (v) => { for (const [k, val] of Object.entries(v)) store.set(k, val); },
        get: async (k) => (store.has(k) ? { [k]: store.get(k) } : {}),
        remove: async (k) => { store.delete(k); },
      },
      onChanged: {
        addListener: (fn) => listeners.push(fn),
        removeListener: (fn) => { const i = listeners.indexOf(fn); if (i >= 0) listeners.splice(i, 1); },
      },
    },
    sidePanel: { setOptions: async () => {}, open: async () => {} },
    runtime: { sendMessage: async () => {} },
  };
  const tab = { id: 77 };
  const claim = () => {
    const key = handoffKey(77);
    const oldValue = store.get(key);
    store.delete(key);
    [...listeners].forEach((fn) => fn({ [key]: { oldValue } }, 'local'));
  };

  await submitTask({ text: 'first', mode: 'ask' }, api, tab);
  assert.equal(isHandoffPending(77), true);
  const first = store.get(handoffKey(77));
  await assert.rejects(() => submitTask({ text: 'second', mode: 'ask' }, api, tab), /still being handed over/);
  assert.equal(store.get(handoffKey(77)).id, first.id, 'the first task was not replaced');

  claim();
  await whenClaimed(tab);
  assert.equal(isHandoffPending(77), false);
  assert.equal(listeners.length, 0, 'the storage listener is removed');

  await submitTask({ text: 'second', mode: 'ask' }, api, tab);
  assert.equal(store.get(handoffKey(77)).text, 'second');
  claim();
  await whenClaimed(tab);
});

test('round-66: a wait that times out is reported as unclaimed, a real claim as claimed', async () => {
  const store = new Map();
  const listeners = [];
  const api = {
    storage: {
      local: {
        get: async (k) => (store.has(k) ? { [k]: store.get(k) } : {}),
        set: async (v) => { for (const [k, val] of Object.entries(v)) store.set(k, val); },
        remove: async (k) => { store.delete(k); },
      },
      onChanged: { addListener: (fn) => listeners.push(fn), removeListener() {} },
    },
  };
  // a record written 20 ms before the lock would run out, never claimed by any panel
  const now = Date.now();
  store.set(handoffKey(188), { id: 'x', tabId: 188, text: 't', mode: 'ask', createdAt: now - 160_000 + 20 });
  assert.equal(await adoptPendingHandoff(api, 188, now), true);
  assert.equal(pendingHandoffText(188), 't', 'an adopted record keeps its text to give back');
  assert.equal(await whenClaimed({ id: 188 }), false, 'timeout is not a claim');
  assert.equal(pendingHandoffText(188), '', 'and nothing is held once it is released');
  assert.equal(isHandoffPending(188), false);
  // a record that is removed resolves as claimed
  store.set(handoffKey(189), { id: 'y', tabId: 189, text: 't', mode: 'ask', createdAt: now });
  assert.equal(await adoptPendingHandoff(api, 189, now), true);
  const key = handoffKey(189);
  store.delete(key);
  listeners.forEach((fn) => fn({ [key]: { oldValue: {} } }, 'local'));
  assert.equal(await whenClaimed({ id: 189 }), true);
  const box = readFileSync(nt('features/agent/TaskBox.jsx'), 'utf8');
  assert.match(box, /if \(claimed === false\) \{\s*setText\(\(current\) => current \|\| value\);\s*setError\(/);
  assert.match(box, /const adoptedText = pendingHandoffText\(tab\.id\);[\s\S]*setText\(\(current\) => current \|\| adoptedText\);/);
});

test('quick link style option values match what the renderer checks', () => {
  const options = readFileSync(nt('features/quicklinks/options/QuickLinksOptions.jsx'), 'utf8');
  const renderer = readFileSync(nt('features/quicklinks/QuickLinks.jsx'), 'utf8');
  const offered = [...options.slice(options.indexOf('name="quickLinksStyle"')).matchAll(/value: '([a-z_]+)'/g)]
    .map((m) => m[1]).slice(0, 3);
  assert.deepEqual(offered, ['icon', 'text', 'metro']);
  for (const style of ['text', 'metro']) {
    assert.match(renderer, new RegExp(`quickLinksStyle'\\)\\s*===\\s*'${style}'`));
  }
});

test('link titles are derived locally and never fetched', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = () => { throw new Error('network call'); };
  try {
    assert.equal(await getTitleFromUrl('https://www.example.com/a/b?q=1'), 'example.com');
    assert.equal(await getTitleFromUrl('docs.example.org/path'), 'docs.example.org');
    assert.equal(await getTitleFromUrl('not a url at all'), 'not a url at all');
    assert.equal(await getTitleFromUrl(''), '');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('link URLs are normalised the same way for add and edit', () => {
  assert.equal(normalizeLinkUrl('example.com'), 'https://example.com');
  assert.equal(normalizeLinkUrl('  http://example.com/x '), 'http://example.com/x');
  assert.equal(normalizeLinkUrl('HTTPS://Example.com'), 'https://Example.com');
  assert.equal(normalizeLinkUrl('javascript:alert(1)'), null);
  assert.equal(normalizeLinkUrl('javascript:alert(1)//https://a.bc'), null);
  assert.equal(normalizeLinkUrl('data:text/html,hi'), null);
  assert.equal(normalizeLinkUrl('ftp://example.com'), null);
  assert.equal(normalizeLinkUrl('nodots'), null);
  assert.equal(normalizeLinkUrl(''), null);
  assert.equal(normalizeLinkUrl(undefined), null);
});

test('editing a link uses the same normalisation as adding one', () => {
  for (const file of ['features/quicklinks/options/QuickLinksOptions.jsx', 'features/navbar/options/AppsOptions.jsx']) {
    const src = readFileSync(nt(file), 'utf8');
    const start = src.indexOf('const editLink');
    const edit = src.slice(start, start + 1500);
    assert.match(src, /normalizeLinkUrl/, file);
    assert.match(edit, /normalizeLinkUrl\(url\)/, `${file}: editLink must normalise`);
  }
});

test('the only fetches in the new tab source load the chosen background image and the WebBrain bulletin', () => {
  const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]);
  const hits = walk(nt()).filter((f) => /\.(jsx?|mjs)$/.test(f))
    .filter((f) => /\bfetch\(|globalThis\.fetch|window\.fetch|XMLHttpRequest|sendBeacon|new WebSocket/.test(readFileSync(f, 'utf8')))
    .map((f) => path.relative(nt(), f).split(path.sep).join('/'));
  // The bulletin under the task box reads one fixed file from webbrain.one (features/bulletin).
  assert.deepEqual(hits, ['features/background/api/blobUrl.js', 'features/bulletin/bulletin.js']);
});

for (const browser of ['chrome', 'firefox']) {
  const { normalizeNewtabHandoff, createNewtabHandoff, newtabHandoffKey, newtabHandoffRetryKey, NEWTAB_HANDOFF_PREFIX } =
    await load(path.join(root, 'src', browser, 'src/ui/newtab-handoff.js'));

  test(`${browser}: handoff normalisation rejects stale, malformed or oversized records`, () => {
    const now = 1_000_000;
    const ok = { id: 'a', tabId: 3, text: ' hi ', mode: 'ask', createdAt: now - 1000 };
    assert.equal(normalizeNewtabHandoff(ok, now).text, 'hi');
    assert.equal(normalizeNewtabHandoff({ ...ok, createdAt: now - 60_000 }, now), null);
    assert.equal(normalizeNewtabHandoff({ ...ok, createdAt: now + 60_000 }, now), null);
    assert.equal(normalizeNewtabHandoff({ ...ok, mode: 'dev' }, now), null);
    assert.equal(normalizeNewtabHandoff({ ...ok, text: '   ' }, now), null);
    assert.equal(normalizeNewtabHandoff({ ...ok, text: 'x'.repeat(4001) }, now), null);
    assert.equal(normalizeNewtabHandoff({ ...ok, tabId: 'x' }, now), null);
    assert.equal(normalizeNewtabHandoff(null, now), null);
  });

  async function harness({
    tabId = 3, processing = false, blocked = false, records, record, visible = true,
    start = true, sendResult, clock, receiver,
  }) {
    const seed = records ?? (record ? { [newtabHandoffKey(record.tabId)]: record } : {});
    const store = start ? {} : { ...seed };
    const log = { mode: null, sent: [], value: '' };
    const input = { value: '', dispatchEvent() {}, focus() {} };
    const listeners = [];
    const state = { visible, tabId, time: clock ?? 100_000 };
    const handoff = createNewtabHandoff({
      storage: {
        get: async (k) => (k in store ? { [k]: store[k] } : {}),
        remove: async (k) => { delete store[k]; },
      },
      getCurrentTabId: () => state.tabId,
      getIsProcessing: () => processing,
      getIsBlocked: () => blocked,
      getIsDocumentVisible: () => state.visible,
      doc: { addEventListener: (type, fn) => { if (type === 'visibilitychange') listeners.push(fn); } },
      setMode: (m) => { log.mode = m; },
      getInputEl: () => input,
      autoResizeInput() {},
      sendMessage: async (params) => {
        log.sent.push(params);
        log.value = input.value;
        if (sendResult === false) return false;
        input.value = '';
        return undefined;
      },
      now: () => state.time,
      ...(receiver ? { receiver } : {}),
    });
    // A started panel with nothing waiting; the record then "arrives".
    if (start) {
      await handoff.start();
      Object.assign(store, seed);
    }
    return { handoff, store, log, input, state, listeners };
  }
  for (const switchAt of ['read', 'remove']) {
    test(`${browser}: a tab switch during the ${switchAt} neither applies nor loses the old tab's task`, async () => {
      const key3 = newtabHandoffKey(3);
      const record = { id: 'r1', tabId: 3, text: 'for tab three', mode: 'ask', createdAt: 99_000 };
      const store = { [key3]: record };
      const state = { tabId: 3 };
      const input = { value: '', dispatchEvent() {}, focus() {} };
      const sent = [];
      const handoff = createNewtabHandoff({
        storage: {
          get: async (k) => { const r = k in store ? { [k]: store[k] } : {}; if (switchAt === 'read' && !state.done) { state.tabId = 4; state.done = true; } return r; },
          remove: async (k) => { delete store[k]; if (switchAt === 'remove' && !state.done) { state.tabId = 4; state.done = true; } },
          set: async (o) => Object.assign(store, o),
        },
        getCurrentTabId: () => state.tabId,
        getIsProcessing: () => false,
        getIsBlocked: () => false,
        getIsDocumentVisible: () => true,
        doc: { addEventListener() {} },
        setMode() {},
        getInputEl: () => input,
        autoResizeInput() {},
        sendMessage: async () => { sent.push(input.value); },
        now: () => 100_000,
      });
      await handoff.start();
      assert.deepEqual(sent, [], 'nothing was sent into the other tab');
      assert.equal(input.value, '', "the other tab's composer was not touched");
      // a read-time switch leaves the record where it was; a removal-time switch hands it back
      assert.equal((store[key3] ?? store[newtabHandoffRetryKey(3)]?.[0])?.id, 'r1', "the old tab's record is still waiting");
      // back on tab 3 the task is applied
      state.tabId = 3;
      await handoff.consume();
      assert.deepEqual(sent, ['for tab three']);
    });
  }

  test(`${browser}: a slash-command Ask keeps the composer held while its preflight runs`, async () => {
    const key3 = newtabHandoffKey(3);
    const store = { [key3]: { id: 'A', tabId: 3, text: '/compact question', mode: 'ask', createdAt: 99_000 } };
    const input = { value: '', dispatchEvent() {}, focus() {} };
    let processing = false;
    const sent = [];
    let release;
    const gate = new Promise((r) => { release = r; });
    const handoff = createNewtabHandoff({
      storage: {
        get: async (k) => (k in store ? { [k]: store[k] } : {}),
        remove: async (k) => { delete store[k]; },
        set: async (o) => Object.assign(store, o),
      },
      getCurrentTabId: () => 3,
      getIsProcessing: () => processing,
      getIsBlocked: () => false,
      getIsDocumentVisible: () => true,
      doc: { addEventListener() {} },
      setMode() {},
      getInputEl: () => input,
      autoResizeInput() {},
      // like sidepanel.js: a slash command empties the box, then awaits its preflight
      sendMessage: async () => { sent.push(input.value); input.value = ''; await gate; return true; },
      now: () => 100_000,
    });
    await handoff.start();
    assert.equal(input.value, '');
    // a second task arrives while the first is still in preflight (box empty, not yet running)
    store[key3] = { id: 'B', tabId: 3, text: 'task B', mode: 'act', createdAt: 99_500 };
    await handoff.consume();
    assert.equal(input.value, '', 'the second task waits instead of landing in the box');
    assert.equal(store[key3]?.id, 'B', 'and stays in storage');
    release();
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    assert.deepEqual(sent, ['/compact question', 'task B'], 'it is sent once the first send has settled');
    assert.equal(processing, false);
  });

  test(`${browser}: a task that could not be written back is kept in memory and saved on the next look`, async () => {
    const key3 = newtabHandoffKey(3);
    const store = { [key3]: { id: 'r1', tabId: 3, text: 'for tab three', mode: 'ask', createdAt: 99_000 } };
    const state = { tabId: 3, failSets: true };
    const input = { value: '', dispatchEvent() {}, focus() {} };
    const sent = [];
    const handoff = createNewtabHandoff({
      storage: {
        get: async (k) => (k in store ? { [k]: store[k] } : {}),
        // the user switches tabs as the claim is removed; the write-back is then refused
        remove: async (k) => { delete store[k]; if (!state.switched) { state.switched = true; state.tabId = 4; } },
        set: async (o) => { if (state.failSets) throw new Error('storage refused'); Object.assign(store, o); },
      },
      getCurrentTabId: () => state.tabId,
      getIsProcessing: () => false,
      getIsBlocked: () => false,
      getIsDocumentVisible: () => true,
      doc: { addEventListener() {} },
      setMode() {},
      getInputEl: () => input,
      autoResizeInput() {},
      sendMessage: async () => { sent.push(input.value); },
      now: () => 100_000,
    });
    await handoff.start();
    assert.equal(newtabHandoffRetryKey(3) in store, false, 'the write-back failed');
    assert.deepEqual(sent, []);
    // storage works again; the next look (on any tab) saves the task for its own tab
    state.failSets = false;
    await handoff.consume();
    assert.equal(store[newtabHandoffRetryKey(3)]?.[0]?.text, 'for tab three');
    // and back on tab 3 it is applied
    state.tabId = 3;
    await handoff.consume();
    assert.deepEqual(sent, ['for tab three']);
  });

  test(`${browser}: a task handed back after a tab switch is still fresh when its tab returns`, async () => {
    const key3 = newtabHandoffKey(3);
    const store = { [key3]: { id: 'r1', tabId: 3, text: 'for tab three', mode: 'ask', createdAt: 80_000 } };
    const state = { tabId: 3, clock: 100_000 };
    const input = { value: '', dispatchEvent() {}, focus() {} };
    const sent = [];
    const handoff = createNewtabHandoff({
      storage: {
        get: async (k) => (k in store ? { [k]: store[k] } : {}),
        remove: async (k) => { delete store[k]; if (!state.switched) { state.switched = true; state.tabId = 4; } },
        set: async (o) => Object.assign(store, o),
      },
      getCurrentTabId: () => state.tabId,
      getIsProcessing: () => false,
      getIsBlocked: () => false,
      getIsDocumentVisible: () => true,
      doc: { addEventListener() {} },
      setMode() {},
      getInputEl: () => input,
      autoResizeInput() {},
      sendMessage: async () => { sent.push(input.value); },
      now: () => state.clock,
    });
    await handoff.start(); // claimed at 100 s when 20 s old, then the user switched away
    assert.equal(store[newtabHandoffRetryKey(3)]?.[0]?.text, 'for tab three');
    state.clock = 125_000; // back after 25 s: older than 30 s counted from the original typing
    state.tabId = 3;
    await handoff.consume();
    assert.deepEqual(sent, ['for tab three'], 'the task the new tab already cleared is not dropped');
  });

  test(`${browser}: a send still in preflight on one tab stays known while another tab is shown`, async () => {
    const store = {
      [newtabHandoffKey(3)]: { id: 'A', tabId: 3, text: 'task A', mode: 'ask', createdAt: 99_000 },
    };
    const state = { tabId: 3 };
    const input = { value: '', dispatchEvent() {}, focus() {} };
    const sends = [];
    let releaseA;
    const gateA = new Promise((r) => { releaseA = r; });
    const handoff = createNewtabHandoff({
      storage: {
        get: async (k) => (k in store ? { [k]: store[k] } : {}),
        remove: async (k) => { delete store[k]; },
        set: async (o) => Object.assign(store, o),
      },
      getCurrentTabId: () => state.tabId,
      getIsProcessing: () => false,
      getIsBlocked: () => false,
      getIsDocumentVisible: () => true,
      doc: { addEventListener() {} },
      setMode() {},
      getInputEl: () => input,
      autoResizeInput() {},
      sendMessage: async () => {
        const text = input.value;
        sends.push(text);
        if (text === 'task A') { await gateA; input.value = ''; } // A stays in preflight, then commits
        return true;
      },
      now: () => 100_000,
    });
    await handoff.start();
    assert.deepEqual(sends, ['task A']);
    // the panel swaps in tab 4's composer; tab 4 gets and sends its own task
    state.tabId = 4;
    input.value = '';
    store[newtabHandoffKey(4)] = { id: 'B', tabId: 4, text: 'task B', mode: 'ask', createdAt: 99_500 };
    await handoff.consume();
    await new Promise((r) => setTimeout(r, 0));
    assert.deepEqual(sends, ['task A', 'task B']);
    // back on tab 3 (its composer shows A again) a new task must not be applied over A
    state.tabId = 3;
    input.value = 'task A';
    store[newtabHandoffKey(3)] = { id: 'A2', tabId: 3, text: 'task A2', mode: 'ask', createdAt: 99_800 };
    await handoff.consume();
    assert.equal(input.value, 'task A', "A's composer is untouched while A is still being sent");
    assert.equal(store[newtabHandoffKey(3)]?.id, 'A2', 'A2 waits in storage');
    releaseA();
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(sends.includes('task A2'), true, 'A2 goes out once A has settled');
  });

  test(`${browser}: the time a task waited behind a send is kept for its own tab`, async () => {
    const key3 = newtabHandoffKey(3);
    const store = { [key3]: { id: 'A', tabId: 3, text: 'task A', mode: 'ask', createdAt: 99_000 } };
    const state = { tabId: 3, clock: 100_000 };
    const input = { value: '', dispatchEvent() {}, focus() {} };
    const sends = [];
    let releaseA;
    const gateA = new Promise((r) => { releaseA = r; });
    const handoff = createNewtabHandoff({
      storage: {
        get: async (k) => (k in store ? { [k]: store[k] } : {}),
        remove: async (k) => { delete store[k]; },
        set: async (o) => Object.assign(store, o),
      },
      getCurrentTabId: () => state.tabId,
      getIsProcessing: () => false,
      getIsBlocked: () => false,
      getIsDocumentVisible: () => true,
      doc: { addEventListener() {} },
      setMode() {},
      getInputEl: () => input,
      autoResizeInput() {},
      sendMessage: async () => {
        const text = input.value;
        sends.push(text);
        if (text === 'task A') { await gateA; input.value = ''; }
        return true;
      },
      now: () => state.clock,
    });
    await handoff.start();
    store[key3] = { id: 'A2', tabId: 3, text: 'task A2', mode: 'ask', createdAt: 99_800 };
    await handoff.consume(); // held behind A: the wait starts counting here
    assert.deepEqual(sends, ['task A']);
    state.clock = 135_000; // the send is slow; A2 is now 35 s old
    // the user looks at another tab, which has nothing waiting
    state.tabId = 4;
    input.value = '';
    await handoff.consume();
    releaseA();
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    // and returns: A2 is older than 30 s only because the panel kept it waiting
    state.tabId = 3;
    input.value = '';
    await handoff.consume();
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(sends.includes('task A2'), true, 'the waiting task is still accepted');
  });

  test(`${browser}: the startup delay is credited to every tab's task, not just the first one looked at`, async () => {
    const store = {
      [newtabHandoffKey(3)]: { id: 'T3', tabId: 3, text: 'task three', mode: 'act', createdAt: 100_500 },
      [newtabHandoffKey(4)]: { id: 'T4', tabId: 4, text: 'task four', mode: 'act', createdAt: 100_600 },
    };
    const state = { tabId: 3, clock: 100_000 };
    const input = { value: '', dispatchEvent() {}, focus() {} };
    const sent = [];
    const settle = async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0)); };
    const handoff = createNewtabHandoff({
      storage: {
        get: async (k) => (k in store ? { [k]: store[k] } : {}),
        remove: async (k) => { delete store[k]; },
        set: async (o) => Object.assign(store, o),
      },
      getCurrentTabId: () => state.tabId,
      getIsProcessing: () => false,
      getIsBlocked: () => false,
      getIsDocumentVisible: () => true,
      doc: { addEventListener() {} },
      setMode() {},
      getInputEl: () => input,
      autoResizeInput() {},
      sendMessage: async () => { sent.push(input.value); input.value = ''; },
      now: () => state.clock,
    });
    state.clock = 150_000; // a cold panel took 50 s to restore its chat; both tasks are ~50 s old
    await handoff.start();
    await settle();
    assert.deepEqual(sent, ['task three']);
    state.tabId = 4;
    await handoff.consume();
    await settle();
    assert.deepEqual(sent, ['task three', 'task four'], "the second tab's equally old task is accepted too");
    // a task typed after startup gets no such credit
    store[newtabHandoffKey(3)] = { id: 'late', tabId: 3, text: 'late', mode: 'act', createdAt: 150_100 };
    state.clock = 190_000; // 40 s old, more than the ordinary 30 s
    state.tabId = 3;
    await handoff.consume();
    await settle();
    assert.deepEqual(sent, ['task three', 'task four'], 'a task created after startup uses the ordinary window');
  });

  test(`${browser}: the hold allowance is dropped once the delayed task has been claimed`, async () => {
    const key3 = newtabHandoffKey(3);
    const store = { [key3]: { id: 'A', tabId: 3, text: 'task A', mode: 'ask', createdAt: 99_000 } };
    const state = { clock: 100_000 };
    const input = { value: '', dispatchEvent() {}, focus() {} };
    const sent = [];
    let releaseA;
    const gateA = new Promise((r) => { releaseA = r; });
    const handoff = createNewtabHandoff({
      storage: {
        get: async (k) => (k in store ? { [k]: store[k] } : {}),
        remove: async (k) => { delete store[k]; },
        set: async (o) => Object.assign(store, o),
      },
      getCurrentTabId: () => 3,
      getIsProcessing: () => false,
      getIsBlocked: () => false,
      getIsDocumentVisible: () => true,
      doc: { addEventListener() {} },
      setMode() {},
      getInputEl: () => input,
      autoResizeInput() {},
      sendMessage: async () => { sent.push(input.value); await gateA; input.value = ''; return true; },
      now: () => state.clock,
    });
    await handoff.start();
    // an Act task waits behind A's slow send (nothing is sent for it, so no later look follows)
    store[key3] = { id: 'B', tabId: 3, text: 'task B', mode: 'act', createdAt: 99_800 };
    await handoff.consume();
    state.clock = 135_000; // B is 35 s old because of the hold
    releaseA();
    for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0));
    assert.deepEqual(sent, ['task A', 'task B'], 'the delayed task is accepted and sent');
    // a later, unrelated task that is genuinely stale (40 s) must not borrow the allowance
    store[key3] = { id: 'C', tabId: 3, text: 'task C', mode: 'act', createdAt: state.clock - 40_000 };
    await handoff.consume();
    for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
    assert.deepEqual(sent, ['task A', 'task B'], 'it is judged on its own age');
  });

  test(`${browser}: Act is checked for eligibility before it is accepted`, async () => {
    const run = async ({ allowed, draft = '', throws = false, typeDuringCheck = '' }) => {
      const key3 = newtabHandoffKey(3);
      const store = { [key3]: { id: 'r1', tabId: 3, text: 'book a table', mode: 'act', createdAt: 99_000 } };
      const input = { value: draft, dispatchEvent() {}, focus() {} };
      const log = { modes: [], sent: [], checks: 0 };
      const handoff = createNewtabHandoff({
        storage: {
          get: async (k) => (k in store ? { [k]: store[k] } : {}),
          remove: async (k) => { delete store[k]; },
          set: async (o) => Object.assign(store, o),
        },
        getCurrentTabId: () => 3,
        getIsProcessing: () => false,
        getIsBlocked: () => false,
        getIsDocumentVisible: () => true,
        doc: { addEventListener() {} },
        setMode: (m) => log.modes.push(m),
        ensureActMode: async (options) => { log.checks += 1; log.options = options; if (typeDuringCheck) input.value = typeDuringCheck; if (throws) throw new Error('lookup failed'); return allowed; },
        getInputEl: () => input,
        autoResizeInput() {},
        sendMessage: async (p) => { log.sent.push(p); input.value = ''; },
        now: () => 100_000,
      });
      await handoff.start();
      return { log, input, store };
    };
    // allowed: sent in Act, as before
    const ok = await run({ allowed: true });
    assert.deepEqual(ok.log.sent, [{ __mode: 'act' }]);
    // not allowed (in-browser model, selected-text scope): nothing is sent or pinned, the task is
    // kept in the composer for the user, and the panel's mode is untouched
    const blocked = await run({ allowed: false });
    assert.deepEqual(blocked.log.sent, []);
    assert.deepEqual(blocked.log.modes, []);
    assert.equal(blocked.input.value, 'book a table');
    assert.equal(blocked.store[newtabHandoffKey(3)], undefined, 'the record was claimed, not lost');
    // a failed lookup does not block (the panel still checks when sending)
    const flaky = await run({ allowed: true, throws: true });
    assert.deepEqual(flaky.log.sent, [{ __mode: 'act' }]);
    // an existing draft is never subjected to the mode check or a mode switch
    const withDraft = await run({ allowed: true, draft: 'my own text' });
    assert.equal(withDraft.log.checks, 0);
    assert.deepEqual(withDraft.log.modes, []);
    assert.equal(withDraft.input.value, 'my own text\n\nbook a table');
    // the check only answers eligibility; a draft typed while it was running keeps its own mode
    const typing = await run({ allowed: true, typeDuringCheck: 'typed meanwhile' });
    assert.deepEqual(typing.log.options, { switchMode: false });
    assert.deepEqual(typing.log.modes, []);
    assert.deepEqual(typing.log.sent, []);
    assert.equal(typing.input.value, 'typed meanwhile\n\nbook a table');
  });

  test(`${browser}: a declined send never refills another tab's composer; the task goes back to its own tab`, async () => {
    const key3 = newtabHandoffKey(3);
    const store = { [key3]: { id: 'r1', tabId: 3, text: 'for tab three', mode: 'ask', createdAt: 99_000 } };
    const state = { tabId: 3 };
    const input = { value: '', dispatchEvent() {}, focus() {} };
    let release;
    const gate = new Promise((r) => { release = r; });
    const handoff = createNewtabHandoff({
      storage: {
        get: async (k) => (k in store ? { [k]: store[k] } : {}),
        remove: async (k) => { delete store[k]; },
        set: async (o) => Object.assign(store, o),
      },
      getCurrentTabId: () => state.tabId,
      getIsProcessing: () => false,
      getIsBlocked: () => false,
      getIsDocumentVisible: () => true,
      doc: { addEventListener() {} },
      setMode() {},
      getInputEl: () => input,
      autoResizeInput() {},
      sendMessage: async () => { input.value = ''; await gate; return false; },
      now: () => 100_000,
    });
    await handoff.start();
    state.tabId = 4; // user switches while the send is pending...
    release(); // ...and it is then declined
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(input.value, '', "tab 4's composer stays empty");
    assert.equal(store[newtabHandoffRetryKey(3)]?.[0]?.text, 'for tab three', 'the task is waiting for tab 3 again');
    assert.equal(store[newtabHandoffRetryKey(3)][0].id, 'r1-retry');
  });

  test(`${browser}: a declined send keeps a draft typed meanwhile and adds the task below it`, async () => {
    const key3 = newtabHandoffKey(3);
    const store = { [key3]: { id: 'A', tabId: 3, text: 'task A', mode: 'ask', createdAt: 99_000 } };
    const input = { value: '', dispatchEvent() {}, focus() {} };
    let release;
    const gate = new Promise((r) => { release = r; });
    const handoff = createNewtabHandoff({
      storage: {
        get: async (k) => (k in store ? { [k]: store[k] } : {}),
        remove: async (k) => { delete store[k]; },
        set: async (o) => Object.assign(store, o),
      },
      getCurrentTabId: () => 3,
      getIsProcessing: () => false,
      getIsBlocked: () => false,
      getIsDocumentVisible: () => true,
      doc: { addEventListener() {} },
      setMode() {},
      getInputEl: () => input,
      autoResizeInput() {},
      sendMessage: async () => { input.value = 'my own draft'; await gate; return false; },
      now: () => 100_000,
    });
    await handoff.start();
    release();
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(input.value, 'my own draft\n\ntask A');
  });

  test(`${browser}: a declined send does not overwrite a newer task stored for the same tab`, async () => {
    const key3 = newtabHandoffKey(3);
    const store = { [key3]: { id: 'A', tabId: 3, text: 'task A', mode: 'ask', createdAt: 99_000 } };
    const state = { tabId: 3 };
    const input = { value: '', dispatchEvent() {}, focus() {} };
    let release;
    const gate = new Promise((r) => { release = r; });
    const handoff = createNewtabHandoff({
      storage: {
        get: async (k) => (k in store ? { [k]: store[k] } : {}),
        remove: async (k) => { delete store[k]; },
        set: async (o) => Object.assign(store, o),
      },
      getCurrentTabId: () => state.tabId,
      getIsProcessing: () => false,
      getIsBlocked: () => false,
      getIsDocumentVisible: () => true,
      doc: { addEventListener() {} },
      setMode() {},
      getInputEl: () => input,
      autoResizeInput() {},
      sendMessage: async () => { input.value = ''; await gate; return false; },
      now: () => 100_000,
    });
    await handoff.start();
    store[key3] = { id: 'B', tabId: 3, text: 'task B', mode: 'ask', createdAt: 99_500 }; // new tab unlocked
    state.tabId = 4;
    release();
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(store[key3].id, 'B', 'the newer task is kept');
    assert.equal(store[newtabHandoffRetryKey(3)][0].id, 'A-retry', 'and the declined one is kept beside it');
  });

  test(`${browser}: a task handed back to its tab is applied when that tab is shown again, and the slot is cleared`, async () => {
    const key3 = newtabHandoffKey(3);
    const retry3 = newtabHandoffRetryKey(3);
    const store = { [retry3]: [{ id: 'A-retry', tabId: 3, text: 'task A', mode: 'ask', createdAt: 99_900 }] };
    const input = { value: '', dispatchEvent() {}, focus() {} };
    const sent = [];
    const handoff = createNewtabHandoff({
      storage: {
        get: async (k) => (k in store ? { [k]: store[k] } : {}),
        remove: async (k) => { delete store[k]; },
        set: async (o) => Object.assign(store, o),
      },
      getCurrentTabId: () => 3,
      getIsProcessing: () => false,
      getIsBlocked: () => false,
      getIsDocumentVisible: () => true,
      doc: { addEventListener() {} },
      setMode() {},
      getInputEl: () => input,
      autoResizeInput() {},
      sendMessage: async () => { sent.push(input.value); input.value = ''; },
      now: () => 100_000,
    });
    await handoff.start();
    assert.deepEqual(sent, ['task A']);
    assert.equal(retry3 in store, false);
    assert.equal(key3 in store, false);
  });

  test(`${browser}: handing a task back never discards one already waiting in the retry slot`, async () => {
    const key3 = newtabHandoffKey(3);
    const retry3 = newtabHandoffRetryKey(3);
    const store = {
      [key3]: { id: 'B', tabId: 3, text: 'task B', mode: 'ask', createdAt: 99_500 },
      [retry3]: [{ id: 'A-retry', tabId: 3, text: 'task A', mode: 'ask', createdAt: 99_900 }],
    };
    const state = { tabId: 3 };
    const input = { value: '', dispatchEvent() {}, focus() {} };
    let release;
    const gate = new Promise((r) => { release = r; });
    const handoff = createNewtabHandoff({
      storage: {
        get: async (k) => (k in store ? { [k]: store[k] } : {}),
        remove: async (k) => { delete store[k]; },
        set: async (o) => Object.assign(store, o),
      },
      getCurrentTabId: () => state.tabId,
      getIsProcessing: () => false,
      getIsBlocked: () => false,
      getIsDocumentVisible: () => true,
      doc: { addEventListener() {} },
      setMode() {},
      getInputEl: () => input,
      autoResizeInput() {},
      sendMessage: async () => { input.value = ''; await gate; return false; },
      now: () => 100_000,
    });
    await handoff.start(); // B (the primary record) is claimed first and sent
    state.tabId = 4;
    release();
    for (let i = 0; i < 4; i++) await new Promise((r) => setTimeout(r, 0));
    assert.deepEqual(store[retry3].map((r) => r.id), ['A-retry', 'B-retry'], 'both tasks are kept');
  });

  test(`${browser}: a short task is not mistaken for a longer replacement draft that merely contains it`, async () => {
    const key3 = newtabHandoffKey(3);
    const store = { [key3]: { id: 'A', tabId: 3, text: 'yes', mode: 'ask', createdAt: 99_000 } };
    const input = { value: '', dispatchEvent() {}, focus() {} };
    let release;
    const gate = new Promise((r) => { release = r; });
    const handoff = createNewtabHandoff({
      storage: {
        get: async (k) => (k in store ? { [k]: store[k] } : {}),
        remove: async (k) => { delete store[k]; },
        set: async (o) => Object.assign(store, o),
      },
      getCurrentTabId: () => 3,
      getIsProcessing: () => false,
      getIsBlocked: () => false,
      getIsDocumentVisible: () => true,
      doc: { addEventListener() {} },
      setMode() {},
      getInputEl: () => input,
      autoResizeInput() {},
      sendMessage: async () => { input.value = 'yesterday'; await gate; return false; },
      now: () => 100_000,
    });
    await handoff.start();
    release();
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(input.value, 'yesterday\n\nyes');
  });

  test(`${browser}: a task waiting in the retry slot is picked up after a newer primary one`, async () => {
    const key3 = newtabHandoffKey(3);
    const retry3 = newtabHandoffRetryKey(3);
    const store = {
      [key3]: { id: 'B', tabId: 3, text: 'task B', mode: 'act', createdAt: 99_500 },
      [retry3]: [{ id: 'A-retry', tabId: 3, text: 'task A', mode: 'act', createdAt: 99_900 }],
    };
    const input = { value: '', dispatchEvent() {}, focus() {} };
    const handoff = createNewtabHandoff({
      storage: {
        get: async (k) => (k in store ? { [k]: store[k] } : {}),
        remove: async (k) => { delete store[k]; },
        set: async (o) => Object.assign(store, o),
      },
      getCurrentTabId: () => 3,
      getIsProcessing: () => false,
      getIsBlocked: () => false,
      getIsDocumentVisible: () => true,
      doc: { addEventListener() {} },
      setMode() {},
      getInputEl: () => input,
      autoResizeInput() {},
      sendMessage: async () => {},
      now: () => 100_000,
    });
    await handoff.start();
    for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0));
    assert.equal(input.value, 'task B\n\ntask A');
    assert.deepEqual(Object.keys(store), [], 'both records were claimed');
  });

  test(`${browser}: a live retry behind a stale primary record is still delivered`, async () => {
    const key3 = newtabHandoffKey(3);
    const retry3 = newtabHandoffRetryKey(3);
    const store = {
      [key3]: { id: 'OLD', tabId: 3, text: 'too old', mode: 'act', createdAt: 1_000 },
      [retry3]: [{ id: 'A-retry', tabId: 3, text: 'task A', mode: 'act', createdAt: 99_900 }],
    };
    const input = { value: '', dispatchEvent() {}, focus() {} };
    const handoff = createNewtabHandoff({
      storage: {
        get: async (k) => (k in store ? { [k]: store[k] } : {}),
        remove: async (k) => { delete store[k]; },
        set: async (o) => Object.assign(store, o),
      },
      getCurrentTabId: () => 3,
      getIsProcessing: () => false,
      getIsBlocked: () => false,
      getIsDocumentVisible: () => true,
      doc: { addEventListener() {} },
      setMode() {},
      getInputEl: () => input,
      autoResizeInput() {},
      sendMessage: async () => {},
      now: () => 100_000,
    });
    await handoff.start();
    for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0));
    assert.equal(input.value, 'task A');
    assert.deepEqual(Object.keys(store), [key3], 'only the stale primary is left behind, untouched');
  });

  test(`${browser}: a failed claim leaves the task deliverable on the next attempt`, async () => {
    const key3 = newtabHandoffKey(3);
    const store = { [key3]: { id: 'A', tabId: 3, text: 'task A', mode: 'act', createdAt: 99_500 } };
    let failRemove = true;
    const input = { value: '', dispatchEvent() {}, focus() {} };
    const handoff = createNewtabHandoff({
      storage: {
        get: async (k) => (k in store ? { [k]: store[k] } : {}),
        remove: async (k) => { if (failRemove) throw new Error('storage unavailable'); delete store[k]; },
        set: async (o) => Object.assign(store, o),
      },
      getCurrentTabId: () => 3,
      getIsProcessing: () => false,
      getIsBlocked: () => false,
      getIsDocumentVisible: () => true,
      doc: { addEventListener() {} },
      setMode() {},
      getInputEl: () => input,
      autoResizeInput() {},
      sendMessage: async () => {},
      now: () => 100_000,
    });
    assert.equal(await handoff.start(), false);
    assert.equal(input.value, '');
    failRemove = false;
    assert.equal(await handoff.consume(), true);
    assert.equal(input.value, 'task A');
  });

  test(`${browser}: a task waiting behind a long send stays out of the composer and is delivered when the send settles`, async () => {
    const key3 = newtabHandoffKey(3);
    const store = { [key3]: { id: 'A', tabId: 3, text: 'task A', mode: 'ask', createdAt: 99_900 } };
    const input = { value: '', dispatchEvent() {}, focus() {} };
    let finishA;
    const gateA = new Promise((r) => { finishA = r; });
    let calls = 0;
    const realSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = (fn) => { queueMicrotask(fn); return 0; }; // run the 150 ms polls at once
    try {
      const handoff = createNewtabHandoff({
        storage: {
          get: async (k) => (k in store ? { [k]: store[k] } : {}),
          remove: async (k) => { delete store[k]; },
          set: async (o) => Object.assign(store, o),
        },
        getCurrentTabId: () => 3,
        getIsProcessing: () => false,
        getIsBlocked: () => false,
        getIsDocumentVisible: () => true,
        doc: { addEventListener() {} },
        setMode() {},
        getInputEl: () => input,
        autoResizeInput() {},
        sendMessage: async () => {
          calls += 1;
          if (calls === 1) { await gateA; input.value = ''; return true; } // A: slow preflight, then sent
          input.value = ''; return true;
        },
        now: () => 100_000,
      });
      await handoff.start(); // A is claimed and its send starts (composer holds A)
      store[key3] = { id: 'B', tabId: 3, text: 'task B', mode: 'ask', createdAt: 99_950 };
      await handoff.consume(); // B is waiting behind A
      for (let i = 0; i < 400; i++) await Promise.resolve(); // polling budget runs out
      assert.equal(input.value, 'task A', 'B was not merged into the composer beside the running send');
      assert.equal(store[key3].id, 'B', 'B is still waiting in storage');
      finishA();
      for (let i = 0; i < 20; i++) await new Promise((r) => realSetTimeout(r, 0));
      assert.equal(key3 in store, false, 'B was delivered once A settled');
      assert.equal(calls, 2);
    } finally {
      globalThis.setTimeout = realSetTimeout;
    }
  });

  test(`${browser}: the polling budget belongs to the tab being waited for`, async () => {
    const key3 = newtabHandoffKey(3);
    const key4 = newtabHandoffKey(4);
    const store = { [key3]: { id: 'A', tabId: 3, text: 'task A', mode: 'ask', createdAt: 99_900 } };
    const state = { tabId: 3, looks: 0 };
    const input = { value: '', dispatchEvent() {}, focus() {} };
    const timers = [];
    const realSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = (fn) => { timers.push(fn); return timers.length; };
    const step = async (n) => {
      for (let i = 0; i < n && timers.length; i++) {
        timers.shift()();
        for (let k = 0; k < 30; k++) await Promise.resolve();
      }
    };
    try {
      const never = new Promise(() => {}); // sends stay in preflight for the whole test
      const handoff = createNewtabHandoff({
        storage: {
          get: async (k) => (k in store ? { [k]: store[k] } : {}),
          remove: async (k) => { delete store[k]; },
          set: async (o) => Object.assign(store, o),
        },
        getCurrentTabId: () => state.tabId,
        getIsProcessing: () => false,
        getIsBlocked: () => false,
        getIsDocumentVisible: () => { state.looks += 1; return true; },
        doc: { addEventListener() {} },
        setMode() {},
        getInputEl: () => input,
        autoResizeInput() {},
        sendMessage: async () => { await never; },
        now: () => 100_000,
      });
      await handoff.start(); // A's send holds tab 3's composer
      state.tabId = 4;
      input.value = '';
      store[key4] = { id: 'C', tabId: 4, text: 'task C', mode: 'ask', createdAt: 99_990 };
      await handoff.consume(); // C's send holds tab 4's composer
      state.tabId = 3;
      input.value = 'task A';
      store[key3] = { id: 'B', tabId: 3, text: 'task B', mode: 'ask', createdAt: 99_950 };
      await handoff.consume(); // B waits behind A; polling starts
      await step(97); // most of tab 3's budget is spent
      state.tabId = 4;
      input.value = 'task C';
      store[key4] = { id: 'D', tabId: 4, text: 'task D', mode: 'ask', createdAt: 99_995 };
      await handoff.consume(); // D waits behind C
      const before = state.looks;
      await step(40);
      assert.ok(state.looks - before >= 35, `tab 4 keeps polling on its own budget (${state.looks - before} looks)`);
    } finally {
      globalThis.setTimeout = realSetTimeout;
    }
  });

  test(`${browser}: a task delayed by the panel's own hold is not stale when the send settles`, async () => {
    const key3 = newtabHandoffKey(3);
    const clock = { t: 100_000 };
    const store = { [key3]: { id: 'A', tabId: 3, text: 'task A', mode: 'ask', createdAt: 99_900 } };
    const input = { value: '', dispatchEvent() {}, focus() {} };
    let finishA;
    const gateA = new Promise((r) => { finishA = r; });
    let calls = 0;
    const realSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = (fn) => { queueMicrotask(fn); return 0; };
    try {
      const handoff = createNewtabHandoff({
        storage: {
          get: async (k) => (k in store ? { [k]: store[k] } : {}),
          remove: async (k) => { delete store[k]; },
          set: async (o) => Object.assign(store, o),
        },
        getCurrentTabId: () => 3,
        getIsProcessing: () => false,
        getIsBlocked: () => false,
        getIsDocumentVisible: () => true,
        doc: { addEventListener() {} },
        setMode() {},
        getInputEl: () => input,
        autoResizeInput() {},
        sendMessage: async () => { calls += 1; if (calls === 1) await gateA; input.value = ''; return true; },
        now: () => clock.t,
      });
      await handoff.start();
      store[key3] = { id: 'B', tabId: 3, text: 'task B', mode: 'ask', createdAt: clock.t };
      await handoff.consume(); // B waits behind A: the hold starts here
      for (let i = 0; i < 400; i++) await Promise.resolve();
      clock.t += 45_000; // A's preflight takes 45 s: B is older than the 30 s a record is accepted for
      finishA();
      for (let i = 0; i < 20; i++) await new Promise((r) => realSetTimeout(r, 0));
      assert.equal(calls, 2, 'B was still delivered');
      assert.equal(key3 in store, false);
    } finally {
      globalThis.setTimeout = realSetTimeout;
    }
  });

  test(`${browser}: the hold allowance lasts until every task it delayed has been considered`, async () => {
    const key3 = newtabHandoffKey(3);
    const retry3 = newtabHandoffRetryKey(3);
    const clock = { t: 100_000 };
    const store = {
      [key3]: { id: 'C', tabId: 3, text: 'task C', mode: 'ask', createdAt: 99_950 },
      [retry3]: [{ id: 'B-retry', tabId: 3, text: 'task B', mode: 'ask', createdAt: 99_900 }],
    };
    const input = { value: '', dispatchEvent() {}, focus() {} };
    let finishC;
    const gateC = new Promise((r) => { finishC = r; });
    const sentTexts = [];
    const realSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = (fn) => { queueMicrotask(fn); return 0; };
    try {
      const handoff = createNewtabHandoff({
        storage: {
          get: async (k) => (k in store ? { [k]: store[k] } : {}),
          remove: async (k) => { delete store[k]; },
          set: async (o) => Object.assign(store, o),
        },
        getCurrentTabId: () => 3,
        getIsProcessing: () => false,
        getIsBlocked: () => false,
        getIsDocumentVisible: () => true,
        doc: { addEventListener() {} },
        setMode() {},
        getInputEl: () => input,
        autoResizeInput() {},
        sendMessage: async () => {
          const text = input.value;
          sentTexts.push(text);
          if (text === 'task C') await gateC;
          input.value = '';
          return true;
        },
        now: () => clock.t,
      });
      await handoff.start(); // C is sent first; B (retry slot) is put off behind it
      for (let i = 0; i < 400; i++) await Promise.resolve();
      clock.t += 45_000; // C's preflight is slow
      store[key3] = { id: 'D', tabId: 3, text: 'task D', mode: 'ask', createdAt: clock.t }; // fresh
      finishC();
      for (let i = 0; i < 40; i++) await new Promise((r) => realSetTimeout(r, 0));
      assert.deepEqual(sentTexts, ['task C', 'task D', 'task B']);
      assert.equal(retry3 in store, false);
    } finally {
      globalThis.setTimeout = realSetTimeout;
    }
  });

  const rec = (over = {}) => ({ id: 'r1', tabId: 3, text: 'summarise', mode: 'ask', createdAt: 99_000, ...over });
  const KEY = newtabHandoffKey(3);

  test(`${browser}: Ask is sent automatically and the record is claimed once`, async () => {
    const h = await harness({ record: rec() });
    assert.equal(await h.handoff.consume(), true);
    assert.equal(h.log.mode, 'ask');
    assert.deepEqual(h.log.sent, [{ __mode: 'ask' }]);
    assert.equal(h.log.value, 'summarise');
    assert.equal(KEY in h.store, false);
    assert.equal(await h.handoff.consume(), false);
    assert.equal(h.log.sent.length, 1);
  });

  test(`${browser}: a side panel open beside the new tab leaves the full-page chat's Ask alone`, async () => {
    const forChat = rec({ text: 'what is a murshid', target: 'tab-chat' });
    // The panel (default receiver) sees the record arrive for its tab but must not take it.
    const panel = await harness({ record: forChat });
    assert.equal(await panel.handoff.consume(), false);
    assert.deepEqual(panel.log.sent, []);
    assert.equal(panel.input.value, '', 'the panel composer must stay untouched');
    assert.deepEqual(panel.store[KEY], forChat, 'the record must be left exactly as written');
    // The full-page chat that loads in the tab then claims and sends it.
    const chat = await harness({ record: forChat, receiver: 'tab-chat' });
    assert.equal(await chat.handoff.consume(), true);
    assert.deepEqual(chat.log.sent, [{ __mode: 'ask' }]);
    assert.equal(chat.log.value, 'what is a murshid');
    assert.equal(KEY in chat.store, false);
  });

  test(`${browser}: the full-page chat never takes a side panel record`, async () => {
    for (const record of [rec({ mode: 'act', text: 'book a table' }), rec({ target: 'panel' }), rec({ target: 'something-else' })]) {
      const chat = await harness({ record, receiver: 'tab-chat' });
      assert.equal(await chat.handoff.consume(), false, `took ${JSON.stringify(record)}`);
      assert.deepEqual(chat.log.sent, []);
      assert.equal(KEY in chat.store, true);
    }
    // A record from an older new tab has no target and is the panel's.
    const legacy = await harness({ record: rec() });
    assert.equal(await legacy.handoff.consume(), true);
  });

  test(`${browser}: a receiver takes its own task from the retry slot and skips the other's`, async () => {
    const retryKey = newtabHandoffRetryKey(3);
    const theirs = rec({ id: 'chat-1', text: 'for the chat', target: 'tab-chat' });
    const mine = rec({ id: 'panel-1', text: 'for the panel' });
    const store = { [retryKey]: [theirs, mine] };
    const input = { value: '', dispatchEvent() {}, focus() {} };
    const sent = [];
    const handoff = createNewtabHandoff({
      storage: {
        get: async (k) => (k in store ? { [k]: store[k] } : {}),
        set: async (v) => { Object.assign(store, v); },
        remove: async (k) => { delete store[k]; },
      },
      getCurrentTabId: () => 3,
      getIsProcessing: () => false,
      getInputEl: () => input,
      autoResizeInput() {},
      setMode() {},
      sendMessage: async () => { sent.push(input.value); input.value = ''; },
      now: () => 100_000,
    });
    assert.equal(await handoff.start(), true);
    assert.deepEqual(sent, ['for the panel']);
    assert.deepEqual(store[retryKey], [theirs], 'the full-page chat task must stay queued for it');
  });

  test(`${browser}: normalised records keep their receiver`, () => {
    const now = 1_000_000;
    const ok = { id: 'a', tabId: 3, text: 'hi', mode: 'ask', createdAt: now - 1000 };
    assert.equal(normalizeNewtabHandoff(ok, now).target, 'panel');
    assert.equal(normalizeNewtabHandoff({ ...ok, target: 'tab-chat' }, now).target, 'tab-chat');
    assert.equal(normalizeNewtabHandoff({ ...ok, target: 'elsewhere' }, now).target, 'panel');
  });

  test(`${browser}: Act is sent immediately, in Act mode, like Ask`, async () => {
    const h = await harness({ record: rec({ mode: 'act', text: 'book a table' }) });
    assert.equal(await h.handoff.consume(), true);
    assert.equal(h.log.mode, 'act');
    assert.deepEqual(h.log.sent, [{ __mode: 'act' }], 'the mode chosen in the box is pinned, not left to automatic selection');
    assert.equal(h.log.value, 'book a table', 'the composer held the task when it was sent');
    const ask = await harness({ record: rec({ mode: 'ask', text: 'what is this' }) });
    await ask.handoff.consume();
    assert.equal(ask.log.mode, 'ask');
    assert.deepEqual(ask.log.sent, [{ __mode: 'ask' }]);
    assert.equal(ask.log.value, 'what is this');
  });

  test(`${browser}: a record for another tab is left alone; a stale one is ignored and left in place`, async () => {
    const other = await harness({ record: rec({ tabId: 99 }) });
    assert.equal(await other.handoff.consume(), false);
    assert.equal(newtabHandoffKey(99) in other.store, true);
    // A record filed under this tab's key but naming another tab is refused too.
    const mismatched = await harness({ records: { [KEY]: rec({ tabId: 99 }) } });
    assert.equal(await mismatched.handoff.consume(), false);
    assert.equal(mismatched.log.sent.length, 0);
    assert.equal(other.log.sent.length, 0);

    const stale = await harness({ record: rec({ createdAt: 1 }), start: false });
    await stale.handoff.start();
    assert.equal(await stale.handoff.consume(), false);
    assert.equal(stale.log.sent.length, 0, 'a stale task is never applied');
    // not deleted from an earlier read: the new tab replaces it once its own lock has run out
    assert.equal(KEY in stale.store, true);
  });

  test(`${browser}: Ask during an active run is queued behind it, not dropped`, async () => {
    const h = await harness({ processing: true, record: rec() });
    assert.equal(await h.handoff.consume(), true);
    assert.deepEqual(h.log.sent, [{ __deliveryMode: 'queue', __mode: 'ask' }]);
    assert.equal(h.log.value, 'summarise');
    assert.equal(KEY in h.store, false);
  });

  test(`${browser}: Ask while the conversation is being cleared is only pre-filled`, async () => {
    const h = await harness({ blocked: true, record: rec() });
    await h.handoff.consume();
    assert.equal(h.log.sent.length, 0);
    assert.equal(h.input.value, 'summarise');
  });

  test(`${browser}: a hidden panel claims the task as soon as it becomes visible`, async () => {
    const h = await harness({ visible: false, record: rec() });
    h.handoff.watch();
    assert.equal(await h.handoff.consume(), false);
    assert.equal(KEY in h.store, true);
    h.state.visible = true;
    h.listeners.forEach((fn) => fn());
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(h.log.sent.length, 1);
    assert.equal(KEY in h.store, false);
  });

  test(`${browser}: nothing is claimed before start(), and a slow startup does not make the task stale`, async () => {
    const h = await harness({ record: rec({ createdAt: 99_000 }), start: false, clock: 100_000 });
    assert.equal(await h.handoff.consume(), false);
    assert.equal(KEY in h.store, true);
    assert.equal(h.log.sent.length, 0);
    // Startup took 45 s: the record is now 46 s old, beyond the normal 30 s window.
    h.state.time = 145_000;
    assert.equal(await h.handoff.start(), true);
    assert.deepEqual(h.log.sent, [{ __mode: 'ask' }]);
    assert.equal(KEY in h.store, false);
  });

  test(`${browser}: the startup allowance applies once and is capped`, async () => {
    const h = await harness({ record: rec({ createdAt: 99_000 }), start: false, clock: 100_000 });
    h.state.time = 100_000 + 10 * 60_000; // ten minutes of startup
    assert.equal(await h.handoff.start(), false); // allowance capped at 2 min, record far older
    assert.equal(h.log.sent.length, 0);
  });

  test(`${browser}: submissions for different tabs never overwrite each other`, async () => {
    const a = rec({ id: 'a', tabId: 3, text: 'first' });
    const b = rec({ id: 'b', tabId: 4, text: 'second' });
    const h = await harness({ records: { [newtabHandoffKey(3)]: a, [newtabHandoffKey(4)]: b } });
    await h.handoff.consume();
    await flush(); // the follow-up look for further tasks settles
    assert.equal(h.log.value, 'first');
    assert.equal(newtabHandoffKey(4) in h.store, true, "tab 4's task is untouched");
    h.state.tabId = 4;
    await h.handoff.consume();
    await flush();
    assert.equal(h.log.value, 'second');
    assert.equal(Object.keys(h.store).length, 0);
  });

  test(`${browser}: a declined send leaves the text in the composer`, async () => {
    const h = await harness({ record: rec(), sendResult: false });
    h.input.value = '';
    assert.equal(await h.handoff.consume(), true);
    assert.equal(h.log.sent.length, 1);
    await flush();
    assert.equal(h.input.value, 'summarise');
  });

  test(`${browser}: a send that lasts a whole run does not block the next hand-off`, async () => {
    const h = await harness({ record: rec() });
    let finishRun;
    const slow = createNewtabHandoff({
      storage: {
        get: async (k) => (k in h.store ? { [k]: h.store[k] } : {}),
        remove: async (k) => { delete h.store[k]; },
      },
      getCurrentTabId: () => 3,
      getIsProcessing: () => false,
      getIsDocumentVisible: () => true,
      doc: null,
      setMode() {},
      getInputEl: () => h.input,
      autoResizeInput() {},
      // Like the real send: commits (clears the composer) quickly, then runs for a long time.
      sendMessage: () => new Promise((resolve) => { h.input.value = ''; finishRun = resolve; }),
      now: () => 100_000,
    });
    await slow.start();
    const result = await Promise.race([slow.consume(), new Promise((r) => setTimeout(() => r('blocked'), 200))]);
    assert.equal(result, false); // record was already claimed by start(); nothing hangs
    h.store[KEY] = rec({ id: 'r2', text: 'next' });
    const second = await Promise.race([slow.consume(), new Promise((r) => setTimeout(() => r('blocked'), 200))]);
    assert.equal(second, true, 'the second task is claimed while the first run is still going');
    finishRun();
  });

  test(`${browser}: a record that arrives while another is being claimed is retried`, async () => {
    const h = await harness({ record: rec({ id: 'r1', text: 'first' }) });
    const sent = [];
    const handoff = createNewtabHandoff({
      storage: {
        get: async (k) => (k in h.store ? { [k]: h.store[k] } : {}),
        remove: async (k) => { delete h.store[k]; },
      },
      getCurrentTabId: () => 3,
      getIsProcessing: () => false,
      getIsDocumentVisible: () => true,
      doc: null,
      setMode: () => {
        // The new tab unlocks once the first record is removed, so the next one
        // lands (and its storage event calls consume) while this claim is running.
        if (!h.store[KEY] && !sent.length) {
          h.store[KEY] = rec({ id: 'r2', text: 'second' });
          handoff.consume();
        }
      },
      getInputEl: () => h.input,
      autoResizeInput() {},
      sendMessage: async () => { sent.push(h.input.value); h.input.value = ''; },
      now: () => 100_000,
    });
    await handoff.start();
    h.store[KEY] = rec({ id: 'r1', text: 'first' });
    await handoff.consume();
    await flush();
    await flush();
    assert.deepEqual(sent, ['first', 'second']);
    assert.equal(KEY in h.store, false);
  });

  test(`${browser}: a second hand-off waits while the first Ask still holds the composer`, async () => {
    const h = await harness({ record: rec({ id: 'r1', text: 'first' }) });
    const sent = [];
    let commitFirst;
    const handoff = createNewtabHandoff({
      storage: {
        get: async (k) => (k in h.store ? { [k]: h.store[k] } : {}),
        remove: async (k) => { delete h.store[k]; },
      },
      getCurrentTabId: () => 3,
      getIsProcessing: () => false,
      getIsDocumentVisible: () => true,
      doc: null,
      setMode() {},
      getInputEl: () => h.input,
      autoResizeInput() {},
      // The send checks the composer, so the draft stays put until it has committed.
      sendMessage: () => new Promise((resolve) => {
        sent.push(h.input.value);
        commitFirst = () => { h.input.value = ''; resolve(undefined); };
      }),
      now: () => 100_000,
    });
    await handoff.start();
    h.store[KEY] = rec({ id: 'r1', text: 'first' });
    await handoff.consume();
    assert.deepEqual(sent, ['first']);

    // The next task lands before the first send has committed.
    h.store[KEY] = rec({ id: 'r2', text: 'second' });
    assert.equal(await handoff.consume(), false);
    assert.equal(h.input.value, 'first', "the first task's text was not replaced");
    assert.equal(KEY in h.store, true, 'the second task is still waiting');

    commitFirst();
    await new Promise((r) => setTimeout(r, 400));
    assert.deepEqual(sent, ['first', 'second']);
    assert.equal(KEY in h.store, false);
  });

  test(`${browser}: Act never replaces what is already in the composer`, async () => {
    const h = await harness({ record: rec({ mode: 'act', text: 'book a table at 8' }) });
    h.input.value = 'book a table';
    assert.equal(await h.handoff.consume(), true);
    assert.equal(h.input.value, 'book a table\n\nbook a table at 8');
    assert.equal(h.log.sent.length, 0);
    assert.equal(h.log.mode, null, 'the draft keeps the mode it was written in');

    // The same text twice is not duplicated; an empty composer is filled and the task is sent.
    const same = await harness({ record: rec({ mode: 'act', text: 'x' }) });
    same.input.value = 'x';
    await same.handoff.consume();
    assert.equal(same.log.value, 'x');
    const empty = await harness({ record: rec({ mode: 'act', text: 'y' }) });
    await empty.handoff.consume();
    assert.equal(empty.log.value, 'y');
    assert.equal(empty.log.sent.length, 1);
  });

  test(`${browser}: Ask never overwrites an existing draft and is not sent over it`, async () => {
    const h = await harness({ record: rec({ text: 'summarise this' }) });
    h.input.value = 'my half-written email to Sam';
    assert.equal(await h.handoff.consume(), true);
    assert.equal(h.input.value, 'my half-written email to Sam\n\nsummarise this');
    assert.equal(h.log.sent.length, 0, 'the combined text is left for the user to review and send');
    assert.equal(h.log.mode, null, 'an Act draft is not turned into an Ask (or the reverse)');
    assert.equal(KEY in h.store, false);
  });

  test(`${browser}: an existing draft keeps its own whitespace when the task is added below it`, async () => {
    const h = await harness({ record: rec({ text: 'summarise this' }) });
    h.input.value = '    indented code\n  more  ';
    assert.equal(await h.handoff.consume(), true);
    assert.equal(h.input.value, '    indented code\n  more  \n\nsummarise this');
    const blank = await harness({ record: rec({ mode: 'act', text: 'task' }) });
    blank.input.value = '   \n ';
    await blank.handoff.consume();
    assert.equal(blank.log.value, 'task', 'a whitespace-only composer counts as empty');
  });

  test(`${browser}: manifest and background are wired`, () => {
    const manifest = JSON.parse(readFileSync(path.join(root, 'src', browser, 'manifest.json'), 'utf8'));
    assert.equal(manifest.chrome_url_overrides?.newtab, 'newtab/index.html');
    assert.ok(manifest.permissions.includes('search'));
    assert.ok(existsSync(path.join(root, 'src', browser, 'newtab/index.html')), 'run npm run build:newtab');
    const bg = readFileSync(path.join(root, 'src', browser, 'src/background.js'), 'utf8');
    assert.match(bg, /WB_NEWTAB_PANEL_OPENED/);
    // Unclaimed records are cleaned up without waiting for another submission.
    assert.match(bg, /tabs\.onRemoved\.addListener\(\(closedTabId\)[^]*?wbNewtabHandoff:\$\{closedTabId\}/);
    assert.match(bg, /runtime\.onStartup\?\.addListener\?\.\(async \(\) => \{\s*try \{[\s\S]*startsWith\('wbNewtabHandoff:'\)/);
  });
}

test('new tab and side panel agree on the hand-off key', async () => {
  const { NEWTAB_HANDOFF_PREFIX: panelPrefix, newtabHandoffKey } =
    await load(path.join(root, 'src/chrome/src/ui/newtab-handoff.js'));
  assert.equal(HANDOFF_PREFIX, panelPrefix);
  assert.equal(handoffKey(12), newtabHandoffKey(12));
  for (const b of ['chrome', 'firefox']) {
    const bg = readFileSync(path.join(root, 'src', b, 'src/background.js'), 'utf8');
    assert.ok(bg.includes(`'${panelPrefix}'`), `${b} background sweeps ${panelPrefix}*`);
  }
});

test('new tab and receivers agree on who each record is for', async () => {
  const { NEWTAB_HANDOFF_TARGET_PANEL, NEWTAB_HANDOFF_TARGET_TAB_CHAT } =
    await load(path.join(root, 'src/chrome/src/ui/newtab-handoff.js'));
  assert.equal(HANDOFF_TARGET_PANEL, NEWTAB_HANDOFF_TARGET_PANEL);
  assert.equal(HANDOFF_TARGET_TAB_CHAT, NEWTAB_HANDOFF_TARGET_TAB_CHAT);
  assert.equal(buildHandoff({ text: 'a', mode: 'act', tabId: 1 }).target, NEWTAB_HANDOFF_TARGET_PANEL);
  // Ask is addressed to the full-page chat; Act (submitTask) to the panel.
  const writes = [];
  const api = {
    storage: { local: { set: async (v) => { writes.push(Object.values(v)[0]); }, get: async () => ({}) } },
    runtime: { getURL: (p) => p, sendMessage: async () => {} },
    sidePanel: { setOptions: async () => {}, open: async () => {} },
  };
  await openAskChat({ text: 'ask' }, api, { id: 51 }, () => {});
  await submitTask({ text: 'act', mode: 'act' }, api, { id: 52 });
  assert.deepEqual(writes.map((w) => w.target), [NEWTAB_HANDOFF_TARGET_TAB_CHAT, NEWTAB_HANDOFF_TARGET_PANEL]);
  // Each side panel page names its role.
  for (const b of ['chrome', 'firefox']) {
    const panel = readFileSync(path.join(root, 'src', b, 'src/ui/sidepanel.js'), 'utf8');
    assert.match(panel, /receiver: isTabChat \? NEWTAB_HANDOFF_TARGET_TAB_CHAT : NEWTAB_HANDOFF_TARGET_PANEL,/, b);
  }
});

test('both extensions ship an identical handoff module', () => {
  const a = readFileSync(path.join(root, 'src/chrome/src/ui/newtab-handoff.js'), 'utf8');
  const b = readFileSync(path.join(root, 'src/firefox/src/ui/newtab-handoff.js'), 'utf8');
  assert.equal(a, b);
});

test('built new tab is identical in both extensions and calls no external host', () => {
  const dirs = ['chrome', 'firefox'].map((b) => path.join(root, 'src', b, 'newtab'));
  const html = dirs.map((d) => readFileSync(path.join(d, 'index.html'), 'utf8'));
  assert.equal(html[0], html[1]);
  assert.doesNotMatch(html[0], /https?:\/\//);
  assert.doesNotMatch(html[0], /<script(?![^>]*src=)[^>]*>[^<]/, 'no inline script (MV3 CSP)');
});

test('every WebBrain locale has every new tab string', async (t) => {
  let esbuild;
  try {
    esbuild = await import(pathToFileURL(path.join(root, 'newtab/node_modules/esbuild/lib/main.js')).href);
  } catch {
    return t.skip('newtab dependencies are not installed');
  }
  const out = await esbuild.build({
    entryPoints: [nt('lib/wb-strings.js')],
    bundle: true,
    write: false,
    format: 'esm',
    nodePaths: [nt()],
    platform: 'node',
  });
  const code = `data:text/javascript;base64,${Buffer.from(out.outputFiles[0].text).toString('base64')}`;
  const { WB_STRINGS } = await import(code);
  const expected = 'en zh ar bn nl tl fr de he hi id ja ko ms fa pl pt ru es th tr uk vi'.split(' ');
  assert.deepEqual(Object.keys(WB_STRINGS).sort(), [...expected].sort());
  const keys = Object.keys(WB_STRINGS.en);
  assert.equal(keys.length, 24);
  for (const lang of expected) {
    for (const k of keys) {
      assert.ok(String(WB_STRINGS[lang][k] ?? '').trim(), `${lang} is missing ${k}`);
    }
  }
});

test('first run on an empty store writes the defaults instead of throwing', async (t) => {
  let esbuild;
  try {
    esbuild = await import(pathToFileURL(path.join(root, 'newtab/node_modules/esbuild/lib/main.js')).href);
  } catch {
    return t.skip('newtab dependencies are not installed');
  }
  const out = await esbuild.build({
    stdin: {
      contents: "import variables from 'config/variables'; export { moveSettings } from 'utils/settings/move'; export { variables };",
      resolveDir: nt(),
      loader: 'js',
    },
    bundle: true,
    write: false,
    format: 'esm',
    nodePaths: [nt()],
    platform: 'node',
  });
  const mod = await import(`data:text/javascript;base64,${Buffer.from(out.outputFiles[0].text).toString('base64')}`);
  mod.variables.getMessage = () => 'New Tab';

  const real = globalThis.localStorage;
  const store = memoryStorage();
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: new Proxy(store, {
    ownKeys: () => [...store._map.keys()],
    getOwnPropertyDescriptor: (_t, k) => (store._map.has(k) ? { value: store._map.get(k), enumerable: true, configurable: true } : undefined),
  }) });
  try {
    assert.doesNotThrow(() => mod.moveSettings());
    assert.equal(store.getItem('firstRun'), 'true');
    assert.equal(store.getItem('taskBox'), 'true');

    // A store that already has values keeps them over the defaults.
    store.clear();
    store.setItem('taskBoxMode', 'act');
    mod.moveSettings();
    assert.equal(store.getItem('taskBoxMode'), 'act');
    assert.equal(store.getItem('firstRun'), 'true');
  } finally {
    if (real === undefined) delete globalThis.localStorage;
    else Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: real });
  }
});

test('recent chats open the clicked conversation by id', () => {
  const recent = readFileSync(nt('features/agent/RecentChats.jsx'), 'utf8');
  assert.match(recent, /\?id=\$\{encodeURIComponent\(chat\.id\)\}/);
  for (const b of ['chrome', 'firefox']) {
    const history = readFileSync(path.join(root, 'src', b, 'src/ui/history.js'), 'utf8');
    assert.match(history, /get\('id'\)/, `${b} history reads ?id=`);
    assert.match(history, /renderRecord\(initialRecordId\)/, `${b} history opens it`);
  }
});

test('EventBus.off removes the listener that was really registered', async () => {
  const doc = new EventTarget();
  const hadDocument = 'document' in globalThis;
  const previous = globalThis.document;
  globalThis.document = doc;
  try {
    const { default: EventBus } = await load(nt('utils/eventbus.js'));
    const calls = [];
    const handler = (detail) => calls.push(detail);

    EventBus.on('refresh', handler);
    EventBus.emit('refresh', 'a');
    EventBus.off('refresh', handler);
    EventBus.emit('refresh', 'b');
    assert.deepEqual(calls, ['a'], 'off() stops further calls (cleanup in React effects works)');
    assert.equal(EventBus.getListeners('refresh').length, 0);

    // Re-subscribing on every render must not pile handlers up.
    for (let i = 0; i < 5; i += 1) {
      EventBus.on('refresh', handler);
      EventBus.off('refresh', handler);
    }
    calls.length = 0;
    EventBus.emit('refresh', 'c');
    assert.deepEqual(calls, []);

    EventBus.once('ping', handler);
    EventBus.emit('ping', 1);
    EventBus.emit('ping', 2);
    assert.deepEqual(calls, [1]);

    calls.length = 0;
    EventBus.prepend('cap', handler);
    EventBus.emit('cap', 'x');
    EventBus.off('cap', handler);
    EventBus.emit('cap', 'y');
    assert.deepEqual(calls, ['x'], 'capture-phase listeners are removed too');
  } finally {
    if (hadDocument) globalThis.document = previous;
    else delete globalThis.document;
  }
});

test('picking a colour refreshes the visible background even though the type is unchanged', () => {
  const hook = readFileSync(nt('features/background/hooks/useBackgroundEvents.js'), 'utf8');
  assert.match(hook, /type === 'colour'/);
});

test('the producer lock outlasts the panel\'s accepted record age', async () => {
  const { NEWTAB_HANDOFF_MAX_AGE_MS, NEWTAB_HANDOFF_MAX_STARTUP_ALLOWANCE_MS } =
    await load(path.join(root, 'src/chrome/src/ui/newtab-handoff.js'));
  const longest = NEWTAB_HANDOFF_MAX_AGE_MS + NEWTAB_HANDOFF_MAX_STARTUP_ALLOWANCE_MS;
  const number = (text, re) => Number(re.exec(text)[1].replace(/_/g, ''));

  const lock = number(readFileSync(nt('features/agent/handoff.js'), 'utf8'), /CLAIM_TIMEOUT_MS = ([\d_]+)/);
  assert.ok(lock > longest, `producer lock ${lock} must exceed ${longest}`);
});

test('the recent-chats switch refreshes the widgets', () => {
  const src = readFileSync(nt('features/agent/TaskBoxOptions.jsx'), 'utf8');
  assert.match(src, /<Switch name="recentChats" category="widgets"/);
  assert.doesNotMatch(src, /element=/, 'a missing .other element made the switch bail out');
});

test('components unsubscribe the handler they registered', () => {
  for (const file of [
    'features/greeting/Greeting.jsx', 'features/navbar/components/Notes.jsx', 'features/navbar/Navbar.jsx',
    'features/misc/views/Widgets.jsx', 'features/message/Message.jsx', 'features/time/Clock.jsx', 'features/time/Date.jsx',
  ]) {
    assert.doesNotMatch(readFileSync(nt(file), 'utf8'), /EventBus\.off\('refresh'\)/, file);
  }
});

test('the task box can be hidden from settings', () => {
  const src = readFileSync(nt('features/agent/TaskBoxOptions.jsx'), 'utf8');
  assert.match(src, /setting="taskBox"[^>]*visibilityToggle=\{true\}/);
});

test('deleting a custom background does not also select a card', () => {
  const src = readFileSync(nt('features/background/options/Custom.jsx'), 'utf8');
  assert.match(src, /closest\('\.delete-button'\)/);
  assert.match(src, /e\.stopPropagation\(\);\s*modifyCustomBackground\('remove', originalIndex\)/);
});

test('reset also deletes the uploaded backgrounds', () => {
  const src = readFileSync(nt('components/Elements/ResetModal/ResetModal.jsx'), 'utf8');
  assert.match(src, /import \{ clearAllBackgrounds \} from 'utils\/customBackgroundDB'/);
  assert.ok(src.indexOf('await clearAllBackgrounds()') < src.indexOf("setDefaultSettings('reset')"));
});

test('the gallery has no arrows that emit a URL the event bus drops', () => {
  const src = readFileSync(nt('features/background/options/Custom.jsx'), 'utf8');
  assert.doesNotMatch(src, /image-nav-buttons|nav-prev|nav-next/);
  assert.doesNotMatch(src, /EventBus\.emit\('refresh', 'background', [^)]*\.url\)/);
});

test('the unreachable custom-URL background flow is gone', () => {
  const src = readFileSync(nt('features/background/options/Custom.jsx'), 'utf8');
  assert.doesNotMatch(src, /addCustomURL|CustomURLModal|setCustomURLModal/);
  assert.equal(existsSync(nt('features/background/options/CustomURLModal.jsx')), false);
});

test('a superseded background load is cancelled instead of painting over the newer one', () => {
  const src = readFileSync(nt('features/background/hooks/useBackgroundRenderer.js'), 'utf8');
  assert.match(src, /let cancelled = false/);
  assert.match(src, /cancelled = true;\s*clearTimeout\(swapTimer\)/);
  assert.equal((src.match(/if \(cancelled\)/g) || []).length >= 2, true);
  assert.doesNotMatch(src, /abortControllerRef/);
});

test('the background settings header has a Hide/Show toggle', () => {
  const src = readFileSync(nt('features/background/options/BackgroundOptions.jsx'), 'utf8');
  assert.match(src, /setting="background"[\s\S]{0,120}visibilityToggle=\{true\}/);
});

for (const browserName of ['chrome', 'firefox']) {
  test(`${browserName}: Act can bootstrap navigation away from WebBrain's own new tab page`, async () => {
    const { BotMemorySession } = await import(
      pathToFileURL(path.join(root, 'src', browserName, 'src/agent/bot-memory.js')).href
    );
    const base = browserName === 'chrome' ? 'chrome-extension://abc123/' : 'moz-extension://uuid-1/';
    const api = { runtime: { getURL: (p) => base + p } };
    const prev = { chrome: globalThis.chrome, browser: globalThis.browser };
    globalThis.chrome = api;
    globalThis.browser = api;
    try {
      const check = (url) => {
        const s = Object.create(BotMemorySession.prototype);
        s.getTab = async () => ({ url });
        return s.canBootstrapNavigation(1, 'navigate', { url: 'https://example.com/' });
      };
      assert.equal(await check(`${base}newtab/index.html`), true);
      assert.equal(await check(`${base}newtab/index.html?x=1#y`), true);
      assert.equal(await check(`${base}src/ui/history.html`), false); // other extension pages: no
      assert.equal(await check('chrome-extension://evil/newtab/index.html'), browserName === 'chrome' ? false : false);
      assert.equal(await check('https://example.com/newtab/index.html'), false);
    } finally {
      globalThis.chrome = prev.chrome;
      globalThis.browser = prev.browser;
      if (prev.chrome === undefined) delete globalThis.chrome;
      if (prev.browser === undefined) delete globalThis.browser;
    }
  });
}

test('chrome agent treats the extension new tab page as a browser new tab', () => {
  const src = readFileSync(path.join(root, 'src/chrome/src/agent/agent.js'), 'utf8');
  const fn = src.slice(src.indexOf('function isBrowserNewTabUrl'), src.indexOf('function isBrowserNewTabUrl') + 700);
  assert.match(fn, /runtime\.getURL\('newtab\/index\.html'\)/);
});

test('a background refresh requested mid-load is not dropped (latest request wins)', () => {
  const src = readFileSync(nt('features/background/hooks/useBackgroundLoader.js'), 'utf8');
  assert.doesNotMatch(src, /isLoadingRef/);
  assert.match(src, /requestRef\.current/);
  assert.match(src, /await getBackgroundData\(\);\s*if \(isStale\(\)\) return;/);
});

test('PreferencesWrapper subscribes to toggle in an effect and unsubscribes', () => {
  const src = readFileSync(nt('components/Layout/Settings/PreferencesWrapper/PreferencesWrapper.jsx'), 'utf8');
  assert.match(src, /useEffect\(/);
  assert.match(src, /EventBus\.off\('toggle', handleToggle\)/);
  // the only subscription lives inside the effect body
  assert.equal((src.match(/EventBus\.on\('toggle'/g) || []).length, 1);
  assert.ok(src.indexOf("EventBus.on('toggle'") > src.indexOf('useEffect('));
});

test('enabling quick links refreshes the widget tree so the widget mounts', () => {
  const src = readFileSync(nt('features/quicklinks/options/QuickLinksOptions.jsx'), 'utf8');
  assert.match(src, /setting="quicklinksenabled"\s*category="widgets"/);
  assert.doesNotMatch(src, /element="\.quicklinks-container"/);
});

test('round-14 inherited fixes: clock timer, custom overlay, video flags, colour reset, icon errors', () => {
  const read = (f) => readFileSync(nt(f), 'utf8');
  const clock = read('features/time/Clock.jsx');
  assert.match(clock, /clearTimeout\(timerRef\.current\);\s*timerRef\.current = null;\s*startTime\(0\)/);
  assert.match(read('features/background/components/BackgroundImage.jsx'), /\[isCustomType, url\]/);
  const video = read('features/background/components/BackgroundVideo.jsx');
  assert.doesNotMatch(video, /useMemo/);
  assert.match(video, /data === 'backgroundvideo'/);
  const custom = read('features/background/options/Custom.jsx');
  assert.equal((custom.match(/category="backgroundvideo"/g) || []).length, 2);
  const colour = read('features/background/options/Colour.jsx');
  assert.match(colour, /setColour\(DEFAULT_COLOUR\);\s*[^\n]*\n?\s*localStorage\.setItem\('customBackgroundColour', DEFAULT_COLOUR\)/);
  assert.match(read('features/navbar/options/AppsOptions.jsx'), /iconError=\{appsModalInfo\.iconError\}/);
  assert.match(read('features/quicklinks/options/QuickLinksOptions.jsx'), /iconError=\{iconError\}/);
});

test('the reload reminder is shown through a null-safe helper (the notice may not be mounted)', () => {
  const helper = readFileSync(nt('utils/reminder.js'), 'utf8');
  assert.match(helper, /const el = document\.querySelector\('\.reminder-info'\);\s*if \(el\)/);
  const offenders = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.jsx?$/.test(entry.name) && full !== nt('utils/reminder.js')
        && /querySelector\('\.reminder-info'\)\.style/.test(readFileSync(full, 'utf8'))) offenders.push(full);
    }
  };
  walk(nt('.'));
  assert.deepEqual(offenders, []);
});

test('widget Show buttons remount through the widget tree, not an element probe', () => {
  for (const f of [
    'features/greeting/options/GreetingOptions.jsx',
    'features/message/options/MessageOptions.jsx',
    'features/time/options/DateOptions.jsx',
    'features/time/options/TimeOptions.jsx',
  ]) {
    const src = readFileSync(nt(f), 'utf8');
    const at = src.indexOf('visibilityToggle', src.indexOf('setting="'));
    const start = src.lastIndexOf('<Header', at);
    const header = src.slice(start, src.indexOf('/>', at));
    assert.match(header, /category="widgets"/, f);
    assert.doesNotMatch(header, /element=/, f);
  }
});

test('the date widget rolls over to a new day and the drag handler ignores a null drop target', () => {
  const date = readFileSync(nt('features/time/Date.jsx'), 'utf8');
  assert.match(date, /setInterval\(getDate, 60_000\)/);
  assert.match(date, /clearInterval\(dayTimer\)/);
  const overview = readFileSync(nt('features/misc/sections/Overview.jsx'), 'utf8');
  assert.match(overview, /if \(over && active\.id !== over\.id\)/);
});

test('after a page reload a still-pending record keeps its lock, so a second submit cannot replace it', async () => {
  const store = new Map();
  const listeners = [];
  const api = {
    storage: {
      local: {
        get: async (k) => (store.has(k) ? { [k]: store.get(k) } : {}),
        set: async (o) => Object.entries(o).forEach(([k, v]) => store.set(k, v)),
        remove: async (k) => store.delete(k),
      },
      onChanged: { addListener: (fn) => listeners.push(fn), removeListener: (fn) => listeners.splice(listeners.indexOf(fn), 1) },
    },
    sidePanel: { setOptions: async () => {}, open: async () => {} },
    runtime: { sendMessage: async () => {} },
  };
  const tabId = 123;
  const now = Date.now();
  // nothing stored: nothing to adopt
  assert.equal(await adoptPendingHandoff(api, tabId, now), false);
  // an expired record is not adopted
  store.set(handoffKey(tabId), { id: 'old', tabId, text: 'x', mode: 'ask', createdAt: now - 200_000 });
  assert.equal(await adoptPendingHandoff(api, tabId, now), false);
  assert.equal(isHandoffPending(tabId), false);
  // a fresh record written by the previous page instance is
  store.set(handoffKey(tabId), { id: 'fresh', tabId, text: 'first', mode: 'ask', createdAt: now - 5_000 });
  assert.equal(await adoptPendingHandoff(api, tabId, now), true);
  assert.equal(isHandoffPending(tabId), true);
  await assert.rejects(() => submitTask({ text: 'second', mode: 'ask' }, api, { id: tabId }), /still being handed over/);
  assert.equal(store.get(handoffKey(tabId)).id, 'fresh');
  // the panel claims it -> released
  const key = handoffKey(tabId);
  store.delete(key);
  listeners.slice().forEach((fn) => fn({ [key]: { oldValue: {} } }, 'local'));
  await whenClaimed({ id: tabId });
  assert.equal(isHandoffPending(tabId), false);
  assert.equal(listeners.length, 0);
});

test('Show on a background that was off at load mounts it without a reload', () => {
  const app = readFileSync(nt('App.jsx'), 'utf8');
  assert.match(app, /data === 'background'[\s\S]{0,120}setShowBackground\(localStorage\.getItem\('background'\) === 'true'\)/);
  assert.match(app, /EventBus\.off\('refresh', handleRefresh\)/);
  const opts = readFileSync(nt('features/background/options/BackgroundOptions.jsx'), 'utf8');
  assert.doesNotMatch(opts, /element="#backgroundImage"/);
});

test('the new tab only publishes its tab after pending-record adoption finished', () => {
  const src = readFileSync(nt('features/agent/handoff.js'), 'utf8');
  const fn = src.slice(src.indexOf('export async function primeCurrentTab'), src.indexOf('export function buildHandoff'));
  assert.ok(fn.indexOf('await adoptPendingHandoff') < fn.indexOf('currentTab = tab'));
});

test('round-17: maximise and effect controls handle video backgrounds; dismissing the modal leaves edit mode', () => {
  const read = (f) => readFileSync(nt(f), 'utf8');
  const max = read('features/navbar/components/Maximise.jsx');
  assert.match(max, /getElementById\('backgroundVideo'\)/);
  assert.match(max, /if \(widgets\) widgets\.style\.display = 'none'/);
  const fx = read('features/background/options/sections/EffectsSettings.jsx');
  assert.equal((fx.match(/element="#backgroundImage, #backgroundVideo"/g) || []).length, 4);
  assert.doesNotMatch(fx, /element="#backgroundImage"/);
  const ql = read('features/quicklinks/options/QuickLinksOptions.jsx');
  assert.match(ql, /onRequestClose=\{\(\) => \{[^}]*setEdit\(false\);\s*setEditData\(''\);/);
});

test('videoCheck accepts a File MIME type as well as data URLs and extensions', async () => {
  const { default: videoCheck } = await load(nt('features/background/api/videoCheck.js'));
  for (const yes of ['video/mp4', 'video/webm', 'video/ogg', 'data:video/mp4;base64,AAA', 'https://x/a.webm']) {
    assert.equal(videoCheck(yes), true, yes);
  }
  for (const no of ['image/png', 'image/jpeg', 'data:image/png;base64,AAA', '']) {
    assert.equal(videoCheck(no), false, no);
  }
});

test('first run does not reload forever when storage is only in memory', () => {
  const app = readFileSync(nt('App.jsx'), 'utf8');
  assert.match(app, /import \{ rawStorage \} from 'lib\/storage-namespace'/);
  assert.match(app, /if \(rawStorage\) \{\s*window\.location\.reload\(\);\s*\} else \{[\s\S]*onDefaultsApplied/);
  assert.match(app, /key=\{setupKey\}/);
});

test('round-18b: maximise toggles the overlay effects, message list changes refresh the widget, birthday is a local date', () => {
  const read = (f) => readFileSync(nt(f), 'utf8');
  const max = read('features/navbar/components/Maximise.jsx');
  assert.match(max, /getElementById\('backgroundFilterOverlay'\)/);
  assert.doesNotMatch(max, /setAttribute\(/, 'no longer overwrites the image element style attribute');
  const msg = read('features/message/Message.jsx');
  assert.match(msg, /messages\.includes\(current\)/);
  assert.match(read('features/message/options/MessageOptions.jsx'), /EventBus\.emit\('refresh', 'message'\)/);
  const greet = read('features/greeting/options/GreetingOptions.jsx');
  assert.match(greet, /new Date\(year, month - 1, day\)/);
  assert.doesNotMatch(greet, /toISOString/);
  // the parse really lands on the same calendar day west of UTC
  const parse = (value) => { const [y, m, d] = value.split('-').map(Number); return new Date(y, m - 1, d); };
  const d = parse('2026-10-17');
  assert.deepEqual([d.getFullYear(), d.getMonth(), d.getDate()], [2026, 9, 17]);
});

test('round-19: import applies by reloading; multiline messages split on real newlines; week number clears', () => {
  const read = (f) => readFileSync(nt(f), 'utf8');
  assert.match(read('utils/settings/import.js'), /setTimeout\(\(\) => window\.location\.reload\(\), 1200\)/);
  const msg = read('features/message/Message.jsx');
  assert.match(msg, /split\(\/\\r\?\\n\/\)/);
  assert.doesNotMatch(msg, /split\('\\\\n'\)/);
  const date = read('features/time/Date.jsx');
  assert.doesNotMatch(date, /weekNumber !== null/);
  assert.equal('a\nb\r\nc'.split(/\r?\n/).length, 3);
});

test('round-20: todo focus handlers, vertical colour resets, padded date reordering, seconds clearing', () => {
  const read = (f) => readFileSync(nt(f), 'utf8');
  const todo = read('features/navbar/components/Todo.jsx');
  assert.match(todo, /onFocus=\{handleShowTodo\}/);
  assert.doesNotMatch(todo, /onFocus=\{handleHideTodo\}/);
  const time = read('features/time/options/TimeOptions.jsx');
  assert.doesNotMatch(time, /onClick=\{\(\) => localStorage\.setItem\('(hour|minute|second)Colour'/);
  assert.equal((time.match(/updateColour\('(hour|minute|second)Colour', \{ target: \{ value: '#ffffff' \} \}\)/g) || []).length, 6);
  const date = read('features/time/Date.jsx');
  assert.doesNotMatch(date, /day = dateMonth|month = dateDay|year = dateDay/);
  assert.match(read('features/time/Clock.jsx'), /setFinalSeconds\(''\)/);
});

test('round-21: Apps popup closes on blur; Maximise restores the page when it unmounts', () => {
  const read = (f) => readFileSync(nt(f), 'utf8');
  assert.match(read('features/navbar/components/Apps.jsx'), /onFocus=\{handleShowApps\}/);
  const max = read('features/navbar/components/Maximise.jsx');
  assert.match(max, /useEffect\(\s*\(\) => \(\) => \{\s*if \(!hiddenRef\.current\) return;/);
  assert.match(max, /hiddenRef\.current = true/);
  assert.match(max, /hiddenRef\.current = false/);
});

test('round-22: switch is an accessible control; report link uses ?title=; uploads are not mirrored into localStorage', () => {
  const read = (f) => readFileSync(nt(f), 'utf8');
  const sw = read('components/Form/Settings/Switch/Switch.jsx');
  assert.match(sw, /role="switch"/);
  assert.match(sw, /aria-label=\{label\}/);
  assert.doesNotMatch(sw, /className="switch-input"[\s\S]{0,80}aria-hidden="true"/);
  assert.match(read('components/Form/Settings/Switch/Switch.scss'), /switch-input:focus-visible/);
  assert.match(read('components/Layout/Settings/Header/Header.jsx'), /BUG_REPORT\}\?title=\$\{encodeURIComponent\(props\.title\)\}/);
  const custom = read('features/background/options/Custom.jsx');
  assert.doesNotMatch(custom, /localStorage\.setItem\('customBackground', JSON/);
  assert.equal((custom.match(/syncBackgroundCount\(backgrounds\)/g) || []).length, 3);
});

test('round-23: popups keep focus inside; reminder mounts via event; backups carry uploaded backgrounds', () => {
  const read = (f) => readFileSync(nt(f), 'utf8');
  for (const f of ['Notes', 'Todo', 'Apps']) {
    const src = read(`features/navbar/components/${f}.jsx`);
    assert.match(src, /event\.currentTarget\.contains\(event\.relatedTarget\)/, f);
    assert.doesNotMatch(src, /<button[\s\S]{0,200}onBlur=/, `${f}: trigger no longer hides on its own blur`);
  }
  assert.match(read('utils/reminder.js'), /EventBus\.emit\('reminder'\)/);
  assert.match(read('components/Elements/MainModal/backend/Tabs.jsx'), /EventBus\.on\('reminder', handleReminder\)[\s\S]*EventBus\.off\('reminder', handleReminder\)/);
  const exp = read('utils/settings/export.js');
  assert.match(exp, /BACKGROUNDS_BACKUP_KEY = 'wbBackgroundsBackup'/);
  assert.match(exp, /getAllBackgroundsWithMetadata\(\)/);
  assert.match(exp, /could not be read[\s\S]*return false;/);
  const imp = read('utils/settings/import.js');
  assert.match(imp, /export async function importSettings/);
  assert.match(imp, /\[BACKGROUNDS_BACKUP_KEY\]: backgrounds/);
  assert.match(imp, /await clearAllBackgrounds\(\)[\s\S]*await addBackground\(record\)/);
});

test('round-24: filters follow the background, backups record an empty gallery, deletions reload the picture', () => {
  const read = (f) => readFileSync(nt(f), 'utf8');
  const rend = read('features/background/hooks/useBackgroundRenderer.js');
  assert.match(rend, /useBackgroundFilters\(backgroundData\)[\s\S]*\[backgroundData\]/);
  assert.match(rend, /useBackgroundOverlayFilters\(backgroundData\)/);
  assert.match(rend, /element\.style\.backgroundImage = ''/);
  const bg = read('features/background/Background.jsx');
  assert.match(bg, /useBackgroundFilters\(backgroundData\)/);
  assert.match(bg, /useBackgroundOverlayFilters\(backgroundData\)/);
  const exp = read('utils/settings/export.js');
  assert.match(exp, /await getBackgroundCount\(\)/);
  assert.match(exp, /if \(backgrounds\.length !== count\) throw/);
  assert.doesNotMatch(exp, /if \(backgrounds\.length > 0\)/);
  const custom = read('features/background/options/Custom.jsx');
  assert.equal((custom.match(/EventBus\.emit\('refresh', 'backgroundrefresh'\)/g) || []).length, 2);
});

test('importSettings restores uploaded backgrounds atomically and rolls back on failure', async (t) => {
  let esbuild;
  try {
    esbuild = await import(pathToFileURL(path.join(root, 'newtab/node_modules/esbuild/lib/main.js')).href);
  } catch {
    return t.skip('newtab dependencies are not installed');
  }
  const fakes = {
    'utils/customBackgroundDB': `
      export const db = { rows: [], nextId: 1, failAddAt: -1, adds: 0, unreadable: false };
      export const getBackgroundCount = async () => { if (db.unreadable) throw new Error('db'); return db.rows.length; };
      export const getAllBackgroundsWithMetadata = async () => db.rows.map((r) => ({ ...r }));
      export const clearAllBackgrounds = async () => { db.rows = []; };
      export const addBackground = async (r) => {
        if (db.adds++ === db.failAddAt) throw new Error('quota');
        db.rows.push({ ...r, id: db.nextId++ });
      };`,
    'react-toastify': 'export const toast = (m) => { (globalThis.__toasts ||= []).push(m); };',
    'config/variables': 'export default { getMessage: (k) => k, stats: { postEvent() {} } };',
  };
  const bundleImport = async (persistent) => {
    const all = {
      ...fakes,
      'lib/storage-namespace': `export const rawStorage = ${persistent ? '{}' : 'null'};`,
      'utils/eventbus': 'export default class EventBus { static emit(name) { (globalThis.__events ||= []).push(name); } }',
    };
    const plugin = {
      name: 'fakes',
      setup(build) {
        build.onResolve({ filter: /^(utils\/customBackgroundDB|react-toastify|config\/variables|lib\/storage-namespace|utils\/eventbus)$/ }, (a) => ({ path: a.path, namespace: 'fake' }));
        build.onLoad({ filter: /.*/, namespace: 'fake' }, (a) => ({ contents: all[a.path], loader: 'js' }));
      },
    };
    const out = await esbuild.build({
      stdin: {
        contents: "export { importSettings } from 'utils/settings/import'; export { BACKGROUNDS_BACKUP_KEY } from 'utils/settings/export'; export { db } from 'utils/customBackgroundDB';",
        resolveDir: nt(), loader: 'js',
      },
      bundle: true, write: false, format: 'esm', nodePaths: [nt()], platform: 'node', plugins: [plugin],
    });
    return import(`data:text/javascript;base64,${Buffer.from(out.outputFiles[0].text).toString('base64')}`);
  };
  const mod = await bundleImport(true);
  const memoryMod = await bundleImport(false);

  const realLs = globalThis.localStorage;
  const realTimeout = globalThis.setTimeout;
  const realWindow = globalThis.window;
  const store = memoryStorage();
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: store });
  globalThis.window = { location: { reload() { globalThis.__reloads = (globalThis.__reloads || 0) + 1; } } };
  globalThis.setTimeout = (fn) => { fn(); return 0; };
  try {
    const K = mod.BACKGROUNDS_BACKUP_KEY;
    const backup = (rows) => JSON.stringify({ theme: 'dark', [K]: rows });
    mod.db.rows = [{ id: 1, url: 'data:old-1' }, { id: 2, url: 'data:old-2' }];
    mod.db.nextId = 3;

    // failure part-way: the old gallery is back, nothing else is imported, no success
    mod.db.adds = 0; mod.db.failAddAt = 1;
    globalThis.__toasts = []; globalThis.__reloads = 0;
    const failed = await mod.importSettings(backup([{ id: 9, url: 'data:image/png;base64,N1==' }, { url: 'data:image/png;base64,N2==' }, { url: 'data:image/png;base64,N3==' }]));
    assert.equal(failed, false);
    assert.deepEqual(mod.db.rows.map((r) => r.url), ['data:old-1', 'data:old-2']);
    assert.equal(store.getItem('theme'), null, 'settings were not applied');
    assert.deepEqual(globalThis.__toasts, ['toasts.error'], 'no success toast');
    assert.equal(globalThis.__reloads, 0);

    // success replaces the gallery and applies settings
    mod.db.adds = 0; mod.db.failAddAt = -1; globalThis.__toasts = [];
    const ok = await mod.importSettings(backup([{ id: 9, url: 'data:image/png;base64,N1==' }, { url: 'data:image/png;base64,N2==' }]));
    assert.equal(ok, true);
    assert.deepEqual(mod.db.rows.map((r) => r.url), ['data:image/png;base64,N1==', 'data:image/png;base64,N2==']);
    // bare hosts in a backup are stored the way the add/edit dialogs would save them
    const reloads0 = globalThis.__reloads, toasts0 = globalThis.__toasts.length;
    assert.equal(await mod.importSettings(JSON.stringify({ quicklinks: JSON.stringify([{ name: 'a', url: 'example.com', key: 'k' }]), applinks: JSON.stringify([{ name: 'b', url: 'HTTP://b.test/x', key: 'j' }]) })), true);
    assert.equal(JSON.parse(store.getItem('quicklinks'))[0].url, 'https://example.com');
    assert.equal(JSON.parse(store.getItem('applinks'))[0].url, 'http://b.test/x');
    // a missing / null icon becomes '' (the edit dialogs read icon.length); a real one is kept
    assert.equal(JSON.parse(store.getItem('applinks'))[0].icon, '');
    assert.equal(await mod.importSettings(JSON.stringify({ applinks: JSON.stringify([{ name: 'a', url: 'https://a.test', key: 'k', icon: null }, { name: 'b', url: 'https://b.test', key: 'j', icon: 'https://b.test/i.png' }]) })), true);
    assert.deepEqual(JSON.parse(store.getItem('applinks')).map((l) => l.icon), ['', 'https://b.test/i.png']);
    globalThis.__reloads = reloads0; globalThis.__toasts.length = toasts0;
    assert.equal(store.getItem('theme'), 'dark');
    assert.ok(globalThis.__toasts.includes('toasts.imported'));
    assert.equal(globalThis.__reloads, 1);

    // an explicit empty list clears the gallery; no list leaves it alone
    await mod.importSettings(backup([]));
    assert.deepEqual(mod.db.rows, []);
    mod.db.rows = [{ id: 5, url: 'data:keep' }];
    await mod.importSettings(JSON.stringify({ theme: 'light' }));
    assert.deepEqual(mod.db.rows.map((r) => r.url), ['data:keep']);

    // the legacy URL list is rendered entry by entry, so every entry has to be a usable address
    assert.equal(await mod.importSettings(JSON.stringify({ customBackground: JSON.stringify([{}]) })), false);
    assert.equal(await mod.importSettings(JSON.stringify({ customBackground: JSON.stringify(['']) })), false);

    // an empty first-run sentinel would make App.jsx reload forever
    store.setItem('theme', 'dark');
    assert.equal(await mod.importSettings(JSON.stringify({ firstRun: '', theme: 'light' })), false);
    assert.equal(await mod.importSettings(JSON.stringify({ firstRun: null })), false);
    assert.equal(store.getItem('theme'), 'dark');
    assert.equal(await mod.importSettings(JSON.stringify({ firstRun: 'true' })), true);
    assert.equal(await mod.importSettings(JSON.stringify({ customBackground: JSON.stringify(['https://x.test/a.jpg']) })), true);
    store.setItem('theme', 'light');

    // the shipped defaults (what a fresh profile exports) must import
    const defaults = JSON.parse(readFileSync(nt('utils/data/default_settings.json'), 'utf8'));
    const shipped = Object.fromEntries(
      ['applinks', 'backgroundExclude', 'customBackground', 'customEvents', 'quicklinks', 'order']
        .map((k) => [k, defaults.find((d) => d.name === k).value]),
    );
    assert.equal(shipped.customBackground, '');
    assert.equal(await mod.importSettings(JSON.stringify(shipped)), true);
    store.setItem('theme', 'light');

    // a widget listed twice would render twice and break drag-and-drop ordering
    assert.equal(await mod.importSettings(JSON.stringify({ order: JSON.stringify(['time', 'time']) })), false);
    assert.equal(await mod.importSettings(JSON.stringify({ order: JSON.stringify(['time', 'date']) })), true);
    store.setItem('theme', 'light');

    // a truncated / foreign file is reported and changes nothing
    globalThis.__toasts = [];
    for (const bad of ['{"theme": "da', '[1,2]', 'null', '"str"']) {
      assert.equal(await mod.importSettings(bad), false, bad);
    }
    assert.deepEqual(globalThis.__toasts, ['toasts.error', 'toasts.error', 'toasts.error', 'toasts.error']);
    assert.equal(store.getItem('theme'), 'light');

    // structured settings that would crash the page on the next load are refused up front
    globalThis.__toasts = []; globalThis.__reloads = 0;
    mod.db.rows = [{ id: 1, url: 'data:keep' }];
    for (const bad of [
      { customEvents: 'not-json' }, { messages: '{"a":1}' }, { applinks: '' }, { order: 'null' }, { order: '["__proto__"]' }, { order: '["time","nope"]' },
      { timezone: 'Not/AZone' }, { timezone: '' }, { favourite: '[1]' }, { favourite: '{}' }, { favourite: '{"url":"  "}' }, { favourite: '{"url":5}' }, { favourite: '{"url":"not-a-url"}' }, { favourite: '{"type":"photo","url":"data:text/plain,x"}' }, { theme: { nested: true } },
    ]) {
      assert.equal(await mod.importSettings(JSON.stringify({ ...bad, [K]: [{ url: 'data:image/png;base64,OTHE' }] })), false, JSON.stringify(bad));
    }
    for (const bad of [
      { customEvents: '[null]' }, { customEvents: '[{"name":"x","month":"1","date":1}]' }, { messages: '[1]' },
      { applinks: '[{"name":"a"}]' }, { order: '[null]' }, { todo: '[{"done":true}]' }, { backgroundExclude: '[{}]' },
    ]) {
      assert.equal(await mod.importSettings(JSON.stringify(bad)), false, JSON.stringify(bad));
    }
    assert.equal(await mod.importSettings(JSON.stringify({ quicklinks: '[null]' })), false);
    // a malformed gallery record is refused as a whole; it must not clear the current gallery
    mod.db.rows = [{ id: 1, url: 'data:keep' }];
    assert.equal(await mod.importSettings(JSON.stringify({ [K]: [null] })), false);
    assert.equal(await mod.importSettings(JSON.stringify({ [K]: [{ url: 'data:image/png;base64,OK==' }, { name: 'no url' }] })), false);
    assert.equal(await mod.importSettings(JSON.stringify({ [K]: 'nope' })), false);
    assert.equal(await mod.importSettings(JSON.stringify({ [K]: [{ url: '' }] })), false);
    assert.equal(await mod.importSettings(JSON.stringify({ [K]: [{ url: '   ' }] })), false);
    for (const bad of [{ name: {} }, { folder: 5 }, { blurHash: [] }, { fileSize: '10' }, { dimensions: { width: 'x', height: 1 } }, { dimensions: 4 }]) {
      assert.equal(await mod.importSettings(JSON.stringify({ [K]: [{ url: 'https://example.com/a.jpg', ...bad }] })), false, JSON.stringify(bad));
    }
    for (const url of ['data:image/png;base64,%%%', 'data:image/png;base64,AAA', 'data:image/png,%E0%A4%A', 'data:image/png;', 'data:video/mp4,', 'data:image/png;base64,', 'not-a-url', 'data:text/plain,x', 'javascript:alert(1)', 'ftp://a.test/x.png']) {
      assert.equal(await mod.importSettings(JSON.stringify({ [K]: [{ url }] })), false, url);
    }
    mod.db.rows = [{ id: 1, url: 'data:keep' }];
    // links follow the add/edit URL policy
    for (const url of ['javascript:alert(1)', '', 'not a url', 'ftp://a.test']) {
      assert.equal(await mod.importSettings(JSON.stringify({ quicklinks: JSON.stringify([{ name: 'a', url, key: 'k' }]) })), false, url);
      assert.equal(await mod.importSettings(JSON.stringify({ applinks: JSON.stringify([{ name: 'a', url, key: 'k' }]) })), false, url);
    }
    assert.equal(await mod.importSettings(JSON.stringify({ quicklinks: '[{"name":"x"}]' })), false);
    // delete / drag-and-drop identify links by key: it must be present and unique
    assert.equal(await mod.importSettings(JSON.stringify({ quicklinks: '[{"name":"a","url":"https://a.test"}]' })), false);
    assert.equal(await mod.importSettings(JSON.stringify({ applinks: '[{"name":"a","url":"u","key":"k"},{"name":"b","url":"u","key":"k"}]' })), false);
    assert.equal(globalThis.__toasts.length, 55);
    assert.equal(globalThis.__reloads, 0);
    assert.deepEqual(mod.db.rows.map((r) => r.url), ['data:keep'], 'nothing was touched');
    assert.equal(await mod.importSettings(JSON.stringify({
      customEvents: '[]', messages: '["hi"]', applinks: '[{"name":"a","url":"https://a.test","key":"k1"}]', order: '["time"]', todo: '[]', favourite: 'null',
    })), true);
    // colour favourites must parse as a CSS background where the browser can tell
    globalThis.CSS = { supports: (_p, v) => /^(#|rgb|linear-gradient)/.test(v) };
    try {
      assert.equal(await mod.importSettings(JSON.stringify({ favourite: '{"type":"random_colour","url":"not-a-colour"}' })), false);
      assert.equal(await mod.importSettings(JSON.stringify({ favourite: '{"url":"https://img.test/a.jpg","credit":{}}' })), false);
      assert.equal(await mod.importSettings(JSON.stringify({ favourite: '{"url":"https://img.test/a.jpg","blur_hash":[],"hidden":"no"}' })), false);
      assert.equal(await mod.importSettings(JSON.stringify({ favourite: '{"url":"https://img.test/a.jpg","credit":"Ada","colour":"#fff"}' })), true);
      assert.equal(await mod.importSettings(JSON.stringify({ favourite: '{"type":"random_gradient","url":"linear-gradient(red, blue)"}' })), true);
    } finally {
      delete globalThis.CSS;
    }
    for (const tz of ['auto', 'Europe/Istanbul', 'UTC']) {
      assert.equal(await mod.importSettings(JSON.stringify({ timezone: tz })), true, tz);
    }
    for (const ok of ['{"type":"random_colour","url":"#ff00aa"}', '{"url":"https://img.test/a.jpg"}', '{"url":"data:image/png;base64,AA=="}']) {
      assert.equal(await mod.importSettings(JSON.stringify({ favourite: ok })), true, ok);
    }

    // a settings write that fails part-way (quota) rolls back both stores
    {
      const failing = memoryStorage({ theme: 'light', keep: 'me' });
      let writes = 0;
      const realSet = failing.setItem.bind(failing);
      failing.setItem = (k, v) => { if (++writes === 3) throw new DOMException('QuotaExceededError'); realSet(k, v); };
      Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: failing });
      mod.db.rows = [{ id: 1, url: 'data:keep' }];
      globalThis.__toasts = []; globalThis.__reloads = 0;
      const res = await mod.importSettings(JSON.stringify({ theme: 'dark', a: '1', b: '2', [K]: [{ url: 'data:replacement' }] }));
      assert.equal(res, false);
      assert.equal(failing.getItem('theme'), 'light', 'earlier writes are undone');
      assert.equal(failing.getItem('a'), null);
      assert.equal(failing.getItem('keep'), 'me');
      assert.deepEqual(mod.db.rows.map((r) => r.url), ['data:keep'], 'the old gallery is back');
      assert.deepEqual(globalThis.__toasts, ['toasts.error']);
      assert.equal(globalThis.__reloads, 0);
      Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: store });
    }

    // with in-memory storage an import remounts instead of reloading (a reload would drop it)
    {
      globalThis.__events = []; globalThis.__reloads = 0;
      memoryMod.db.rows = [];
      assert.equal(await memoryMod.importSettings(JSON.stringify({ theme: 'sepia' })), true);
      assert.equal(store.getItem('theme'), 'sepia');
      assert.equal(globalThis.__reloads, 0);
      assert.deepEqual(globalThis.__events, ['settingsimported']);
    }

    // an unreadable current gallery aborts instead of being wiped
    mod.db.unreadable = true;
    assert.equal(await mod.importSettings(backup([{ url: 'data:x' }])), false);
    mod.db.unreadable = false;
    assert.deepEqual(mod.db.rows.map((r) => r.url), ['data:keep']);
  } finally {
    globalThis.setTimeout = realTimeout;
    if (realWindow === undefined) delete globalThis.window; else globalThis.window = realWindow;
    if (realLs === undefined) delete globalThis.localStorage;
    else Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: realLs });
  }
});

test('round-25: video remounts per url, migration drops the localStorage copy, Navbar tracks background state', () => {
  const read = (f) => readFileSync(nt(f), 'utf8');
  assert.match(read('features/background/components/BackgroundVideo.jsx'), /key=\{url\}/);
  const db = read('utils/customBackgroundDB.js');
  assert.match(db, /localStorage\.removeItem\('customBackground'\);\s*localStorage\.setItem\('customBackgroundCount'/);
  const nav = read('features/navbar/Navbar.jsx');
  assert.match(nav, /\[backgroundEnabled, setBackgroundEnabled\] = useState/);
  assert.match(nav, /setBackgroundEnabled\(localStorage\.getItem\('background'\) === 'true'\)/);
  assert.doesNotMatch(nav, /const backgroundEnabled = localStorage/);
});

test('a Storage object whose methods throw falls back to in-memory storage', async () => {
  const href = pathToFileURL(nt('lib/storage-namespace.js')).href;
  const realWindow = globalThis.window;
  try {
    const broken = { setItem() { throw new DOMException('QuotaExceededError'); }, getItem() { return null; }, removeItem() {}, key: () => null, length: 0 };
    globalThis.window = { localStorage: broken };
    const mod = await import(`${href}?broken=${Date.now()}`);
    assert.equal(mod.rawStorage, null, 'no persistent storage is claimed');
    const ls = globalThis.window.localStorage;
    ls.setItem('a', 'b');
    assert.equal(ls.getItem('a'), 'b', 'the page still has working (in-memory) settings');

    const working = memoryStorage();
    globalThis.window = { localStorage: working };
    const ok = await import(`${href}?ok=${Date.now()}`);
    assert.equal(ok.rawStorage, working, 'real storage is used when it works');
    assert.equal(working.getItem(`${NAMESPACE_PREFIX}__probe`), null, 'the probe leaves nothing behind');
  } finally {
    if (realWindow === undefined) delete globalThis.window; else globalThis.window = realWindow;
  }
});

test('round-27: document language follows the WebBrain locale; effects wait while maximised; import remount wired', () => {
  const read = (f) => readFileSync(nt(f), 'utf8');
  assert.match(read('boot.jsx'), /applyDocumentLanguage\(\);/);
  assert.doesNotMatch(read('boot.jsx'), /documentElement\.lang = languagecode/);
  const ctx = read('contexts/TranslationContext.jsx');
  assert.doesNotMatch(ctx, /documentElement\.lang = /);
  assert.equal((ctx.match(/applyDocumentLanguage\(\)/g) || []).length, 2);
  assert.match(read('lib/document-language.js'), /WB_STRINGS\[resolved\.lang\] \? resolved : \{ lang: 'en', dir: 'ltr' \}/);
  assert.match(read('features/background/hooks/useBackgroundEvents.js'), /dataset\.bgMaximised === 'true'\) return/);
  assert.match(read('features/navbar/components/Maximise.jsx'), /dataset\.bgMaximised = 'true'/);
  assert.match(read('App.jsx'), /EventBus\.on\('settingsimported', importedHandler\)[\s\S]*EventBus\.off\('settingsimported', importedHandler\)/);
});

test('round-28: migration cleans up partial copies; maximised remounts stay unfiltered; in-memory import reapplies globals; single delete clears selection', () => {
  const read = (f) => readFileSync(nt(f), 'utf8');
  assert.match(read('utils/customBackgroundDB.js'), /await addBackground\(bg\);\s*\}\s*\} catch \(error\) \{\s*try \{\s*await clearAllBackgrounds\(\);/);
  const rend = read('features/background/hooks/useBackgroundRenderer.js');
  assert.match(rend, /isMaximised\(\) \? 'blur\(0px\) brightness\(100%\)'/);
  assert.match(rend, /isMaximised\(\) \? NO_OVERLAY/);
  assert.match(read('App.jsx'), /importedHandler = \(\) => \{\s*loadSettings\(true\);/);
  const custom = read('features/background/options/Custom.jsx');
  assert.match(custom, /syncBackgroundCount\(backgrounds\);\s*\/\/ Selections are array indices[^\n]*\n\s*setSelectedImages\(new Set\(\)\);/);
});

test('round-29: an open dropdown commits the highlighted option on Enter / Space', () => {
  const src = readFileSync(nt('components/Form/Settings/Dropdown/Dropdown.jsx'), 'utf8');
  assert.match(src, /isOpen && focusedIndex >= 0\s*\? props\.items\.filter\(\(i\) => i !== null\)\[focusedIndex\]/);
  assert.match(src, /onChange\(highlighted\.value\)/);
  assert.match(src, /\[isOpen, focusedIndex, onChange, props\.items, props\.disabled\]/);
});

test('round-30: leaving the settings route with Back closes the modal', () => {
  const src = readFileSync(nt('components/Elements/MainModal/Main.jsx'), 'utf8');
  assert.match(src, /else if \(!window\.location\.hash\) \{[^}]*modalClose\?\.\(\);/);
  assert.match(src, /\[modalClose\]\);/);
});

test('round-31: history navigation keeps the breadcrumb in step; breadcrumb click updates the route', () => {
  const read = (f) => readFileSync(nt(f), 'utf8');
  assert.match(read('components/Elements/MainModal/backend/Tabs.jsx'), /onSectionChange\?\.\(label, section\.name, \{ fromHistory: true \}\)/);
  const main = read('components/Elements/MainModal/Main.jsx');
  assert.match(main, /\{ fromHistory = false \} = \{\}/);
  assert.match(main, /if \(fromHistory\) return;/);
  assert.match(read('components/Elements/MainModal/components/ModalTopBar.jsx'), /onSubSectionChange\(null, currentSectionName\)/);
  assert.match(read('utils/settings/import.js'), /quicklinks: isLinkEntry/);
});

test('round-32: closing or normally opening the settings modal drops stale deep-link data', () => {
  const src = readFileSync(nt('features/misc/modals/Modals.jsx'), 'utf8');
  assert.match(src, /setMainModal\(action\);[^}]*setDeepLinkData\(null\);/);
});

test('round-33: tooltip description sits on the focusable control; initial settings sync keeps the deep-link route', () => {
  const read = (f) => readFileSync(nt(f), 'utf8');
  const tip = read('components/Elements/Tooltip/Tooltip.jsx');
  assert.match(tip, /cloneElement\(children, \{ 'aria-describedby': tooltipId \}\)/);
  assert.match(tip, /<span id=\{tooltipId\} role="tooltip"/);
  assert.doesNotMatch(tip, /Math\.random/);
  assert.doesNotMatch(tip, /<div[^>]*aria-describedby/);
  const tabs = read('components/Elements/MainModal/backend/Tabs.jsx');
  assert.match(tabs, /onSectionChange\(currentTab, currentName, \{ fromHistory: true \}\)/);
});

test('round-34: keyed import lists, keyboard sections, named navbar buttons, forward-nav reopen, toast time, close button', () => {
  const read = (f) => readFileSync(nt(f), 'utf8');
  assert.match(read('utils/settings/import.js'), /KEYED_LISTS[\s\S]*share a key/);
  assert.match(read('components/Layout/Settings/Section/Section.jsx'), /role="button"[\s\S]*tabIndex=\{0\}[\s\S]*onKeyDown/);
  assert.match(read('features/navbar/components/Todo.jsx'), /aria-label=\{t\('widgets\.navbar\.todo\.title'\)\}/);
  assert.match(read('features/navbar/components/Apps.jsx'), /aria-label=\{variables\.getMessage\('widgets\.navbar\.apps\.title'\)\}/);
  assert.match(read('features/misc/modals/Modals.jsx'), /addEventListener\('popstate', handlePopState\)/);
  assert.match(read('App.jsx'), /setToastDisplayTime\(parseInt\(localStorage\.getItem\('toastDisplayTime'\)/);
  assert.match(read('components/Elements/MainModal/components/ModalTopBar.jsx'), /<button\s+type="button"\s+className="closeModal"/);
});

test('round-36: reset stops when uploads cannot be cleared', () => {
  const src = readFileSync(nt('components/Elements/ResetModal/ResetModal.jsx'), 'utf8');
  assert.match(src, /catch \(error\) \{[\s\S]*toast\(variables\.getMessage\('toasts\.error'\)\);\s*return;/);
  assert.ok(src.indexOf('return;') < src.indexOf("setDefaultSettings('reset')"));
});

test('round-37: Back to a bare #settings entry shows the default section', () => {
  const read = (f) => readFileSync(nt(f), 'utf8');
  assert.match(read('components/Elements/MainModal/Main.jsx'), /else if \(linkData\) \{[\s\S]*type: 'settings-default'/);
  assert.match(read('components/Elements/MainModal/backend/Tabs.jsx'), /type === 'settings-default'[\s\S]*children\[0\]\?\.props[\s\S]*fromHistory: true/);
});

test('round-37b: a navigation trigger is acted on once, not on every language change', () => {
  const tabs = readFileSync(nt('components/Elements/MainModal/backend/Tabs.jsx'), 'utf8');
  assert.match(tabs, /handledTriggerRef\.current === navigationTrigger\) return;/);
  assert.equal((tabs.match(/handledTriggerRef\.current = navigationTrigger/g) || []).length, 2);
});

test('round-38: imported links are stored normalised; gallery urls must be loadable', async () => {
  const src = readFileSync(nt('utils/settings/import.js'), 'utf8');
  assert.match(src, /normalizeLinks\(content\);/);
  assert.match(src, /data:\(image\|video\)/);
});

test('round-42: background cards and todo checkboxes work from the keyboard; nested dropdown does not open the card', () => {
  const read = (f) => readFileSync(nt(f), 'utf8');
  const card = read('features/background/options/sections/NavigationCard.jsx');
  assert.match(card, /role="button"[\s\S]*tabIndex=\{0\}[\s\S]*onKeyDown/);
  assert.match(card, /event\.stopPropagation\(\)/);
  assert.match(read('components/Layout/Settings/Section/Section.jsx'), /event\.stopPropagation\(\)/);
  const todo = read('features/navbar/components/Todo.jsx');
  assert.match(todo, /role="checkbox"[\s\S]*aria-checked[\s\S]*tabIndex=\{0\}[\s\S]*onKeyDown/);
});

test('round-43: todo delete icon is a keyboard control', () => {
  const todo = readFileSync(nt('features/navbar/components/Todo.jsx'), 'utf8');
  assert.match(todo, /<MdDelete\s+role="button"\s+tabIndex=\{0\}/);
});

test('round-51: handoff records are cleared at browser start, never swept from a snapshot', () => {
  for (const [file, api] of [['src/chrome/src/background.js', 'chrome'], ['src/firefox/src/background.js', 'browser']]) {
    const src = readFileSync(path.join(root, file), 'utf8');
    assert.doesNotMatch(src, /sweepStaleNewtabHandoffs/, file);
    assert.match(src, /onStartup\?\.addListener\?\.\(async \(\) => \{\s*try \{[\s\S]*startedAt - 10_000[\s\S]*startsWith\('wbNewtabHandoff:'\)/, file);
    assert.match(src, /wbNewtabHandoff:retry:\$\{closedTabId\}/, file);
  }
});

test('round-48: dialog close controls work from the keyboard', () => {
  const read = (f) => readFileSync(nt(f), 'utf8');
  for (const f of ['components/Elements/AddModal/AddModal.jsx', 'components/Elements/ResetModal/ResetModal.jsx']) {
    assert.match(read(f), /className="close"\s+role="button"\s+tabIndex=\{0\}[\s\S]*onActivateKey\(/, f);
  }
  assert.match(read('components/Elements/MainModal/components/ReminderInfo.jsx'), /<button\s+type="button"\s+className="closeModal"/);
  assert.match(read('utils/keyboard.js'), /event\.key === 'Enter' \|\| event\.key === ' '/);
});

test('round-52: a video favourite is flagged so it renders as a video', () => {
  const loader = readFileSync(nt('features/background/api/backgroundLoader.js'), 'utf8');
  assert.match(loader, /video: videoCheck\(fav\.url\)/);
});

test('round-53: video detection looks at the lower-cased path of the address', async () => {
  const videoCheck = (await load(nt('features/background/api/videoCheck.js'))).default;
  for (const url of [
    'https://cdn.example/clip.mp4?token=abc', 'https://cdn.example/CLIP.MP4#t=3', 'data:video/mp4;base64,AA==',
    'video/webm', 'https://a.test/x.OGG', 'clip.webm?x=1',
  ]) assert.equal(videoCheck(url), true, url);
  for (const url of ['https://cdn.example/pic.jpg?name=a.mp4', 'https://a.test/mp4', 'data:image/png;base64,AA==', '']) {
    assert.equal(videoCheck(url), false, url);
  }
  const privacy = readFileSync(path.join(root, 'docs/privacy-and-data-flow.md'), 'utf8');
  assert.doesNotMatch(readFileSync(path.join(root, "docs/newtab.md"), "utf8"), /swept each time/);
  assert.doesNotMatch(privacy, /unclaimed\s+records are removed after about three minutes/);
});

test('round-54: a remote picture that fails to load is retried as a video; the composer hold stays under the record age', async () => {
  const read = (f) => readFileSync(nt(f), 'utf8');
  assert.match(read('features/background/hooks/useBackgroundRenderer.js'), /!loaded && \/\^https\?:\/i\.test\(backgroundData\.url\)/);
  assert.match(read('features/background/Background.jsx'), /updateBackground\(\{ video: true \}\)/);
  for (const b of ['chrome', 'firefox']) {
    const mod = await load(path.join(root, `src/${b}/src/ui/newtab-handoff.js`));
    const hold = mod.NEWTAB_HANDOFF_SEND_HOLD_MAX_RETRIES * mod.NEWTAB_HANDOFF_SEND_RETRY_MS;
    assert.ok(hold <= mod.NEWTAB_HANDOFF_MAX_AGE_MS / 2, `${b}: hold ${hold} ms must be well under ${mod.NEWTAB_HANDOFF_MAX_AGE_MS}`);
  }
});

test('round-55: the video fallback also runs when the fade transition is off', () => {
  const src = readFileSync(nt('features/background/hooks/useBackgroundRenderer.js'), 'utf8');
  const skipBranch = src.slice(src.indexOf('if (!hasTransition || prefersReducedMotion)'), src.indexOf('// Create or get overlay element'));
  assert.match(skipBranch, /onRemoteImageFailedRef\.current\?\.\(backgroundData\.url\)/);
});

test('round-58: CSS url() values are quoted and escaped', () => {
  const src = readFileSync(nt('features/background/hooks/useBackgroundRenderer.js'), 'utf8');
  const match = /export const cssUrl = \(url\) =>\n\s+(`[^\n]*`);/.exec(src);
  assert.ok(match, 'cssUrl helper present');
  const cssUrl = new Function('url', `return ${match[1]};`);
  assert.equal(cssUrl('https://host/a.jpg'), 'url("https://host/a.jpg")');
  assert.equal(cssUrl('https://host/image).jpg'), 'url("https://host/image).jpg")');
  assert.equal(cssUrl('a"b\\c'), 'url("a\\"b\\\\c")');
  assert.equal(cssUrl('a\nb'), 'url("a\\a b")');
  assert.doesNotMatch(src, /`url\(\$\{/, 'no raw url(${...}) left');
});

test('round-59: reset actions are keyboard-operable; Dropdown only writes a paired setting it was given', () => {
  const read = (f) => readFileSync(nt(f), 'utf8');
  for (const [f, cls] of [
    ['components/Form/Settings/Slider/Slider.jsx', 'slider-reset'],
    ['components/Form/Settings/Dropdown/Dropdown.jsx', 'dropdown-reset'],
    ['components/Form/Settings/Text/Text.jsx', 'text-field-reset'],
  ]) {
    assert.match(read(f), new RegExp(`className="${cls}"\\s+onClick=\\{resetItem\\}\\s+onKeyDown=\\{onActivateKey\\(resetItem\\)\\}\\s+role="button"\\s+tabIndex=\\{0\\}`), f);
  }
  const dd = read('components/Form/Settings/Dropdown/Dropdown.jsx');
  assert.match(dd, /props\.name2 !== undefined && props\.name2 !== null\) \{\s*localStorage\.setItem\(props\.name2, props\.value2\)/);
});

test('round-63: remaining click-only controls are keyboard-operable', () => {
  const read = (f) => readFileSync(nt(f), 'utf8');
  const time = read('features/time/options/TimeOptions.jsx');
  assert.equal((time.match(/onKeyDown=\{onActivateKey\(\(\) => updateColour\(/g) || []).length, 3);
  assert.equal((time.match(/role="button"\s+tabIndex=\{0\}/g) || []).length >= 3, true);
  assert.match(read('features/background/options/Colour.jsx'), /onKeyDown=\{onActivateKey\(\(\) => resetColour\(\)\)\}\s+role="button"\s+tabIndex=\{0\}/);
  const chips = read('components/Form/Settings/ChipSelect/ChipSelect.jsx');
  assert.match(chips, /className="chipSelect-control"[\s\S]*onKeyDown=\{onActivateKey[\s\S]*role="combobox"[\s\S]*tabIndex=\{0\}/);
  assert.match(chips, /className=\{`chipSelect-option[\s\S]*onKeyDown=\{onActivateKey[\s\S]*role="option"[\s\S]*tabIndex=\{0\}/);
});

test('round-64: a failed gallery write reaches the batch uploader instead of counting as stored', () => {
  const src = readFileSync(nt('features/background/options/Custom.jsx'), 'utf8');
  assert.match(src, /console\.error\('Error saving background:', error\);\s*throw error;/);
  assert.match(src, /error\.name === 'QuotaExceededError'/);
  assert.match(src, /errors\.push\(files\[i\]\.name\)/);
});

test('round-69: the documented hold budget matches the constants', async () => {
  const { NEWTAB_HANDOFF_SEND_RETRY_MS: every, NEWTAB_HANDOFF_SEND_HOLD_MAX_RETRIES: max } =
    await load(path.join(root, 'src/chrome/src/ui/newtab-handoff.js'));
  assert.equal((every * max) / 1000, 15);
  assert.match(readFileSync(path.join(root, 'docs/newtab.md'), 'utf8'), /retried every 150 ms, for up to about 15 s/);
});

test('round-73: icon-only buttons have an accessible name', () => {
  const unnamed = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.jsx')) {
        const src = readFileSync(full, 'utf8');
        for (const m of src.matchAll(/<button\b/g)) {
          let i = m.index + m[0].length;
          let depth = 0;
          for (; i < src.length; i++) {
            const c = src[i];
            if (c === '{') depth++;
            else if (c === '}') depth--;
            else if (c === '>' && depth === 0 && src[i - 1] !== '=') break;
          }
          const tag = src.slice(m.index, i + 1);
          const end = src.indexOf('</button>', i);
          const body = src.slice(i + 1, end).replace(/<Md\w+\s*\/>/g, '').trim();
          if (!body && !/aria-label=/.test(tag)) unnamed.push(`${path.relative(nt(), full)}:${src.slice(0, m.index).split('\n').length}`);
        }
      }
    }
  };
  walk(nt());
  assert.deepEqual(unnamed, [], 'icon-only <button>s need an aria-label');
});

test('round-74: gallery writes resolve only once the IndexedDB transaction has committed', async (t) => {
  let esbuild;
  try {
    esbuild = await import(pathToFileURL(path.join(root, 'newtab/node_modules/esbuild/lib/main.js')).href);
  } catch {
    return t.skip('newtab dependencies are not installed');
  }
  const out = await esbuild.build({
    entryPoints: [nt('utils/customBackgroundDB.js')],
    bundle: true, write: false, format: 'esm', platform: 'node',
  });
  // A tiny IndexedDB: every request "succeeds" a tick after it is made, the transaction settles
  // later, and with failCommit it aborts at that point (storage full) without applying anything.
  const state = { rows: [], next: 1, failCommit: false };
  const later = (fn, ms = 1) => globalThis.setTimeout(fn, ms);
  const makeTx = () => {
    const ops = [];
    const tx = { oncomplete: null, onerror: null, onabort: null, error: null };
    const request = (result, op) => {
      const req = { result: undefined, onsuccess: null, onerror: null };
      if (op) ops.push(op);
      later(() => { req.result = typeof result === 'function' ? result() : result; req.onsuccess?.(); });
      return req;
    };
    const store = {
      add: (data) => { const id = state.next++; return request(id, () => state.rows.push({ ...data, id })); },
      put: (item) => request(item.id, () => { const at = state.rows.findIndex((r) => r.id === item.id); if (at >= 0) state.rows[at] = item; }),
      get: (id) => request(() => { const row = state.rows.find((r) => r.id === id); return row && { ...row }; }),
      getAll: () => request(() => state.rows.map((r) => ({ ...r }))),
      delete: (id) => request(undefined, () => { state.rows = state.rows.filter((r) => r.id !== id); }),
      clear: () => request(undefined, () => { state.rows = []; }),
      count: () => request(() => state.rows.length),
    };
    tx.objectStore = () => store;
    later(() => {
      if (state.failCommit) {
        tx.error = new Error('QuotaExceededError');
        tx.onabort?.();
      } else {
        ops.forEach((op) => op());
        tx.oncomplete?.();
      }
    }, 15);
    return tx;
  };
  const db = { objectStoreNames: { contains: () => true }, transaction: () => makeTx() };
  const realIDB = globalThis.indexedDB;
  Object.defineProperty(globalThis, 'indexedDB', {
    configurable: true,
    value: { open: () => { const req = { result: db, onsuccess: null }; later(() => req.onsuccess?.()); return req; } },
  });
  try {
    const mod = await import(`data:text/javascript;base64,${Buffer.from(out.outputFiles[0].text).toString('base64')}`);
    // committed: the row exists by the time the promise resolves
    const id = await mod.addBackground({ url: 'data:image/png;base64,AAAA', name: 'a' });
    assert.equal(id, 1);
    assert.equal(state.rows.length, 1);
    await mod.updateBackgroundMetadata(1, { name: 'b' });
    assert.equal(state.rows[0].name, 'b');
    // every request succeeds, then the commit aborts: each write reports the failure
    state.failCommit = true;
    await assert.rejects(() => mod.addBackground({ url: 'data:image/png;base64,BBBB', name: 'c' }), /Quota/);
    await assert.rejects(() => mod.deleteBackground(0), /Quota/);
    await assert.rejects(() => mod.deleteMultipleBackgrounds([0]), /Quota/);
    await assert.rejects(() => mod.clearAllBackgrounds(), /Quota/);
    await assert.rejects(() => mod.updateBackgroundMetadata(1, { name: 'z' }), /Quota/);
    await assert.rejects(() => mod.updateBackground(0, { name: 'z' }), /Quota/);
    assert.deepEqual(state.rows.map((r) => r.name), ['b'], 'nothing from the aborted transactions was kept');
    state.failCommit = false;
    await mod.deleteMultipleBackgrounds([0]);
    assert.equal(state.rows.length, 0);
    await assert.rejects(() => mod.updateBackgroundMetadata(99, {}), /not found/);
  } finally {
    if (realIDB === undefined) delete globalThis.indexedDB;
    else Object.defineProperty(globalThis, 'indexedDB', { configurable: true, value: realIDB });
  }
});

test('round-74: gallery selection checkboxes are named', () => {
  const src = readFileSync(nt('features/background/options/Custom.jsx'), 'utf8');
  assert.match(src, /onChange=\{\(\) => toggleImageSelection\(originalIndex\)\}\s+aria-label=\{bg\.name \|\| `\$\{originalIndex \+ 1\}`\}/);
});

test('round-76: Act warns that it starts immediately, in every shipped language', () => {
  const box = readFileSync(nt('features/agent/TaskBox.jsx'), 'utf8');
  assert.match(box, /mode === 'act' && \(\s*<span className="taskBoxHint taskBoxWarning" role="note">\s*\{wbT\('wb\.act_hint'\)\}/);
  const strings = readFileSync(nt('lib/wb-strings.js'), 'utf8');
  assert.doesNotMatch(strings, /Press Enter there to run it|Pulsa Intro allí/);
  assert.equal((strings.match(/^    "[^"]*(?:Enter|Intro|Entrée|Eingabetaste)[^"]*",$/gm) || []).length >= 15, true);
  const h = readFileSync(path.join(root, 'src/chrome/src/ui/newtab-handoff.js'), 'utf8');
  assert.doesNotMatch(h, /handoff\.mode === 'ask' && !getIsBlocked/);
});

test('round-77: a queued handoff keeps the mode pinned by the new tab until it is sent', () => {
  for (const browser of ['chrome', 'firefox']) {
    const src = readFileSync(path.join(root, 'src', browser, 'src/ui/sidepanel.js'), 'utf8');
    assert.match(src, /function enqueueQueuedComposerMessage\(tabId, text, mode = null\)/, browser);
    assert.match(src, /text: queuedText,[\s\S]{0,260}\.\.\.\(\['ask', 'act', 'dev'\]\.includes\(mode\) \? \{ mode \} : \{\}\)/, browser);
    assert.match(src, /return enqueueQueuedComposerMessage\(tabId, text, modeOverride\);/, browser);
    assert.match(src, /__queuedComposerMessage: submission,\s*\.\.\.\(item\.mode \? \{ __mode: item\.mode \} : \{\}\)/, browser);
  }
});

test('round-78: Act handoffs use the panel eligibility check; file inputs are cleared after a selection', () => {
  for (const browser of ['chrome', 'firefox']) {
    const src = readFileSync(path.join(root, 'src', browser, 'src/ui/sidepanel.js'), 'utf8');
    assert.match(src, /setMode,\s*ensureActMode,\s*getInputEl: \(\) => inputEl/, browser);
  }
  const upload = readFileSync(nt('components/Form/Settings/FileUpload/FileUpload.jsx'), 'utf8');
  assert.match(upload, /const files = Array\.from\(e\.target\.files\);[\s\S]*e\.target\.value = '';\s*if \(files\.length === 0\) return;/);
});

test('round-80: a new background replaces the photo metadata; custom CSS and font are inserted as text', async (t) => {
  let esbuild;
  try {
    esbuild = await import(pathToFileURL(path.join(root, 'newtab/node_modules/esbuild/lib/main.js')).href);
  } catch {
    return t.skip('newtab dependencies are not installed');
  }
  const out = await esbuild.build({
    entryPoints: [nt('features/background/hooks/useBackgroundState.js')],
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'node',
    plugins: [
      {
        name: 'fake-react',
        setup(build) {
          build.onResolve({ filter: /^react$/ }, () => ({ path: 'react', namespace: 'fake' }));
          build.onLoad({ filter: /.*/, namespace: 'fake' }, () => ({
            contents: `
              let state;
              export const useState = (init) => { if (state === undefined) state = init; return [state, (v) => { state = typeof v === 'function' ? v(state) : v; }]; };
              export const useCallback = (fn) => fn;
              export const current = () => state;
            `,
            loader: 'js',
          }));
        },
      },
    ],
  });
  const code = `data:text/javascript;base64,${Buffer.from(out.outputFiles[0].text).toString('base64')}`;
  const { useBackgroundState } = await import(code);
  const hook = useBackgroundState();
  hook.resetBackground();
  hook.updateBackground({ url: 'a.jpg', photoInfo: { offline: true, credit: 'Someone' } });
  // The reset's `hidden: true` must not survive into the new background.
  const refreshed = useBackgroundState().backgroundData;
  assert.deepEqual(refreshed.photoInfo, { offline: true, credit: 'Someone' });
  // An update without metadata keeps the current metadata.
  hook.updateBackground({ video: true });
  assert.deepEqual(useBackgroundState().backgroundData.photoInfo, { offline: true, credit: 'Someone' });

  const load = readFileSync(nt('utils/settings/load.js'), 'utf8');
  assert.doesNotMatch(load, /insertAdjacentHTML/);
  assert.match(load, /customStyle\.textContent = css;/);
  assert.match(load, /fontStyle\.textContent = /);
});

test('round-82: the Apps popup reads one appsPinned key everywhere', () => {
  const apps = readFileSync(nt('features/navbar/components/Apps.jsx'), 'utf8');
  assert.doesNotMatch(apps, /AppsPinned/);
  assert.equal((apps.match(/getItem\('appsPinned'\)/g) || []).length, 3);
});

test('round-83: ensureActMode can answer eligibility without switching the panel mode', () => {
  for (const browser of ['chrome', 'firefox']) {
    const src = readFileSync(path.join(root, 'src', browser, 'src/ui/sidepanel.js'), 'utf8');
    assert.match(src, /async function ensureActMode\(\{ switchMode = true \} = \{\}\)[\s\S]*?setMode\('act'\);/, browser);
  }
  const chrome = readFileSync(path.join(root, 'src', 'chrome', 'src/ui/sidepanel.js'), 'utf8');
  // already in Act: the eligibility query still looks at the provider (WebGPU is Ask-only)
  assert.match(chrome, /if \(agentMode === 'act' && switchMode\) return true;\s*if \(await inBrowserProviderBlocksMode\(\)\) return false;/);
});

test('round-85: the handoff module contract says Act is sent immediately', () => {
  const src = readFileSync(path.join(root, 'src', 'chrome', 'src/ui/newtab-handoff.js'), 'utf8');
  assert.doesNotMatch(src, /Act always needs the user's own Enter/);
  assert.match(src, /Ask and Act: the task is filled in and sent straight away/);
});

test('round-85: inactive settings are inert, dialogs hide the page from assistive technology, the producer contract matches', () => {
  const wrapper = readFileSync(nt('components/Layout/Settings/PreferencesWrapper/PreferencesWrapper.jsx'), 'utf8');
  assert.match(wrapper, /className=\{shown \? 'preferences' : 'preferencesInactive'\} inert=\{!shown\}/);
  const files = [
    'features/misc/modals/Modals.jsx',
    'features/misc/sections/Advanced.jsx',
    'features/background/options/Custom.jsx',
    'features/navbar/options/AppsOptions.jsx',
    'features/quicklinks/options/QuickLinksOptions.jsx',
  ];
  for (const f of files) {
    const src = readFileSync(nt(f), 'utf8');
    if (f.endsWith('Modals.jsx')) {
      // the parent dialog hides the page...
      assert.doesNotMatch(src, /ariaHideApp=\{false\}/, f);
      assert.match(src, /appElement=\{pageElement\(\)\}/, f);
    } else {
      // ...nested ones must not touch it (react-modal's close would un-hide it under the parent)
      assert.match(src, /ariaHideApp=\{false\}/, f);
      assert.doesNotMatch(src, /appElement=/, f);
      assert.match(src, /aria=\{\{ modal: true \}\}/, f);
    }
  }
  const handoff = readFileSync(nt('features/agent/handoff.js'), 'utf8');
  assert.doesNotMatch(handoff, /does NOT send|user always confirms an Act run/);
  assert.match(handoff, /Ask and Act: fills the composer and sends straight away/);
});

test('opt-in: the new tab hands the tab to the browser unless newTabEnabled is true', async (t) => {
  let esbuild;
  try {
    esbuild = await import(pathToFileURL(path.join(root, 'newtab/node_modules/esbuild/lib/main.js')).href);
  } catch {
    return t.skip('newtab dependencies are not installed');
  }
  const out = await esbuild.build({ entryPoints: [nt('lib/gate.js')], bundle: true, write: false, format: 'esm', platform: 'node' });
  const gate = await import(`data:text/javascript;base64,${Buffer.from(out.outputFiles[0].text).toString('base64')}`);
  assert.equal(gate.NEWTAB_ENABLED_KEY, 'newTabEnabled');

  const makeApi = ({ stored = {}, tab = { id: 7 }, failStorage = false, failUpdate = false } = {}) => {
    const calls = [];
    return {
      calls,
      storage: { local: { get: async (key) => { calls.push(['get', key]); if (failStorage) throw new Error('storage'); return stored; } } },
      tabs: {
        getCurrent: async () => tab,
        update: async (id, props) => { calls.push(['update', id, props]); if (failUpdate) throw new Error('blocked'); },
      },
    };
  };
  const chromeEnv = (opts) => { const api = makeApi(opts); return { env: { chrome: { runtime: { id: 'x' }, ...api } }, calls: api.calls }; };

  // never asked / declined / anything that is not exactly true: hand the tab over
  for (const stored of [{}, { newTabEnabled: false }, { newTabEnabled: 'true' }, { newTabEnabled: 1 }, { newTabEnabled: null }]) {
    const { env, calls } = chromeEnv({ stored });
    assert.equal(await gate.shouldShowWebBrainNewTab(env), false, JSON.stringify(stored));
    assert.deepEqual(calls.filter((c) => c[0] === 'update'), [['update', 7, { url: 'chrome://new-tab-page/' }]]);
  }
  // opted in: render, and never touch the tab
  const on = chromeEnv({ stored: { newTabEnabled: true } });
  assert.equal(await gate.shouldShowWebBrainNewTab(on.env), true);
  assert.deepEqual(on.calls.filter((c) => c[0] === 'update'), []);
  // Edge does not serve chrome://new-tab-page/, so it gets its own fallback (by brand or by UA)
  for (const navigator of [
    { userAgentData: { brands: [{ brand: 'Chromium' }, { brand: 'Microsoft Edge' }] }, userAgent: 'x' },
    { userAgent: 'Mozilla/5.0 AppleWebKit/537.36 Chrome/141.0 Safari/537.36 Edg/141.0.0.0' },
  ]) {
    const edge = chromeEnv();
    edge.env.navigator = navigator;
    assert.equal(await gate.shouldShowWebBrainNewTab(edge.env), false);
    assert.deepEqual(edge.calls.filter((c) => c[0] === 'update'), [['update', 7, { url: 'chrome-search://local-ntp/local-ntp.html' }]]);
  }
  const chromeUa = chromeEnv();
  chromeUa.env.navigator = { userAgentData: { brands: [{ brand: 'Google Chrome' }] }, userAgent: 'Mozilla/5.0 Chrome/141.0 Safari/537.36' };
  assert.equal(await gate.shouldShowWebBrainNewTab(chromeUa.env), false);
  assert.deepEqual(chromeUa.calls.filter((c) => c[0] === 'update'), [['update', 7, { url: 'chrome://new-tab-page/' }]]);
  // Firefox cannot load its own new tab page (about:home / about:newtab are "Illegal URL"), so
  // there is nothing to hand over to: the page is never redirected and storage is never read
  const ffApi = makeApi();
  assert.equal(await gate.shouldShowWebBrainNewTab({ browser: { sidebarAction: { open() {} }, ...ffApi } }), true);
  assert.deepEqual(ffApi.calls, []);
  // it fails towards showing a page, never a blank tab
  assert.equal(await gate.shouldShowWebBrainNewTab({}), true, 'no extension APIs (dev preview)');
  assert.equal(await gate.shouldShowWebBrainNewTab(chromeEnv({ failStorage: true }).env), true, 'unreadable storage');
  assert.equal(await gate.shouldShowWebBrainNewTab(chromeEnv({ failUpdate: true }).env), true, 'redirect refused');
  assert.equal(await gate.shouldShowWebBrainNewTab(chromeEnv({ tab: null }).env), true, 'no current tab');

  // the gate runs before the app is even loaded, and the app keeps its own first import
  const entry = readFileSync(nt('index.jsx'), 'utf8');
  assert.match(entry, /shouldShowWebBrainNewTab\(\)\.then\(\(show\) => \{\s*if \(show\) return import\('\.\/boot'\);/);
  assert.doesNotMatch(entry, /from '\.\/App'/);
  assert.match(readFileSync(nt('boot.jsx'), 'utf8'), /^\/\/[^\n]*\n\/\/[^\n]*\nimport 'lib\/storage-namespace';/);
});

test('opt-in: onboarding offers the new tab (ticked by default) and Settings can change it; Firefox has no switch', async () => {
  const expected = 'en zh ar bn nl tl fr de he hi id ja ko ms fa pl pt ru es th tr uk vi'.split(' ');
  const ui = (browser, f) => readFileSync(path.join(root, 'src', browser, 'src/ui', f), 'utf8');
  const browser = 'chrome';
  const html = ui(browser, 'sidepanel.html');
  // on the last onboarding step (the one with Help Improve WebBrain), ticked by default
  const lastStep = html.slice(html.indexOf('data-step="2"'));
  assert.match(lastStep, /id="ob-newtab-checkbox"[^>]*\schecked>/);
  assert.ok(lastStep.indexOf('ob-help-improve-checkbox') < lastStep.indexOf('ob-newtab-checkbox'), 'next to Help Improve');
  assert.match(html, /data-i18n="st\.display\.newtab\.desc"/);
  // written with onboardingComplete, whichever way onboarding is left
  const js = ui(browser, 'sidepanel.js');
  assert.match(js, /chrome\.storage\.local\.set\(\{\s*onboardingComplete: true,\s*\.\.\.\(newTabCheckbox \? \{ newTabEnabled: newTabCheckbox\.checked \} : \{\}\),\s*\}\)/);
  assert.equal((js.match(/onboardingComplete: true/g) || []).length, 1, 'one exit path');
  // Settings: off until chosen, saved on change
  assert.match(ui(browser, 'settings.html'), /id="toggle-newtab"/);
  const settings = ui(browser, 'settings.js');
  assert.match(settings, /newTabToggle\.checked = stored\.newTabEnabled === true/);
  assert.match(settings, /newTabToggle\?\.addEventListener\('change'[\s\S]*?chrome\.storage\.local\.set\(\{ newTabEnabled: newTabToggle\.checked \}\)/);
  // translated everywhere
  for (const code of expected) {
    const dict = (await import(pathToFileURL(path.join(root, 'src', browser, 'src/ui/locales', `${code}.js`)).href)).default;
    assert.ok(String(dict['st.display.newtab.label'] || '').trim(), `${code} label`);
    assert.ok(String(dict['st.display.newtab.desc'] || '').trim(), `${code} desc`);
  }
  // Firefox cannot hand a tab to its own new tab page, so it has no in-extension switch (the new
  // tab stays on; users change it in Firefox's own settings)
  for (const f of ['sidepanel.html', 'sidepanel.js', 'settings.html', 'settings.js']) {
    assert.doesNotMatch(ui('firefox', f), /newTabEnabled|newtab-checkbox|toggle-newtab/, `firefox ${f}`);
  }
  assert.doesNotMatch(readFileSync(path.join(root, 'src/firefox/src/ui/locales/en.js'), 'utf8'), /st\.display\.newtab/);
});



// ---------------------------------------------------------------------------
// WebBrain bulletin under the task box (newtab/src/features/bulletin)
// ---------------------------------------------------------------------------
const bulletin = await load(nt('features/bulletin/bulletin.js'));

function bulletinResponse(body, { url = 'https://webbrain.one/newtab-comm.html', ok = true, length = null } = {}) {
  return {
    ok,
    url,
    headers: { get: (name) => (name.toLowerCase() === 'content-length' && length != null ? String(length) : null) },
    text: async () => body,
  };
}

function bulletinStore(seed = {}) {
  const data = { ...seed };
  return {
    data,
    async get(keys) { return Object.fromEntries([].concat(keys).filter((k) => k in data).map((k) => [k, data[k]])); },
    async set(values) { Object.assign(data, values); },
  };
}

const extensionPage = { protocol: 'chrome-extension:', hostname: 'abc', origin: 'chrome-extension://abc', search: '' };

test('bulletin: the published file is newtab-comm.html on webbrain.one, with a placeholder preview', () => {
  assert.equal(bulletin.bulletinUrl(extensionPage).href, 'https://webbrain.one/newtab-comm.html');
  assert.equal(bulletin.bulletinUrl({ ...extensionPage, search: '?newtab-comm=placeholder' }).href,
    'https://webbrain.one/newtab-comm-placeholder.html');
  // A local preview of the web site reads its own copy, like apocalypse-comm.js.
  const local = { protocol: 'http:', hostname: '127.0.0.1', origin: 'http://127.0.0.1:4173', search: '' };
  assert.equal(bulletin.bulletinUrl(local).href, 'http://127.0.0.1:4173/newtab-comm.html');
});

test('bulletin: empty and comment-only markup renders nothing, exactly like the Apocalypse bulletin', async () => {
  const apocalypse = await load(path.join(root, 'src/chrome/src/ui/apocalypse-comm.js'));
  const inputs = ['', ' \t\r\n ﻿', '<!DOCTYPE html>', '<!-- reserved -->', '﻿<!doctype html>\n<!--a--><!--b-->',
    'text', '<p>Notice</p>', '<!--unterminated', '<!doctype html', '<!-->visible', 'x'.repeat(128_000), 'x'.repeat(128_001)];
  for (const input of inputs) {
    assert.equal(bulletin.isRenderableMarkup(input), apocalypse.isRenderableMarkup(input), JSON.stringify(input.slice(0, 40)));
  }
  for (const value of [null, undefined, {}, 0]) assert.equal(bulletin.isRenderableMarkup(value), false);
});

test('bulletin: the shipped file is empty and the placeholder is a self-contained sample', () => {
  const shipped = readFileSync(path.join(root, 'web/newtab-comm.html'), 'utf8');
  assert.equal(bulletin.isRenderableMarkup(shipped), false, 'the new tab bulletin must ship switched off');
  const sample = readFileSync(path.join(root, 'web/newtab-comm-placeholder.html'), 'utf8');
  assert.equal(bulletin.isRenderableMarkup(sample), true);
  assert.doesNotMatch(sample, /<script|https?:\/\//i, 'the sample stays script-free and self-contained');
  assert.ok(Buffer.byteLength(sample) <= bulletin.MAX_BULLETIN_BYTES);
});

test('bulletin: one private request, accepted only from webbrain.one and within the size cap', async () => {
  const url = new URL('https://webbrain.one/newtab-comm.html');
  let options;
  const ok = await bulletin.fetchBulletin(url, { fetchImpl: async (href, init) => { options = init; return bulletinResponse('<p>Hi</p>'); } });
  assert.deepEqual(ok, { ok: true, url: 'https://webbrain.one/newtab-comm.html', markup: '<p>Hi</p>' });
  assert.equal(options.credentials, 'omit');
  assert.equal(options.referrerPolicy, 'no-referrer');
  assert.equal(options.cache, 'no-store');
  const www = await bulletin.fetchBulletin(url, { fetchImpl: async () => bulletinResponse('<p>Hi</p>', { url: 'https://www.webbrain.one/newtab-comm.html' }) });
  assert.equal(www.ok, true);
  for (const response of [
    bulletinResponse('<p>x</p>', { url: 'https://evil.example/newtab-comm.html' }),
    bulletinResponse('<p>x</p>', { url: 'http://webbrain.one/newtab-comm.html' }),
    bulletinResponse('<p>x</p>', { ok: false }),
    bulletinResponse('<p>x</p>', { length: 128_001 }),
    bulletinResponse('x'.repeat(128_001)),
    bulletinResponse('€'.repeat(65_000)),
  ]) {
    assert.deepEqual(await bulletin.fetchBulletin(url, { fetchImpl: async () => response }), { ok: false });
  }

  // Stream reader cancellation when stream exceeds byte limit
  let streamCancelled = false;
  const chunkedStreamResponse = {
    ok: true,
    url: 'https://webbrain.one/newtab-comm.html',
    body: {
      getReader() {
        let chunkCount = 0;
        return {
          async read() {
            chunkCount++;
            if (chunkCount > 3) return { done: true, value: undefined };
            return { done: false, value: new Uint8Array(50_000) };
          },
          async cancel() {
            streamCancelled = true;
          },
          releaseLock() {},
        };
      },
    },
  };
  assert.deepEqual(await bulletin.fetchBulletin(url, { fetchImpl: async () => chunkedStreamResponse }), { ok: false });
  assert.equal(streamCancelled, true, 'stream reader must be cancelled when byte limit exceeded');

  // Valid stream reader reading
  const validStreamResponse = {
    ok: true,
    url: 'https://webbrain.one/newtab-comm.html',
    body: {
      getReader() {
        let readOnce = false;
        return {
          async read() {
            if (readOnce) return { done: true, value: undefined };
            readOnce = true;
            return { done: false, value: new TextEncoder().encode('<p>Valid Stream</p>') };
          },
          async cancel() {},
          releaseLock() {},
        };
      },
    },
  };
  assert.deepEqual(await bulletin.fetchBulletin(url, { fetchImpl: async () => validStreamResponse }),
    { ok: true, url: 'https://webbrain.one/newtab-comm.html', markup: '<p>Valid Stream</p>' });

  assert.deepEqual(await bulletin.fetchBulletin(url, { fetchImpl: async () => { throw new TypeError('offline'); } }), { ok: false });
  assert.deepEqual(await bulletin.fetchBulletin(url, { fetchImpl: async () => bulletinResponse('  <!-- off -->') }),
    { ok: true, url: 'https://webbrain.one/newtab-comm.html', markup: '' });
});

test('bulletin: a request at most every ten minutes, with the answer cached in extension storage', async () => {
  const storage = bulletinStore();
  let calls = 0;
  let body = '';
  let clock = 1_000_000;
  const run = () => bulletin.loadBulletin({
    storage, location: extensionPage, now: () => clock,
    fetchImpl: async () => { calls++; return bulletinResponse(body); },
  });
  assert.equal(await run(), null, 'empty file: nothing shown');
  assert.equal(calls, 1);
  body = '<p>Storm warning</p>';
  clock += bulletin.BULLETIN_REFRESH_MS - 1;
  assert.equal(await run(), null, 'still the cached empty answer');
  assert.equal(calls, 1, 'no request inside the interval');
  clock += 1;
  const shown = await run();
  assert.equal(calls, 2);
  assert.equal(shown.markup, '<p>Storm warning</p>');
  assert.equal(shown.url, 'https://webbrain.one/newtab-comm.html');
  assert.equal(shown.hash, bulletin.bulletinHash('<p>Storm warning</p>'));
  assert.equal((await run()).markup, '<p>Storm warning</p>', 'served from the cache');
  assert.equal(calls, 2);
  assert.deepEqual(Object.keys(storage.data).sort(), [bulletin.BULLETIN_CACHE_KEY]);
});

test('bulletin: an unreachable file keeps the last bulletin for a day, then drops it', async () => {
  const storage = bulletinStore();
  let clock = 5_000_000;
  let online = true;
  const run = () => bulletin.loadBulletin({
    storage, location: extensionPage, now: () => clock,
    fetchImpl: async () => { if (!online) throw new TypeError('offline'); return bulletinResponse('<p>Evacuate</p>'); },
  });
  assert.ok(await run());
  online = false;
  clock += bulletin.BULLETIN_REFRESH_MS;
  assert.equal((await run())?.markup, '<p>Evacuate</p>', 'kept while the network is down');
  clock += bulletin.BULLETIN_STALE_LIMIT_MS;
  assert.equal(await run(), null, 'not shown forever');
  const checkedAt = storage.data[bulletin.BULLETIN_CACHE_KEY].checkedAt;
  assert.equal(checkedAt, clock, 'a failed check still waits a full interval before the next request');
});

test('bulletin: dismissing hides that bulletin on every new tab, but a new one shows', async () => {
  const storage = bulletinStore();
  let body = '<p>First</p>';
  let clock = 9_000_000;
  const run = () => bulletin.loadBulletin({ storage, location: extensionPage, now: () => clock, fetchImpl: async () => bulletinResponse(body) });
  const first = await run();
  await bulletin.dismissBulletin(first.hash, storage);
  assert.equal(storage.data[bulletin.BULLETIN_DISMISSED_KEY], first.hash);
  assert.equal(await run(), null);
  body = '<p>Second</p>';
  clock += bulletin.BULLETIN_REFRESH_MS;
  assert.equal((await run())?.markup, '<p>Second</p>');
});

test('bulletin: previews read the file afresh and never touch the cache', async () => {
  const storage = bulletinStore();
  let requested;
  const shown = await bulletin.loadBulletin({
    storage,
    location: { ...extensionPage, search: '?newtab-comm=placeholder' },
    fetchImpl: async (href) => { requested = href; return bulletinResponse('<p>Sample</p>', { url: href }); },
  });
  assert.equal(requested, 'https://webbrain.one/newtab-comm-placeholder.html');
  assert.equal(shown.markup, '<p>Sample</p>');
  assert.deepEqual(storage.data, {});
});

test('bulletin: never throws, even with broken storage or no fetch', async () => {
  const broken = { get: async () => { throw new Error('quota'); }, set: async () => { throw new Error('quota'); } };
  assert.equal(await bulletin.loadBulletin({ storage: broken, location: extensionPage, fetchImpl: undefined }), null);
  const shown = await bulletin.loadBulletin({ storage: broken, location: extensionPage, fetchImpl: async () => bulletinResponse('<p>x</p>') });
  assert.equal(shown?.markup, '<p>x</p>');
  await bulletin.dismissBulletin('abc', broken);
  assert.equal(bulletin.bulletinStorage({}), null);
});

test('bulletin: the frame keeps relative links on webbrain.one, injects a restrictive CSP, and cannot run scripts', () => {
  const framed = bulletin.bulletinDocument('<head></head><p>Hi</p>', new URL('https://webbrain.one/newtab-comm.html'));
  assert.match(framed, /^<base href="https:\/\/webbrain\.one\/newtab-comm\.html" target="_blank"><meta name="referrer" content="no-referrer"><meta http-equiv="Content-Security-Policy" content="[^"]*"><head><\/head><p>Hi<\/p>$/);
  assert.match(framed, /default-src 'none'/);
  assert.match(framed, /style-src 'unsafe-inline'/);
  assert.match(framed, /img-src data:/);
  // A `<head>` token the publisher hides in a comment, attribute or doctype must not receive the policy.
  const base = new URL('https://webbrain.one/newtab-comm.html');
  for (const hostile of [
    '<!-- <head> --><img src="https://evil.example/pixel">',
    '<!-- <HEAD lang="x"> --><head></head><img src="https://evil.example/pixel">',
    '<!doctype html public "x><head>" "y"><img src="https://evil.example/pixel">',
    '<p title="<head>"><img src="https://evil.example/pixel">',
  ]) {
    const doc = bulletin.bulletinDocument(hostile, base);
    assert.ok(doc.startsWith('<base '), `controls come first: ${hostile}`);
    assert.equal(doc.indexOf('Content-Security-Policy'), doc.lastIndexOf('Content-Security-Policy'), 'policy injected exactly once');
    assert.ok(doc.indexOf('Content-Security-Policy') < doc.indexOf('evil.example'), hostile);
  }
  const headless = bulletin.bulletinDocument('<p>Hi</p>', new URL('https://webbrain.one/newtab-comm.html'));
  assert.match(headless, /^<base href="https:\/\/webbrain\.one\/newtab-comm\.html" target="_blank"><meta name="referrer" content="no-referrer"><meta http-equiv="Content-Security-Policy" content="[^"]*"><p>Hi<\/p>/);
  const view = readFileSync(nt('features/bulletin/Bulletin.jsx'), 'utf8');
  const sandbox = view.match(/sandbox="([^"]*)"/)?.[1];
  assert.equal(sandbox, 'allow-popups allow-popups-to-escape-sandbox');
  assert.match(view, /srcDoc=\{bulletinDocument\(/, 'markup goes in through srcdoc, never by framing webbrain.one');
  assert.doesNotMatch(view, /\bsrc=\{/);
  // Under the task box, rendered whether or not the box is shown.
  const widgets = readFileSync(nt('features/misc/views/Widgets.jsx'), 'utf8');
  assert.match(widgets, /\{enabled\('taskBox'\) && <TaskBox \/>\}\s*\{\/\*[^*]*\*\/\}\s*<Bulletin \/>/);
});

test('bulletin: concurrent new tabs coordinate refreshes so only one request is sent', async () => {
  const storage = bulletinStore();
  let calls = 0;
  const run = () => bulletin.loadBulletin({
    storage,
    location: extensionPage,
    fetchImpl: async () => {
      calls++;
      await new Promise((r) => setTimeout(r, 20));
      return bulletinResponse('<p>Coordinated</p>');
    },
  });
  const [tab1, tab2, tab3] = await Promise.all([run(), run(), run()]);
  assert.equal(calls, 1, 'only one request across concurrent tabs');
  assert.equal(tab1?.markup, '<p>Coordinated</p>');
  assert.equal(tab2?.markup, '<p>Coordinated</p>');
  assert.equal(tab3?.markup, '<p>Coordinated</p>');
});

test('bulletin: out-of-order completions do not overwrite a newer successful cache', async () => {
  const storage = bulletinStore();
  let clock = 100_000;
  // An older fetch starts at 100_000
  const res = await bulletin.loadBulletin({
    storage,
    location: extensionPage,
    now: () => clock,
    fetchImpl: async () => {
      // While this fetch was in flight, another tab finished a newer fetch and stored it
      storage.data[bulletin.BULLETIN_CACHE_KEY] = {
        checkedAt: 150_000,
        fetchedAt: 150_000,
        url: 'https://webbrain.one/newtab-comm.html',
        markup: '<p>Newer</p>',
      };
      return bulletinResponse('<p>Older</p>');
    },
  });
  assert.equal(res?.markup, '<p>Newer</p>', 'newer cache entry is preserved');
  assert.equal(storage.data[bulletin.BULLETIN_CACHE_KEY].markup, '<p>Newer</p>');
});

test('bulletin: both built new tabs carry the same bulletin code', () => {
  const assets = (b) => path.join(root, 'src', b, 'newtab', 'assets');
  const withBulletin = (b) => readdirSync(assets(b)).filter((f) => f.endsWith('.js')
    && readFileSync(path.join(assets(b), f), 'utf8').includes('newtab-comm.html'));
  const chrome = withBulletin('chrome');
  assert.equal(chrome.length, 1, 'the bulletin is bundled once');
  assert.deepEqual(withBulletin('firefox'), chrome);
  assert.equal(readFileSync(path.join(assets('chrome'), chrome[0]), 'utf8'), readFileSync(path.join(assets('firefox'), chrome[0]), 'utf8'));
});

// ---------------------------------------------------------------------------
// WebBrain Companion invitation in the bulletin slot (newtab/src/features/companion)
// ---------------------------------------------------------------------------
const companionPromo = await load(nt('features/companion/companion-promo.js'));

test('companion banner: hidden once a Companion provider has a model, shown before that', () => {
  const { hasCompanionProvider } = companionPromo;
  assert.equal(hasCompanionProvider(undefined), false);
  assert.equal(hasCompanionProvider({}), false);
  // The default card ships with no model: not set up yet.
  assert.equal(hasCompanionProvider({ webbrain_companion: { baseUrl: 'http://127.0.0.1:8327/v1', model: '' } }), false);
  assert.equal(hasCompanionProvider({ webbrain_companion: { model: '   ' } }), false);
  assert.equal(hasCompanionProvider({ webbrain_companion: { model: 'claude-haiku-5-5' } }), true);
  // A duplicated card counts; another provider with a model does not.
  assert.equal(hasCompanionProvider({ webbrain_companion_2: { duplicateOf: 'webbrain_companion', model: 'luna-6.1' } }), true);
  assert.equal(hasCompanionProvider({ openai: { model: 'gpt-6' }, local_openai_proxy: { model: 'x' } }), false);
});

test('companion banner: storage decides, a dismissal sticks, unreadable storage hides it', async () => {
  const { shouldShowCompanionPromo, dismissCompanionPromo, COMPANION_PROMO_DISMISSED_KEY } = companionPromo;
  const store = bulletinStore({ providers: { webbrain_companion: { model: '' } } });
  assert.equal(await shouldShowCompanionPromo(store), true);
  await dismissCompanionPromo(store);
  assert.ok(Number.isFinite(store.data[COMPANION_PROMO_DISMISSED_KEY]));
  assert.equal(await shouldShowCompanionPromo(store), false);
  assert.equal(await shouldShowCompanionPromo(bulletinStore({ providers: { webbrain_companion: { model: 'kimi-k3' } } })), false);
  assert.equal(await shouldShowCompanionPromo({ get: async () => { throw new Error('denied'); }, set: async () => {} }), false);
  // A plain preview page has no extension storage and shows it.
  assert.equal(await shouldShowCompanionPromo(null), true);
  // Dismissing without storage, or with storage that throws, never throws.
  await dismissCompanionPromo(null);
  await dismissCompanionPromo({ get: async () => ({}), set: async () => { throw new Error('quota'); } });
});

test('companion banner: links to the companion page in the WebBrain language when it is translated', () => {
  const { companionPageUrl, COMPANION_PAGE } = companionPromo;
  assert.equal(COMPANION_PAGE, 'https://www.webbrain.one/companion/');
  assert.equal(companionPageUrl('en'), COMPANION_PAGE);
  assert.equal(companionPageUrl('tr'), 'https://www.webbrain.one/companion/tr/');
  assert.equal(companionPageUrl('zh_CN'), 'https://www.webbrain.one/companion/zh/');
  // Polish has no companion page yet; unknown or empty values fall back to English.
  assert.equal(companionPageUrl('pl'), COMPANION_PAGE);
  assert.equal(companionPageUrl(''), COMPANION_PAGE);
  // Every translated page the link can point at exists in the site.
  for (const code of 'ar bn de es fa fr he hi id ja ko ms nl pt ru th tl tr uk vi zh'.split(' ')) {
    assert.ok(existsSync(path.join(root, 'web', 'companion', code, 'index.html')), code);
    assert.equal(companionPageUrl(code), `${COMPANION_PAGE}${code}/`);
  }
});

test('companion banner: every plan has a mark and it shows only where no bulletin is shown', () => {
  const view = readFileSync(nt('features/companion/CompanionPromo.jsx'), 'utf8');
  for (const plan of companionPromo.PLANS) {
    assert.ok(existsSync(nt('assets', 'providers', `${plan.logo}.svg`)), plan.logo);
    assert.ok(view.includes(`${plan.logo}: ${plan.logo}Logo`), `${plan.logo} is wired into LOGOS`);
    // The marks are shown as <img>, where currentColor would always be black.
    assert.doesNotMatch(readFileSync(nt('assets', 'providers', `${plan.logo}.svg`), 'utf8'), /currentColor/);
  }
  // The bulletin slot under the task box shows it once the bulletin check found nothing to
  // show, unless a bulletin was dismissed on this page; it is mounted nowhere else.
  const slot = readFileSync(nt('features/bulletin/Bulletin.jsx'), 'utf8');
  assert.match(slot, /if \(!bulletin\) return checked && !dismissedHere \? <CompanionPromo \/> : null;/);
  assert.doesNotMatch(readFileSync(nt('App.jsx'), 'utf8'), /CompanionPromo/);
});

test("bulletin: the dev server serves the site's bulletin files, not the page for unknown paths", () => {
  const config = readFileSync(path.join(root, 'newtab', 'vite.config.mjs'), 'utf8');
  assert.match(config, /BULLETIN_FILES = \['newtab-comm\.html', 'newtab-comm-placeholder\.html'\]/);
  assert.match(config, /apply: 'serve'/);
  assert.match(config, /plugins: \[bulletinFiles\]/);
  for (const name of ['newtab-comm.html', 'newtab-comm-placeholder.html']) {
    assert.ok(existsSync(path.join(root, 'web', name)), name);
  }
});
