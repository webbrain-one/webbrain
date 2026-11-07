// A request that says how a page is to be read ("read it in the background,
// keep this tab where it is") gets a final answer that says how it was read.
// fetch_url and research_url already report it (retrieval, visibleTabOpened,
// backgroundTabActivated, activeTabChanged); the run keeps what its reads
// reported, the completion judge is asked about the request only after such
// a read, and a sure "asked" adds one line built from those reads.
// Both builds: the pure helpers, the judge's questions, and the real batch
// path and done handler with a mocked browser.
import assert from 'node:assert/strict';
import { test } from 'node:test';

const PAGE = 'http://localhost:8765/';
const ARTICLE = 'https://wiki.example.org/wiki/Sample_city?utm_source=token-123';
const REQUEST = `Read ${ARTICLE} in the background and summarize it in three sentences. Keep this tab where it is.`;
const SUMMARY = 'Sample City is the capital of an example country. It is old. It is busy.';
const FETCH_NOTE = 'Read in the background from wiki.example.org: fetched directly, without opening a tab or changing your active tab.';

const area = { get: async () => ({}), set: async () => {}, remove: async () => {} };
const api = {
  storage: { local: area, session: area, onChanged: { addListener() {} } },
  runtime: { getURL: value => `extension://test/${value}`, sendMessage: async () => ({}) },
  tabs: {
    get: async id => ({ id, url: PAGE, title: 'Test site', status: 'complete' }),
    sendMessage: async () => ({ ready: true }),
    executeScript: async () => [null],
  },
  webNavigation: { getAllFrames: async () => [{ frameId: 0, parentFrameId: -1, documentId: 'document-1', url: PAGE }] },
  scripting: { executeScript: async () => [{ result: null }] },
};
globalThis.chrome = api;
globalThis.browser = api;
const { cdpClient } = await import('../src/chrome/src/cdp/cdp-client.js');

let nextTab = 9700;
let nextCall = 1;

