#!/usr/bin/env node

import assert from 'node:assert/strict';
import { access } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const extensionPath = path.join(root, 'src', 'chrome');
const pdfMimeType = 'application/pdf';

async function firstExistingPath(candidates) {
  for (const candidate of candidates.filter(Boolean)) {
    try {
      await access(candidate);
      return candidate;
    } catch {}
  }
  return '';
}

async function chromeLaunchTarget() {
  if (process.env.WEBMCP_CHROME_PATH) {
    return { executablePath: process.env.WEBMCP_CHROME_PATH };
  }

  const candidates = process.platform === 'win32'
    ? [
        process.env.PROGRAMFILES && path.join(process.env.PROGRAMFILES, 'Google', 'Chrome', 'Application', 'chrome.exe'),
        process.env['PROGRAMFILES(X86)'] && path.join(process.env['PROGRAMFILES(X86)'], 'Google', 'Chrome', 'Application', 'chrome.exe'),
        process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      ]
    : process.platform === 'darwin'
      ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']
      : ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable'];
  const executablePath = await firstExistingPath(candidates);
  return executablePath ? { executablePath } : { channel: 'chrome' };
}

function createMinimalPdf() {
  const pageContent = 'BT\n/F1 12 Tf\n20 100 Td\n(WebBrain PDF MIME handler test) Tj\nET\n';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 320 180] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${Buffer.byteLength(pageContent)} >>\nstream\n${pageContent}endstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let source = '%PDF-1.4\n';
  const offsets = [0];
  for (const [index, body] of objects.entries()) {
    offsets.push(Buffer.byteLength(source));
    source += `${index + 1} 0 obj\n${body}\nendobj\n`;
  }
  const xrefOffset = Buffer.byteLength(source);
  source += `xref\n0 ${objects.length + 1}\n`;
  source += '0000000000 65535 f \n';
  source += offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('');
  source += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(source);
}

