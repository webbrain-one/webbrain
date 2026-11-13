#!/usr/bin/env node

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pdfExtractionModulePath = path.join(root, 'src', 'chrome', 'src', 'agent', 'pdf-extraction.js');
const pdfToolsModulePath = path.join(root, 'src', 'chrome', 'src', 'agent', 'pdf-tools.js');
const pdfExtractionHostPath = path.join(root, 'src', 'chrome', 'src', 'offscreen', 'pdf-extraction-host.js');
const offscreenHtmlPath = path.join(root, 'src', 'chrome', 'src', 'offscreen', 'offscreen.html');
const pdfjsVendorPath = path.join(root, 'src', 'chrome', 'vendor', 'pdfjs');

function eventHub() {
  const listeners = new Set();
  return {
    addListener: listener => listeners.add(listener),
    removeListener: listener => listeners.delete(listener),
    emit: (...args) => [...listeners].map(listener => listener(...args)),
    get size() { return listeners.size; },
  };
}

function addressEvents() {
  return Object.fromEntries(['onBeforeRedirect', 'onResponseStarted', 'onErrorOccurred']
    .map(name => [name, eventHub()]));
}

function buildSinglePagePdf(text) {
  const contents = `BT /F1 24 Tf 72 720 Td (${text}) Tj ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${contents.length} >>\nstream\n${contents}\nendstream`,
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = objects.map((body, index) => {
    const offset = pdf.length;
    pdf += `${index + 1} 0 obj\n${body}\nendobj\n`;
    return offset;
  });
  const xrefOffset = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return new TextEncoder().encode(pdf);
}

async function testVendoredPdfjsExtractsTextThroughCompatEntryPoints() {
  // The modern build builds one DOMMatrix while it evaluates. Node has none,
  // and text extraction never renders, so an empty stand-in is enough.
  const hadDomMatrix = 'DOMMatrix' in globalThis;
  if (!hadDomMatrix) globalThis.DOMMatrix = class DOMMatrix {};
  let pdfjs;
  try {
    pdfjs = await import(pathToFileURL(path.join(pdfjsVendorPath, 'index.mjs')).href);
  } finally {
    if (!hadDomMatrix) delete globalThis.DOMMatrix;
  }
  // Node runs PDF.js's main-thread fallback, which imports workerSrc and reads
  // WorkerMessageHandler from it, so this also covers worker.mjs's re-export.
  pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(path.join(pdfjsVendorPath, 'worker.mjs')).href;
  const { extractPdfTextFromBytes } = await import(pathToFileURL(pdfExtractionModulePath).href);

  const result = await extractPdfTextFromBytes(pdfjs, buildSinglePagePdf('Hello from WebBrain'));
  assert.equal(result.success, true);
  assert.equal(result.totalPages, 1);
  assert.deepEqual(result.pages, ['Hello from WebBrain']);
}

async function testPdfjsCompatFillsMissingBuiltIns() {
  // Delete the built-ins in a fresh Node process so the polyfills themselves
  // run, whatever this Node version already ships.
  const compatUrl = pathToFileURL(path.join(pdfjsVendorPath, 'compat.mjs')).href;
  const script = `
    import assert from 'node:assert/strict';
    for (const Collection of [Map, WeakMap]) {
      delete Collection.prototype.getOrInsert;
      delete Collection.prototype.getOrInsertComputed;
    }
    delete Math.sumPrecise;
    delete Uint8Array.fromBase64;
    delete Uint8Array.prototype.toBase64;
    delete Uint8Array.prototype.toHex;
    delete Response.prototype.bytes;
    delete Promise.try;
    const existing = function getOrInsert() { return 'existing'; };
    Map.prototype.getOrInsert = existing;
    await import(${JSON.stringify(compatUrl)});

    let called = false;
    const promise = Promise.try((a, b) => { called = true; return a + b; }, 2, 3);
    assert.equal(called, true);
    assert.equal(await promise, 5);
    await assert.rejects(Promise.try(() => { throw new Error('fixture'); }), /fixture/);
    await assert.rejects(Promise.try(null), TypeError);
    class DerivedPromise extends Promise {}
    assert.ok(DerivedPromise.try(() => 1) instanceof DerivedPromise);

    assert.equal(Map.prototype.getOrInsert, existing, 'compat must not replace a method the browser has');
    assert.equal(Object.getOwnPropertyDescriptor(Math, 'sumPrecise').enumerable, false);

    const counts = new Map([['seen', 1]]);
    let calls = 0;
    assert.equal(counts.getOrInsertComputed('seen', () => { calls++; return 2; }), 1);
    assert.equal(counts.getOrInsertComputed('new', (key) => { calls++; return key.length; }), 3);
    assert.equal(calls, 1);
    assert.throws(() => counts.getOrInsertComputed('x', null), TypeError);
    const key = {};
    const weak = new WeakMap();
    assert.equal(weak.getOrInsert(key, 'first'), 'first');
    assert.equal(weak.getOrInsert(key, 'second'), 'first');
    assert.equal(weak.getOrInsertComputed({}, () => 'computed'), 'computed');

    assert.equal(Math.sumPrecise([0.1, 0.2, 0.3]), 0.6);
    assert.equal(Math.sumPrecise([1e20, 0.1, -1e20]), 0.1);
    assert.equal(Math.sumPrecise([1e100, 1, -1e100, 1e-100, 1e50, -1, -1e50]), 1e-100);
    assert.equal(Math.sumPrecise(new Set([1, 2, 3])), 6);
    assert.ok(Object.is(Math.sumPrecise([]), -0));
    assert.ok(Object.is(Math.sumPrecise([-0, -0]), -0));
    assert.ok(Object.is(Math.sumPrecise([-0, 0]), 0));
    assert.equal(Math.sumPrecise([Infinity, 1]), Infinity);
    assert.ok(Number.isNaN(Math.sumPrecise([Infinity, -Infinity])));
    assert.ok(Number.isNaN(Math.sumPrecise([NaN, 1])));
    assert.throws(() => Math.sumPrecise([1, '2']), TypeError);

    const hello = new TextEncoder().encode('Hello');
    assert.equal(hello.toBase64(), 'SGVsbG8=');
    assert.deepEqual(Uint8Array.fromBase64('SGVsbG8='), hello);
    const urlSafe = Uint8Array.from([251, 255]);
    assert.equal(urlSafe.toBase64(), '+/8=');
    assert.equal(urlSafe.toBase64({ alphabet: 'base64url', omitPadding: true }), '-_8');
    assert.deepEqual(Uint8Array.fromBase64('-_8', { alphabet: 'base64url' }), urlSafe);
    const large = Uint8Array.from({ length: 100003 }, (_, i) => (i * 31) % 256);
    assert.deepEqual(Uint8Array.fromBase64(large.toBase64()), large);
    assert.equal(Uint8Array.from([0, 1, 254, 255]).toHex(), '0001feff');

    assert.deepEqual(await new Response('abc').bytes(), Uint8Array.from([97, 98, 99]));
  `;
  execFileSync(process.execPath, ['--input-type=module', '--eval', script], { stdio: 'pipe' });
}

