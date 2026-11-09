import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';

// Chrome has no DNS API for extensions, so these tools rely on webRequest
// reporting details.ip for service-worker fetches, hidden tabs, and offscreen
// PDF fetches authorized by the service worker. This runs the real Chrome
// network tools in a disposable browser whose resolver maps a public-looking
// name onto this loopback server, the DNS answer the URL text cannot reveal.
const root = path.resolve(process.env.WEBBRAIN_TEST_ROOT || '.');
const out = await fs.mkdtemp(path.join(os.tmpdir(), 'webbrain-resolved-address-'));
const extension = path.join(out, 'extension');
const profile = path.join(out, 'profile');
const copied = new Set();
async function copy(relative) {
  if (copied.has(relative)) return;
  copied.add(relative);
  const bytes = await fs.readFile(path.join(root, 'src/chrome', relative));
  const dest = path.join(extension, relative);
  await fs.mkdir(path.dirname(dest), { recursive: true });
  await fs.writeFile(dest, bytes);
  for (const m of bytes.toString().matchAll(/^import\s+(?:[\s\S]*?)\sfrom\s+['"]([^'"]+)['"];?/gm)) {
    await copy(path.posix.normalize(path.posix.join(path.posix.dirname(relative), m[1])));
  }
}
await copy('src/network/network-tools.js');
await copy('src/agent/pdf-tools.js');
await copy('src/offscreen/pdf-extraction-host.js');
await fs.cp(path.join(root, 'src/chrome/vendor/pdfjs'), path.join(extension, 'vendor/pdfjs'), { recursive: true });
await fs.writeFile(path.join(extension, 'src/offscreen/offscreen.html'),
  '<!doctype html><script type="module" src="pdf-extraction-host.js"></script>');
await fs.mkdir(path.join(extension, 'src/ui'), { recursive: true });
await fs.writeFile(path.join(extension, 'src/ui/pdf-handler.html'), '<!doctype html><title>PDF viewer fixture</title>');
await fs.writeFile(path.join(extension, 'manifest.json'), JSON.stringify({
  manifest_version: 3, name: 'Resolved address fixture', version: '1.0',
  permissions: ['storage', 'tabs', 'scripting', 'webRequest', 'offscreen'], host_permissions: ['<all_urls>'],
  background: { service_worker: 'src/background.js', type: 'module' },
}));
await fs.writeFile(path.join(extension, 'src/background.js'),
  "import * as network from './network/network-tools.js'; import * as pdf from './agent/pdf-tools.js'; globalThis.network = network; globalThis.pdf = pdf;");

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