async function startPdfServer() {
  const pdf = createMinimalPdf();
  let requestCount = 0;
  const server = createServer((request, response) => {
    const url = new URL(request.url || '/', 'http://127.0.0.1');
    if (url.pathname !== '/document.pdf') {
      response.writeHead(404).end('not found');
      return;
    }
    requestCount += 1;
    response.writeHead(200, {
      'content-type': pdfMimeType,
      'content-length': String(pdf.byteLength),
      'content-disposition': 'inline; filename="document.pdf"',
      'cache-control': 'no-store',
    });
    response.end(pdf);
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  return {
    server,
    pdf,
    requestCount: () => requestCount,
    url: `http://127.0.0.1:${address.port}/document.pdf`,
  };
}

async function waitForNativeHandlerOption(page, enabled) {
  await page.waitForFunction(async ({ mimeType, expected }) => {
    if (typeof chrome.mimeHandler?.getMimeHandlerOptions !== 'function') return false;
    const options = await chrome.mimeHandler.getMimeHandlerOptions(mimeType);
    return options?.enabled === expected;
  }, { mimeType: pdfMimeType, expected: enabled }, { timeout: 10_000 });
}

async function setPdfViewerToggle(page, enabled) {
  await page.evaluate(expected => {
    const toggle = document.getElementById('toggle-pdf-viewer');
    if (!(toggle instanceof HTMLInputElement)) throw new Error('PDF viewer toggle is unavailable.');
    if (toggle.checked !== expected) toggle.click();
  }, enabled);
}

async function inspectPdfRouting(context, url, extensionId, waitMs = 2000) {
  const page = await context.newPage();
  const handlerUrl = `chrome-extension://${extensionId}/src/ui/pdf-handler.html`;
  const navigations = [];
  page.on('framenavigated', frame => navigations.push(frame.url()));
  try {
    await page.goto(url, { waitUntil: 'commit', timeout: 30_000 });
    await page.waitForTimeout(waitMs);
    const urls = [...navigations, ...page.frames().map(frame => frame.url())];
    return {
      sawWebBrainHandler: urls.some(value => value.startsWith(handlerUrl)),
      sawNativeHandler: urls.some(value => value.startsWith('chrome-extension://') && !value.startsWith(`chrome-extension://${extensionId}/`)),
      urls,
    };
  } finally {
    await page.close();
  }
}

async function closeServer(server) {
  if (!server) return;
  await new Promise(resolve => server.close(resolve));
}

async function main() {
  const fixture = await startPdfServer();
  let context = null;
  let browserCdp = null;
  let extensionId = '';
  try {
    const launchTarget = await chromeLaunchTarget();
    context = await chromium.launchPersistentContext('', {
      ...launchTarget,
      headless: true,
      ignoreDefaultArgs: ['--disable-extensions'],
      args: ['--enable-unsafe-extension-debugging'],
    });
    const browser = context.browser();
    assert.ok(browser, 'Lost the real Chrome browser connection.');
    browserCdp = await browser.newBrowserCDPSession();
    const loaded = await browserCdp.send('Extensions.loadUnpacked', { path: extensionPath });
    extensionId = String(loaded.id || '');
    assert.match(extensionId, /^[a-p]{32}$/, 'Chrome did not return a valid unpacked extension ID.');

    const settings = await context.newPage();
    await settings.goto(`chrome-extension://${extensionId}/src/ui/settings.html`);
    const apiAvailable = await settings.evaluate(() => (
      typeof chrome.mimeHandler?.getMimeHandlerOptions === 'function'
      && typeof chrome.mimeHandler?.setMimeHandlerOptions === 'function'
    ));
    assert.equal(apiAvailable, true, `Chrome ${browser.version()} does not expose the public MIME handler options API.`);

    const ensured = await settings.evaluate(async () => chrome.runtime.sendMessage({
        target: 'background',
        action: 'ensure_offscreen_offline_rag_host',
      }));
    assert.equal(ensured?.ready, true, 'The background did not create the shared offscreen host.');

    const rejected = await settings.evaluate(async url => chrome.runtime.sendMessage({
        type: 'offscreen-pdf-extract',
        url,
        options: { fromPage: 1, toPage: 1, maxChars: 5000 },
      }), fixture.url);
    assert.equal(rejected?.ok, false, 'An extension page bypassed the background-only PDF extraction gate.');
    assert.match(rejected?.error || '', /Unauthorized PDF extraction sender/);
    assert.equal(fixture.requestCount(), 0, 'An unauthorized PDF extraction request reached the network.');

    const backgroundUrl = `chrome-extension://${extensionId}/src/background.js`;
    // serviceWorkers() is a snapshot: Playwright may not have observed the
    // worker yet, and Chrome can idle it out during the steps above.
    let background = context.serviceWorkers().find(worker => worker.url() === backgroundUrl);
    if (!background) {
      background = await context.waitForEvent('serviceworker', {
        predicate: worker => worker.url() === backgroundUrl,
        timeout: 10000,
      }).catch(() => null);
    }
    assert.ok(background, 'The WebBrain service worker was not available for the PDF extraction test.');
    const ready = await background.evaluate(async () => chrome.runtime.sendMessage({
      type: 'offscreen-pdf-extract-ready',
    }));
    assert.equal(ready?.ready, true, ready?.error || 'The offscreen PDF parser did not become ready.');

    const requestsBeforeExtraction = fixture.requestCount();
    const extraction = await background.evaluate(async url => chrome.runtime.sendMessage({
      type: 'offscreen-pdf-extract',
      url,
      options: { fromPage: 1, toPage: 1, maxChars: 5000, includeBase64: true },
    }), fixture.url);
    assert.equal(extraction?.ok, true, extraction?.error || 'The offscreen PDF parser failed.');
    assert.equal(fixture.requestCount() - requestsBeforeExtraction, 1, 'Claude-compatible extraction fetched the PDF more than once.');
    assert.equal(extraction.result?.totalPages, 1);
    assert.equal(extraction.result?.byteLength, fixture.pdf.byteLength);
    assert.match(extraction.result?.pages?.[0] || '', /WebBrain PDF MIME handler test/);
    assert.deepEqual(Buffer.from(extraction.result?._pdfBase64 || '', 'base64'), fixture.pdf);

    await waitForNativeHandlerOption(settings, false);
    // Installation initially registers public MIME handlers as enabled. Allow
    // the post-registration reconciliation pass to settle before navigating.
    await settings.waitForTimeout(750);
    const initialState = await settings.evaluate(async () => ({
      stored: await chrome.storage.local.get(['pdfViewerEnabled']),
      checked: document.getElementById('toggle-pdf-viewer')?.checked,
    }));
    assert.equal(initialState.stored.pdfViewerEnabled, undefined, 'Fresh installs must preserve an unset WebBrain PDF setting.');
    assert.equal(initialState.checked, false, 'The PDF viewer toggle must render off by default.');

    const disabledRouting = await inspectPdfRouting(context, `${fixture.url}?mode=disabled`, extensionId);
    assert.equal(disabledRouting.sawWebBrainHandler, false, `Disabled PDF handling still entered WebBrain: ${disabledRouting.urls.join(', ')}`);
    assert.equal(disabledRouting.sawNativeHandler, true, `Disabled PDF handling did not reach Chrome's native viewer: ${disabledRouting.urls.join(', ')}`);

    await setPdfViewerToggle(settings, true);
    await waitForNativeHandlerOption(settings, true);
    const enabledStored = await settings.evaluate(async () => chrome.storage.local.get('pdfViewerEnabled'));
    assert.equal(enabledStored.pdfViewerEnabled, true, 'The enabled toggle was not stored.');

    const enabledRouting = await inspectPdfRouting(context, `${fixture.url}?mode=enabled`, extensionId);
    assert.equal(enabledRouting.sawWebBrainHandler, true, `Enabled PDF handling did not enter WebBrain: ${enabledRouting.urls.join(', ')}`);

    await setPdfViewerToggle(settings, false);
    await waitForNativeHandlerOption(settings, false);
    const disabledAgainRouting = await inspectPdfRouting(context, `${fixture.url}?mode=disabled-again`, extensionId);
    assert.equal(disabledAgainRouting.sawWebBrainHandler, false, `Turning PDF handling off still entered WebBrain: ${disabledAgainRouting.urls.join(', ')}`);
    assert.equal(disabledAgainRouting.sawNativeHandler, true, `Turning PDF handling off did not restore Chrome's native viewer: ${disabledAgainRouting.urls.join(', ')}`);
    console.log(`  ✓ Chrome ${browser.version()} keeps native PDF routing aligned with the WebBrain toggle`);
  } finally {
    if (browserCdp && extensionId) {
      await browserCdp.send('Extensions.uninstall', { id: extensionId }).catch(() => {});
    }
    if (context) await context.close();
    await closeServer(fixture?.server);
  }
}

main().catch(error => {
  console.error(`  ✗ PDF MIME handler runtime regression failed\n    ${error?.stack || error}`);
  process.exitCode = 1;
});
