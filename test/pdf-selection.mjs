#!/usr/bin/env node

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifestPath = path.join(root, 'src', 'chrome', 'manifest.json');
const handlerHtmlPath = path.join(root, 'src', 'chrome', 'src', 'ui', 'pdf-handler.html');
const handlerJsPath = path.join(root, 'src', 'chrome', 'src', 'ui', 'pdf-handler.js');
const ocrModulePath = path.join(root, 'src', 'chrome', 'src', 'agent', 'pdf-ocr.js');
const pdfStreamModulePath = path.join(root, 'src', 'chrome', 'src', 'agent', 'pdf-stream.js');
const firefoxPdfStreamModulePath = path.join(root, 'src', 'firefox', 'src', 'agent', 'pdf-stream.js');
const selectionShortcutPath = path.join(root, 'src', 'chrome', 'src', 'content', 'selection-shortcut.js');
const settingsHtmlPath = path.join(root, 'src', 'chrome', 'src', 'ui', 'settings.html');
const settingsJsPath = path.join(root, 'src', 'chrome', 'src', 'ui', 'settings.js');

async function testManifestRegistration() {
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  assert.deepEqual(manifest.mime_types_handler?.['application/pdf'], {
    handler_url: 'src/ui/pdf-handler.html',
    can_embed: true,
  });
}

