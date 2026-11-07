// Delivery regression: a certified native BUTTON whose own click changes the
// document's route. Mastodon's single-column UI is the field case: a toot's
// Reply button pushes /publish, and the composer's submit posts and then calls
// history.back(). Both route changes are the press's effect, not an
// interrupted observation with an unknown outcome (which made a model re-post
// the same reply). The pushed route is verified proof; a route reached by Back
// is not (any frame's script can go back), so that press is delivered and
// awaits a fresh observation. The browser's own Back stays the user's.
//
// [real DOM, Chromium only: the trusted native-button path is Chrome CDP]
// The real Agent, page-feedback run, page monitor (with its Navigation API
// reading), accessibility tree and content script run unchanged. Only the
// extension transport, debugger session and webNavigation history events are
// bridged to Playwright.
import { chromium } from 'playwright';
import { readFile } from 'node:fs/promises';
import http from 'node:http';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cdpClient } from '../src/chrome/src/cdp/cdp-client.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const area = { get: async () => ({}), set: async () => {}, remove: async () => {} };
let page, session;
const hooks = { afterRelease: null, traversalReadingDelayMs: 0, operationId: '', onAgentMessage: null };
const commands = [];
const requests = new Set();
const api = {
  storage: { local: area, session: area },
  runtime: { getURL: p => pathToFileURL(path.join(root, 'src/chrome', p)).href },
  tabs: {
    get: async () => ({ id: 17, url: page.url() }),
    query: async () => [{ id: 17, url: page.url() }],
    sendMessage: async (_id, message) => {
      // Set while a commit report is held: this message reaches the new document.
      const sentAfterCommit = hooks.onAgentMessage;
      // The dispatch operation of the press in flight, as the monitor is told.
      if (message.action === 'page_monitor_prepare' && message.params?.operationId) hooks.operationId = message.params.operationId;
      if (message.action === 'page_monitor_traversal' && hooks.traversalReadingDelayMs) {
        await new Promise(resolve => setTimeout(resolve, hooks.traversalReadingDelayMs));
      }
      try {
        return await page.evaluate(message => window.qaMessage(message), message);
      } finally { sentAfterCommit?.(); }
    },
  },
  webNavigation: { getAllFrames: async () => [{ frameId: 0, documentId: 'delivery-route-document', url: page.url() }] },
  webRequest: { onBeforeRequest: { addListener: l => requests.add(l), removeListener: l => requests.delete(l) } },
  debugger: { sendCommand: (_target, method, params, callback) => {
    commands.push({ method, type: params.type, x: params.x, y: params.y });
    session.send(method, params).then(result => {
      if (method === 'Input.dispatchMouseEvent' && params.type === 'mouseReleased' && hooks.afterRelease) {
        const after = hooks.afterRelease; hooks.afterRelease = null;
        void after();
      }
      return result;
    }).then(callback, error => {
      api.runtime.lastError = { message: error.message };
      try { callback(); } finally { delete api.runtime.lastError; }
    });
  } },
};
globalThis.chrome = api;
globalThis.browser = api;
const { Agent } = await import('../src/chrome/src/agent/agent.js');

// `/current` is reached from `/start` by the page's own pushState, so a
// traversal back to `/start` stays in this document.
const html = ({ script = '', slowScript = false } = {}) => `<!doctype html><style>body{margin:20px} button{width:200px;height:45px}</style>
<main id="app"></main>
<script>window.qaClicks=[];
const app=document.getElementById('app');
const show=()=>{ app.innerHTML=location.pathname==='/current'
  ? '<h1>Current reply</h1><label>Reply text<textarea>@owned Owned neutral reply</textarea></label><button id="commit" type="button">Post reply</button>'
  : '<h1>'+location.pathname+'</h1><p>Column view</p>';
  const commit=document.getElementById('commit');
  if(commit) commit.addEventListener('click',event=>{qaClicks.push({trusted:event.isTrusted});window.qaOnClick?.();});
};
addEventListener('popstate',()=>{show();window.qaOnPopState?.();});
history.replaceState({},'','/start'); history.pushState({},'','/current'); show();
${script}</script>${slowScript ? '<script src="/slow.js"></script>' : ''}`;

