import assert from 'node:assert/strict';
import test from 'node:test';

const area = { get: async () => ({}), set: async () => {}, remove: async () => {} };
globalThis.chrome = globalThis.browser = { storage: { local: area, session: area },
  runtime: { getURL: x => x, sendMessage: async () => ({}) } };
const json = body => new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } });
let nextTab = 7200;

for (const build of ['chrome', 'firefox']) {
  const { Agent } = await import(`../src/${build}/src/agent/agent.js`);
  const { normalizeVideoDurationContract: normalize, pinVideoDurationTarget: pin,
    recordVideoDurationResult: receipt, videoDurationCompletionBlock: block, videoDurationTolerance: tolerance } = await import(`../src/${build}/src/agent/video-duration-contract.js`);
  const target = () => ({ requestedSeconds: 60, status: 'pending' });
  const delivered = seconds => ({ success: true, url: 'https://media.example/video.mp4', mimeType: 'video/mp4', durationSeconds: seconds });
  function fixture() {
    const agent = new Agent({}), tab = nextTab++;
    agent.conversations.set(tab, [{ role: 'user', content: 'Explain this in a one minute video.' }]);
    agent.conversationIds.set(tab, `conversation-${tab}`);
    agent.conversationModes.set(tab, 'act');
    agent._persist = () => {};
    agent._persistNow = async () => ({ ok: true });
    const guard = agent._startPlanExecutionGuard(tab, 'act', { requestKind: 'execute', requiresStateChange: false });
    return { agent, tab, guard };
  }

  test(`${build}: retries cannot drop or reduce the duration, including after failure`, () => {
    let value = pin({ media: 'video', estimated_duration: 60, prompt: 'Make it.' }).contract;
    value = receipt(value, { success: false, error: 'Scene too long' });
    for (const args of [{ prompt: 'Retry the video.' }, { media: 'video' }, { media: 'video', estimated_duration: 5, duration: 5 }]) {
      const retried = pin(args, value);
      assert.equal(retried.args.estimated_duration, 60);
      assert.equal(retried.contract.requestedSeconds, 60);
    }
    assert.equal(pin({ media: 'image' }, value).contract.requestedSeconds, 60);
    assert.equal(pin({ estimated_duration: 60, scenes: [] }).contract.requestedSeconds, 60);
    assert.equal(pin({ media: 'video' }).contract, null, 'an unspecified standalone clip stays supported');
  });

  test(`${build}: only one measured video can satisfy the target`, () => {
    assert.equal(block(receipt(target(), delivered(5))).durationStatus, 'short');
    assert.equal(block(receipt(target(), delivered(61))), null, 'the requested sixty, not a rounded plan of sixty-four');
    assert.ok(block(receipt(target(), { ...delivered(64), joined: false })));
    assert.ok(block(receipt(target(), { success: true, url: 'https://media.example/v.mp4', durationStatus: 'enough', plannedSeconds: 64 })));
    assert.ok(block(receipt(target(), { success: true, durationSeconds: 64, mimeType: 'video/mp4' })));
    assert.ok(block(receipt(target(), { ...delivered(64), error: 'failed' })));
    assert.equal(receipt(receipt(target(), delivered(30)), delivered(30)).durationSeconds, 30, 'do not sum separate retries');
    assert.equal(receipt(receipt(target(), delivered(64)), { success: false }).status, 'enough', 'keep a completed deliverable');
    assert.deepEqual(pin({ prompt: 'A thumbnail image' }, receipt(target(), delivered(64))).args, { prompt: 'A thumbnail image' });
    assert.equal(block(receipt(target(), delivered(5)), 'partial'), null);
    assert.equal(block(receipt(target(), delivered(5)), 'failed'), null);
    assert.ok(block(normalize({ requestedSeconds: 60, status: 'enough' })));
    assert.equal(normalize({ requestedSeconds: Infinity }), null);
  });

  test(`${build}: a video made of clips may be a frame short for each clip`, () => {
    assert.deepEqual([undefined, 1, 2, 8, 24, 1000, -3, 2.5].map(count => Math.round(tolerance(count) * 100) / 100),
      [0.25, 0.25, 0.35, 0.95, 2.55, 2.55, 0.25, 0.25]);
    // One clip keeps the quarter second it had.
    assert.equal(block(receipt(target(), delivered(59.8))), null);
    assert.equal(block(receipt(target(), delivered(59.7))).durationStatus, 'short');
    // Eight clips of 7.4 s for a minute: 59.2 s is enough, 59 s is not.
    const joined = receipt(target(), { ...delivered(59.2), clipCount: 8 });
    assert.deepEqual([joined.status, joined.clipCount, block(joined)], ['enough', 8, null]);
    assert.equal(normalize(structuredClone(joined)).status, 'enough', 'a restored receipt keeps its clip count');
    assert.equal(normalize({ ...joined, clipCount: undefined }).status, 'short', 'the tolerance is the measured video\'s own');
    assert.equal(block(receipt(target(), { ...delivered(59), clipCount: 8 })).durationStatus, 'short');
    // A later result of the same video is judged by its own clips.
    assert.equal(receipt(receipt(target(), { ...delivered(50), clipCount: 8 }), delivered(59.2)).clipCount, undefined);
    assert.equal(receipt(receipt(target(), { ...delivered(50), clipCount: 8 }), delivered(59.2)).status, 'short');
  });

  test(`${build}: only an approved shorter runtime result changes the effective target`, () => {
    const long = { requestedSeconds: 330, status: 'pending', videoId: 'explainer' };
    assert.ok(block(receipt(long, delivered(120))));
    const approved = receipt(long, { ...delivered(120), approvedDurationSeconds: 120 });
    assert.equal(approved.requestedSeconds, 330);
    assert.equal(approved.approvedDurationSeconds, 120);
    assert.equal(block(approved), null);
    assert.equal(pin({ media: 'video', video_id: 'explainer', estimated_duration: 5 }, approved).args.estimated_duration, 120);
  });

  test(`${build}: a rejected scene generation cannot retry as a default short paid clip`, async () => {
    const { agent, tab, guard } = fixture();
    const originalFetch = globalThis.fetch;
    let submits = 0, saved = 0;
    agent._persistNow = async () => { saved++; return { ok: true }; };
    globalThis.fetch = async (url, init = {}) => {
      if (init.method === 'POST') {
        submits++;
        assert.equal(JSON.parse(init.body).duration, 15, 'only the original full scene plan may be submitted');
        return new Response(JSON.stringify({ error: 'Fixture provider rejected this clip length.' }), { status: 422 });
      }
      if (url.startsWith('https://api.fal.ai/')) return json({ models: [] });
      assert.ok(url.startsWith('https://fal.ai/api/openapi/queue/openapi.json'));
      return json({});
    };
    try {
      const context = { imageGenConfig: { provider: 'fal', apiKey: 'fixture', videoModel: 'minimax/h3-max/text-to-video' } };
      const first = await agent._executeToolImpl(tab, 'generate_image', {
        prompt: 'Explain the Minkowski sum.', estimated_duration: 60,
        scenes: Array.from({ length: 4 }, (_, i) => ({ prompt: `Distinct scene ${i}`, duration: 15 })),
      }, () => {}, context);
      assert.equal(first.success, false);
      assert.equal(guard.videoDurationContract.requestedSeconds, 60);
      assert.match(first.error, /422/);
      const firstSubmits = submits;
      assert.ok(firstSubmits > 0, 'missing metadata no longer prevents the explicit scene plan');
      for (const retry of [{ prompt: 'Explain the Minkowski sum.' }, { media: 'video', prompt: 'Explain the Minkowski sum.' },
        { media: 'video', prompt: 'Explain it.', duration: 5, estimated_duration: 5 }]) {
        const result = await agent._executeToolImpl(tab, 'generate_image', retry, () => {}, context);
        assert.equal(result.success, false);
        assert.match(result.error, /estimated_duration: 60|requested video needs 60 s/);
      }
      assert.equal(submits, firstSubmits, 'target-losing retries never submit another paid clip');
      assert.equal(saved, 8, 'save target before each attempt and its result afterward');
    } finally { globalThis.fetch = originalFetch; }
  });

  test(`${build}: Strict checks refuse short or unverified results through done, JSON and plain text`, async () => {
    for (const result of [delivered(5), { success: true, url: 'https://media.example/v.mp4' }, { ...delivered(64), joined: false }]) {
      const { agent, tab, guard } = fixture();
      guard.videoDurationContract = receipt(target(), result);
      guard.successfulTaskToolCalls = guard.successfulConsequentialToolCalls = 99;
      guard.evidenceTaskKey = guard.taskKey;
      agent.strictGuards = true;
      agent._leanRunActive = () => false;
      agent._resolveExactTableDone = async () => assert.fail('video guard must precede table and lean completion');
      assert.ok(agent._completionDoneBlock(tab, 'done', { outcome: 'success' }));
      for (let i = 0; i < 2; i++) {
        const done = await agent._executeToolImpl(tab, 'done', { outcome: 'success', summary: 'The video is ready.' }, () => {});
        assert.equal(done.blockedDone, true);
        assert.equal(done.videoDurationIncomplete, true);
      }
      agent.cloudRunContexts.set(tab, { outputSchema: { type: 'object' } });
      const structured = await agent._executeToolImpl(tab, 'done_json', { result: {}, summary: 'Complete.' }, () => {});
      assert.equal(structured.videoDurationIncomplete, true);
      assert.equal(agent._planOnlyTerminalDecision(tab, 'Here is the full minute.').retry, true);
      assert.equal(agent._planOnlyTerminalDecision(tab, 'Here is the full minute.').retry, true);
      agent._resolveExactTableDone = async () => null;
      agent._leanRunActive = () => true;
      const partial = await agent._executeToolImpl(tab, 'done', { outcome: 'partial', summary: 'Only a short clip is available.' }, () => {});
      assert.equal(partial.done, true);
      assert.equal(partial.outcome, 'partial');
    }
  });

  test(`${build}: a measured sufficient receipt passes the duration check`, async () => {
    const { agent, tab, guard } = fixture();
    guard.videoDurationContract = receipt(target(), delivered(64));
    agent._resolveExactTableDone = async () => null;
    agent._leanRunActive = () => true;
    agent._leanChatReceiptBlock = async () => null;
    assert.equal(agent._videoDurationDoneBlock(tab), null);
    assert.equal((await agent._executeToolImpl(tab, 'done', { outcome: 'success', summary: '64 seconds.' }, () => {})).done, true);
  });

  test(`${build}: an accepted shorter target survives a failed provider request`, async () => {
    const { agent, tab, guard } = fixture();
    const originalFetch = globalThis.fetch;
    let confirmations = 0, submits = 0;
    agent._promptVideoLengthConfirmation = async () => { confirmations++; return 'once'; };
    const openapi = { openapi: '3.0.4', paths: { '/model': { post: { requestBody: { content: {
      'application/json': { schema: { type: 'object', properties: { prompt: { type: 'string' }, duration: { type: 'integer', enum: [15] } } } },
    } } } } } };
    globalThis.fetch = async (url, init = {}) => {
      if (init.method === 'POST') {
        submits++;
        assert.equal(guard.videoDurationContract.approvedDurationSeconds, 120, 'persist approval before the paid request');
        return new Response('provider rejected', { status: 400 });
      }
      assert.ok(url.startsWith('https://api.fal.ai/'));
      return json({ models: [{ endpoint_id: 'fixture/video', openapi }] });
    };
    try {
      const context = { imageGenConfig: { provider: 'fal', apiKey: 'fixture', videoModel: 'fixture/video' } };
      const result = await agent._executeToolImpl(tab, 'generate_image', {
        media: 'video', prompt: 'A long explainer', estimated_duration: 330,
        scenes: Array.from({ length: 8 }, (_, i) => ({ prompt: `Scene ${i}`, duration: 15 })),
      }, () => {}, context);
      assert.equal(result.success, false);
      assert.ok(submits > 0);
      assert.equal(confirmations, 1);
      assert.equal(guard.videoDurationContract.requestedSeconds, 330);
      assert.equal(guard.videoDurationContract.approvedDurationSeconds, 120);
      assert.equal(pin({ prompt: 'Retry' }, guard.videoDurationContract).args.estimated_duration, 120);
    } finally { globalThis.fetch = originalFetch; }
  });

  test(`${build}: steering queued during persistence prevents a new paid dispatch`, async () => {
    const { agent, tab } = fixture();
    agent._persistNow = async () => { agent._hasPendingSteering = () => true; return { ok: true }; };
    const result = await agent._executeToolImpl(tab, 'generate_image', { media: 'video', estimated_duration: 60, prompt: 'Video' }, () => {});
    assert.equal(result.dispatched, false);
    assert.match(result.error, /changed or stopped/);
  });

  test(`${build}: a late result cannot overwrite a replacement task contract`, async () => {
    const { agent, tab, guard } = fixture();
    const originalFetch = globalThis.fetch;
    let finish, started;
    const wait = new Promise(resolve => { finish = resolve; });
    const began = new Promise(resolve => { started = resolve; });
    globalThis.fetch = async () => { started(); await wait; return json({}); };
    try {
      const pending = agent._executeToolImpl(tab, 'generate_image', { media: 'video', estimated_duration: 60, prompt: 'Video' }, () => {},
        { imageGenConfig: { provider: 'fal', apiKey: 'fixture', videoModel: 'fixture/video' } });
      await began;
      const replacement = { ...guard, videoDurationContract: { requestedSeconds: 8, status: 'pending' } };
      agent._planExecutionGuards.set(tab, replacement);
      finish();
      assert.equal((await pending).success, false);
      assert.deepEqual(replacement.videoDurationContract, { requestedSeconds: 8, status: 'pending' });
    } finally { finish(); globalThis.fetch = originalFetch; }
  });

  test(`${build}: storage failure blocks dispatch and changing tasks detaches old receipts`, async () => {
    const { agent, tab, guard } = fixture();
    agent._persistNow = async () => ({ ok: false });
    const result = await agent._executeToolImpl(tab, 'generate_image', { media: 'video', estimated_duration: 60, prompt: 'Video' }, () => {});
    assert.equal(result.dispatched, false);
    assert.equal(guard.videoDurationContract.requestedSeconds, 60);
    agent.conversationIds.set(tab, 'another-conversation');
    assert.equal(agent._currentVideoDurationGuard(tab), null);
  });
}
