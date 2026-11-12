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
  const requests = [];
  const sendPdf = (response, filename) => {
    response.writeHead(200, {
      'content-type': pdfMimeType,
      'content-length': String(pdf.byteLength),
      'content-disposition': `inline; filename="${filename}"`,
      'cache-control': 'no-store',
    });
    response.end(pdf);
  };
  const server = createServer((request, response) => {
    const url = new URL(request.url || '/', 'http://127.0.0.1');
    requests.push(`${request.method} ${url.pathname}`);
    // The same PDF from a URL that reveals nothing about its type, behind a
    // server that refuses HEAD. A Content-Type probe learns nothing here, so
    // this endpoint is what proves the handler page is recognized without one.
    if (url.pathname === '/opaque-download') {
      if (request.method === 'HEAD') {
        response.writeHead(405).end();
        return;
      }
      sendPdf(response, 'document.pdf');
      return;
    }
    if (url.pathname !== '/document.pdf') {
      response.writeHead(404).end('not found');
      return;
    }
    requestCount += 1;
    sendPdf(response, 'document.pdf');
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
    requests,
    address: address.address,
    url: `http://127.0.0.1:${address.port}/document.pdf`,
    opaqueUrl: `http://127.0.0.1:${address.port}/opaque-download?id=42`,
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

// The fixture server listens on loopback, which read_pdf refuses until the user
// turns on "Allow agent to access local network". Flip that switch the way a
// user does, on the Settings page, and wait for the stored value to follow.
async function setLocalNetworkToggle(page, enabled) {
  await page.evaluate(expected => {
    const toggle = document.getElementById('toggle-allow-local-network');
    if (!(toggle instanceof HTMLInputElement)) throw new Error('Local network toggle is unavailable.');
    if (toggle.checked !== expected) toggle.click();
  }, enabled);
  await page.waitForFunction(async expected => {
    const stored = await chrome.storage.local.get('agentAllowLocalNetwork');
    return (stored.agentAllowLocalNetwork === true) === expected;
  }, enabled, { timeout: 10_000 });
}

// Stands in for the service worker's half of read_pdf, `extractPdfText` in
// src/agent/pdf-tools.js, which cannot be loaded here: dynamic import() is
// disallowed on ServiceWorkerGlobalScope. Like that caller it forwards the
// user's local-network setting to the offscreen host and, because offscreen
// documents have no webRequest, answers the host's verdict request from the
// address Chrome reports for the fetch.
async function extractPdfFromBackground(background, url, expectedAddress) {
  return background.evaluate(async ({ url, expectedAddress }) => {
    const stored = await chrome.storage.local.get('agentAllowLocalNetwork');
    const requestId = crypto.randomUUID();
    let reportAddress;
    const connected = new Promise(resolve => { reportAddress = resolve; });
    const onResponseStarted = details => {
      if (details.url === url) reportAddress(details.ip || '');
    };
    const onVerdictRequest = (message, _sender, sendResponse) => {
      if (message?.type !== 'offscreen-pdf-fetch-verdict' || message.requestId !== requestId) return false;
      // fetch() can resolve in the offscreen document before the matching
      // webRequest event reaches the worker, so allow it a moment to arrive.
      Promise.race([connected, new Promise(resolve => setTimeout(resolve, 1500, ''))]).then(address => {
        sendResponse(address === expectedAddress
          ? { ok: true }
          : { ok: false, error: `PDF response address was ${address || 'not reported'}, expected ${expectedAddress}.` });
      });
      return true;
    };
    chrome.webRequest.onResponseStarted.addListener(onResponseStarted, { urls: ['<all_urls>'], tabId: -1 });
    chrome.runtime.onMessage.addListener(onVerdictRequest);
    try {
      return await chrome.runtime.sendMessage({
        type: 'offscreen-pdf-extract',
        requestId,
        url,
        options: {
          fromPage: 1,
          toPage: 1,
          maxChars: 5000,
          includeBase64: true,
          allowLocalNetwork: stored.agentAllowLocalNetwork === true,
        },
      });
    } finally {
      chrome.runtime.onMessage.removeListener(onVerdictRequest);
      chrome.webRequest.onResponseStarted.removeListener(onResponseStarted);
    }
  }, { url, expectedAddress });
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

// `read_page` cannot use the content-script path on our own PDF viewer, so it
// redirects to `read_pdf`. That redirect hinges on `_isPdfTab` recognizing the
// handler page. Recognizing it by URL pattern alone is not enough: the wrapped
// URL may reveal nothing about its type, and the Content-Type probe that used
// to decide those cases is a HEAD request servers are free to reject. We only
// ever open the handler for a response already identified as a PDF, so the
// page itself is the signal, and no probe should be issued.
async function assertHandlerTabSkipsContentTypeProbe(context, settings, extensionId, fixture) {
  const sourceUrl = fixture.opaqueUrl;
  // Capture Chrome's tab ID when creating it. A PDF target may be replaced by
  // the native viewer before Playwright's Page and chrome.tabs snapshots agree.
  const tabId = await settings.evaluate(async url => (await chrome.tabs.create({ url, active: false })).id, sourceUrl);
  assert.ok(Number.isInteger(tabId) && tabId > 0, 'Could not create the tab showing the opaque PDF.');
  try {
    await settings.waitForFunction(async ({ id, url }) => (await chrome.tabs.get(id)).url === url,
      { id: tabId, url: sourceUrl }, { timeout: 15_000 });

    // Chrome's native PDF document exposes its real MIME even when the URL
    // is extensionless and the server refuses HEAD. Inspect that document
    // before replacing it with our own viewer; neither route may re-fetch it.
    await settings.waitForFunction(async ({ id, url }) => {
      const { Agent } = await import(chrome.runtime.getURL('src/agent/agent.js'));
      const agent = Object.create(Agent.prototype);
      agent._isPdfTabCache = new Map();
      return agent._isPdfTab(id, url);
    }, { id: tabId, url: sourceUrl }, { timeout: 15_000 });
    assert.equal(fixture.requests.some(entry => entry.startsWith('HEAD')), false,
      'Recognizing the extensionless native PDF must use the already-loaded document MIME.');

    // Exactly what the "Open PDF with WebBrain" context menu does. That entry
    // is the only route to a wrapped handler URL, and it appears because the
    // response was application/pdf, not because the URL looked like a PDF.
    const handlerUrl = await settings.evaluate(async ({ id, url }) => {
      const viewerUrl = chrome.runtime.getURL(
        `src/ui/pdf-handler.html?url=${encodeURIComponent(url)}&tabId=${encodeURIComponent(id)}`,
      );
      await chrome.tabs.update(id, { url: viewerUrl });
      return viewerUrl;
    }, { id: tabId, url: sourceUrl });

    await settings.waitForFunction(async ({ id, expected }) => {
      const tab = await chrome.tabs.get(id);
      return tab?.url === expected;
    }, { id: tabId, expected: handlerUrl }, { timeout: 15_000 });

    const requestsBefore = fixture.requests.length;

    // Dynamic import() is disallowed on ServiceWorkerGlobalScope, so the
    // settings page stands in: same extension origin, same chrome.* APIs.
    // Running here also exercises the origin comparison in
    // `unwrapPdfHandlerUrl` for real. Node's URL parser reports `origin` as
    // the string "null" for every chrome-extension:// URL, so the unit tests
    // cannot tell our handler from another extension's.
    const helpers = await settings.evaluate(async ({ url, source }) => {
      const module = await import(chrome.runtime.getURL('src/agent/pdf-extraction.js'));
      return {
        handlerTab: module.isPdfHandlerTabUrl(url),
        unwrapped: module.pdfUrlFromTabUrl(url),
        foreignExtension: module.isPdfHandlerTabUrl(
          'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/src/ui/pdf-handler.html?url=http://example.invalid/x.pdf',
        ),
        ordinaryPage: module.isPdfHandlerTabUrl('https://example.invalid/'),
      };
    }, { url: handlerUrl, source: sourceUrl });
    assert.equal(helpers.handlerTab, true, 'isPdfHandlerTabUrl did not recognize our own handler tab.');
    assert.equal(helpers.unwrapped, sourceUrl, 'The handler tab did not unwrap to its source URL.');
    assert.equal(helpers.foreignExtension, false, 'A foreign extension id was accepted as our PDF handler.');
    assert.equal(helpers.ordinaryPage, false, 'An ordinary page was treated as a PDF handler tab.');

    const isPdfTab = await settings.evaluate(async ({ id, url }) => {
      const { Agent } = await import(chrome.runtime.getURL('src/agent/agent.js'));
      // Object.create skips the constructor; _isPdfTab only needs this cache.
      const agent = Object.create(Agent.prototype);
      agent._isPdfTabCache = new Map();
      return agent._isPdfTab(id, url);
    }, { id: tabId, url: handlerUrl });
    assert.equal(isPdfTab, true, '_isPdfTab did not recognize the PDF handler tab.');

    // The viewer legitimately GETs the PDF to render it; what must not appear
    // is a HEAD, which is how the routing decision used to be made.
    const probesDuring = fixture.requests.slice(requestsBefore).filter(entry => entry.startsWith('HEAD'));
    assert.deepEqual(probesDuring, [], `Recognizing the handler tab issued a probe: ${probesDuring.join(', ')}`);
    assert.equal(
      fixture.requests.some(entry => entry.startsWith('HEAD')),
      false,
      `The handler tab triggered a Content-Type probe: ${fixture.requests.join(', ')}`,
    );
  } finally {
    await settings.evaluate(id => chrome.tabs.remove(id), tabId);
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

    // Fresh installs keep local-network access off, so the loopback fixture
    // must be refused before any request leaves the browser.
    const blocked = await extractPdfFromBackground(background, fixture.url, fixture.address);
    assert.equal(blocked?.ok, false, 'A loopback PDF was extracted while local-network access was off.');
    assert.match(blocked?.error || '', /Blocked loopback IPv4: 127\.0\.0\.1/);
    assert.equal(fixture.requestCount(), 0, 'A blocked loopback PDF request reached the network.');

    await setLocalNetworkToggle(settings, true);
    const requestsBeforeExtraction = fixture.requestCount();
    const extraction = await extractPdfFromBackground(background, fixture.url, fixture.address);
    // The rest of this file covers default PDF routing; leave no opt-in behind.
    await setLocalNetworkToggle(settings, false);
    assert.equal(extraction?.ok, true, extraction?.error || 'The offscreen PDF parser failed.');
    assert.equal(fixture.requestCount() - requestsBeforeExtraction, 1, 'Claude-compatible extraction fetched the PDF more than once.');
    assert.equal(extraction.result?.totalPages, 1);
    assert.equal(extraction.result?.byteLength, fixture.pdf.byteLength);
    assert.match(extraction.result?.pages?.[0] || '', /WebBrain PDF MIME handler test/);
    assert.deepEqual(Buffer.from(extraction.result?._pdfBase64 || '', 'base64'), fixture.pdf);

    await waitForNativeHandlerOption(settings, true);
    // Installation initially registers public MIME handlers as enabled. Allow
    // the post-registration reconciliation pass to settle before navigating.
    await settings.waitForTimeout(750);
    const initialState = await settings.evaluate(async () => ({
      stored: await chrome.storage.local.get(['pdfViewerEnabled']),
      checked: document.getElementById('toggle-pdf-viewer')?.checked,
    }));
    assert.equal(initialState.stored.pdfViewerEnabled, undefined, 'Fresh installs must preserve an unset WebBrain PDF setting.');
    assert.equal(initialState.checked, true, 'The PDF viewer toggle must render on by default.');

    const enabledByDefaultRouting = await inspectPdfRouting(context, `${fixture.url}?mode=enabled-by-default`, extensionId);
    assert.equal(enabledByDefaultRouting.sawWebBrainHandler, true, `Default PDF handling did not enter WebBrain: ${enabledByDefaultRouting.urls.join(', ')}`);

    await setPdfViewerToggle(settings, false);
    await waitForNativeHandlerOption(settings, false);
    const disabledAgainRouting = await inspectPdfRouting(context, `${fixture.url}?mode=disabled-again`, extensionId);
    assert.equal(disabledAgainRouting.sawWebBrainHandler, false, `Turning PDF handling off still entered WebBrain: ${disabledAgainRouting.urls.join(', ')}`);
    assert.equal(disabledAgainRouting.sawNativeHandler, true, `Turning PDF handling off did not restore Chrome's native viewer: ${disabledAgainRouting.urls.join(', ')}`);
    console.log(`  ✓ Chrome ${browser.version()} keeps native PDF routing aligned with the WebBrain toggle`);

    await assertHandlerTabSkipsContentTypeProbe(context, settings, extensionId, fixture);
    console.log('  ✓ read_page routing recognizes a PDF handler tab without a Content-Type probe');
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