const secret = 'LOOPBACK-ADMIN-SECRET';
const pdfBytes = buildSinglePagePdf(secret);
const pdfHits = [];
const hits = [];
let port;
const server = http.createServer((req, res) => {
  hits.push(req.url);
  if (req.url.endsWith('.pdf')) {
    const hasCookie = (req.headers.cookie || '').includes('pdfsession=fixture');
    pdfHits.push({ host: req.headers.host, path: req.url, hasCookie });
    if (req.url === '/auth.pdf' && !hasCookie) {
      res.writeHead(401).end();
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/pdf', 'Cache-Control': 'no-store' });
    res.end(pdfBytes);
    return;
  }
  if (req.url === '/redirect') {
    res.writeHead(302, { Location: `http://public.rebind.test:${port}/admin` });
    return res.end();
  }
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end(`<!doctype html><title>Admin</title><main>${secret}</main>`);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
port = server.address().port;

let browser;
let chrome;
const rows = [];
try {
  chrome = spawn(chromium.executablePath(), [
    '--headless=new', '--no-sandbox', '--no-first-run', '--no-default-browser-check',
    '--disable-background-networking', '--no-proxy-server', `--user-data-dir=${profile}`,
    '--remote-debugging-port=0', `--disable-extensions-except=${extension}`, `--load-extension=${extension}`,
    '--host-resolver-rules=MAP public.rebind.test 127.0.0.1, MAP other-site.test 127.0.0.1, MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1',
    'about:blank',
  ], { windowsHide: true, stdio: 'ignore' });
  let endpoint;
  for (let n = 0; n < 100 && !endpoint; n++) {
    try {
      const [p, u] = (await fs.readFile(path.join(profile, 'DevToolsActivePort'), 'utf8')).trim().split(/\r?\n/);
      endpoint = `ws://127.0.0.1:${p}${u}`;
    } catch { await new Promise(r => setTimeout(r, 100)); }
  }
  assert.ok(endpoint, 'disposable browser endpoint');
  browser = await chromium.connectOverCDP(endpoint);
  const context = browser.contexts()[0];
  const worker = context.serviceWorkers().find(w => w.url().endsWith('/src/background.js'))
    || await context.waitForEvent('serviceworker', { predicate: w => w.url().endsWith('/src/background.js') });
  for (let n = 0; n < 100 && !(await worker.evaluate(() => Boolean(globalThis.network))); n++) {
    await new Promise(r => setTimeout(r, 100));
  }

  const admin = `http://public.rebind.test:${port}/admin`;
  const run = (tool, url) => worker.evaluate(({ tool, url }) => (
    tool === 'read_pdf' ? pdf.extractPdfText(url).catch(error => ({ success: false, error: error.message }))
      : tool === 'fetch_url' ? network.fetchUrl(url)
      : tool === 'read_page_source' ? network.readPageSource(url)
        : network.researchUrl(url, { timeout: 10000 })
  ), { tool, url });
  const openTabs = () => worker.evaluate(() => chrome.tabs.query({}).then(tabs => tabs.length));
  const tabsBefore = await openTabs();

  for (const [tool, url] of [
    ['read_pdf', `http://public.rebind.test:${port}/private.pdf`],
    ['fetch_url', admin],
    ['read_page_source', admin],
    ['research_url', admin],
    ['research_url', `http://public.rebind.test:${port}/redirect`],
  ]) {
    const before = hits.length;
    const result = await run(tool, url);
    rows.push({ tool, url, allowLocalNetwork: false, success: result.success, error: result.error, requests: hits.slice(before) });
    assert.equal(result.success, false, `${tool} ${url}: a name resolving to loopback must be blocked`);
    assert.match(result.error, /^public\.rebind\.test resolved to a blocked address\. Blocked loopback IPv4: 127\.0\.0\.1/);
    assert.doesNotMatch(JSON.stringify(result), new RegExp(secret), `${tool}: loopback content must not be returned`);
  }
  assert.equal(await openTabs(), tabsBefore, 'research_url must close its hidden tab');

  // The user's local-network opt-in relaxes the resolved address as it does
  // a loopback literal.
  await worker.evaluate(() => chrome.storage.local.set({ agentAllowLocalNetwork: true }));
  for (let n = 0; n < 50 && !(await worker.evaluate(() => network.getAllowLocalNetwork())); n++) {
    await new Promise(r => setTimeout(r, 50));
  }
  for (const tool of ['fetch_url', 'read_page_source', 'research_url']) {
    const result = await run(tool, admin);
    rows.push({ tool, url: admin, allowLocalNetwork: true, success: result.success, error: result.error });
    assert.equal(result.success, true, `${tool}: local-network access should permit loopback (${result.error || ''})`);
    assert.match(JSON.stringify(result), new RegExp(secret), `${tool}: permitted content should be returned`);
  }
  // The offscreen document exposes runtime only: this proves the address
  // decision really came from the service worker, not a mocked offscreen API.
  const offscreen = context.pages().find(p => p.url().endsWith('/src/offscreen/offscreen.html'));
  if (offscreen) assert.equal(await offscreen.evaluate(() => typeof chrome.webRequest), 'undefined');
  const primary = `http://public.rebind.test:${port}`;
  const foreign = `http://other-site.test:${port}`;
  await context.addCookies([
    { name: 'pdfsession', value: 'fixture', url: primary, sameSite: 'Lax' },
    { name: 'pdfsession', value: 'fixture', url: foreign, sameSite: 'Lax' },
  ]);
  const tabId = await worker.evaluate(async url => {
    const tab = await chrome.tabs.create({ url: chrome.runtime.getURL('src/ui/pdf-handler.html') + '?url=' + encodeURIComponent(url) });
    return tab.id;
  }, `${primary}/auth.pdf`);
  for (let n = 0; n < 100; n++) {
    const tab = await worker.evaluate(tabId => chrome.tabs.get(tabId), tabId);
    if (tab.url?.includes('pdf-handler.html?')) break;
    await new Promise(r => setTimeout(r, 25));
  }
  assert.equal(await worker.evaluate(async tabId => {
    const tab = await chrome.tabs.get(tabId);
    return pdf.pdfFetchCredentials(tab.url, tabId);
  }, tabId), 'include');
  const readPdf = (url, options = {}) => worker.evaluate(async ({ url, tabId, options }) => {
    try { return await pdf.extractPdfText(url, { tabId, includeDocument: true, ...options }); }
    catch (error) { return { success: false, error: error.message }; }
  }, { url, tabId, options });
  const wrapped = await worker.evaluate(url => chrome.runtime.getURL('src/ui/pdf-handler.html') + '?url=' + encodeURIComponent(url), `${foreign}/auth.pdf`);
  const authenticated = await readPdf(`${primary}/auth.pdf`);
  assert.equal(authenticated.success, true, `Viewer-tab same-document read: ${authenticated.error}`);
  assert.match(authenticated.pages.join(' '), new RegExp(secret));
  assert.deepEqual(Buffer.from(authenticated._pdfBase64, 'base64'), Buffer.from(pdfBytes));
  const crossSite = await readPdf(wrapped);
  assert.equal(crossSite.success, false);
  assert.match(crossSite.error, /HTTP 401/);
  assert.deepEqual(pdfHits.slice(-2).map(hit => hit.hasCookie), [true, false]);
  rows.push({ tool: 'read_pdf', case: 'viewer authenticated same document', success: authenticated.success });
  rows.push({ tool: 'read_pdf', case: 'viewer wrapped cross-site request', error: crossSite.error, cookiesSent: false });
  // Re-disable local access while reusing the same offscreen document. Neither
  // extracted text nor the Claude byte attachment may escape on a later read.
  await worker.evaluate(() => chrome.storage.local.set({ agentAllowLocalNetwork: false }));
  for (let n = 0; n < 50 && await worker.evaluate(() => network.getAllowLocalNetwork()); n++) {
    await new Promise(r => setTimeout(r, 50));
  }
  const denied = await readPdf(`${primary}/private.pdf`);
  assert.equal(denied.success, false);
  assert.match(denied.error, /resolved to a blocked address/);
  assert.doesNotMatch(JSON.stringify(denied), new RegExp(secret));
  assert.equal(denied._pdfBase64, undefined);
  rows.push({ tool: 'read_pdf', case: 'warm offscreen denied response', error: denied.error });
  console.log(JSON.stringify({ passed: true, chrome: browser.version(), rows, pdfHits }, null, 2));
} catch (error) {
  console.log(JSON.stringify({ passed: false, error: String(error.stack || error), rows, pdfHits }, null, 2));
  process.exitCode = 1;
} finally {
  await browser?.close().catch(() => {});
  if (chrome && !chrome.killed) chrome.kill();
  await new Promise(resolve => server.close(resolve));
  await fs.rm(out, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {});
}