async function testHandlerUsesChromeStreamAndTextLayer() {
  const html = await readFile(handlerHtmlPath, 'utf8');
  const source = await readFile(handlerJsPath, 'utf8');
  assert.match(html, /pdf-handler\.js/);
  assert.match(source, /mimeHandler\.getStreamInfo\(\)/);
  assert.match(source, /fetch\(streamInfo\.streamUrl/);
  assert.match(source, /getDocument\(\{ data:/);
  assert.match(source, /new (?:state\.)?(?:pdfjs\.)?TextLayer\(/);
  assert.match(source, /__webbrainSelectionShortcutConfig/);
  assert.match(source, /allowNestedFrame: true/);
  assert.match(source, /streamInfo\.embedded/);
}

async function testPdfViewerDefaultsOnWithExplicitAndCapabilityFallbacks() {
  const html = await readFile(settingsHtmlPath, 'utf8');
  const settings = await readFile(settingsJsPath, 'utf8');
  const source = await readFile(handlerJsPath, 'utf8');
  const background = await readFile(path.join(root, 'src', 'chrome', 'src', 'background.js'), 'utf8');
  assert.match(html, /id="toggle-pdf-viewer"/);
  assert.match(settings, /pdfViewerEnabled/);
  assert.match(settings, /stored\.pdfViewerEnabled === undefined \|\| stored\.pdfViewerEnabled === true/);
  assert.match(source, /typeof api\?\.mimeHandler\?\.getStreamInfo === 'function'/);
  assert.match(source, /api\.storage\.local\.get\(\{ \[PDF_VIEWER_ENABLED_KEY\]: true \}\)/);
  assert.match(source, /if \(stored\?\.\[PDF_VIEWER_ENABLED_KEY\] !== true\)/);
  assert.match(source, /const explicitViewer = Boolean\(explicitUrl && Number\.isInteger\(explicitTabId\) && explicitTabId >= 0\)/);
  assert.match(source, /if \(!explicitViewer\)/);
  assert.match(source, /fallbackToNative\(\);/);
  assert.match(source, /MAX_PDF_BYTES/);
  assert.match(source, /MAX_PDF_PAGES/);
  assert.match(background, /mimeHandler\?\.setMimeHandlerOptions/);
  assert.match(background, /syncNativePdfMimeHandlerFromStorage/);
  assert.match(background, /const value = changes\[PDF_VIEWER_ENABLED_KEY\]\.newValue;\s*setNativePdfMimeHandlerEnabled\(value === undefined \|\| value === true\)/);
}

async function testPdfPreferencesRejectMalformedValues() {
  const background = await readFile(path.join(root, 'src/chrome/src/background.js'), 'utf8');
  const handler = await readFile(handlerJsPath, 'utf8');
  const settings = await readFile(settingsJsPath, 'utf8');
  const syncBlock = background.match(/async function syncNativePdfMimeHandlerFromStorage\(\) \{[\s\S]*?\n\}/)?.[0];
  const changeBlock = background.match(/if \(areaName === 'local' && changes\[PDF_VIEWER_ENABLED_KEY\]\) \{[\s\S]*?\n  \}/)?.[0];
  const toggleBlock = settings.match(/pdfViewerToggle\.checked = [^;]+;/)?.[0];
  const gateStart = handler.indexOf('  if (!explicitViewer) {');
  const gateEnd = handler.indexOf('  const streamInfo = explicitViewer', gateStart);
  assert.ok(syncBlock && changeBlock && toggleBlock && gateStart >= 0 && gateEnd > gateStart);
  for (const [value, expected] of [
    [undefined, true], [true, true], [false, false], [null, false],
    ['false', false], ['true', false], [0, false], [1, false], [{}, false], [[], false],
  ]) {
    const stored = value === undefined ? {} : { pdfViewerEnabled: value };
    const api = { storage: { local: { get: async defaults => ({ ...defaults, ...stored }) } } };
    const updates = [];
    const setEnabled = async enabled => { updates.push(enabled); };
    const sync = Function('chrome', 'PDF_VIEWER_ENABLED_KEY', 'setNativePdfMimeHandlerEnabled',
      `${syncBlock}\nreturn syncNativePdfMimeHandlerFromStorage;`)(api, 'pdfViewerEnabled', setEnabled);
    await sync();
    const changes = { pdfViewerEnabled: value === undefined ? { oldValue: true } : { newValue: value } };
    Function('changes', 'areaName', 'PDF_VIEWER_ENABLED_KEY', 'setNativePdfMimeHandlerEnabled', 'reportPdfMimeHandlerSyncFailure',
      changeBlock)(changes, 'local', 'pdfViewerEnabled', setEnabled, error => { throw error; });
    assert.deepEqual(updates, [expected, expected], `PDF runtime: ${JSON.stringify(value)}`);
    const toggle = { checked: true };
    Function('stored', 'pdfViewerToggle', toggleBlock)(stored, toggle);
    assert.equal(toggle.checked, expected);
    for (const explicitViewer of [false, true]) {
      let fallbacks = 0;
      const continued = await Function('api', 'PDF_VIEWER_ENABLED_KEY', 'explicitViewer', 'fallbackToNative',
        `return (async () => { ${handler.slice(gateStart, gateEnd)} return true; })();`)(
        api, 'pdfViewerEnabled', explicitViewer, async () => { fallbacks++; },
      );
      assert.equal(continued === true, explicitViewer || expected);
      assert.equal(fallbacks, explicitViewer || expected ? 0 : 1);
    }
  }
}

async function testPdfHandlerProvidesCompleteViewerControls() {
  const html = await readFile(handlerHtmlPath, 'utf8');
  const source = await readFile(handlerJsPath, 'utf8');
  const firefoxHtml = await readFile(path.join(root, 'src', 'firefox', 'src', 'ui', 'pdf-handler.html'), 'utf8');
  const firefoxSource = await readFile(path.join(root, 'src', 'firefox', 'src', 'ui', 'pdf-handler.js'), 'utf8');
  const i18nSource = await readFile(path.join(root, 'src', 'chrome', 'src', 'ui', 'i18n.js'), 'utf8');
  const { pdfViewerEnglish, pdfViewerTranslations } = await import(
    pathToFileURL(path.join(root, 'src', 'chrome', 'src', 'ui', 'locales', 'pdf-viewer-copy.mjs')).href
  );
  for (const id of [
    'previous-page', 'page-number', 'page-count', 'next-page',
    'zoom-out', 'fit-width', 'zoom-in', 'rotate-page',
    'document-search', 'download-pdf', 'print-pdf',
    'native-viewer', 'disable-pdf-viewer',
  ]) {
    assert.match(html, new RegExp(`id="${id}"`), `viewer control ${id} is missing`);
  }
  assert.match(firefoxHtml, /id="native-viewer"/, 'Firefox viewer control native-viewer is missing');
  assert.match(firefoxSource, /elements\['native-viewer'\]\?\.addEventListener\('click'/);
  assert.match(source, /elements\['native-viewer'\]\?\.addEventListener\('click'/);
  assert.match(source, /elements\['disable-pdf-viewer'\]\?\.addEventListener\('click'/);
  assert.match(source, /async function disablePdfViewerAndFallback\(\)/);
  assert.match(source, /async function markNativeBypassForTab\(tabId\)/);
  assert.match(source, /async function consumeNativeBypassForTab\(tabId\)/);
  assert.match(source, /if \(await consumeNativeBypassForTab\(streamInfo\?\.tabId\)\)/);
  assert.match(source, /api\?\.storage\?\.local\?\.set\?\.\(\{ \[PDF_VIEWER_ENABLED_KEY\]: false \}\)/);
  assert.match(source, /api\?\.storage\?\.onChanged\?\.addListener\?\.\(\(changes, areaName\) =>/);
  assert.match(i18nSource, /pdfViewerTranslations/);
  assert.ok(pdfViewerEnglish['st.display.pdf_viewer.label']);
  assert.ok(pdfViewerEnglish['st.display.pdf_viewer.desc']);
  for (const locale of ['es', 'fr', 'tr', 'zh', 'ru', 'uk', 'ar', 'ja', 'ko', 'id', 'th', 'ms', 'tl', 'pl', 'he', 'hi', 'pt', 'vi', 'bn', 'fa', 'nl', 'de']) {
    assert.ok(pdfViewerTranslations[locale]?.['st.display.pdf_viewer.label'], `missing PDF viewer label translation for ${locale}`);
    assert.ok(pdfViewerTranslations[locale]?.['st.display.pdf_viewer.desc'], `missing PDF viewer desc translation for ${locale}`);
  }
  assert.match(source, /for \(let pageNumber = 1; pageNumber <= (?:state\.)?pdf\.numPages; pageNumber\+\+\)/);
  assert.match(source, /getTextContent\(\)/);
  assert.match(source, /scrollIntoView\(/);
  assert.match(source, /rotation/);
  assert.match(source, /URL\.createObjectURL\(/);
  assert.match(source, /(?:globalThis|window)\.print\(\)/);
  assert.match(source, /abortAndFallbackToNativeHandler/);
}

async function testScannedPdfOcrContract() {
  const html = await readFile(handlerHtmlPath, 'utf8');
  const handlerSource = await readFile(handlerJsPath, 'utf8');
  const ocrSource = await readFile(ocrModulePath, 'utf8');
  const backgroundSource = await readFile(path.join(root, 'src', 'chrome', 'src', 'background.js'), 'utf8');
  const agentSource = await readFile(path.join(root, 'src', 'chrome', 'src', 'agent', 'agent.js'), 'utf8');
  const firefoxAgentSource = await readFile(path.join(root, 'src', 'firefox', 'src', 'agent', 'agent.js'), 'utf8');
  assert.match(html, /id="ocr-page"/);
  assert.match(html, /id="cancel-ocr-page"/);
  assert.match(handlerSource, /action: 'ocr_pdf_page'/);
  assert.match(handlerSource, /action: 'cancel_pdf_ocr'/);
  assert.match(handlerSource, /ocrRequestId/);
  assert.match(handlerSource, /toDataURL\('image\/png'\)/);
  assert.match(handlerSource, /normalizePdfOcrResult/);
  assert.match(backgroundSource, /case 'ocr_pdf_page'/);
  assert.match(backgroundSource, /case 'cancel_pdf_ocr'/);
  assert.match(backgroundSource, /pdfOcrRequests/);
  assert.match(backgroundSource, /agent\.ocrPdfPageWithVision/);
  assert.match(agentSource, /async ocrPdfPageWithVision\([^)]*externalSignal/);
  assert.match(agentSource, /_wrapUntrusted\(\s*'pdf_ocr_image'/);
  assert.match(agentSource, /source="\$\{name\}"/);
  assert.match(firefoxAgentSource, /_wrapUntrusted\(\s*'pdf_ocr_image'/);
  assert.match(firefoxAgentSource, /source="pdf_ocr_image"/);
  assert.match(ocrSource, /untrusted PDF page data/);
}

async function testOcrNormalizationKeepsOnlyBoundedNormalizedLines() {
  const { normalizePdfOcrResult } = await import(pathToFileURL(ocrModulePath).href);
  const result = normalizePdfOcrResult({
    lines: [
      { text: '  Keep this text  ', x: 0.1, y: 0.2, width: 0.7, height: 0.04, confidence: 0.91 },
      { text: 'outside', x: -0.4, y: 0.8, width: 1.8, height: 0.4 },
      { text: '', x: 0.2, y: 0.2, width: 0.2, height: 0.1 },
      { text: 'pixel coordinates must fail', x: 10, y: 20, width: 100, height: 10 },
    ],
  });
  assert.equal(result.success, true);
  assert.deepEqual(result.lines.map(line => line.text), ['Keep this text', 'outside']);
  assert.deepEqual(result.lines[1].box, { x: 0, y: 0.8, width: 1, height: 0.2 });
  assert.equal(result.lines[0].confidence, 0.91);
  assert.equal(normalizePdfOcrResult({ lines: [] }).success, false);
}

async function testFirefoxProvidesAnExplicitOnlinePdfViewerFallback() {
  const firefoxManifest = JSON.parse(await readFile(path.join(root, 'src', 'firefox', 'manifest.json'), 'utf8'));
  const firefoxBackground = await readFile(path.join(root, 'src', 'firefox', 'src', 'background.js'), 'utf8');
  const firefoxHandlerHtml = await readFile(path.join(root, 'src', 'firefox', 'src', 'ui', 'pdf-handler.html'), 'utf8');
  const firefoxHandlerSource = await readFile(path.join(root, 'src', 'firefox', 'src', 'ui', 'pdf-handler.js'), 'utf8');
  const chromeHandlerSource = await readFile(handlerJsPath, 'utf8');
  assert.ok(firefoxManifest.permissions.includes('<all_urls>'));
  assert.match(firefoxBackground, /CONTEXT_MENU_OPEN_PDF_VIEWER_ID/);
  assert.match(firefoxBackground, /pdf-handler\.html\?url=/);
  assert.match(firefoxBackground, /trackPdfResponse/);
  assert.match(firefoxBackground, /onShown/);
  assert.match(firefoxBackground, /await menuApi\?\.refresh\?\.\(\)/);
  assert.match(firefoxBackground, /WB_PDF_SELECTION_SHORTCUT_SUBMIT/);
  assert.match(firefoxHandlerHtml, /pdf-handler\.js/);
  assert.match(firefoxHandlerSource, /URLSearchParams\(globalThis\.location\.search\)/);
  assert.match(firefoxHandlerSource, /action: 'fetch_pdf_document'/);
  assert.doesNotMatch(firefoxHandlerSource, /fetch\(/);
  assert.match(firefoxBackground, /case 'fetch_pdf_document'/);
  assert.match(chromeHandlerSource, /URLSearchParams\(globalThis\.location\.search\)/);
  const chromeBackground = await readFile(path.join(root, 'src', 'chrome', 'src', 'background.js'), 'utf8');
  assert.match(chromeBackground, /trackPdfResponse/);
  assert.doesNotMatch(chromeBackground, /contextMenus\?\.onShown/);
  assert.match(chromeBackground, /syncPdfContextMenuForActiveTab/);
  assert.match(chromeBackground, /CONTEXT_MENU_OPEN_PDF_VIEWER_ID,[\s\S]{0,180}visible: false/);
}

async function testPdfResponseStreamingStopsAtTheByteLimit() {
  const chromeModuleSource = await readFile(pdfStreamModulePath, 'utf8');
  const firefoxModuleSource = await readFile(firefoxPdfStreamModulePath, 'utf8');
  assert.equal(firefoxModuleSource, chromeModuleSource, 'Chrome and Firefox must share the same streaming limit behavior');

  const { readPdfResponseBytes } = await import(pathToFileURL(pdfStreamModulePath).href);
  let cancelled = false;
  const oversizedResponse = {
    headers: { get: () => '1' },
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3]));
        controller.enqueue(new Uint8Array([4, 5, 6]));
      },
      cancel() { cancelled = true; },
    }),
  };
  await assert.rejects(
    readPdfResponseBytes(oversizedResponse, { maxBytes: 5 }),
    /larger than the WebBrain viewer limit/,
  );
  assert.equal(cancelled, true, 'the response stream should be cancelled as soon as it exceeds the limit');

  const streamed = await readPdfResponseBytes({
    headers: { get: () => 'not-a-number' },
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array([7, 8]));
        controller.enqueue(new Uint8Array([9]));
        controller.close();
      },
    }),
  }, { maxBytes: 5 });
  assert.deepEqual(Array.from(streamed), [7, 8, 9]);
}

async function testPdfHandlerHardeningReviewFindings() {
  const chromeSource = await readFile(handlerJsPath, 'utf8');
  const firefoxHandlerSource = await readFile(path.join(root, 'src', 'firefox', 'src', 'ui', 'pdf-handler.js'), 'utf8');
  const firefoxBackground = await readFile(path.join(root, 'src', 'firefox', 'src', 'background.js'), 'utf8');
  const chromeBackground = await readFile(path.join(root, 'src', 'chrome', 'src', 'background.js'), 'utf8');
  // Review nit: Firefox handler must not leak the Chrome error string.
  assert.doesNotMatch(firefoxHandlerSource, /Chrome returned an empty PDF stream/);
  assert.match(firefoxHandlerSource, /Firefox returned an empty PDF stream/);
  assert.match(firefoxHandlerSource, /Firefox PDF fetch failed/);
  // Review: the credentialed fetch proxy must require a PDF content type.
  const fetchIndex = firefoxBackground.indexOf('async function fetchPdfDocumentForViewer');
  const fetchBody = firefoxBackground.slice(fetchIndex, fetchIndex + 900);
  assert.match(fetchBody, /application\\\/pdf/);
  assert.match(fetchBody, /get\('content-type'\)/);
  // Review: the O(n) scroll distance scan is throttled to one pass per frame.
  assert.match(chromeSource, /requestAnimationFrame/);
  assert.match(chromeSource, /scrollFrame/);
  assert.match(firefoxHandlerSource, /requestAnimationFrame/);
  assert.match(firefoxHandlerSource, /scrollFrame/);
  // Review: the download anchor is appended to the document before click().
  assert.match(chromeSource, /document\.body\.append\(anchor\)/);
  assert.match(chromeSource, /anchor\.remove\(\)/);
  assert.match(firefoxHandlerSource, /document\.body\.append\(anchor\)/);
  assert.match(firefoxHandlerSource, /anchor\.remove\(\)/);
  // Review: PDF.js may transfer the original input buffer, so downloads ask
  // the loaded document for fresh bytes instead of retaining that buffer.
  assert.match(chromeSource, /const bytes = await state\.pdf\.getData\(\)/);
  assert.match(firefoxHandlerSource, /const bytes = await state\.pdf\.getData\(\)/);
  assert.doesNotMatch(chromeSource, /state\.pdfBytes\s*=\s*bytes/);
  assert.doesNotMatch(firefoxHandlerSource, /state\.pdfBytes\s*=\s*bytes/);
  // Review: large documents must materialize every page before print() and
  // then return to their virtualized render window.
  for (const source of [chromeSource, firefoxHandlerSource]) {
    const printIndex = source.indexOf('async function printPdf()');
    const printBody = source.slice(printIndex, printIndex + 1500);
    assert.match(printBody, /for \(let pageNumber = 1; pageNumber <= state\.pdf\.numPages; pageNumber\+\+\)/);
    assert.ok(printBody.indexOf('await renderPage(pageNumber, sequence)') < printBody.lastIndexOf('globalThis.print()'));
    assert.match(printBody, /await renderAllPages\(\)/);
    assert.match(source, /state\.requestedPage = state\.currentPage;\s*setPageStatus\(\);\s*scheduleWindowRender\(\);/);
    assert.match(source, /windowRenderSequence/);
    assert.match(source, /isCurrentWindowRender\(sequence, windowSequence\)/);
    assert.match(source, /if \(!state\.pdf \|\| state\.pdf\.numPages <= EAGER_PAGE_LIMIT \|\| state\.printing\) return;/);
  }
  // Review: the explicit top-level viewer restores its URL without first
  // invoking the MIME-child-only fallback API.
  const fallbackIndex = chromeSource.indexOf('async function fallbackToNative');
  const fallbackBody = chromeSource.slice(fallbackIndex, fallbackIndex + 1200);
  assert.ok(fallbackBody.indexOf('tabs?.update') < fallbackBody.indexOf('abortAndFallbackToNativeHandler'));
  // Review: Chrome uses supported tab/response hooks and Firefox refreshes
  // the menu that is already open after updating visibility.
  assert.doesNotMatch(chromeBackground, /contextMenus\?\.onShown/);
  assert.match(chromeBackground, /tabs\.onUpdated\.addListener/);
  assert.match(chromeBackground, /syncPdfContextMenuForActiveTab/);
  assert.match(firefoxBackground, /menuApi\?\.refresh/);
}

async function testPdfSelectionCarriesItsTabScope() {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 500, height: 360 } });
    await page.setContent(`<!doctype html>
      <style>body { margin: 0; font: 18px/1.5 sans-serif; } #pdf-text { margin: 80px; }</style>
      <div id="pdf-text">Selectable text rendered by the PDF text layer.</div>`);
    await page.addScriptTag({ content: `
      window.__selectionMessages = [];
      window.__selectionStorage = { selectionShortcutEnabled: true, wbLocale: 'en' };
      window.__selectionRuntimeListeners = [];
      window.__selectionStorageListeners = [];
      window.chrome = {
        runtime: {
          sendMessage: async (message) => {
            if (message.type === 'WB_SELECTION_SHORTCUT_LOCALIZATION') return { ok: false };
            window.__selectionMessages.push(message);
            return { ok: true, queued: true, requiresManualOpen: false };
          },
          onMessage: { addListener: (listener) => window.__selectionRuntimeListeners.push(listener) },
        },
        storage: {
          local: {
            get: async (defaults) => ({ ...defaults, ...window.__selectionStorage }),
            set: async (update) => {
              const changes = {};
              for (const [key, value] of Object.entries(update)) {
                changes[key] = { oldValue: window.__selectionStorage[key], newValue: value };
                window.__selectionStorage[key] = value;
              }
              window.__selectionStorageListeners.forEach((listener) => listener(changes, 'local'));
            },
          },
          onChanged: { addListener: (listener) => window.__selectionStorageListeners.push(listener) },
        },
      };
      window.__webbrainSelectionShortcutConfig = {
        submitMessage: 'WB_PDF_SELECTION_SHORTCUT_SUBMIT',
        submitFields: { tabId: 73, originalUrl: 'https://papers.example.test/reading.pdf', windowId: 5 },
        allowNestedFrame: true,
      };
    ` });
    await page.addScriptTag({ content: await readFile(selectionShortcutPath, 'utf8') });
    await page.waitForFunction(() => typeof window.__webbrainSelectionShortcut?.getState === 'function');
    await page.evaluate(async () => {
      const range = document.createRange();
      range.selectNodeContents(document.getElementById('pdf-text'));
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      await new Promise(resolve => requestAnimationFrame(resolve));
      document.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
    });
    await page.waitForFunction(() => window.__webbrainSelectionShortcut.getState().shortcutVisible);
    // The viewer's tab is dragged into another window after the page loaded; the viewer
    // keeps its fields current, and the selection must carry the window it is in now.
    await page.evaluate(() => { window.__webbrainSelectionShortcutConfig.submitFields.windowId = 8; });
    await page.evaluate(() => window.__webbrainSelectionShortcut.submitPreset('summarize'));
    await page.waitForFunction(() => window.__selectionMessages.length === 1);
    const message = await page.evaluate(() => window.__selectionMessages[0]);
    assert.equal(message.type, 'WB_PDF_SELECTION_SHORTCUT_SUBMIT');
    assert.equal(message.tabId, 73);
    assert.equal(message.originalUrl, 'https://papers.example.test/reading.pdf');
    assert.equal(message.windowId, 8, 'the window the viewer is in when the selection is sent travels with it');
    assert.equal(message.action, 'summarize');
    assert.match(message.selectionText, /Selectable text rendered by the PDF text layer/);
  } finally {
    await browser.close();
  }
}

