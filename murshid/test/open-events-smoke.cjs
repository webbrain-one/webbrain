'use strict';
// Run under Electron with MURSHID_PROFILE pointing to a disposable directory.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { pathToFileURL } = require('node:url');
const { app } = require('electron');
app.commandLine.appendSwitch('host-resolver-rules', 'MAP public.example 127.0.0.1');
const file = path.join(process.env.MURSHID_PROFILE, 'test file.html');
fs.writeFileSync(file, '<!doctype html><title>isolated fixture</title>');
const requestHeaders = new Map();
const server = http.createServer((req, res) => {
  requestHeaders.set(req.url, req.headers);
  if (req.url === '/download-abort') { req.socket.destroy(); return; }
  if (req.url === '/early') res.setHeader('Accept-CH', 'Sec-CH-UA-Arch');
  if (req.url.startsWith('/tab-')) res.setHeader('X-Murshid-Fixture', 'ordinary-tab');
  if (req.url === '/download-redirect') { res.writeHead(302, { location: '/download-final', 'Set-Cookie': 'fixture-secret=value; HttpOnly; Secure; SameSite=Lax' }); res.end(); return; }
  if (req.url === '/download-cross-origin') { res.writeHead(302, { location: 'http://example.invalid/other' }); res.end(); return; }
  if (req.url === '/address-redirect') { res.writeHead(302, { location: '/address-final', 'Access-Control-Allow-Origin': '*' }); res.end(); return; }
  if (req.url === '/address-error') { req.socket.destroy(); return; }
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.end(req.url === '/download-final' ? 'download fixture' : '<!doctype html><title>isolated fixture</title>');
});
server.listen(0, '127.0.0.1', () => {
const base = `http://127.0.0.1:${server.address().port}`;
const { ctx } = require('../app/main');
const event = () => ({ preventDefault() { this.prevented = true; } });
const earlyUrl = event(); const earlyFile = event();
app.emit('open-url', earlyUrl, `${base}/early`);
app.emit('open-file', earlyFile, file);
assert(earlyUrl.prevented && earlyFile.prevented);
const waitFor = async (condition) => {
  for (let i = 0; i < 150; i++) { if (await condition()) return; await new Promise(r => setTimeout(r, 100)); }
  throw new Error('Timed out waiting for browser state');
};
(async () => {
  try {
    const urls = () => ctx.windows.flatMap(w => w.tabs.map(t => t.url));
    await waitFor(() => urls().includes(`${base}/early`) && urls().includes(pathToFileURL(file).href));
    await waitFor(() => requestHeaders.has('/early'));
    assert.match(requestHeaders.get('/early')?.['sec-ch-ua'] || '', /Murshid/);
    const late = event(); app.emit('open-url', late, `${base}/late`);
    await waitFor(() => urls().includes(`${base}/late`));
    assert(late.prevented);
    console.log('Early and late macOS open events reached isolated tabs');
    const bridge = ctx.crx, extId = ctx.webBrainId;
    ctx.downloads.folder = () => process.env.MURSHID_PROFILE;
    const ordinaryTab = ctx.windows[0].tabs.find(t => t.url === `${base}/late`);
    await waitFor(() => ordinaryTab && !ordinaryTab.wc.isLoading());
    await ordinaryTab.wc.executeJavaScript("fetch('/hints-check')");
    assert(requestHeaders.get('/hints-check')?.['sec-ch-ua-arch'], 'Accept-CH should still enable high-entropy hints');
    const privateExtensionUrl = `chrome-extension://${extId}/src/offscreen/skill-download.js`;
    const access = await ordinaryTab.wc.executeJavaScript(`fetch(${JSON.stringify(privateExtensionUrl)}).then(r => r.ok).catch(() => false)`);
    assert.equal(access, false, 'a website must not fetch a private extension resource');
    await bridge.handlers['offscreen.createDocument'].call(bridge, { extId }, { url: 'src/offscreen/offscreen.html' });
    const getOffscreen = () => bridge.handlers['runtime.getContexts'].call(bridge, { extId }, { contextTypes: ['OFFSCREEN_DOCUMENT'] })[0];
    const offscreenWindow = bridge.offscreen.get(extId);
    const firstIdentity = getOffscreen()?.documentId;
    assert(firstIdentity, 'offscreen context should expose the native document identity');
    await bridge.forwardOffscreenRequest('onBeforeRequest', {
      id: 123456789, url: `${base}/download-redirect`, method: 'GET', resourceType: 'xhr',
      initiatorOrigin: `chrome-extension://${extId}`, webContentsId: offscreenWindow.webContents.id,
      frame: { frameToken: 'wrong-frame', url: offscreenWindow.webContents.getURL() },
    });
    assert.equal(bridge.offscreenRequests.has('123456789'), false, 'another frame must not be bound to the offscreen identity');
    // Only a current worker response to the pending nonce may establish an identity.
    assert.throws(() => bridge.handlers['murshid.registerOffscreenIdentity'].call(bridge,
      { extId, worker: {} }, { nonce: 'wrong', documentId: firstIdentity, url: offscreenWindow.webContents.getURL(), frameId: 0 }));
    assert.equal(getOffscreen().documentId, firstIdentity);
    const identityState = bridge.offscreenIdentity.get(extId);
    identityState.pending = { nonce: 'test-nonce', generation: identityState.generation,
      url: offscreenWindow.webContents.getURL(), resolve() {} };
    const nativeReply = await offscreenWindow.webContents.executeJavaScript("chrome.runtime.sendMessage({type:'murshid-offscreen-document-identity', nonce:'test-nonce'})");
    assert.equal(nativeReply.documentId, firstIdentity, 'context identity must come from the native sender');
    if (process.env.MURSHID_TEST_CDP_PORT) {
      const list = await (await fetch(`http://127.0.0.1:${process.env.MURSHID_TEST_CDP_PORT}/json/list`)).json();
      const target = list.find(t => t.type === 'service_worker' && t.url === `chrome-extension://${extId}/src/background.js`);
      assert(target, 'WebBrain worker should expose its debugging target');
      const socket = new WebSocket(target.webSocketDebuggerUrl);
      await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
      const evaluate = (expression) => new Promise((resolve, reject) => {
        const id = Math.floor(Math.random() * 1e9);
        const listener = e => { const data = JSON.parse(e.data); if (data.id !== id) return; socket.removeEventListener('message', listener); if (data.error || data.result.exceptionDetails) reject(new Error(JSON.stringify(data.error || data.result.exceptionDetails))); else resolve(data.result.result.value); };
        socket.addEventListener('message', listener);
        socket.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }));
      });
      const stagingSource = fs.readFileSync(path.join(__dirname, '../../src/chrome/src/network/download-staging.js'), 'utf8').replace(/^export /gm, '');
      await evaluate(`(() => {
        globalThis.addressEvents = [];
        globalThis.addressListeners = ['onBeforeRedirect', 'onResponseStarted', 'onErrorOccurred'].map(name => {
          const fn = details => { if (details.url.includes('/address-')) addressEvents.push({ event: name, ...details }); };
          chrome.webRequest[name].addListener(fn, {urls:['<all_urls>']}); return [name, fn];
        });
      })()`);
      await ordinaryTab.wc.executeJavaScript(`fetch(${JSON.stringify(base + '/address-redirect')}).then(r => r.text())`);
      await evaluate(`fetch(${JSON.stringify(base + '/address-final')}).then(r => r.text())`);
      await evaluate(`fetch(${JSON.stringify(base + '/address-error')}).catch(() => {})`);
      await waitFor(async () => { const e = await evaluate('addressEvents'); return e.filter(x => x.event === 'onResponseStarted').length >= 2 && e.some(x => x.event === 'onErrorOccurred'); });
      const addressEvents = await evaluate('addressEvents');
      const tabRedirect = addressEvents.find(e => e.event === 'onBeforeRedirect' && e.tabId === ordinaryTab.id);
      const tabResponse = addressEvents.find(e => e.event === 'onResponseStarted' && e.tabId === ordinaryTab.id);
      const workerResponse = addressEvents.find(e => e.event === 'onResponseStarted' && e.tabId === -1);
      assert.equal(tabRedirect?.ip, '127.0.0.1');
      assert.equal(tabResponse?.ip, '127.0.0.1');
      assert.equal(workerResponse?.ip, '127.0.0.1');
      assert.equal(addressEvents.find(e => e.event === 'onErrorOccurred')?.tabId, -1);
      assert.equal(tabRedirect.redirectUrl, `${base}/address-final`);
      await evaluate('addressListeners.forEach(([name, fn]) => chrome.webRequest[name].removeListener(fn))');
      await evaluate("chrome.storage.local.set({agentAllowLocalNetwork:false})");
      const publicLookingUrl = `http://public.example:${server.address().port}/address-final`;
      const networkSource = fs.readFileSync(path.join(__dirname, '../../src/chrome/src/network/network-tools.js'), 'utf8');
      const guardSource = networkSource.slice(networkSource.indexOf('export function validateFetchUrl('), networkSource.indexOf('// ─── Same-eTLD+1 cookie policy'))
        .replace(/^export /gm, '');
      await evaluate(`(() => { ${guardSource}\n globalThis.testWatchFetchAddresses = watchFetchAddresses; globalThis.testWatchResponseAddresses = watchResponseAddresses; globalThis.testValidateFetchUrl = validateFetchUrl; })()`);
      assert.equal((await evaluate(`testValidateFetchUrl(${JSON.stringify(publicLookingUrl)}, {allowLocalNetwork:false})`)).ok, true);
      const blockedAddress = await evaluate(`(async () => { const watcher = testWatchFetchAddresses(${JSON.stringify(publicLookingUrl)}, false); try { await fetch(${JSON.stringify(publicLookingUrl)}); return await watcher.settledFailure('fetch'); } finally { watcher.close(); } })()`);
      assert.match(blockedAddress, /blocked address/i, String(blockedAddress));
      const allowedAddress = await evaluate(`(async () => { const watcher = testWatchFetchAddresses(${JSON.stringify(publicLookingUrl)}, true); try { await fetch(${JSON.stringify(publicLookingUrl)}); return await watcher.settledFailure('fetch'); } finally { watcher.close(); } })()`);
      assert.equal(allowedAddress, null);
      await evaluate("globalThis.testResearchWatcher = testWatchResponseAddresses({types:['main_frame']}, d => d.tabId, false)");
      const researchTab = ctx.windows[0].addTab({ url: publicLookingUrl, active: false });
      await waitFor(async () => Boolean(await evaluate(`testResearchWatcher.failure(${researchTab.id})`)));
      assert.match(await evaluate(`testResearchWatcher.failure(${researchTab.id})`), /blocked address/i);
      await evaluate('testResearchWatcher.close()');
      ctx.windows[0].closeTab(researchTab);
      console.log('Response-address events protect worker fetches and research tabs');
      await evaluate(`(() => {
        globalThis.tabRequestEvents = [];
        globalThis.tabRequestListeners = ['onBeforeRequest', 'onBeforeSendHeaders', 'onHeadersReceived'].map(name => {
          const fn = details => {
            if (!details.url.startsWith(${JSON.stringify(base + '/tab-')})) return;
            const body = details.requestBody?.raw?.map(part => part.bytes ? new TextDecoder().decode(part.bytes) : '').join('');
            tabRequestEvents.push({event:name, ...details, body});
          };
          chrome.webRequest[name].addListener(fn, {urls:['<all_urls>']}, name === 'onBeforeRequest' ? ['requestBody'] : name === 'onBeforeSendHeaders' ? ['requestHeaders'] : ['responseHeaders']);
          return [name, fn];
        });
        globalThis.tabRequestPlain = [];
        globalThis.tabRequestPlainListener = d => { if (d.url.includes('/tab-event')) tabRequestPlain.push(d); };
        chrome.webRequest.onBeforeRequest.addListener(tabRequestPlainListener, {urls:['<all_urls>'], tabId:${ordinaryTab.id}, types:['xmlhttprequest']});
      })()`);
      await evaluate("chrome.storage.local.set({apiMutationObserverEnabled:true})");
      await ordinaryTab.wc.executeJavaScript(`fetch('/tab-event', {method:'POST', headers:{'Content-Type':'application/json','X-CSRF-Token':'fixture-csrf'}, body:JSON.stringify({fixture:'body'})}).then(r => r.text())`);
      const tabEvents = await evaluate('tabRequestEvents');
      for (const event of ['onBeforeRequest', 'onBeforeSendHeaders', 'onHeadersReceived']) {
        const entries = tabEvents.filter(d => d.event === event);
        assert.equal(entries.length, 1, `${event} should reach the extension once for the ordinary tab`);
        assert.equal(entries[0].tabId, ordinaryTab.id);
        assert.equal(entries[0].frameId, 0);
        assert.equal(entries[0].type, 'xmlhttprequest');
        assert.equal(entries[0].requestId, tabEvents[0].requestId);
      }
      assert.equal(tabEvents[0].body, JSON.stringify({fixture:'body'}));
      assert(tabEvents.find(d => d.event === 'onBeforeSendHeaders').requestHeaders.some(h => h.name.toLowerCase() === 'x-csrf-token' && h.value === 'fixture-csrf'));
      assert(tabEvents.find(d => d.event === 'onHeadersReceived').responseHeaders.some(h => h.name.toLowerCase() === 'x-murshid-fixture'));
      const plainEvents = await evaluate('tabRequestPlain');
      assert.equal(plainEvents.length, 1);
      assert.equal(plainEvents[0].requestBody, undefined, 'listeners without requestBody must not receive the body');
      const apiReplay = await evaluate(`(() => {
        const entry = globalThis.__webbrainApiRequests.get(${ordinaryTab.id})?.find(d => d.url.endsWith('/tab-event'));
        return entry && {entry, replay:globalThis.__webbrainApiRequestReplay.get(entry.replayRequestId)};
      })()`);
      assert.equal(apiReplay?.replay.body, JSON.stringify({fixture:'body'}));
      assert.equal(apiReplay?.replay.headers['x-csrf-token'], 'fixture-csrf');
      const otherRequestTab = ctx.windows[0].addTab({url:`${base}/other-request-tab`});
      await waitFor(() => !otherRequestTab.wc.isLoading());
      await otherRequestTab.wc.executeJavaScript("fetch('/tab-event').then(r => r.text())");
      assert.equal((await evaluate('tabRequestPlain')).length, 1, 'tabId filters must exclude requests from other tabs');
      await ordinaryTab.wc.executeJavaScript("new Promise(resolve => { const f = document.createElement('iframe'); f.src = '/child-frame'; f.onload = resolve; document.body.append(f); })");
      await ordinaryTab.wc.mainFrame.frames[0].executeJavaScript("fetch('/tab-frame', {method:'POST',body:new Blob(['frame-body'])}).then(r => r.text())");
      const frameEvents = await evaluate("tabRequestEvents.filter(d => d.url.endsWith('/tab-frame'))");
      assert.equal(frameEvents.length, 3);
      assert(frameEvents.every(d => d.tabId === ordinaryTab.id && d.frameId > 0 && d.parentFrameId === 0));
      assert.equal(frameEvents[0].body, 'frame-body');
      await ordinaryTab.wc.loadURL(`${base}/tab-page`);
      const mainEvents = await evaluate("tabRequestEvents.filter(d => d.url.endsWith('/tab-page'))");
      assert(mainEvents.some(d => d.event === 'onHeadersReceived' && d.type === 'main_frame' && d.tabId === ordinaryTab.id));
      await evaluate(`(() => {
        for (const [name, fn] of tabRequestListeners) chrome.webRequest[name].removeListener(fn);
        chrome.webRequest.onBeforeRequest.removeListener(tabRequestPlainListener);
      })()`);
      await ordinaryTab.wc.loadURL(`${base}/late`);
      ctx.windows[0].closeTab(otherRequestTab);
      console.log('Ordinary-tab webRequest events preserve tab identity, request bodies, headers and API replay');
      const runDownload = (url) => evaluate(`(async () => {
        ${stagingSource}
        const observedEvents = [];
        const b = d => observedEvents.push({event:'before', ...d});
        const h = d => observedEvents.push({event:'headers', ...d});
        chrome.webRequest.onBeforeRequest.addListener(b, {urls:['<all_urls>']});
        chrome.webRequest.onHeadersReceived.addListener(h, {urls:['<all_urls>']}, ['responseHeaders']);
        const contexts = await chrome.runtime.getContexts({contextTypes:['OFFSCREEN_DOCUMENT']});
        const context = {documentId:contexts[0].documentId, origin:chrome.runtime.getURL('').replace(/\\/$/, ''), isCurrent:()=>true};
        const send = message => chrome.runtime.sendMessage(message);
        const transport = {start:(jobId,url)=>send({type:'authenticated-download-start',jobId,url}), status:jobId=>send({type:'authenticated-download-status',jobId}), cancel:jobId=>send({type:'authenticated-download-cancel',jobId}), forget:jobId=>send({type:'authenticated-download-forget',jobId})};
        const result = await prepareAuthenticatedDownload(${JSON.stringify(url)}, {api:chrome, transport, context, validateUrl:()=>({ok:true})});
        if (result.success) {
          const id = await chrome.downloads.download({url:result.localUrl, filename:'staged-fixture.txt'});
          for (let n=0; n<100; n++) {
            const [item] = await chrome.downloads.search({id});
            if (item?.state === 'complete' || item?.state === 'interrupted') { result.download = item; break; }
            await new Promise(r => setTimeout(r, 50));
          }
        }
        if (result.releaseToken) await send({type:'authenticated-download-release',releaseToken:result.releaseToken});
        chrome.webRequest.onBeforeRequest.removeListener(b); chrome.webRequest.onHeadersReceived.removeListener(h);
        return {result, observedEvents};
      })()`);
      const attemptPromise = runDownload(`${base}/download-redirect`);
      await ordinaryTab.wc.executeJavaScript(`fetch(${JSON.stringify(`${base}/download-redirect`)}).catch(() => {})`);
      const attempt = await attemptPromise;
      const redirected = attempt.result;
      assert.equal(redirected.success, true, JSON.stringify(redirected));
      assert.equal(redirected.finalUrl, `${base}/download-final`);
      assert.equal(redirected.download?.state, 'complete', JSON.stringify(redirected.download));
      assert.equal(fs.readFileSync(redirected.download.filename, 'utf8'), 'download fixture');
      assert.match(requestHeaders.get('/download-final')?.cookie || '', /fixture-secret=value/);
      assert.equal(await ordinaryTab.wc.executeJavaScript("document.cookie.includes('fixture-secret=')"), false,
        'the download fixture cookie must not be exposed to page scripts');
      const [fixtureCookie] = await ctx.ses.cookies.get({ url: base, name: 'fixture-secret' });
      assert.equal(fixtureCookie?.secure, true, 'Chromium should retain the Secure cookie flag');
      const redirectHeaders = attempt.observedEvents.find(e => e.event === 'headers' && e.tabId === -1 && e.url.endsWith('/download-redirect'));
      assert(redirectHeaders.responseHeaders.every(h => h.name.toLowerCase() === 'location'));
      assert.equal(attempt.observedEvents.filter(e => e.event === 'before' && e.tabId === -1 && e.url.endsWith('/download-redirect')).length, 1,
        'another tab requesting the same URL must not be attributed to the offscreen document');
      const crossOrigin = (await runDownload(`${base}/download-cross-origin`)).result;
      assert.equal(crossOrigin.redirectRequiresPermission, true, JSON.stringify(crossOrigin));
      await offscreenWindow.webContents.executeJavaScript(`fetch(${JSON.stringify(`${base}/download-abort`)}).catch(() => {})`);
      await waitFor(() => bridge.offscreenRequests.size === 0);
      socket.close();
      console.log('Authenticated download validates same-origin and cross-origin redirects');
    }
    let invalidated = false;
    offscreenWindow.webContents.once('did-start-navigation', () => { invalidated = !getOffscreen()?.documentId; });
    const reloaded = new Promise(resolve => offscreenWindow.webContents.once('did-finish-load', resolve));
    offscreenWindow.webContents.reload();
    await reloaded;
    await bridge.offscreenIdentity.get(extId).ready;
    assert(invalidated, 'navigation must invalidate the old document identity');
    assert(getOffscreen()?.documentId && getOffscreen().documentId !== firstIdentity, 'reload must receive a new identity');
    bridge.handlers['offscreen.closeDocument'].call(bridge, { extId });
    assert.equal(getOffscreen(), undefined);
    await assert.rejects(bridge.handlers['offscreen.createDocument'].call(bridge, { extId }, { url: 'missing-offscreen-fixture.html' }));
    assert.equal(bridge.offscreen.has(extId), false, 'a failed offscreen load must not retain a window');
    assert.equal(bridge.offscreenIdentity.has(extId), false);
    console.log('Native offscreen identity changes on reload and rejects stale registrations');
    const w = ctx.windows[0];
    await waitFor(() => w.uiReady);
    w.selectTab(ordinaryTab);
    const readAddress = () => w.ui.executeJavaScript("document.getElementById('address').value");
    await waitFor(async () => (await readAddress()).includes('/late'));
    w.focusOmnibox();
    const newTab = w.addTab({});
    await waitFor(async () => await readAddress() === '');
    assert.equal(await w.ui.executeJavaScript("document.activeElement.id"), 'address');
    console.log('New tab focuses an empty address bar after a previous page');
    const guarded = w.addTab({ url: `${base}/guarded` });
    await waitFor(() => guarded.wc.getURL() === `${base}/guarded` && !guarded.wc.isLoading());
    await guarded.wc.executeJavaScript("window.onbeforeunload = e => { e.preventDefault(); e.returnValue = ''; }; document.body.click();", true);
    const { dialog } = require('electron');
    const originalDialog = dialog.showMessageBoxSync;
    let prompts = 0;
    try {
      dialog.showMessageBoxSync = () => { prompts++; return 1; };
      w.closeTab(guarded);
      await new Promise(r => setTimeout(r, 500));
      assert.equal(prompts, 1, 'beforeunload should prompt');
      assert(w.tabs.includes(guarded) && !guarded.wc.isDestroyed(), 'Stay should retain the tab');
      dialog.showMessageBoxSync = () => { prompts++; return 0; };
      w.closeTab(guarded);
      await waitFor(() => !w.tabs.includes(guarded));
      assert.equal(prompts, 2, 'retry should prompt again');
      assert(w.closedTabs.some(entry => entry.url === `${base}/guarded`));
      console.log('Beforeunload Stay retains the tab; Leave closes it');
      const other = ctx.createWindow({ url: `${base}/window-guarded` });
      const windowTab = other.activeTab;
      await waitFor(() => windowTab.wc.getURL() === `${base}/window-guarded` && !windowTab.wc.isLoading());
      await windowTab.wc.executeJavaScript("window.onbeforeunload = e => { e.preventDefault(); e.returnValue = ''; }; document.body.click();", true);
      dialog.showMessageBoxSync = () => 1;
      other.win.close();
      await new Promise(r => setTimeout(r, 500));
      assert(!other.win.isDestroyed() && other.tabs.includes(windowTab), 'Stay should retain the window and tab');
      dialog.showMessageBoxSync = () => 0;
      other.win.close();
      await waitFor(() => other.win.isDestroyed());
      console.log('Window close honors beforeunload');
    } finally { dialog.showMessageBoxSync = originalDialog; }
    // Exercise the last-window decision with an offscreen window still alive.
    const { BrowserWindow } = require('electron');
    const offscreen = new BrowserWindow({ show: false });
    const realWindows = ctx.windows, realFocus = ctx.focusOrder, realQuit = app.quit;
    const platform = Object.getOwnPropertyDescriptor(process, 'platform');
    let quitCalls = 0;
    try {
      Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
      app.quit = () => { quitCalls++; };
      const first = {}, last = {};
      ctx.windows = [first, last]; ctx.focusOrder = [first, last];
      ctx.onWindowClosed(first); assert.equal(quitCalls, 0);
      ctx.onWindowClosed(last); assert.equal(quitCalls, 1);
      assert.equal(offscreen.isDestroyed(), false);
      console.log('Last Linux browser window requests quit despite an offscreen window');
    } finally {
      Object.defineProperty(process, 'platform', platform);
      app.quit = realQuit; ctx.windows = realWindows; ctx.focusOrder = realFocus;
      offscreen.destroy();
    }
  } catch (error) { console.error(error); process.exitCode = 1; }
  finally { server.close(); app.exit(process.exitCode || 0); }
})();
});
