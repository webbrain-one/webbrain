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
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cdpClient } from '../src/chrome/src/cdp/cdp-client.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const area = { get: async () => ({}), set: async () => {}, remove: async () => {} };
let page, session;
const hooks = { afterRelease: null, traversalReadingDelayMs: 0, operationId: '' };
const commands = [];
const requests = new Set();
const api = {
  storage: { local: area, session: area },
  runtime: { getURL: p => pathToFileURL(path.join(root, 'src/chrome', p)).href },
  tabs: {
    get: async () => ({ id: 17, url: page.url() }),
    query: async () => [{ id: 17, url: page.url() }],
    sendMessage: async (_id, message) => {
      // The dispatch operation of the press in flight, as the monitor is told.
      if (message.action === 'page_monitor_prepare' && message.params?.operationId) hooks.operationId = message.params.operationId;
      if (message.action === 'page_monitor_traversal' && hooks.traversalReadingDelayMs) {
        await new Promise(resolve => setTimeout(resolve, hooks.traversalReadingDelayMs));
      }
      return page.evaluate(message => window.qaMessage(message), message);
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
  // Claimed the way a real run starts, with its run AbortController, so Stop
  // aborts what waits on the run signal (a pending traversal reading too).
  await agent._claimRunEntry(17, 'interactive');
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
  const close = async () => { try { agent._releaseRunEntry(17); } finally { await context.close(); } };
  return { context, agent, run, ref, close };
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
      } finally { await f.close(); }
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
      } finally { await f.close(); }
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
      } finally { await f.close(); }
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
        } finally { hooks.afterRelease = null; await f.close(); }
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
      } finally { hooks.afterRelease = null; await f.close(); }
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
      } finally { await f.close(); }
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
      } finally { await f.close(); }
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
      } finally { await f.close(); }
    });

    // The page goes back 300 ms after the click, inside the press's 500 ms
    // file-input settle window, so when the observation first checks its
    // owner the delayed reading still has about 250 ms to go (the agent caps
    // a reading at 500 ms). Stop is sent the moment the observation waits on
    // that pending reading: a Stop that waited for it would return only when
    // the reading settles.
    await t.test('Stop while a traversal is read ends the observation at once', async () => {
      const f = await fixture(browserInstance, { script: 'window.qaOnClick=()=>setTimeout(()=>history.back(),300);' });
      try {
        hooks.traversalReadingDelayMs = 450;
        let stoppedAt = 0;
        const settled = f.agent._pageFeedbackTraversalSettled;
        f.agent._pageFeedbackTraversalSettled = function (run, signal) {
          const waiting = settled.call(this, run, signal);
          if (run.traversalAttribution && !stoppedAt) { stoppedAt = Date.now(); this.abort(17); }
          return waiting;
        };
        const result = await f.agent.executeTool(17, 'click_ax', { ref_id: f.ref });
        const returnedAt = Date.now();
        assert.ok(stoppedAt > 0, `The observation waited on a pending traversal reading: ${JSON.stringify(result)}`);
        assert.ok(returnedAt - stoppedAt < 150, `returned ${returnedAt - stoppedAt} ms after Stop`);
        assert.ok(f.run.traversalAttribution, 'Stop did not wait for the traversal reading to settle');
        assert.notEqual(result.verified, true, JSON.stringify(result));
        assert.equal(presses().length, 1);
      } finally { await f.close(); }
    });
  } finally {
    cdpClient.attach = cdpAttach;
    await browserInstance.close();
  }
});
