import assert from 'node:assert/strict';
import { test } from 'node:test';
import { makeSchedulerHarness } from './lib/scheduler-harness.mjs';
import './systemone-trace.mjs';
const area = { get: async () => ({}), set: async () => {} };
globalThis.chrome = globalThis.browser = { storage: { local: area, session: area }, runtime: { getURL: x => x, sendMessage: async () => ({}) } };
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
for (const build of ['chrome', 'firefox']) {
  const mod = await import(`../src/${build}/src/agent/systemone-judge.js`);
  const evidence = await import(`../src/${build}/src/agent/systemone-evidence.js`);
  const scheduler = await import(`../src/${build}/src/agent/scheduler.js`);
  const questions = { p: { type: 'noul', instructions: 'Is it ready?' }, c: { type: 'choice', instructions: 'Choose', criteria: { yes: 'ready', no: 'not ready' } }, s: { type: 'score', instructions: 'Score', criteria: ['none', 'some', 'all'] } };
  const answers = () => ({ p: { type: 'noul', noul: .9 }, c: { type: 'choice', choice: 'yes', confidence: .9, probabilities: { yes: .9, no: .1 } }, s: { type: 'score', score: 1.8, confidence: .9, probabilities: { 0: 0, 1: .2, 2: .8 }, legend: { 0: 'none', 1: 'some', 2: 'all' } } });
  test(`${build}: strict typed answer and threshold contracts`, () => {
    assert.deepEqual(mod.validateSystemOneAnswers(answers(), questions), answers());
    for (const value of [null, '', true, '0.9', NaN, Infinity, -1, 1.1]) {
      const a = answers(); a.p.noul = value;
      assert.throws(() => mod.validateSystemOneAnswers(a, questions));
    }
    for (const patch of [{ choice: 'fake' }, { confidence: null }, { probabilities: { yes: .9 } }, { probabilities: { yes: 1.2, no: -.2 } }, { probabilities: { yes: .1, no: .9 } }]) {
      const a = answers(); Object.assign(a.c, patch); assert.throws(() => mod.validateSystemOneAnswers(a, questions));
    }
    for (const patch of [{ score: null }, { score: 3 }, { score: 0 }, { legend: null }, { type: 'noul' }]) {
      const a = answers(); Object.assign(a.s, patch); assert.throws(() => mod.validateSystemOneAnswers(a, questions));
    }
    for (const value of [null, '', '0.8', false, NaN, .3, 1]) assert.equal(mod.normalizeSystemOneThreshold(value), .7);
    assert.throws(
      () => mod.validateSystemOneAnswers({}, questions),
      error => error.code === 'JEV_INVALID_ANSWER_TYPE' && mod.isSystemOneResponseContractError(error),
    );
    assert.equal(mod.systemOneFailureReason(Object.assign(new Error(), { code: 'JEV_INVALID_DISTRIBUTION' })), 'invalid_distribution');
    assert.equal(mod.systemOneFailureReason(Object.assign(new Error(), { status: 429 })), 'rate_limit');
  });
  test(`${build}: a model that clips long text never receives a state past its token budget`, async () => {
    const requests = [];
    const judge = mod.createSystemOneJudge({ fetchImpl: async (_url, init) => { const body = JSON.parse(init.body); requests.push(body);
      return { ok: true, json: async () => ({ model: body.model, answers: { p: { type: 'noul', noul: .9 } }, usage: { input_tokens: 10, output_tokens: 0 } }) }; } });
    const one = { p: questions.p };
    const config = { provider: 'openrouter', model: 'cloudflare/clef-flash', apiKey: 'test', url: 'https://example.test/v1/decisions' };
    const budget = mod.SYSTEM_ONE_TEXT_BYTE_BUDGETS['cloudflare/clef-flash'];
    assert.ok(budget < 2000, 'the budget (bytes, an upper bound on byte-level tokens) stays under the 2K tokens the model reads');
    await judge.evaluate({ config, state: { evidence: 'The post was published and its page shows it. '.repeat(20) }, questions: one });
    assert.equal(requests.length, 1, 'ordinary text within the budget is sent');
    // Each of these stays far below the old 6,000-character cap yet can exceed 2K real tokens.
    const dense = {
      cjk: { evidence: '投稿が公開されました。'.repeat(100) },
      hashes: { evidence: ('a1b2c3d4e5f60718293a4b5c6d7e8f90 ').repeat(60) },
      unbroken: { evidence: 'Zm9vYmFy'.repeat(250) },
      emoji: { evidence: '\u{1F600}'.repeat(700) },
      punctuation: { evidence: '\\"\\n{}[]<>|~^'.repeat(150) },
    };
    for (const [name, state] of Object.entries(dense)) {
      assert.ok(JSON.stringify(state).length < 6000, `${name} is under the old character cap`);
      await assert.rejects(judge.evaluate({ config, state, questions: one }),
        error => error.code === 'JEV_STATE_EXCEEDS_MODEL_INPUT' && mod.systemOneFailureReason(error) === 'state_too_long', name);
    }
    assert.equal(requests.length, 1, 'a state past the budget is not sent');
    // A screenshot inside the state is an image, not text, so it does not use up the budget.
    await judge.evaluate({ config: { ...config, supportsVision: true }, state: [{ task: 'Is it done?' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,' + 'iVBORw0KGgo'.repeat(50000) } }], questions: one });
    assert.equal(requests.length, 2, 'an image payload is excluded from the text budget');
    // The same data URL as ordinary text is text: the model reads it as tokens.
    await assert.rejects(judge.evaluate({ config: { ...config, supportsVision: true }, questions: one,
      state: [{ observation: 'data:image/png;base64,' + 'iVBORw0KGgo'.repeat(400) }, { task: 'Is it done?' }] }),
    error => error.code === 'JEV_STATE_EXCEEDS_MODEL_INPUT');
    assert.equal(requests.length, 2, 'a data URL in text is not sent');
    await judge.evaluate({ config: { ...config, model: 'another/publisher' }, state: dense.cjk, questions: one });
    assert.equal(requests.length, 3, 'other models keep the full state');
  });
  test(`${build}: Compass accepts the server-selected model while other providers enforce their selection`, async () => {
    let responseModel = 'liquid/d1.1-20261027';
    let responseAnswers = answers();
    const judge = mod.createSystemOneJudge({ fetchImpl: async () => ({ ok: true, json: async () => ({
      model: responseModel, answers: responseAnswers, usage: { input_tokens: 10, output_tokens: 0 },
    }) }) });
    const config = { provider: 'compass', model: 'cloudflare/clef-flash', url: 'https://example.test/v1/decisions' };
    let usage;
    const result = await judge.evaluate({ config, state: {}, questions, onUsage: value => { usage = value; } });
    assert.equal(result.model, responseModel);
    assert.equal(usage.model, responseModel);
    assert.deepEqual(result.answers, answers());
    await assert.rejects(judge.evaluate({ config: { ...config, provider: 'openrouter', apiKey: 'test' }, state: {}, questions }),
      error => error.code === 'JEV_UNEXPECTED_MODEL');
    responseModel = 'cloudflare/clef-flash-20261027';
    await judge.evaluate({ config: { ...config, provider: 'openrouter', apiKey: 'test' }, state: {}, questions });
    responseModel = '';
    await assert.rejects(judge.evaluate({ config, state: {}, questions }), error => error.code === 'JEV_UNEXPECTED_MODEL');
    responseModel = 'liquid/d1.1-20261027';
    responseAnswers = {};
    await assert.rejects(judge.evaluate({ config, state: {}, questions }), error => error.code === 'JEV_INVALID_ANSWER_TYPE');
  });
  test(`${build}: singleton Choice requests fail locally before a service call`, async () => {
    let calls = 0;
    const judge = mod.createSystemOneJudge({ fetchImpl: async () => { calls++; throw new Error('must not call'); } });
    await assert.rejects(
      judge.evaluate({
        apiKey: 'test', state: {},
        questions: { target: { type: 'choice', instructions: 'Choose', criteria: { none: 'No target' } } },
      }),
      /at least two criteria/,
    );
    assert.equal(calls, 0);
  });
  test(`${build}: one deadline covers retry backoff and an uncooperative fetch`, async () => {
    let calls = 0;
    const start = Date.now();
    const judge = mod.createSystemOneJudge({ timeoutMs: 40, fetchImpl: async () => { calls++; return { ok: false, status: 429 }; } });
    await assert.rejects(judge.evaluate({ apiKey: 'test', state: {}, questions }), /timed out/);
    assert.equal(calls, 1); assert.ok(Date.now() - start < 500);
    await assert.rejects(mod.createSystemOneJudge({ timeoutMs: 20, fetchImpl: () => new Promise(() => {}) }).evaluate({ apiKey: 'test', state: {}, questions }), /timed out/);
  });
  test(`${build}: abort interrupts backoff; billable invalid answers are accounted`, async () => {
    const controller = new AbortController(); const entered = deferred(); let calls = 0;
    const judge = mod.createSystemOneJudge({ fetchImpl: async () => { calls++; return { ok: false, status: 529 }; }, sleep: () => { entered.resolve(); return new Promise(() => {}); } });
    const result = judge.evaluate({ apiKey: 'test', state: {}, questions, signal: controller.signal });
    await entered.promise; controller.abort(new Error('cancelled')); await assert.rejects(result, /cancelled/); assert.equal(calls, 1);
    let usage;
    const invalid = mod.createSystemOneJudge({ fetchImpl: async () => ({ ok: true, json: async () => ({ model: mod.SYSTEM_ONE_MODEL, answers: {}, usage: { input_tokens: 1000, output_tokens: 0 } }) }) });
    await assert.rejects(
      invalid.evaluate({ apiKey: 'test', state: {}, questions, onUsage: m => { usage = m; } }),
      error => error.code === 'JEV_INVALID_ANSWER_TYPE' && mod.systemOneFailureReason(error) === 'invalid_answer_type',
    );
    assert.equal(usage.model, 'jev-1.13.0'); assert.equal(usage.estimatedCostUsd, .000042);
  });
  test(`${build}: evidence excludes summary, history, credentials and pre-action observations`, () => {
    const c = evidence.createSystemOneEvidence();
    c.observe('tool_result', { name: 'done', result: { summary: 'Everything succeeded!' } });
    assert.equal(evidence.systemOneEvidenceState('task', c.snapshot()), null);
    c.observe('tool_result', { name: 'get_accessibility_tree', result: { pageContent: 'Before action', screenshot: 'PRIVATE', history: 'PRIVATE' } });
    c.observe('tool_call', { name: 'click_ax', args: { ref_id: 'ref_1' } });
    c.observe('tool_result', { name: 'click_ax', result: { success: true } });
    assert.equal(evidence.systemOneEvidenceState('task', c.snapshot()), null);
    c.observe('tool_result', { name: 'read_page', result: { text: 'After action\npassword=hunter2\nhttps://user:pass@example.com/page?token=PRIVATE' } });
    const state = evidence.systemOneEvidenceState('task', c.snapshot());
    assert.equal(c.snapshot().sideEffect, true);
    assert.doesNotMatch(JSON.stringify(state), /Before action|hunter2|PRIVATE|user:pass/);
    assert.match(state.latest_observation[0].data, /untrusted_page_content/);
    assert.ok(JSON.stringify(state).length <= 16000);
  });
  async function setup({ mutate = false, noEvidence = false, judge, recurring = false, outcome = 'success' } = {}) {
    let calls = 0;
    const h = makeSchedulerHarness(scheduler, {
      systemOneEnabled: true, systemOneWatchEnabled: true, systemOneCompletionEnabled: true, systemOneApiKey: 'test',
      systemOneJudge: judge || { evaluate: async () => { calls++; return { answers: { condition_met: { noul: .1 }, task_complete: { noul: .1 }, task_completeness: { score: 0 } } }; } },
      processMessage: async (_tab, _prompt, emit, _mode, _attachments, options) => {
        if (mutate) {
          await options.beforeConsequentialTool({ name: 'click_ax' });
          emit('tool_call', { name: 'click_ax' }); emit('tool_result', { name: 'click_ax', result: { success: true } });
          await options.afterConsequentialTool({ name: 'click_ax', result: { success: true } });
        }
        if (!noEvidence) emit('tool_result', { name: 'get_accessibility_tree', result: { pageContent: 'Status: not confirmed' } });
        emit('tool_result', { name: 'done', result: { done: true, outcome, summary: 'Succeeded' } });
        return 'Succeeded';
      },
    });
    const created = recurring
      ? await h.manager.createTaskJob({ tabId: 77, args: { title: 'Save record', prompt: 'Save record', mode: 'act', schedule: { type: 'recurring', after_seconds: 0, interval_minutes: 5 }, target: { type: 'current_tab' } }, currentUrl: 'https://example.com/' })
      : await h.manager.createWatchJob({ tabId: 77, args: { prompt: 'Watch status', keep: true, interval_seconds: 60 }, currentUrl: 'https://example.com/' });
    assert.equal(created.success, true);
    return { ...h, id: created.jobId, calls: () => calls, run: () => h.manager.handleAlarm(h.alarmName(created.jobId)) };
  }
  test(`${build}: multilingual watch and scheduled evidence reaches the judge within its byte budget`, async () => {
    for (const source of ['watch', 'scheduled']) for (const sample of ['公開された投稿を確認してください。', '😀公開\n"\\\u0000']) {
      const text = sample.repeat(1500);
      const collector = evidence.createSystemOneEvidence();
      collector.observe('tool_result', { name: 'read_page', result: { text, content: text, pageContent: text } });
      collector.observe('tool_result', { name: 'get_accessibility_tree', result: { pageContent: text } });
      let calls = 0;
      const judge = mod.createSystemOneJudge({ fetchImpl: async (_url, options) => {
        calls++;
        const request = JSON.parse(options.body);
        assert.ok(Buffer.byteLength(JSON.stringify(request.state)) <= 16000);
        assert.ok(request.state.latest_observation.length > 0);
        assert.match(request.state.latest_observation.at(-1).data, /<untrusted_page_content.*[\s\S]*<\/untrusted_page_content/);
        const result = answers();
        return { ok: true, json: async () => ({ model: mod.SYSTEM_ONE_MODEL, usage: { input_tokens: 1, output_tokens: 1 }, answers: {
          [source === 'watch' ? 'condition_met' : 'task_complete']: result.p,
          task_completeness: { ...result.s, legend: Object.fromEntries(request.questions.task_completeness.criteria.map((label, i) => [i, label])) },
        } }) };
      } });
      const h = makeSchedulerHarness(scheduler, { systemOneJudge: judge });
      const verdict = await h.manager._evaluateSystemOne({ source, prompt: text, tabId: 77, watch: { systemOneBaseline: collector.snapshot().observations } }, '', 'success', {
        settings: { typesafeApiKey: 'test', systemOneEnabled: true, systemOneWatchEnabled: true, systemOneCompletionEnabled: true }, evidence: collector.snapshot(),
      });
      assert.equal(calls, 1, 'multibyte or escaped evidence must not silently skip verification');
      assert.equal(verdict.decision, 'keep');
    }
  });
  test(`${build}: no evidence skips Jev; read-only downgraded watch keeps polling`, async () => {
    const missing = await setup({ noEvidence: true }); await missing.run();
    assert.equal(missing.calls(), 0); assert.equal(missing.jobs()[0].systemOneVerdict, undefined);
    assert.equal(missing.jobs()[0].watch.systemOneBaseline, undefined);
    const h = await setup(); await h.run();
    assert.equal(h.jobs()[0].status, 'pending'); assert.equal(h.jobs()[0].lastOutcome, 'partial');
    assert.match(h.jobs()[0].watch.systemOneBaseline[0].data, /Status: not confirmed/);
  });
  test(`${build}: uncertain completed actions never automatically repeat, including recurring tasks`, async () => {
    for (const recurring of [false, true]) {
      const h = await setup({ mutate: true, recurring }); await h.run();
      const job = h.jobs()[0]; assert.equal(job.status, 'needs_user_input'); assert.equal(job.reconciliationRequired, true);
      assert.equal(job.completedConsequentialAction.name, 'click_ax'); assert.equal(job.nextRunAt, null);
      await h.run(); assert.equal(h.calls(), 1);
    }
  });
  test(`${build}: cancellation and replaced execution discard a delayed verdict`, async () => {
    for (const cancel of [true, false]) {
      const entered = deferred(); const response = deferred();
      const h = await setup({ judge: { evaluate: async () => { entered.resolve(); return response.promise; } } });
      let current = true;
      h.manager.agent.systemOneContext = () => ({ isCurrent: () => current });
      const running = h.run(); await entered.promise;
      current = false;
      if (cancel) await h.manager.cancelJob(h.id);
      else await h.manager._updateJob(h.id, () => ({ executionId: 'new-execution', lastResult: 'new result' }));
      response.resolve({ answers: { condition_met: { noul: .1 }, task_completeness: { score: 0 } } }); await running;
      const job = h.jobs()[0]; assert.equal(job.systemOneVerdict, undefined);
      assert.equal(cancel ? job.status : job.lastResult, cancel ? 'cancelled' : 'new result');
    }
  });

  test(`${build}: every skipped judgment preserves prior verdict and observation without a verdict trace`, async () => {
    for (const reason of ['disabled', 'no_evidence', 'not_success', 'service_unavailable', 'cost_limit', 'unavailable', 'cancelled']) {
      const h = await setup();
      const prior = { decision: 'keep', reason: 'evidence_judgment' };
      const baseline = [{ tool: 'read_page', data: 'Previously judged observation' }];
      await h.manager._updateJob(h.id, job => ({ systemOneVerdict: prior, watch: { ...job.watch, systemOneBaseline: baseline } }));
      h.manager._evaluateSystemOne = async () => ({ decision: 'skip', reason });
      let notes = 0; h.manager.agent.recordSystemOneVerdict = () => { notes++; };
      await h.run();
      assert.deepEqual(h.jobs()[0].systemOneVerdict, prior, reason);
      assert.deepEqual(h.jobs()[0].watch.systemOneBaseline, baseline, reason);
      assert.equal(h.jobs()[0].status, 'pending', reason);
      assert.equal(notes, 0, reason);
    }
  });

  test(`${build}: generation loss settles the owned watch or recurring execution without replay`, async () => {
    for (const recurring of [false, true]) for (const phase of ['judge', 'terminal']) {
      const entered = deferred(); const response = deferred(); let current = true;
      const h = await setup({ mutate: true, recurring, judge: { evaluate: async () => { entered.resolve(); return response.promise; } } });
      h.manager.agent.systemOneContext = () => ({ isCurrent: () => current });
      h.manager.agent.recordSystemOneVerdict = () => { if (phase === 'terminal') current = false; };
      const running = h.run(); await entered.promise;
      if (phase === 'judge') current = false;
      response.resolve({ answers: { condition_met: { noul: .99 }, task_complete: { noul: .99 }, task_completeness: { score: 2 } } });
      await running;
      const job = h.jobs()[0];
      assert.equal(job.status, 'needs_user_input');
      assert.equal(job.reconciliationRequired, true);
      assert.equal(job.completedConsequentialAction.name, 'click_ax');
      assert.equal(job.nextRunAt, null);
      if (phase === 'judge') assert.equal(job.systemOneVerdict, undefined);
      await h.run(); assert.equal(h.jobs()[0].status, 'needs_user_input');
    }
  });

  test(`${build}: response that crosses the allowance is charged but cannot supply a judgment`, async () => {
    const { Agent } = await import(`../src/${build}/src/agent/agent.js`);
    const agent = new Agent({ getActive: () => ({ name: 'test', config: {} }) });
    agent._checkCostAllowance = async () => null;
    let charged = 0; const notes = [];
    agent._recordCostUsage = async () => { charged++; return 'Cost allowance exceeded'; };
    agent.recordSystemOneVerdict = (_tab, data) => notes.push(data);
    const client = mod.createSystemOneJudge({ fetchImpl: async () => ({ ok: true, json: async () => ({ model: mod.SYSTEM_ONE_MODEL, usage: { input_tokens: 1000, output_tokens: 1 }, answers: answers() }) }) });
    await assert.rejects(agent.evaluateSystemOne(77, client, { apiKey: 'test', state: {}, questions }), error => error.code === 'WB_COST_ALLOWANCE');
    assert.equal(charged, 1);
    assert.equal(notes.length, 1);
    assert.equal(notes[0].decision, 'usage');
  });
}
