import assert from 'node:assert/strict';
import { test } from 'node:test';

const pageUrl = 'https://owned-answer.invalid/';
const documents = new Map();
const documentHooks = new Map();
const unnumberedDocuments = new Set(), monitorReplies = new Map();
const area = { get: async () => ({}), set: async () => {}, remove: async () => {} };
const api = { storage: { local: area, session: area },
  runtime: { getURL: path => path, sendMessage: async () => ({}) },
  tabs: { get: async id => ({ id, url: pageUrl, title: 'Owned answer fixture' }),
    sendMessage: async (id, message) => message.action === 'page_monitor_state' && monitorReplies.has(id)
      ? monitorReplies.get(id) : { ready: true } },
  webNavigation: { getAllFrames: async ({ tabId }) => {
    documentHooks.get(tabId)?.();
    return [{ frameId: 0, documentId: unnumberedDocuments.has(tabId) ? undefined : documents.get(tabId) || 'main-document', url: pageUrl }];
  } },
  scripting: { executeScript: async () => [{ result: null }] } };
globalThis.chrome = globalThis.browser = api;
let nextTab = 9100;
const call = answer => ({ toolCalls: [{ id: 'answer', function: { name: 'done', arguments: JSON.stringify({ summary: answer }) } }] });

function fixture(Agent, { streaming, response, change = '', dependent = false, beforeDispatch = false, pendingRead = false }) {
  const tab = nextTab++, updates = [], reads = [], dispatched = [];
  let agent, mainCalls = 0, scopeCalls = 0, churnCount = 0;
  const fresh = change === 'prior-done' ? 'Opening line from the earlier poem.\nShorter ending.'
    : 'Corrected conversation draft: available on GitHub and Firefox.';
  const old = 'Original conversation draft: launching soon.';
  if (['missing-document-id', 'foreign-monitor'].includes(change)) unnumberedDocuments.add(tab);
  const churn = () => {
    const count = ++churnCount;
    agent.observePageNavigation({ tabId: tab, frameId: 7, parentFrameId: 0,
      url: `https://owned-frame.invalid/${count}`, documentId: `child-${count}` }, 'committed');
    const sender = { tab: { id: tab }, frameId: 7, documentId: `child-${count}`, url: `https://owned-frame.invalid/${count}` };
    const binding = agent.pageMonitorState(sender, `child-token-${count}`);
    assert.equal(binding.active, true);
    assert.equal(agent.observePageFeedback(sender, { ...binding, seq: 1, kind: 'dom', source: 'unknown',
      revision: count, target: 'span#live-count' }).accepted, true);
  };
  const steer = () => {
    assert.equal(agent.steerMessage(tab, 'Use the corrected draft: available on GitHub and Firefox.',
      { requestId: `owned-churn-${tab}`, messageId: `correction-${tab}` }).accepted, true);
  };
  const next = async messages => {
    if (messages[0]?.content?.startsWith('You classify whether one proposed terminal WebBrain Ask answer')) {
      scopeCalls++;
      const input = JSON.parse(messages[1].content);
      assert.ok(input.user_request); assert.ok(input.candidate_answer);
      if (change === 'prior-context') {
        assert.ok(input.prior_context.includes('Before revising, read the currently visible iframe.'), 'A late live-source qualification cannot be clipped away.');
      }
      if (change === 'prior-done') {
        assert.ok(input.prior_context.includes('Opening line from the earlier poem.'), 'A successfully delivered done draft remains available to corrections.');
        assert.ok(input.prior_context.includes('Retain this qualification at the very end.'), 'Completed summaries are not clipped.');
        assert.ok(!input.prior_context.includes('PRIVATE_PAGE_VERIFICATION'), 'Page/result fields cannot be promoted into conversation facts.');
      }
      churn();
      if (scopeCalls === 1) {
        if (change === 'final-user') {
          let checks = 0;
          documentHooks.set(tab, () => {
            if (++checks === 2) {
              documentHooks.delete(tab);
              agent._queuePageFeedback(tab, { kind: 'input', source: 'user', frameId: 0, target: 'input#edited' });
            }
          });
        }
        if (change === 'scope-ignored-stop' || change === 'scope-ignored-steering') {
          setTimeout(() => change === 'scope-ignored-stop' ? agent.abort(tab) : steer(), 0);
          return new Promise(() => {});
        }
        if (change === 'scope-steering') steer();
        if (change === 'scope-stop') agent.abort(tab);
        if (change === 'scope-document') documents.set(tab, 'new-main-document');
        if (change === 'scope-provider') provider.model = 'replacement-model';
      }
      return { content: JSON.stringify({ pageIndependent: !dependent && !(change === 'scope-candidate' && scopeCalls === 1) }) };
    }
    mainCalls++;
    assert.ok(mainCalls <= 5, 'Frame activity cannot keep regenerating the answer.');
    if (mainCalls === 1 || !dependent || change === 'dependent-continuous') churn();
    if (mainCalls === 1 && change === 'model-steering') steer();
    const answer = change && !['prior-done', 'missing-document-id'].includes(change) && mainCalls === 1 ? old : fresh;
    return response === 'done' ? call(answer) : { content: answer };
  };
  const provider = { name: 'Owned answer provider', model: 'owned-answer', promptTier: 'full', contextWindow: 128000,
    supportsTools: true, supportsVision: false, chat: next,
    async *chatStream(messages) {
      const result = await next(messages);
      if (result.content) yield { type: 'text', content: result.content };
      if (result.toolCalls) yield { type: 'tool_call', content: result.toolCalls.map((tool, index) => ({ ...tool, index })) };
      yield { type: 'done' };
    } };
  agent = new Agent({ getActive: () => provider, getProvider: () => provider, getVisionProvider: async () => null });
  for (const method of ['_hydrate', '_persistNow', '_persistSubmittedTurn', '_startTraceRun', '_endTraceRun',
    '_beginReadCompleteness', '_manageContext', '_checkCostAllowance', '_recordCostUsage', '_maybeEmitAskModeHandoff',
    '_maybeReinjectAdapter', '_ensureProgressSessionForCurrentTask']) agent[method] = async () => null;
  if (pendingRead) {
    agent._readCompletenessBlock = () => 'Conversation coverage is still incomplete; continue reading.';
    provider._supportsInteractiveAskStreaming = () => true;
  }
  agent._persist = () => {};
  agent._plannerMode = () => 'off';
  agent._currentUrl = async () => pageUrl;
  agent._getTabUrlTitle = async () => ({ tabUrl: pageUrl, tabTitle: 'Owned answer fixture' });
  agent._shouldAutoScreenshot = () => false;
  agent._pageFeedbackIdleMs = 0;
  agent.maxSteps = Infinity;
  if (change === 'prior-context') agent.getConversation(tab, 'ask').push(
    { role: 'user', content: 'Previous draft details: '.repeat(40) + 'Before revising, read the currently visible iframe.' },
    { role: 'assistant', content: 'Previous draft based on that live iframe.' });
  if (change === 'prior-done') agent.getConversation(tab, 'ask').push(
    { role: 'user', content: 'Write an original poem using my facts.' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'previous-poem', function: { name: 'done', arguments: JSON.stringify({
      summary: 'Opening line from the earlier poem.\n' + 'Original poem details. '.repeat(30) + 'Retain this qualification at the very end.',
    }) } }] },
    { role: 'tool', tool_call_id: 'previous-poem', content: agent._wrapUntrusted('done', JSON.stringify({ done: true,
      summary: 'PRIVATE_PAGE_VERIFICATION', pageState: 'PRIVATE_PAGE_VERIFICATION' })) });
  agent._enrichUserMessageWithCurrentPage = async (_tab, _messages, content) => {
    const main = agent.pageMonitorState({ tab: { id: tab }, frameId: 0,
      documentId: unnumberedDocuments.has(tab) ? undefined : 'main-document', url: pageUrl }, 'main-token');
    assert.equal(main.active, true);
    if (unnumberedDocuments.has(tab)) monitorReplies.set(tab, { ready: true, active: true, runToken: main.runToken,
      documentToken: change === 'foreign-monitor' ? 'foreign-top-document' : main.documentToken });
    const sender = { tab: { id: tab }, frameId: 7, documentId: 'child-original', url: 'https://owned-frame.invalid/initial' };
    assert.equal(agent.pageMonitorState(sender, 'child-original-token').active, true);
    return { role: 'user', content };
  };
  agent.executeTool = async (_tab, name, args) => {
    if (name === 'get_accessibility_tree') {
      reads.push(name); return { success: true, pageContent: 'region "Observed fixture" [ref_1]', url: pageUrl };
    }
    assert.equal(name, 'done', 'A response scope cannot grant any browser action.');
    dispatched.push(args.summary);
    return { done: true, summary: args.summary };
  };
  if (beforeDispatch) {
    const execute = agent._executeToolBatch.bind(agent);
    agent._executeToolBatch = async (...args) => {
      churn();
      if (change === 'dispatch-steering' && mainCalls === 1) steer();
      return execute(...args);
    };
  }
  const task = dependent ? 'Read the current iframe status.' : change === 'prior-done'
    ? 'Keep the opening line of your poem above and shorten the rest.' : 'Draft a conversation-only announcement from the facts above.';
  const run = () => streaming
    ? agent.processMessageStream(tab, task,
      (type, data) => updates.push({ type, data }), 'ask', { detachedRequestId: `owned-churn-${tab}`, askStreamingEnabled: true, interactiveChat: pendingRead })
    : agent.processMessage(tab, task,
      (type, data) => updates.push({ type, data }), 'ask', [], { detachedRequestId: `owned-churn-${tab}`, askStreamingEnabled: true, interactiveChat: pendingRead });
  return { agent, tab, run, fresh, old, updates, dispatched, reads, counts: () => ({ mainCalls, scopeCalls }), clean: () => {
    documents.delete(tab); documentHooks.delete(tab); unnumberedDocuments.delete(tab); monitorReplies.delete(tab);
  } };
}