async function testPdfSelectionShortcutRunsInHandlerFrame() {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 500, height: 360 } });
    await page.setContent('<iframe id="pdf-handler-frame" srcdoc="<div id=pdf-text>Text rendered inside the PDF handler frame.</div>"></iframe>');
    const frame = page.frames().find(item => item !== page.mainFrame());
    assert.ok(frame, 'PDF handler frame was not created');
    await frame.waitForSelector('#pdf-text');
    const bootstrap = `
      window.__selectionMessages = [];
      window.__selectionStorage = { selectionShortcutEnabled: true, wbLocale: 'en' };
      window.__selectionRuntimeListeners = [];
      window.__selectionStorageListeners = [];
      window.chrome = {
        runtime: {
          sendMessage: async (message) => {
            if (message.type === 'WB_SELECTION_SHORTCUT_LOCALIZATION') return { ok: false };
            window.__selectionMessages.push(message);
            return { ok: true, queued: true, requiresManualOpen: false };
          },
          onMessage: { addListener: (listener) => window.__selectionRuntimeListeners.push(listener) },
        },
        storage: {
          local: {
            get: async (defaults) => ({ ...defaults, ...window.__selectionStorage }),
            set: async (update) => {
              const changes = {};
              for (const [key, value] of Object.entries(update)) {
                changes[key] = { oldValue: window.__selectionStorage[key], newValue: value };
                window.__selectionStorage[key] = value;
              }
              window.__selectionStorageListeners.forEach((listener) => listener(changes, 'local'));
            },
          },
          onChanged: { addListener: (listener) => window.__selectionStorageListeners.push(listener) },
        },
      };
      window.__webbrainSelectionShortcutConfig = {
        submitMessage: 'WB_PDF_SELECTION_SHORTCUT_SUBMIT',
        submitFields: { tabId: 91, originalUrl: 'https://papers.example.test/frame.pdf' },
        allowNestedFrame: true,
      };
    `;
    await frame.addScriptTag({ content: bootstrap });
    await frame.addScriptTag({ content: await readFile(selectionShortcutPath, 'utf8') });
    await frame.waitForFunction(() => typeof window.__webbrainSelectionShortcut?.getState === 'function', null, { timeout: 5000 });
    await frame.evaluate(async () => {
      const range = document.createRange();
      range.selectNodeContents(document.getElementById('pdf-text'));
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      await new Promise(resolve => requestAnimationFrame(resolve));
      document.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
    });
    await frame.waitForFunction(() => window.__webbrainSelectionShortcut.getState().shortcutVisible, null, { timeout: 5000 });
    await frame.evaluate(() => window.__webbrainSelectionShortcut.submitPreset('summarize'));
    await frame.waitForFunction(() => window.__selectionMessages.length === 1);
    const message = await frame.evaluate(() => window.__selectionMessages[0]);
    assert.equal(message.type, 'WB_PDF_SELECTION_SHORTCUT_SUBMIT');
    assert.equal(message.tabId, 91);
    assert.match(message.selectionText, /inside the PDF handler frame/);
  } finally {
    await browser.close();
  }
}