// Swap globals for one body and always restore them.
async function withGlobals(overrides, fn) {
  const saved = new Map(Object.keys(overrides).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  Object.assign(globalThis, overrides);
  try { return await fn(); } finally {
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  }
}

const htmlResponse = url => ({ status: 200, url, headers: new Headers({ 'content-type': 'text/html' }),
  text: async () => '<html><title>Sample city</title><body>Sample City is the capital.</body></html>' });

// Real fetch_url / research_url results, as the agent receives them.
async function fetchResult(network, build, url = ARTICLE) {
  const tabs = { tabs: { get: async () => ({ id: 5, url: PAGE }) } };
  return withGlobals({ fetch: async target => htmlResponse(String(target)), [build === 'chrome' ? 'chrome' : 'browser']: { ...api, ...tabs } },
    () => network.fetchUrl(url, {}, { tabId: 5 }));
}
async function researchResult(network, build, url = 'https://spa.example.com/app') {
  const nativeSetTimeout = globalThis.setTimeout;
  const page = { title: 'Rendered', url, text: 'Rendered text', originalLength: 13, links: [] };
  const tabs = {
    async create(props) { return { id: 77, url: props.url }; },
    async get() { return { id: 77, url }; },
    async remove() {},
    onUpdated: { addListener(fn) { nativeSetTimeout(() => fn(77, { status: 'complete' }), 0); }, removeListener() {} },
  };
  const browserApi = build === 'chrome'
    ? { ...api, tabs, scripting: { async executeScript() { return [{ result: page }]; } } }
    : { ...api, tabs: { ...tabs, async executeScript() { return [page]; } } };
  const fastTimeout = (fn, ms, ...args) => nativeSetTimeout(fn, ms === 800 ? 0 : ms, ...args);
  return withGlobals({ setTimeout: fastTimeout, [build === 'chrome' ? 'chrome' : 'browser']: browserApi },
    () => network.researchUrl(url, { timeout: 1000 }));
}

const choice = (choices, picked, confidence = .95) => ({ type: 'choice', choice: picked, confidence,
  probabilities: Object.fromEntries(choices.map(x => [x, x === picked ? 1 - .05 * (choices.length - 1) : .05])) });
const decisionAnswers = (questions, read) => ({ model: 'judge', answers: {
  task_outcome: { type: 'choice', choice: 'succeeded', confidence: .99,
    probabilities: { succeeded: .97, pending: .01, failed: .01, uncertain: .01 } },
  later_outcome: choice(['asked', 'not_asked'], 'not_asked'),
  summary_kind: choice(['result', 'meta_only', 'plan_only'], 'result'),
  ...(questions.read_method ? { read_method: choice(['asked', 'not_asked'], read) } : {}),
} });

// An Act agent whose tool batches and done handler run for real against a
// fixed page; only fetch_url / research_url and the judge's page read are
// answered by the test. `judge` is 'decision' (the decision model) or 'llm'
// (the active model, with the decision model off).
function harness(Agent, { judge = 'decision', task = REQUEST, reads = {} } = {}) {
  const tab = nextTab++;
  const pageState = { url: PAGE, title: 'Test site', openDialogCount: 0, dialogTitles: [], visibleFormCount: 0,
    relevantFormCount: 0, formDescriptors: [], liveRegionMessages: [], successMessages: [], documentIdentity: 'test-document',
    incompleteTaskControls: [], workflowStatusTexts: [], workflowResourceUrls: [], workflowResourceRecords: [], workflowPageText: 'Test site' };
  const settings = judge === 'decision' ? { decisionProvider: 'local', systemOneEnabled: true, decisionVisionMode: 'off' } : { systemOneEnabled: false };
  globalThis.chrome = globalThis.browser = { ...api, storage: { ...api.storage, local: { ...area, get: async () => settings } },
    tabs: { ...api.tabs, executeScript: async () => [pageState] } };
  cdpClient.attach = async () => {};
  cdpClient.sendCommand = async () => ({});
  cdpClient.evaluate = async () => ({ result: { value: pageState } });
  const provider = { model: 'test-model', supportsTools: true, supportsVision: false, config: { category: 'local' }, chat() {} };
  const agent = new Agent({ getActive: () => provider, getVisionProvider: async () => null });
  agent.conversationIds.set(tab, `conv-${tab}`);
  agent.conversationModes.set(tab, 'act');
  agent.conversations.set(tab, [{ role: 'system', content: 'sys' }, { role: 'user', content: task }]);
  agent.autoScreenshot = 'off';
  Object.assign(agent, { _ensureGateSetting: async () => {}, _skipPermissionGate: true, _currentUrl: async () => PAGE,
    _persist: () => {}, _persistNow: async () => true, systemOneContext: () => ({ isCurrent: () => true }),
    _latestTaskText: () => task, _completionDocumentStamp: async () => 'test-document',
    _captureViewportProbe: async () => ({ url: PAGE, title: 'Test site' }) });
  const judged = [];
  const state = { read: 'asked', llm: { outcome: 'succeeded', reason: 'The summary was given.', read: 'asked' } };
  agent.evaluateSystemOne = async (_tab, _client, args) => {
    if (judge !== 'decision') throw new Error('The decision model is off.');
    judged.push(args);
    return decisionAnswers(args.questions, state.read);
  };
  agent._chatWithCostAllowance = async (_provider, messages) => {
    judged.push(messages);
    return { content: JSON.stringify(state.llm) };
  };
  const execute = agent.executeTool.bind(agent);
  agent.executeTool = (tabId, name, args, ...rest) => {
    if (name === 'get_accessibility_tree') return Promise.resolve({ success: true, pageContent: 'heading "Test site"' });
    if (Object.hasOwn(reads, name)) return Promise.resolve(structuredClone(reads[name]));
    return execute(tabId, name, args, ...rest);
  };
  agent._beginCompletionInvariant(tab);
  const batch = async calls => {
    const toolCalls = calls.map(([name, args]) => ({ id: `${name}_${nextCall++}`, function: { name, arguments: JSON.stringify(args) } }));
    const messages = agent.conversations.get(tab);
    messages.push({ role: 'assistant', content: null, tool_calls: toolCalls });
    return agent._executeToolBatch(tab, toolCalls, messages, () => {}, { supportsVision: false }, null,
      new Set(['done', 'fetch_url', 'research_url', 'get_accessibility_tree']), 1, {});
  };
  return { agent, tab, batch, judged, state };
}

for (const build of ['chrome', 'firefox']) {
  const network = await import(`../src/${build}/src/network/network-tools.js`);
  const verifier = await import(`../src/${build}/src/agent/completion-verifier.js`);
  const { Agent } = await import(`../src/${build}/src/agent/agent.js`);

  test(`${build}: a run keeps how its background reads read each site, by host only`, async () => {
    const fetched = await fetchResult(network, build);
    assert.equal(fetched.retrieval, 'background_fetch');
    let reads = network.recordBackgroundRead(undefined, 'fetch_url', { url: ARTICLE }, fetched);
    assert.deepEqual(reads, [{ retrieval: 'background_fetch', host: 'wiki.example.org', count: 1 }],
      'the host is kept; the path and query string are not');
    // The same article read again (another window, a find, a HEAD) is one site.
    reads = network.recordBackgroundRead(reads, 'fetch_url', { url: ARTICLE, find: 'capital', method: 'head' }, fetched);
    assert.deepEqual(reads, [{ retrieval: 'background_fetch', host: 'wiki.example.org', count: 2 }]);
    const tabbed = await researchResult(network, build);
    assert.equal(tabbed.retrieval, 'background_tab');
    reads = network.recordBackgroundRead(reads, 'research_url', { url: 'https://spa.example.com/app' }, tabbed);
    assert.deepEqual(reads.at(-1), { retrieval: 'background_tab', host: 'spa.example.com', count: 1 });

    // Nothing else is a background read: a failed read, a write or a captured
    // API replay, another tool's result carrying the same fields, a read that
    // changed the active tab, or a result without a web address.
    for (const [name, args, result] of [
      ['fetch_url', {}, { ...fetched, success: false, status: 404 }],
      ['fetch_url', { method: 'POST', body: '{}' }, fetched],
      ['fetch_url', { method: 'delete' }, fetched],
      ['fetch_url', { replayRequestId: 'api_9_req_1' }, fetched],
      ['fetch_url', {}, { ...fetched, replayContext: 'page' }],
      ['execute_webmcp_tool', {}, fetched],
      ['fetch_url', {}, { ...fetched, activeTabChanged: true }],
      ['fetch_url', {}, { ...fetched, visibleTabOpened: true }],
      ['research_url', {}, { ...tabbed, backgroundTabActivated: true }],
      ['fetch_url', {}, tabbed],
      ['fetch_url', {}, { ...fetched, url: 'file:///home/user/notes.txt' }],
      ['fetch_url', {}, { ...fetched, url: 'not a url' }],
      ['fetch_url', {}, null],
    ]) assert.equal(network.recordBackgroundRead(reads, name, args, result), reads, `${name} ${JSON.stringify(args)} ${JSON.stringify(result)?.slice(0, 80)}`);
  });

  test(`${build}: the read line says what the reads did, site by site`, () => {
    const fetch = host => ({ retrieval: 'background_fetch', host, count: 1 });
    const tab = (host, count = 1) => ({ retrieval: 'background_tab', host, count });
    assert.equal(network.backgroundReadNote([fetch('wiki.example.org')]), FETCH_NOTE);
    assert.equal(network.backgroundReadNote([fetch('a.example'), fetch('b.example')]),
      'Read in the background from a.example and b.example: fetched directly, without opening a tab or changing your active tab.');
    assert.equal(network.backgroundReadNote(['a', 'b', 'c', 'd', 'e'].map(x => fetch(`${x}.example`))),
      'Read in the background from a.example, b.example and 3 other sites: fetched directly, without opening a tab or changing your active tab.');
    assert.equal(network.backgroundReadNote([tab('spa.example.com')]),
      'Read in a background tab from spa.example.com, which was never brought to the front and was closed after reading.');
    assert.equal(network.backgroundReadNote([fetch('a.example'), tab('spa.example.com', 2)]),
      'Read in the background from a.example: fetched directly, without opening a tab or changing your active tab. '
      + 'Read in background tabs from spa.example.com, which were never brought to the front and were closed after reading.');
    for (const none of [undefined, null, [], [{ retrieval: 'navigate', host: 'x.example' }]]) {
      assert.equal(network.backgroundReadNote(none), '', JSON.stringify(none));
    }
  });

  test(`${build}: the judge is asked how pages were to be read only after a background read`, () => {
    assert.deepEqual(Object.keys(verifier.completionQuestions()), ['task_outcome', 'later_outcome', 'summary_kind'],
      'a run without a background read sends the same questions as before');
    const asked = verifier.completionQuestions({ readMethod: true });
    assert.deepEqual(Object.keys(asked), ['task_outcome', 'later_outcome', 'summary_kind', 'read_method']);
    assert.deepEqual(Object.keys(asked.read_method.criteria), ['asked', 'not_asked']);
    assert.match(asked.read_method.instructions, /in the background/);
    assert.match(asked.read_method.instructions, /any language/);
    assert.match(verifier.READ_METHOD_FIELD, /"read" to "asked"/);
    assert.match(verifier.READ_METHOD_FIELD, /any language/);

    // Only a sure "asked" counts, and it never changes the verdict.
    const sure = decisionAnswers(asked, 'asked');
    assert.equal(verifier.decisionCompletionVerdict(sure).readMethod, 'asked');
    assert.equal(verifier.decisionCompletionVerdict(sure).outcome, 'succeeded');
    assert.equal(verifier.decisionCompletionVerdict(decisionAnswers(asked, 'not_asked')).readMethod, undefined);
    const unsure = decisionAnswers(asked, 'asked');
    unsure.answers.read_method.confidence = .5;
    assert.equal(verifier.decisionCompletionVerdict(unsure).readMethod, undefined);
    assert.equal(verifier.decisionCompletionVerdict(decisionAnswers(verifier.completionQuestions(), 'asked')).readMethod, undefined);

    // The active model's verdict: an exact "asked", and only when asked.
    const llm = read => JSON.stringify({ outcome: 'succeeded', reason: 'summarized', read });
    assert.equal(verifier.llmCompletionVerdict(llm('asked'), { readMethod: true }).readMethod, 'asked');
    assert.equal(verifier.llmCompletionVerdict(llm('asked')).readMethod, undefined, 'an answer to a question not asked counts for nothing');
    for (const read of ['not_asked', 'ASKED', 'yes', '', null, true]) {
      const verdict = verifier.llmCompletionVerdict(llm(read), { readMethod: true });
      assert.equal(verdict.outcome, 'succeeded'); assert.equal(verdict.readMethod, undefined, JSON.stringify(read));
    }
  });

  test(`${build}: a background read for a request about how to read ends with how it was read`, async () => {
    const fetched = await fetchResult(network, build);
    const h = harness(Agent, { reads: { fetch_url: fetched } });
    // The QA case: the same article fetched in several windows, then done.
    for (const args of [{ url: ARTICLE }, { url: ARTICLE, find: 'capital' }, { url: ARTICLE, offset: 7000 }]) {
      assert.equal((await h.batch([['fetch_url', args]])).action, 'continue');
    }
    const result = await h.batch([['done', { summary: SUMMARY, outcome: 'success' }]]);
    assert.equal(result.action, 'return');
    assert.equal(result.value, `${SUMMARY}\n\n${FETCH_NOTE}`);
    assert.equal(h.judged.length, 1, 'the line costs no extra decision');
    assert.ok(h.judged[0].questions.read_method, 'the read question travels with the verdict');
    assert.match(JSON.stringify(h.judged[0].state), /in the background/, 'the judge reads the request as written');
    assert.doesNotMatch(result.value, /utm_source|token-123|Sample_city/, 'only the host reaches the answer');
  });

  test(`${build}: no line without a sure "asked" or without a background read`, async () => {
    const fetched = await fetchResult(network, build);
    // The judge reads a request that says nothing about how to read.
    const plain = harness(Agent, { task: `Summarize ${ARTICLE} in three sentences.`, reads: { fetch_url: fetched } });
    plain.state.read = 'not_asked';
    await plain.batch([['fetch_url', { url: ARTICLE }]]);
    const plainDone = await plain.batch([['done', { summary: SUMMARY, outcome: 'success' }]]);
    assert.equal(plainDone.value, SUMMARY);
    assert.ok(plain.judged[0].questions.read_method);

    // A failed fetch read nothing, so the judge is not asked about reading.
    const failed = harness(Agent, { reads: { fetch_url: { ...fetched, success: false, status: 404, error: 'Fetch returned HTTP 404' } } });
    await failed.batch([['fetch_url', { url: ARTICLE }]]);
    const failedDone = await failed.batch([['done', { summary: SUMMARY, outcome: 'success' }]]);
    assert.equal(failedDone.value, SUMMARY);
    assert.equal(failed.judged[0].questions.read_method, undefined, 'no background read, no read question');

    // A request about tabs whose run read nothing in the background.
    const none = harness(Agent);
    const noneDone = await none.batch([['done', { summary: SUMMARY, outcome: 'success' }]]);
    assert.equal(noneDone.value, SUMMARY);
    assert.deepEqual(Object.keys(none.judged[0].questions), ['task_outcome', 'later_outcome', 'summary_kind']);
  });

  test(`${build}: research_url reads are reported as a background tab that was closed`, async () => {
    const tabbed = await researchResult(network, build);
    const h = harness(Agent, { task: 'Open https://spa.example.com/app in a background tab and tell me its title.', reads: { research_url: tabbed } });
    await h.batch([['research_url', { url: 'https://spa.example.com/app' }]]);
    const result = await h.batch([['done', { summary: 'The title is Rendered.', outcome: 'success' }]]);
    assert.equal(result.value, 'The title is Rendered.\n\nRead in a background tab from spa.example.com, which was never brought to the front and was closed after reading.');
  });

  test(`${build}: the active-model judge answers the read question in the same request`, async () => {
    const fetched = await fetchResult(network, build);
    const h = harness(Agent, { judge: 'llm', task: 'Lies https://wiki.example.org/wiki/Sample_city im Hintergrund und fasse es zusammen. Lass diesen Tab, wo er ist.', reads: { fetch_url: fetched } });
    await h.batch([['fetch_url', { url: ARTICLE }]]);
    const result = await h.batch([['done', { summary: SUMMARY, outcome: 'success' }]]);
    assert.equal(result.value, `${SUMMARY}\n\n${FETCH_NOTE}`);
    assert.equal(h.judged.length, 1, 'the line costs no extra model call');
    assert.match(h.judged[0][0].content, /"read":"asked\|not_asked"/);
    assert.ok(h.judged[0][0].content.includes(verifier.READ_METHOD_FIELD));
    assert.match(h.judged[0][1].content, /im Hintergrund/, 'the judge reads the request as written');

    // Without a background read the field is neither asked nor honored.
    const none = harness(Agent, { judge: 'llm' });
    const noneDone = await none.batch([['done', { summary: SUMMARY, outcome: 'success' }]]);
    assert.equal(noneDone.value, SUMMARY);
    assert.doesNotMatch(none.judged[0][0].content, /"read"/);
    assert.equal(none.judged[0][0].content.includes(verifier.READ_METHOD_FIELD), false);
  });
}
