// Ask mode on a long page (QA case G7: "Summarize this page." on a very long
// article). The model was shown only the start of the page, cut off, and
// answered at once as if it had read all of it. A page cut to fit a tool
// result now stays JSON and names the read that covers the whole page; an
// Ask answer about the whole page written before the rest was read is sent
// back once with the exact read that continues it, and an answer given again
// without reading on ends with a note that only part of the page was read.
// Short pages and questions about one part of a page are not affected.
// Real Agent batches and run loops with mocked browser APIs, both builds.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { installModelStub, withFixedChoiceAnswers } from './semantic-decision-stub.mjs';

const PAGE = 'https://docs.example.test/long-article';
const area = { get: async () => ({}), set: async () => {}, remove: async () => {} };
const api = {
  storage: { local: area, session: area, onChanged: { addListener() {} } },
  runtime: { getURL: value => `extension://test/${value}`, sendMessage: async () => ({}) },
  tabs: {
    get: async id => ({ id, url: PAGE, title: 'Long article', status: 'complete' }),
    sendMessage: async () => ({ ready: true }),
    executeScript: async () => [null],
  },
  webNavigation: { getAllFrames: async () => [{ frameId: 0, parentFrameId: -1, documentId: 'article-document', url: PAGE }] },
  scripting: { executeScript: async () => [{ result: null }] },
};
globalThis.chrome = api;
globalThis.browser = api;

const CAVEAT = 'WebBrain could not verify everything: ';
// The article's text: 40 sections, about 31,000 characters, so read_page
// returns it in several windows.
const ARTICLE = Array.from({ length: 40 }, (_, index) => `Section ${index + 1}. `
  + `Placeholder history of era ${index + 1}, with dates, places and outcomes kept short for the fixture. `.repeat(7)).join('\n\n');
// The visible-page tree a page observation reads, larger than a tool result.
const TREE = Array.from({ length: 220 }, (_, index) => `paragraph "Era ${index + 1}: placeholder text of the long article" [ref_${index + 10}]`).join('\n');
const SHORT_TREE = 'main [ref_1]\n heading "Short note" [ref_2]\n paragraph "One line of text." [ref_3]';
const SUMMARY = 'The article surveys every era from the first section to the last.';
let nextTab = 9700;
let nextCall = 1;

function readPageWindow(applyReadPageWindow, args = {}) {
  const flat = { ...(args.continuationArgs || {}), ...args };
  delete flat.continuationArgs;
  return applyReadPageWindow({ url: PAGE, title: 'Long article', text: ARTICLE, textSource: 'article',
    isArticlePage: true, includeChrome: flat.includeChrome === true }, flat);
}

