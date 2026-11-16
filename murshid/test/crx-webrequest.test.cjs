'use strict';
// CrxBridge relays webRequest events that Electron's session handlers keep
// from reaching WebBrain's worker. These tests drive the offscreen-document
// path (read_pdf's fetch) without Electron.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const EXT = 'a'.repeat(32);
const OFFSCREEN_URL = `chrome-extension://${EXT}/src/offscreen/offscreen.html`;
const PDF_URL = 'https://example.com/paper.pdf';
const srcModule = (file) => pathToFileURL(path.join(__dirname, '../../src/chrome/src', file)).href;
// What electron.webContents.getAllWebContents() returns to the bridge.
const allContents = [];

function loadBridge() {
  const electron = { BrowserWindow: class {}, ipcMain: {}, shell: {}, webContents: { getAllWebContents: () => allContents } };
  const file = '../app/crx/bridge';
  const original = Module._load;
  Module._load = function (name, ...args) { return name === 'electron' ? electron : original.call(this, name, ...args); };
  try { delete require.cache[require.resolve(file)]; return require(file); } finally { Module._load = original; }
}

// A bridge with one live offscreen document and no tabs. Relayed events are
// recorded, then handed to `deliver` when one is given.
function offscreenBridge(deliver) {
  const { CrxBridge } = loadBridge();
  const bridge = Object.create(CrxBridge.prototype);
  const mainFrame = { frameToken: 'offscreen-frame' };
  bridge.ses = { extensions: { getExtension: () => ({ manifest: { permissions: ['webRequest'], host_permissions: ['<all_urls>'] } }) } };
  const win = { isDestroyed: () => false,
    webContents: { id: 7, mainFrame, session: bridge.ses, isDestroyed: () => false, getURL: () => OFFSCREEN_URL } };
  allContents.splice(0, allContents.length, win.webContents);
  const state = { win, generation: 1, documentId: 'offscreen-document-1' };
  bridge.ctx = { webBrainId: EXT, windows: [], windowForTab: () => null };
  bridge.runningWorker = () => null;
  bridge.panelContents = new Map();
  bridge.offscreen = new Map([[EXT, win]]);
  bridge.offscreenIdentity = new Map([[EXT, state]]);
  bridge.offscreenRequests = new Map();
  bridge.requestEventAcks = new Map();
  const delivered = [];
  bridge.deliverWebRequest = async (extId, event, payload) => {
    delivered.push({ extId, event, ...payload });
    deliver?.(event, payload);
  };
  const details = (id, extra = {}) => ({
    id, url: PDF_URL, method: 'GET', resourceType: 'xhr', initiatorOrigin: `chrome-extension://${EXT}`,
    webContentsId: 7, frame: { frameToken: 'offscreen-frame', url: OFFSCREEN_URL }, timestamp: 1, ...extra,
  });
  return { bridge, state, delivered, details };
}

test('offscreen fetch relays its response address after the response headers', async () => {
  const { bridge, delivered, details } = offscreenBridge();
  await bridge.forwardWebRequest('onBeforeRequest', details(41));
  await bridge.forwardWebRequest('onBeforeSendHeaders', details(41, { requestHeaders: { Cookie: 'fixture=1' } }));
  await bridge.forwardWebRequest('onHeadersReceived', details(41, { statusCode: 200,
    responseHeaders: { 'Content-Type': ['application/pdf'], 'Set-Cookie': ['fixture=1'] } }));
  assert.equal(bridge.offscreenRequests.has('41'), true, 'the binding must outlive the response headers');
  await bridge.forwardWebRequest('onResponseStarted', details(41, { ip: '203.0.113.10', statusCode: 200,
    responseHeaders: { 'Set-Cookie': ['fixture=1'] } }));
  assert.deepEqual(delivered.map(e => e.event), ['onBeforeRequest', 'onHeadersReceived', 'onResponseStarted']);
  const response = delivered.at(-1);
  assert.equal(response.extId, EXT);
  assert.equal(response.ip, '203.0.113.10');
  assert.equal(response.statusCode, 200);
  assert.equal(response.tabId, -1);
  assert.equal(response.frameId, 0);
  assert.equal(response.documentId, 'offscreen-document-1');
  assert.equal(response.requestId, '41');
  assert.equal(response.url, PDF_URL);
  assert.equal(response.responseHeaders, undefined, 'response headers are not relayed with the address');
  assert.deepEqual(delivered[1].responseHeaders, [], 'only Location is relayed with the response headers');
  assert.equal(bridge.offscreenRequests.has('41'), false, 'the response ends the binding');
  await bridge.forwardWebRequest('onErrorOccurred', details(41, { error: 'net::ERR_ABORTED' }));
  assert.equal(delivered.length, 3, 'nothing is relayed for a finished request');
});

