import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fixedChoiceQuestion, withFixedChoiceAnswers } from './semantic-decision-stub.mjs';

const PAGE_URL = 'https://example.com/repositories';
const DATA_URL = 'https://example.com/data.json';
const TASK = 'Return a JSON list of all 174 repositories from this category.';
const EXPECTED = { count: 174, item_type: 'repository', ordered: false, required_fields: ['name'] };
const area = { get: async () => ({}), set: async () => {}, remove: async () => {} };
const api = {
  storage: { local: area, session: area },
  runtime: { getURL: value => `extension://test/${value}`, sendMessage: async () => ({}) },
  tabs: { get: async id => ({ id, url: PAGE_URL, title: 'Repositories' }), sendMessage: async () => ({ ready: true }) },
  webNavigation: { getAllFrames: async () => [{ frameId: 0, parentFrameId: -1, documentId: 'collection-document', url: PAGE_URL }] },
  scripting: { executeScript: async () => [{ result: null }] },
};
globalThis.chrome = api;
globalThis.browser = api;
let nextTab = 5600;

function fetchWindow(offset = 0, length = 7000, originalLength = 200000, url = DATA_URL) {
  const end = offset + length;
  return {
    success: true, status: 200, contentType: 'application/json', url,
    json: 'x'.repeat(length), offset, maxChars: length, originalLength,
    nextOffset: end < originalLength ? end : null, hasMore: end < originalLength,
    truncated: end < originalLength,
  };
}

const fetchArgs = (offset = 0, url = DATA_URL, maxChars = 7000) => ({ url, offset, maxChars });

function bindCollection(agent, tab, { task = TASK, count = 174, mode = 'active', action = 'process_item', guard = {} } = {}) {
  agent.conversations.set(tab, [{ role: 'system', content: 'System' }, { role: 'user', content: task }]);
  agent.progressExpectedItems.set(tab, { ...EXPECTED, count });
  const session = agent._setProgressSession(tab, { mode, allowedActions: [action], forbiddenActions: [], confidence: 1 }, {
    taskText: task, pageScope: PAGE_URL, source: 'planner',
  });
  assert.ok(session?.sessionId);
  agent._planExecutionGuards.set(tab, {
    enabled: true, requestKind: 'execute', requiresStateChange: false, requiresSubmission: false,
    taskDrifted: false, taskKey: agent._progressTaskKeyHash(tab), ...guard,
  });
  return session;
}

const checkRead = (agent, tab, args, result, name = 'fetch_url') => agent._checkDeliveryObservationStreak(
  tab, name, args, result, { enforceTerminal: true },
);

