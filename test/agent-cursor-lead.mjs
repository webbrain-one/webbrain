// The agent cursor leads a click. On a tab that shows the run, the agent asks
// the page's cursor (content/agent-visual-indicator.js) to glide onto the
// target and waits for it to land, bounded, before the click's page checks
// and dispatch; afterwards it tells the cursor how the click went. On any
// other tab it sends nothing and waits for nothing.
//
// The same tab's Stop button never takes the agent's input: before input
// lands at a point it covers (it is hidden in every screenshot), the agent
// asks it to move out of the way, before the point's checks and again before
// each CDP pointer command.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';

const sent = [];
let reply = () => ({ ok: true });
const area = { get: async () => ({}), set: async () => {}, remove: async () => {} };
const api = {
  storage: { local: area, session: area },
  runtime: { getURL: value => value, getManifest: () => ({ version: 'test' }) },
  tabs: {
    get: async tabId => ({ id: tabId, url: 'https://cursor.test/' }),
    query: async () => [{ id: 7 }],
    sendMessage: async (tabId, message, options) => {
      sent.push({ tabId, message, options, at: performance.now() });
      return reply(message);
    },
  },
};
globalThis.chrome = api;
globalThis.browser = api;
const builds = {
  chrome: (await import('../src/chrome/src/agent/agent.js')).Agent,
  firefox: (await import('../src/firefox/src/agent/agent.js')).Agent,
};
const { CDPClient } = await import('../src/chrome/src/cdp/cdp-client.js');
const landingReply = arriveInMs => message => (message.phase === 'approach' ? { ok: true, arriveInMs } : { ok: true });
const since = start => performance.now() - start;

for (const [build, Agent] of Object.entries(builds)) {
  test(`${build}: a click waits for the agent cursor to land, only on a tab showing the run`, async () => {
    const agent = new Agent({});
    sent.length = 0;
    reply = landingReply(120);

    // No run indicator on the tab: nothing is sent and nothing waited for.
    let start = performance.now();
    await agent._leadAgentCursor(7, { ref_id: 'ref_1', pageUrl: 'https://cursor.test/' }, 'click_ax');
    agent._settleAgentCursor(7, { success: true });
    assert.equal(sent.length, 0);
    assert.ok(since(start) < 60);

    agent.isAgentIndicatorShown = tabId => tabId === 7;
    start = performance.now();
    await agent._leadAgentCursor(7, { ref_id: 'ref_1', pageUrl: 'https://cursor.test/' }, 'click_ax');
    assert.ok(since(start) >= 110, `waited ${since(start)} ms for the landing`);
    assert.deepEqual(sent.map(({ message }) => message), [{
      type: 'WB_SHOW_AGENT_TARGET', source: 'click_ax', phase: 'approach', ref_id: 'ref_1', pageUrl: 'https://cursor.test/',
    }]);

    // The wait is bounded by the agent, whatever the page answers.
    reply = landingReply(60_000);
    start = performance.now();
    await agent._leadAgentCursor(7, { x: 10, y: 20, w: 1, h: 1 }, 'click_coordinates');
    assert.ok(since(start) < 1500, `capped wait took ${since(start)} ms`);

    // Stop ends the wait at once.
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 30);
    start = performance.now();
    await agent._leadAgentCursor(7, { selector: '#go' }, 'click_selector', controller.signal);
    assert.ok(since(start) < 400, `aborted wait took ${since(start)} ms`);

    // A page that never answers is not waited on past the reply bound.
    reply = () => new Promise(() => {});
    start = performance.now();
    await agent._leadAgentCursor(7, { x: 1, y: 1, w: 1, h: 1 }, 'click_coordinates');
    assert.ok(since(start) < 800, `silent page took ${since(start)} ms`);

    // The verdict: only a dispatched success presses.
    sent.length = 0;
    reply = () => ({ ok: true });
    agent._settleAgentCursor(7, { success: true, dispatched: true });
    agent._settleAgentCursor(7, { success: false, noDispatch: true });
    agent._settleAgentCursor(7, { success: true, dispatched: false });
    agent._settleAgentCursor(7, undefined);
    assert.deepEqual(sent.map(({ message }) => [message.phase, message.ok]),
      [['done', true], ['done', false], ['done', false], ['done', false]]);
  });

  test(`${build}: click_ax leads with the cursor before its page checks and dispatch`, async () => {
    const agent = new Agent({});
    agent.isAgentIndicatorShown = () => true;
    sent.length = 0;
    reply = landingReply(150);
    const stop = new Error('stop after the first page step');
    let firstPageStepAt = 0;
    const firstPageStep = async () => { firstPageStepAt = performance.now(); throw stop; };
    // Chrome reads the URL first; Firefox goes straight to the content dispatch.
    if (build === 'chrome') agent._currentUrl = firstPageStep;
    else agent._withContentActionDeadline = firstPageStep;
    // Chrome lets the stop through; Firefox turns it into a failed result.
    await agent._dispatchClickAxImpl(7, { ref_id: 'ref_9' }, { documentToken: 'doc', pageUrl: 'https://cursor.test/' })
      .catch(error => { if (error !== stop) throw error; });
    assert.ok(firstPageStepAt > 0, 'the click went on to its page steps');
    assert.equal(sent[0]?.message.phase, 'approach');
    assert.equal(sent[0].message.ref_id, 'ref_9');
    assert.ok(firstPageStepAt - sent[0].at >= 140, `the click went ${firstPageStepAt - sent[0].at} ms after the approach`);
  });
}

