import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { BidiSession } from '../../firefox-companion/session.mjs';
import { firefoxBinary } from '../firefox-binary.mjs';

// Install the real PDF modules in a disposable Firefox profile behind a local
// HTTP proxy. Firefox reports that proxy's socket IP in webRequest; destination
// DNS validation must permit public PDFs and still reject private destinations.
const root = path.resolve(process.env.WEBBRAIN_TEST_ROOT || '.');
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'webbrain-pdf-proxy-firefox-'));
const profile = path.join(temporary, 'profile');
const extension = path.join(temporary, 'extension');
await fs.mkdir(profile);
const copied = new Set();
async function copy(relative) {
  if (copied.has(relative)) return;
  copied.add(relative);
  const bytes = await fs.readFile(path.join(root, 'src/firefox', relative));
  const destination = path.join(extension, relative);
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.writeFile(destination, bytes);
  for (const match of bytes.toString().matchAll(/^import\s+(?:[\s\S]*?)\sfrom\s+['"]([^'"]+)['"];?/gm)) {
    await copy(path.posix.normalize(path.posix.join(path.posix.dirname(relative), match[1])));
  }
}
await copy('src/agent/pdf-tools.js');
await fs.cp(path.join(root, 'src/firefox/vendor/pdfjs'), path.join(extension, 'vendor/pdfjs'), { recursive: true });
await fs.writeFile(path.join(extension, 'manifest.json'), JSON.stringify({
  manifest_version: 2, name: 'PDF proxy fixture', version: '1.0',
  permissions: ['dns', 'webRequest', 'storage', 'tabs', 'cookies', '<all_urls>'],
  background: { page: 'fixture-background.html', persistent: true },
  browser_specific_settings: { gecko: { id: 'pdf-proxy-fixture@webbrain.test' } },
}));
await fs.writeFile(path.join(extension, 'fixture-background.html'), '<script type="module" src="fixture-background.js"></script>');
await fs.writeFile(path.join(extension, 'fixture-background.js'), `
import * as pdf from './src/agent/pdf-tools.js';
globalThis.fixturePdf = pdf;
globalThis.fixtureAddresses = [];
browser.webRequest.onResponseStarted.addListener(details => {
  if (details.url.includes('/auth.pdf')) fixtureAddresses.push({ ip: details.ip, proxyType: details.proxyInfo?.type });
}, { urls: ['<all_urls>'] });
browser.tabs.create({ url: browser.runtime.getURL('fixture-harness.html') });
`);
await fs.writeFile(path.join(extension, 'fixture-harness.html'), '<!doctype html><title>PDF proxy fixture</title>');
await fs.mkdir(path.join(extension, 'src/ui'), { recursive: true });
await fs.writeFile(path.join(extension, 'src/ui/pdf-handler.html'), '<!doctype html><title>PDF viewer fixture</title>');