function makeIntegrationAgent(Agent, next, readings = []) {
  // The collected values are real ones; a model reading them at done says so.
  const answered = withFixedChoiceAnswers(next, { missing_value: 'value' });
  const provider = {
    name: 'collection read regression', model: 'test', promptTier: 'full', contextWindow: 128000,
    supportsTools: true, supportsVision: false,
    chat: (messages, options) => {
      const question = fixedChoiceQuestion(messages);
      if (question) readings.push({ kind: question.kind, items: question.items.length });
      return answered(messages, options);
    },
    async *chatStream(messages) {
      const response = await next(messages);
      if (response.content) yield { type: 'text', content: response.content };
      if (response.toolCalls) yield { type: 'tool_call', content: response.toolCalls.map((call, index) => ({ ...call, index })) };
      yield { type: 'done' };
    },
  };
  const agent = new Agent({ getActive: () => provider, getProvider: () => provider, getVisionProvider: async () => null });
  for (const name of ['_hydrate', '_persistSubmittedTurn', '_endTraceRun', '_manageContext', '_maybeEmitAskModeHandoff',
    '_maybeReinjectAdapter']) agent[name] = async () => {};
  agent._persist = () => {};
  agent._persistNow = async () => ({ ok: true });
  agent._startTraceRun = async () => null;
  agent._beginReadCompleteness = async () => null;
  agent._checkCostAllowance = async () => null;
  agent._recordCostUsage = async () => null;
  agent._currentUrl = async () => PAGE_URL;
  agent._getTabUrlTitle = async () => ({ tabUrl: PAGE_URL, tabTitle: 'Repositories' });
  agent._enrichUserMessageWithCurrentPage = async (_tab, _messages, content) => ({ role: 'user', content });
  agent._plannerMode = () => 'off';
  agent._runPlannerIntentGate = async () => ({
    proceed: true, requestKind: 'execute', requiresStateChange: false, requiresSubmission: false,
    expectedItems: EXPECTED, progressLedgerPolicy: 'enabled', progressAction: 'process_item',
  });
  // Classifier inference is unrelated to the observation cutoff. Keep real
  // session/task binding while supplying the planner's known collection intent.
  agent._ensureProgressSessionForCurrentTask = async (tab, opts = {}) => {
    agent.progressExpectedItems.set(tab, { ...EXPECTED });
    const session = agent._setProgressSession(tab, {
      mode: 'active', allowedActions: ['process_item'], forbiddenActions: [], confidence: 1,
    }, { taskText: opts.taskText || TASK, pageScope: PAGE_URL, source: 'planner' });
    agent._seedExpectedProgressItems(tab, session, EXPECTED);
    return session;
  };
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
  agent.maxSteps = Infinity;
  return agent;
}

const call = (id, name, args) => ({ toolCalls: [{ id, function: { name, arguments: JSON.stringify(args) } }] });

