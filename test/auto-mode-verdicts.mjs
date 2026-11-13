// Auto mode's `run_mode` verdicts: how a reply to the page-free question is
// read, and what the trace keeps of it (src/*/src/agent/semantic-decisions.js,
// auto-mode.js, agent.js and trace/privacy.js).
//
// Live QA case A7 (2026-11-13): in Auto mode the Turkish request "Bu sayfadaki
// bültene kaydol." ("Sign up for the newsletter on this page.") started in
// Ask, the model handed it to Act, and WebBrain refused with not_action. The
// trace said nothing about the run_mode answer behind the refusal. Replayed
// against the same model (claude-sonnet-5-5-high through WebBrain Companion,
// temperature 0, 400 output tokens), the active model answered "act" with an
// exact quote, but wrote a translation of the request before the JSON, and
// the strict JSON reader dropped the whole reply. English, German, Spanish,
// French, Japanese, Chinese and Arabic got bare JSON. TR_REPLY is that reply,
// word for word.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const pageUrl = 'http://newsletter.invalid/newsletter-prefilled';
const area = { get: async () => ({}), set: async () => {}, remove: async () => {} };
globalThis.chrome = globalThis.browser = {
  storage: { local: area, session: area },
  runtime: { getURL: path => path, sendMessage: async () => ({}), getManifest: () => ({ version: 'test' }) },
  tabs: { get: async id => ({ id, url: pageUrl, title: 'Newsletter fixture' }), sendMessage: async () => ({ ready: true }) },
  webNavigation: { getAllFrames: async () => [{ frameId: 0, documentId: 'main-document', url: pageUrl }] },
  scripting: { executeScript: async () => [{ result: null }] },
};

const BUILDS = ['chrome', 'firefox'];
const source = (build, file) => readFileSync(new URL(`../src/${build}/src/${file}`, import.meta.url), 'utf8');

const TR_REQUEST = 'Bu sayfadaki bültene kaydol.';
const TR_REPLY = 'The request is in Turkish: "Bu sayfadaki bültene kaydol" means "Sign up for the newsletter on this page." '
  + 'Signing up means typing into a form and submitting it, which changes account state, so the agent has to operate the '
  + 'browser.\n\n{"choice":"act","evidence":"Bu sayfadaki bültene kaydol."}';
const json = (choice, evidence) => JSON.stringify({ choice, evidence });
// The same reply shape for other languages: an explanation, then the answer.
const explained = (language, request, meaning, choice) => `The request is in ${language}: "${request}" means "${meaning}"\n\n${json(choice, request)}`;

// Plain imperatives and read-only questions, as the replay answered them.
const LANGUAGE_CASES = [
  ['Turkish', TR_REQUEST, 'Sign up for the newsletter on this page.', 'act'],
  ['German', 'Melde mich für den Newsletter auf dieser Seite an.', 'Sign me up for the newsletter on this page.', 'act'],
  ['Spanish', 'Suscríbeme al boletín de esta página.', 'Subscribe me to this page\'s newsletter.', 'act'],
  ['French', 'Inscris-moi à la newsletter sur cette page.', 'Sign me up for the newsletter on this page.', 'act'],
  ['Japanese', 'このページのニュースレターに登録して。', 'Sign up for this page\'s newsletter.', 'act'],
  ['Arabic', 'اشترك في النشرة الإخبارية في هذه الصفحة.', 'Subscribe to the newsletter on this page.', 'act'],
  ['Turkish', 'Bu sayfadaki bülten ne hakkında?', 'What is the newsletter on this page about?', 'answer'],
  ['German', 'Worum geht es in dem Newsletter auf dieser Seite?', 'What is the newsletter on this page about?', 'answer'],
  ['Japanese', 'このページのニュースレターは何について？', 'What is this page\'s newsletter about?', 'answer'],
];

// Words of a request, for checking that a trace excerpt keeps none of them.
const requestWords = text => (text.normalize('NFC').toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) || []);

test('the run_mode verdict note and its privacy projection are identical across browsers', () => {
  assert.equal(source('chrome', 'trace/privacy.js'), source('firefox', 'trace/privacy.js'));
  assert.equal(source('chrome', 'agent/semantic-decisions.js'), source('firefox', 'agent/semantic-decisions.js'));
  assert.equal(source('chrome', 'agent/auto-mode.js'), source('firefox', 'agent/auto-mode.js'));
});

