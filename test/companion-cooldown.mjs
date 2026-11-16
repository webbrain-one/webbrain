import assert from 'node:assert/strict';
import test from 'node:test';

const area = { get: async () => ({}), set: async () => {}, remove: async () => {} };
globalThis.chrome = globalThis.browser = { storage: { local: area, session: area },
  runtime: { getURL: value => `extension://owned/${value}` } };
const upstream = { error: { code: 429, status: 'RESOURCE_EXHAUSTED',
  message: 'Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 38h52m48s.',
  details: [{ '@type': 'type.googleapis.com/' + 'x'.repeat(1200) }] } };
const body = JSON.stringify({ error: { code: 'model_cooldown',
  last_upstream_error: JSON.stringify(upstream),
  message: 'All credentials for model gemini-3.8-flash-high are cooling down via provider antigravity' } });
const page = { tabUrl: 'https://www.linkedin.com/messaging/thread/owned/', tabTitle: 'Messaging' };

for (const browser of ['chrome', 'firefox']) {
  const { OpenAICompatibleProvider } = await import(`../src/${browser}/src/providers/openai.js`);
  const { Agent } = await import(`../src/${browser}/src/agent/agent.js`);
  const { retryModelCall, retryModelStream } = await import(`../src/${browser}/src/providers/model-retry.js`);
  const cooldownBody = fields => JSON.stringify({ error: { code: 'model_cooldown',
    message: 'All credentials for model gemini-3.8-flash-high are cooling down', ...fields } });
  const makeProvider = () => new OpenAICompatibleProvider({ providerName: 'webbrain-companion',
    baseUrl: 'http://127.0.0.1:8327/v1', model: 'gemini-3.8-flash-high', apiKey: 'test-only' });
  const cooldown = () => makeProvider()._httpError(429, body, 'webbrain-companion error 429');
  function makeAgent(error) {
    const provider = makeProvider();
    const agent = new Agent({ getActive: () => provider });
    agent._jevClassify = async () => null;
    agent._readCompletenessNeedsScopeClassification = () => true;
    agent._armReadCompletenessFromPlan = () => assert.fail('Unavailable provider must not authorize reading');
    agent._persist = () => {};
    agent._persistSubmittedTurn = async () => {};
    let calls = 0;
    agent._chatWithCostAllowance = async () => { calls++; throw error; };
    return { agent, calls: () => calls };
  }

  test(`${browser}: Companion cooldown exposes a concise quota message and reset duration`, async () => {
    const provider = makeProvider();
    assert.ok(body.length > 1200, 'Exercise truncation in both chat and stream error readers.');
    const original = globalThis.fetch;
    let error;
    globalThis.fetch = async () => new Response(body, { status: 429 });
    try {
      await assert.rejects(provider.chat([{ role: 'user', content: 'Classify the scope.' }]), value => {
        error = value;
        return true;
      });
    } finally { globalThis.fetch = original; }
    assert.equal(error.code, 'model_cooldown');
    assert.equal(error.httpStatus, 429);
    assert.match(error.message, /selected model has reached its provider quota/);
    assert.match(error.message, /38h52m48s/);
    assert.match(error.message, /Switch to another model/);
    assert.doesNotMatch(error.message, /last_upstream_error|antigravity|RESOURCE_EXHAUSTED|upgrade|\{/i);
  });

  test(`${browser}: streaming errors also normalize an outer JSON payload cut off by the reader`, async () => {
    const original = globalThis.fetch;
    globalThis.fetch = async () => new Response(body, { status: 429 });
    try {
      await assert.rejects(async () => {
        for await (const chunk of makeProvider().chatStream([{ role: 'user', content: 'Read this' }])) {
          assert.fail(JSON.stringify(chunk));
        }
      }, error => {
        assert.equal(error.code, 'model_cooldown');
        assert.match(error.message, /provider quota/);
        assert.match(error.message, /38h52m48s/);
        assert.doesNotMatch(error.message, /\\|\{|last_upstream_error/);
        return true;
      });
    } finally { globalThis.fetch = original; }
  });

  test(`${browser}: malformed or absent upstream detail still produces a useful cooldown message`, () => {
    for (const detail of [undefined, '{not JSON', JSON.stringify({ error: { message: 'rate limited' } })]) {
      const error = makeProvider()._httpError(429, JSON.stringify({ error: {
        code: 'model_cooldown', message: 'private upstream payload', last_upstream_error: detail,
      } }), 'companion error');
      assert.match(error.message, /no available credentials/);
      assert.doesNotMatch(error.message, /private|quota|reset in|\{/);
    }
  });

  test(`${browser}: cooldown does not alter another provider's error contract`, () => {
    const provider = new OpenAICompatibleProvider({ providerName: 'openrouter', model: 'test' });
    const error = provider._httpError(429, body, 'router error');
    assert.equal(error.modelUnavailableMessage, undefined);
    assert.equal(error.retryAfterMs, null);
    assert.match(error.message, /last_upstream_error/);
  });

  // QA 2026-11-13 A1: a quota that resets in hours was retried three times
  // over a minute before the same message was shown.
  test(`${browser}: a quota reset hours away fails at once instead of being retried as a rate limit`, async () => {
    const error = cooldown();
    assert.equal(error.retryAfterMs, (38 * 3600 + 52 * 60 + 48) * 1000);
    await assert.rejects(retryModelCall(error, async () => assert.fail('Do not ask again before the reset'), {
      onRetry: async () => assert.fail('No retry is announced'),
      sleep: async () => assert.fail('Do not wait for a reset hours away'),
    }), value => value === error);
  });

  test(`${browser}: a streamed quota error whose outer JSON was cut off sends one request`, async () => {
    const original = globalThis.fetch;
    let requests = 0;
    globalThis.fetch = async () => { requests++; return new Response(body, { status: 429 }); };
    try {
      await assert.rejects(async () => {
        const stream = retryModelStream(() => makeProvider().chatStream([{ role: 'user', content: 'Read this' }]),
          { sleep: async () => assert.fail('Do not wait for a reset hours away') });
        for await (const chunk of stream) assert.fail(JSON.stringify(chunk));
      }, error => {
        assert.equal(error.code, 'model_cooldown');
        assert.ok(error.retryAfterMs > 60000, `retryAfterMs ${error.retryAfterMs}`);
        assert.match(error.message, /38h52m48s/);
        return true;
      });
    } finally { globalThis.fetch = original; }
    assert.equal(requests, 1);
  });

  test(`${browser}: short Companion cooldowns stay retryable after the reported reset`, async () => {
    for (const [fields, expected] of [
      [{ reset_seconds: 12, reset_time: '12s' }, 12000],
      [{ last_upstream_error: JSON.stringify({ error: { message: 'Individual quota reached. Resets in 20s.' } }) }, 20000],
    ]) {
      const error = makeProvider()._httpError(429, cooldownBody(fields), 'companion error');
      assert.equal(error.retryAfterMs, expected);
      const waits = [];
      assert.equal(await retryModelCall(error, async () => 'OK', { random: () => 0, sleep: async ms => waits.push(ms) }), 'OK');
      assert.deepEqual(waits, [expected]);
    }
  });

  test(`${browser}: the longest reset the Companion or the upstream quota reports decides`, async () => {
    const hours = (38 * 3600 + 52 * 60 + 48) * 1000;
    // A proxy backoff or Retry-After shorter than the upstream quota reset
    // cannot restore the quota.
    assert.equal(makeProvider()._httpError(429, cooldownBody({ reset_seconds: 1,
      last_upstream_error: JSON.stringify(upstream) }), 'companion error', '1').retryAfterMs, hours);
    // A credential cooldown with no upstream text uses the Companion's reset.
    const far = makeProvider()._httpError(429, cooldownBody({ reset_seconds: 7200, reset_time: '2h0m0s' }), 'companion error');
    assert.equal(far.retryAfterMs, 7200000);
    assert.match(far.message, /no available credentials/);
    await assert.rejects(retryModelCall(far, async () => assert.fail('Do not ask again before the reset'),
      { sleep: async () => assert.fail('Do not wait') }), value => value === far);
    assert.equal(makeProvider()._httpError(429, cooldownBody({}), 'companion error', '45').retryAfterMs, 45000);
    // A reset cut off by the bounded body read is not a reset.
    for (const cut of ['{"error":{"code":"model_cooldown","reset_seconds":158', '{"error":{"code":"model_cooldown","message":"Individual quota reached. Resets in 43h5']) {
      assert.equal(makeProvider()._httpError(429, cut, 'companion error').retryAfterMs, null, cut);
    }
  });

  test(`${browser}: scope errors show readable text after the existing recovery attempts`, async () => {
    const { agent, calls } = makeAgent(cooldown());
    const outcome = await agent._runReadScopeClassifier(42, { role: 'user', content: 'Summarize this conversation' },
      () => {}, null, null, '', page);
    assert.equal(calls(), 2);
    assert.equal(outcome.proceed, false);
    assert.equal(outcome.reason, 'read_scope_error');
    assert.match(outcome.message, /provider quota/);
    assert.match(outcome.message, /No page tools ran/);
    assert.doesNotMatch(outcome.message, /could not determine|last_upstream_error|\\|\{/);
  });

  test(`${browser}: truncated escaped upstream text still yields clean quota/reset facts`, () => {
    const escaped = '{\\n  \\"error\\": {\\n    \\"message\\": \\"Individual quota reached. Resets in 38h52m48s.\\", ...';
    const error = makeProvider()._httpError(429, JSON.stringify({ error: {
      code: 'model_cooldown', last_upstream_error: escaped,
    } }), 'companion error');
    assert.match(error.message, /provider quota/);
    assert.match(error.message, /38h52m48s/);
    assert.doesNotMatch(error.message, /\\|\{|last_upstream_error/);
  });

  test(`${browser}: Ask transcript preserves the user's request and clean provider failure`, async () => {
    const { agent, calls } = makeAgent(cooldown());
    const messages = [{ role: 'system', content: 'system' }];
    const user = { role: 'user', content: 'Summarize this conversation' };
    const outcome = await agent._maybeRunPlannerGate(42, messages, user, () => {}, 'ask', null, null, page, {});
    assert.equal(calls(), 2);
    assert.equal(outcome.proceed, false);
    assert.equal(messages[1], user);
    assert.equal(messages.at(-1).content, outcome.message);
    assert.doesNotMatch(messages.at(-1).content, /last_upstream_error|\{/);
  });
}