for (const build of ['chrome', 'firefox']) {
  const { Agent } = await import(`../src/${build}/src/agent/agent.js`);
  const { recordCollectionReadProgress } = await import(`../src/${build}/src/agent/collection-read-progress.js`);

  test(`${build}: collection range coverage accepts jumps and earlier unseen intervals`, () => {
    let state;
    const record = (offset, length = 7000, total = 633870) => {
      const recorded = recordCollectionReadProgress(state, fetchArgs(offset, DATA_URL, length), fetchWindow(offset, length, total));
      state = recorded.state;
      return recorded.madeProgress;
    };
    assert.equal(record(0, 4000), false, 'The first read only establishes a finite resource');
    assert.equal(record(372040, 6951), true, 'Searching schema offsets may jump past earlier content');
    assert.equal(record(378991, 4000), true, 'Actual delivered length determines the next interval');
    assert.equal(record(4000, 7000), true, 'Returning to the names array advances previously unseen coverage');
    assert.equal(record(372040, 7000), false, 'A changed maxChars cannot disguise covered positions');
    assert.equal(record(6000, 7000), true, 'An overlapping range still contributes more than 1000 new characters');
    assert.equal(record(12000, 1100), false, 'A tiny overlapping extension must not keep a run alive');
    assert.equal(record(633370, 500), true, 'The final short window may add fewer than 1000 characters');
    assert.equal(record(633370, 500), false, 'Completed tail coverage cannot reset twice');
  });

  test(`${build}: changing source length retires a resource instead of rebasing coverage`, () => {
    let recorded = recordCollectionReadProgress(undefined, fetchArgs(), fetchWindow());
    recorded = recordCollectionReadProgress(recorded.state, fetchArgs(7000), fetchWindow(7000, 7000, 200001));
    assert.equal(recorded.madeProgress, false);
    recorded = recordCollectionReadProgress(recorded.state, fetchArgs(14000), fetchWindow(14000));
    assert.equal(recorded.madeProgress, false, 'Reverting to the old length must not restore retired coverage');
  });

  test(`${build}: same-length content changes cannot reopen already covered positions`, () => {
    const initial = fetchWindow();
    let recorded = recordCollectionReadProgress(undefined, fetchArgs(), initial);
    recorded = recordCollectionReadProgress(recorded.state, fetchArgs(), { ...initial, json: 'y'.repeat(7000) });
    assert.equal(recorded.madeProgress, false);
    recorded = recordCollectionReadProgress(recorded.state, fetchArgs(7000), { ...fetchWindow(7000), json: 'y'.repeat(7000) });
    assert.equal(recorded.madeProgress, true, 'Coverage advances by position within the finite resource');
  });

  test(`${build}: only eight established resources can contribute continuation progress`, () => {
    let state;
    for (let resource = 0; resource < 8; resource++) {
      const url = `https://example.com/data-${resource}.json`;
      const first = recordCollectionReadProgress(state, fetchArgs(0, url), fetchWindow(0, 7000, 200000, url));
      assert.equal(first.madeProgress, false);
      const continuation = recordCollectionReadProgress(first.state, fetchArgs(7000, url), fetchWindow(7000, 7000, 200000, url));
      assert.equal(continuation.madeProgress, true);
      state = continuation.state;
    }
    const extraUrl = 'https://example.com/data-over-limit.json';
    const extra = recordCollectionReadProgress(state, fetchArgs(0, extraUrl), fetchWindow(0, 7000, 200000, extraUrl));
    assert.equal(extra.madeProgress, false);
    assert.equal(recordCollectionReadProgress(extra.state, fetchArgs(7000, extraUrl), fetchWindow(7000, 7000, 200000, extraUrl)).madeProgress, false);
  });

  for (const invalid of [
    ['failed response', args => args, result => ({ ...result, success: false, status: 500 })],
    ['find response', args => ({ ...args, find: 'name' }), result => ({ ...result, find: 'name' })],
    ['POST', args => ({ ...args, method: 'POST' }), result => result],
    ['HEAD', args => ({ ...args, method: 'HEAD' }), result => result],
    ['byte range', args => ({ ...args, headers: { Range: 'bytes=7000-13999' } }), result => ({ ...result, contentRange: 'bytes 7000-13999/200000' })],
    ['missing source length', args => args, result => ({ ...result, originalLength: undefined })],
    ['incorrect delivered length', args => args, result => ({ ...result, maxChars: 7001 })],
    ['incorrect continuation', args => args, result => ({ ...result, nextOffset: 15000 })],
    ['out of range', args => args, result => ({ ...result, originalLength: 1000 })],
    ['empty window', args => args, result => ({ ...result, json: '', maxChars: 0, nextOffset: 7000 })],
  ]) test(`${build}: ${invalid[0]} cannot claim collection read progress`, () => {
    const first = recordCollectionReadProgress(undefined, fetchArgs(), fetchWindow());
    assert.equal(recordCollectionReadProgress(first.state, invalid[1](fetchArgs(7000)), invalid[2](fetchWindow(7000))).madeProgress, false);
  });

  test(`${build}: fresh finite collection reads pass the real delivery guard beyond eight`, () => {
    const tab = nextTab++, agent = new Agent({});
    bindCollection(agent, tab);
    for (let index = 0; index < 15; index++) {
      assert.equal(checkRead(agent, tab, fetchArgs(index * 7000), fetchWindow(index * 7000)).kind, 'none');
    }
    assert.equal(agent.deliveryObservationStreaks.has(tab), false);
    assert.equal(agent._expectedItemsDoneBlock(tab)?.blocked, true, 'Read coverage must not falsely complete repository ledger rows');
  });

  test(`${build}: repeated covered windows still force terminal delivery after eight`, () => {
    const tab = nextTab++, agent = new Agent({});
    bindCollection(agent, tab);
    checkRead(agent, tab, fetchArgs(), fetchWindow());
    checkRead(agent, tab, fetchArgs(7000), fetchWindow(7000));
    let result;
    for (let attempt = 1; attempt <= 8; attempt++) {
      result = checkRead(agent, tab, fetchArgs(7000), fetchWindow(7000));
      assert.equal(result.kind, attempt === 4 ? 'nudge' : attempt === 8 ? 'deliver' : 'none');
    }
    assert.equal(result.count, 8);
  });

  test(`${build}: arbitrary fresh URLs do not erase the observation streak`, () => {
    const tab = nextTab++, agent = new Agent({});
    bindCollection(agent, tab);
    let result;
    for (let attempt = 0; attempt < 8; attempt++) {
      const url = `https://example.com/arbitrary-${attempt}.json`;
      result = checkRead(agent, tab, fetchArgs(0, url), fetchWindow(0, 7000, 200000, url));
    }
    assert.equal(result.kind, 'deliver');
    assert.equal(result.count, 8);
  });

  for (const name of ['fetch_url', 'research_url']) test(`${build}: ${name} search, failure and mutation calls do not clear a read debt`, () => {
    const tab = nextTab++, agent = new Agent({});
    bindCollection(agent, tab);
    checkRead(agent, tab, fetchArgs(), fetchWindow());
    for (const [args, result] of [
      [{ ...fetchArgs(7000), find: 'name' }, { ...fetchWindow(7000), find: 'name' }],
      [fetchArgs(7000), { ...fetchWindow(7000), success: false }],
      [{ ...fetchArgs(7000), method: 'POST' }, fetchWindow(7000)],
      [{ ...fetchArgs(7000), method: 'HEAD' }, fetchWindow(7000)],
    ]) {
      assert.equal(agent._deliveryCheckpointCollectionReadProgress(tab, name, args, result), false);
    }
    assert.equal(agent.deliveryObservationStreaks.get(tab), 1);
  });

  for (const scenario of [
    ['no expected items', (agent, tab) => agent.progressExpectedItems.delete(tab)],
    ['single expected item', (agent, tab) => agent.progressExpectedItems.set(tab, { ...EXPECTED, count: 1 })],
    ['inactive session', (agent, tab) => { agent.progressSessions.get(tab).mode = 'inactive'; }],
    ['action session', (agent, tab) => { agent.progressSessions.get(tab).allowedActions = ['follow']; }],
    ['mixed action session', (agent, tab) => { agent.progressSessions.get(tab).allowedActions = ['process_item', 'follow']; }],
    ['submission task', (agent, tab) => { agent._planExecutionGuards.get(tab).requiresSubmission = true; }],
    ['disabled guard', (agent, tab) => { agent._planExecutionGuards.get(tab).enabled = false; }],
    ['stale session', (agent, tab) => { agent.progressSessions.get(tab).taskText = 'A different task'; }],
    ['drifted task', (agent, tab) => { agent._planExecutionGuards.get(tab).taskDrifted = true; }],
    ['replaced task', (agent, tab) => { agent.conversations.get(tab).push({ role: 'user', content: 'Read a different website' }); }],
  ]) test(`${build}: ${scenario[0]} retains the ordinary eight-observation cutoff`, () => {
    const tab = nextTab++, agent = new Agent({});
    bindCollection(agent, tab);
    scenario[1](agent, tab);
    let result;
    for (let index = 0; index < 8; index++) result = checkRead(agent, tab, fetchArgs(index * 7000), fetchWindow(index * 7000));
    assert.equal(result.kind, 'deliver');
    assert.equal(result.count, 8);
  });

  test(`${build}: a mutation task gets one API discovery read but no collection continuation credit`, () => {
    const tab = nextTab++, agent = new Agent({});
    bindCollection(agent, tab, { guard: { requiresStateChange: true } });
    let result;
    for (let index = 0; index < 9; index++) {
      result = checkRead(agent, tab, fetchArgs(index * 7000), fetchWindow(index * 7000));
      if (index < 8) assert.notEqual(result.kind, 'deliver');
    }
    assert.equal(result.kind, 'deliver');
    assert.equal(result.count, 8, 'new offsets at one endpoint cannot renew API preparation credit');
    assert.equal(agent.deliveryApiReads.get(tab).size, 1);
  });

  test(`${build}: task-bound coverage survives page resets and clears at a run boundary`, () => {
    const tab = nextTab++, agent = new Agent({});
    bindCollection(agent, tab);
    assert.equal(agent._deliveryCheckpointCollectionReadProgress(tab, 'fetch_url', fetchArgs(), fetchWindow()), false);
    assert.equal(agent._deliveryCheckpointCollectionReadProgress(tab, 'fetch_url', fetchArgs(7000), fetchWindow(7000)), true);
    agent._clearPageLoopState(tab);
    assert.equal(agent._deliveryCheckpointCollectionReadProgress(tab, 'fetch_url', fetchArgs(7000), fetchWindow(7000)), false,
      'Navigating or refreshing must not reopen covered positions');
    assert.equal(agent._deliveryCheckpointCollectionReadProgress(tab, 'fetch_url', fetchArgs(14000), fetchWindow(14000)), true);
    agent._clearRunLoopState(tab);
    assert.equal(agent._deliveryCheckpointCollectionReadProgress(tab, 'fetch_url', fetchArgs(14000), fetchWindow(14000)), false,
      'A new run establishes a fresh baseline');
    assert.equal(agent._deliveryCheckpointCollectionReadProgress(tab, 'fetch_url', fetchArgs(21000), fetchWindow(21000)), true);
  });

  for (const streaming of [false, true]) test(`${build}: ${streaming ? 'stream' : 'chat'} delivers a finite collection after fifteen fresh reads`, async () => {
    const tab = nextTab++, updates = [], dispatched = [];
    const names = Array.from({ length: 174 }, (_, index) => ({ name: `owner/repository-${index + 1}` }));
    const answer = JSON.stringify(names);
    let requests = 0;
    const next = async () => {
      requests++;
      assert.ok(requests <= 17, 'Fresh collection windows should finish without terminal recovery');
      if (requests <= 15) return call(`window-${requests}`, 'fetch_url', fetchArgs((requests - 1) * 7000));
      if (requests === 16) return call('record-complete-items', 'progress_update', { items: names.map((item, index) => ({
        id: `expected:${index + 1}`, label: item.name, status: 'processed',
        fields: { name: item.name },
      })) });
      return call('finished', 'done', { summary: answer, outcome: 'success' });
    };
    const readings = [];
    const agent = makeIntegrationAgent(Agent, next, readings);
    agent.executeTool = async (_tab, name, args) => {
      if (name === 'get_accessibility_tree') return { success: true, pageContent: 'heading "Repositories" [ref_1]' };
      if (name === 'done') return { done: true, success: true, summary: args.summary, outcome: args.outcome };
      if (name === 'progress_update') return agent._progressUpdate(_tab, args);
      assert.equal(name, 'fetch_url');
      dispatched.push(args.offset);
      return fetchWindow(args.offset);
    };
    const update = (type, data) => updates.push({ type, data });
    const options = { detachedRequestId: 'collection-run', askStreamingEnabled: false };
    const result = streaming
      ? await agent.processMessageStream(tab, TASK, update, 'act', options)
      : await agent.processMessage(tab, TASK, update, 'act', [], options);
    assert.equal(result.split('\n\nProgress ledger:')[0], answer, JSON.stringify(updates.filter(entry => entry.type === 'warning')));
    assert.match(result, /174 row\(s\), 174 processed/);
    assert.equal(requests, 17);
    // Each of the 174 required values was read once, in a few long lists.
    assert.deepEqual(readings.map(reading => reading.kind), ['missing_value', 'missing_value', 'missing_value']);
    assert.equal(readings.reduce((sum, reading) => sum + reading.items, 0), 174);
    assert.equal(dispatched.length, 15);
    assert.equal(updates.some(entry => entry.type === 'warning' && /observation tools are now stopping/.test(entry.data.message)), false);
  });
}
