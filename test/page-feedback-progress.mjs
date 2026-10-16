import assert from 'node:assert/strict';
import { withFixtureCalculationReadings } from './calculation-fixture-readings.mjs';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';

const ORIGINAL_CALC_CORRECTION = readFileSync(new URL('./fixtures/literal-calculation-correction.txt', import.meta.url), 'utf8').trim();

const PAGE_URL = 'https://example.com/photo/1';
const documents = new Map();
const area = { get: async () => ({}), set: async () => {}, remove: async () => {} };
const api = {
  storage: { local: area, session: area },
  runtime: { getURL: value => `extension://test/${value}`, sendMessage: async () => ({}) },
  tabs: { get: async id => ({ id, url: PAGE_URL, title: 'Photo' }), sendMessage: async () => ({ ready: true }) },
  webNavigation: { getAllFrames: async ({ tabId }) => [{ frameId: 0, parentFrameId: -1, documentId: documents.get(tabId) || 'document-1', url: PAGE_URL }] },
  scripting: { executeScript: async () => [{ result: null }] },
};
globalThis.chrome = api;
globalThis.browser = api;
let nextTab = 2600;

function makeAgent(Agent, next) {
  const provider = {
    name: 'feedback progress test', model: 'test', promptTier: 'full', contextWindow: 128000,
    supportsTools: true, supportsVision: false,
    chat: withFixtureCalculationReadings(messages => messages[0]?.content?.startsWith('You classify whether one proposed terminal WebBrain Ask answer')
      ? Promise.resolve({ content: '{"pageIndependent":false}' }) : next(messages)),
    async *chatStream(messages) {
      const response = await next(messages);
      if (response.content) yield { type: 'text', content: response.content };
      if (response.toolCalls) yield { type: 'tool_call', content: response.toolCalls.map((call, index) => ({ ...call, index })) };
      yield { type: 'done' };
    },
  };
  const agent = new Agent({ getActive: () => provider, getProvider: () => provider, getVisionProvider: async () => null });
  agent._hydrate = async () => {};
  agent._persist = () => {};
  agent._persistNow = async () => ({ ok: true });
  agent._persistSubmittedTurn = async () => {};
  agent._startTraceRun = async () => null;
  agent._endTraceRun = async () => {};
  agent._beginReadCompleteness = async () => null;
  agent._manageContext = async () => {};
  agent._checkCostAllowance = async () => null;
  agent._recordCostUsage = async () => null;
  agent._currentUrl = async () => PAGE_URL;
  agent._getTabUrlTitle = async () => ({ tabUrl: PAGE_URL, tabTitle: 'Photo' });
  agent._maybeEmitAskModeHandoff = async () => {};
  agent._maybeReinjectAdapter = async () => {};
  agent._ensureProgressSessionForCurrentTask = async () => {};
  agent._plannerMode = () => 'off';
  agent._runPlannerIntentGate = async () => ({
    proceed: true, requestKind: 'execute', requiresStateChange: false, requiresSubmission: false,
  });
  agent._skipPermissionGate = true;
  agent._ensureGateSetting = async () => true;
  for (const name of ['_chromeProtectedPageFailure', '_captchaMutationPreflight', '_workflowPreSubmitDispatchBlock',
    '_messageRecipientGuardBlock', '_detectLikelySubmitAction', '_socialPublicationPreSubmitBlock']) agent[name] = async () => null;
  agent._adoptLiveSocialPublishWorkflow = async () => false;
  agent._isFormValidationCandidate = () => false;
  agent._preflightRichTextToolbarTarget = async () => ({ block: null });
  agent._auditRichTextToolbarTarget = async () => {};
  agent._shouldAutoScreenshot = () => false;
  agent._pageFeedbackIdleMs = 0;
  agent._completionDoneBlock = () => null;
  agent.maxSteps = 5;
  return agent;
}

function bind(agent, tab) {
  const from = { tab: { id: tab }, frameId: 0, documentId: 'document-1', url: PAGE_URL };
  const state = agent.pageMonitorState(from, 'content-1');
  assert.equal(state.active, true);
  let seq = 0;
  return value => {
    const current = ++seq;
    assert.equal(agent.observePageFeedback(from, {
      ...state, seq: current, revision: current, kind: 'dom', source: 'page', target: 'span#views', ...value,
    }).accepted, true);
  };
}

const call = (id, name, args) => ({ toolCalls: [{ id, function: { name, arguments: JSON.stringify(args) } }] });
const ANSWER = 'The photo is https://images.example/current-photo.jpg';
const done = () => call('finished', 'done', { summary: ANSWER, outcome: 'success' });
const finish = (agent, tab, streaming, updates, options) => streaming
  ? agent.processMessageStream(tab, 'Extract the current photo', (type, data) => updates.push({ type, data }), 'act', options)
  : agent.processMessage(tab, 'Extract the current photo', (type, data) => updates.push({ type, data }), 'act', [], options);