for (const build of BUILDS) {
  const semantic = await import(`../src/${build}/src/agent/semantic-decisions.js`);
  const autoMode = await import(`../src/${build}/src/agent/auto-mode.js`);
  const { projectTraceEventData } = await import(`../src/${build}/src/trace/privacy.js`);
  const { readSemanticReply, semanticReplyExcerpt, semanticDecisionMessages, semanticBatchDecisionMessages, acceptSemanticAnswer } = semantic;

  test(`${build}: A7's reply, a translation before the JSON, is read as its one answer`, () => {
    const read = readSemanticReply(TR_REPLY);
    assert.deepEqual(read, { answer: { choice: 'act', evidence: TR_REQUEST }, format: 'prose_wrapped' });
    assert.deepEqual(acceptSemanticAnswer('run_mode', read.answer, TR_REQUEST), { choice: 'act', evidence: TR_REQUEST });
    assert.equal(autoMode.autoModeForChoice(read.answer.choice), 'act');
    // A bare or fenced object is the usual form.
    assert.deepEqual(readSemanticReply(json('answer', '')), { answer: { choice: 'answer', evidence: '' }, format: 'json' });
    assert.deepEqual(readSemanticReply('```json\n{"choice":"act","evidence":"x"}\n```'), { answer: { choice: 'act', evidence: 'x' }, format: 'json' });
    // Braces and quotation marks inside the JSON strings do not split it.
    assert.deepEqual(readSemanticReply('Answer: {"choice":"act","evidence":"a } \\"b\\" {"}'),
      { answer: { choice: 'act', evidence: 'a } "b" {' }, format: 'prose_wrapped' });
  });

  test(`${build}: a reply with no answer, two answers or a repeated field still has none`, () => {
    const malformed = { failure: 'malformed_or_multiple_json_objects' };
    assert.deepEqual(readSemanticReply(`${json('answer', '')} ${json('act', TR_REQUEST)}`), malformed, 'a second verdict is never dropped');
    assert.deepEqual(readSemanticReply(`I read it as {act}. ${json('act', TR_REQUEST)}`), malformed, 'a brace in the prose is a second object');
    assert.deepEqual(readSemanticReply('It asks to sign up, so: act.'), malformed);
    assert.deepEqual(readSemanticReply('{"choice":"act"'), malformed);
    assert.deepEqual(readSemanticReply('} {"choice":"act"}'), malformed);
    assert.deepEqual(readSemanticReply('{"choice":"answer","choice":"act"}'), { failure: 'duplicate_extra_field' });
    assert.deepEqual(readSemanticReply('Here: {"choice":"answer","choice":"act"}'), { failure: 'duplicate_extra_field' });
    assert.deepEqual(readSemanticReply('[{"choice":"act"}, {"choice":"answer"}]'), { failure: 'response_not_object' });
    assert.deepEqual(readSemanticReply('Both: [{"choice":"act"}, {"choice":"answer"}]'), malformed);
    assert.deepEqual(readSemanticReply('[1]'), { failure: 'response_not_object' });
    assert.deepEqual(readSemanticReply(''), { failure: 'empty_response' });
    assert.deepEqual(readSemanticReply(null), { failure: 'empty_response' });
  });

  test(`${build}: a fixed-choice question asks for the JSON alone and an untranslated quote`, () => {
    const wrap = text => text;
    const single = semanticDecisionMessages('run_mode', TR_REQUEST, { previous_mode: 'none', current_task: '' }, wrap)[0].content;
    assert.match(single, /Return exactly \{"choice":string,"evidence":string\} and nothing else, whatever language the request or data are in: no explanation, translation, reasoning or Markdown before or after it\./);
    assert.match(single, /exact quotation from `request` in its own language, never translated/);
    const batch = semanticBatchDecisionMessages('control_effect', 'Delete it.', [{ text: 'Sil' }], wrap)[0].content;
    assert.match(batch, /Return exactly \{"answers":\[\{"item":number,"choice":string,"evidence":string\}\]\} and nothing else, whatever language/);
    assert.match(batch, /exact quotation from that item, in its own language and never translated/);
    assert.equal(semantic.SEMANTIC_DECISION_VERSION, 5, 'answers to the old wording are not reused');
  });

  test(`${build}: a trace excerpt keeps a reply's shape and none of the user's words`, () => {
    const excerpt = semanticReplyExcerpt(TR_REPLY, TR_REQUEST, 'run_mode');
    assert.ok(excerpt.length <= 160);
    assert.match(excerpt, /^The request is in Turkish: "…" means "…" Signing up means typing into a form/);
    for (const word of [...requestWords(TR_REQUEST), 'newsletter']) assert.doesNotMatch(excerpt.toLowerCase(), new RegExp(word), word);
    // The JSON keeps its field names and the choice, never the quote.
    assert.equal(semanticReplyExcerpt(json('act', TR_REQUEST), TR_REQUEST, 'run_mode'), '{"choice":"act","evidence":"…"}');
    assert.equal(semanticReplyExcerpt('{"choice":"act","evidence":"say \\"kaydol\\" now"}', TR_REQUEST, 'run_mode'),
      '{"choice":"act","evidence":"…"}');
    // Unquoted words of the request, other quotation marks and a cut-off quote.
    assert.equal(semanticReplyExcerpt('Bültene kaydol asks to subscribe. {"choice":"act"}', TR_REQUEST, 'run_mode'),
      '… … asks to subscribe. {"choice":"act"}');
    assert.equal(semanticReplyExcerpt('„Bu sayfadaki“ heißt «subscribe» und 「登録」.', TR_REQUEST, 'run_mode'), '„…“ heißt «…» und 「…」.');
    assert.equal(semanticReplyExcerpt('It says "Bu sayfadaki bültene', TR_REQUEST, 'run_mode'), 'It says "…');
    assert.equal(semanticReplyExcerpt('x'.repeat(400), '', 'run_mode').length, 160);
  });

  test(`${build}: a metadata trace keeps a run_mode verdict's codes, and only a content trace its excerpt`, () => {
    const extra = {
      purpose: 'escalation', choice: null, plan: 'direct', source: 'unavailable', decisionModel: 'off', mainModel: 'rejected',
      model: 'claude-sonnet-5-5-high', failure: 'malformed_or_multiple_json_objects', rawChars: 270, latencyMs: 1623,
      excerpt: 'The request is in Turkish: "…" means "…"', requested: 'act', outcome: 'not_action',
      evidence: TR_REQUEST, request: TR_REQUEST, quote: TR_REQUEST,
    };
    const { excerpt, evidence, request, quote, ...codes } = extra;
    assert.deepEqual(projectTraceEventData('note', { step: 1, note: 'run_mode_decision', extra }),
      { step: 1, note: 'run_mode_decision', extra: codes });
    assert.deepEqual(projectTraceEventData('note', { step: 1, note: 'run_mode_decision', extra }, { includeContent: true }),
      { step: 1, note: 'run_mode_decision', extra: { ...codes, excerpt } });
    // Anything outside the closed lists, a path-like model id or a long
    // excerpt does not survive either tier.
    const unsafe = projectTraceEventData('note', { step: 2, note: 'run_mode_decision', extra: {
      purpose: 'other', choice: TR_REQUEST, source: 'page', failure: TR_REQUEST, decisionModelFailure: 'boom', model: 'C:/Users/someone/model.gguf',
      rawChars: -1, latencyMs: Infinity, decisionModelConfidence: 0.91, decisionModelChoice: 'answer', excerpt: 'y'.repeat(400) } }, { includeContent: true });
    assert.deepEqual(unsafe, { step: 2, note: 'run_mode_decision', extra: { decisionModelChoice: 'answer', decisionModelConfidence: 0.91, excerpt: 'y'.repeat(160) } });
  });
}

