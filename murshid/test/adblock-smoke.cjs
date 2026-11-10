'use strict';

// Run under Electron by run-adblock-smoke.cjs, with a disposable profile and a
// debugging port. Real ad and tracker hosts are pointed at a local server, so
// what is blocked never leaves the machine and what is let through can be seen
// arriving.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { app, Menu } = require('electron');

const AD_HOST = 'pagead2.googlesyndication.com';
const TRACKER_HOST = 'sb.scorecardresearch.com'; // www.google-analytics.com is HSTS-preloaded, so it would not come to the http fixture
// The page needs a host name: the library hides no elements on IP addresses or localhost.
const SITE = 'adblock-fixture.test';
app.commandLine.appendSwitch('host-resolver-rules', `MAP ${AD_HOST} 127.0.0.1, MAP ${TRACKER_HOST} 127.0.0.1, MAP ${SITE} 127.0.0.1`);

const seen = [];
const server = http.createServer((req, res) => {
  seen.push({ host: req.headers.host.split(':')[0], url: req.url });
  if (req.url.endsWith('.js')) { res.setHeader('Content-Type', 'text/javascript'); res.end('window.loaded = true;'); return; }
  if (req.url.startsWith('/collect')) { res.setHeader('Content-Type', 'image/gif'); res.end(Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64')); return; }
  res.setHeader('Content-Type', 'text/html');
  const port = server.address().port;
  res.end(`<!doctype html><title>adblock fixture</title>
<div id="ad_banner">ad</div><div class="ad-slot">ad</div><div id="content">content</div>
<script>window.results = {};</script>
<script src="http://${AD_HOST}:${port}/pagead/js/adsbygoogle.js" onload="results.ad = 'load'" onerror="results.ad = 'error'"></script>
<img src="http://${TRACKER_HOST}:${port}/collect?v=1&t=pageview" onload="results.tracker = 'load'" onerror="results.tracker = 'error'">
<script src="/local.js" onload="results.local = 'load'" onerror="results.local = 'error'"></script>`);
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(condition, what) {
  for (let i = 0; i < 150; i++) { if (await condition()) return; await sleep(100); }
  throw new Error(`timed out waiting for ${what}`);
}

server.listen(0, '127.0.0.1', () => {
  const base = `http://${SITE}:${server.address().port}`;
  const { ctx } = require('../app/main');
  (async () => {
    try {
      await waitFor(() => ctx.windows.length && ctx.webBrainId, 'the browser and WebBrain');
      await sleep(2000); // WebBrain may open its own first-run tab
      const w = ctx.windows[0];
      assert.ok(ctx.adblock.engine, 'the bundled engine loads');

      // WebBrain's worker, through its own chrome.webRequest.
      const list = await (await fetch(`http://127.0.0.1:${process.env.MURSHID_TEST_CDP_PORT}/json/list`)).json();
      const target = list.find((t) => t.type === 'service_worker' && t.url === `chrome-extension://${ctx.webBrainId}/src/background.js`);
      assert.ok(target, 'WebBrain worker target');
      const socket = new WebSocket(target.webSocketDebuggerUrl);
      await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
      const evaluate = (expression) => new Promise((resolve, reject) => {
        const id = Math.floor(Math.random() * 1e9);
        const listener = (e) => {
          const data = JSON.parse(e.data);
          if (data.id !== id) return;
          socket.removeEventListener('message', listener);
          if (data.error || data.result.exceptionDetails) reject(new Error(JSON.stringify(data.error || data.result.exceptionDetails)));
          else resolve(data.result.result.value);
        };
        socket.addEventListener('message', listener);
        socket.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }));
      });
      await evaluate(`(() => {
        globalThis.adEvents = [];
        for (const name of ['onBeforeRequest', 'onErrorOccurred', 'onResponseStarted']) {
          chrome.webRequest[name].addListener((d) => { if (d.url.includes(${JSON.stringify(AD_HOST)}) || d.url.includes(${JSON.stringify(TRACKER_HOST)}) || d.url.includes('/local.js')) adEvents.push({ name, url: d.url, tabId: d.tabId, error: d.error }); }, { urls: ['<all_urls>'] });
        }
      })()`);

      const load = async (tab) => {
        await waitFor(() => !tab.wc.isLoading(), 'the fixture page');
        await waitFor(() => tab.wc.executeJavaScript('Boolean(window.results && results.ad && results.tracker && results.local)'), 'the fixture results');
        await sleep(500); // element hiding arrives after DOMContentLoaded
        return tab.wc.executeJavaScript(`({ ...results,
          banner: getComputedStyle(document.getElementById('ad_banner')).display,
          slot: getComputedStyle(document.querySelector('.ad-slot')).display,
          content: getComputedStyle(document.getElementById('content')).display })`);
      };

      // 1. On by default: the ad script and the tracking pixel are blocked, and hidden ad slots.
      const tab = w.addTab({ url: `${base}/page` });
      let result = await load(tab);
      assert.deepEqual(result, { ad: 'error', tracker: 'error', local: 'load', banner: 'none', slot: 'none', content: 'block' });
      assert.ok(!seen.some((entry) => entry.host === AD_HOST || entry.host === TRACKER_HOST), `nothing reached the ad hosts: ${seen.map((entry) => `${entry.host}${entry.url}`).join(',')}`);
      await waitFor(async () => (await evaluate('adEvents')).some((e) => e.name === 'onErrorOccurred'), 'WebBrain to see the blocked request');
      const events = await evaluate('adEvents');
      const adEvents = events.filter((e) => {
        try { return new URL(e.url).hostname === AD_HOST; } catch { return false; }
      });
      assert.deepEqual(adEvents.map((e) => [e.name, e.tabId, e.error]), [['onBeforeRequest', tab.id, undefined], ['onErrorOccurred', tab.id, 'net::ERR_BLOCKED_BY_CLIENT']]);
      assert.ok(events.some((e) => e.name === 'onResponseStarted' && e.url.endsWith('/local.js') && e.tabId === tab.id), 'WebBrain sees the page\'s other requests');
      console.log('Ads and trackers blocked, ad slots hidden; WebBrain\'s webRequest sees the blocked request');

      // 2. WebBrain's side panel still opens and loads.
      ctx.crx.togglePanelForActiveTab(w);
      await waitFor(() => w.panelContents() && !w.panelContents().isLoading() && w.panelContents().getURL().startsWith(`chrome-extension://${ctx.webBrainId}/`), 'the WebBrain side panel');
      const panelText = await w.panelContents().executeJavaScript('document.body.innerText.length');
      assert.ok(panelText > 0, 'the side panel renders');
      console.log(`WebBrain side panel open at ${w.panelContents().getURL()}`);
      w.selectTab(tab);

      // 3. The ⋮ menu's per-site item allows ads on this site.
      const realBuild = Menu.buildFromTemplate;
      let template;
      Menu.buildFromTemplate = (items) => { template = items; return { popup() {} }; };
      try { require('../app/menu').popupMainMenu(ctx, w, { x: 0, y: 0 }); } finally { Menu.buildFromTemplate = realBuild; }
      const item = template.find((i) => i.type === 'checkbox' && i.label === `Block ads on ${SITE}`);
      assert.ok(item?.checked, `the ⋮ menu offers "Block ads on ${SITE}", ticked`);
      item.click(); // reloads the tab
      await sleep(300);
      result = await load(tab);
      assert.deepEqual(result, { ad: 'load', tracker: 'load', local: 'load', banner: 'block', slot: 'block', content: 'block' }, `server saw: ${seen.join(' ')}; WebBrain saw: ${JSON.stringify(await evaluate('adEvents'))}`);
      assert.deepEqual(ctx.settings.get('adblockAllowedSites'), [SITE]);
      ctx.adblock.setAllowed(SITE, false);
      console.log('Allowing ads on one site lets its ads load');

      // 3b. The toolbar shield does the same from the browser chrome, both ways.
      const shield = () => w.ui.executeJavaScript(`(() => { const b = document.getElementById('adblock');
        return { hidden: b.hidden, allowed: b.classList.contains('allowed'), pressed: b.getAttribute('aria-pressed'), title: b.title }; })()`);
      await waitFor(async () => { const s = await shield(); return !s.hidden && !s.allowed; }, 'the shield showing blocking');
      assert.equal((await shield()).pressed, 'true');
      assert.ok((await shield()).title.includes(`blocked on ${SITE}`), (await shield()).title);
      await tab.wc.reload();
      await load(tab);
      await w.ui.executeJavaScript("document.getElementById('adblock').click()"); // allows, and reloads the tab
      await waitFor(() => (ctx.settings.get('adblockAllowedSites') || []).includes(SITE), 'the site allowed');
      await sleep(300);
      result = await load(tab);
      assert.equal(result.ad, 'load');
      assert.equal(result.tracker, 'load');
      await waitFor(async () => (await shield()).allowed, 'the shield showing allowed');
      await w.ui.executeJavaScript("document.getElementById('adblock').click()"); // blocks again
      await waitFor(() => !(ctx.settings.get('adblockAllowedSites') || []).includes(SITE), 'the site blocked again');
      await sleep(300);
      result = await load(tab);
      assert.equal(result.ad, 'error');
      assert.equal(result.tracker, 'error');
      await waitFor(async () => !(await shield()).allowed, 'the shield showing blocking again');
      // Not on Murshid's own pages.
      const settingsTab = w.addTab({ url: 'murshid://settings/' });
      await waitFor(async () => (await shield()).hidden, 'no shield on murshid://');
      await w.closeTab(settingsTab);
      w.selectTab(tab);
      console.log('The toolbar shield allows and blocks ads on the site');

      // 4. Settings > "Block ads and trackers" turns it off.
      seen.length = 0;
      await tab.wc.loadURL('murshid://settings/');
      await waitFor(() => tab.wc.executeJavaScript("document.getElementById('adblock')?.checked === true"), 'the Settings switch');
      await tab.wc.executeJavaScript("document.getElementById('adblock').click()");
      await waitFor(() => ctx.settings.get('adblock') === false, 'the setting');
      tab.wc.loadURL(`${base}/page`);
      await sleep(300);
      result = await load(tab);
      assert.equal(result.ad, 'load');
      assert.equal(result.tracker, 'load');
      assert.equal(result.banner, 'block');
      assert.ok(seen.some((entry) => entry.host === AD_HOST), 'the ad request reached the network');
      ctx.settings.set('adblock', true);
      console.log('The Settings switch turns blocking off and on');

      // 5. Optional: a real list update (network), built in a utility process.
      if (process.env.MURSHID_TEST_ADBLOCK_REFRESH === '1') {
        const before = ctx.adblock.engine;
        await ctx.adblock.refresh();
        assert.notEqual(ctx.adblock.engine, before);
        const meta = JSON.parse(fs.readFileSync(path.join(process.env.MURSHID_PROFILE, 'adblock', 'lists.json'), 'utf8'));
        assert.equal(meta.lists.length, 3);
        assert.ok(Date.now() - meta.updated < 5 * 60 * 1000);
        tab.wc.loadURL(`${base}/page`);
        await sleep(300);
        assert.equal((await load(tab)).ad, 'error');
        console.log(`Lists updated (${meta.lists.map((l) => `${l.name} ${l.version}`).join(', ')}) and still blocking`);
      }
      console.log('Adblock smoke passed');
    } catch (error) {
      console.error(error);
      process.exitCode = 1;
    } finally {
      server.close();
      app.exit(process.exitCode || 0);
    }
  })();
});