for (const build of ['chrome', 'firefox']) {
  const { Agent } = await import(`../src/${build}/src/agent/agent.js`);

  test(build + ': natural arithmetic receipt needs actual calculation and current owned planner intent', async () => {
    const tab = nextTab++, expression = '12345678901234567890 * 7 + 0.125';
    let providerCalls = 0;
    const agent = makeAgent(Agent, async () => { providerCalls++; return {}; });
    agent.conversations.set(tab, [{ role: 'system', content: 'Owned fixture system.' },
      { role: 'user', content: ORIGINAL_CALC_CORRECTION }]);
    agent.conversationModes.set(tab, 'act');
    const plan = { read_scope: 'none', deliverables: ['Exact arithmetic result', 'Response formatting marker'] };
    const fields = agent._plannerCompletionGateFields(plan);
    const guard = agent._startPlanExecutionGuard(tab, 'act', { ...fields, requestKind: 'execute',
      requiresStateChange: false, requiresSubmission: false });
    await agent._prepareCalculationReading(tab);
    agent._beginCompletionInvariant(tab);
    const args = { expression };
    assert.equal(agent._pageFeedbackCalculationComplete(tab), false, 'A plan is not a calculation receipt.');
    agent._recordCompletionToolResult(tab, 'calculate', args, { success: false, error: 'Owned calculation rejected.' });
    assert.equal(agent._pageFeedbackCalculationComplete(tab), false, 'Failed calculation cannot establish a receipt.');
    const result = await agent._executeToolImpl(tab, 'calculate', args);
    agent._markPlanExecutionToolCall(tab, 'calculate', result);
    agent._recordCompletionToolResult(tab, 'calculate', args, result);
    assert.equal(agent._pageFeedbackCalculationComplete(tab), true);
    // The planner's own page reads veto the scope; its deliverable words are
    // not read at all.
    for (const [key, value, complete] of [['readScope', 'visible', false], ['deliverables', [], true],
      ['deliverables', ['Exact arithmetic result and read the page'], true]]) {
      const previous = guard[key]; guard[key] = value;
      assert.equal(agent._pageFeedbackCalculationComplete(tab), complete, key);
      guard[key] = previous;
      assert.equal(agent._pageFeedbackCalculationComplete(tab), true);
    }
    for (const invalid of [Array(9).fill('Exact arithmetic result'), ['Exact arithmetic result', 42],
      ['Exact arithmetic result', 'x'.repeat(1001)]]) {
      assert.deepEqual(agent._plannerCompletionGateFields({ ...plan, deliverables: invalid }).deliverables, [],
        'Invalid extra work must not be silently dropped or truncated from the intent.');
    }
    for (const mixed of [
      'Only calculate ' + expression + '. Report the exact result and post it.',
      'Only calculate ' + expression + '. Report the result using current page data.',
    ]) {
      const mixedTab = nextTab++;
      agent.conversations.set(mixedTab, [{ role: 'system', content: 'Owned fixture system.' }, { role: 'user', content: mixed }]);
      agent.conversationModes.set(mixedTab, 'act');
      agent._startPlanExecutionGuard(mixedTab, 'act', { ...fields, requestKind: 'execute',
        requiresStateChange: false, requiresSubmission: false });
      await agent._prepareCalculationReading(mixedTab);
      agent._beginCompletionInvariant(mixedTab);
      agent._markPlanExecutionToolCall(mixedTab, 'calculate', result);
      agent._recordCompletionToolResult(mixedTab, 'calculate', args, result);
      assert.equal(agent._pageFeedbackCalculationComplete(mixedTab), false,
        'Arithmetic-only planner metadata cannot override a request read as mixed work.');
    }
    assert.equal(providerCalls, 0, 'Only the request readings and the actual deterministic tool ran; no other model request.');
  });

  test(`${build}: calculate terminal retention binds the actual result to task/run/provider and excludes unfinished page work`, async () => {
    const tab = nextTab++, expression = '12345678901234567890 * 7 + 0.125';
    const agent = makeAgent(Agent, async () => ({}));
    const task = { role: 'user', content: `Only calculate ${expression}; do not interact with the page.` };
    agent.conversations.set(tab, [{ role: 'system', content: 'Owned fixture system.' }, task]);
    agent.conversationModes.set(tab, 'act');
    const guard = agent._startPlanExecutionGuard(tab, 'act', { requestKind: 'execute', requiresStateChange: false, requiresSubmission: false });
    await agent._prepareCalculationReading(tab);
    agent._beginCompletionInvariant(tab);
    const args = { expression }, result = await agent._executeToolImpl(tab, 'calculate', args);
    agent._markPlanExecutionToolCall(tab, 'calculate', result);
    agent._recordCompletionToolResult(tab, 'calculate', args, result);
    assert.equal(agent._pageFeedbackCalculationComplete(tab), true);
    const savedCompletion = agent.completionInvariants.get(tab), receipt = guard.pureCalculationReceipt;
    const provider = agent._activeProvider(tab), config = provider.config;
    const deny = (name, change, restore) => {
      change(); assert.equal(agent._pageFeedbackCalculationComplete(tab), false, name); restore();
      assert.equal(agent._pageFeedbackCalculationComplete(tab), true, `${name}: original fixture restored`);
    };
    deny('a genuinely new task with identical wording has different authority', () => agent.conversations.get(tab).push({ ...task, webbrainResumeTaskId: undefined }), () => agent.conversations.get(tab).pop());
    deny('same provider object changed in place', () => { provider.config = { endpoint: 'https://other-owned-provider.invalid', account: 'different' }; }, () => { provider.config = config; });
    deny('new completion run cannot inherit old calculation', () => agent._beginCompletionInvariant(tab), () => agent.completionInvariants.set(tab, savedCompletion));
    deny('Stop wins over a successful calculation', () => agent.abortFlags.set(tab, true), () => agent.abortFlags.delete(tab));
    deny('unapplied steering cannot reuse result', () => agent._steeringRuns.set(tab, { messages: [{}], revision: 1, authorizedRevision: 0 }), () => agent._steeringRuns.delete(tab));
    deny('verified prior page action is still page work', () => { savedCompletion.hadAction = true; }, () => { savedCompletion.hadAction = false; });
    deny('unverified action debt stays outstanding', () => { savedCompletion.verificationDebt = true; }, () => { savedCompletion.verificationDebt = false; });
    deny('iframe form verification remains required', () => { savedCompletion.iframeFormVerificationDebt = true; }, () => { savedCompletion.iframeFormVerificationDebt = false; });
    for (const [key, value] of [['requiresStateChange', true], ['requiresSubmission', true], ['requiresDownload', true],
      ['requiredSchedulingTool', 'schedule_task'], ['siteWorkflow', { job: {} }], ['messaging', { target_kind: 'active_conversation' }],
      ['draftRecipients', { target_kind: 'active_conversation' }], ['steeringPriorSubmission', { dispatched: true }]]) {
      const previous = guard[key]; deny(key, () => { guard[key] = value; }, () => { guard[key] = previous; });
    }
    deny('unfinished ledger rows cannot be waived', () => agent.progressLedgers.set(tab, [{ id: 'required-row', status: 'pending' }]), () => agent.progressLedgers.delete(tab));
    deny('uncertain chat send stays pending', () => agent.chatSessions.set(tab, { pendingOutbound: { text: 'owned uncertain body' } }), () => agent.chatSessions.delete(tab));
    deny('receipt cannot come from another arithmetic expression', () => { receipt.expression = '1 + 1'; }, () => { receipt.expression = expression; });
    agent.conversations.get(tab).push({ role: 'user', content: `Calculate ${expression}, then send the answer to a recipient.` });
    assert.equal(agent._pageFeedbackCalculationComplete(tab), false);
    agent._completionDoneBlock = Agent.prototype._completionDoneBlock;
    savedCompletion.hadAction = true; savedCompletion.verificationDebt = true;
    assert.ok(agent._completionDoneBlock(tab, { outcome: 'success', summary: result.result }), 'Ordinary terminal invariant still refuses unresolved actions.');
  });

  for (const streaming of [false, true]) {
    for (const allowed of [true, false]) {
      test(`${build}: ${streaming ? 'stream' : 'chat'} API fallback survives continuous counters and still requires API consent (${allowed})`, async () => {
        const tab = nextTab++, updates = [], sent = [];
        const args = { url: 'https://api.mail.test/accounts', method: 'POST',
          headers: { 'Content-Type': 'application/json' }, body: '{"address":"fresh@example.test","password":"fixture"}' };
        let send, requests = 0, reads = 0;
        const agent = makeAgent(Agent, async () => {
          requests++;
          assert.ok(requests <= 2, 'Unrelated counters cannot restart the API decision');
          send({}); send({});
          return requests === 1 ? call('create-mailbox', 'fetch_url', args)
            : allowed ? done() : call('blocked-api', 'done', { summary: 'API consent is required.', outcome: 'partial' });
        });
        agent.isApiMutationsAllowed = () => allowed;
        agent._enrichUserMessageWithCurrentPage = async (_tab, _messages, content) => {
          send = bind(agent, tab); return { role: 'user', content };
        };
        agent.executeTool = async (_tab, name, actual) => {
          if (name === 'get_accessibility_tree') {
            reads++; send({});
            return { success: true, pageContent: `heading "Inbox" [ref_inbox]\ntext "${reads} seconds ago"` };
          }
          if (name === 'done') return { success: true, done: true, summary: actual.summary, outcome: actual.outcome };
          assert.equal(name, 'fetch_url');
          assert.equal(allowed, true, 'The freshness exception must not authorize API mutations');
          sent.push(structuredClone(actual));
          return { success: true, status: 201, json: '{"id":"fixture-mailbox"}' };
        };
        await finish(agent, tab, streaming, updates, { detachedRequestId: 'api-fallback-' + tab, askStreamingEnabled: false });
        assert.equal(requests, 2);
        assert.deepEqual(sent, allowed ? [args] : []);
        if (!allowed) assert.ok(updates.some(update => update.type === 'warning' && /API mutation blocked/.test(update.data.message)));
      });
    }
    for (const condition of ['unsupported', 'targeted_recovery', 'target_drift', 'stale_document']) {
      test(build + ': ' + (streaming ? 'stream' : 'chat') + ' ' + condition + ' action-context diagnostics preserve no-dispatch and fresh-decision fences', async () => {
        const tab = nextTab++, updates = [], modelMessages = [], captures = [];
        const oldSend = api.tabs.sendMessage;
        let agent, send, requests = 0, validations = 0, dispatched = 0, terminalStatus;
        api.tabs.sendMessage = async (_id, message) => {
          if (message.action === 'page_monitor_capture_model') {
            captures.push(message.params);
            const verified = condition === 'targeted_recovery' && captures.length > 1;
            return { ready: true, runToken: message.params.runToken, documentToken: 'content-1',
              snapshotToken: 'owned-' + captures.length, targetCount: verified ? 1 : 0, focusedTargetAvailable: false,
              page: { success: true, url: PAGE_URL, pageContent: verified
                ? 'region "Owned action context" [ref_owner]\n button "Owned toolbar control" [ref_standalone]'
                : 'button "Owned toolbar control" [ref_standalone]' } };
          }
          if (message.action === 'page_monitor_validate_model') {
            validations++;
            const verified = condition === 'targeted_recovery' && captures.length > 1;
            return { ready: verified, ...(condition !== 'target_drift' && !verified ? { uncertified: true } : {}),
              runToken: message.params.runToken, documentToken: condition === 'stale_document' ? 'other-document' : 'content-1',
              snapshotToken: message.params.snapshotToken };
          }
          return { ready: true };
        };
        const next = async messages => {
          modelMessages.push(structuredClone(messages)); requests++;
          assert.ok(requests <= 5, 'Unverified context keeps the existing bounded recovery budget.');
          if (condition === 'targeted_recovery' && dispatched) return done();
          send({});
          return call('context-' + requests, 'click_ax', { ref_id: 'ref_standalone' });
        };
        agent = makeAgent(Agent, next); agent.maxSteps = Infinity;
        agent._grantSocialPublicationAuditRetry = () => assert.fail('Context recovery must not bypass publication checks.');
        agent._endTraceRun = async (_tab, _run, status) => { terminalStatus = status; };
        agent._enrichUserMessageWithCurrentPage = async (_tab, _messages, content) => { send = bind(agent, tab); return { role: 'user', content }; };
        agent.executeTool = async (_id, name, args) => {
          if (name === 'get_accessibility_tree') return { success: true, pageContent: 'button "Owned toolbar control" [ref_standalone]' };
          if (name === 'done') return { done: true, success: true, summary: args.summary, outcome: args.outcome };
          assert.equal(condition, 'targeted_recovery'); assert.ok(requests > 1, 'Never certify the rejected first decision.');
          assert.equal(name, 'click_ax'); dispatched++; return { success: true, dispatched: true, verified: true };
        };
        try {
          const result = await finish(agent, tab, streaming, updates, { detachedRequestId: 'context-' + tab, askStreamingEnabled: false });
          if (condition === 'targeted_recovery') {
            assert.equal(result, ANSWER); assert.equal(dispatched, 1); assert.equal(requests, 3);
            assert.deepEqual(captures[1].actionTarget, { tool: 'click_ax', ref_id: 'ref_standalone' });
            assert.ok(modelMessages[1].some(m => /ACTION CONTEXT UNVERIFIED/.test(JSON.stringify(m))));
          } else {
            assert.equal(requests, 5); assert.equal(validations, 5); assert.equal(dispatched, 0);
            if (condition === 'unsupported') {
              assert.match(result, /could not confirm which part of the page the control belongs to/);
              assert.doesNotMatch(result, /page kept changing/);
              assert.equal(terminalStatus, 'action_context_unverified');
              assert.ok(updates.some(u => u.type === 'warning' && /could not confirm/.test(u.data.message)));
              assert.ok(modelMessages[1].some(m => /ACTION CONTEXT UNVERIFIED/.test(JSON.stringify(m))));
            } else {
              assert.match(result, /page kept changing/);
              assert.equal(modelMessages.some(messages => messages.some(m => /ACTION CONTEXT UNVERIFIED/.test(JSON.stringify(m)))), false);
              assert.equal(captures.some(c => c.actionTarget), false);
            }
            const offer = updates.find(u => u.type === 'failure_recovery')?.data;
            assert.equal(offer?.stage, 'action_preparation');
            assert.equal(offer.code, condition === 'unsupported' ? 'action_context_unverified' : 'page_unstable');
            const retryMode = condition === 'unsupported' ? 'action_monitoring_relaxed' : 'resume';
            assert.equal(offer.retryMode, retryMode);
            assert.equal(offer.message, result);
            assert.match(result, /choose Retry/);
            assert.equal(agent._pendingFailureRecoveryForUi(tab).recoveryId, offer.recoveryId);
            assert.deepEqual(agent.requestFailureRecovery(tab, offer.recoveryId, streaming ? 'retry' : 'give_up', 'owned-recovery-' + tab),
              { ok: true, continue: streaming, retryMode });
            if (streaming && condition === 'unsupported') {
              assert.equal(agent._pendingFailureRecoveryForUi(tab).recoveryId, offer.recoveryId,
                'Keep recovery until its reserved continuation actually claims the run.');
              agent._failureRecovery.clear(tab);
            } else assert.equal(agent._pendingFailureRecoveryForUi(tab), null);
          }
          assert.equal(agent._pageFeedbackRuns.size, 0);
        } finally { api.tabs.sendMessage = oldSend; documents.delete(tab); }
      });
    }
    for (const variant of ['literal', 'original-natural', 'turkish-natural', 'german-natural']) for (const refreshFails of [false, true]) {
      test(build + ': ' + (streaming ? 'stream' : 'chat') + ' applied ' + variant + ' calculate-only steering executes exact math once under passive churn' + (refreshFails ? ' with unavailable page refresh' : ''), async () => {
        const tab = nextTab++, updates = [], expression = '12345678901234567890 * 7 + 0.125';
        const expected = '86419752308641975230.125';
        const summary = expected + (variant === 'original-natural' ? ' MIDRUN-CALCULATE-QA-20261008'
          : variant === 'turkish-natural' ? ' HESAP_2026_01' : variant === 'german-natural' ? ' RECHNUNG_2026_01' : '');
        let agent, send, requests = 0, calculations = 0, reads = 0, plannerCalls = 0;
        let entered, release;
        const planning = new Promise(resolve => { entered = resolve; });
        const hold = new Promise(resolve => { release = resolve; });
        const next = async messages => {
          assert.ok(++requests <= 6, 'Unrelated DOM activity must not repeatedly discard pure calculation.');
          send({});
          const calculated = messages.find(message => message.role === 'tool'
            && message.content.includes(expected));
          return calculated ? call('finished-compute', 'done', { summary, outcome: 'success' })
            : call(`exact-compute-${requests}`, 'calculate', { expression });
        };
        agent = makeAgent(Agent, next);
        agent.maxSteps = Infinity;
        agent._enrichUserMessageWithCurrentPage = async (_tab, _messages, content) => {
          send = bind(agent, tab); return { role: 'user', content };
        };
        agent._runPlannerIntentGate = async (_tab, enriched) => {
          if (++plannerCalls === 1) { entered(); await hold; }
          else assert.ok(enriched.content.includes(expression), 'The revised planner must receive the genuine calculation task.');
          return { proceed: true, requestKind: 'execute', requiresStateChange: false, requiresSubmission: false,
            ...agent._plannerCompletionGateFields({ read_scope: 'none', deliverables: ['Exact arithmetic result', 'Response formatting marker'] }) };
        };
        agent.executeTool = async (_tab, name, args) => {
          if (name === 'get_accessibility_tree') {
            reads++;
            return refreshFails ? { success: false, error: 'Owned page observation unavailable.' }
              : { success: true, pageContent: 'text "Unrelated changing sidebar"' };
          }
          if (name === 'done') return { done: true, success: true, summary: args.summary, outcome: args.outcome };
          assert.equal(name, 'calculate', 'The corrected task must not interact with any page control.');
          calculations++;
          return agent._executeToolImpl(_tab, name, args);
        };
        const options = { detachedRequestId: `calculate-only-${tab}`, askStreamingEnabled: false };
        const update = (type, data) => updates.push({ type, data });
        try {
          const run = streaming
            ? agent.processMessageStream(tab, 'Inspect the current owned page.', update, 'act', options)
            : agent.processMessage(tab, 'Inspect the current owned page.', update, 'act', [], options);
          await planning;
          const correction = variant === 'original-natural' ? ORIGINAL_CALC_CORRECTION
            : variant === 'turkish-natural' ? 'Sadece ' + expression + ' hesapla. Tam sonucu bildir ve marker "HESAP_2026_01" ile bitir.'
            : variant === 'german-natural' ? 'Berechne nur ' + expression + '. Gib das exakte Ergebnis zurück und beende mit marker "RECHNUNG_2026_01".'
            : 'Cancel page inspection. Only calculate ' + expression + '; do not interact with the page.';
          assert.equal(agent.steerMessage(tab, correction, {
            requestId: options.detachedRequestId, messageId: 'genuine-compute-correction',
          }).accepted, true);
          release();
          assert.equal(await run, summary);
          assert.equal(calculations, 1); assert.equal(requests, 2); assert.equal(plannerCalls, 2);
          assert.ok(reads > 0, 'The ordinary feedback read remains available; failed reads cannot invalidate literal math.');
          assert.equal(updates.filter(update => update.type === 'steering_applied').length, 1);
          assert.equal(updates.some(update => update.type === 'run_status' && update.data.status === 'page_unstable'), false);
          assert.equal(agent._pageFeedbackRuns.size, 0);
        } finally { release(); documents.delete(tab); }
      });
    }
    // webbrain-traces-1791395643317.json: completed detached research followed
    // by repeated valid Ask completions discarded because X counters changed.
    for (const response of ['done', 'prose', 'empty']) for (const refreshFails of [false, true]) {
      test(`${build}: ${streaming ? 'stream' : 'chat'} Ask ${response} reaches delivery under passive churn${refreshFails ? ' with failed AX refresh' : ''}`, async () => {
        const tab = nextTab++, updates = [], dispatched = [];
        const answer = 'Robot Ventures is an investment firm founded by Robert Leshner and Tarun Chitra.';
        let agent, send, requests = 0, reads = 0;
        const next = async () => {
          assert.ok(++requests <= (response === 'empty' ? 3 : 2), 'Passive counters cannot consume the answer or provider recovery budget');
          send({});
          if (requests === 1) return call('research-founders', 'research_url', { url: 'https://example.com/robot-ventures' });
          if (response === 'done') return call('researched-answer', 'done', { summary: answer });
          return { content: response === 'prose' ? answer : '' };
        };
        agent = makeAgent(Agent, next);
        agent.maxSteps = Infinity;
        agent._enrichUserMessageWithCurrentPage = async (_tab, _messages, content) => {
          send = bind(agent, tab);
          return { role: 'user', content };
        };
        agent.executeTool = async (_tab, name, args) => {
          if (name === 'get_accessibility_tree') {
            reads++; send({});
            return refreshFails ? { success: false, error: 'AX refresh unavailable' }
              : { success: true, pageContent: `article "Unrelated timeline" [ref_1]\n text "${reads} views"` };
          }
          dispatched.push(name);
          if (name === 'done') return { success: true, done: true, summary: args.summary };
          assert.equal(name, 'research_url');
          return { success: true, content: answer };
        };
        const options = { detachedRequestId: 'ask-feedback-run', askStreamingEnabled: true };
        const update = (type, data) => updates.push({ type, data });
        const result = streaming
          ? await agent.processMessageStream(tab, 'Who founded Robot Ventures?', update, 'ask', options)
          : await agent.processMessage(tab, 'Who founded Robot Ventures?', update, 'ask', [], options);
        if (response === 'empty') {
          assert.match(result, /empty|visible answer|visible text/i);
          assert.equal(requests, 3, 'The provider receives exactly one recovery turn after its first empty response');
        } else {
          assert.equal(result, answer);
          assert.equal(requests, 2);
        }
        assert.deepEqual(dispatched, response === 'done' ? ['research_url', 'done'] : ['research_url']);
        assert.ok(reads >= requests, 'Every pending passive batch is still observed');
        assert.equal(updates.some(update => update.type === 'warning' && /page kept changing/.test(update.data.message)), false);
        assert.equal(agent._pageFeedbackRuns.size, 0);
      });
    }
    // The person typing on the page while an Ask answer is written does not
    // make the answer stale: it is delivered once, not written again.
    for (const response of ['done', 'prose']) {
      test(`${build}: ${streaming ? 'stream' : 'chat'} Ask ${response} is kept after the person types on the page`, async () => {
        const tab = nextTab++, delivered = [];
        let agent, send, requests = 0;
        const next = async () => {
          assert.equal(++requests, 1, 'The answer is not written again');
          send({ kind: 'input', source: 'user' });
          return response === 'done' ? call('answer', 'done', { summary: 'The answer' }) : { content: 'The answer' };
        };
        agent = makeAgent(Agent, next);
        agent._enrichUserMessageWithCurrentPage = async (_tab, _messages, content) => {
          send = bind(agent, tab); return { role: 'user', content };
        };
        agent.executeTool = async (_tab, name, args) => {
          if (name === 'get_accessibility_tree') return { success: true, pageContent: 'article "Context" [ref_1]' };
          assert.equal(name, 'done');
          delivered.push(args.summary);
          return { success: true, done: true, summary: args.summary };
        };
        const options = { detachedRequestId: 'ask-kept-run', askStreamingEnabled: true };
        const result = streaming
          ? await agent.processMessageStream(tab, 'Read the current question', () => {}, 'ask', options)
          : await agent.processMessage(tab, 'Read the current question', () => {}, 'ask', [], options);
        assert.equal(result, 'The answer');
        assert.equal(requests, 1);
        assert.deepEqual(delivered, response === 'done' ? ['The answer'] : []);
        assert.equal(agent._pageFeedbackRuns.size, 0);
      });
    }
    for (const response of ['done', 'prose']) for (const change of ['unknown', 'navigation', 'style', 'frame', 'task_steering', 'document', 'mode_change']) {
      test(`${build}: ${streaming ? 'stream' : 'chat'} Ask ${response} is reconsidered after ${change}`, async () => {
        const tab = nextTab++, updates = [], delivered = [];
        let agent, send, requests = 0;
        const next = async () => {
          if (++requests === 1) {
            if (change === 'task_steering') {
              assert.equal(agent.steerMessage(tab, 'Use the corrected question', { requestId: 'ask-guard-run', messageId: 'ask-correction' }).accepted, true);
            } else if (change === 'navigation') {
              agent._queuePageFeedback(tab, { kind: 'navigation', source: 'user', frameId: 0, before: PAGE_URL, after: PAGE_URL });
            } else if (change === 'frame') {
              agent._queuePageFeedback(tab, { kind: 'dom', source: 'page', frameId: 1, target: 'span#views' });
            } else if (change === 'document') {
              documents.set(tab, 'new-document'); send({});
            } else if (change === 'mode_change') {
              agent._runModeOverrides.set(tab, 'act'); send({});
            } else send({ kind: change === 'human_input' ? 'input' : 'dom',
              source: change === 'human_input' ? 'user' : change === 'unknown' ? 'unknown' : 'page',
              ...(change === 'style' ? { target: 'style' } : {}) });
            return response === 'done' ? call('stale-answer', 'done', { summary: 'Old answer' }) : { content: 'Old answer' };
          }
          assert.equal(requests, 2);
          return { content: 'Fresh answer' };
        };
        agent = makeAgent(Agent, next);
        agent._enrichUserMessageWithCurrentPage = async (_tab, _messages, content) => {
          send = bind(agent, tab); return { role: 'user', content };
        };
        agent.executeTool = async (_tab, name, args) => {
          if (name === 'get_accessibility_tree') return { success: true, pageContent: 'article "Fresh context" [ref_1]' };
          delivered.push(args.summary); assert.fail(`Stale ${name} must not dispatch`);
        };
        const update = (type, data) => updates.push({ type, data });
        const options = { detachedRequestId: 'ask-guard-run', askStreamingEnabled: true };
        try {
          const result = streaming
            ? await agent.processMessageStream(tab, 'Read the current question', update, 'ask', options)
            : await agent.processMessage(tab, 'Read the current question', update, 'ask', [], options);
          assert.equal(result, 'Fresh answer');
          assert.equal(requests, 2);
          assert.deepEqual(delivered, []);
          assert.equal(agent._pageFeedbackRuns.size, 0);
        } finally { documents.delete(tab); }
      });
    }
    test(`${build}: ${streaming ? 'stream' : 'chat'} same-URL document replacement supersedes a read before the monitor registers`, async () => {
      const tab = nextTab++, updates = [], dispatched = [];
      let agent, requests = 0;
      const next = async () => {
        switch (++requests) {
          case 1:
            documents.set(tab, 'replacement-document');
            // The navigation observer and content registration may lag the
            // browser document. Fresh webNavigation identity must still fence it.
            agent._queuePageFeedback(tab, { kind: 'dom', source: 'page', frameId: 0, target: 'span#views' });
            return call('stale-read', 'extract_data', { type: 'headings' });
          case 2: return call('fresh-read', 'extract_data', { type: 'images' });
          case 3: return done();
          default: assert.fail('A refreshed document read should finish');
        }
      };
      agent = makeAgent(Agent, next);
      agent._enrichUserMessageWithCurrentPage = async (_tab, _messages, content) => ({ role: 'user', content });
      agent.executeTool = async (_tab, name, args) => {
        if (name === 'get_accessibility_tree') return { success: true, pageContent: 'article "Replacement document photo" [ref_1]' };
        if (name === 'done') return { done: true, success: true, summary: args.summary, outcome: args.outcome };
        assert.equal(name, 'extract_data');
        dispatched.push(args);
        return { success: true, images: [{ src: 'https://images.example/current-photo.jpg' }] };
      };
      try {
        assert.equal(await finish(agent, tab, streaming, updates, { detachedRequestId: 'progress-run', askStreamingEnabled: false }), ANSWER);
        assert.deepEqual(dispatched, [{ type: 'images' }]);
        assert.equal(requests, 3);
      } finally { documents.delete(tab); }
    });

    for (const phase of ['model', 'preflight']) for (const target of ['coordinates', 'label']) {
      test(`${build}: ${streaming ? 'stream' : 'chat'} repeated ${target} rejected by ${phase} churn stops without dispatch`, async () => {
        const tab = nextTab++, updates = [], snapshots = [];
        let agent, send, requests = 0, dispatched = 0;
        const args = target === 'coordinates' ? { x: 100, y: 100, coordinate_space: 'css' } : { text: 'Continue' };
        const next = async messages => {
          snapshots.push(structuredClone(messages));
          assert.ok(++requests <= 6, 'Unlimited-step runs must have a bounded feedback recovery');
          if (phase === 'model') send({});
          return call(`unsafe-click-${requests}`, 'click', args);
        };
        agent = makeAgent(Agent, next);
        agent.maxSteps = Infinity;
        agent._enrichUserMessageWithCurrentPage = async (_tab, _messages, content) => {
          send = bind(agent, tab);
          return { role: 'user', content };
        };
        agent._preflightRichTextToolbarTarget = async (_tab, name) => {
          if (phase === 'preflight' && name === 'click') send({});
          return { block: null };
        };
        agent.executeTool = async (_tab, name) => {
          if (name === 'get_accessibility_tree') return { success: true, pageContent: `button "Continue" [ref_1]\n text "${requests} views"` };
          dispatched++;
          assert.fail(`Unsafe ${name} must not reach dispatch`);
        };
        const result = await finish(agent, tab, streaming, updates, { detachedRequestId: 'progress-run', askStreamingEnabled: false });
        assert.match(result, /Stopped because the page kept changing/);
        assert.match(result, /task is incomplete/i);
        assert.equal(requests, 5);
        assert.equal(dispatched, 0);
        assert.ok(snapshots.some(messages => /PAGE KEEPS CHANGING/.test(JSON.stringify(messages))), 'The model must receive the safer-action nudge');
        for (const messages of snapshots) {
          assert.ok(messages.filter(message => message.webbrainAppOwnedKind === 'page_feedback').length <= 1,
            'Counter churn must replace old observations instead of growing model context');
        }
        assert.ok(updates.some(update => update.type === 'warning' && /Stopped because the page kept changing/.test(update.data.message)));
      });
    }

    for (const phase of ['model', 'feedback_read', 'preflight', 'text_fallback']) {
      test(`${build}: ${streaming ? 'stream' : 'chat'} fresh extraction progresses through passive ${phase} churn`, async () => {
        const tab = nextTab++, updates = [], dispatched = [];
        let agent, send, requests = 0, reads = 0;
        const next = async () => {
          requests++;
          assert.ok(requests <= 2, 'Passive counters must not cause another model decision');
          // Keep changing the page on every inference, including completion.
          for (let index = 0; index < 3; index++) send({});
          if (requests === 2) return done();
          return phase === 'text_fallback'
            ? { content: JSON.stringify({ name: 'extract_data', arguments: { type: 'images' } }) }
            : call('extract-current', 'extract_data', { type: 'images' });
        };
        agent = makeAgent(Agent, next);
        agent._enrichUserMessageWithCurrentPage = async (_tab, _messages, content) => {
          send = bind(agent, tab);
          return { role: 'user', content };
        };
        agent._preflightRichTextToolbarTarget = async (_tab, name) => {
          if (phase === 'preflight' && name === 'extract_data') send({});
          return { block: null };
        };
        agent.executeTool = async (_tab, name, args) => {
          if (name === 'get_accessibility_tree') {
            reads++;
            if (phase === 'feedback_read') send({});
            return { success: true, pageContent: `article "Current photo" [ref_1]\n image "Photo" [ref_2]\n text "${reads} views"` };
          }
          if (name === 'done') return { done: true, success: true, summary: args.summary, outcome: args.outcome };
          assert.equal(name, 'extract_data');
          dispatched.push({ name, args });
          return { success: true, images: [{ src: 'https://images.example/current-photo.jpg' }] };
        };
        const result = await finish(agent, tab, streaming, updates, { detachedRequestId: 'progress-run', askStreamingEnabled: false });
        assert.equal(result, ANSWER, JSON.stringify(updates.filter(update => ['tool_result', 'warning'].includes(update.type))));
        assert.deepEqual(dispatched, [{ name: 'extract_data', args: { type: 'images' } }]);
        assert.equal(requests, 2);
        assert.ok(reads > 0, 'Feedback must still refresh the observation');
        assert.equal(agent._pageFeedbackRuns.size, 0);
      });
    }

    for (const phase of ['model', 'preflight']) for (const change of ['human_input', 'unknown', 'navigation', 'task_steering']) {
      // Unknown-attribution DOM is automatic churn, not an intervention: the
      // proposed read still reads the current page and needs no new decision.
      const retained = change === 'unknown';
      test(`${build}: ${streaming ? 'stream' : 'chat'} fresh reads ${retained ? 'proceed through' : 'still supersede after'} ${change} during ${phase}`, async () => {
        const tab = nextTab++, updates = [], dispatched = [];
        let agent, send, requests = 0;
        const intervene = () => {
          if (change === 'task_steering') {
            assert.equal(agent.steerMessage(tab, 'Extract the updated photo instead', {
              requestId: 'progress-run', messageId: 'correction-1',
            }).accepted, true);
          } else if (change === 'navigation') {
            agent._queuePageFeedback(tab, { kind: 'navigation', source: 'user', frameId: 0, before: PAGE_URL, after: PAGE_URL });
          } else send({ kind: change === 'human_input' ? 'input' : 'dom', source: change === 'human_input' ? 'user' : 'unknown' });
        };
        const next = async () => {
          switch (++requests) {
            case 1:
              if (phase === 'model') intervene();
              return call('stale-read', 'extract_data', { type: 'headings' });
            case 2: return call('fresh-read', 'extract_data', { type: 'images' });
            case 3: return done();
            default: assert.fail('The updated read should finish without more model requests');
          }
        };
        agent = makeAgent(Agent, next);
        agent._enrichUserMessageWithCurrentPage = async (_tab, _messages, content) => {
          send = bind(agent, tab);
          return { role: 'user', content };
        };
        agent._preflightRichTextToolbarTarget = async (_tab, name, args) => {
          if (phase === 'preflight' && name === 'extract_data' && args.type === 'headings') intervene();
          return { block: null };
        };
        agent.executeTool = async (_tab, name, args) => {
          if (name === 'get_accessibility_tree') return { success: true, pageContent: 'article "Updated photo" [ref_1]' };
          if (name === 'done') return { done: true, success: true, summary: args.summary, outcome: args.outcome };
          assert.equal(name, 'extract_data');
          dispatched.push(args);
          return { success: true, images: [{ src: 'https://images.example/current-photo.jpg' }] };
        };
        const result = await finish(agent, tab, streaming, updates, { detachedRequestId: 'progress-run', askStreamingEnabled: false });
        assert.equal(result, ANSWER, JSON.stringify(updates.filter(update => ['tool_result', 'warning'].includes(update.type))));
        assert.deepEqual(dispatched, retained ? [{ type: 'headings' }, { type: 'images' }] : [{ type: 'images' }]);
        assert.equal(requests, 3);
        assert.equal(agent._pageFeedbackRuns.size, 0);
      });
    }
  }

  test(`${build}: repeated browser refreshes replace obsolete trees and captures while preserving trusted history`, async () => {
    const tab = nextTab++, agent = makeAgent(Agent, async () => assert.fail('Observation compaction does not need inference'));
    await agent._claimRunEntry(tab, 'interactive');
    const messages = [{ role: 'system', content: 'System' }, { role: 'user', content: 'Extract the current photo' },
      { role: 'assistant', content: 'I found the photo.' }];
    agent.conversations.set(tab, messages);
    agent._beginSteeringRun(tab, () => {}, { detachedRequestId: 'progress-run' });
    let revision = 0;
    agent.executeTool = async (_tab, name) => {
      assert.equal(name, 'get_accessibility_tree');
      return { success: true, pageContent: `article "Photo" [ref_1]\n text "${revision} views"` };
    };
    agent._shouldAutoScreenshot = () => true;
    agent._resolveVisionRoute = async () => ({ provider: { supportsVision: true }, rawImage: true });
    agent._captureBudgetedAutoScreenshot = async () => ({
      captureId: `capture-${revision}`, width: 1, height: 1, cssWidth: 1, cssHeight: 1,
      dataUrl: `data:image/png;base64,revision${revision}`,
    });
    try {
      const send = bind(agent, tab);
      await agent._capturePageFeedbackModelState(tab);
      for (revision = 1; revision <= 8; revision++) {
        send({});
        await agent._applyPendingPageFeedback(tab, messages);
        assert.equal(messages.filter(message => message.webbrainAppOwnedKind === 'page_feedback').length, 1);
        assert.equal(messages.filter(message => message.webbrainAppOwnedKind === 'page_feedback_capture').length, 1);
        assert.equal(messages[1].content, 'Extract the current photo');
        assert.equal(messages[2].content, 'I found the photo.');
      }
      assert.match(JSON.stringify(messages), /capture-8/);
      assert.doesNotMatch(JSON.stringify(messages), /capture-[1-7]/);
      assert.equal(agent._activeTaskBinding(messages).text, 'Extract the current photo');
    } finally { agent._finishSteeringRun(tab); agent._releaseRunEntry(tab); }
  });
}