// An agent whose active model answers the page-free run_mode question with
// `semanticReply(request)` and the routed turn with `replies`, in order.
function fixture(Agent, { semanticReply = () => '', replies = [], decisionModel = null } = {}) {
  const tab = nextTab++;
  const replyQueue = [...replies];
  const calls = [], semanticCalls = [], updates = [], notes = [], routes = [];
  const provider = {
    name: 'Auto mode provider', model: 'claude-sonnet-5-5-high', promptTier: 'full', contextWindow: 128000,
    supportsTools: true, supportsVision: false,
    async chat(messages, options = {}) {
      if (String(messages[0]?.content).startsWith('Answer one fixed-choice question')) {
        const request = JSON.parse(messages[1].content).request;
        semanticCalls.push({ request, system: messages[0].content, maxTokens: options.maxTokens, temperature: options.temperature });
        const reply = semanticReply(request);
        if (reply instanceof Error) throw reply;
        return typeof reply === 'string' ? { content: reply } : reply;
      }
      calls.push({ tools: (options.tools || []).map(tool => tool.function.name) });
      const reply = replyQueue.shift();
      assert.ok(reply, 'unexpected model call');
      return typeof reply === 'function' ? reply(messages, options) : reply;
    },
  };
  const agent = new Agent({ getActive: () => provider, getProvider: () => provider, getVisionProvider: async () => null });
  for (const method of ['_hydrate', '_persistNow', '_persistSubmittedTurn', '_endTraceRun', '_beginReadCompleteness', '_manageContext',
    '_checkCostAllowance', '_recordCostUsage', '_maybeEmitAskModeHandoff', '_maybeReinjectAdapter',
    '_ensureProgressSessionForCurrentTask', '_restoreJournaledSteering']) agent[method] = async () => null;
  agent._persist = () => {};
  agent._plannerMode = () => 'off';
  // The settings of A7's run: lean mode on, no decision model.
  agent.leanMode = 'on';
  agent._jevSettings = async () => decisionModel?.settings || null;
  if (decisionModel) agent.evaluateSystemOne = async () => decisionModel.verdict;
  agent._startTraceRun = async (_tab, _message, _mode, _provider, _info, runOptions) => {
    routes.push(runOptions?.modeRoute || null);
    return `run-${tab}`;
  };
  agent._traceRunModeDecision = (runId, step, decision) => { if (runId && decision) notes.push({ runId, step, decision }); };
  agent._maybeRunPlannerGate = async (_tab, messages, enriched) => {
    messages.push(enriched);
    return { proceed: true, requestKind: 'execute', requiresStateChange: false };
  };
  agent._currentUrl = async () => pageUrl;
  agent._getTabUrlTitle = async () => ({ tabUrl: pageUrl, tabTitle: 'Newsletter fixture' });
  agent._shouldAutoScreenshot = () => false;
  agent._interactiveAskStreamingDecision = () => ({ eligible: false, reason: 'test' });
  agent.maxSteps = 6;
  agent._enrichUserMessageWithCurrentPage = async (tabId, _messages, content) => ({
    role: 'user',
    content: `[Trusted runtime context]\nAuthoritative execution state: runtime_mode=${agent._effectiveRunMode(tabId)}. Test.\n[/Trusted runtime context]\n\n${content}`,
    webbrainUserAuthoredText: content,
  });
  agent.executeTool = async (_tab, name, args) => (name === 'done'
    ? { done: true, success: true, outcome: 'success', summary: args.summary }
    : { success: true, pageContent: 'form "QA Weekly newsletter" [ref_1]', url: pageUrl });
  const run = text => agent.processMessage(tab, text, (type, data) => updates.push({ type, data }), 'auto', [],
    { detachedRequestId: `verdicts-${tab}` });
  return { agent, provider, tab, calls, semanticCalls, updates, notes, routes, run };
}
let nextTab = 7100;
const done = summary => ({ toolCalls: [{ id: `done-${summary.length}`, function: { name: 'done', arguments: JSON.stringify({ summary }) } }] });
const handoff = (mode, evidence) => ({ toolCalls: [{ id: 'handoff', function: { name: 'request_action_mode', arguments: JSON.stringify({ mode, evidence }) } }] });
const runModes = updates => updates.filter(update => update.type === 'run_mode').map(update => update.data);

