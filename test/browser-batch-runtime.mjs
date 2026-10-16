import assert from 'node:assert/strict';
import { test } from 'node:test';

const area = { get: async () => ({}), set: async () => {}, remove: async () => {} };
const api = {
  storage: { local: area, session: area },
  runtime: { getURL: value => `chrome-extension://test/${value}`, sendMessage: async () => ({}) },
  tabs: { get: async id => ({ id, url: 'https://example.com/', title: 'Example', status: 'complete' }), sendMessage: async () => ({}) },
  scripting: { executeScript: async () => [{ result: null }] },
};
globalThis.chrome = api;
globalThis.browser = api;
const call = (id, name, input) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(input) } });
const field = n => ({ name: 'set_field', input: { ref_id: `ref_${n}`, text: `value ${n}` } });
const batch = (actions, id = 'batch') => call(id, 'browser_batch', { actions });

async function withClock(t, operation) {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 0 });
  let done = false;
  const pending = operation().finally(() => { done = true; });
  for (let elapsed = 0; elapsed < 10000 && !done; elapsed += 100) {
    await new Promise(setImmediate);
    t.mock.timers.tick(100);
  }
  assert.equal(done, true, 'fixture must finish within the bounded settling window');
  return pending;
}

for (const build of ['chrome', 'firefox']) {
  const { Agent } = await import(`../src/${build}/src/agent/agent.js`);
  const { getToolsForMode } = await import(`../src/${build}/src/agent/tools.js`);
  const { AnthropicProvider } = await import(`../src/${build}/src/providers/anthropic.js`);
  const { OpenAICompatibleProvider } = await import(`../src/${build}/src/providers/openai.js`);
  const { installPageFeedback } = await import(`../src/${build}/src/agent/page-feedback.js`);
  function setup(calls, tier = 'full') {
    const provider = { name: 'test', model: 'test', promptTier: tier, contextWindow: 128000, supportsVision: false };
    const agent = new Agent({ getActive: () => provider, getProvider: () => provider, getVisionProvider: async () => null });
    agent._persist = () => {};
    agent._persistNow = async () => ({ ok: true });
    agent._currentUrl = async () => 'https://example.com/';
    agent._ensureGateSetting = async () => false;
    agent._chromeProtectedPageFailure = async () => null;
    agent._captchaMutationPreflight = async () => null;
    agent._adoptLiveSocialPublishWorkflow = async () => false;
    agent._workflowPreSubmitDispatchBlock = async () => null;
    agent._messageRecipientGuardBlock = async () => null;
    agent._detectLikelySubmitAction = async () => null;
    agent._isFormValidationCandidate = () => false;
    agent._preflightRichTextToolbarTarget = async () => ({ block: null });
    agent._socialPublicationPreSubmitBlock = async () => null;
    agent._auditRichTextToolbarTarget = async () => {};
    agent._shouldAutoScreenshot = () => false;
    agent._resolveVisionRoute = async () => ({ provider: null });
    const gates = [], dispatched = [], updates = [], snapshots = [];
    agent.permissions.hydrate = async () => {};
    agent.permissions.check = (host, capability, tabId) => { gates.push({ host, capability, tabId }); return { allowed: true }; };
    agent.executeTool = async (_tab, name, args) => { dispatched.push({ name, args }); return { success: true, verified: true }; };
    const messages = [{ role: 'user', content: 'Fill the known fields.' }, { role: 'assistant', content: '', tool_calls: calls }];
    agent.conversations.set(1, messages);
    agent._persist = () => snapshots.push(agent._conversationStorageEntry(1));
    const tools = getToolsForMode('act', { tier });
    const run = () => agent._executeToolBatch(1, calls, messages, (type, data) => updates.push({ type, data }), provider, null,
      new Set(tools.map(tool => tool.function.name)), 1, {}, new Map(tools.map(tool => [tool.function.name, tool.function.parameters])));
    return { agent, messages, run, gates, dispatched, updates, snapshots, provider };
  }
  function assertPaired(messages) {
    let pending = new Set();
    for (const message of messages) {
      if (message.role === 'tool') assert.ok(pending.delete(message.tool_call_id), `unexpected result ${message.tool_call_id}`);
      else {
        assert.equal(pending.size, 0, 'attachments must follow all results');
        pending = new Set(message.tool_calls?.map(call => call.id) || []);
      }
    }
    assert.equal(pending.size, 0);
    assert.ok(messages.every(message => !message.tool_call_id?.includes('::')));
  }

  test(`${build}: explicit Mid batch uses each normal permission gate and folds one parent result`, async () => {
    const parent = batch([field(1), field(2), { name: 'get_window_info', input: {} }]);
    const h = setup([parent], 'mid');
    const before = structuredClone(parent);
    await h.run();
    assert.deepEqual(h.dispatched.map(item => item.name), ['set_field', 'set_field', 'get_window_info']);
    assert.equal(h.gates.filter(gate => gate.capability === 'type').length, 2);
    assert.ok(h.gates.every(gate => gate.host === 'example.com'));
    assert.deepEqual(parent, before);
    assertPaired(h.messages);
    assert.equal(h.messages.filter(message => message.role === 'tool').length, 1);
    assert.match(h.messages.at(-1).content, /ran 3 of 3/);
    assert.equal(h.updates.filter(event => event.type === 'tool_call' && event.data.name === 'browser_batch').length, 1);
    assert.equal(h.updates.filter(event => event.type === 'tool_result' && event.data.name === 'browser_batch').length, 1);
  });

  test(`${build}: only verified batched type_text dispatches hand off exact clear semantics`, async () => {
    for (const scenario of [
      { clear: true, result: { success: true, verified: true }, seal: true },
      { clear: false, result: { success: true, verified: true }, seal: true },
      { result: { success: true, verified: true }, seal: true },
      { clear: true, result: { success: true, verified: false }, seal: false },
      { clear: true, result: { success: true, verified: true, noDispatch: true }, seal: false },
      { clear: true, result: { success: true, verified: true, outcomeUnknown: true }, seal: false },
      { clear: true, result: { success: true, verified: true }, seal: false, native: true },
    ]) {
      class FixtureAgent {
        static STATE_CHANGE_TOOLS = new Set(['type_text']);
        isRunning() { return true; }
        _checkAbort() { return false; }
        async executeTool() { return scenario.result; }
      }
      installPageFeedback(FixtureAgent);
      const agent = new FixtureAgent();
      const originalMessage = api.tabs.sendMessage;
      let finish;
      api.tabs.sendMessage = async (_tab, message) => {
        if (message.action === 'page_monitor_prepare') return { ready: true, modelBindingValid: true };
        if (message.action === 'page_monitor_finish') finish = message.params;
        return {};
      };
      try {
        await agent._beginPageFeedbackRun(1993, 'interactive');
        agent._pageFeedbackRuns.get(1993).modelState = { actionBinding: { snapshotToken: 'original-snapshot' } };
        agent._validatePageFeedbackAction = async () => true;
        agent._pageFeedbackStateCurrent = () => true;
        agent._pageFeedbackBlocksCall = () => false;
        await agent.executeTool(1993, 'type_text', { selector: '#name', text: 'Ada', clear: scenario.clear }, () => {},
          scenario.native ? {} : { _browserBatch: { parentId: 'parent' } });
        assert.equal(finish?.commitBrowserBatchInput === true, scenario.seal, JSON.stringify(scenario));
        if (scenario.seal) {
          assert.equal(finish.batchId, 'parent');
          assert.equal(finish.batchInputText, 'Ada');
          assert.equal(finish.batchInputClear, scenario.clear === true);
        }
      } finally {
        agent._finishPageFeedbackRun(1993);
        api.tabs.sendMessage = originalMessage;
      }
    }
  });

  for (const scenario of [
    { tier: 'full', active: 'mid', count: 7, dispatched: 7 },
    { tier: 'mid', active: 'full', count: 7, dispatched: 0 },
    { tier: 'mid', active: 'full', count: 2, dispatched: 2, sibling: true },
    { tier: 'full', active: 'mid', count: 2, dispatched: 3, sibling: true },
  ]) test(`${build}: ${scenario.tier} run uses its own tier with ${scenario.active} active (${scenario.count} actions${scenario.sibling ? ' and sibling' : ''})`, async () => {
    const calls = [batch(Array.from({ length: scenario.count }, (_, index) => field(index)))];
    if (scenario.sibling) calls.push(call('sibling', 'get_window_info', {}));
    const h = setup(calls, scenario.tier);
    h.agent.providerManager.getActive = () => ({ ...h.provider, promptTier: scenario.active });
    await h.run();
    assert.equal(h.dispatched.length, scenario.dispatched);
    assertPaired(h.messages);
    if (!scenario.dispatched) assert.match(h.messages.at(-1).content, /invalid_browser_batch/);
    else if (scenario.sibling && scenario.tier === 'mid') {
      assert.equal(JSON.parse(h.messages.at(-1).content).reason, 'small_model_action_boundary');
    }
  });

  for (const scenario of ['mutation', 'observation', 'reload', 'timeout']) test(`${build}: delayed navigation ${scenario} settles before a fresh batch decision`, async t => {
    const next = scenario === 'observation' ? { name: 'read_page', input: {} } : field(2);
    const h = setup([batch([{ name: 'click_ax', input: { ref_id: 'ref_1' } }, next]), call('sibling', 'get_window_info', {})]);
    const originalGet = api.tabs.get;
    t.after(() => { api.tabs.get = originalGet; });
    let dispatchedAt = null;
    let nextAt = null;
    const elapsed = () => dispatchedAt === null ? -1 : Date.now() - dispatchedAt;
    const loading = () => elapsed() >= 300 && (scenario === 'timeout' || elapsed() < 600);
    const url = () => elapsed() >= 300 && scenario !== 'reload' ? 'https://example.com/next' : 'https://example.com/';
    api.tabs.get = async id => ({ id, url: url(), status: loading() ? 'loading' : 'complete' });
    h.agent._currentUrl = async () => url();
    h.agent.executeTool = async (_tab, name, args) => {
      h.dispatched.push({ name, args });
      if (dispatchedAt === null) dispatchedAt = Date.now();
      else nextAt = elapsed();
      return { success: true, verified: true };
    };
    await withClock(t, h.run);
    assertPaired(h.messages);
    assert.deepEqual(h.dispatched.map(item => item.name), scenario === 'observation' ? ['click_ax', 'read_page'] : ['click_ax']);
    if (scenario === 'observation') assert.ok(nextAt >= 800, 'observation waits for navigation and quiet completion');
    assert.equal(JSON.parse(h.messages.find(message => message.tool_call_id === 'sibling').content).reason,
      scenario === 'timeout' ? 'action_unverified' : 'navigation_changed');
  });

  test(`${build}: a complete tab gets a bounded delayed-navigation grace period`, async t => {
    const { agent } = setup([]);
    let result;
    let finishedAt;
    await withClock(t, async () => {
      result = await agent._settleBrowserBatchNavigation(1);
      finishedAt = Date.now();
    });
    assert.deepEqual(result, { settled: true, navigationObserved: false });
    assert.ok(finishedAt >= 500 && finishedAt <= 700);
  });

  test(`${build}: malformed later input prevents every dispatch`, async () => {
    const h = setup([batch([field(1), { name: 'set_field', input: { ref_id: 'ref_2' } }])]);
    await h.run();
    assert.equal(h.dispatched.length, 0);
    assert.equal(h.gates.length, 0);
    assert.equal(h.messages.filter(message => message.role === 'tool').length, 1);
    assert.match(h.messages.at(-1).content, /invalid_browser_batch/);
  });

  test(`${build}: malformed parent JSON uses native transcript repair without changing the original call`, async () => {
    const parent = batch([field(1)]);
    parent.function.arguments = 'not a JSON object';
    const h = setup([parent]);
    const reasoning = { type: 'reasoning', encrypted_content: 'original-reasoning' };
    const item = { type: 'function_call', name: 'browser_batch', call_id: parent.id, arguments: parent.function.arguments };
    h.messages[1].response_items = [reasoning, item];
    await h.run();
    assert.equal(h.dispatched.length, 0);
    assert.equal(parent.function.arguments, 'not a JSON object');
    assert.equal(h.messages[1].tool_calls[0].function.arguments, '{}');
    assert.equal(h.messages[1].response_items[0], reasoning);
    assert.equal(h.messages[1].response_items[1].arguments, '{}');
    assert.equal(item.arguments, 'not a JSON object');
    assertPaired(h.messages);
    const wire = new OpenAICompatibleProvider({ apiKey: 'test', model: 'test' })._buildChatCompletionsBody(h.messages);
    for (const message of wire.messages) for (const tool of message.tool_calls || []) assert.doesNotThrow(() => JSON.parse(tool.function.arguments));
  });

  test(`${build}: rejected batch collision preserves the executed native sibling through persistence and provider conversion`, async () => {
    const h = setup([batch([field(1)]), call('batch::0', 'get_window_info', {})]);
    await h.run();
    assert.deepEqual(h.dispatched.map(item => item.name), ['get_window_info']);
    const results = h.messages.filter(message => message.role === 'tool');
    assert.deepEqual(results.map(message => message.tool_call_id), ['batch', 'batch::0']);
    assert.equal(JSON.parse(results[0].content).errorCode, 'invalid_browser_batch');
    assert.equal(JSON.parse(h.agent._unwrapUntrusted(results[1].content)).success, true);
    assert.doesNotMatch(results[1].content, /not run|"skipped":true/);
    const snapshot = h.agent._conversationStorageEntry(1);
    assert.deepEqual(snapshot.messages.filter(message => message.role === 'tool'), results);
    const wire = new OpenAICompatibleProvider({ apiKey: 'test', model: 'test' })._buildChatCompletionsBody(snapshot.messages);
    assert.deepEqual(wire.messages.filter(message => message.role === 'tool').map(message => message.tool_call_id), ['batch', 'batch::0']);
    const anthropic = new AnthropicProvider({ apiKey: 'test', model: 'claude-test' })._convertMessages(snapshot.messages);
    const toolResults = anthropic.messages.flatMap(message => Array.isArray(message.content) ? message.content : []).filter(block => block.type === 'tool_result');
    assert.deepEqual(toolResults.map(block => block.tool_use_id), ['batch', 'batch::0']);
  });

  test(`${build}: permission denial stops the batch before any dispatch`, async () => {
    const h = setup([batch([field(1), field(2)]), call('sibling', 'get_window_info', {})]);
    h.agent.permissions.check = () => ({ allowed: false, needsPrompt: false });
    await h.run();
    assert.equal(h.dispatched.length, 0);
    assertPaired(h.messages);
    assert.match(h.messages.find(message => message.tool_call_id === 'batch').content, /ran 0 of 2/);
    assert.equal(JSON.parse(h.messages.at(-1).content).skipped, true);
  });

  test(`${build}: a preparation failure that normally continues still ends an explicit batch`, async () => {
    const h = setup([batch([field(1), field(2)]), call('sibling', 'get_window_info', {})]);
    let checks = 0;
    h.agent._pureCalculationToolBlock = () => {
      checks++;
      return { success: false, noDispatch: true, error: 'fixture preflight rejection' };
    };
    await h.run();
    assert.equal(checks, 1);
    assert.equal(h.dispatched.length, 0);
    assertPaired(h.messages);
    assert.match(h.messages.find(message => message.tool_call_id === 'batch').content, /ran 0 of 2/);
  });

  test(`${build}: inserted progress notes cannot shift the wrapper result lookup`, async () => {
    const h = setup([batch([field(1), field(2)])]);
    h.messages[1] = structuredClone(h.messages[1]);
    let count = 0;
    h.agent.executeTool = async () => {
      if (!count++) h.messages.unshift({ role: 'system', content: 'app-owned progress fixture' });
      return { success: true, verified: true };
    };
    await h.run();
    assertPaired(h.messages);
    const wrapper = h.updates.find(event => event.type === 'tool_result' && event.data.name === 'browser_batch');
    assert.equal(wrapper.data.result.success, true);
    assert.equal(wrapper.data.result.summary, '[browser_batch] ran 2 of 2 actions');
  });

  test(`${build}: content-free traces preserve bounded batch membership`, async () => {
    const { projectTraceEventData } = await import(`../src/${build}/src/trace/privacy.js`);
    const metadata = { parentId: 'parent_1', index: 1, total: 3 };
    const projected = projectTraceEventData('tool', { name: 'set_field', batch: { ...metadata, input: 'PRIVATE' }, args: { text: 'PRIVATE' }, result: { success: true, text: 'PRIVATE' } });
    assert.deepEqual(projected.batch, metadata);
    assert.ok(!JSON.stringify(projected).includes('PRIVATE'));
    assert.equal(projectTraceEventData('tool', { name: 'set_field' }).batch, undefined);
    assert.equal(projectTraceEventData('tool', { name: 'set_field', batch: { ...metadata, index: 4 } }).batch, undefined);
  });

  for (const problem of [{ success: false, error: 'failed' }, { success: true, verified: false }]) {
    test(`${build}: ${problem.success ? 'unverified' : 'failed'} action stops children and siblings`, async () => {
      const h = setup([batch([field(1), field(2), field(3)]), call('sibling', 'get_window_info', {})]);
      let count = 0;
      h.agent.executeTool = async () => ++count === 2 ? problem : { success: true, verified: true };
      await h.run();
      assert.equal(count, 2);
      assertPaired(h.messages);
      assert.match(h.messages.find(message => message.tool_call_id === 'batch').content, /ran 2 of 3/);
      assert.equal(JSON.parse(h.messages.find(message => message.tool_call_id === 'sibling').content).skipped, true);
    });
  }

  for (const observation of [false, true]) test(`${build}: navigation ${observation ? 'permits trailing observations' : 'stops remaining mutations'}`, async () => {
    const next = observation ? { name: 'get_window_info', input: {} } : field(2);
    const h = setup([batch([{ name: 'navigate', input: { url: 'https://example.com/next' } }, next])], 'mid');
    await h.run();
    assert.equal(h.dispatched.length, observation ? 2 : 1);
    assertPaired(h.messages);
  });

  for (const submit of [
    { name: 'set_field', input: { ref_id: 'ref_1', text: 'search', submit: true } },
    { name: 'press_keys', input: { key: 'Enter' } },
  ]) test(`${build}: ${submit.name} submit stops before the next action`, async () => {
    const h = setup([batch([submit, field(2)])]);
    h.agent._isFormValidationCandidate = () => true;
    h.agent._detectLikelySubmitAction = async () => ({ isSubmit: true, validationSubmitEvidence: 'strong' });
    h.agent._captureFormValidationState = async () => [];
    h.agent._readCompletionResult = async () => null;
    h.agent._waitForFormValidationFailure = async () => null;
    h.agent._skipPermissionGate = true;
    await h.run();
    assert.equal(h.dispatched.length, 1);
    assert.match(h.messages.at(-1).content, /submit_boundary/);
  });

  test(`${build}: Mid boundary still skips a sibling after trailing observation`, async () => {
    const h = setup([batch([field(1), { name: 'get_window_info', input: {} }]), call('sibling', 'get_window_info', {})], 'mid');
    await h.run();
    assert.equal(h.dispatched.length, 2);
    assertPaired(h.messages);
    assert.equal(JSON.parse(h.messages.at(-1).content).reason, 'small_model_action_boundary');
  });

  test(`${build}: navigate then read cannot authorize a stale Full-tier sibling`, async () => {
    const h = setup([batch([{ name: 'navigate', input: { url: 'https://example.com/next' } }, { name: 'get_window_info', input: {} }]), call('sibling', 'set_field', field(2).input)]);
    await h.run();
    assert.deepEqual(h.dispatched.map(item => item.name), ['navigate', 'get_window_info']);
    assertPaired(h.messages);
    assert.equal(JSON.parse(h.messages.at(-1).content).reason, 'navigation_changed');
  });

  test(`${build}: two Full batches and a native sibling retain paired results`, async () => {
    const h = setup([batch([field(1), field(2)], 'first'), batch([field(3)], 'second'), call('native', 'get_window_info', {})]);
    await h.run();
    assert.equal(h.dispatched.length, 4);
    assertPaired(h.messages);
    assert.deepEqual(h.messages.filter(message => message.role === 'tool').map(message => message.tool_call_id), ['first', 'second', 'native']);
  });

  test(`${build}: actual mid-batch storage and provider boundaries fold copies without modifying live execution`, async () => {
    const h = setup([batch([field(1), field(2)])]);
    let count = 0;
    h.agent.executeTool = async () => {
      if (++count === 2) {
        const snapshot = h.agent._conversationStorageEntry(1);
        assertPaired(snapshot.messages);
        assert.match(snapshot.messages.at(-1).content, /ran 1 of 2/);
        assert.match(snapshot.messages.at(-1).content, /not run \(interrupted\)/);
        assert.ok(h.messages.some(message => message.tool_call_id === 'batch::0'));
        h.agent._checkCostAllowance = async () => null;
        h.agent._recordCostUsage = async () => null;
        const wire = { chat: async messages => { assertPaired(messages); return { content: '' }; }, async *chatStream(messages) { assertPaired(messages); yield { type: 'done' }; } };
        await h.agent._chatWithCostAllowance(wire, h.messages, {}, null);
        await h.agent._chatStreamWithCostAllowance(wire, h.messages, {}, null);
        new AnthropicProvider({ apiKey: 'test', model: 'claude-test' })._convertMessages(snapshot.messages);
        new OpenAICompatibleProvider({ apiKey: 'test', model: 'test' })._buildChatCompletionsBody(snapshot.messages);
      }
      return { success: true, verified: true };
    };
    await h.run();
    assert.equal(count, 2);
    assertPaired(h.messages);
  });

  test(`${build}: cancellation after first dispatch repairs children then folds without nested wrapping`, async () => {
    const h = setup([batch([field(1), field(2)])]);
    await h.agent._claimRunEntry(1, 'interactive');
    let count = 0;
    h.agent.executeTool = async (_tab, _name, _args, _update, context) => {
      count++;
      context._contentActionDispatchState.started = true;
      h.agent.abort(1);
      throw context._contentActionAbortSignal.reason;
    };
    await assert.rejects(h.run(), { name: 'AbortError' });
    assert.equal(count, 1);
    assertPaired(h.messages);
    const result = h.messages.at(-1).content;
    assert.ok(result.startsWith('[browser_batch]'));
    assert.match(result, /outcomeUnknown/);
    assert.match(result, /not run/);
    assert.ok((result.match(/<untrusted_page_content id=/g) || []).length >= 1);
    h.agent._releaseRunEntry(1);
  });

  for (const trim of ['normal', 'emergency']) test(`${build}: ${trim} context trimming preserves batch child boundaries and metadata`, async () => {
    const h = setup([batch(Array.from({ length: 3 }, () => ({ name: 'read_page', input: {} })))]);
    h.messages.unshift({ role: 'system', content: 'System instructions.' });
    let reads = 0;
    h.agent.executeTool = async () => ({ success: true, text: ++reads === 1 ? 'First page.' : 'PRIVATE-PAGE '.repeat(1000) });
    await h.run();
    const original = h.messages.find(message => message.tool_call_id === 'batch').content;
    const openings = content => [...content.matchAll(/<untrusted_page_content id="([^"]+)"[^>]*>/g)].map(match => match[1]);
    assert.equal(openings(original).length, 3);
    const digest = h.agent._digestToolResult('browser_batch', original);
    if (trim === 'normal') assert.equal(h.agent._truncateOversizedMessages(1, h.messages), true);
    else h.agent._emergencyTrim(h.messages);
    const result = h.messages.find(message => message.tool_call_id === 'batch').content;
    const retainedIds = openings(result);
    assert.equal(retainedIds.length, 2, 'retain the first child and the truncated second child');
    assert.deepEqual(retainedIds, openings(original).slice(0, 2), 'keep original nonces');
    assert.deepEqual([...result.matchAll(/<\/untrusted_page_content id="([^"]+)">/g)].map(match => match[1]), retainedIds);
    assert.ok(result.length <= 2000 + '\n[...truncated to fit context]'.length);
    assert.equal(h.agent._hasUntrustedWrapper(result), true);
    assert.equal(h.agent._digestToolResult('browser_batch', result), digest);
    assertPaired(h.messages);
  });

  test(`${build}: every batch truncation cutoff keeps whole matching markers`, () => {
    const { agent } = setup([]);
    const blocks = [1, 2, 3].map(index => agent._wrapUntrusted('read_page', `PRIVATE-PAGE-${index} `.repeat(5)));
    const content = `[browser_batch] header\n${blocks.join('\nnext child\n')}\ntrusted trailing note`;
    const originalIds = [...content.matchAll(/<untrusted_page_content id="([^"]+)">/g)].map(match => match[1]);
    for (let limit = 1; limit < content.length; limit++) {
      const result = agent._truncatePreservingUntrustedWrapper(content, limit);
      const retainedIds = [...result.matchAll(/<untrusted_page_content id="([^"]+)">/g)].map(match => match[1]);
      assert.deepEqual(retainedIds, originalIds.slice(0, retainedIds.length), `original nonce order at ${limit}`);
      const outside = result.replace(/<untrusted_page_content id="([^"]+)">[\s\S]*?<\/untrusted_page_content id="\1">/g, '');
      assert.doesNotMatch(outside, /[<>]|PRIVATE/, `partial marker or unwrapped page bytes at ${limit}`);
      assert.ok(result.length <= limit + '\n[...truncated to fit context]'.length, `bounded at ${limit}`);
    }
  });

  test(`${build}: truncation still closes a legacy single wrapper and leaves plain text behavior intact`, () => {
    const { agent } = setup([]);
    const source = agent._wrapUntrusted('read_page', 'PRIVATE-PAGE '.repeat(1000));
    const result = agent._truncatePreservingUntrustedWrapper(source, 2000);
    assert.ok(result.startsWith(source.slice(0, source.indexOf('\n'))));
    assert.ok(result.endsWith(source.slice(source.lastIndexOf('\n'))));
    assert.equal(agent._hasUntrustedWrapper(result), true);
    assert.equal(agent._truncatePreservingUntrustedWrapper('ordinary text', 5), 'ordin\n[...truncated to fit context]');
  });

  test(`${build}: one auto screenshot after several mutations, paired before supplemental image`, async () => {
    const h = setup([batch([field(1), field(2)])]);
    let shots = 0;
    h.agent._shouldAutoScreenshot = () => true;
    h.agent._advanceAutoScreenshotBurst = () => true;
    h.agent._resolveVisionRoute = async () => ({ provider: h.provider, rawImage: true });
    h.agent._captureBudgetedAutoScreenshot = async () => { shots++; return { dataUrl: 'data:image/png;base64,AAAA' }; };
    h.agent._getVisibleInteractiveElements = async () => [];
    await h.run();
    assert.equal(shots, 1);
    assertPaired(h.messages);
    assert.equal(h.messages.at(-1).role, 'user');
  });
}
