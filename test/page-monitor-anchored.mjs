import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { test } from 'node:test';
import { chromium, firefox } from 'playwright';

const url = 'https://owned-anchored.invalid/detail';
const body = `<!doctype html><meta charset="utf-8"><style>body{margin:20px}article{width:550px;border:1px solid;padding:15px}.detail{height:900px}button{padding:12px}</style>
<h1>Owned detail</h1><button id="other" aria-label="More">Unrelated</button><article id="owned" role="article"><div class="detail"><a href="/@owned/200">Owned permalink</a><a href="/@owned">Owned account</a><p>Owned synthetic QA post</p></div><button id="more" aria-label="More">Owned menu</button></article>
<script>window.ownedClicks=0;window.otherClicks=0;document.querySelector('#more').onclick=()=>ownedClicks++;document.querySelector('#other').onclick=()=>otherClicks++;</script>`;

async function fixture(engine, build) {
  const { installPageFeedback } = await import(`../src/${build}/src/agent/page-feedback.js`);
  const browser = await engine.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1000, height: 700 } });
  await context.route('https://owned-anchored.invalid/**', route => route.fulfill({ contentType: 'text/html', body }));
  let host, page;
  class Host {
    static STATE_CHANGE_TOOLS = new Set(['click_ax']);
    isRunning() { return true; }
    _checkAbort() { return false; }
    _runAbortSignal() { return null; }
    _throwIfAborted() {}
    _persist() {}
    _shouldAutoScreenshot() { return false; }
    _effectiveRunMode() { return 'act'; }
    _appOwnedUserMessage(content, webbrainAppOwnedKind) { return { role: 'user', content, webbrainAppOwnedKind }; }
    _wrapUntrusted(_kind, content) { return content; }
    async executeTool(_tab, name, args) { return page.evaluate(({ name, args }) => qaSend(name, args), { name, args }); }
  }
  installPageFeedback(Host); host = new Host();
  const api = { runtime: {}, tabs: {
    get: async () => ({ url: page?.url() || url }),
    sendMessage: async (_tab, message) => page ? page.evaluate(message => qaSend(message.action, message.params || {}, message), message) : {},
  }, webNavigation: { getAllFrames: async () => [{ frameId: 0, documentId: await page.evaluate(() => String(performance.timeOrigin)), url: page.url() }] } };
  globalThis.chrome = api; delete globalThis.browser;
  await context.addInitScript(() => {
    const listeners = [];
    const runtime = { getURL: value => value, onMessage: { addListener: fn => listeners.push(fn), removeListener: fn => { const i = listeners.indexOf(fn); if (i >= 0) listeners.splice(i, 1); } },
      async sendMessage(message) {
        if (message.action === 'get_page_monitor_state') return qaState(message.documentToken, String(performance.timeOrigin), location.href);
        if (message.action === 'page_feedback') return qaFeedback(message.feedback, String(performance.timeOrigin));
        return {};
      } };
    window.chrome = { runtime }; window.browser = window.chrome;
    window.qaSend = (action, params = {}, original = {}) => new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`Missing production content response ${action}`)), 5000);
      let answered = false;
      const respond = result => { answered = true; clearTimeout(timeout); resolve(result); };
      for (const listener of listeners) {
        const async = listener({ ...original, target: 'content', action, params }, {}, respond);
        if (answered || async === true) break;
      }
    });
  });
  for (const file of ['page-monitor-shadow.js', 'rich-text-toolbar-heuristic.js', 'accessibility-tree.js', 'page-monitor.js', 'content.js'])
    await context.addInitScript({ content: await fs.readFile(new URL(`../src/${build}/src/content/${file}`, import.meta.url), 'utf8') });
  page = await context.newPage();
  await page.exposeFunction('qaState', (token, documentId, url) => host.pageMonitorState({ tab: { id: 1 }, frameId: 0, documentId, url }, token));
  await page.exposeFunction('qaFeedback', (feedback, documentId) => host.observePageFeedback({ tab: { id: 1 }, frameId: 0, documentId }, feedback));
  await page.goto(url);
  await host._beginPageFeedbackRun(1, 'interactive');
  await page.waitForFunction(() => __wbPageMonitor?.active);
  await page.waitForTimeout(200);
  host._pageFeedbackRuns.get(1).events.clear();
  const refs = await page.evaluate(() => ({ root: __wb_ax_ref(document.querySelector('#owned')), more: __wb_ax_ref(document.querySelector('#more')) }));
  return { browser, page, host, refs, run: host._pageFeedbackRuns.get(1), capture: async () => {
    const messages = []; await host._capturePageFeedbackModelState(1, messages); return { state: host._pageFeedbackRuns.get(1).modelState, messages };
  } };
}