// webNavigation.onHistoryStateUpdated / onReferenceFragmentUpdated as real
// Chrome reports them: a traversal (a browser Back or the page's own
// history.back()) carries forward_back and its destination entry's original
// transition type ("typed" for the page first opened by address); a History
// API push or replace is a "link".
async function fixture(browserInstance, options) {
  const context = await browserInstance.newContext({ viewport: { width: 900, height: 700 } });
  // A parser-blocking script keeps the document loading after its inline
  // script ran, until the fixture releases it.
  let releaseSlowScript = () => {};
  const slowScript = new Promise(resolve => { releaseSlowScript = resolve; });
  await context.route('**/*', async route => {
    const url = route.request().url();
    if (!url.startsWith('https://delivery-route.invalid/')) return route.abort();
    if (new URL(url).pathname === '/slow.js') { await slowScript; return route.fulfill({ contentType: 'text/javascript', body: '' }); }
    return route.fulfill({ contentType: 'text/html', body: html({ ...options, slowScript: !!options.reinjectWhileLoading }) });
  });
  page = await context.newPage();
  const agent = new Agent({ getActive: () => ({ model: 'delivery-model' }) });
  agent._runningTabs.add(17);
  await page.exposeFunction('qaBackground', message => {
    const sender = { tab: { id: 17 }, frameId: 0, documentId: 'delivery-route-document', url: page.url() };
    if (message.action === 'get_page_monitor_state') return agent.pageMonitorState(sender, message.documentToken);
    if (message.action === 'page_feedback') return agent.observePageFeedback(sender, message.feedback);
    return {};
  });
  await page.addInitScript(() => {
    window.qaListeners = [];
    window.chrome = window.browser = { runtime: {
      getURL: p => p,
      onMessage: { addListener: f => qaListeners.push(f), removeListener() {} },
      sendMessage: message => window.qaBackground(message),
    } };
    window.qaMessage = message => new Promise(resolve => {
      let answered = false;
      const respond = value => { answered = true; resolve(value); };
      for (const f of qaListeners) { const value = f(message, {}, respond); if (answered || value === true) return; }
      resolve(undefined);
    });
  });
  for (const name of ['rich-text-toolbar-heuristic.js', 'file-upload-policy.js', 'accessibility-tree.js', 'page-monitor.js', 'content.js']) {
    await page.addInitScript({ content: await readFile(path.join(root, 'src/chrome/src/content', name), 'utf8') });
  }
  const monitorSource = await readFile(path.join(root, 'src/chrome/src/content/page-monitor.js'), 'utf8');
  if (options.reinjectWhileLoading) {
    // A monitor re-injected after page scripts ran, while the document still
    // loads (a recovery injection into a slow page).
    await page.goto('https://delivery-route.invalid/entry', { waitUntil: 'commit' });
    await page.waitForFunction(() => Array.isArray(window.qaClicks) && document.readyState === 'loading', null, { polling: 25 });
    await page.evaluate(() => window.__wbPageMonitor?.dispose());
    await page.evaluate(source => (0, eval)(source), monitorSource);
    assert.equal(await page.evaluate(() => document.readyState), 'loading');
    releaseSlowScript();
    await page.waitForLoadState('load');
  } else {
    releaseSlowScript();
    await page.goto('https://delivery-route.invalid/entry');
  }
  if (options.lateMonitor) {
    // A monitor injected after the page loaded (an extension update with the
    // tab left open): page scripts may have registered listeners before it.
    await page.evaluate(() => window.__wbPageMonitor?.dispose());
    await page.evaluate(source => (0, eval)(source), monitorSource);
  }
  session = await context.newCDPSession(page);
  await session.send('Page.enable');
  let previousUrl = page.url();
  session.on('Page.navigatedWithinDocument', event => {
    const before = new URL(previousUrl), after = new URL(event.url);
    previousUrl = event.url;
    if (!agent._pageFeedbackRuns?.get(17)) return;
    const traversal = after.pathname === '/start' && !after.search && !after.hash;
    const fragment = before.origin + before.pathname + before.search === after.origin + after.pathname + after.search;
    agent.observePageNavigation({ tabId: 17, frameId: 0, url: event.url, documentId: 'delivery-route-document',
      transitionType: traversal ? 'typed' : 'link', transitionQualifiers: traversal ? ['forward_back'] : [] },
    fragment ? 'fragment' : 'history');
  });
  await agent._beginPageFeedbackRun(17, 'neutral');
  await page.waitForFunction(() => window.__wbPageMonitor?.active);
  await page.mouse.move(5, 690);
  await page.waitForTimeout(180);
  const run = agent._pageFeedbackRuns.get(17);
  run.events.clear();
  const axScope = await api.tabs.sendMessage(17, { target: 'content', action: 'get_accessibility_tree', params: { filter: 'visible', maxChars: 12000 } });
  const capture = await api.tabs.sendMessage(17, { target: 'content', action: 'page_monitor_capture_model',
    params: { runToken: run.token, includeTree: true } });
  const ref = capture.page.pageContent.match(/button "Post reply" \[(ref_[A-Za-z0-9_-]+)\]/)?.[1];
  assert.ok(ref, capture.page.pageContent);
  const state = { token: run.token, url: run.url, steeringRevision: 0, frames: new Map(run.frames),
    actionBinding: { snapshotToken: capture.snapshotToken, runToken: run.token, documentToken: capture.documentToken } };
  run.modelState = state;
  run.dispatchCall = { name: 'click_ax', args: { ref_id: ref }, expectedModelSnapshot: capture.snapshotToken,
    modelState: state, dispatchState: { started: false }, allowPassiveRebase: true };
  const prepared = await api.tabs.sendMessage(17, { target: 'content', action: 'page_monitor_prepare',
    params: { runToken: run.token, tool: 'click_ax', ref_id: ref, operationId: 'delivery-route-operation',
      expectedModelSnapshot: capture.snapshotToken, allowPassiveRebase: true } });
  assert.equal(prepared.modelBindingValid, true);
  commands.length = 0; hooks.afterRelease = null; hooks.traversalReadingDelayMs = 0; hooks.operationId = '';
  agent._settleContentFilePickerGuard = async (_id, result) => result;
  agent._annotateClickProgress = async (_id, _name, _args, result) => result;
  agent._recordInteractionRect = () => {};
  agent._clearUploadSelectorRecoveryAfterInspection = () => {};
  agent._lastAxScopes.set(17, { documentToken: axScope.documentToken, pageUrl: axScope.refScopeUrl });
  return { context, agent, run, ref };
}