for (const [build, Agent] of Object.entries(builds)) {
  test(`${build}: input under the page's Stop button asks it to move first, only on a tab showing the run`, async () => {
    const agent = new Agent({});
    sent.length = 0;
    reply = message => (message.type === 'WB_AGENT_POINTER_AT' ? { ok: true, moved: true } : { ok: true });

    // No run indicator on the tab, so no Stop button: nothing is sent.
    assert.equal(await agent._clearAgentStopButton(7, [{ x: 640, y: 680 }]), false);
    assert.equal(sent.length, 0);

    // The top document gets the points that are points; the reply says it moved.
    agent.isAgentIndicatorShown = tabId => tabId === 7;
    assert.equal(await agent._clearAgentStopButton(7, [{ x: 640, y: 680 }, { x: 'left', y: 3 }, null, { x: '12', y: 30.5 }]), true);
    assert.deepEqual(sent.map(({ tabId, message, options }) => ({ tabId, message, options })), [{
      tabId: 7, message: { type: 'WB_AGENT_POINTER_AT', points: [{ x: 640, y: 680 }, { x: 12, y: 30.5 }] }, options: { frameId: 0 },
    }]);
    sent.length = 0;
    reply = () => ({ ok: true, moved: false });
    assert.equal(await agent._clearAgentStopButton(7, [{ x: 1, y: 1 }]), false);
    assert.equal(await agent._clearAgentStopButton(7, []), false);
    assert.equal(await agent._clearAgentStopButton(7, undefined), false);
    assert.equal(sent.length, 1, 'no points, no message');

    // A page that never answers, or no content script, holds nothing back.
    reply = () => new Promise(() => {});
    let start = performance.now();
    assert.equal(await agent._clearAgentStopButton(7, [{ x: 1, y: 1 }]), false);
    assert.ok(since(start) < 800, `silent page took ${since(start)} ms`);
    reply = () => Promise.reject(new Error('Could not establish connection. Receiving end does not exist.'));
    start = performance.now();
    assert.equal(await agent._clearAgentStopButton(7, [{ x: 1, y: 1 }]), false);
    assert.ok(since(start) < 100);

    // The points a call aims at before its checks: a coordinate click's
    // (CSS once prepared) and a vision tool's monitor or wheel point.
    assert.deepEqual(agent._agentInputPoints('click', { x: 10, y: 20, coordinate_space: 'css' }), [{ x: 10, y: 20 }]);
    assert.deepEqual(agent._agentInputPoints('click', { ref_id: 'ref_1' }), []);
    assert.deepEqual(agent._agentInputPoints('drag_at', { start_x: 1, start_y: 2 }, { tool: 'drag_at', monitorPoint: { x: 3, y: 4 } }), [{ x: 3, y: 4 }]);
    assert.deepEqual(agent._agentInputPoints('scroll_at', {}, { tool: 'scroll_at', wheelPoint: { x: 5, y: 6 } }), [{ x: 5, y: 6 }]);
    assert.deepEqual(agent._agentInputPoints('type_text', { text: 'hello' }), []);
    reply = () => ({ ok: true });
  });

  test(`${build}: a vision probe reads its points only after the Stop button moved out of them`, async () => {
    const agent = new Agent({});
    const order = [];
    agent._clearAgentStopButton = async (tabId, points) => { order.push(['clear', tabId, points]); return true; };
    agent._visionPlatformDomProbe = async (tabId, request) => { order.push(['probe', tabId, request.points]); return { points: [] }; };
    const points = [{ x: 640, y: 680 }, { x: 640, y: 30 }];
    await agent._visionDomProbe(7, { points, pair: true });
    assert.deepEqual(order, [['clear', 7, points], ['probe', 7, points]]);
  });
}