{
  // Download stage from webbrain-traces-1791372051482.json: X photo overlay,
  // unrelated live counters, and an optional pre-inference image binding missing.
  const PAGE_URL = 'https://x.com/mahallejargonu/status/2107603050810712208/photo/1';
  const IMAGE_URL = 'https://pbs.twimg.com/media/example-photo.jpg';
  const area = { get: async () => ({}), set: async () => {}, remove: async () => {} };
  let blindDownloadAttempts = 0;
  const api = {
    storage: { local: area, session: area },
    runtime: { getURL: value => `extension://test/${value}`, sendMessage: async () => ({}) },
    tabs: { get: async id => ({ id, url: PAGE_URL, title: 'Home / X' }), sendMessage: async () => ({ ready: true }) },
    webNavigation: { getAllFrames: async () => [{ frameId: 0, parentFrameId: -1, documentId: 'photo-document', url: PAGE_URL }] },
    scripting: { executeScript: async options => {
      if (options.files) return [];
      if (/SocialMediaDownloader\.run\(/.test(String(options.func))) blindDownloadAttempts++;
      // Both optional prebinding and readonly candidate resolution fail here.
      // Extraction remains available, as in CSS/media carriers not represented
      // by the downloader's initial candidate selector.
      return [{ result: { bindings: { auto: null, image: null, video: null },
        diagnostics: { image: { status: 'unavailable', reason: 'no_matching_media' } }, status: 'unavailable' } }];
    } },
  };
  let nextTab = 4100;
  const call = (id, name, args) => ({ toolCalls: [{ id, function: { name, arguments: JSON.stringify(args) } }] });

  function setup(Agent, next) {
    const provider = {
      name: 'missing media regression', model: 'test', promptTier: 'full', contextWindow: 128000,
      supportsTools: true, supportsVision: false, chat: withFixtureCalculationReadings(next),
      async *chatStream(messages) {
        const response = await next(messages);
        if (response.content) yield { type: 'text', content: response.content };
        if (response.toolCalls) yield { type: 'tool_call', content: response.toolCalls.map((tool, index) => ({ ...tool, index })) };
        yield { type: 'done' };
      },
    };
    const agent = new Agent({ getActive: () => provider, getProvider: () => provider, getVisionProvider: async () => null });
    for (const method of ['_hydrate', '_persistSubmittedTurn', '_endTraceRun', '_manageContext', '_maybeReinjectAdapter',
      '_maybeEmitAskModeHandoff', '_ensureProgressSessionForCurrentTask']) agent[method] = async () => {};
    agent._persist = () => {};
    agent._persistNow = async () => ({ ok: true });
    agent._startTraceRun = async () => null;
    agent._beginReadCompleteness = async () => null;
    agent._checkCostAllowance = async () => null;
    agent._recordCostUsage = async () => null;
    agent._currentUrl = async () => PAGE_URL;
    agent._getTabUrlTitle = async () => ({ tabUrl: PAGE_URL, tabTitle: 'Home / X' });
    agent._plannerMode = () => 'off';
    agent._runPlannerIntentGate = async () => ({
      proceed: true, requestKind: 'execute', requiresStateChange: false, requiresSubmission: false,
      completionRequirements: { download: true },
    });
    agent._skipPermissionGate = true;
    agent._ensureGateSetting = async () => true;
    for (const name of ['_chromeProtectedPageFailure', '_captchaMutationPreflight', '_workflowPreSubmitDispatchBlock',
      '_messageRecipientGuardBlock', '_detectLikelySubmitAction', '_socialPublicationPreSubmitBlock']) agent[name] = async () => null;
    agent._downloadSocialMediaFallbackDecision = async () => null;
    agent._adoptLiveSocialPublishWorkflow = async () => false;
    agent._isFormValidationCandidate = () => false;
    agent._preflightRichTextToolbarTarget = async () => ({ block: null });
    agent._auditRichTextToolbarTarget = async () => {};
    agent._shouldAutoScreenshot = () => false;
    agent._pageFeedbackIdleMs = 0;
    agent._completionDoneBlock = () => null;
    agent.maxSteps = Infinity;
    return agent;
  }

  for (const build of ['chrome', 'firefox']) {
    const { Agent } = await import(`../src/${build}/src/agent/agent.js`);
    for (const streaming of [false, true]) for (const mode of [undefined, 'main']) {
      test(`${build}: ${streaming ? 'stream' : 'chat'} missing ${mode || 'auto'} photo prebinding gives one readonly diagnostic and permits fresh extraction`, async () => {
        const previousChrome = globalThis.chrome, previousBrowser = globalThis.browser;
        globalThis.chrome = api; globalThis.browser = api;
        try {
          const tab = nextTab++, updates = [], dispatched = [];
          let agent, requests = 0, sequence = 0, photoReads = 0;
          const final = 'Downloaded the photo as photo.jpg (download ID: saved-photo).';
          const counterUpdate = () => {
            const from = { tab: { id: tab }, frameId: 0, documentId: 'photo-document', url: PAGE_URL };
            const state = agent.pageMonitorState(from, 'photo-content');
            assert.equal(state.active, true);
            assert.equal(agent.observePageFeedback(from, { ...state, seq: ++sequence, revision: sequence,
              kind: 'dom', source: 'page', target: 'button [button]' }).accepted, true);
          };
          const next = async messages => {
            assert.ok(++requests <= 4, 'The missing optional binding must produce actionable tool feedback, not repeated model retries');
            counterUpdate();
            switch (requests) {
              case 1: return call('resolve-photo', 'download_social_media', { target: 'image', ...(mode ? { mode } : {}) });
              case 2: {
                const results = messages.filter(message => message.role === 'tool');
                assert.equal(results.length, 1);
                assert.match(results[0].content, /media_binding_unavailable/);
                assert.match(results[0].content, /"noDispatch":true/);
                assert.doesNotMatch(results[0].content, /"pageFeedbackPending":true/);
                return call('extract-photo', 'extract_data', { type: 'images' });
              }
              case 3:
                assert.ok(messages.some(message => message.role === 'tool' && message.content.includes(IMAGE_URL)));
                return call('download-exact-photo', 'download_files', { urls: [IMAGE_URL] });
              case 4: return call('finished', 'done', { summary: final, outcome: 'success' });
            }
          };
          agent = setup(Agent, next);
          agent._enrichUserMessageWithCurrentPage = async (_tab, _messages, content) => {
            // Bind the content document before the production inference snapshot.
            agent.pageMonitorState({ tab: { id: tab }, frameId: 0, documentId: 'photo-document', url: PAGE_URL }, 'photo-content');
            return { role: 'user', content };
          };
          const executeProductionTool = Agent.prototype.executeTool.bind(agent);
          agent.executeTool = async (_tab, name, args, onUpdate, context) => {
            if (name === 'get_accessibility_tree') {
              photoReads++;
              return { success: true, pageContent: `dialog [ref_1]\n button "${2556 + photoReads} Likes. Like" [ref_2] type="button"\n image "Photo" [ref_3]` };
            }
            if (name === 'download_social_media') {
              dispatched.push({ name, args });
              return executeProductionTool(_tab, name, args, onUpdate, context);
            }
            if (name === 'extract_data') {
              dispatched.push({ name, args });
              return { success: true, images: [{ src: IMAGE_URL }] };
            }
            if (name === 'download_files') {
              dispatched.push({ name, args });
              return { success: true, count: 1, completedCount: 1, downloads: [{ id: 'saved-photo', filename: 'photo.jpg', state: 'complete' }] };
            }
            assert.equal(name, 'done');
            return { done: true, success: true, summary: args.summary, outcome: args.outcome };
          };
          const blindBefore = blindDownloadAttempts;
          const options = { detachedRequestId: 'missing-media-run', askStreamingEnabled: false };
          const update = (type, data) => updates.push({ type, data });
          const result = streaming
            ? await agent.processMessageStream(tab, 'Download the currently open X photo', update, 'act', options)
            : await agent.processMessage(tab, 'Download the currently open X photo', update, 'act', [], options);
          assert.equal(result, final, JSON.stringify(updates.filter(entry => entry.type === 'tool_result')));
          assert.equal(requests, 4);
          assert.deepEqual(dispatched.map(entry => entry.name), ['download_social_media', 'extract_data', 'download_files']);
          assert.equal(blindDownloadAttempts, blindBefore, 'Missing binding resolution must never invoke the downloader');
          assert.ok(photoReads > 0);
          assert.equal(agent._pageFeedbackRuns.size, 0);
          assert.equal(updates.some(entry => entry.type === 'run_status' && entry.data.status === 'page_unstable'), false);
        } finally {
          globalThis.chrome = previousChrome; globalThis.browser = previousBrowser;
        }
      });
    }
  }
}

{
  // Generic editor: no social-site adapter or media precapture is available.
  // The content endpoint keeps identity/form data private while unrelated text
  // changes remain visible to the real chat/stream feedback state machine.
  const GENERIC_URL = 'https://ordinary-editor.test/draft/7';
  const DOCUMENT_ID = 'generic-editor-document';
  const DOCUMENT_TOKEN = 'generic-editor-content';
  let genericTab = 5200;

  function genericFixture(phase, preparationChange = null) {
    const live = { recipient: 'Alice', formTarget: '/save/7', node: 'save-node-1', focus: 'draft-field-node', value: 'Saved draft',
      formCounter: 100, regionCounter: 200, headingCounter: 20 };
    const snapshots = new Map(), prepared = new Map(), messages = [], dispatched = [], feedbackAccepted = [];
    let agent, tab, seq = 0, snapshotSequence = 0;
    const identity = () => JSON.stringify([live.recipient, live.formTarget, live.node, live.focus, live.value]);
    const sender = () => ({ tab: { id: tab }, frameId: 0, documentId: DOCUMENT_ID, url: GENERIC_URL });
    const emit = (event = {}) => {
      const state = agent.pageMonitorState(sender(), DOCUMENT_TOKEN);
      assert.equal(state.active, true);
      const accepted = agent.observePageFeedback(sender(), { ...state, seq: ++seq, revision: seq,
        kind: 'dom', source: 'page', target: 'span#form-counter', ...event }).accepted;
      feedbackAccepted.push(accepted);
      assert.equal(accepted, true);
    };
    const churn = () => {
      live.formCounter++; live.regionCounter++; live.headingCounter++;
      for (const target of ['span#form-counter', 'span#region-counter', 'h2#sidebar-heading']) emit({ target });
    };
    const revoke = change => {
      if (change === 'recipient') live.recipient = 'Bob';
      if (change === 'form destination') live.formTarget = '/save/other';
      if (change === 'target node') live.node = 'replacement-save-node';
      if (change === 'field value') live.value = 'Someone else changed the draft';
      if (change === 'focus') live.focus = 'different-field-node';
      if (change === 'human') emit({ kind: 'click', source: 'user', interacting: false, target: 'button#human' });
      else emit({ target: change === 'recipient' ? 'h2#recipient' : change === 'form destination' ? 'form#draft' : 'button#save' });
    };
    const page = () => ({ success: true, pageContent:
      `region "Draft editor" [ref_editor]\n heading "${live.recipient}" [ref_recipient]\n`
      + ` form "Draft" [ref_form] action="${live.formTarget}"\n`
      + `  textbox "Draft text" [ref_body] value="${live.value}"\n`
      + '  button "Save" [ref_save] type="submit"\n'
      + `  text "${live.formCounter} views" [ref_form_counter]\n`
      + ` text "${live.regionCounter} updates" [ref_region_counter]\n`
      + `region "Unrelated sidebar" [ref_sidebar]\n heading "Trending ${live.headingCounter}" [ref_sidebar_heading]` });
    const api = {
      storage: { local: area, session: area },
      runtime: { getURL: value => `extension://test/${value}`, sendMessage: async () => ({}) },
      tabs: {
        get: async id => ({ id, url: GENERIC_URL, title: 'Ordinary draft editor' }),
        async sendMessage(_tab, message) {
          messages.push(message);
          const params = message.params || {};
          if (message.action === 'page_monitor_state') {
            return { ready: true, ...agent.pageMonitorState(sender(), DOCUMENT_TOKEN) };
          }
          if (message.action === 'page_monitor_capture_model') {
            if (params.actionTarget) live.coverageMissing = false;
            const snapshotToken = `generic-snapshot-${++snapshotSequence}`;
            snapshots.set(snapshotToken, { runToken: params.runToken, identity: identity() });
            return { ready: true, runToken: params.runToken, documentToken: DOCUMENT_TOKEN,
              snapshotToken, targetCount: 2, focusedTargetAvailable: true, page: { ...page(), url: GENERIC_URL } };
          }
          if (message.action === 'page_monitor_validate_model') {
            const snapshot = snapshots.get(params.snapshotToken);
            const resolved = (params.tool === 'click_ax' && params.ref_id === 'ref_save')
              || (params.tool === 'click' && params.selector === (live.selector || '#save'))
              || (['type_text', 'press_keys'].includes(params.tool) && !params.ref_id && !params.selector && !!live.focus);
            return { ready: !live.coverageMissing && !!snapshot && resolved && snapshot.runToken === params.runToken && snapshot.identity === identity(),
              ...(live.coverageMissing ? { reason: live.coverageReason || 'target_uncovered' } : {}),
              runToken: params.runToken, documentToken: DOCUMENT_TOKEN, snapshotToken: params.snapshotToken };
          }
          if (message.action === 'page_monitor_prepare') {
            const preparedIdentity = identity();
            if (phase === 'preparation') preparationChange ? revoke(preparationChange) : churn();
            const snapshot = snapshots.get(params.expectedModelSnapshot);
            const modelBindingValid = !!snapshot && snapshot.runToken === params.runToken && snapshot.identity === identity();
            prepared.set(params.operationId, { identity: preparedIdentity,
              approved: params.allowPassiveRebase === true && modelBindingValid });
            return { ready: modelBindingValid, modelBindingValid };
          }
          if (message.action === 'page_monitor_dispatch') {
            const operation = prepared.get(params.operationId);
            const ready = !!operation && operation.identity === identity() && operation.approved;
            return { ready, ...(!ready ? { pageFeedbackPending: true } : {}) };
          }
          return { ready: true };
        },
      },
      webNavigation: { getAllFrames: async () => [{ frameId: 0, parentFrameId: -1, documentId: DOCUMENT_ID, url: GENERIC_URL }] },
      scripting: { executeScript: async () => [{ result: null }] },
    };
    return { api, live, snapshots, messages, dispatched, feedbackAccepted, churn, emit, revoke, page,
      attach(value, id) { agent = value; tab = id; },
      initialize() {
        agent.pageMonitorState(sender(), DOCUMENT_TOKEN);
        agent._pageFeedbackRuns.get(tab).latestPage = page();
      },
    };
  }

  for (const build of ['chrome', 'firefox']) {
    const { Agent } = await import(`../src/${build}/src/agent/agent.js`);
    const { installPageFeedback, beforePageAgentDispatch } = await import(`../src/${build}/src/agent/page-feedback.js`);
    class GenericProgressAgent extends Agent {
      async executeTool(...args) { return this.genericExecute(...args); }
    }
    installPageFeedback(GenericProgressAgent);

    const actionFor = target => ({
      'native submit': { name: 'click_ax', args: { ref_id: 'ref_save' } },
      'unique selector': { name: 'click', args: { selector: '#save' } },
      'focused typing': { name: 'type_text', args: { text: 'Updated draft', clear: true } },
      'focused key': { name: 'press_keys', args: { key: 'Enter' } },
    })[target];
    const genericFinish = (agent, tab, streaming, updates) => {
      const update = (type, data) => updates.push({ type, data });
      const options = { detachedRequestId: 'generic-feedback-run', askStreamingEnabled: false };
      return streaming ? agent.processMessageStream(tab, 'Save the current draft for Alice', update, 'act', options)
        : agent.processMessage(tab, 'Save the current draft for Alice', update, 'act', [], options);
    };
    const configure = (agent, fixture, tab) => {
      fixture.attach(agent, tab);
      agent._currentUrl = async () => GENERIC_URL;
      agent._pageFeedbackIdleMs = 1;
      agent._getTabUrlTitle = async () => ({ tabUrl: GENERIC_URL, tabTitle: 'Ordinary draft editor' });
      agent._enrichUserMessageWithCurrentPage = async (_tab, _messages, content) => {
        fixture.initialize();
        return { role: 'user', content };
      };
      agent.genericExecute = async (_tab, name, args, _onUpdate, context) => {
        if (name === 'get_accessibility_tree') {
          const current = fixture.page();
          if (phaseForAgent.get(agent) === 'refresh') fixture.churn();
          return current;
        }
        if (name === 'done') return { done: true, success: true, summary: args.summary, outcome: args.outcome };
        if (name === 'extract_data') return { success: true, headings: [fixture.live.recipient] };
        if (name === 'download_files') {
          fixture.dispatched.push({ name, args: structuredClone(args) });
          return { success: true, downloads: [{ success: true, url: args.url,
            downloadId: 711, state: 'complete', filename: args.filename }] };
        }
        assert.ok(['click', 'click_ax', 'type_text', 'press_keys'].includes(name));
        await beforePageAgentDispatch(fixture.api, _tab, { kind: ['type_text', 'press_keys'].includes(name) ? 'input' : 'click', navigationCandidate: false });
        context._contentActionDispatchState.started = true;
        fixture.dispatched.push({ name, args: structuredClone(args), recipient: fixture.live.recipient });
        return { success: true, dispatched: true };
      };
    };
    const phaseForAgent = new WeakMap();

    for (const streaming of [false, true]) {
      test(`${build}: ${streaming ? 'stream' : 'chat'} private target proof preserves long selectors exactly`, async () => {
        const previousChrome = globalThis.chrome, previousBrowser = globalThis.browser;
        const fixture = genericFixture('model'), tab = genericTab++, updates = [];
        globalThis.chrome = fixture.api; globalThis.browser = fixture.api;
        try {
          const selector = `#save\n:not([data-unused="${'x'.repeat(550)}"])`;
          fixture.live.selector = selector;
          const final = 'Saved the current draft.';
          let requests = 0;
          const agent = makeAgent(GenericProgressAgent, async () => {
            assert.ok(++requests <= 2);
            fixture.churn();
            return requests === 1 ? call('exact-long-selector', 'click', { selector })
              : call('saved', 'done', { summary: final, outcome: 'success' });
          });
          configure(agent, fixture, tab);
          assert.equal(await genericFinish(agent, tab, streaming, updates), final);
          assert.deepEqual(fixture.dispatched, [{ name: 'click', args: { selector }, recipient: 'Alice' }]);
          for (const action of ['page_monitor_validate_model', 'page_monitor_prepare']) {
            const messages = fixture.messages.filter(message => message.action === action && message.params.selector);
            assert.ok(messages.length);
            assert.ok(messages.every(message => message.params.selector === selector), 'Proof must refer to the original target string');
          }
        } finally { globalThis.chrome = previousChrome; globalThis.browser = previousBrowser; }
      });

      for (const reason of ['target_uncovered', 'target_unresolved']) test(`${build}: ${streaming ? 'stream' : 'chat'} ${reason} waits for a fresh priority observation without a page-change loop`, async () => {
        const previousChrome = globalThis.chrome, previousBrowser = globalThis.browser;
        const fixture = genericFixture('model'), tab = genericTab++, updates = [];
        fixture.live.coverageMissing = true;
        fixture.live.coverageReason = reason;
        globalThis.chrome = fixture.api; globalThis.browser = fixture.api;
        try {
          const args = { selector: '#save' }, final = 'Inspected and saved the freshly observed draft.';
          let requests = 0;
          const agent = makeAgent(GenericProgressAgent, async messages => {
            assert.ok(++requests <= 3);
            if (requests === 1) return call('unobserved-target', 'click', args);
            if (requests === 2) {
              assert.equal(fixture.dispatched.length, 0);
              const result = messages.find(message => message.role === 'tool');
              assert.match(result.content, /action_binding_unavailable/);
              assert.doesNotMatch(result.content, /pageFeedbackPending/);
              assert.ok(fixture.messages.some(message => message.action === 'page_monitor_capture_model'
                && message.params.actionTarget?.selector === args.selector));
              return call('freshly-observed-target', 'click', args);
            }
            return call('saved', 'done', { summary: final, outcome: 'success' });
          });
          configure(agent, fixture, tab);
          assert.equal(await genericFinish(agent, tab, streaming, updates), final);
          assert.equal(requests, 3);
          assert.deepEqual(fixture.dispatched, [{ name: 'click', args, recipient: 'Alice' }]);
          assert.equal(updates.some(update => update.type === 'run_status' && update.data.status === 'page_unstable'), false);
          assert.equal(fixture.messages.filter(message => message.action === 'page_monitor_capture_model'
            && message.params.actionTarget).length, 1, 'Priority capture is consumed after a fresh observation');
        } finally { globalThis.chrome = previousChrome; globalThis.browser = previousBrowser; }
      });
    }

    for (const streaming of [false, true]) {
      const resourceUrl = 'https://assets.ordinary-editor.test/images/draft-photo.jpg';
      for (const phase of ['model', 'refresh', 'preflight']) {
        test(`${build}: ${streaming ? 'stream' : 'chat'} singular-url download progresses through passive ${phase} churn`, async () => {
          const previousChrome = globalThis.chrome, previousBrowser = globalThis.browser;
          const fixture = genericFixture(phase), tab = genericTab++, updates = [];
          globalThis.chrome = fixture.api; globalThis.browser = fixture.api;
          try {
            const args = { url: resourceUrl, filename: 'draft-photo.jpg' };
            const final = 'Downloaded draft-photo.jpg (download ID: 711).';
            let requests = 0;
            const agent = makeAgent(GenericProgressAgent, async () => {
              assert.ok(++requests <= 2, 'A concrete download URL must not be discarded because the page changed');
              fixture.churn();
              return requests === 1 ? call('download-exact-resource', 'download_files', args)
                : call('downloaded', 'done', { summary: final, outcome: 'success' });
            });
            configure(agent, fixture, tab);
            phaseForAgent.set(agent, phase);
            agent._preflightRichTextToolbarTarget = async (_tab, name) => {
              if (phase === 'preflight' && name === 'download_files') fixture.churn();
              return { block: null };
            };
            assert.equal(await genericFinish(agent, tab, streaming, updates), final,
              JSON.stringify(updates.filter(update => ['tool_result', 'warning'].includes(update.type))));
            assert.equal(requests, 2);
            assert.deepEqual(fixture.dispatched, [{ name: 'download_files', args }], 'The handler executes exactly once');
            assert.ok(fixture.feedbackAccepted.length > 0 && fixture.feedbackAccepted.every(Boolean));
            assert.ok(updates.some(update => update.type === 'page_feedback'));
            assert.equal(updates.some(update => update.type === 'run_status' && update.data.status === 'page_unstable'), false);
          } finally { globalThis.chrome = previousChrome; globalThis.browser = previousBrowser; }
        });
      }
      test(`${build}: ${streaming ? 'stream' : 'chat'} a valid singular URL cannot override a mixed invalid download array`, async () => {
        const previousChrome = globalThis.chrome, previousBrowser = globalThis.browser;
        const fixture = genericFixture('model'), tab = genericTab++, updates = [];
        globalThis.chrome = fixture.api; globalThis.browser = fixture.api;
        try {
          const final = 'Inspected the current page after rejecting the invalid download list.';
          let requests = 0;
          const agent = makeAgent(GenericProgressAgent, async () => {
            assert.ok(++requests <= 3);
            if (requests === 1) {
              fixture.churn();
              return call('invalid-download-list', 'download_files', {
                url: resourceUrl, urls: [resourceUrl, 'javascript:alert(1)'], filename: 'draft-photo.jpg',
              });
            }
            if (requests === 2) return call('inspect-current-page', 'extract_data', { type: 'headings' });
            return call('inspected', 'done', { summary: final, outcome: 'success' });
          });
          configure(agent, fixture, tab);
          assert.equal(await genericFinish(agent, tab, streaming, updates), final);
          assert.equal(requests, 3);
          assert.deepEqual(fixture.dispatched, [], 'The nonempty invalid array must retain precedence over url');
          assert.ok(fixture.feedbackAccepted.length > 0 && fixture.feedbackAccepted.every(Boolean));
        } finally { globalThis.chrome = previousChrome; globalThis.browser = previousBrowser; }
      });
    }

    for (const streaming of [false, true]) for (const target of ['native submit', 'unique selector', 'focused typing', 'focused key']) {
      for (const phase of ['model', 'refresh', 'preparation']) {
        test(`${build}: ${streaming ? 'stream' : 'chat'} generic ${target} progresses through ${phase} churn in its form, region and unrelated heading`, async () => {
          const previousChrome = globalThis.chrome, previousBrowser = globalThis.browser;
          const fixture = genericFixture(phase), tab = genericTab++, updates = [];
          globalThis.chrome = fixture.api; globalThis.browser = fixture.api;
          try {
            const action = actionFor(target), final = 'Saved the current draft for Alice.';
            let requests = 0;
            const inferenceCaptured = [];
            const agent = makeAgent(GenericProgressAgent, async () => {
              assert.ok(++requests <= 2, 'Unrelated passive updates must not require another model decision');
              inferenceCaptured.push(fixture.snapshots.size > 0);
              fixture.churn();
              return requests === 1 ? call('save-current-draft', action.name, action.args)
                : call('saved', 'done', { summary: final, outcome: 'success' });
            });
            phaseForAgent.set(agent, phase);
            configure(agent, fixture, tab);
            assert.equal(await genericFinish(agent, tab, streaming, updates), final);
            assert.equal(requests, 2);
            assert.deepEqual(inferenceCaptured, [true, true], 'The target must be captured privately before each inference');
            assert.deepEqual(fixture.dispatched, [{ ...action, recipient: 'Alice' }]);
            assert.ok(fixture.feedbackAccepted.length > 0 && fixture.feedbackAccepted.every(Boolean));
            assert.ok(fixture.messages.filter(message => message.action === 'page_monitor_capture_model')
              .every(message => message.params.includeTree === true), 'The observation and private binding must be captured together');
            assert.ok(fixture.messages.some(message => message.action === 'page_monitor_validate_model'));
            assert.ok(updates.some(update => update.type === 'page_feedback'), 'Passive updates remain observable');
            assert.equal(updates.some(update => update.type === 'run_status' && update.data.status === 'page_unstable'), false);
          } finally { globalThis.chrome = previousChrome; globalThis.browser = previousBrowser; }
        });
      }

      const changes = target.startsWith('focused') ? ['recipient', 'field value', 'focus', 'human']
        : ['recipient', 'form destination', 'target node', 'human'];
      for (const change of changes) for (const phase of ['model', 'preparation']) {
        test(`${build}: ${streaming ? 'stream' : 'chat'} generic ${target} rejects changed ${change} during ${phase} before dispatch`, async () => {
          const previousChrome = globalThis.chrome, previousBrowser = globalThis.browser;
          const fixture = genericFixture(phase, phase === 'preparation' ? change : null), tab = genericTab++, updates = [];
          globalThis.chrome = fixture.api; globalThis.browser = fixture.api;
          try {
            const action = actionFor(target), final = 'Inspected the changed editor.';
            let requests = 0, initialCapture = false;
            const agent = makeAgent(GenericProgressAgent, async () => {
              assert.ok(++requests <= 3);
              if (requests === 1) {
                initialCapture = fixture.snapshots.size > 0;
                if (phase === 'model') fixture.revoke(change);
                else fixture.churn();
                return call('stale-save', action.name, action.args);
              }
              if (requests === 2) return call('inspect-changed-editor', 'extract_data', { type: 'headings' });
              return call('inspected', 'done', { summary: final, outcome: 'success' });
            });
            configure(agent, fixture, tab);
            assert.equal(await genericFinish(agent, tab, streaming, updates), final);
            assert.equal(requests, 3);
            assert.equal(initialCapture, true, 'The revoked action must have had a private snapshot before inference');
            assert.deepEqual(fixture.dispatched, [], 'A stale action must never reach the transport');
            assert.ok(fixture.feedbackAccepted.length > 0 && fixture.feedbackAccepted.every(Boolean));
          } finally { globalThis.chrome = previousChrome; globalThis.browser = previousBrowser; }
        });
      }
    }
  }
}