const presses = () => commands.filter(call => call.method === 'Input.dispatchMouseEvent' && call.type === 'mousePressed');
const routeOf = () => { const url = new URL(page.url()); return url.pathname + url.search + url.hash; };
const navigationSource = run => [...run.events.values()].find(event => event.kind === 'navigation')?.source;

test('Chrome: a native button\'s own route change is its effect; the browser\'s Back is not', { timeout: 300000 }, async t => {
  const cdpAttach = cdpClient.attach;
  cdpClient.attach = async () => cdpClient.sessions.set(17, {});
  const browserInstance = await chromium.launch({ headless: true });
  try {
    for (const [name, script, route, proof] of [
      // Reply-style: the click handler pushes the next column synchronously.
      ['an SPA pushState to the next column', "window.qaOnClick=()=>{history.pushState({},'','/publish');show();};", '/publish', true],
      // Submit-style: after its network round trip the page goes back itself.
      ['the page\'s own history.back() after a delayed post', 'window.qaOnClick=()=>setTimeout(()=>history.back(),200);', '/start', false],
      // ...and then restores its state while the traversal is still being read.
      ['the page\'s own history.back() followed by a state restore',
        "window.qaOnClick=()=>setTimeout(()=>history.back(),200);window.qaOnPopState=()=>history.replaceState({restored:true},'','/start?restored=1');",
        '/start?restored=1', false],
    ]) await t.test(`${name}: ${proof ? 'verified' : 'delivered'}, one press, no unknown outcome`, async () => {
      const f = await fixture(browserInstance, { script });
      try {
        const result = await f.agent.executeTool(17, 'click_ax', { ref_id: f.ref });
        assert.equal(result.success, true, JSON.stringify(result));
        assert.equal(result.initialTrustedNativeButton, true, JSON.stringify(result));
        assert.notEqual(result.outcomeUnknown, true, JSON.stringify(result));
        assert.notEqual(result.observationInterrupted, true, JSON.stringify(result));
        if (proof) {
          assert.equal(result.verified, true, JSON.stringify(result));
          assert.ok(result.observedEffects?.includes('url'), JSON.stringify(result));
        } else {
          // Tolerated as the press's effect, but a Back is never its url proof.
          assert.notEqual(result.observedEffects?.includes('url'), true, JSON.stringify(result));
          assert.ok(result.verified === true || result.effectVerificationPending === true, JSON.stringify(result));
        }
        assert.deepEqual((await page.evaluate(() => window.qaClicks)).map(click => click.trusted), [true]);
        assert.equal(presses().length, 1, 'exactly one press was sent');
        assert.equal(routeOf(), route);
        assert.equal(navigationSource(f.run), undefined, 'The route change is the click effect, not a navigation observation');
        assert.equal(f.run.agentRoute?.url, page.url());
        assert.ok(f.run.agentRoute?.operationId, 'The route is bound to the dispatch operation that produced it');
        assert.equal(f.agent._pageFeedbackAgentRouteCurrent(17, f.run, 0), false, 'No later action can claim that route');
        assert.equal(f.agent._pageFeedbackStateCurrent(17, f.run, f.run.modelState), false,
          'The route still invalidates the bound model state for the next decision');
      } finally { await f.context.close(); }
    });

    await t.test('a page traversal reading is answered once', async () => {
      const f = await fixture(browserInstance, { script: 'window.qaOnClick=()=>setTimeout(()=>history.back(),200);' });
      try {
        const result = await f.agent.executeTool(17, 'click_ax', { ref_id: f.ref });
        assert.equal(result.success, true, JSON.stringify(result));
        assert.notEqual(result.outcomeUnknown, true, JSON.stringify(result));
        const again = await api.tabs.sendMessage(17, { target: 'content', action: 'page_monitor_traversal',
          params: { runToken: f.run.token, url: page.url() } });
        assert.equal(again.ready, true);
        assert.equal(again.pageInitiated, false, 'A consumed reading cannot certify a later traversal');
        assert.deepEqual(Object.keys(again).sort(), ['documentToken', 'pageInitiated', 'ready', 'runToken'], 'Value-free reply');
      } finally { await f.context.close(); }
    });

    await t.test('a hash-only change is tolerated but is not proof', async () => {
      const f = await fixture(browserInstance, { script: "window.qaOnClick=()=>{location.hash='section-2';};" });
      try {
        const result = await f.agent.executeTool(17, 'click_ax', { ref_id: f.ref });
        assert.equal(result.success, true, JSON.stringify(result));
        assert.notEqual(result.observationInterrupted, true, JSON.stringify(result));
        assert.notEqual(result.outcomeUnknown, true, JSON.stringify(result));
        assert.notEqual(result.observedEffects?.includes('url'), true, JSON.stringify(result));
        assert.equal(routeOf(), '/current#section-2');
        assert.equal(presses().length, 1);
      } finally { await f.context.close(); }
    });

    // Only a route recorded for this press's own dispatch operation, at or
    // after the press, is tolerated (and, reached without Back, is proof).
    await t.test('a route recorded for another operation or before the press is not this press\'s', async () => {
      for (const variant of ['other-operation', 'before-press', 'own']) {
        const f = await fixture(browserInstance, {});
        let operationId = '';
        try {
          hooks.afterRelease = () => {
            const url = 'https://delivery-route.invalid/elsewhere';
            operationId = hooks.operationId;
            f.run.url = url;
            f.run.agentRoute = variant === 'other-operation' ? { at: Date.now(), url, operationId: 'another-operation' }
              : variant === 'before-press' ? { at: Date.now() - 60000, url, operationId } : { at: Date.now(), url, operationId };
          };
          const result = await f.agent.executeTool(17, 'click_ax', { ref_id: f.ref });
          assert.ok(operationId, 'The press ran under its own dispatch operation');
          assert.equal(presses().length, 1, `${variant}: ${JSON.stringify(result)}`);
          if (variant === 'own') {
            assert.equal(result.verified, true, `${variant}: ${JSON.stringify(result)}`);
            assert.ok(result.observedEffects?.includes('url'), `${variant}: ${JSON.stringify(result)}`);
          } else {
            assert.notEqual(result.verified, true, `${variant}: ${JSON.stringify(result)}`);
            assert.equal(result.outcomeUnknown, true, `${variant}: ${JSON.stringify(result)}`);
            assert.equal(result.observationInterrupted, true, `${variant}: ${JSON.stringify(result)}`);
          }
        } finally { hooks.afterRelease = null; await f.context.close(); }
      }
    });

    // The person presses the browser's Back while the press is observed.
    await t.test('the browser\'s own Back during observation keeps the outcome unverified', async () => {
      const f = await fixture(browserInstance, {});
      try {
        hooks.afterRelease = () => new Promise(resolve => setTimeout(resolve, 120)).then(() => page.goBack());
        const result = await f.agent.executeTool(17, 'click_ax', { ref_id: f.ref });
        await page.waitForTimeout(100);
        assert.equal(presses().length, 1, JSON.stringify(result));
        assert.equal(routeOf(), '/start');
        assert.notEqual(result.verified, true, JSON.stringify(result));
        assert.equal(result.outcomeUnknown, true, JSON.stringify(result));
        assert.equal(result.observationInterrupted, true, JSON.stringify(result));
        assert.equal(navigationSource(f.run), 'user');
      } finally { hooks.afterRelease = null; await f.context.close(); }
    });

    await t.test('a monitor injected after page scripts never certifies a page traversal', async () => {
      const f = await fixture(browserInstance, { script: 'window.qaOnClick=()=>setTimeout(()=>history.back(),150);', lateMonitor: true });
      try {
        const result = await f.agent.executeTool(17, 'click_ax', { ref_id: f.ref });
        assert.equal(presses().length, 1, JSON.stringify(result));
        assert.equal(routeOf(), '/start');
        assert.notEqual(result.verified, true, JSON.stringify(result));
        assert.equal(result.outcomeUnknown, true, JSON.stringify(result));
        assert.equal(navigationSource(f.run), 'user', 'It cannot rule out a Back the page hid from it');
      } finally { await f.context.close(); }
    });

    await t.test('a monitor re-injected while the document still loads never certifies a page traversal', async () => {
      const f = await fixture(browserInstance, { script: 'window.qaOnClick=()=>setTimeout(()=>history.back(),150);', reinjectWhileLoading: true });
      try {
        const result = await f.agent.executeTool(17, 'click_ax', { ref_id: f.ref });
        assert.equal(presses().length, 1, JSON.stringify(result));
        assert.equal(routeOf(), '/start');
        assert.notEqual(result.verified, true, JSON.stringify(result));
        assert.equal(result.outcomeUnknown, true, JSON.stringify(result));
        assert.equal(navigationSource(f.run), 'user', 'Page scripts ran before it and could have hidden a Back from it');
      } finally { await f.context.close(); }
    });

    // A reading that misses its deadline keeps the browser-UI attribution.
    await t.test('a late page traversal reading keeps the outcome unverified', async () => {
      const f = await fixture(browserInstance, { script: 'window.qaOnClick=()=>setTimeout(()=>history.back(),150);' });
      try {
        hooks.traversalReadingDelayMs = 900;
        const result = await f.agent.executeTool(17, 'click_ax', { ref_id: f.ref });
        assert.equal(presses().length, 1, JSON.stringify(result));
        assert.notEqual(result.verified, true, JSON.stringify(result));
        assert.equal(result.outcomeUnknown, true, JSON.stringify(result));
        assert.equal(navigationSource(f.run), 'user');
      } finally { await f.context.close(); }
    });

    await t.test('Stop while a traversal is read ends the observation at once', async () => {
      const f = await fixture(browserInstance, { script: 'window.qaOnClick=()=>setTimeout(()=>history.back(),100);' });
      try {
        hooks.traversalReadingDelayMs = 450;
        let stoppedAt = 0;
        hooks.afterRelease = () => new Promise(resolve => setTimeout(resolve, 300)).then(() => { stoppedAt = Date.now(); f.agent.abort(17); });
        const result = await f.agent.executeTool(17, 'click_ax', { ref_id: f.ref });
        const returnedAt = Date.now();
        assert.ok(stoppedAt > 0, JSON.stringify(result));
        assert.ok(returnedAt - stoppedAt < 300, `returned ${returnedAt - stoppedAt} ms after Stop`);
        assert.notEqual(result.verified, true, JSON.stringify(result));
        assert.equal(presses().length, 1);
      } finally { await f.context.close(); }
    });
  } finally {
    cdpClient.attach = cdpAttach;
    await browserInstance.close();
  }
});