for (const [build, engine] of [['chrome', chromium], ['firefox', firefox]]) {
  test(`${build}: vision-mode page feedback keeps the tree private while reporting page changes`, async () => {
    const f = await fixture(engine, build);
    try {
      const messages = [];
      const heading = f.page.locator('h1');
      await f.page.exposeFunction('qaReportedClick', () => [...f.run.events.values()]
        .some(event => event.kind === 'click' && event.source === 'user'));
      for (const vision of [false, true]) {
        f.host._visionRunState = () => ({ active: vision });
        const title = vision ? 'Heading during vision mode' : 'Heading during tree mode';
        await heading.evaluate((node, text) => { node.textContent = text; }, title);
        await f.host._capturePageFeedbackModelState(1, messages);
        assert.ok(f.run.modelState.actionBinding?.snapshotToken, 'the page still binds actions in either mode');
        assert.ok(f.run.modelState.page.pageContent.includes(title));
        const observed = messages.filter(message => message.webbrainAppOwnedKind === 'page_action_observation');
        assert.equal(observed.length, vision ? 0 : 1);
        if (!vision) assert.ok(observed[0].content.includes(title));

        const updatedTitle = title + ' after the page changed';
        await heading.evaluate((node, text) => { node.textContent = text; }, updatedTitle);
        await f.page.locator('#other').click();
        await f.page.waitForFunction(() => window.qaReportedClick());
        await f.host._applyPendingPageFeedback(1, messages);
        const feedback = messages.findLast(message => message.webbrainAppOwnedKind === 'page_feedback');
        assert.ok(feedback);
        const payload = JSON.parse(feedback.content.slice(feedback.content.indexOf('\n') + 1));
        assert.ok(payload.events.some(event => event.kind === 'click' && event.source === 'user'));
        assert.equal(Object.hasOwn(payload, 'page'), !vision);
        if (vision) assert.ok(!feedback.content.includes(title));
        else assert.ok(payload.page.pageContent.includes(updatedTitle));
      }
    } finally { await f.browser.close(); }
  });

  test(`${build}: failed offscreen action then explicit rooted reads keeps a fresh exact menu target`, { timeout: 60000 }, async () => {
    const f = await fixture(engine, build);
    try {
      await f.capture();
      const rejected = await f.host.executeTool(1, 'click_ax', { ref_id: f.refs.more });
      assert.equal(rejected.errorCode, 'action_binding_unavailable'); assert.equal(rejected.noDispatch, true);
      assert.equal(await f.page.evaluate(() => ownedClicks + otherClicks), 0);
      await f.capture(); // Consume the failed action's single-turn priority capture.
      for (let index = 0; index < 2; index++) {
        const read = await f.host.executeTool(1, 'get_accessibility_tree', { ref_id: f.refs.root });
        assert.ok(read.pageContent.includes(`[${f.refs.more}]`));
        const fresh = await f.capture();
        assert.ok(fresh.state.page.pageContent.includes('[CURRENT REQUESTED OBSERVATION SCOPE]'));
        assert.ok(fresh.state.page.pageContent.includes(`[${f.refs.more}]`));
      }
      const result = await f.host.executeTool(1, 'click_ax', { ref_id: f.refs.more });
      assert.equal(result.success, true, JSON.stringify(result));
      assert.deepEqual(await f.page.evaluate(() => [ownedClicks, otherClicks]), [1, 0]);
    } finally { await f.browser.close(); }
  });

  test(`${build}: rooted inventory is freshly re-read, bounded and replaced nodes lose the original reference`, { timeout: 60000 }, async () => {
    const f = await fixture(engine, build);
    try {
      await f.host.executeTool(1, 'get_accessibility_tree', { ref_id: f.refs.root });
      await f.page.locator('#more').evaluate(node => node.setAttribute('aria-label', 'Current owned menu'));
      await f.page.waitForTimeout(200); f.run.events.clear();
      const fresh = await f.capture();
      assert.match(fresh.state.page.pageContent, /Current owned menu/);
      assert.ok(JSON.stringify(fresh.state.page).length <= 16000);
      await f.page.locator('#owned').evaluate(node => { const clone = node.cloneNode(true); node.replaceWith(clone); });
      await f.page.waitForTimeout(200); f.run.events.clear();
      await f.capture();
      assert.equal(f.run.actionObservationScope, null, 'A detached root cannot select a replacement by DOM id.');
      const rejected = await f.host.executeTool(1, 'click_ax', { ref_id: f.refs.more });
      assert.equal(rejected.success, false); assert.equal(rejected.noDispatch, true);
      assert.deepEqual(await f.page.evaluate(() => [ownedClicks, otherClicks]), [0, 0]);
    } finally { await f.browser.close(); }
  });

  test(`${build}: unanchored AX and changed document or route clear rooted scope ownership`, { timeout: 60000 }, async () => {
    const f = await fixture(engine, build);
    try {
      await f.host.executeTool(1, 'get_accessibility_tree', { ref_id: f.refs.root });
      assert.ok(f.run.actionObservationScope);
      await f.host.executeTool(1, 'get_accessibility_tree', { filter: 'visible' });
      assert.equal(f.run.actionObservationScope, null);
      await f.host.executeTool(1, 'get_accessibility_tree', { ref_id: f.refs.root });
      await f.page.evaluate(() => history.pushState({}, '', '/changed-route'));
      await f.page.waitForTimeout(200); f.run.events.clear();
      await f.capture(); assert.equal(f.run.actionObservationScope, null);
      await f.page.goto(url);
      f.host.observePageNavigation({ tabId: 1, frameId: 0, documentId: await f.page.evaluate(() => String(performance.timeOrigin)), url }, 'committed');
      await f.page.evaluate(() => qaSend('page_monitor_state', {}, { active: true }));
      await f.page.waitForFunction(() => __wbPageMonitor?.active);
      const root = await f.page.evaluate(() => __wb_ax_ref(document.querySelector('#owned')));
      f.run.url = url;
      await f.host.executeTool(1, 'get_accessibility_tree', { ref_id: root });
      const oldToken = f.run.actionObservationScope.documentToken;
      await f.page.reload();
      f.host.observePageNavigation({ tabId: 1, frameId: 0, documentId: await f.page.evaluate(() => String(performance.timeOrigin)), url }, 'committed');
      await f.page.evaluate(() => qaSend('page_monitor_state', {}, { active: true }));
      await f.page.waitForFunction(() => __wbPageMonitor?.active);
      await f.page.waitForTimeout(200); f.run.events.clear();
      assert.notEqual(f.run.frames.get(0).token, oldToken);
      await f.capture(); assert.equal(f.run.actionObservationScope, null);
    } finally { await f.browser.close(); }
  });
}