for (const build of BUILDS) {
  const { Agent } = await import(`../src/${build}/src/agent/agent.js`);
  const { autoModeForChoice } = await import(`../src/${build}/src/agent/auto-mode.js`);
  const question = request => ({ request, page: { previous_mode: 'none', current_task: '' } });

  test(`${build}: live QA case A7 hands the Turkish request to Act and traces the verdict`, async () => {
    const f = fixture(Agent, { semanticReply: () => TR_REPLY, replies: [handoff('act', TR_REQUEST)] });
    assert.equal(await f.run(TR_REQUEST), '');
    assert.deepEqual(runModes(f.updates), [{ mode: 'ask', source: 'ask_first' }]);
    assert.deepEqual(f.agent.takeModeEscalation(f.tab), { mode: 'act', evidence: TR_REQUEST });
    assert.equal(f.semanticCalls.length, 1, 'the route asks the decision model only; the check asks the active model once');
    assert.deepEqual([f.semanticCalls[0].request, f.semanticCalls[0].temperature, f.semanticCalls[0].maxTokens], [TR_REQUEST, 0, 400]);
    // The route's verdict goes with mode_route and becomes its own note.
    assert.deepEqual(f.routes[0].decision, { purpose: 'route', choice: null, decisionModel: 'off', mainModel: 'not_asked',
      source: 'unavailable', latencyMs: f.routes[0].decision.latencyMs });
    // The hand-off check's verdict: which model gave it, in what form.
    assert.equal(f.notes.length, 1);
    const { runId, decision } = f.notes[0];
    assert.equal(runId, `run-${f.tab}`);
    const { excerpt, latencyMs, rawChars, ...codes } = decision;
    assert.deepEqual(codes, { purpose: 'escalation', choice: 'act', decisionModel: 'off', model: 'claude-sonnet-5-5-high',
      mainModel: 'answered', format: 'prose_wrapped', source: 'main_model', requested: 'act', outcome: 'accepted' });
    assert.equal(rawChars, TR_REPLY.length);
    assert.ok(Number.isFinite(latencyMs) && latencyMs >= 0);
    for (const word of requestWords(TR_REQUEST)) assert.doesNotMatch(excerpt.toLowerCase(), new RegExp(word), word);
    assert.equal(JSON.stringify(decision).includes(TR_REQUEST), false, 'the trace never keeps the quote');
  });

  test(`${build}: a refused hand-off traces the page-free verdict and why it did not count`, async () => {
    // Two answers in one reply: WebBrain cannot tell which one the model meant.
    const twice = fixture(Agent, {
      semanticReply: request => `${json('answer', '')}\n${json('act', request)}`,
      replies: [handoff('act', TR_REQUEST), done('Kaydı yapamadım.')],
    });
    assert.equal(await twice.run(TR_REQUEST), 'Kaydı yapamadım.');
    assert.equal(twice.agent.takeModeEscalation(twice.tab), null);
    const refused = twice.notes[0].decision;
    assert.deepEqual([refused.choice, refused.source, refused.mainModel, refused.failure, refused.outcome],
      [null, 'unavailable', 'rejected', 'malformed_or_multiple_json_objects', 'not_action']);
    // A question the page talked the model into handing off stays read-only,
    // lean mode or not: the page-free answer is "answer".
    const asked = 'Bu sayfadaki bülten ne hakkında?';
    const page = fixture(Agent, {
      semanticReply: request => json('answer', request),
      replies: [handoff('act', asked), done('Haftalık QA bülteni.')],
    });
    assert.equal(await page.run(asked), 'Haftalık QA bülteni.');
    assert.equal(page.agent.takeModeEscalation(page.tab), null);
    assert.deepEqual([page.notes[0].decision.choice, page.notes[0].decision.mainModel, page.notes[0].decision.outcome, page.notes[0].decision.failure],
      ['answer', 'answered', 'not_action', undefined]);
    // A translated quote is not the user's words.
    const translated = fixture(Agent, {
      semanticReply: () => json('act', 'Sign up for the newsletter on this page.'),
      replies: [handoff('act', TR_REQUEST), done('Kaydı yapamadım.')],
    });
    await translated.run(TR_REQUEST);
    assert.deepEqual([translated.notes[0].decision.failure, translated.notes[0].decision.outcome], ['evidence_not_quoted', 'not_action']);
  });

  test(`${build}: plain imperatives in other languages are actions and questions stay read-only`, async () => {
    for (const [language, request, meaning, expected] of LANGUAGE_CASES) {
      for (const reply of [json(expected, request), explained(language, request, meaning, expected)]) {
        const f = fixture(Agent, { semanticReply: () => reply });
        const verdict = await f.agent._semanticDecision(f.tab, 'run_mode', question(request), { provider: f.provider, retryChoices: ['unclear'] });
        assert.deepEqual([verdict.choice, verdict.source], [expected, 'main_model'], `${language}: ${reply.slice(0, 40)}`);
        assert.equal(autoModeForChoice(verdict.choice), expected === 'act' ? 'act' : 'ask', request);
      }
    }
  });

  test(`${build}: the diagnostics name the path, the model and why an answer did not count`, async () => {
    const decide = async (f, request, options = {}) => {
      const diagnostics = {};
      const verdict = await f.agent._semanticDecision(f.tab, 'run_mode', question(request), { provider: f.provider, diagnostics, ...options });
      return { verdict, diagnostics };
    };
    // The active model's reply was cut off, empty, or the request failed.
    const cut = fixture(Agent, { semanticReply: () => ({ content: '{"choice":"act","evidence":"Bu sayfa', finishReason: 'length' }) });
    assert.deepEqual((await decide(cut, TR_REQUEST)).diagnostics.failure, 'truncated_response');
    const empty = fixture(Agent, { semanticReply: () => ({ content: '', reasoningContent: 'thinking', finishReason: 'stop' }) });
    assert.deepEqual([(await decide(empty, TR_REQUEST)).diagnostics.failure], ['reasoning_only']);
    const failed = fixture(Agent, { semanticReply: () => new Error('socket hang up') });
    const failure = await decide(failed, TR_REQUEST);
    assert.deepEqual([failure.verdict.choice, failure.diagnostics.mainModel, failure.diagnostics.failure], [null, 'failed', 'request_failed']);
    const outside = fixture(Agent, { semanticReply: () => json('click', TR_REQUEST) });
    assert.equal((await decide(outside, TR_REQUEST)).diagnostics.failure, 'choice_not_listed');
    // The route asks the decision model only.
    const route = fixture(Agent, { semanticReply: () => assert.fail('the route never asks the active model') });
    const { latencyMs, ...routed } = (await decide(route, TR_REQUEST, { mainModel: false })).diagnostics;
    assert.deepEqual(routed, { decisionModel: 'off', mainModel: 'not_asked', source: 'unavailable' });
    assert.ok(Number.isFinite(latencyMs));
    // An unsure decision model hands over to the active model; the trace
    // keeps what it leaned to.
    const settings = { decisionConfig: { provider: 'webbrain-cloud', model: 'jev-1.13.0' } };
    const unsure = fixture(Agent, {
      semanticReply: () => json('act', TR_REQUEST),
      decisionModel: { settings, verdict: { model: 'jev-1.13.0', answers: { run_mode: { type: 'choice', choice: 'answer', confidence: 0.612, probabilities: { answer: 0.612, act: 0.31 } } } } },
    });
    const handedOver = await decide(unsure, TR_REQUEST);
    assert.equal(handedOver.verdict.choice, 'act');
    assert.deepEqual([handedOver.diagnostics.decisionModel, handedOver.diagnostics.decisionModelChoice, handedOver.diagnostics.decisionModelConfidence,
      handedOver.diagnostics.model, handedOver.diagnostics.source], ['unsure', 'answer', 0.61, 'claude-sonnet-5-5-high', 'main_model']);
    // A sure decision model answers alone; asked again, the cache answers.
    const sure = fixture(Agent, {
      semanticReply: () => assert.fail('a sure decision model settles it'),
      decisionModel: { settings, verdict: { model: 'jev-1.13.0', answers: { run_mode: { type: 'choice', choice: 'act', confidence: 0.97, probabilities: { act: 0.97 } } } } },
    });
    const first = await decide(sure, TR_REQUEST);
    assert.deepEqual([first.verdict.choice, first.diagnostics.source, first.diagnostics.decisionModel, first.diagnostics.model],
      ['act', 'decision_model', 'answered', 'jev-1.13.0']);
    const again = await decide(sure, TR_REQUEST);
    assert.deepEqual([again.verdict.choice, again.diagnostics.source, again.diagnostics.answeredBy], ['act', 'cache', 'decision_model']);
  });
}