// Cross-document: the certified native BUTTON submits its form and the server
// answers the POST with a redirect to the saved record. Real Chrome reports
// that commit through webNavigation.onCommitted as transition "form_submit"
// with qualifier "server_redirect"; the fixture bridges each top-level commit
// that way (or as the given transition). The press is delivered and its own
// navigation opened a new page, so its result carries that page for a fresh
// read. A navigation the press cannot be tied to, a redirect back to the same
// address, a redirect elsewhere that is not a form submission, or the person's
// own navigation stays an interrupted, unknown outcome.
//
// In Chrome the old document's reply can be lost before the browser's report
// of the commit arrives. holdCommitReport delivers that report 20 ms after the
// agent's next message to the page has returned; until then the new
// document's own messages wait, as in Chrome, where they follow the report.
const posts = [];
let serverOptions = {};
const formPage = ({ submit = true, script = '' } = {}) => `<!doctype html><style>body{margin:20px} button{width:200px;height:45px}</style>
<main><h1>Edit record</h1><form method="post" action="/save"><label>Record title<input name="title" value="Owned neutral title"></label>
<button id="save" type="${submit ? 'submit' : 'button'}">Save record</button></form></main>
<script>document.getElementById('save').addEventListener('click',()=>{${script}});</script>`;

async function formFixture(browserInstance, origin, options = {}) {
  serverOptions = { ...options }; posts.length = 0;
  hooks.onAgentMessage = null;
  let reported = null;
  const context = await browserInstance.newContext({ viewport: { width: 900, height: 700 } });
  page = await context.newPage();
  const agent = new Agent({ getActive: () => ({ model: 'delivery-model' }) });
  agent._runningTabs.add(17);
  // The id webNavigation.getAllFrames reports for the first document.
  const tab = { documentId: 'delivery-route-document' };
  await page.exposeFunction('qaBackground', async message => {
    if (reported) await reported;
    const sender = { tab: { id: 17 }, frameId: 0, documentId: tab.documentId, url: page.url() };
    if (message.action === 'get_page_monitor_state') return agent.pageMonitorState(sender, message.documentToken);
    if (message.action === 'page_feedback') return agent.observePageFeedback(sender, message.feedback);
    return {};
  });
  await page.addInitScript(() => {
    window.qaListeners = [];
    window.chrome = window.browser = { runtime: {
      getURL: p => p,
      onMessage: { addListener: f => qaListeners.push(f), removeListener() {} },
      sendMessage: message => window.qaBackground(message),
    } };
    window.qaMessage = message => new Promise(resolve => {
      let answered = false;
      const respond = value => { answered = true; resolve(value); };
      for (const f of qaListeners) { const value = f(message, {}, respond); if (answered || value === true) return; }
      resolve(undefined);
    });
  });
  for (const name of ['rich-text-toolbar-heuristic.js', 'file-upload-policy.js', 'accessibility-tree.js', 'page-monitor.js', 'content.js']) {
    await page.addInitScript({ content: await readFile(path.join(root, 'src/chrome/src/content', name), 'utf8') });
  }
  await page.goto(origin + '/edit');
  session = await context.newCDPSession(page);
  await session.send('Page.enable');
  session.on('Page.frameNavigated', ({ frame }) => {
    if (frame.parentId || !agent._pageFeedbackRuns?.get(17)) return;
    const report = () => {
      tab.documentId = 'delivery-route-document-' + frame.loaderId;
      agent.observePageNavigation({ tabId: 17, frameId: 0, url: frame.url, documentId: tab.documentId,
        ...(options.transition || { transitionType: 'link', transitionQualifiers: [] }) }, 'committed');
    };
    if (!options.holdCommitReport || reported) { report(); return; }
    let released = false, fallback;
    reported = new Promise(resolve => {
      const release = () => { if (released) return; released = true; clearTimeout(fallback); report(); resolve(); };
      fallback = setTimeout(release, 5000);
      hooks.onAgentMessage = () => { hooks.onAgentMessage = null; setTimeout(release, 20); };
    });
  });
  await agent._beginPageFeedbackRun(17, 'neutral');
  await page.waitForFunction(() => window.__wbPageMonitor?.active);
  await page.mouse.move(5, 690);
  await page.waitForTimeout(180);
  const run = agent._pageFeedbackRuns.get(17);
  run.events.clear();
  const axScope = await api.tabs.sendMessage(17, { target: 'content', action: 'get_accessibility_tree', params: { filter: 'visible', maxChars: 12000 } });
  const capture = await api.tabs.sendMessage(17, { target: 'content', action: 'page_monitor_capture_model',
    params: { runToken: run.token, includeTree: true } });
  const ref = capture.page.pageContent.match(/button "Save record" \[(ref_[A-Za-z0-9_-]+)\]/)?.[1];
  assert.ok(ref, capture.page.pageContent);
  const state = { token: run.token, url: run.url, steeringRevision: 0, frames: new Map(run.frames),
    actionBinding: { snapshotToken: capture.snapshotToken, runToken: run.token, documentToken: capture.documentToken } };
  run.modelState = state;
  run.dispatchCall = { name: 'click_ax', args: { ref_id: ref }, expectedModelSnapshot: capture.snapshotToken,
    modelState: state, dispatchState: { started: false }, allowPassiveRebase: true };
  const prepared = await api.tabs.sendMessage(17, { target: 'content', action: 'page_monitor_prepare',
    params: { runToken: run.token, tool: 'click_ax', ref_id: ref, operationId: 'delivery-redirect-operation',
      expectedModelSnapshot: capture.snapshotToken, allowPassiveRebase: true } });
  assert.equal(prepared.modelBindingValid, true);
  commands.length = 0; hooks.afterRelease = null; hooks.traversalReadingDelayMs = 0; hooks.operationId = '';
  agent._settleContentFilePickerGuard = async (_id, result) => result;
  agent._annotateClickProgress = async (_id, _name, _args, result) => result;
  agent._recordInteractionRect = () => {};
  agent._clearUploadSelectorRecoveryAfterInspection = () => {};
  agent._lastAxScopes.set(17, { documentToken: axScope.documentToken, pageUrl: axScope.refScopeUrl });
  return { context, agent, run, ref };
}