async function testMv3PdfExtractionUsesTheSharedOffscreenHost() {
  const pdfTools = await readFile(pdfToolsModulePath, 'utf8');
  const host = await readFile(pdfExtractionHostPath, 'utf8');
  const offscreenHtml = await readFile(offscreenHtmlPath, 'utf8');
  assert.match(pdfTools, /ensureOffscreen\(\)/);
  assert.match(pdfTools, /PDF_EXTRACTION_READY_MESSAGE/);
  assert.match(pdfTools, /type: PDF_EXTRACTION_MESSAGE/);
  assert.doesNotMatch(
    pdfTools,
    /import\(chrome\.runtime\.getURL\('vendor\/pdfjs\//,
    'MV3 service workers reject dynamic import() at runtime',
  );
  assert.match(host, /import\(chrome\.runtime\.getURL\('vendor\/pdfjs\/index\.mjs'\)\)/);
  assert.match(host, /chrome\.runtime\.getURL\('vendor\/pdfjs\/worker\.mjs'\)/);
  assert.match(host, /extractPdfTextFromBytes/);
  assert.match(host, /isTrustedPdfExtractionSender\(sender\)/);
  assert.match(offscreenHtml, /<script type="module" src="pdf-extraction-host\.js"><\/script>/);
  // The offscreen document outlives any single read, so a failed PDF.js import
  // must not be memoized into every later read_pdf.
  assert.match(host, /pdfjsPromise\.catch\(\(\) => \{ pdfjsPromise = null; \}\);/);
}

async function testPdfUrlAndSenderBoundaries() {
  const {
    fetchPdfBytes,
    isTrustedPdfExtractionSender,
    normalizePdfUrl,
  } = await import(pathToFileURL(pdfExtractionModulePath).href);
  const runtime = {
    id: 'trusted-extension',
    getURL: path => `chrome-extension://trusted-extension/${path}`,
  };
  const backgroundUrl = runtime.getURL('src/background.js');
  assert.equal(isTrustedPdfExtractionSender({ id: runtime.id, url: backgroundUrl }, runtime), true);
  assert.equal(isTrustedPdfExtractionSender({ id: runtime.id, url: runtime.getURL('src/ui/settings.html') }, runtime), false);
  assert.equal(isTrustedPdfExtractionSender({ id: runtime.id, url: backgroundUrl, tab: { id: 7 } }, runtime), false);
  assert.equal(isTrustedPdfExtractionSender({ id: 'other-extension', url: backgroundUrl }, runtime), false);

  // The trusted path follows the manifest, so renaming the service worker
  // entry cannot silently start rejecting every extraction.
  const renamedRuntime = {
    ...runtime,
    getManifest: () => ({ background: { service_worker: 'src/sw/main.js' } }),
  };
  assert.equal(isTrustedPdfExtractionSender(
    { id: runtime.id, url: renamedRuntime.getURL('src/sw/main.js') }, renamedRuntime), true);
  assert.equal(isTrustedPdfExtractionSender(
    { id: runtime.id, url: backgroundUrl }, renamedRuntime), false);

  assert.equal(normalizePdfUrl('https://example.test/document.pdf'), 'https://example.test/document.pdf');
  assert.equal(normalizePdfUrl('file:///tmp/document.pdf'), 'file:///tmp/document.pdf');
  assert.throws(() => normalizePdfUrl('data:application/pdf;base64,JVBERg=='), /must use http.*https.*file/i);
  assert.throws(() => normalizePdfUrl('javascript:alert(1)'), /must use http.*https.*file/i);

  // A PDF tab owned by the native MIME handler reports our viewer page as its
  // URL; read_pdf falls back to that, so the real URL must be unwrapped.
  const handlerUrl = `${runtime.getURL('src/ui/pdf-handler.html')}?url=${encodeURIComponent('https://example.test/paper.pdf')}&tabId=7`;
  assert.equal(normalizePdfUrl(handlerUrl, runtime), 'https://example.test/paper.pdf');
  assert.throws(
    () => normalizePdfUrl(`${runtime.getURL('src/ui/settings.html')}?url=${encodeURIComponent('https://example.test/x.pdf')}`, runtime),
    /must use http.*https.*file/i,
    'Only the PDF handler page may unwrap an inner URL.');
  assert.throws(
    () => normalizePdfUrl(`${runtime.getURL('src/ui/pdf-handler.html')}?url=${encodeURIComponent('javascript:alert(1)')}`, runtime),
    /must use http.*https.*file/i,
    'An unwrapped inner URL must still pass the scheme allowlist.');

  // The viewer page follows the manifest too, so renaming it cannot start
  // rejecting our own PDF tabs with a bogus scheme error.
  const renamedHandlerRuntime = {
    ...runtime,
    getManifest: () => ({ mime_types_handler: { 'application/pdf': { handler_url: 'src/ui/viewer.html' } } }),
  };
  assert.equal(
    normalizePdfUrl(
      `${runtime.getURL('src/ui/viewer.html')}?url=${encodeURIComponent('https://example.test/paper.pdf')}&tabId=7`,
      renamedHandlerRuntime),
    'https://example.test/paper.pdf');
  assert.throws(
    () => normalizePdfUrl(handlerUrl, renamedHandlerRuntime),
    /must use http.*https.*file/i,
    'Only the manifest-declared viewer page may unwrap an inner URL.');

  let fetchCalls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    throw new Error('disallowed URL reached fetch');
  };
  try {
    await assert.rejects(fetchPdfBytes('chrome-extension://trusted-extension/private.pdf'), /must use http.*https.*file/i);
    assert.equal(fetchCalls, 0, 'Disallowed schemes must be rejected before fetch.');
  } finally {
    globalThis.fetch = originalFetch;
  }
}

async function testPdfExtractionPreservesBoundedPageMetadataAndTruncation() {
  const { extractPdfTextFromBytes } = await import(pathToFileURL(pdfExtractionModulePath).href);
  const cleanedPages = [];
  const pageTexts = new Map([
    [1, ['First', 'page']],
    [2, ['x'.repeat(1200)]],
  ]);
  const pdfjs = {
    getDocument({ data, verbosity }) {
      assert.deepEqual(Array.from(data), [1, 2, 3]);
      assert.equal(verbosity, 0);
      return {
        promise: Promise.resolve({
          numPages: 2,
          getMetadata: async () => ({ info: { Title: 'Fixture PDF' } }),
          getPage: async pageNumber => ({
            getTextContent: async () => ({
              items: pageTexts.get(pageNumber).map(str => ({ str })),
            }),
            cleanup: () => cleanedPages.push(pageNumber),
          }),
        }),
      };
    },
  };

  const result = await extractPdfTextFromBytes(pdfjs, new Uint8Array([1, 2, 3]), {
    fromPage: 1,
    toPage: 2,
    maxChars: 1000,
  });
  assert.equal(result.title, 'Fixture PDF');
  assert.equal(result.totalPages, 2);
  assert.equal(result.fromPage, 1);
  assert.equal(result.toPage, 2);
  assert.equal(result.pageCount, 2);
  assert.equal(result.truncated, true);
  assert.equal(result.byteLength, 3);
  assert.match(result.pages[1], /page truncated/);
  assert.deepEqual(cleanedPages, [1, 2]);
}

async function testPdfFacadeRequestsOffscreenExtractionAndPreservesClaudeBytes() {
  const originalChrome = globalThis.chrome;
  const originalFetch = globalThis.fetch;
  const messages = [];
  let readyAttempts = 0;
  let fetchCalls = 0;
  const webRequest = addressEvents();
  const onMessage = eventHub();
  globalThis.chrome = {
    webRequest,
    offscreen: { hasDocument: async () => true },
    runtime: {
      id: 'trusted-extension',
      getURL: path => `chrome-extension://trusted-extension/${path}`,
      onMessage,
      sendMessage: async message => {
        messages.push(message);
        if (message.type === 'offscreen-pdf-extract-ready') {
          readyAttempts += 1;
          return readyAttempts < 3 ? undefined : { ok: true, ready: true };
        }
        assert.equal(webRequest.onResponseStarted.size, 1, 'The service worker must watch before offscreen fetch starts.');
        webRequest.onResponseStarted.emit({ url: message.url, tabId: -1, ip: '8.8.8.8' });
        const verdictMessage = { type: 'offscreen-pdf-fetch-verdict', requestId: message.requestId };
        const refused = await new Promise(resolve => {
          onMessage.emit(verdictMessage, { id: 'trusted-extension', url: 'chrome-extension://trusted-extension/src/ui/settings.html' }, resolve);
        });
        assert.equal(refused.ok, false, 'Only the offscreen host may request a verdict.');
        const verdict = await new Promise(resolve => {
          onMessage.emit(verdictMessage, { id: 'trusted-extension', url: 'chrome-extension://trusted-extension/src/offscreen/offscreen.html' }, resolve);
        });
        assert.deepEqual(verdict, { ok: true });
        return {
          ok: true,
          result: {
            success: true,
            title: 'Facade fixture',
            totalPages: 1,
            fromPage: 1,
            toPage: 1,
            pageCount: 1,
            pages: ['fixture text'],
            hasExtractableText: true,
            truncated: false,
            byteLength: 3,
            ...(message.options?.includeBase64 ? { _pdfBase64: 'BAUG' } : {}),
          },
        };
      },
    },
  };
  globalThis.fetch = async () => {
    fetchCalls += 1;
    throw new Error('The service-worker facade must not fetch the PDF.');
  };
  try {
    const { buildClaudeDocumentBlock, extractPdfText } = await import(pathToFileURL(pdfToolsModulePath).href);
    const plainResult = await extractPdfText('https://example.test/document.pdf', {
      fromPage: 2,
      toPage: 4,
      maxChars: 5000,
    });
    assert.equal(plainResult.title, 'Facade fixture');
    assert.equal(plainResult._pdfBase64, undefined);

    const claudeResult = await extractPdfText('https://example.test/document.pdf', {
      includeDocument: true,
    });
    assert.equal(claudeResult._pdfBase64, 'BAUG');
    assert.equal(buildClaudeDocumentBlock(claudeResult._pdfBase64, 'fixture.pdf').source.data, 'BAUG');
    assert.equal(fetchCalls, 0);
    assert.equal(onMessage.size, 0, 'Verdict listeners must be removed after extraction.');
    assert.equal(webRequest.onResponseStarted.size, 0, 'Address listeners must be removed after extraction.');
    for (const message of messages.filter(m => m.type === 'offscreen-pdf-extract')) {
      assert.match(message.requestId, /^[0-9a-f-]{36}$/);
      assert.equal(message.options.attachCookies, false);
    }
    assert.deepEqual(messages.map(({ requestId, credentials, ...message }) => message), [
      { type: 'offscreen-pdf-extract-ready' },
      { type: 'offscreen-pdf-extract-ready' },
      { type: 'offscreen-pdf-extract-ready' },
      {
        type: 'offscreen-pdf-extract',
        url: 'https://example.test/document.pdf',
        options: { fromPage: 2, toPage: 4, maxChars: 5000, includeBase64: false, allowLocalNetwork: false, attachCookies: false },
      },
      { type: 'offscreen-pdf-extract-ready' },
      {
        type: 'offscreen-pdf-extract',
        url: 'https://example.test/document.pdf',
        options: { fromPage: undefined, toPage: undefined, maxChars: undefined, includeBase64: true, allowLocalNetwork: false, attachCookies: false },
      },
    ]);
  } finally {
    if (originalChrome === undefined) delete globalThis.chrome;
    else globalThis.chrome = originalChrome;
    globalThis.fetch = originalFetch;
  }
}

async function testPdfVerdictSenderIsTheOffscreenDocument() {
  const { isTrustedPdfVerdictSender } = await import(pathToFileURL(pdfExtractionModulePath).href);
  const offscreenUrl = 'chrome-extension://trusted-extension/src/offscreen/offscreen.html';
  const queries = [];
  let contexts = [{ contextType: 'OFFSCREEN_DOCUMENT', documentUrl: offscreenUrl, documentId: 'OFFSCREEN-DOC' }];
  const runtime = {
    id: 'trusted-extension',
    getURL: path => `chrome-extension://trusted-extension/${path}`,
    getContexts: async filter => {
      queries.push(filter);
      if (contexts instanceof Error) throw contexts;
      return contexts;
    },
  };
  // Chrome: messages from the offscreen document carry no tab.
  assert.equal(await isTrustedPdfVerdictSender({ id: runtime.id, url: offscreenUrl, documentId: 'OFFSCREEN-DOC' }, runtime), true);
  assert.equal(queries.length, 0, 'A sender without a tab needs no context lookup.');
  assert.equal(await isTrustedPdfVerdictSender({ id: 'other-extension', url: offscreenUrl }, runtime), false);
  assert.equal(await isTrustedPdfVerdictSender({ id: runtime.id, url: runtime.getURL('src/ui/settings.html') }, runtime), false);
  assert.equal(await isTrustedPdfVerdictSender(undefined, runtime), false);

  // Murshid (Electron): the hidden offscreen window's messages carry tab details.
  const electronSender = { id: runtime.id, url: offscreenUrl, frameId: 0, documentId: 'OFFSCREEN-DOC', tab: { id: 7, url: offscreenUrl } };
  assert.equal(await isTrustedPdfVerdictSender(electronSender, runtime), true);
  assert.deepEqual(queries, [{ contextTypes: ['OFFSCREEN_DOCUMENT'], documentUrls: [offscreenUrl] }]);
  assert.equal(await isTrustedPdfVerdictSender({ ...electronSender, id: 'other-extension' }, runtime), false);
  // A tab that loaded offscreen.html is another document.
  assert.equal(await isTrustedPdfVerdictSender({ ...electronSender, documentId: 'TAB-DOC' }, runtime), false);
  assert.equal(await isTrustedPdfVerdictSender({ ...electronSender, documentId: undefined }, runtime), false);
  contexts = [{ contextType: 'OFFSCREEN_DOCUMENT', documentUrl: offscreenUrl }];
  assert.equal(await isTrustedPdfVerdictSender({ ...electronSender, documentId: undefined }, runtime), false,
    'A context without a documentId must not match a sender without one.');
  contexts = [{ documentId: 'OFFSCREEN-DOC' }, { documentId: 'OFFSCREEN-DOC' }];
  assert.equal(await isTrustedPdfVerdictSender(electronSender, runtime), false, 'The offscreen document must be unique.');
  contexts = [];
  assert.equal(await isTrustedPdfVerdictSender(electronSender, runtime), false);
  contexts = new Error('getContexts failed');
  assert.equal(await isTrustedPdfVerdictSender(electronSender, runtime), false);
  assert.equal(await isTrustedPdfVerdictSender(electronSender, { id: runtime.id, getURL: runtime.getURL }), false,
    'Without getContexts a sender with a tab cannot be identified.');
}

// Murshid runs the Chrome build in Electron, where the offscreen document is
// a hidden window and its messages arrive with sender.tab set.
async function testPdfFacadeAcceptsElectronOffscreenSender() {
  const originalChrome = globalThis.chrome;
  const webRequest = addressEvents();
  const onMessage = eventHub();
  const offscreenUrl = 'chrome-extension://trusted-extension/src/offscreen/offscreen.html';
  const offscreenSender = { id: 'trusted-extension', url: offscreenUrl, frameId: 0, documentId: 'OFFSCREEN-DOC', tab: { id: 7, url: offscreenUrl } };
  globalThis.chrome = {
    webRequest,
    offscreen: { hasDocument: async () => true },
    runtime: {
      id: 'trusted-extension',
      getURL: path => `chrome-extension://trusted-extension/${path}`,
      getContexts: async () => [{ contextType: 'OFFSCREEN_DOCUMENT', documentUrl: offscreenUrl, documentId: 'OFFSCREEN-DOC' }],
      onMessage,
      sendMessage: async message => {
        if (message.type === 'offscreen-pdf-extract-ready') return { ok: true, ready: true };
        webRequest.onResponseStarted.emit({ url: message.url, tabId: -1, ip: '8.8.8.8' });
        const ask = sender => new Promise(resolve => {
          onMessage.emit({ type: 'offscreen-pdf-fetch-verdict', requestId: message.requestId }, sender, resolve);
        });
        assert.deepEqual(await ask({ ...offscreenSender, tab: { id: 9, url: offscreenUrl }, documentId: 'TAB-DOC' }),
          { ok: false, error: 'Unauthorized PDF response verification sender.' }, 'A tab that loaded offscreen.html is refused.');
        // As the offscreen host does: read the bytes only on an ok verdict.
        const verdict = await ask(offscreenSender);
        if (verdict?.ok !== true) return { ok: false, error: verdict?.error || 'no verdict' };
        return { ok: true, result: { success: true, title: 'Electron fixture', totalPages: 1, fromPage: 1, toPage: 1,
          pageCount: 1, pages: ['fixture text'], hasExtractableText: true, truncated: false, byteLength: 3 } };
      },
    },
  };
  try {
    const { extractPdfText } = await import(pathToFileURL(pdfToolsModulePath).href);
    const result = await extractPdfText('https://example.test/document.pdf');
    assert.equal(result.title, 'Electron fixture');
    assert.equal(onMessage.size, 0, 'Verdict listeners must be removed after extraction.');
    assert.equal(webRequest.onResponseStarted.size, 0, 'Address listeners must be removed after extraction.');
  } finally {
    if (originalChrome === undefined) delete globalThis.chrome;
    else globalThis.chrome = originalChrome;
  }
}

async function testPdfCookieDomainsUseDocumentUrlsInBothBrowsers() {
  const previous = { chrome: globalThis.chrome, browser: globalThis.browser };
  try {
    for (const name of ['chrome', 'firefox']) {
      const scheme = name === 'chrome' ? 'chrome-extension:' : 'moz-extension:';
      const runtime = { getURL: path => `${scheme}//trusted-extension/${path}` };
      const viewer = url => `${runtime.getURL('src/ui/pdf-handler.html')}?url=${encodeURIComponent(url)}`;
      let activeUrl;
      const api = { runtime, tabs: { get: async () => ({ url: activeUrl }) } };
      globalThis.chrome = api;
      globalThis.browser = name === 'firefox' ? api : undefined;
      const { pdfFetchCredentials } = await import(new URL(`../src/${name}/src/agent/pdf-tools.js`, import.meta.url));
      activeUrl = viewer('https://private.example.com/document.pdf');
      assert.equal(await pdfFetchCredentials('https://private.example.com/document.pdf', 7), 'include', name);
      assert.equal(await pdfFetchCredentials(viewer('https://private.example.com/document.pdf'), 7), 'include', name);
      assert.equal(await pdfFetchCredentials(viewer('https://mail.other.com/private.pdf'), 7), 'omit', name);
      assert.equal(await pdfFetchCredentials('https://mail.other.com/private.pdf', 7), 'omit', name);
      assert.equal(await pdfFetchCredentials('https://private.example.com/document.pdf'), 'omit', name);
      activeUrl = viewer('javascript:alert(1)');
      assert.equal(await pdfFetchCredentials(viewer('https://private.example.com/document.pdf'), 7), 'omit', name);
      activeUrl = viewer('https://alice.github.io/a.pdf');
      assert.equal(await pdfFetchCredentials(viewer('https://bob.github.io/b.pdf'), 7), 'omit', name);
      await assert.rejects(pdfFetchCredentials(viewer('javascript:alert(1)'), 7), /must use http/);
    }
  } finally {
    globalThis.chrome = previous.chrome;
    globalThis.browser = previous.browser;
  }
}

async function testPdfAddressChecksFailClosedBeforeReadingBytes() {
  const previous = { chrome: globalThis.chrome, browser: globalThis.browser, fetch: globalThis.fetch };
  try {
    const { fetchPdfBytes } = await import(pathToFileURL(pdfExtractionModulePath).href);
    let bodyReads = 0;
    globalThis.fetch = async (_url, options) => {
      assert.equal(options.redirect, 'manual');
      assert.equal(options.credentials, 'omit');
      return { ok: true, status: 200, arrayBuffer: async () => { bodyReads++; return new ArrayBuffer(1); } };
    };
    globalThis.chrome = { runtime: {} }; // Real offscreen documents have no webRequest.
    await assert.rejects(fetchPdfBytes('https://public.example/p.pdf'), /verification is required/);
    await assert.rejects(fetchPdfBytes('https://public.example/p.pdf', {
      verifyResponse: async () => { throw new Error('blocked address'); },
    }), /blocked address/);
    assert.equal(bodyReads, 0, 'An absent or denied worker verdict must prevent body consumption.');
    await fetchPdfBytes('https://public.example/p.pdf', { verifyResponse: async () => {} });
    assert.equal(bodyReads, 1);
    globalThis.fetch = async () => ({ ok: false, status: 404, statusText: 'Not Found' });
    await assert.rejects(fetchPdfBytes('https://public.example/p.pdf', {
      verifyResponse: async () => { throw new Error('blocked address'); },
    }), /blocked address/, 'A blocked response must not disclose its HTTP status.');
    globalThis.fetch = async () => ({ ok: false, type: 'opaqueredirect', status: 0 });
    await assert.rejects(fetchPdfBytes('https://public.example/p.pdf'), /Redirect was not followed/);

    for (const name of ['chrome', 'firefox']) {
      const webRequest = addressEvents();
      const api = { webRequest };
      globalThis.chrome = api;
      globalThis.browser = api;
      const { watchFetchAddresses } = await import(new URL(`../src/${name}/src/network/network-tools.js`, import.meta.url));
      const watcher = watchFetchAddresses('https://public.example/p.pdf#page=1', false, { requireAddress: true });
      webRequest.onResponseStarted.emit({ tabId: -1, url: 'https://public.example/p.pdf' });
      assert.match(await watcher.settledFailure('fetch', 1), /Cannot verify/);
      webRequest.onResponseStarted.emit({ tabId: -1, url: 'https://public.example/p.pdf', ip: '127.0.0.1' });
      assert.match(await watcher.settledFailure('fetch'), /blocked address/);
      watcher.close();
      assert.equal(webRequest.onResponseStarted.size, 0);
      delete api.webRequest;
      assert.equal(watchFetchAddresses('https://public.example/p.pdf', false, { requireAddress: true }), null);
    }
    const webRequest = addressEvents();
    globalThis.browser = { webRequest, dns: { resolve: async () => ({ addresses: ['8.8.8.8'] }) } };
    globalThis.fetch = async () => {
      webRequest.onResponseStarted.emit({ tabId: -1, url: 'https://public.example/p.pdf', ip: '127.0.0.1' });
      return { ok: true, status: 200, arrayBuffer: async () => { bodyReads++; } };
    };
    const firefox = await import(new URL('../src/firefox/src/agent/pdf-tools.js', import.meta.url));
    await assert.rejects(firefox.fetchPdfBytes('https://public.example/p.pdf'), /blocked address/);
    assert.equal(bodyReads, 1, 'Firefox must also discard a blocked response before reading it.');
    assert.equal(webRequest.onResponseStarted.size, 0);
  } finally {
    globalThis.chrome = previous.chrome;
    globalThis.browser = previous.browser;
    globalThis.fetch = previous.fetch;
  }
}

async function testFirefoxPdfProxyRequiresValidatedDestination() {
  const previous = { browser: globalThis.browser, fetch: globalThis.fetch };
  const url = 'https://public.example/proxied.pdf';
  const firefox = await import(new URL('../src/firefox/src/agent/pdf-tools.js', import.meta.url));
  try {
    for (const [label, addresses, lookupFails, allowed, expectedFetches] of [
      ['public destination through local HTTP proxy', ['93.184.216.34'], false, true, 1],
      ['mixed public IPv4 and IPv6 answers', ['93.184.216.34', '2606:4700::1111'], false, true, 1],
      ['loopback destination', ['127.0.0.1'], false, false, 0],
      ['private destination mixed with public', ['93.184.216.34', '10.0.0.5'], false, false, 0],
      ['metadata destination', ['169.254.169.254'], false, false, 0],
      ['failed lookup', [], true, false, 0],
      ['empty lookup', [], false, false, 0],
      ['missing DNS API', null, false, false, 0],
    ]) {
      const webRequest = addressEvents();
      let fetches = 0;
      let bodyReads = 0;
      globalThis.browser = {
        webRequest,
        ...(addresses === null ? {} : { dns: { resolve: async host => {
          assert.equal(host, 'public.example');
          if (lookupFails) throw new Error('Lookup failed');
          return { addresses };
        } } }),
      };
      globalThis.fetch = async (_url, options) => {
        fetches++;
        assert.equal(options.credentials, 'omit');
        // Like Firefox, report the proxy socket, not the destination address.
        // Deliver the event after headers to exercise the watcher wait path.
        setTimeout(() => webRequest.onResponseStarted.emit({
          tabId: -1, url, ip: '127.0.0.1',
          proxyInfo: { type: 'http', host: '127.0.0.1', port: 8080 },
        }), 5);
        return { ok: true, status: 200, arrayBuffer: async () => { bodyReads++; return new Uint8Array([1, 2, 3]).buffer; } };
      };
      if (allowed) assert.deepEqual(await firefox.fetchPdfBytes(url), new Uint8Array([1, 2, 3]), label);
      else await assert.rejects(firefox.fetchPdfBytes(url), /blocked address|Cannot verify/, label);
      assert.equal(fetches, expectedFetches, label);
      assert.equal(bodyReads, allowed ? 1 : 0, label);
      assert.equal(webRequest.onResponseStarted.size, 0, `${label}: listeners must be removed`);
    }
    // A proxy event alone must never satisfy a strict watcher without the
    // caller's explicit guarantee that destination validation has succeeded.
    const webRequest = addressEvents();
    globalThis.browser = { webRequest };
    const { watchFetchAddresses } = await import(new URL('../src/firefox/src/network/network-tools.js', import.meta.url));
    const watcher = watchFetchAddresses(url, false, { requireAddress: true });
    webRequest.onResponseStarted.emit({ tabId: -1, url, ip: '127.0.0.1', proxyInfo: { type: 'http' } });
    assert.match(await watcher.settledFailure('fetch', 1), /Cannot verify/);
    watcher.close();
  } finally {
    globalThis.browser = previous.browser;
    globalThis.fetch = previous.fetch;
  }
}

async function testPdfExtractionSsrfAndCookieHardening() {
  const { fetchPdfBytes } = await import(pathToFileURL(pdfExtractionModulePath).href);
  const originalFetch = globalThis.fetch;
  const originalBrowser = globalThis.browser;
  const webRequest = addressEvents();
  globalThis.browser = { webRequest, dns: { resolve: async () => ({ addresses: ['8.8.8.8'] }) } };
  let lastFetchInit = null;
  globalThis.fetch = async (url, init) => {
    lastFetchInit = init;
    webRequest.onResponseStarted.emit({ tabId: -1, url, ip: url.includes('127.0.0.1') ? '127.0.0.1' : '8.8.8.8' });
    return new Response(new Uint8Array([37, 80, 68, 70]), { status: 200 });
  };

  try {
    // 1. Always-blocked cloud metadata
    await assert.rejects(
      fetchPdfBytes('http://169.254.169.254/latest/meta-data/', { allowLocalNetwork: false }),
      /Blocked link-local IPv4 \(cloud metadata\)/,
    );
    await assert.rejects(
      fetchPdfBytes('http://169.254.169.254/latest/meta-data/', { allowLocalNetwork: true }),
      /Blocked link-local IPv4 \(cloud metadata\)/,
    );
    await assert.rejects(
      fetchPdfBytes('http://metadata.google.internal/computeMetadata/v1/', { allowLocalNetwork: true }),
      /Blocked hostname/,
    );

    // 2. Local network blocked by default
    await assert.rejects(
      fetchPdfBytes('http://127.0.0.1:8080/secret.pdf', { allowLocalNetwork: false }),
      /Blocked loopback IPv4/,
    );
    await assert.rejects(
      fetchPdfBytes('http://localhost:3000/report.pdf', { allowLocalNetwork: false }),
      /Blocked local hostname/,
    );
    await assert.rejects(
      fetchPdfBytes('http://192.168.1.1/router.pdf', { allowLocalNetwork: false }),
      /Blocked private IPv4/,
    );
    await assert.rejects(
      fetchPdfBytes('http://10.0.0.5/doc.pdf', { allowLocalNetwork: false }),
      /Blocked private IPv4/,
    );

    // 3. Local network allowed when explicitly opted in
    const localBytes = await fetchPdfBytes('http://127.0.0.1:8080/secret.pdf', { allowLocalNetwork: true, verifyResponse: async () => {} });
    assert.deepEqual(Array.from(localBytes), [37, 80, 68, 70]);

    // 4. Scoped cookie credentials policy
    await fetchPdfBytes('https://example.test/public.pdf', { attachCookies: false, verifyResponse: async () => {} });
    assert.equal(lastFetchInit?.credentials, 'omit');
    assert.equal(lastFetchInit?.redirect, 'manual');

    await fetchPdfBytes('https://example.test/private.pdf', { attachCookies: true, verifyResponse: async () => {} });
    assert.equal(lastFetchInit?.credentials, 'include');
    assert.equal(lastFetchInit?.redirect, 'manual');

    // 5. Reject manual redirect responses
    globalThis.fetch = async () => ({
      status: 302,
      type: 'opaqueredirect',
    });
    await assert.rejects(
      fetchPdfBytes('https://example.test/redirect.pdf'),
      /Redirect was not followed because its target cannot be validated/,
    );
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.browser = originalBrowser;
  }
}

async function testFirefoxPdfExtractionSsrfAndCookieHardening() {
  const firefoxPdfToolsPath = path.join(root, 'src', 'firefox', 'src', 'agent', 'pdf-tools.js');
  const { fetchPdfBytes } = await import(pathToFileURL(firefoxPdfToolsPath).href);
  const originalFetch = globalThis.fetch;
  const originalBrowser = globalThis.browser;
  const webRequest = addressEvents();
  globalThis.browser = { webRequest, dns: { resolve: async () => ({ addresses: ['8.8.8.8'] }) } };
  let lastFetchInit = null;
  globalThis.fetch = async (url, init) => {
    lastFetchInit = init;
    webRequest.onResponseStarted.emit({ tabId: -1, url, ip: url.includes('127.0.0.1') ? '127.0.0.1' : '8.8.8.8' });
    return new Response(new Uint8Array([37, 80, 68, 70]), { status: 200 });
  };

  try {
    // 1. Cloud metadata always blocked
    await assert.rejects(
      fetchPdfBytes('http://169.254.169.254/latest/meta-data/', { allowLocalNetwork: true }),
      /Blocked link-local IPv4 \(cloud metadata\)/,
    );

    // 2. Loopback blocked without opt-in
    await assert.rejects(
      fetchPdfBytes('http://127.0.0.1:8080/secret.pdf', { allowLocalNetwork: false }),
      /Blocked loopback IPv4/,
    );

    // 3. Loopback permitted with opt-in
    const localBytes = await fetchPdfBytes('http://127.0.0.1:8080/secret.pdf', { allowLocalNetwork: true });
    assert.deepEqual(Array.from(localBytes), [37, 80, 68, 70]);

    // 4. Scoped cookie credentials policy
    await fetchPdfBytes('https://example.test/public.pdf', { attachCookies: false });
    assert.equal(lastFetchInit?.credentials, 'omit');
    assert.equal(lastFetchInit?.redirect, 'manual');

    await fetchPdfBytes('https://example.test/private.pdf', { attachCookies: true });
    assert.equal(lastFetchInit?.credentials, 'include');
    assert.equal(lastFetchInit?.redirect, 'manual');

    // 5. Reject manual redirect responses
    globalThis.fetch = async () => ({
      status: 302,
      type: 'opaqueredirect',
    });
    await assert.rejects(
      fetchPdfBytes('https://example.test/redirect.pdf'),
      /Redirect was not followed because its target cannot be validated/,
    );
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.browser = originalBrowser;
  }
}

const tests = [
  ['Chrome PDF extraction enforces SSRF checks, redirect rejection and scoped cookies', testPdfExtractionSsrfAndCookieHardening],
  ['Firefox PDF extraction enforces SSRF checks, redirect rejection and scoped cookies', testFirefoxPdfExtractionSsrfAndCookieHardening],
  ['Firefox PDF proxy reads require validated destination DNS answers', testFirefoxPdfProxyRequiresValidatedDestination],
  ['PDF cookie scope compares unwrapped document domains in Chrome and Firefox', testPdfCookieDomainsUseDocumentUrlsInBothBrowsers],
  ['PDF address checks require an observed address and discard denied bodies', testPdfAddressChecksFailClosedBeforeReadingBytes],
  ['MV3 PDF extraction uses the shared offscreen host', testMv3PdfExtractionUsesTheSharedOffscreenHost],
  ['PDF extraction rejects unsafe URLs and untrusted senders', testPdfUrlAndSenderBoundaries],
  ['PDF extraction preserves bounded page metadata and truncation', testPdfExtractionPreservesBoundedPageMetadataAndTruncation],
  ['PDF facade waits for host readiness and reuses Claude bytes', testPdfFacadeRequestsOffscreenExtractionAndPreservesClaudeBytes],
  ['PDF verdicts go only to the offscreen document, with or without sender.tab', testPdfVerdictSenderIsTheOffscreenDocument],
  ['PDF facade accepts the offscreen document of an Electron host (Murshid)', testPdfFacadeAcceptsElectronOffscreenSender],
  ['Vendored PDF.js extracts text through the compat entry points', testVendoredPdfjsExtractsTextThroughCompatEntryPoints],
  ['PDF.js compat fills missing built-ins without replacing native ones', testPdfjsCompatFillsMissingBuiltIns],
];

let failed = 0;
for (const [name, run] of tests) {
  try {
    await run();
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`  ✗ ${name}\n    ${error.message}`);
  }
}
console.log(`\n${tests.length - failed} PDF read tests passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
