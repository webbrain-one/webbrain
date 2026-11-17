import assert from 'node:assert/strict';
import { test } from 'node:test';
import { withFixedChoiceAnswers } from './semantic-decision-stub.mjs';

const SITE = 'https://cms.example/';
const TASK = 'Translate the source article and publish a new post on this WordPress site.';
const SOURCE = 'https://news.example/article';
const area = { get: async () => ({}), set: async () => {}, remove: async () => {} };
const api = {
  storage: { local: area, session: area },
  runtime: { getURL: value => `extension://test/${value}`, sendMessage: async () => ({}) },
  tabs: { get: async id => ({ id, url: SITE, title: 'CMS' }), sendMessage: async () => ({ ready: true }) },
  webNavigation: { getAllFrames: async () => [{ frameId: 0, parentFrameId: -1, documentId: 'cms-document', url: SITE }] },
  scripting: { executeScript: async () => [{ result: null }] },
};
globalThis.chrome = api;
globalThis.browser = api;

const args = path => ({ url: new URL(path, SITE).href });
const json = (request, value = { available: true }) => ({
  success: true, status: 200, contentType: 'application/json; charset=utf-8',
  url: request.url, json: JSON.stringify(value),
});
const call = (id, name, parameters) => ({ id, function: { name, arguments: JSON.stringify(parameters) } });
const enforced = { enforceTerminal: true };

// Sanitized shape of the reported 49.0.1 trace: two batches of four reads,
// followed by the write the runtime used to prevent. No source text or nonce.
const preflight = [
  ['research_url', { url: SOURCE }, { success: true, url: SOURCE, text: 'Source article.' }],
  ['fetch_url', args('/wp-json/'), json(args('/wp-json/'))],
  ['fetch_url', args('/wp-admin/admin-ajax.php?action=rest-nonce'), {
    success: true, status: 200, contentType: 'text/html', text: 'fixture-nonce',
  }],
  ['fetch_url', args('/wp-json/wp/v2/posts?per_page=3&_fields=id,title,content'), json(args('/wp-json/wp/v2/posts'), [{ id: 1 }])],
  ['fetch_url', { url: SOURCE, find: 'article ending' }, { success: true, status: 200, text: 'Ending.' }],
  ['fetch_url', args('/wp-json/wp/v2/users/me?context=edit'), json(args('/wp-json/wp/v2/users/me'), { capabilities: { edit_posts: true, publish_posts: true } })],
  ['fetch_url', args('/wp-json/wp/v2/categories?per_page=100'), json(args('/wp-json/wp/v2/categories'), [{ id: 20, name: 'Technology' }])],
  ['fetch_url', args('/wp-json/wp/v2/types/post?context=edit'), json(args('/wp-json/wp/v2/types/post'), { rest_base: 'posts', taxonomies: ['category'] })],
];

function bindTask(agent, tab, mode = 'act', gate = {}) {
  agent.conversations.set(tab, [{ role: 'system', content: 'System' }, { role: 'user', content: TASK }]);
  return agent._startPlanExecutionGuard(tab, mode, {
    requestKind: 'execute', requiresStateChange: true, requiresSubmission: true, ...gate,
  });
}