// One tool batch the way the run loop executes it, for an Ask (or Act)
// agent whose page tools are stubbed. `decide` answers page_read_scope.
async function batchAgent(build, { mode = 'ask', task = 'Summarize this page.', strict = false, decide = () => 'whole_page',
  runOptions = {} } = {}) {
  const { Agent } = await import(`../src/${build}/src/agent/agent.js`);
  const { applyReadPageWindow } = await import(`../src/${build}/src/agent/read-page-window.js`);
  const tab = nextTab++;
  const provider = { model: 'test', supportsTools: true, supportsVision: false, promptTier: 'full', contextWindow: 32000,
    chat: async () => { throw new Error('Only fixed-choice questions reach the model here.'); } };
  const agent = new Agent({ getActive: () => provider, getProvider: () => provider, getVisionProvider: async () => null });
  agent.strictGuards = strict;
  agent.conversationIds.set(tab, `conv-${tab}`);
  agent.conversationModes.set(tab, mode);
  agent.conversations.set(tab, [{ role: 'system', content: 'sys' }, { role: 'user', content: task }]);
  Object.assign(agent, { _ensureGateSetting: async () => {}, _skipPermissionGate: true, _currentUrl: async () => PAGE,
    _persist: () => {}, _persistNow: async () => true });
  const questions = installModelStub(agent, { decide: (kind, question) => (kind === 'page_read_scope' ? decide(question) : null) });
  agent.executeTool = async (_tab, name, args) => {
    if (name === 'done') return { done: true, summary: args.summary, outcome: args.outcome };
    if (name === 'read_page') return readPageWindow(applyReadPageWindow, args);
    if (name === 'get_accessibility_tree') return { success: true, pageContent: TREE, truncated: false, hasMore: false };
    return { success: true };
  };
  await agent._beginReadCompleteness(tab, task, runOptions);
  const batch = async (calls, updates = []) => {
    const toolCalls = calls.map(([name, args]) => ({ id: `${name}_${nextCall++}`, function: { name, arguments: JSON.stringify(args) } }));
    const messages = agent.conversations.get(tab);
    messages.push({ role: 'assistant', content: null, tool_calls: toolCalls });
    const result = await agent._executeToolBatch(tab, toolCalls, messages, (type, data) => updates.push({ type, data }),
      provider, null, new Set(['done', 'read_page', 'get_accessibility_tree']), 1, {}, null);
    const results = toolCalls.map(call => messages.find(message => message.role === 'tool' && message.tool_call_id === call.id)?.content || '');
    return { ...result, results };
  };
  // A page observation the runtime attached (page-feedback.js), as the model
  // was shown it.
  const observe = page => agent._notePageObservationCoverage(tab, PAGE, page);
  const lastDone = updates => updates.filter(update => update.type === 'tool_result' && update.data.name === 'done').at(-1)?.data.result;
  return { agent, tab, batch, observe, questions, lastDone, Agent };
}