const tests = [
  ['manifest registers a top-level application/pdf handler', testManifestRegistration],
  ['PDF handler consumes Chrome stream info and renders a text layer', testHandlerUsesChromeStreamAndTextLayer],
  ['PDF viewer defaults on with explicit and capability fallbacks', testPdfViewerDefaultsOnWithExplicitAndCapabilityFallbacks],
  ['PDF preference validation preserves defaults and explicit viewer entry', testPdfPreferencesRejectMalformedValues],
  ['PDF handler provides complete viewer controls', testPdfHandlerProvidesCompleteViewerControls],
  ['scanned PDF OCR has a bounded handler/background contract', testScannedPdfOcrContract],
  ['OCR normalization keeps bounded normalized text lines', testOcrNormalizationKeepsOnlyBoundedNormalizedLines],
  ['Firefox provides an explicit online PDF viewer fallback', testFirefoxProvidesAnExplicitOnlinePdfViewerFallback],
  ['PDF response streaming stops at the byte limit', testPdfResponseStreamingStopsAtTheByteLimit],
  ['PDF handler hardening addresses review findings', testPdfHandlerHardeningReviewFindings],
  ['PDF selection submission carries tab scope and original URL', testPdfSelectionCarriesItsTabScope],
  ['PDF selection shortcut runs in the handler frame', testPdfSelectionShortcutRunsInHandlerFrame],
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
console.log(`\n${tests.length - failed} pdf selection tests passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