test('Chrome: a native submit button whose form POST redirects reports its own new page', { timeout: 300000 }, async t => {
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    let body = ''; for await (const part of request) body += part;
    if (url.pathname === '/save' && request.method === 'POST') {
      posts.push(body);
      response.writeHead(303, { Location: serverOptions.redirectTo || '/record' }).end(); return;
    }
    if (url.pathname === '/edit') { response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(formPage(serverOptions)); return; }
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      .end('<!doctype html><title>Saved record</title><main><h1>Saved record</h1><p role="status">Record saved</p></main>');
  });
  // Another origin (another port) that serves the saved record too.
  const elsewhere = http.createServer((_request, response) => response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    .end('<!doctype html><title>Saved record</title><main><h1>Saved record</h1></main>'));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  await new Promise(resolve => elsewhere.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const otherOrigin = `http://127.0.0.1:${elsewhere.address().port}`;
  const withDestination = options => ({ ...options,
    ...(options.redirectTo === 'elsewhere' ? { redirectTo: otherOrigin + '/record' } : {}) });
  const redirected = { transitionType: 'form_submit', transitionQualifiers: ['server_redirect'] };
  const linkRedirected = { transitionType: 'link', transitionQualifiers: ['server_redirect'] };
  const cdpAttach = cdpClient.attach;
  cdpClient.attach = async () => cdpClient.sessions.set(17, {});
  const browserInstance = await chromium.launch({ headless: true });
  try {
    for (const [name, options] of [
      ['the press is delivered and names the page its own navigation opened', { transition: redirected }],
      // The page-monitor finish message after input is the read that fails.
      ['the press is delivered when the old document\'s reply is lost before the commit report',
        { transition: redirected, holdCommitReport: true }],
      // The page submits the press's form itself after input was acknowledged
      // and the target was first read, so a target read inside the bounded
      // observation is the one that fails.
      ['the press is delivered when its target read fails before the commit report',
        { transition: redirected, holdCommitReport: true,
          script: "event.preventDefault();const save=document.getElementById('save');setTimeout(()=>save.form.requestSubmit(save),700);" }],
      ['a form submission redirected to another origin is still the press\'s own navigation',
        { transition: redirected, redirectTo: 'elsewhere' }],
    ]) await t.test(name, async () => {
      const f = await formFixture(browserInstance, origin, withDestination(options));
      try {
        const result = await f.agent.executeTool(17, 'click_ax', { ref_id: f.ref });
        assert.equal(result.success, true, JSON.stringify(result));
        assert.equal(result.initialTrustedNativeButton, true, JSON.stringify(result));
        assert.equal(result.ownNavigation, true, JSON.stringify(result));
        assert.equal(result.pageUrlChanged, true, JSON.stringify(result));
        assert.equal(result.previousUrl, origin + '/edit');
        assert.equal(result.currentUrl, (options.redirectTo === 'elsewhere' ? otherOrigin : origin) + '/record');
        // Delivered, not proof: the new page still needs a fresh read.
        assert.equal(result.verified, false, JSON.stringify(result));
        assert.equal(result.outcomeUnknown, true, JSON.stringify(result));
        assert.equal(result.nativeInputAcknowledged, true, JSON.stringify(result));
        assert.equal(result.observationInterrupted, true, JSON.stringify(result));
        assert.equal(result.error, undefined, JSON.stringify(result));
        assert.equal(presses().length, 1, 'exactly one press was sent');
        assert.deepEqual(posts, ['title=Owned+neutral+title'], 'exactly one form POST');
        assert.equal(navigationSource(f.run), undefined, 'The commit is the press\'s effect, not a navigation observation');
        assert.ok(hooks.operationId && f.run.agentDocument?.operationId === hooks.operationId,
          'The new document is bound to the dispatch operation that produced it');
        assert.equal(f.agent._pageFeedbackAgentDocumentCurrent(17, f.run, f.run.modelState, 0), false,
          'No later action can claim that document');
        assert.equal(f.agent._pageFeedbackStateCurrent(17, f.run, f.run.modelState), false,
          'The new document still invalidates the bound model state for the next decision');
      } finally { await f.context.close(); }
    });

    for (const [name, options, source, expectedPosts] of [
      // A plain button whose page script navigates: nothing ties it to the press.
      ['a page script navigation the press did not start',
        { submit: false, script: "setTimeout(()=>location.assign('/elsewhere'),50);" }, 'unknown', 0],
      ['a redirect back to the same address', { transition: redirected, redirectTo: '/edit' }, undefined, 1],
      // Within the attribution window, but neither the press's form submission
      // nor at its destination's origin.
      ['a redirect to another origin that is not a form submission',
        { transition: linkRedirected, redirectTo: 'elsewhere' }, undefined, 1],
      ['the person\'s own address-bar navigation',
        { submit: false, addressBar: true, transition: { transitionType: 'typed', transitionQualifiers: ['from_address_bar'] } }, 'user', 0],
    ]) await t.test(`${name} keeps the outcome unknown`, async () => {
      const f = await formFixture(browserInstance, origin, withDestination(options));
      try {
        if (options.addressBar) {
          hooks.afterRelease = () => new Promise(resolve => setTimeout(resolve, 50)).then(() => page.goto(origin + '/elsewhere'));
        }
        const result = await f.agent.executeTool(17, 'click_ax', { ref_id: f.ref });
        await page.waitForLoadState('load');
        assert.notEqual(result.success, true, JSON.stringify(result));
        assert.notEqual(result.ownNavigation, true, JSON.stringify(result));
        assert.equal(result.outcomeUnknown, true, JSON.stringify(result));
        assert.equal(result.observationInterrupted, true, JSON.stringify(result));
        assert.equal(presses().length, 1, JSON.stringify(result));
        assert.equal(posts.length, expectedPosts);
        assert.equal(navigationSource(f.run), source);
      } finally { hooks.afterRelease = null; await f.context.close(); }
    });

    // The page cancels the submission and removes the button, so the press's
    // navigation stays expected but never commits. Its failed target reads
    // wait for that commit within one bounded budget for the whole press.
    await t.test('a press whose page cancels its submission waits one bounded budget in all', async () => {
      const f = await formFixture(browserInstance, origin,
        { script: "event.preventDefault();document.getElementById('save').remove();" });
      const waits = [];
      const settled = f.agent._pageFeedbackAgentNavigationSettled;
      f.agent._pageFeedbackAgentNavigationSettled = async function (...args) {
        const started = Date.now();
        try { return await settled.apply(this, args); } finally { waits.push(Date.now() - started); }
      };
      try {
        const result = await f.agent.executeTool(17, 'click_ax', { ref_id: f.ref });
        assert.equal(result.success, true, JSON.stringify(result));
        assert.notEqual(result.ownNavigation, true, JSON.stringify(result));
        assert.notEqual(result.verified, true, JSON.stringify(result));
        assert.equal(presses().length, 1, JSON.stringify(result));
        assert.equal(posts.length, 0);
        assert.ok(waits.length >= 2, JSON.stringify(waits));
        assert.ok(waits[0] >= 250, `The first failed read waited for the expected commit: ${JSON.stringify(waits)}`);
        assert.ok(waits.reduce((sum, ms) => sum + ms, 0) < 450, `The press waited one budget in all: ${JSON.stringify(waits)}`);
      } finally { await f.context.close(); }
    });
  } finally {
    cdpClient.attach = cdpAttach;
    await browserInstance.close();
    await new Promise(resolve => server.close(resolve));
    await new Promise(resolve => elsewhere.close(resolve));
  }
});