for (const build of ['chrome', 'firefox']) {
  const { Agent } = await import(`../src/${build}/src/agent/agent.js`);
  for (const streaming of [false, true]) {
    for (const coverageComplete of [false, true]) test(`${build}: ${streaming ? 'stream' : 'interactive chat'} hides rejected drafts before ${coverageComplete ? 'complete' : 'partial'} delivery`, async () => {
      const f = fixture(Agent, { streaming, response: 'prose', change: 'dependent', dependent: true, pendingRead: true });
      if (coverageComplete) f.agent._readCompletenessBlock = () => f.counts().mainCalls >= 3
        ? null : 'Conversation coverage is still incomplete; continue reading.';
      try {
        assert.match(await f.run(), new RegExp(f.fresh));
        assert.equal(f.counts().mainCalls, 3, 'Both rejected candidates are regenerated before the accepted reply.');
        assert.equal(f.updates.filter(update => update.type === 'text_delta').length, 0,
          'Draft tokens must not be shown and subsequently erased.');
        const shown = f.updates.filter(update => update.type === 'text' && update.data.content);
        assert.ok(shown.length > 0, 'The accepted reply must still reach the UI.');
        assert.ok(shown.every(update => update.data.content.startsWith(f.fresh)));
        assert.ok(!shown.some(update => update.data.content.includes(f.old)));
      } finally { f.clean(); }
    });
    test(`${build}: ${streaming ? 'stream' : 'interactive chat'} still streams normally when no conversation reading is pending`, async () => {
      const f = fixture(Agent, { streaming, response: 'prose', pendingRead: true });
      f.agent._readCompletenessBlock = () => null;
      try {
        assert.equal(await f.run(), f.fresh);
        assert.ok(f.updates.some(update => update.type === 'text_delta' && update.data.content === f.fresh));
      } finally { f.clean(); }
    });
  }
  for (const streaming of [false, true]) for (const response of ['done', 'prose']) {
    test(`${build}: ${streaming ? 'stream' : 'chat'} ${response} delivers through child document churn`, async () => {
      const f = fixture(Agent, { streaming, response, beforeDispatch: response === 'done' });
      try {
        assert.equal(await f.run(), f.fresh);
        assert.deepEqual(f.counts(), { mainCalls: 1, scopeCalls: 1 });
        assert.deepEqual(f.dispatched, response === 'done' ? [f.fresh] : []);
        assert.deepEqual(f.reads, [], 'An independent reply needs no repeated page refresh.');
      } finally { f.clean(); }
    });
    for (const change of ['model-steering', 'scope-steering', 'scope-document', 'scope-provider', 'scope-candidate', 'scope-ignored-steering']) {
      test(`${build}: ${streaming ? 'stream' : 'chat'} ${response} cannot retain stale authority after ${change}`, async () => {
        const f = fixture(Agent, { streaming, response, change });
        try {
          assert.equal(await f.run(), f.fresh);
          assert.equal(f.counts().mainCalls, 2);
          assert.ok(!f.dispatched.includes(f.old));
          assert.ok(!f.agent.getConversation(f.tab, 'ask').some(message => message.role === 'assistant' && message.content === f.old));
        } finally { f.clean(); }
      });
    }
    // The person typing on the page while the answer is checked does not make
    // it stale: the answer is delivered once instead of being written again.
    test(`${build}: ${streaming ? 'stream' : 'chat'} ${response} is kept when the person types on the page during the final check`, async () => {
      const f = fixture(Agent, { streaming, response, change: 'final-user' });
      try {
        assert.equal(await f.run(), f.old);
        assert.equal(f.counts().mainCalls, 1);
      } finally { f.clean(); }
    });
    test(`${build}: ${streaming ? 'stream' : 'chat'} ${response} still refreshes a page-dependent answer`, async () => {
      const f = fixture(Agent, { streaming, response, change: 'dependent', dependent: true });
      try {
        assert.equal(await f.run(), f.fresh);
        assert.deepEqual(f.counts(), { mainCalls: 2, scopeCalls: 1 });
        assert.ok(f.reads.length > 0); assert.ok(!f.dispatched.includes(f.old));
      } finally { f.clean(); }
    });
    for (const change of ['scope-stop', 'scope-ignored-stop']) test(`${build}: ${streaming ? 'stream' : 'chat'} ${response} stops during ${change}`, { timeout: 1500 }, async () => {
      const f = fixture(Agent, { streaming, response, change });
      try {
        assert.match(await f.run(), /stop/i);
        assert.deepEqual(f.dispatched, []);
      } finally { f.clean(); }
    });
  }
  test(`${build}: steering after scope approval replaces the pending done candidate`, async () => {
    const f = fixture(Agent, { streaming: false, response: 'done', change: 'dispatch-steering', beforeDispatch: true });
    try {
      assert.equal(await f.run(), f.fresh); assert.equal(f.counts().mainCalls, 2);
      assert.deepEqual(f.dispatched, [f.fresh]);
    } finally { f.clean(); }
  });
  test(`${build}: automatic iframe churn has a finite retry budget for dependent answers`, async () => {
    const f = fixture(Agent, { streaming: false, response: 'done', change: 'dependent-continuous', dependent: true });
    try {
      assert.match(await f.run(), /could not validate the next action after repeated browser updates/i);
      assert.deepEqual(f.dispatched, []);
      assert.deepEqual(f.counts(), { mainCalls: 5, scopeCalls: 2 });
      assert.ok(f.updates.some(update => update.type === 'error' && update.data.code === 'page_unstable'));
    } finally { f.clean(); }
  });
  test(`${build}: dependency classification retains complete prior qualifications`, async () => {
    const f = fixture(Agent, { streaming: false, response: 'done', change: 'prior-context', dependent: true });
    try {
      assert.equal(await f.run(), f.fresh);
      assert.deepEqual(f.counts(), { mainCalls: 2, scopeCalls: 1 });
      assert.ok(!f.dispatched.includes(f.old));
    } finally { f.clean(); }
  });
  test(`${build}: completed done drafts remain reference context without verification fields`, async () => {
    const f = fixture(Agent, { streaming: false, response: 'done', change: 'prior-done' });
    try {
      assert.equal(await f.run(), f.fresh);
      assert.deepEqual(f.counts(), { mainCalls: 1, scopeCalls: 1 });
    } finally { f.clean(); }
  });
  test(`${build}: an unnumbered main document needs the live monitor's original identity`, async () => {
    const f = fixture(Agent, { streaming: false, response: 'done', change: 'missing-document-id' });
    try {
      assert.equal(await f.run(), f.fresh);
      assert.deepEqual(f.counts(), { mainCalls: 1, scopeCalls: 1 });
    } finally { f.clean(); }
  });
  test(`${build}: a foreign live monitor cannot grant an independent answer proof`, async () => {
    const f = fixture(Agent, { streaming: false, response: 'done', change: 'foreign-monitor' });
    try {
      assert.match(await f.run(), /could not validate the next action after repeated browser updates/i);
      assert.deepEqual(f.dispatched, []);
      assert.deepEqual(f.counts(), { mainCalls: 5, scopeCalls: 0 });
    } finally { f.clean(); }
  });
}
