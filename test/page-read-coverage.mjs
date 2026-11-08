// Ask mode on a long page (QA case G7: "Summarize this page." on a very long
// article). The model was shown only the start of the page, cut off, and
// answered at once as if it had read all of it. A page cut to fit a tool
// result now stays JSON and names the read that covers the whole page; an
// Ask answer about the whole page written before the rest was read is sent
// back once with the exact read that continues it, and an answer given again
// without reading on ends with a note that only part of the page was read.
// Short pages, questions about one part of a page, selected text, and pages
// read through a reader of their own source (a video's transcript, a PDF) are
// not affected.
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
// The read the notes name for the whole page: read_page in its largest windows.
const WHOLE_PAGE_READ = '{"includeChrome":false,"limit":6000}';
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
  runOptions = {}, tools = ['done', 'read_page', 'get_accessibility_tree'], results = {} } = {}) {
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
    if (results[name]) return results[name](args);
    return { success: true };
  };
  await agent._beginReadCompleteness(tab, task, runOptions);
  const batch = async (calls, updates = []) => {
    const toolCalls = calls.map(([name, args]) => ({ id: `${name}_${nextCall++}`, function: { name, arguments: JSON.stringify(args) } }));
    const messages = agent.conversations.get(tab);
    messages.push({ role: 'assistant', content: null, tool_calls: toolCalls });
    const result = await agent._executeToolBatch(tab, toolCalls, messages, (type, data) => updates.push({ type, data }),
      provider, null, new Set(tools), 1, {}, null);
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
      assert.ok(shown.notice.endsWith(`To read the whole page, call read_page(${WHOLE_PAGE_READ}) and repeat with each returned continuationArgs until hasMore is false.`),
        shown.notice);
      // The tree's own continuation would skip the text cut here.
      assert.equal(shown.continuationArgs, undefined);
      assert.equal(shown.nextPage, undefined);
      // The slice now ends before its old end.
      assert.equal(shown.chunkEnd, undefined);
    }
    assert.equal(JSON.parse(Agent.prototype._limitToolResult(tree)).chunkStart, tree.chunkStart, `${build}: where the slice starts is kept`);
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
      { tool: 'read_page', args: { includeChrome: false, limit: 6000 } });
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
      assert.ok(note.error.includes(`Call read_page(${WHOLE_PAGE_READ}) now and repeat with each returned continuationArgs while hasMore is true`),
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
      // Stopping here, the note would name the window that follows, in the
      // largest windows read_page returns.
      await h.agent._preparePageReadCoverage(h.tab, new Set(['done', 'read_page']));
      assert.ok(h.agent._readCompletenessBlock(h.tab).includes(`Call read_page(${JSON.stringify({ ...shown.continuationArgs, limit: 6000 })}) now`),
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
    assert.match(JSON.parse(first.results[0]).error, /Call read_page\(\{"offset":\d+,"limit":6000,"includeChrome":false\}\) now/);
    assert.equal(h.questions.length, 0);
  });

  test(`${build}: Act runs keep their own completion checks`, async () => {
    const h = await batchAgent(build, { mode: 'act', task: 'Summarize this page.' });
    h.observe({ success: true, pageContent: TREE, truncated: false, hasMore: false });
    const done = await h.batch([['done', { summary: SUMMARY, outcome: 'success' }]]);
    assert.doesNotMatch(String(done.results[0]), /WHOLE PAGE NOT READ/);
    assert.equal(h.questions.length, 0);
  });

  test(`${build}: calls after a sent-back answer are skipped with the page's own reason`, async () => {
    const h = await batchAgent(build);
    h.observe({ success: true, pageContent: TREE, truncated: true, hasMore: true, page: 1 });
    const sent = await h.batch([['done', { summary: SUMMARY }], ['read_page', { includeChrome: false }]]);
    assert.equal(sent.action, 'continue');
    assert.equal(JSON.parse(sent.results[1]).error, 'skipped: read the rest of the page before answering');
  });

  // ── Content read from the page's own source ────────────────────────────
  // A video page's tree is long, so its observation is cut off; the video's
  // content is its transcript, not the page text around it.
  const TRANSCRIPT = { success: true, data: { text: 'The whole transcript of the video, from its start to its end.', has_more_text: false } };
  const VIDEO_SUMMARY = 'The video explains its topic from the first minute to the last.';
  test(`${build}: a video summary written from its transcript is accepted without reading the page around it`, async () => {
    const tools = ['done', 'read_page', 'get_accessibility_tree', 'read_youtube_transcript'];
    const h = await batchAgent(build, { task: 'Summarize this video.', tools, results: { read_youtube_transcript: () => TRANSCRIPT } });
    h.observe({ success: true, pageContent: TREE, truncated: true, hasMore: true, page: 1 });
    await h.batch([['read_youtube_transcript', {}]]);
    const updates = [];
    const done = await h.batch([['done', { summary: VIDEO_SUMMARY }]], updates);
    assert.equal(done.action, 'return', `${build}: the answer is not sent back`);
    assert.equal(done.value, VIDEO_SUMMARY, `${build}: and it gets no caveat`);
    assert.notEqual(h.lastDone(updates)?.outcome, 'partial');
    assert.equal(h.questions.length, 0, `${build}: nothing is asked about the request`);

    // A transcript that could not be read is no reading of the video.
    const failed = await batchAgent(build, { task: 'Summarize this page.', tools,
      results: { read_youtube_transcript: () => ({ success: false, error: 'No transcript is available for this video.' }) } });
    failed.observe({ success: true, pageContent: TREE, truncated: true, hasMore: true, page: 1 });
    await failed.batch([['read_youtube_transcript', {}]]);
    assert.equal((await failed.batch([['done', { summary: SUMMARY }]])).action, 'continue');

    // The Summarize video action reads the transcript first by construction.
    const action = await batchAgent(build, { task: 'Summarize this video.', tools, decide: () => 'whole_page',
      runOptions: { recommendedAction: { id: 'summarize-youtube-video', tool: 'read_youtube_transcript' } } });
    action.observe({ success: true, pageContent: TREE, truncated: true, hasMore: true, page: 1 });
    const answered = await action.batch([['done', { summary: VIDEO_SUMMARY }]]);
    assert.equal(answered.value, VIDEO_SUMMARY);
    assert.equal(action.questions.length, 0, `${build}: the action's request is not asked about`);
  });

  test(`${build}: page-source readers of the open page leave its text coverage unchecked`, () => {
    const cases = [
      ['read_pdf', {}, { success: true, pages: ['First page of the document.'], hasExtractableText: true }, true],
      ['read_pdf', { url: 'https://docs.example.test/other.pdf' }, { success: true, pages: ['Another document.'] }, false],
      ['read_pdf', {}, { success: true, pages: [''], hasExtractableText: false }, false],
      ['iframe_read', {}, { success: true, pageUrl: PAGE, frameCount: 1, frames: [{ ok: true, url: 'https://embed.example.test/doc', text: 'The framed document.' }] }, true],
      ['iframe_read', { selector: 'input, textarea' }, { success: true, frames: [{ ok: true, text: 'A form field.' }] }, false],
      ['fetch_url', { url: `${PAGE}#history` }, { success: true, url: `${PAGE}#history`, text: 'The page text as served.', hasMore: true }, true],
      ['fetch_url', { url: 'https://other.example.test/' }, { success: true, text: 'Another page.' }, false],
      ['read_youtube_transcript', {}, { success: true, data: { text: '', segments: [{ start: 0, text: 'Opening line.' }] } }, true],
      ['read_youtube_transcript', {}, { success: true, data: { text: '  ' } }, false],
      ['read_youtube_transcript', {}, { success: false, error: 'No transcript.' }, false],
      // A table, a heading list: parts of the page, as an article's tables are.
      ['extract_data', { type: 'tables' }, [{ caption: 'Eras', rows: [['1', 'First era']] }], false],
    ];
    for (const [tool, args, result, covers] of cases) {
      const state = coverage.createPageReadCoverage({ url: PAGE });
      coverage.recordPageObservation(state, PAGE, { pageContent: TREE, hasMore: true });
      coverage.recordPageRead(state, tool, args, result, 8000, { pageUrl: PAGE });
      assert.equal(coverage.pageReadCoverageGap(state, PAGE) === null, covers, `${build}: ${tool}(${JSON.stringify(args)})`);
    }
  });

  // Codex review of PR #600: a transcript read for another video, by the
  // tool's url argument, is no reading of the open page.
  test(`${build}: a transcript of another video leaves the open page's coverage checked`, async () => {
    const VIDEO = 'https://www.youtube.com/watch?v=AAAAAAAAAAA';
    const OTHER = 'https://www.youtube.com/watch?v=BBBBBBBBBBB';
    const transcript = data => ({ success: true, data: { text: 'The whole transcript of a video.', has_more_text: false, ...data } });
    const cases = [
      // The open video, however its address is written.
      [VIDEO, {}, transcript(), true],
      [VIDEO, { url: 'https://youtu.be/AAAAAAAAAAA?t=30' }, transcript(), true],
      [VIDEO, { url: `${VIDEO}&t=30s` }, transcript({ video_id: 'AAAAAAAAAAA' }), true],
      [VIDEO, { url: 'https://www.youtube.com/shorts/AAAAAAAAAAA' }, transcript(), true],
      // Another video, named by url or by the provider.
      [VIDEO, { url: OTHER }, transcript(), false],
      [VIDEO, { url: 'https://youtu.be/BBBBBBBBBBB' }, transcript({ video_id: 'BBBBBBBBBBB' }), false],
      [VIDEO, {}, transcript({ video_id: 'BBBBBBBBBBB' }), false],
      [VIDEO, { url: VIDEO }, transcript({ video_id: 'BBBBBBBBBBB' }), false],
      // An article that is no video: a video named by url is another page.
      [PAGE, { url: OTHER }, transcript(), false],
      [PAGE, {}, transcript({ video_id: 'BBBBBBBBBBB' }), false],
    ];
    for (const [page, args, result, covers] of cases) {
      const state = coverage.createPageReadCoverage({ url: page });
      coverage.recordPageObservation(state, page, { pageContent: TREE, hasMore: true });
      coverage.recordPageRead(state, 'read_youtube_transcript', args, result, 8000, { pageUrl: page });
      assert.equal(coverage.pageReadCoverageGap(state, page) === null, covers,
        `${build}: on ${page}, read_youtube_transcript(${JSON.stringify(args)}) -> ${JSON.stringify(result.data)}`);
    }

    // The run: an Ask summary of the open article after a transcript of
    // another video is still sent back to read the article.
    const tools = ['done', 'read_page', 'get_accessibility_tree', 'read_youtube_transcript'];
    const h = await batchAgent(build, { tools, results: { read_youtube_transcript: () => transcript() } });
    h.observe({ success: true, pageContent: TREE, truncated: true, hasMore: true, page: 1 });
    await h.batch([['read_youtube_transcript', { url: OTHER }]]);
    const sent = await h.batch([['done', { summary: SUMMARY }]]);
    assert.equal(sent.action, 'continue', `${build}: the open page was not read`);
    assert.ok(JSON.parse(sent.results[0]).error.includes(`Call read_page(${WHOLE_PAGE_READ}) now`));
  });

  // Codex review of PR #600: a full-depth tree whose walk left out deeper
  // content (depthTruncated, accessibility-tree.js) did not read the whole
  // page, however far its slices reach.
  test(`${build}: a depth-truncated tree does not complete the page`, async () => {
    const one = coverage.createPageReadCoverage({ url: PAGE });
    coverage.recordPageObservation(one, PAGE, { pageContent: TREE, hasMore: true });
    coverage.recordPageRead(one, 'get_accessibility_tree', { filter: 'all', maxDepth: 15 },
      { success: true, pageContent: SHORT_TREE, truncated: false, hasMore: false, depthTruncated: true, refScopeUrl: PAGE });
    assert.deepEqual(coverage.pageReadCoverageGap(one, PAGE)?.nextRead, { tool: 'read_page', args: { includeChrome: false, limit: 6000 } },
      `${build}: one depth-truncated tree result`);

    const paged = coverage.createPageReadCoverage({ url: PAGE });
    coverage.recordPageObservation(paged, PAGE, { pageContent: TREE, hasMore: true });
    const slice = (page, chunkStart, chunkEnd, hasMore) => ({ pageContent: `slice ${page}`, page, chunkStart, chunkEnd,
      totalChars: 200, hasMore, truncated: hasMore, refScopeUrl: PAGE, depthTruncated: true,
      continuationArgs: hasMore ? { filter: 'all', maxDepth: 20, maxChars: 100, page: page + 1 } : null });
    coverage.recordPageRead(paged, 'get_accessibility_tree', { filter: 'all', maxDepth: 20, maxChars: 100 }, slice(1, 0, 99, true));
    // Following that tree's own pages cannot reach the content it left out.
    assert.deepEqual(coverage.pageReadCoverageGap(paged, PAGE)?.nextRead, { tool: 'read_page', args: { includeChrome: false, limit: 6000 } },
      `${build}: the next read is not the depth-truncated tree's next page`);
    coverage.recordPageRead(paged, 'get_accessibility_tree', { filter: 'all', maxDepth: 20, maxChars: 100, page: 2 }, slice(2, 100, 200, false));
    assert.ok(coverage.pageReadCoverageGap(paged, PAGE), `${build}: every slice of a depth-truncated tree`);

    // The run: the answer after a depth-truncated full tree is sent back.
    const h = await batchAgent(build);
    h.agent.executeTool = async (_tab, name, args) => (name === 'done' ? { done: true, summary: args.summary }
      : { success: true, pageContent: SHORT_TREE, truncated: false, hasMore: false, depthTruncated: true });
    h.observe({ success: true, pageContent: TREE, truncated: true, hasMore: true, page: 1 });
    await h.batch([['get_accessibility_tree', { filter: 'all', maxDepth: 15 }]]);
    const sent = await h.batch([['done', { summary: SUMMARY }]]);
    assert.equal(sent.action, 'continue', `${build}: the tree left out part of the page`);
    assert.ok(JSON.parse(sent.results[0]).error.includes(`Call read_page(${WHOLE_PAGE_READ}) now`));
  });

  test(`${build}: a request about selected text is not checked against the page`, async () => {
    const h = await batchAgent(build, { task: 'Summarize the selected text.', runOptions: { sourceGrounding: 'selection_only' } });
    h.observe({ success: true, pageContent: TREE, truncated: true, hasMore: true, page: 1 });
    const answer = 'The selected passage describes one era.';
    assert.equal((await h.batch([['done', { summary: answer }]])).value, answer);
    assert.equal(h.questions.length, 0);
  });

  test(`${build}: a cut subtree names a smaller read of the same element`, () => {
    const subtree = { success: true, pageContent: TREE, truncated: false, hasMore: false, refScopeUrl: PAGE };
    for (const [result, args] of [[subtree, { ref_id: 'ref_7', filter: 'all' }],
      [{ ...subtree, hasMore: true, continuationArgs: { ref_id: 'ref_7', filter: 'all', maxDepth: 15, maxChars: 12000, page: 2 } }, null]]) {
      const shown = JSON.parse(Agent.prototype._limitToolResult(result, 8000, { args }));
      assert.ok(shown.pageContent.endsWith(coverage.PAGE_CONTENT_TRUNCATED_MARKER));
      assert.match(shown.notice, /of this part of the page fit in the result\. To read the rest of it, call get_accessibility_tree again with ref_id "ref_7" and a smaller maxChars/);
      assert.doesNotMatch(shown.notice, /read_page/, `${build}: read_page reads the whole page, not this element`);
      assert.equal(shown.continuationArgs, undefined);
    }
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
          // The model makes the read the note names.
          const note = last.role === 'tool' ? JSON.parse(text).error : text;
          const named = note.match(/Call read_page\((\{[^\n]*?\})\) now/);
          assert.ok(named, note);
          return { toolCalls: [{ id: 'read-1', function: { name: 'read_page', arguments: named[1] } }] };
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
      assert.deepEqual(reads[0], { includeChrome: false, limit: 6000 });
      // The observation the first answer was written from marks its cut and
      // names the read for the whole page.
      assert.equal(typeof observed, 'object', `${build}: the observation must stay JSON: ${String(observed).slice(-200)}`);
      assert.ok(observed.pageContent.endsWith(coverage.PAGE_CONTENT_TRUNCATED_MARKER), `${build}: the observation marks its cut`);
      assert.ok(observed.notice.includes(`call read_page(${WHOLE_PAGE_READ})`), observed.notice);
    });
  }
}

test('page-read-coverage.js is shared byte for byte by both builds', () => {
  const read = build => fs.readFileSync(new URL(`../src/${build}/src/agent/page-read-coverage.js`, import.meta.url), 'utf8');
  assert.equal(read('firefox'), read('chrome'));
});
