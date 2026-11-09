// The agent cursor leads a click. On a tab that shows the run, the agent asks
// the page's cursor (content/agent-visual-indicator.js) to glide onto the
// target and waits for it to land, bounded, before the click's page checks
// and dispatch; afterwards it tells the cursor how the click went. On any
// other tab it sends nothing and waits for nothing.
import assert from 'node:assert/strict';
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
    sendMessage: async (tabId, message) => {
      sent.push({ tabId, message, at: performance.now() });
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