function makeAgent(Agent, next) {
  const answered = withFixedChoiceAnswers(next, {});
  const provider = {
    name: 'API preflight regression', model: 'test', promptTier: 'full', contextWindow: 128000,
    supportsTools: true, supportsVision: false,
    chat: (messages, options) => answered(messages, options),
    async *chatStream(messages, options) {
      const response = await answered(messages, options);
      if (response.content) yield { type: 'text', content: response.content };
      if (response.toolCalls) yield { type: 'tool_call', content: response.toolCalls.map((item, index) => ({ ...item, index })) };
      yield { type: 'done' };
    },
  };
  const agent = new Agent({ getActive: () => provider, getProvider: () => provider, getVisionProvider: async () => null });
  for (const name of ['_hydrate', '_persistSubmittedTurn', '_endTraceRun', '_manageContext', '_maybeReinjectAdapter']) agent[name] = async () => {};
  agent._persist = () => {};
  agent._persistNow = async () => ({ ok: true });
  agent._startTraceRun = async () => null;
  agent._beginReadCompleteness = async () => null;
  agent._checkCostAllowance = async () => null;
  agent._recordCostUsage = async () => null;
  agent._currentUrl = async () => SITE;
  agent._getTabUrlTitle = async () => ({ tabUrl: SITE, tabTitle: 'CMS' });
  agent._enrichUserMessageWithCurrentPage = async (_tab, _messages, content) => ({ role: 'user', content });
  agent._plannerMode = () => 'off';
  agent._runPlannerIntentGate = async () => ({
    proceed: true, requestKind: 'execute', requiresStateChange: true, requiresSubmission: true,
  });
  agent._ensureProgressSessionForCurrentTask = async tab => agent._setProgressSession(tab, {
    mode: 'inactive', allowedActions: [], forbiddenActions: [], confidence: 1,
  }, { taskText: TASK, pageScope: SITE, source: 'planner' });
  agent._skipPermissionGate = true;
  agent._ensureGateSetting = async () => true;
  agent.alwaysAllowApiMutations = true;
  agent.enforceActionGuards = false;
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

for (const build of ['chrome', 'firefox']) {
  const { Agent } = await import(`../src/${build}/src/agent/agent.js`);
  const { recordApiReadProgress } = await import(`../src/${build}/src/agent/api-read-progress.js`);

  test(`${build}: eight publishing preflight reads leave action tools available with guards on or off`, () => {
    for (const guards of [true, false]) {
      const agent = new Agent({}), tab = `preflight-${guards}`;
      agent.enforceActionGuards = guards;
      const guard = bindTask(agent, tab);
      for (const [name, request, response] of preflight) {
        assert.equal(agent._checkDeliveryObservationStreak(tab, name, request, response, enforced).kind, 'none');
      }
      assert.equal(agent.deliveryObservationStreaks.get(tab), 3);
      assert.equal(agent.deliveryApiReads.get(tab).size, 5);
      assert.equal(guard.successfulConsequentialToolCalls, 0, 'preparation does not prove a write');
      assert.equal(guard.verifiedSubmissionEvidence, false);
    }
  });

  test(`${build}: projections, pagination, fragments and trailing slashes cannot renew endpoint credit`, () => {
    const first = args('/api/schema');
    const recorded = recordApiReadProgress(undefined, first, json(first));
    assert.equal(recorded.madeProgress, true);
    for (const path of ['/api/schema', '/api/schema/', '/api/schema?page=2', '/api/schema?_fields=id', '/api/schema#part']) {
      const request = args(path);
      assert.equal(recordApiReadProgress(recorded.state, request, json(request)).madeProgress, false);
    }
    assert.deepEqual([...recorded.state], [`${SITE}api/schema`]);
  });

  test(`${build}: failed, empty, non-JSON, redirected and mutating requests get no allowance`, () => {
    const request = args('/api/schema'), response = json(request);
    for (const [a, r] of [
      [request, { ...response, success: false }], [request, { ...response, status: 403 }],
      [request, { ...response, status: 500 }], [request, { ...response, error: 'blocked' }],
      [request, { ...response, noProgress: true }], [request, { ...response, json: '' }],
      [request, { ...response, contentType: 'text/html' }],
      [request, { ...response, url: 'https://other.example/api/schema' }],
      [request, { ...response, url: `${SITE}login` }],
      [{ ...request, method: 'POST' }, response], [{ ...request, method: 'HEAD' }, response],
    ]) assert.equal(recordApiReadProgress(undefined, a, r).madeProgress, false);
    assert.equal(recordApiReadProgress(undefined, request, {
      ...response, contentType: 'application/vnd.api+json', json: '{"schema":', truncated: true,
    }).madeProgress, true, 'a delivered slice of a large schema is useful preparation');
  });

  test(`${build}: new endpoints have a run-wide cap and never erase earlier observations`, () => {
    const agent = new Agent({}), tab = 'bounded';
    bindTask(agent, tab);
    for (let n = 0; n < 3; n++) agent._checkDeliveryObservationStreak(tab, 'scroll', {}, { success: true }, enforced);
    for (let n = 0; n < 8; n++) {
      const request = args(`/api/schema-${n}`);
      assert.equal(agent._checkDeliveryObservationStreak(tab, 'fetch_url', request, json(request), enforced).kind, 'none');
    }
    assert.equal(agent.deliveryObservationStreaks.get(tab), 3);
    let check;
    for (let n = 8; n < 13; n++) {
      const request = args(`/api/schema-${n}`);
      check = agent._checkDeliveryObservationStreak(tab, 'fetch_url', request, json(request), enforced);
    }
    assert.equal(check.kind, 'deliver');
    assert.equal(check.count, 8);
    assert.equal(agent.deliveryApiReads.get(tab).size, 8);
  });

  test(`${build}: page resets and successful writes do not replenish preparation credit; a new run does`, () => {
    const agent = new Agent({}), tab = 'lifecycle', request = args('/api/schema');
    bindTask(agent, tab);
    assert.equal(agent._deliveryCheckpointApiReadProgress(tab, 'fetch_url', request, json(request)), true);
    agent._clearPageLoopState(tab);
    assert.equal(agent._deliveryCheckpointApiReadProgress(tab, 'fetch_url', request, json(request)), false);
    agent._checkDeliveryObservationStreak(tab, 'fetch_url', { ...request, method: 'POST' }, { success: true }, { ...enforced, consequential: true });
    assert.equal(agent._deliveryCheckpointApiReadProgress(tab, 'fetch_url', request, json(request)), false);
    agent._clearRunLoopState(tab);
    assert.equal(agent.deliveryApiReads.has(tab), false);
    assert.equal(agent._deliveryCheckpointApiReadProgress(tab, 'fetch_url', request, json(request)), true);
  });

  for (const scenario of ['ask', 'read-only', 'unknown intent', 'drifted', 'replaced task', 'missing binding']) {
    test(`${build}: ${scenario} retains the ordinary cutoff`, () => {
      const agent = new Agent({}), tab = scenario;
      const guard = bindTask(agent, tab, scenario === 'ask' ? 'ask' : 'act', {
        requiresStateChange: scenario === 'read-only' ? false : scenario === 'unknown intent' ? null : true,
      });
      if (scenario === 'drifted') guard.taskDrifted = true;
      if (scenario === 'missing binding') guard.taskKey = '';
      if (scenario === 'replaced task') agent.conversations.get(tab).push({ role: 'user', content: 'Read another website.' });
      let check;
      for (let n = 0; n < 8; n++) {
        const request = args(`/api/schema-${n}`);
        check = agent._checkDeliveryObservationStreak(tab, 'fetch_url', request, json(request), enforced);
      }
      assert.equal(check.kind, 'deliver');
    });
  }

  test(`${build}: repeated successful endpoints still force delivery`, () => {
    const agent = new Agent({}), tab = 'repeated', request = args('/api/schema');
    bindTask(agent, tab);
    let check;
    for (let n = 0; n < 9; n++) check = agent._checkDeliveryObservationStreak(tab, 'fetch_url', request, json(request), enforced);
    assert.equal(check.kind, 'deliver');
    assert.equal(check.count, 8);
  });

  for (const streaming of [false, true]) test(`${build}: ${streaming ? 'stream' : 'chat'} publishes and reads back after two preflight batches`, async () => {
    let requests = 0;
    const dispatched = [], updates = [];
    const post = { id: 42, status: 'publish', link: `${SITE}translated-post/`, title: { rendered: 'Translated article' } };
    const next = async (_messages, options) => {
      requests++;
      assert.ok(requests <= 5, 'run should finish without a forced recovery turn');
      assert.ok(options?.tools?.some(tool => tool.function.name === 'fetch_url'), 'normal action tools remain available');
      if (requests <= 2) return { toolCalls: preflight.slice((requests - 1) * 4, requests * 4)
        .map(([name, request], index) => call(`read-${requests}-${index}`, name, request)) };
      if (requests === 3) return {
        content: 'Creating the translated post with POST /wp-json/wp/v2/posts, title Translated article and status publish.',
        toolCalls: [call('create', 'fetch_url', { ...args('/wp-json/wp/v2/posts'), method: 'POST', body: JSON.stringify({ title: 'Translated article', content: 'Translation.', status: 'publish' }) })],
      };
      if (requests === 4) return { toolCalls: [call('verify', 'fetch_url', args('/wp-json/wp/v2/posts/42'))] };
      return { toolCalls: [call('finished', 'done', { summary: `Published: ${post.link}`, outcome: 'success' })] };
    };
    const agent = makeAgent(Agent, next);
    agent.executeTool = async (_tab, name, request) => {
      if (name === 'get_accessibility_tree') return { success: true, pageContent: 'heading "CMS" [ref_1]' };
      if (name === 'done') return { done: true, success: true, summary: request.summary, outcome: request.outcome };
      dispatched.push({ name, ...request });
      if (request.method === 'POST') return { ...json(request, post), status: 201 };
      if (request.url === `${SITE}wp-json/wp/v2/posts/42`) return json(request, post);
      const fixture = preflight.find(([tool, parameters]) => tool === name && parameters.url === request.url);
      assert.ok(fixture, `unexpected tool ${name} ${request.url}`);
      return structuredClone(fixture[2]);
    };
    const tab = `integration-${streaming}`, update = (type, data) => updates.push({ type, data });
    const options = { detachedRequestId: tab, askStreamingEnabled: false };
    const result = streaming
      ? await agent.processMessageStream(tab, TASK, update, 'act', options)
      : await agent.processMessage(tab, TASK, update, 'act', [], options);
    assert.equal(result, `Published: ${post.link}`, JSON.stringify(updates.filter(u => u.type === 'warning')));
    assert.equal(requests, 5);
    assert.equal(dispatched.length, 10, JSON.stringify({ dispatched, updates: updates.filter(u => ['warning', 'error', 'tool_result'].includes(u.type)) }));
    assert.equal(dispatched[8].method, 'POST');
    assert.equal(dispatched[9].url, `${SITE}wp-json/wp/v2/posts/42`);
    assert.equal(updates.some(u => u.type === 'warning' && /observation limit|DELIVERY/.test(u.data.message)), false);
  });
}