test('offscreen redirects and errors carry their address, target and error', async () => {
  const { bridge, delivered, details } = offscreenBridge();
  const finalUrl = 'https://example.com/final.pdf';
  await bridge.forwardWebRequest('onBeforeRequest', details(42));
  await bridge.forwardWebRequest('onHeadersReceived', details(42, { statusCode: 302, responseHeaders: { Location: [finalUrl] } }));
  await bridge.forwardWebRequest('onBeforeRedirect', details(42, { ip: '203.0.113.10', statusCode: 302, redirectURL: finalUrl }));
  const redirect = delivered.at(-1);
  assert.equal(redirect.event, 'onBeforeRedirect');
  assert.equal(redirect.ip, '203.0.113.10');
  assert.equal(redirect.redirectUrl, finalUrl);
  assert.equal(redirect.statusCode, 302);
  assert.deepEqual(delivered[1].responseHeaders, [{ name: 'Location', value: finalUrl }]);
  assert.equal(bridge.offscreenRequests.has('42'), false, 'a redirect ends the binding for the old URL');
  // A followed redirect is bound again for its new URL.
  await bridge.forwardWebRequest('onBeforeRequest', details(42, { url: finalUrl }));
  await bridge.forwardWebRequest('onResponseStarted', details(42, { url: finalUrl, ip: '203.0.113.11', statusCode: 200 }));
  assert.equal(delivered.at(-1).event, 'onResponseStarted');
  assert.equal(delivered.at(-1).url, finalUrl);
  assert.equal(delivered.at(-1).ip, '203.0.113.11');

  await bridge.forwardWebRequest('onBeforeRequest', details(43));
  await bridge.forwardWebRequest('onErrorOccurred', details(43, { error: 'net::ERR_CONNECTION_REFUSED' }));
  assert.equal(delivered.at(-1).event, 'onErrorOccurred');
  assert.equal(delivered.at(-1).error, 'net::ERR_CONNECTION_REFUSED');
  assert.equal(bridge.offscreenRequests.size, 0);
});

test('offscreen response events are relayed only for a request bound to the current document', async () => {
  const { bridge, state, delivered, details } = offscreenBridge();
  // Never bound: another frame of the offscreen window made the request.
  await bridge.forwardWebRequest('onBeforeRequest', details(51, { frame: { frameToken: 'other-frame', url: OFFSCREEN_URL } }));
  await bridge.forwardWebRequest('onResponseStarted', details(51, { ip: '203.0.113.10' }));
  // Bound, but the URL differs from the bound one.
  await bridge.forwardWebRequest('onBeforeRequest', details(52));
  await bridge.forwardWebRequest('onResponseStarted', details(52, { url: 'https://example.com/other.pdf', ip: '203.0.113.10' }));
  // Bound, then the offscreen document reloaded.
  state.generation += 1;
  state.documentId = 'offscreen-document-2';
  await bridge.forwardWebRequest('onResponseStarted', details(52, { ip: '203.0.113.10' }));
  // A repeated response for one binding is relayed once.
  await bridge.forwardWebRequest('onBeforeRequest', details(53));
  await bridge.forwardWebRequest('onHeadersReceived', details(53, { statusCode: 401 }));
  await bridge.forwardWebRequest('onHeadersReceived', details(53, { statusCode: 200 }));
  assert.deepEqual(delivered.map(e => `${e.requestId}:${e.event}`), ['52:onBeforeRequest', '53:onBeforeRequest', '53:onHeadersReceived']);
  assert.equal(delivered.at(-1).statusCode, 401);
});