const requests = [];
const secret = 'FIREFOX-PROXIED-PDF';
const contents = `BT /F1 18 Tf 72 720 Td (${secret}) Tj ET`;
const objects = [
  '<< /Type /Catalog /Pages 2 0 R >>',
  '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
  '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
  '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  `<< /Length ${contents.length} >>\nstream\n${contents}\nendstream`,
];
let pdfBytes = '%PDF-1.4\n';
const offsets = objects.map((body, index) => {
  const offset = pdfBytes.length;
  pdfBytes += `${index + 1} 0 obj\n${body}\nendobj\n`;
  return offset;
});
const xref = pdfBytes.length;
pdfBytes += `xref\n0 6\n0000000000 65535 f \n${offsets.map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
const proxy = http.createServer((request, response) => {
  let url;
  try { url = new URL(request.url); } catch { response.writeHead(400).end(); return; }
  if (!['example.com', 'example.org', 'private.rebind.test'].includes(url.hostname)) {
    response.writeHead(502).end();
    return;
  }
  const hasCookie = (request.headers.cookie || '').includes('pdfsession=fixture');
  requests.push({ host: url.hostname, path: url.pathname, hasCookie });
  if (url.pathname === '/auth.pdf' && !hasCookie) { response.writeHead(401).end(); return; }
  response.writeHead(200, { 'Content-Type': 'application/pdf', 'Cache-Control': 'no-store' });
  response.end(pdfBytes);
});
await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
const proxyPort = proxy.address().port;
const prefs = {
  'network.proxy.type': 1, 'network.proxy.http': '127.0.0.1', 'network.proxy.http_port': proxyPort,
  'network.proxy.no_proxies_on': '', 'network.trr.mode': 5,
  'network.dns.localDomains': 'private.rebind.test',
  'browser.startup.homepage': 'about:blank', 'browser.shell.checkDefaultBrowser': false,
};
await fs.writeFile(path.join(profile, 'user.js'), Object.entries(prefs)
  .map(([key, value]) => `user_pref(${JSON.stringify(key)}, ${JSON.stringify(value)});`).join('\n'));
const firefox = spawn((await firefoxBinary()).binary, [
  '--headless', '--remote-allow-system-access', '--no-remote', '--profile', profile, '--remote-debugging-port', '0',
], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, MOZ_REMOTE_ALLOW_SYSTEM_ACCESS: '1' } });
let session;
try {
  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Firefox did not start BiDi')), 20000);
    let output = '';
    firefox.stderr.on('data', data => {
      output += data;
      const match = output.match(/WebDriver BiDi listening on ws:\/\/127\.0\.0\.1:(\d+)/);
      if (match) { clearTimeout(timer); resolve(Number(match[1])); }
    });
    firefox.once('error', error => { clearTimeout(timer); reject(error); });
    firefox.once('exit', code => { clearTimeout(timer); reject(new Error(`Firefox exited before BiDi (${code})`)); });
  });
  session = new BidiSession();
  const receive = session.receive.bind(session);
  session.receive = message => receive(message.type === 'error'
    ? { ...message, error: `${message.error}: ${message.message}` } : message);
  const send = session.send.bind(session);
  session.send = (method, params) => send(method, params).catch(error => { throw new Error(`${method}: ${error.message}`); });
  await session.connect(port);
  await session.send('webExtension.install', { extensionData: { type: 'path', path: extension } });
  let harness;
  for (let attempt = 0; attempt < 100 && !harness; attempt++) {
    const tree = await session.send('browsingContext.getTree', {});
    harness = tree.contexts.find(item => item.url?.endsWith('/fixture-harness.html'));
    if (!harness) await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.ok(harness, 'The installed extension must open its harness.');
  const evaluate = async expression => {
    const result = await session.send('script.evaluate', { target: { context: harness.context }, expression, awaitPromise: true });
    if (result.type === 'exception') throw new Error(result.exceptionDetails.text);
    return JSON.parse(result.result.value);
  };
  const result = await evaluate(`(async () => {
    const background = await browser.runtime.getBackgroundPage();
    const pdf = background.fixturePdf;
    await browser.cookies.set({ url: 'http://example.com/', name: 'pdfsession', value: 'fixture' });
    await browser.cookies.set({ url: 'http://example.org/', name: 'pdfsession', value: 'fixture' });
    const viewer = url => browser.runtime.getURL('src/ui/pdf-handler.html') + '?url=' + encodeURIComponent(url);
    const tab = await browser.tabs.create({ url: viewer('http://example.com/auth.pdf') });
    for (let n = 0; n < 100; n++) {
      if ((await browser.tabs.get(tab.id)).url?.includes('pdf-handler.html?')) break;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    const read = async (url, options = {}) => {
      try { return await pdf.extractPdfText(url, options, { tabId: tab.id }); }
      catch (error) { return { success: false, error: error.message }; }
    };
    // Ask for the Claude document copy: PDF.js hands the fetched buffer to
    // its real Worker here, which detaches the original array.
    const sameSite = await read('http://example.com/auth.pdf', { includeDocument: true });
    const documentBytes = sameSite._pdfBytes;
    const crossSite = await read(viewer('http://example.org/auth.pdf'));
    const blocked = await read('http://private.rebind.test/private.pdf');
    return JSON.stringify({
      sameSite: {
        success: sameSite.success, pages: sameSite.pages, error: sameSite.error, byteLength: sameSite.byteLength,
        documentLength: documentBytes?.length ?? null,
        documentMatches: !!documentBytes && new TextDecoder().decode(documentBytes) === ${JSON.stringify(pdfBytes)},
      },
      crossSite, blocked, addresses: background.fixtureAddresses,
    });
  })()`);
  assert.equal(result.sameSite.success, true, result.sameSite.error);
  assert.match(result.sameSite.pages.join(' '), new RegExp(secret));
  assert.equal(result.sameSite.byteLength, pdfBytes.length, 'byteLength must survive PDF.js detaching the fetched bytes.');
  assert.equal(result.sameSite.documentLength, pdfBytes.length, 'The Claude document copy must not be a detached, empty array.');
  assert.equal(result.sameSite.documentMatches, true, 'The Claude document copy must be the fetched PDF.');
  assert.equal(result.crossSite.success, false);
  assert.match(result.crossSite.error, /HTTP 401/);
  assert.equal(result.blocked.success, false);
  assert.match(result.blocked.error, /resolved to a blocked address.*127\.0\.0\.1/);
  assert.ok(result.addresses.some(details => details.ip === '127.0.0.1' && details.proxyType === 'http'), 'Firefox must report the actual local proxy socket.');
  assert.deepEqual(requests, [
    { host: 'example.com', path: '/auth.pdf', hasCookie: true },
    { host: 'example.org', path: '/auth.pdf', hasCookie: false },
  ], 'Blocked destinations must never reach the proxy.');
  console.log(JSON.stringify({ passed: true, installedFirefox: true, requests, result }, null, 2));
} finally {
  await session?.close();
  firefox.kill();
  await new Promise(resolve => proxy.close(resolve));
  await fs.rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
