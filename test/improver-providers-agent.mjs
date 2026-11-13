// Real Agent loops (Ask with interactive streaming, and the streaming loop
// that Act uses) against a real OpenRouter-configured provider whose fetch is
// stubbed with real Response objects, both builds. Rate limits and Cloud
// upstream failures must get model-retry's cooldowns whether they arrive as
// an HTTP status or inside the HTTP 200 stream, must never be mistaken for a
// context overflow, and must never replay text the user already saw. A
// per-minute input-token limit that outlasts the cooldowns (the request alone
// may exceed it) is trimmed once; billing exhaustion, and a Companion quota
// that resets after the cooldowns would end, fail at once.
import assert from 'node:assert/strict';
import { test } from 'node:test';

const area = { get: async () => ({}), set: async () => {}, remove: async () => {} };
const api = {
  storage: { local: area, session: area },
  runtime: { getURL: value => `chrome-extension://test/${value}`, sendMessage: async () => ({}) },
  tabs: { get: async id => ({ id, url: 'https://example.com/', title: 'Example' }), sendMessage: async () => ({}) },
  scripting: { executeScript: async () => [{ result: null }] },
};
globalThis.chrome = api;
globalThis.browser = api;

const sse = (...events) => new Response(
  events.map(event => `data: ${typeof event === 'string' ? event : JSON.stringify(event)}\n\n`).join(''),
  { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
);
const answer = content => sse({ choices: [{ index: 0, delta: { content } }] }, { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }, '[DONE]');
const inStream = error => ({ error, choices: [{ index: 0, delta: { content: '' }, finish_reason: 'error' }] });
const LIMIT = { code: 429, message: 'Rate limit exceeded', metadata: { error_type: 'rate_limit_exceeded' } };
const httpLimit = () => new Response(JSON.stringify({ error: { code: 429, message: 'Rate limit exceeded: free-models-per-min.' } }), { status: 429 });
// Anthropic's exact per-minute input-token (ITPM) wording. It is the same
// whether earlier requests used the minute's budget or this request alone
// exceeds it.
const ANTHROPIC_ITPM = "This request would exceed your organization's rate limit of 30,000 input tokens per minute (org: 3f9a1c2e-0000-4000-8000-000000000000, model: claude-sonnet-4-5-20250929). For details, refer to: https://docs.claude.com/en/api/rate-limits. You can see the response headers for current usage. Please reduce the prompt length or the maximum tokens requested, or try again later.";
const ANTHROPIC_OTPM = "This request would exceed your organization's rate limit of 8,000 output tokens per minute (org: 3f9a1c2e-0000-4000-8000-000000000000, model: claude-sonnet-4-5-20250929). For details, refer to: https://docs.claude.com/en/api/rate-limits. You can see the response headers for current usage. Please reduce the prompt length or the maximum tokens requested, or try again later.";
// OpenAI states the request's own size: this one fits under the limit.
const OPENAI_TPM = 'Rate limit reached for gpt-4o in organization org-x on tokens per min (TPM): Limit 30000, Used 29000, Requested 2000. Please try again in 2s. Visit https://platform.openai.com/account/rate-limits to learn more.';
const OPENAI_TOO_LARGE = 'Request too large for gpt-4o in organization org-x on tokens per min (TPM): Limit 30000, Requested 45000. The input or output tokens must be reduced in order to run successfully. Visit https://platform.openai.com/account/rate-limits to learn more.';
// No sizes at all.
const AZURE_TOKEN_LIMIT = 'Requests to the ChatCompletions_Create Operation under Azure OpenAI API version 2024-02-01 have exceeded token rate limit of your current OpenAI S0 pricing tier. Please retry after 6 seconds.';
const limited = message => () => new Response(JSON.stringify({ error: { code: 'rate_limit_exceeded', message } }), { status: 429 });
const itpm = limited(ANTHROPIC_ITPM);
const OPENAI_QUOTA = { message: 'You exceeded your current quota, please check your plan and billing details. For more information on this error, read the docs: https://platform.openai.com/docs/guides/error-codes/api-errors.', type: 'insufficient_quota', param: null, code: 'insufficient_quota' };
// 30 earlier exchanges, so a trim is visible in the request size. With the
// default 200-character questions the request (about 7,700 estimated tokens
// with the tool schemas) fits well under a 30,000-token limit; with OVERSIZED
// ones (about 51,000) it alone exceeds that limit.
const OVERSIZED = 6000;
const history = (questionChars = 200) => Array.from({ length: 30 }, (_, i) => [
  { role: 'user', content: `old question ${i} ${'x'.repeat(questionChars)}` }, { role: 'assistant', content: `old answer ${i}` },
]).flat();
// Refused while the request carries the whole history.
const refusedUntilTrimmed = limit => body => body.messages.length > 20 ? limit() : answer('Hello there.');
let nextTab = 9100;

// Run one Agent turn with model-retry's cooldown slices collapsed (only timers
// whose direct caller is model-retry.js's sleep; every other timer, including
// request deadlines started during a retry, keeps real time). `streams`
// answers each streaming model request in order, or is one function answering
// every request from its body. `history` seeds the conversation; `standalone:
// false` runs the ordinary (page-bound) Ask/Act request path.
async function run(Agent, OpenAICompatibleProvider, streams, {
  entry = 'ask', onUpdate = () => {}, history = null, standalone = true, provider: makeProvider = null, setup = () => {},
} = {}) {
  const provider = makeProvider ? makeProvider() : new OpenAICompatibleProvider({
    providerName: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1', model: 'openai/gpt-4o-mini', supportsAskStreaming: true,
  });
  const agent = new Agent({ getActive: () => provider, getProvider: () => provider, getVisionProvider: async () => null });
  Object.assign(agent, {
    _hydrate: async () => {}, _persist: () => {}, _persistNow: async () => ({ ok: true }), _persistSubmittedTurn: async () => {},
    _startTraceRun: async () => null, _endTraceRun: async (_tab, _run, status) => { agent.testStatus = status; },
    _enrichUserMessageWithCurrentPage: async (_tab, _messages, content) => ({ role: 'user', content }),
    _manageContext: async () => {}, _checkCostAllowance: async () => null, _recordCostUsage: async () => null,
    _currentUrl: async () => 'https://example.com/', _maybeEmitAskModeHandoff: async () => {},
  });
  setup(agent);
  const tab = nextTab++, requests = [], updates = [];
  if (history) agent.conversations.set(tab, history);
  let cooldownMs = 0;
  const nativeFetch = globalThis.fetch, nativeTimeout = globalThis.setTimeout;
  globalThis.fetch = async (_url, options) => {
    const body = JSON.parse(options.body);
    assert.equal(body.stream, true, 'only the streamed main turn reaches the provider');
    requests.push(body);
    const respond = typeof streams === 'function' ? streams : streams[requests.length - 1];
    assert.ok(respond, `unexpected model request ${requests.length}`);
    return respond(body);
  };
  globalThis.setTimeout = (fn, ms, ...args) => {
    const cooldown = /providers[\\/]model-retry\.js/.test((new Error().stack || '').split('\n')[2] || '');
    if (cooldown) cooldownMs += ms;
    return nativeTimeout(fn, cooldown ? 0 : ms, ...args);
  };
  try {
    const update = (type, data) => { updates.push({ type, data }); onUpdate(agent, tab, type, data); };
    const scope = standalone ? { standaloneChat: true } : {};
    const result = entry === 'ask'
      ? await agent.processMessage(tab, 'Say hello.', update, 'ask', [],
        { ...scope, interactiveChat: true, askStreamingEnabled: true, detachedRequestId: `ask-${tab}` })
      : await agent.processMessageStream(tab, 'Say hello.', update, 'ask', { ...scope, askStreamingEnabled: false });
    return { agent, tab, result, requests, updates, cooldownMs };
  } finally {
    globalThis.fetch = nativeFetch;
    globalThis.setTimeout = nativeTimeout;
  }
}
const warnings = updates => updates.filter(update => update.type === 'warning').map(update => update.data.message);
const trimmed = updates => updates.some(update => /Context too large/.test(update.data?.note || ''));
const trimNotes = updates => updates.filter(update => /Context too large, trimming/.test(update.data?.note || '')).length;
const trialNotes = updates => updates.filter(update => /per-minute token limit; retrying once with older context left out/.test(update.data?.note || '')).length;
// Earlier questions still in the saved conversation (30 when it is intact).
const oldQuestions = (agent, tab) => agent.conversations.get(tab)
  .filter(message => typeof message.content === 'string' && message.content.startsWith('old question')).length;
const recovery = updates => updates.find(update => update.type === 'failure_recovery')?.data;
const sizes = requests => requests.map(request => request.messages.length);

for (const build of ['chrome', 'firefox']) {
  const { Agent } = await import(`../src/${build}/src/agent/agent.js`);
  const { OpenAICompatibleProvider } = await import(`../src/${build}/src/providers/openai.js`);
  const { AnthropicProvider } = await import(`../src/${build}/src/providers/anthropic.js`);
  const { AzureOpenAIProvider } = await import(`../src/${build}/src/providers/azure-openai.js`);

  test(`${build}: trace labels read httpStatus and keep a 429 a rate limit despite quota wording`, () => {
    const agent = new Agent({});
    const http = (httpStatus, message, code) => Object.assign(new Error(message), { httpStatus }, code ? { code } : {});
    assert.equal(agent._traceErrorCodeFor(http(429, 'Gemini error 429: You exceeded your current quota, please check your plan and billing details.')), 'RATE_LIMIT');
    assert.equal(agent._traceErrorCodeFor(http(429, 'openrouter error 429: Rate limit exceeded for this API key')), 'RATE_LIMIT');
    assert.equal(agent._traceErrorCodeFor(http(429, 'openai error 429: You exceeded your current quota.', 'insufficient_quota')), 'QUOTA');
    assert.equal(agent._traceErrorCodeFor(http(401, 'Anthropic error 401: invalid x-api-key')), 'INVALID_CREDENTIAL');
    assert.equal(agent._traceErrorCodeFor(http(400, 'openrouter error 400: Request failed')), 'TRANSPORT');
    assert.equal(agent._traceErrorCodeFor({ message: 'You have hit your quota' }), 'QUOTA');
    assert.equal(agent._traceErrorCodeFor({ message: 'context window exceeded' }), 'CONTEXT_WINDOW_EXCEEDED');
  });

  test(`${build}: an OpenAI-compatible HTTP 400 image rejection qualifies for the local vision fallback`, () => {
    const agent = new Agent({});
    const ollama = new OpenAICompatibleProvider({ providerName: 'ollama', baseUrl: 'http://127.0.0.1:11434/v1', model: 'llama3.2' });
    const rejection = ollama._httpError(400, '{"error":{"message":"image input is not supported by this model"}}', 'ollama error 400');
    assert.equal(rejection.status, undefined, 'fixture: the real error carries only httpStatus');
    assert.equal(agent._isImageSpecificProviderRejection(rejection), true);
    assert.equal(agent._isImageSpecificProviderRejection(ollama._httpError(429, 'image input is not supported', 'ollama error 429')), false);
    assert.equal(agent._isImageSpecificProviderRejection(ollama._httpError(500, 'image input is not supported', 'ollama error 500')), false);
  });

  test(`${build}: rate-limit texts are not context overflows unless the request itself is too large`, () => {
    const agent = new Agent({});
    const http = (httpStatus, message) => Object.assign(new Error(message), { httpStatus });
    assert.equal(agent._isContextOverflowFailure(http(429, 'openrouter error 429: Rate limit exceeded: free-models-per-min.')), false);
    assert.equal(agent._isContextOverflowFailure(http(429, 'Rate limit reached for gpt-4o on tokens per min (TPM): Limit 30000, Used 29000, Requested 2000.')), false);
    assert.equal(agent._isContextOverflowFailure(http(529, 'Anthropic error 529: {"type":"overloaded_error"} exceeded capacity')), false);
    assert.equal(agent._isContextOverflowFailure(http(429, 'Request too large for gpt-4o on tokens per min (TPM): Limit 30000, Requested 45000. The input or output tokens must be reduced in order to run successfully.')), true);
    assert.equal(agent._isContextOverflowFailure(http(400, "This model's maximum context length is 128000 tokens.")), true);
    assert.equal(agent._isContextOverflowFailure(new Error('context_length_exceeded')), true);
  });

  test(`${build}: Ask retries a rate limit reported inside the HTTP 200 stream after a cooldown`, async () => {
    const { result, requests, updates, cooldownMs, agent } = await run(Agent, OpenAICompatibleProvider,
      [() => sse(inStream(LIMIT)), () => answer('Hello there.')]);
    assert.equal(result, 'Hello there.');
    assert.equal(agent.testStatus, 'done');
    assert.equal(requests.length, 2);
    assert.deepEqual(requests[0].messages, requests[1].messages, 'the same request is sent again');
    assert.ok(cooldownMs >= 4000 && cooldownMs <= 6000, `cooldown ${cooldownMs}`);
    assert.deepEqual(warnings(updates).map(text => text.replace(/\d+ seconds/, 'N seconds')),
      ['The model provider is rate-limiting requests. Retrying this step in N seconds (1/3).']);
    assert.equal(trimmed(updates), false, 'a rate limit never trims the conversation');
    assert.equal(recovery(updates), undefined);
  });

  test(`${build}: Ask waits out HTTP 429 "Rate limit exceeded" instead of trimming the conversation`, async () => {
    const { result, requests, updates, cooldownMs } = await run(Agent, OpenAICompatibleProvider,
      [httpLimit, httpLimit, () => answer('Hello there.')]);
    assert.equal(result, 'Hello there.');
    assert.equal(requests.length, 3);
    assert.ok(cooldownMs >= 16000 && cooldownMs <= 24000, `cooldown ${cooldownMs}`);
    assert.equal(warnings(updates).length, 2);
    assert.equal(trimmed(updates), false);
    assert.equal(recovery(updates), undefined);
  });

  test(`${build}: Ask retries a Cloud upstream failure reported inside the stream`, async () => {
    const { result, requests, updates, cooldownMs } = await run(Agent, OpenAICompatibleProvider,
      [() => sse(inStream({ code: 'webbrain_cloud_upstream_error', message: 'Compass upstream unavailable' })), () => answer('Hello there.')]);
    assert.equal(result, 'Hello there.');
    assert.equal(requests.length, 2);
    assert.equal(cooldownMs, 2000);
    assert.equal(recovery(updates), undefined);
  });

  test(`${build}: Ask never regenerates after streamed text was shown, and keeps other stream errors terminal`, async () => {
    for (const [label, stream] of [
      ['text then rate limit', () => sse({ choices: [{ index: 0, delta: { content: 'Partial ' } }] }, inStream(LIMIT))],
      ['provider failure', () => sse(inStream({ code: 'server_error', message: 'The model failed' }))],
    ]) {
      const { requests, updates, cooldownMs, agent } = await run(Agent, OpenAICompatibleProvider, [stream]);
      assert.equal(requests.length, 1, label);
      assert.equal(cooldownMs, 0, label);
      assert.equal(agent.testStatus, 'error', label);
      assert.equal(recovery(updates)?.retryMode, 'resume', `${label}: the manual Retry stays available`);
      if (label === 'text then rate limit') {
        assert.ok(updates.some(update => update.type === 'text' && update.data.replace === true && update.data.content === ''),
          'the unfinished partial is retracted');
      }
    }
  });

  test(`${build}: Stop during a rate-limit cooldown sends no further request`, async () => {
    const { result, requests, agent } = await run(Agent, OpenAICompatibleProvider,
      [() => sse(inStream(LIMIT)), () => assert.fail('Stopped runs must not retry')],
      { onUpdate: (owner, tab, type, data) => { if (type === 'warning' && /rate-limiting/.test(data.message)) owner.abort(tab); } });
    assert.match(result, /Stopped by user/);
    assert.equal(requests.length, 1);
    assert.equal(agent.testStatus, 'cancelled');
  });

  test(`${build}: the streaming loop retries a first-event in-stream rate limit and stops without trimming when limits persist`, async () => {
    const recovered = await run(Agent, OpenAICompatibleProvider, [() => sse(inStream(LIMIT)), () => answer('Hello there.')], { entry: 'stream' });
    assert.equal(recovered.result, 'Hello there.');
    assert.equal(recovered.requests.length, 2);
    assert.ok(recovered.cooldownMs >= 4000 && recovered.cooldownMs <= 6000, `cooldown ${recovered.cooldownMs}`);
    assert.equal(trimmed(recovered.updates), false);
    const persistent = await run(Agent, OpenAICompatibleProvider, [httpLimit, httpLimit, httpLimit, httpLimit], { entry: 'stream' });
    assert.equal(persistent.requests.length, 4, 'one request plus three cooldown retries');
    assert.ok(persistent.cooldownMs >= 40000 && persistent.cooldownMs <= 60000, `cooldown ${persistent.cooldownMs}`);
    assert.equal(trimmed(persistent.updates), false, 'a persistent rate limit keeps the conversation intact');
    assert.equal(recovery(persistent.updates)?.retryMode, 'resume');
  });

  test(`${build}: billing 429s, typed Azure stream limits and Cloud deadline failures are not context overflows`, async () => {
    const agent = new Agent({});
    const http = (httpStatus, message) => Object.assign(new Error(message), { httpStatus });
    const streamError = async (provider, frame) => {
      const native = globalThis.fetch;
      globalThis.fetch = async () => sse(frame);
      try {
        for await (const _event of provider.chatStream([{ role: 'user', content: 'hello' }])) { /* drain */ }
      } catch (error) { return error; } finally { globalThis.fetch = native; }
      return assert.fail('expected a stream error');
    };
    const router = new OpenAICompatibleProvider({ providerName: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1', model: 'openai/gpt-4o-mini' });
    const quota = router._httpError(429, JSON.stringify({ error: OPENAI_QUOTA }), 'openrouter error 429');
    assert.equal(agent._isContextOverflow(quota.message), true, 'fixture: its text alone reads as an overflow');
    assert.equal(agent._isContextOverflowFailure(quota), false);
    assert.equal(agent._isContextOverflowFailure(await streamError(router, { error: OPENAI_QUOTA })), false);
    const azure = new AzureOpenAIProvider({ baseUrl: 'https://example.openai.azure.com', model: 'gpt-4o', apiKey: 'key' });
    const azureLimit = await streamError(azure, { error: { code: '429', message: 'Rate limit is exceeded. Try again in 1 seconds.' } });
    assert.equal(agent._isContextOverflow(azureLimit.message), true, 'fixture: its text alone reads as an overflow');
    assert.equal(azureLimit.httpStatus, 429);
    assert.equal(agent._isContextOverflowFailure(azureLimit), false);
    const upstream = message => streamError(router, { error: { code: 'webbrain_cloud_upstream_error', message } });
    const deadline = await upstream('upstream request failed: Post "https://api.example.com/v1/chat/completions": context deadline exceeded');
    assert.equal(deadline.code, 'webbrain_cloud_upstream_error');
    assert.equal(agent._isContextOverflowFailure(deadline), false);
    for (const overflow of [
      "upstream error: This model's maximum context length is 128000 tokens. However, your messages resulted in 131072 tokens.",
      'upstream error: prompt is too long: 214000 tokens > 200000 maximum',
      'upstream error: context_length_exceeded',
      'upstream error: the request exceeds the available context size, try increasing it',
      'upstream error: The input token count (1050000) exceeds the maximum number of tokens allowed (1048576).',
      'upstream error: The decoder prompt (length 140000) is longer than the maximum model length of 131072. Make sure that `max_model_len` is no smaller than the number of text tokens.',
    ]) assert.equal(agent._isContextOverflowFailure(await upstream(overflow)), true, overflow);
    assert.equal(agent._isContextOverflowFailure(http(400, "This model's maximum context length is 128000 tokens.")), true);
    assert.equal(agent._isContextOverflowFailure(new Error('The input token count (1050000) exceeds the maximum number of tokens allowed (1048576).')), true);
  });

  test(`${build}: only per-minute input-token limits are token limits`, () => {
    const agent = new Agent({});
    const http = (httpStatus, message, code) => Object.assign(new Error(message), { httpStatus }, code ? { code } : {});
    for (const tokenLimit of [
      `Anthropic stream error 429: {"type":"error","error":{"type":"rate_limit_error","message":"${ANTHROPIC_ITPM}"}}`,
      'Anthropic error 429: Number of request tokens has exceeded your per-minute rate limit (https://docs.anthropic.com/en/api/rate-limits); see the response headers for current usage. Please reduce the prompt length or the maximum tokens requested, or try again later.',
      'openai error 429: Rate limit reached for gpt-4o in organization org-x on tokens per min (TPM): Limit 30000, Used 29000, Requested 2000. Please try again in 2s.',
      'Azure OpenAI error 429: Requests to the ChatCompletions_Create Operation have exceeded token rate limit of your current OpenAI S0 pricing tier.',
    ]) assert.equal(agent._isTokenRateLimit(http(429, tokenLimit)), true, tokenLimit);
    for (const other of [
      http(429, `Anthropic error 429: ${ANTHROPIC_OTPM}`),
      http(429, 'openrouter error 429: Rate limit exceeded: free-models-per-min.'),
      http(429, 'openai error 429: Rate limit reached for gpt-4o in organization org-x on requests per min (RPM): Limit 3, Used 3, Requested 1.'),
      http(529, 'Anthropic error 529: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}'),
      http(429, `openai error 429: ${OPENAI_QUOTA.message} (tokens per min)`, 'insufficient_quota'),
      http(400, ANTHROPIC_ITPM),
    ]) assert.equal(agent._isTokenRateLimit(other), false, other.message);
  });

  test(`${build}: a per-minute token limit trims only when the request alone reaches it`, () => {
    const agent = new Agent({});
    const refusal = message => Object.assign(new Error(`provider error 429: ${message}`), { httpStatus: 429 });
    const tokens = count => () => count;
    // The provider's own count decides, whatever the local estimate says.
    assert.equal(agent._tokenLimitRemedy(refusal(OPENAI_TPM), tokens(1e6)), 'wait');
    assert.equal(agent._tokenLimitRemedy(refusal(OPENAI_TOO_LARGE), tokens(10)), 'trim');
    assert.equal(agent._tokenLimitRemedy(refusal('Rate limit reached for model `llama-3.3-70b-versatile` in organization `org_x` service tier `on_demand` on tokens per minute (TPM): Limit 6000, Used 5000, Requested 2000. Please try again in 10s.'), tokens(1e6)), 'wait');
    // Otherwise the local estimate decides, only well away from the stated limit.
    assert.equal(agent._tokenLimitRemedy(refusal(ANTHROPIC_ITPM), tokens(7700)), 'wait');
    assert.equal(agent._tokenLimitRemedy(refusal(ANTHROPIC_ITPM), tokens(37500)), 'trim');
    for (const near of [15000, 30000, 37499]) assert.equal(agent._tokenLimitRemedy(refusal(ANTHROPIC_ITPM), tokens(near)), 'probe', String(near));
    // Without a stated limit nothing is known.
    assert.equal(agent._tokenLimitRemedy(refusal(AZURE_TOKEN_LIMIT), tokens(1e6)), 'probe');
    assert.equal(agent._tokenLimitRemedy(refusal('Number of request tokens has exceeded your per-minute rate limit (https://docs.anthropic.com/en/api/rate-limits); see the response headers for current usage.'), tokens(10)), 'probe');
    for (const other of [refusal(ANTHROPIC_OTPM), refusal('Rate limit exceeded: free-models-per-min.'), Object.assign(new Error(OPENAI_TPM), { httpStatus: 400 })]) {
      assert.equal(agent._tokenLimitRemedy(other, tokens(1e6)), null, other.message);
    }
  });

  for (const [entry, path] of [['ask', 'Ask'], ['stream', 'the streaming loop']]) {
    test(`${build}: ${path} trims at once when the request alone exceeds Anthropic's per-minute input-token limit`, async () => {
      const { result, requests, updates, cooldownMs, agent } = await run(Agent, OpenAICompatibleProvider,
        refusedUntilTrimmed(itpm), { entry, history: history(OVERSIZED), standalone: false });
      assert.equal(result, 'Hello there.');
      assert.equal(agent.testStatus, 'done');
      assert.deepEqual(sizes(requests).map(size => size > 20), [true, false], `${sizes(requests)}`);
      assert.equal(cooldownMs, 0, 'no wait can make it fit');
      assert.deepEqual(warnings(updates), []);
      assert.equal(trimNotes(updates), 1);
      assert.equal(recovery(updates), undefined);
    });
  }

  test(`${build}: OpenAI's "Request too large" trims at once in Ask and Act, and only once`, async () => {
    for (const entry of ['ask', 'stream']) {
      const recovered = await run(Agent, OpenAICompatibleProvider, refusedUntilTrimmed(limited(OPENAI_TOO_LARGE)),
        { entry, history: history(), standalone: false });
      assert.equal(recovered.result, 'Hello there.', entry);
      assert.deepEqual(sizes(recovered.requests).map(size => size > 20), [true, false], entry);
      assert.equal(recovered.cooldownMs, 0, `${entry}: no cooldowns before the trim`);
      assert.equal(trimNotes(recovered.updates), 1, entry);
      // A trim that cannot help ends the run instead of repeating every step.
      const persistent = await run(Agent, OpenAICompatibleProvider, () => limited(OPENAI_TOO_LARGE)(),
        { entry, history: history(), standalone: false });
      assert.equal(persistent.requests.length, 2, `${entry}: ${sizes(persistent.requests)}`);
      assert.equal(persistent.cooldownMs, 0, entry);
      assert.equal(trimNotes(persistent.updates), 1, entry);
      assert.equal(persistent.agent.testStatus, 'error', entry);
    }
  });

  test(`${build}: the streaming loop trims at once for a native Anthropic 429 the request alone exceeds`, async () => {
    const anthropicSse = (...events) => new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''),
      { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
    const nativeItpm = () => new Response(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: ANTHROPIC_ITPM } }),
      { status: 429, headers: { 'retry-after': '4' } });
    const reply = () => anthropicSse(
      { type: 'message_start', message: { usage: { input_tokens: 12, output_tokens: 0 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hello there.' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 3 } },
      { type: 'message_stop' },
    );
    const { result, requests, updates, cooldownMs, agent } = await run(Agent, OpenAICompatibleProvider,
      body => body.messages.length > 20 ? nativeItpm() : reply(),
      { entry: 'stream', history: history(OVERSIZED), standalone: false, provider: () => new AnthropicProvider({ apiKey: 'test', model: 'claude-sonnet-5' }) });
    assert.equal(result, 'Hello there.');
    assert.equal(agent.testStatus, 'done');
    assert.deepEqual(sizes(requests).map(size => size > 20), [true, false], `${sizes(requests)}`);
    assert.equal(cooldownMs, 0);
    assert.equal(trimNotes(updates), 1);
  });

  test(`${build}: a request under the per-minute limit waits and fails with its history intact`, async () => {
    for (const entry of ['ask', 'stream']) {
      // OpenAI reports the request's size; Anthropic's size is estimated.
      for (const limit of [limited(OPENAI_TPM), itpm]) {
        const { requests, updates, cooldownMs, agent, tab } = await run(Agent, OpenAICompatibleProvider, () => limit(),
          { entry, history: history(), standalone: false });
        assert.equal(requests.length, 4, entry);
        assert.equal(new Set(sizes(requests)).size, 1, `${entry}: never trimmed (${sizes(requests)})`);
        assert.ok(cooldownMs >= 40000 && cooldownMs <= 60000, `${entry}: cooldown ${cooldownMs}`);
        assert.equal(trimNotes(updates) + trialNotes(updates), 0, entry);
        assert.equal(agent.testStatus, 'error', entry);
        assert.equal(oldQuestions(agent, tab), 30, `${entry}: the conversation is kept`);
      }
    }
  });

  test(`${build}: an unsized token limit gets one trial on a trimmed copy, kept only if accepted`, async () => {
    for (const entry of ['ask', 'stream']) {
      const refused = await run(Agent, OpenAICompatibleProvider, () => limited(AZURE_TOKEN_LIMIT)(),
        { entry, history: history(), standalone: false });
      assert.equal(refused.requests.length, 5, `${entry}: one request, three cooldown retries, one trial (${sizes(refused.requests)})`);
      assert.ok(refused.requests[4].messages.length < refused.requests[3].messages.length, entry);
      assert.ok(refused.cooldownMs <= 60000, `${entry}: the trial is one request (${refused.cooldownMs})`);
      assert.equal(trialNotes(refused.updates), 1, entry);
      assert.equal(refused.agent.testStatus, 'error', entry);
      assert.equal(oldQuestions(refused.agent, refused.tab), 30, `${entry}: the refused trial leaves the conversation intact`);
      const accepted = await run(Agent, OpenAICompatibleProvider, refusedUntilTrimmed(limited(AZURE_TOKEN_LIMIT)),
        { entry, history: history(), standalone: false });
      assert.equal(accepted.result, 'Hello there.', entry);
      assert.equal(accepted.requests.length, 5, entry);
      assert.ok(oldQuestions(accepted.agent, accepted.tab) < 30, `${entry}: the accepted trim is kept`);
    }
  });

  test(`${build}: Ask never regenerates shown text to try a trimmed copy`, async () => {
    const shownThenLimited = () => sse({ choices: [{ index: 0, delta: { content: 'Partial ' } }] },
      inStream({ code: 'rate_limit_exceeded', message: AZURE_TOKEN_LIMIT }));
    const { requests, updates, agent, tab } = await run(Agent, OpenAICompatibleProvider,
      [limited(AZURE_TOKEN_LIMIT), shownThenLimited], { history: history(), standalone: false });
    assert.equal(requests.length, 2);
    assert.equal(trialNotes(updates), 0);
    assert.equal(agent.testStatus, 'error');
    assert.equal(oldQuestions(agent, tab), 30);
    assert.ok(updates.some(update => update.type === 'text' && update.data.replace === true && update.data.content === ''),
      'the partial text is retracted');
  });

  test(`${build}: rate limits that clear in the cooldowns or do not limit input tokens never trim`, async () => {
    const cleared = await run(Agent, OpenAICompatibleProvider, [itpm, () => answer('Hello there.')], { history: history(), standalone: false });
    assert.equal(cleared.result, 'Hello there.');
    assert.deepEqual(sizes(cleared.requests), [sizes(cleared.requests)[0], sizes(cleared.requests)[0]]);
    assert.equal(trimNotes(cleared.updates) + trialNotes(cleared.updates), 0);
    for (const entry of ['ask', 'stream']) {
      for (const limit of [httpLimit, limited(ANTHROPIC_OTPM)]) {
        const persistent = await run(Agent, OpenAICompatibleProvider, () => limit(), { entry, history: history(), standalone: false });
        assert.equal(persistent.requests.length, 4, entry);
        assert.equal(new Set(sizes(persistent.requests)).size, 1, `${entry}: never trimmed (${sizes(persistent.requests)})`);
        assert.equal(trimNotes(persistent.updates) + trialNotes(persistent.updates), 0, entry);
        assert.equal(persistent.agent.testStatus, 'error', entry);
      }
    }
  });

  test(`${build}: an OpenAI insufficient_quota 429 fails at once without cooldowns or trimming`, async () => {
    const quota = () => new Response(JSON.stringify({ error: OPENAI_QUOTA }), { status: 429 });
    for (const entry of ['ask', 'stream']) {
      const { requests, updates, cooldownMs, agent } = await run(Agent, OpenAICompatibleProvider, [quota],
        { entry, history: history(), standalone: false });
      assert.equal(requests.length, 1, entry);
      assert.equal(cooldownMs, 0, entry);
      assert.deepEqual(warnings(updates), [], `${entry}: not reported as rate limiting`);
      assert.equal(trimNotes(updates) + trialNotes(updates), 0, entry);
      assert.equal(agent.testStatus, 'error', entry);
      assert.equal(recovery(updates)?.code, 'insufficient_quota', entry);
      assert.match(recovery(updates)?.diagnostics || '', /exceeded your current quota/, entry);
    }
  });

  // WebBrain Companion answers HTTP 429 model_cooldown with the reset it
  // knows (QA 2026-11-13 A1: "Individual quota reached ... Resets in
  // 43h56m18s."). Only a reset within model-retry's minute is waited out.
  const companion = () => new OpenAICompatibleProvider({ providerName: 'webbrain-companion',
    baseUrl: 'http://127.0.0.1:8327/v1', model: 'gemini-3.8-flash-high', supportsAskStreaming: true });
  const companionCooldown = fields => () => new Response(JSON.stringify({ error: { code: 'model_cooldown',
    message: 'All credentials for model gemini-3.8-flash-high are cooling down', ...fields } }), { status: 429 });
  const COMPANION_QUOTA = { last_upstream_error: JSON.stringify({ error: { code: 429, status: 'RESOURCE_EXHAUSTED',
    message: 'Individual quota reached. Resets in 43h56m18s.' } }) };

  test(`${build}: a Companion quota that resets hours away fails at once in Ask and the streaming loop`, async () => {
    for (const entry of ['ask', 'stream']) {
      const { requests, updates, cooldownMs, agent } = await run(Agent, OpenAICompatibleProvider,
        [companionCooldown(COMPANION_QUOTA)], { entry, provider: companion });
      assert.equal(requests.length, 1, entry);
      assert.equal(cooldownMs, 0, entry);
      assert.deepEqual(warnings(updates), [], `${entry}: not reported as rate limiting`);
      assert.equal(agent.testStatus, 'error', entry);
      assert.equal(recovery(updates)?.code, 'model_cooldown', entry);
      assert.match(recovery(updates)?.diagnostics || '', /provider quota\. The provider reports a reset in 43h56m18s/, entry);
    }
  });

  test(`${build}: a Companion cooldown that ends within the minute is waited out`, async () => {
    const { result, requests, cooldownMs } = await run(Agent, OpenAICompatibleProvider,
      [companionCooldown({ reset_seconds: 12, reset_time: '12s' }), () => answer('Hello there.')], { provider: companion });
    assert.equal(result, 'Hello there.');
    assert.equal(requests.length, 2);
    assert.equal(cooldownMs, 12000);
  });

  test(`${build}: a WebBrain Cloud tier 402 stays an allowance stop, not a rate limit`, async () => {
    const cloud = () => new Response(JSON.stringify({ error: { code: 'webbrain_cloud_free_tier_exceeded', message: 'Weekly free WebBrain Compass allowance used.' },
      subscribe_url: 'https://webbrain.one/subscribe' }), { status: 402 });
    const { requests, updates, cooldownMs, agent } = await run(Agent, OpenAICompatibleProvider, [cloud], {
      entry: 'stream', provider: () => new OpenAICompatibleProvider({ providerName: 'webbrain-cloud', baseUrl: 'https://api.webbrain.one/v1', model: 'compass' }),
    });
    assert.equal(requests.length, 1);
    assert.equal(cooldownMs, 0);
    assert.equal(agent.testStatus, 'cost_limit');
    assert.equal(updates.find(update => update.type === 'quota')?.data.quota.code, 'webbrain_cloud_free_tier_exceeded');
  });

  test(`${build}: Ask retries a Cloud "context deadline exceeded" failure instead of trimming`, async () => {
    const { result, requests, updates, cooldownMs } = await run(Agent, OpenAICompatibleProvider, [
      () => sse(inStream({ code: 'webbrain_cloud_upstream_error', message: 'upstream request failed: context deadline exceeded' })),
      () => answer('Hello there.'),
    ], { history: history(), standalone: false });
    assert.equal(result, 'Hello there.');
    assert.equal(cooldownMs, 2000);
    assert.deepEqual(sizes(requests), [sizes(requests)[0], sizes(requests)[0]], 'the same request is retried');
    assert.equal(trimmed(updates), false);
  });

  test(`${build}: the streaming loop retries a rate limit after reasoning alone and keeps only the new reasoning`, async () => {
    const reasoning = text => ({ choices: [{ index: 0, delta: { reasoning: text } }] });
    const saved = [];
    const { result, requests, updates, cooldownMs } = await run(Agent, OpenAICompatibleProvider, [
      () => sse(reasoning('stale thoughts'), inStream(LIMIT)),
      () => sse(reasoning('fresh thoughts'), { choices: [{ index: 0, delta: { content: 'Hello there.' } }] },
        { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }, '[DONE]'),
    ], {
      entry: 'stream',
      setup: agent => {
        const withResponseItems = agent._withResponseItems.bind(agent);
        agent._withResponseItems = (message, items, reasoningContent, provider) => {
          saved.push(reasoningContent);
          return withResponseItems(message, items, reasoningContent, provider);
        };
      },
    });
    assert.equal(result, 'Hello there.');
    assert.equal(requests.length, 2);
    assert.deepEqual(requests[0].messages, requests[1].messages);
    assert.ok(cooldownMs >= 4000 && cooldownMs <= 6000, `cooldown ${cooldownMs}`);
    assert.deepEqual(saved, ['fresh thoughts'], 'the failed attempt left no reasoning behind');
    assert.equal(updates.filter(update => update.type === 'thinking' && !update.data?.note).length, 1, 'retried within the same step');
    assert.equal(updates.filter(update => /could not start the response/.test(update.data?.note || '')).length, 1);
    assert.equal(trimmed(updates), false);
  });

  test(`${build}: the streaming loop never retries a rate limit once text followed the reasoning`, async () => {
    const { requests, updates, cooldownMs, agent } = await run(Agent, OpenAICompatibleProvider, [
      () => sse({ choices: [{ index: 0, delta: { reasoning: 'thoughts' } }] }, { choices: [{ index: 0, delta: { content: 'Partial' } }] }, inStream(LIMIT)),
    ], { entry: 'stream' });
    assert.equal(requests.length, 1);
    assert.equal(cooldownMs, 0);
    assert.equal(agent.testStatus, 'error');
    assert.ok(updates.some(update => update.type === 'text_delta' && update.data.content === 'Partial'));
  });
}