// A worker `chrome` whose webRequest events take what the bridge relays, as
// the worker's preload shim delivers it: to listeners whose tabId matches.
function installWorkerChrome(t) {
  // One listener function is added to several events, as the watcher does.
  const listeners = new Set();
  const event = (name) => ({
    addListener(fn, filter) { listeners.add({ name, fn, filter }); },
    removeListener(fn) { for (const entry of listeners) if (entry.name === name && entry.fn === fn) listeners.delete(entry); },
  });
  const previous = globalThis.chrome;
  globalThis.chrome = {
    runtime: {}, storage: { local: { get: async () => ({}) }, onChanged: { addListener() {} } },
    webRequest: Object.fromEntries(['onBeforeRequest', 'onHeadersReceived', 'onBeforeRedirect', 'onResponseStarted', 'onErrorOccurred']
      .map(name => [name, event(name)])),
  };
  t.after(() => { globalThis.chrome = previous; });
  const deliver = (name, payload) => {
    for (const { name: listening, fn, filter } of [...listeners]) {
      if (listening === name && (filter?.tabId === undefined || filter.tabId === payload.tabId)) fn({ ...payload });
    }
  };
  return { listeners, deliver };
}

const fetchThroughOffscreen = async (bridge, details, id, ip) => {
  await bridge.forwardWebRequest('onBeforeRequest', details(id));
  await bridge.forwardWebRequest('onHeadersReceived', details(id, { statusCode: 200 }));
  await bridge.forwardWebRequest('onResponseStarted', details(id, { ip, statusCode: 200 }));
};

// read_pdf (src/chrome/src/agent/pdf-tools.js) waits in the worker for a
// verified response address before the offscreen host may read the bytes.
test('read_pdf address check settles on relayed offscreen events', async (t) => {
  const { listeners, deliver } = installWorkerChrome(t);
  const { watchFetchAddresses } = await import(srcModule('network/network-tools.js'));
  const { bridge, details } = offscreenBridge(deliver);

  let watcher = watchFetchAddresses(PDF_URL, false, { requireAddress: true });
  await fetchThroughOffscreen(bridge, details, 61, '203.0.113.10');
  assert.equal(await watcher.settledFailure('fetch', 200), null, 'a public PDF must be readable');
  watcher.close();

  watcher = watchFetchAddresses(PDF_URL, false, { requireAddress: true });
  await fetchThroughOffscreen(bridge, details, 62, '10.0.0.5');
  assert.match(await watcher.settledFailure('fetch', 200), /resolved to a blocked address/);
  watcher.close();

  watcher = watchFetchAddresses(PDF_URL, true, { requireAddress: true });
  await bridge.forwardWebRequest('onBeforeRequest', details(63));
  assert.equal(await watcher.settledFailure('fetch', 50), 'Cannot verify the PDF response resolved address.',
    'without a response address the check still fails closed');
  watcher.close();
  assert.equal(listeners.size, 0);
});

// Electron adds tab details to messages from every window, the hidden
// offscreen window included, so read_pdf's verdict listener identifies the
// offscreen document by the documentId Murshid's getContexts reports.
test('read_pdf verdict reaches the offscreen document through Murshid contexts', async (t) => {
  const { deliver } = installWorkerChrome(t);
  const { watchFetchAddresses } = await import(srcModule('network/network-tools.js'));
  const { createPdfVerdictListener } = await import(srcModule('agent/pdf-extraction.js'));
  const { bridge, state, details } = offscreenBridge(deliver);
  const runtime = {
    id: EXT,
    getURL: (file) => `chrome-extension://${EXT}/${file}`,
    // As preload-post.js installs it: a promise for the bridge handler's answer.
    getContexts: async (filter) => bridge.handlers['runtime.getContexts'].call(bridge, { extId: EXT }, filter),
  };
  const offscreenSender = { id: EXT, url: OFFSCREEN_URL, frameId: 0, documentId: state.documentId, tab: { id: 7, url: OFFSCREEN_URL } };
  const ask = (listener, sender) => new Promise((resolve) => {
    assert.equal(listener({ type: 'offscreen-pdf-fetch-verdict', requestId: 'request-1' }, sender, resolve), true);
  });

  const watcher = watchFetchAddresses(PDF_URL, false, { requireAddress: true });
  const listener = createPdfVerdictListener('request-1', watcher, runtime);
  await fetchThroughOffscreen(bridge, details, 71, '203.0.113.10');
  assert.deepEqual(await ask(listener, offscreenSender), { ok: true });
  const refused = { ok: false, error: 'Unauthorized PDF response verification sender.' };
  // A tab that loaded offscreen.html, and the document before a reload.
  assert.deepEqual(await ask(listener, { ...offscreenSender, tab: { id: 9, url: OFFSCREEN_URL }, documentId: 'tab-document' }), refused);
  state.documentId = 'offscreen-document-2';
  assert.deepEqual(await ask(listener, offscreenSender), refused);
  watcher.close();
});