for (const build of ['chrome', 'firefox']) {
  const coverage = await import(`../src/${build}/src/agent/page-read-coverage.js`);
  const { Agent } = await import(`../src/${build}/src/agent/agent.js`);

  // ── A page cut to fit a tool result ────────────────────────────────────
  test(`${build}: page content cut to fit a tool result stays JSON and names the read for the whole page`, () => {
    // The G7 observation: a gated article's text before the gate, far
    // larger than the tool result.
    const gated = { pageGate: { type: 'subscription', blocking: true, surface: 'inline', label: 'Subscription required' },
      pageContent: ARTICLE, textSource: 'article (pre-gate)' };
    const tree = { success: true, pageContent: TREE, truncated: true, hasMore: true, page: 1, nextPage: 2,
      continuationArgs: { filter: 'visible', maxDepth: 15, maxChars: 12000, page: 2 }, totalChars: 41000,
      notice: 'Call again with the exact continuationArgs for the next slice.' };
    for (const result of [gated, tree]) {
      const serialized = Agent.prototype._limitToolResult(result);
      assert.ok(serialized.length <= 8000, `${build}: the result must fit`);
      assert.doesNotMatch(serialized, /\[\.\.\.result truncated\]/, `${build}: page content must not be chopped into broken JSON`);
      const shown = JSON.parse(serialized);
      assert.ok(shown.pageContent.endsWith(`\n${coverage.PAGE_CONTENT_TRUNCATED_MARKER}`), `${build}: the cut is marked`);
      assert.ok(result.pageContent.startsWith(shown.pageContent.slice(0, -coverage.PAGE_CONTENT_TRUNCATED_MARKER.length - 1)),
        `${build}: the shown content is the start of the page content`);
      assert.ok(shown.pageContent.length > 4000, `${build}: as much content as fits is kept`);
      assert.equal(shown.hasMore, true);
      assert.equal(shown.pageContentTruncated, true);
      assert.match(shown.notice, /To read the whole page, call read_page\(\{"includeChrome":false\}\) and repeat with each returned continuationArgs until hasMore is false\./);
      // The tree's own continuation would skip the text cut here.
      assert.equal(shown.continuationArgs, undefined);
      assert.equal(shown.nextPage, undefined);
    }
    assert.deepEqual(JSON.parse(Agent.prototype._limitToolResult(gated)).pageGate, gated.pageGate, `${build}: other fields are kept`);
    const small = { success: true, pageContent: SHORT_TREE, hasMore: false };
    assert.deepEqual(JSON.parse(Agent.prototype._limitToolResult(small)), small, `${build}: a page that fits is unchanged`);
  });

  test(`${build}: tree pages complete the page only when they join up from its start`, () => {
    const state = coverage.createPageReadCoverage({ url: PAGE });
    const slice = (page, chunkStart, chunkEnd, hasMore) => ({ pageContent: `slice ${page}`, page, chunkStart, chunkEnd,
      totalChars: 300, hasMore, truncated: hasMore, refScopeUrl: PAGE,
      continuationArgs: hasMore ? { filter: 'all', maxDepth: 15, maxChars: 100, page: page + 1 } : null });
    coverage.recordPageRead(state, 'get_accessibility_tree', {}, slice(1, 0, 99, true));
    assert.deepEqual(coverage.pageReadCoverageGap(state, PAGE).nextRead,
      { tool: 'get_accessibility_tree', args: { filter: 'all', maxDepth: 15, maxChars: 100, page: 2 } });
    // The last page alone, read out of order, leaves the middle unread.
    coverage.recordPageRead(state, 'get_accessibility_tree', { filter: 'all', maxChars: 100, page: 3 }, slice(3, 200, 300, false));
    assert.ok(coverage.pageReadCoverageGap(state, PAGE), `${build}: a skipped page is still unread`);
    // A subtree or a visible-only tree says nothing about the whole page.
    coverage.recordPageRead(state, 'get_accessibility_tree', { ref_id: 'ref_9', filter: 'all' }, slice(2, 100, 199, false));
    coverage.recordPageRead(state, 'get_accessibility_tree', { filter: 'visible', page: 2 }, slice(2, 100, 199, false));
    assert.ok(coverage.pageReadCoverageGap(state, PAGE));
    coverage.recordPageRead(state, 'get_accessibility_tree', { filter: 'all', maxDepth: 15, maxChars: 100, page: 2 }, slice(2, 100, 199, true));
    assert.equal(coverage.pageReadCoverageGap(state, PAGE), null, `${build}: every slice from the start was read`);
    // No read tool to continue with: nothing to send the answer back for.
    const unread = coverage.createPageReadCoverage({ url: PAGE });
    coverage.recordPageObservation(unread, PAGE, { pageContent: TREE });
    assert.equal(coverage.pageReadCoverageGap(unread, PAGE, { tools: new Set(['done']) }), null);
    assert.deepEqual(coverage.pageReadCoverageGap(unread, PAGE, { tools: new Set(['done', 'read_page']) }).nextRead,
      { tool: 'read_page', args: { includeChrome: false } });
  });

  // ── Done-time coverage in Ask mode ─────────────────────────────────────
  test(`${build}: a whole-page answer from a cut-off page is sent back once with the exact read that continues it`, async () => {
    for (const strict of [false, true]) {
      const h = await batchAgent(build, { strict });
      h.observe({ success: true, pageContent: TREE, truncated: false, hasMore: false });
      const updates = [];
      const first = await h.batch([['done', { summary: SUMMARY }]], updates);
      assert.equal(first.action, 'continue', `${build}: the answer is sent back`);
      const note = JSON.parse(first.results[0]);
      assert.equal(note.blockedDone, true);
      assert.match(note.error, /^\[WHOLE PAGE NOT READ: /);
      assert.ok(note.error.includes('Call read_page({"includeChrome":false}) now and repeat with each returned continuationArgs while hasMore is true'),
        `${build}: the note names the exact read: ${note.error}`);
      assert.ok(updates.some(update => update.type === 'warning' && /Whole-page answer sent back/.test(update.data.message)));
      assert.deepEqual(h.questions.map(question => [question.kind, question.request]), [['page_read_scope', 'Summarize this page.']]);
      const again = [];
      const second = await h.batch([['done', { summary: SUMMARY }]], again);
      assert.equal(h.questions.length, 1, `${build}: the request is read once per run`);
      if (strict) {
        assert.equal(second.action, 'continue', `${build}: Strict checks keep refusing`);
        continue;
      }
      assert.equal(second.action, 'return', `${build}: the answer given again is accepted`);
      assert.equal(second.value, `${SUMMARY}\n\n${CAVEAT}${coverage.PAGE_COVERAGE_CAVEAT}`);
      assert.equal(second.endStatus, 'partial', `${build}: an answer over an unread page ends as partial`);
      assert.equal(h.lastDone(again)?.outcome, 'partial');
    }
  });

  test(`${build}: a whole-page answer is accepted once the reads reach the end of the page`, async () => {
    const h = await batchAgent(build);
    h.observe({ success: true, pageContent: TREE, truncated: false, hasMore: false });
    assert.equal((await h.batch([['done', { summary: SUMMARY }]])).action, 'continue');
    let args = { includeChrome: false };
    let windows = 0;
    for (;;) {
      const read = await h.batch([['read_page', args]]);
      windows += 1;
      const shown = JSON.parse(h.agent._unwrapUntrusted(read.results[0]));
      if (!shown.hasMore) break;
      // Stopping here, the note would name exactly the window that follows.
      await h.agent._preparePageReadCoverage(h.tab, new Set(['done', 'read_page']));
      assert.ok(h.agent._readCompletenessBlock(h.tab).includes(`Call read_page(${JSON.stringify(shown.continuationArgs)}) now`),
        `${build}: the next read continues where window ${windows} ends`);
      args = shown.continuationArgs;
    }
    assert.ok(windows > 3, `${build}: the fixture page takes several windows (${windows})`);
    const updates = [];
    const done = await h.batch([['done', { summary: SUMMARY }]], updates);
    assert.equal(done.action, 'return');
    assert.equal(done.value, SUMMARY, `${build}: a page read to the end gets no caveat`);
    assert.notEqual(h.lastDone(updates)?.outcome, 'partial');
  });

  test(`${build}: a question about one part of a long page is answered without a coverage note`, async () => {
    const h = await batchAgent(build, { task: 'What does the first section say about era 1?', decide: () => 'part' });
    h.observe({ success: true, pageContent: TREE, truncated: true, hasMore: true, page: 1 });
    const answer = 'The first section covers era 1 with its dates, places and outcomes.';
    const done = await h.batch([['done', { summary: answer }]]);
    assert.equal(done.action, 'return');
    assert.equal(done.value, answer);
    assert.deepEqual(h.questions.map(question => question.kind), ['page_read_scope']);
  });

  test(`${build}: a short page, a page read in one window and an unsure reading leave the answer alone`, async () => {
    const short = await batchAgent(build);
    short.observe({ success: true, pageContent: SHORT_TREE, truncated: false, hasMore: false });
    assert.equal((await short.batch([['done', { summary: SUMMARY }]])).value, SUMMARY);
    assert.equal(short.questions.length, 0, `${build}: nothing was cut, so nothing is asked`);

    const read = await batchAgent(build);
    read.observe({ success: true, pageContent: TREE, truncated: false, hasMore: false });
    read.agent.executeTool = async (_tab, name, args) => (name === 'done' ? { done: true, summary: args.summary }
      : { url: PAGE, title: 'Short', text: 'All of it.', textSource: 'article', includeChrome: false, originalLength: 10,
        textOffset: 0, textLimit: 4000, returnedLength: 10, hasMore: false, continuationArgs: null, accessState: 'no_blocking_page_gate' });
    await read.batch([['read_page', { includeChrome: false }]]);
    assert.equal((await read.batch([['done', { summary: SUMMARY }]])).value, SUMMARY);
    assert.equal(read.questions.length, 0);

    const unsure = await batchAgent(build, { decide: () => null });
    unsure.observe({ success: true, pageContent: TREE, truncated: false, hasMore: false });
    assert.equal((await unsure.batch([['done', { summary: SUMMARY }]])).value, SUMMARY, `${build}: no sure reading, no note`);
  });

  test(`${build}: the Summarize this page action asks for the whole page without a reading`, async () => {
    const h = await batchAgent(build, { task: 'Summarize the page in 5-8 concise bullet points.',
      runOptions: { recommendedAction: { id: 'summarize-page', tool: 'read_page', args: { includeChrome: false } } } });
    await h.batch([['read_page', { includeChrome: false }]]);
    const first = await h.batch([['done', { summary: SUMMARY }]]);
    assert.equal(first.action, 'continue');
    assert.match(JSON.parse(first.results[0]).error, /Call read_page\(\{"offset":\d+,"limit":4000,"includeChrome":false\}\) now/);
    assert.equal(h.questions.length, 0);
  });

  test(`${build}: Act runs keep their own completion checks`, async () => {
    const h = await batchAgent(build, { mode: 'act', task: 'Summarize this page.' });
    h.observe({ success: true, pageContent: TREE, truncated: false, hasMore: false });
    const done = await h.batch([['done', { summary: SUMMARY, outcome: 'success' }]]);
    assert.doesNotMatch(String(done.results[0]), /WHOLE PAGE NOT READ/);
    assert.equal(h.questions.length, 0);
  });

  // ── The whole run, as in G7 ────────────────────────────────────────────
  // The page observation the runtime attaches before the first decision is
  // the start of the page, cut off; the model answers from it at once.
  for (const streaming of [false, true]) for (const answerWith of ['done', 'text']) for (const readsOn of [true, false]) {
    const outcome = readsOn ? 'reads to the end before it is accepted' : 'given again without reading ends with the caveat';
    test(`${build} ${streaming ? 'stream' : 'chat'}: an Ask summary (${answerWith}) of a long page ${outcome}`, async () => {
      const { applyReadPageWindow } = await import(`../src/${build}/src/agent/read-page-window.js`);
      const tab = nextTab++;
      const seen = [];
      let agent;
      const answer = summary => (answerWith === 'done'
        ? { toolCalls: [{ id: `answer-${seen.length}`, function: { name: 'done', arguments: JSON.stringify({ summary }) } }] }
        : { content: summary });
      let observed = null;
      const respond = messages => {
        const last = messages.at(-1);
        seen.push(last);
        if (seen.length === 1) {
          const observation = messages.find(message => String(message.content || '').startsWith('[BROWSER STATE UPDATE'));
          try {
            observed = JSON.parse(JSON.parse(agent._unwrapUntrusted(String(observation.content)
              .slice(observation.content.indexOf('\n') + 1))).page);
          } catch { observed = String(observation?.content || 'no observation'); }
          return answer('A summary of the opening sections.');
        }
        const text = agent._unwrapUntrusted(String(last.content));
        if (text.includes('WHOLE PAGE NOT READ')) {
          assert.equal(last.role, answerWith === 'done' ? 'tool' : 'user');
          if (!readsOn) return answer('A summary of the opening sections.');
          return { toolCalls: [{ id: 'read-1', function: { name: 'read_page', arguments: JSON.stringify({ includeChrome: false }) } }] };
        }
        assert.equal(last.role, 'tool');
        const shown = JSON.parse(text);
        if (shown.hasMore) {
          return { toolCalls: [{ id: `read-${seen.length}`, function: { name: 'read_page', arguments: JSON.stringify(shown.continuationArgs) } }] };
        }
        return answer(SUMMARY);
      };
      const chat = withFixedChoiceAnswers(async messages => respond(messages), { page_read_scope: 'whole_page' });
      const provider = { name: 'coverage test', model: 'test', promptTier: 'full', contextWindow: 32000, supportsTools: true,
        supportsVision: false,
        chat: async (messages, options) => (String(messages[0]?.content || '').startsWith('You classify whether one proposed terminal WebBrain Ask answer')
          ? { content: '{"pageIndependent":false}' } : chat(messages, options)),
        async *chatStream(messages) {
          const response = await respond(messages);
          if (response.content) yield { type: 'text', content: response.content };
          if (response.toolCalls) yield { type: 'tool_call', content: response.toolCalls.map((call, index) => ({ ...call, index })) };
          yield { type: 'done' };
        } };
      agent = new Agent({ getActive: () => provider, getProvider: () => provider, getVisionProvider: async () => null });
      Object.assign(agent, {
        _hydrate: async () => {}, _persist: () => {}, _persistNow: async () => ({ ok: true }), _persistSubmittedTurn: async () => {},
        _startTraceRun: async () => null, _endTraceRun: async () => {},
        _manageContext: async () => {}, _checkCostAllowance: async () => null, _recordCostUsage: async () => null,
        _currentUrl: async () => PAGE, _getTabUrlTitle: async () => ({ tabUrl: PAGE, tabTitle: 'Long article' }),
        _maybeEmitAskModeHandoff: async () => {}, _maybeReinjectAdapter: async () => {}, _ensureProgressSessionForCurrentTask: async () => {},
        _plannerMode: () => 'off',
        _runPlannerIntentGate: async () => ({ proceed: true, requestKind: 'execute', requiresStateChange: false, requiresSubmission: false }),
        _skipPermissionGate: true, _ensureGateSetting: async () => true, _shouldAutoScreenshot: () => false, _pageFeedbackIdleMs: 0,
        _completionDoneBlock: () => null,
      });
      // The page changes once as the run starts, as in G7, so the first
      // decision gets a page observation.
      const begin = agent._beginPageFeedbackRun.bind(agent);
      agent._beginPageFeedbackRun = async (tabId, ...rest) => {
        await begin(tabId, ...rest);
        const from = { tab: { id: tabId }, frameId: 0, documentId: 'article-document', url: PAGE };
        const state = agent.pageMonitorState(from, 'article-token');
        assert.equal(agent.observePageFeedback(from, { ...state, seq: 1, revision: 1, kind: 'dom', source: 'page', target: 'div' }).accepted, true);
      };
      const reads = [];
      agent.executeTool = async (_tab, name, args) => {
        if (name === 'get_accessibility_tree') return { success: true, pageContent: TREE, truncated: false, hasMore: false };
        if (name === 'read_page') { reads.push(args); return readPageWindow(applyReadPageWindow, args); }
        assert.equal(name, 'done');
        return { done: true, success: true, summary: args.summary };
      };
      const options = { detachedRequestId: `coverage-${tab}`, askStreamingEnabled: false };
      const result = streaming ? await agent.processMessageStream(tab, 'Summarize this page.', () => {}, 'ask', options)
        : await agent.processMessage(tab, 'Summarize this page.', () => {}, 'ask', [], options);
      if (!readsOn) {
        assert.equal(result, `A summary of the opening sections.\n\n${CAVEAT}${coverage.PAGE_COVERAGE_CAVEAT}`,
          `${build}: an answer given again without reading on says only part of the page was read`);
        assert.equal(reads.length, 0);
        return;
      }
      assert.equal(result, SUMMARY, `${build}: the summary is given after reading the whole page`);
      assert.ok(reads.length > 3, `${build}: the page was read to its end (${reads.length} windows)`);
      assert.deepEqual(reads[0], { includeChrome: false });
      // The observation the first answer was written from marks its cut and
      // names the read for the whole page.
      assert.equal(typeof observed, 'object', `${build}: the observation must stay JSON: ${String(observed).slice(-200)}`);
      assert.ok(observed.pageContent.endsWith(coverage.PAGE_CONTENT_TRUNCATED_MARKER), `${build}: the observation marks its cut`);
      assert.match(observed.notice, /call read_page\(\{"includeChrome":false\}\)/);
    });
  }
}

test('page-read-coverage.js is shared byte for byte by both builds', () => {
  const read = build => fs.readFileSync(new URL(`../src/${build}/src/agent/page-read-coverage.js`, import.meta.url), 'utf8');
  assert.equal(read('firefox'), read('chrome'));
});