test('chrome: every top-level CDP pointer command clears the Stop button before its hit test', async () => {
  const client = new CDPClient();
  client.sessions.set(7, { attached: true });
  const order = [];
  client._pageAgentInputTarget = async (_tab, method, params) => { order.push(['hit test', method, params.type]); return {}; };
  // Not set: the command goes as before.
  await client._beforeCommand(7, 'Input.dispatchMouseEvent', { type: 'mousePressed', x: 10, y: 20 }, '');
  assert.deepEqual(order, [['hit test', 'Input.dispatchMouseEvent', 'mousePressed']]);

  order.length = 0;
  client.beforePointerInput = async (tabId, point) => { order.push(['clear', tabId, point]); };
  for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased', 'mouseWheel']) {
    await client._beforeCommand(7, 'Input.dispatchMouseEvent', { type, x: 640.5, y: 680 }, '');
  }
  assert.deepEqual(order, ['mouseMoved', 'mousePressed', 'mouseReleased', 'mouseWheel'].flatMap(type => [
    ['clear', 7, { x: 640.5, y: 680 }], ['hit test', 'Input.dispatchMouseEvent', type],
  ]));

  // Keys, text and a child frame's own coordinates are not the top document's points.
  order.length = 0;
  await client._beforeCommand(7, 'Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter' }, '');
  await client._beforeCommand(7, 'Input.insertText', { text: 'hi' }, '');
  await client._beforeCommand(7, 'Input.dispatchMouseEvent', { type: 'mousePressed', x: 1, y: 2 }, 'child-session');
  assert.equal(order.some(([kind]) => kind === 'clear'), false, JSON.stringify(order));

  // A failing hook never holds the command back.
  order.length = 0;
  client.beforePointerInput = async () => { throw new Error('extension context invalidated'); };
  await client._beforeCommand(7, 'Input.dispatchMouseEvent', { type: 'mousePressed', x: 1, y: 2 }, '');
  assert.deepEqual(order, [['hit test', 'Input.dispatchMouseEvent', 'mousePressed']]);

  // background.js points the hook at the agent.
  const background = fs.readFileSync(new URL('../src/chrome/src/background.js', import.meta.url), 'utf8');
  assert.match(background, /cdpClient\.beforePointerInput = \(tabId, point\) => agent\._clearAgentStopButton\(tabId, \[point\]\);/);
});
