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

function loadBridge() {
  const electron = { BrowserWindow: class {}, ipcMain: {}, shell: {}, webContents: { getAllWebContents: () => [] } };
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
  const win = { isDestroyed: () => false, webContents: { id: 7, mainFrame, getURL: () => OFFSCREEN_URL } };
  const state = { win, generation: 1, documentId: 'offscreen-document-1' };
  bridge.ctx = { webBrainId: EXT, windows: [] };
  bridge.ses = { extensions: { getExtension: () => ({ manifest: { permissions: ['webRequest'], host_permissions: ['<all_urls>'] } }) } };
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

// read_pdf (src/chrome/src/agent/pdf-tools.js) waits in the worker for a
// verified response address before the offscreen host may read the bytes.
test('read_pdf address check settles on relayed offscreen events', async (t) => {
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
  const networkTools = pathToFileURL(path.join(__dirname, '../../src/chrome/src/network/network-tools.js')).href;
  const { watchFetchAddresses } = await import(networkTools);
  // Deliver as the worker's preload shim does: to listeners whose tabId matches.
  const { bridge, details } = offscreenBridge((name, payload) => {
    for (const { name: listening, fn, filter } of [...listeners]) {
      if (listening === name && (filter?.tabId === undefined || filter.tabId === payload.tabId)) fn({ ...payload });
    }
  });
  const fetchThroughOffscreen = async (id, ip) => {
    await bridge.forwardWebRequest('onBeforeRequest', details(id));
    await bridge.forwardWebRequest('onHeadersReceived', details(id, { statusCode: 200 }));
    await bridge.forwardWebRequest('onResponseStarted', details(id, { ip, statusCode: 200 }));
  };

  let watcher = watchFetchAddresses(PDF_URL, false, { requireAddress: true });
  await fetchThroughOffscreen(61, '203.0.113.10');
  assert.equal(await watcher.settledFailure('fetch', 200), null, 'a public PDF must be readable');
  watcher.close();

  watcher = watchFetchAddresses(PDF_URL, false, { requireAddress: true });
  await fetchThroughOffscreen(62, '10.0.0.5');
  assert.match(await watcher.settledFailure('fetch', 200), /resolved to a blocked address/);
  watcher.close();

  watcher = watchFetchAddresses(PDF_URL, true, { requireAddress: true });
  await bridge.forwardWebRequest('onBeforeRequest', details(63));
  assert.equal(await watcher.settledFailure('fetch', 50), 'Cannot verify the PDF response resolved address.',
    'without a response address the check still fails closed');
  watcher.close();
  assert.equal(listeners.size, 0);
});
