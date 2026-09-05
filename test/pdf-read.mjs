#!/usr/bin/env node

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pdfExtractionModulePath = path.join(root, 'src', 'chrome', 'src', 'agent', 'pdf-extraction.js');
const pdfToolsModulePath = path.join(root, 'src', 'chrome', 'src', 'agent', 'pdf-tools.js');
const pdfExtractionHostPath = path.join(root, 'src', 'chrome', 'src', 'offscreen', 'pdf-extraction-host.js');
const offscreenHtmlPath = path.join(root, 'src', 'chrome', 'src', 'offscreen', 'offscreen.html');

async function testMv3PdfExtractionUsesTheSharedOffscreenHost() {
  const pdfTools = await readFile(pdfToolsModulePath, 'utf8');
  const host = await readFile(pdfExtractionHostPath, 'utf8');
  const offscreenHtml = await readFile(offscreenHtmlPath, 'utf8');
  assert.match(pdfTools, /ensureOffscreen\(\)/);
  assert.match(pdfTools, /PDF_EXTRACTION_READY_MESSAGE/);
  assert.match(pdfTools, /type: PDF_EXTRACTION_MESSAGE/);
  assert.doesNotMatch(
    pdfTools,
    /import\(chrome\.runtime\.getURL\('vendor\/pdfjs\/pdf\.mjs'\)\)/,
    'MV3 service workers reject dynamic import() at runtime',
  );
  assert.match(host, /import\(chrome\.runtime\.getURL\('vendor\/pdfjs\/pdf\.mjs'\)\)/);
  assert.match(host, /extractPdfTextFromBytes/);
  assert.match(host, /isTrustedPdfExtractionSender\(sender\)/);
  assert.match(offscreenHtml, /<script type="module" src="pdf-extraction-host\.js"><\/script>/);
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
  globalThis.chrome = {
    offscreen: { hasDocument: async () => true },
    runtime: {
      sendMessage: async message => {
        messages.push(message);
        if (message.type === 'offscreen-pdf-extract-ready') {
          readyAttempts += 1;
          return readyAttempts < 3 ? undefined : { ok: true, ready: true };
        }
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
    assert.deepEqual(messages, [
      { type: 'offscreen-pdf-extract-ready' },
      { type: 'offscreen-pdf-extract-ready' },
      { type: 'offscreen-pdf-extract-ready' },
      {
        type: 'offscreen-pdf-extract',
        url: 'https://example.test/document.pdf',
        options: { fromPage: 2, toPage: 4, maxChars: 5000, includeBase64: false },
      },
      { type: 'offscreen-pdf-extract-ready' },
      {
        type: 'offscreen-pdf-extract',
        url: 'https://example.test/document.pdf',
        options: { fromPage: undefined, toPage: undefined, maxChars: undefined, includeBase64: true },
      },
    ]);
  } finally {
    if (originalChrome === undefined) delete globalThis.chrome;
    else globalThis.chrome = originalChrome;
    globalThis.fetch = originalFetch;
  }
}

const tests = [
  ['MV3 PDF extraction uses the shared offscreen host', testMv3PdfExtractionUsesTheSharedOffscreenHost],
  ['PDF extraction rejects unsafe URLs and untrusted senders', testPdfUrlAndSenderBoundaries],
  ['PDF extraction preserves bounded page metadata and truncation', testPdfExtractionPreservesBoundedPageMetadataAndTruncation],
  ['PDF facade waits for host readiness and reuses Claude bytes', testPdfFacadeRequestsOffscreenExtractionAndPreservesClaudeBytes],
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
