import { strict as assert } from 'node:assert';
import { test } from 'node:test';

// The X/Bluesky publication contract and draft audit start in the background
// after the draft is written, so the click on Post does not wait for them.
// These tests drive the real Agent with a fake checker model that records
// every call with its start and end, and can hold a call open until released.

const ref = (text, source = 'request') => ({ source, start: text, end: text });
const count = (type = 'any', min = 0, max = 0, format = null) => ({ kind: 'count', type, format, min, max });
const rawAction = (id, platform, text = 'Hello', kind = 'exact') => ({ id, platform, account: null,
  posts: [{ body: { kind, source: ref(text) }, media: count(), context: { kind: 'post', target: null } }] });
const rawContract = (actions = [rawAction('p1', 'twitter')], requirements = 'p1') => ({
  version: 1, status: 'ready', actions, requirements, prohibited: [], reason: 'User requested publication.',
});
const snapshot = (bodyText = 'Hello', account = 'twitter:alice') => ({ complete: true, account,
  posts: [{ complete: true, bodyText, attachments: [], context: { kind: 'post', target: null } }] });
const deferred = () => {
  let release;
  const promise = new Promise(resolve => { release = resolve; });
  return { promise, release };
};
// An X route whose sends the recipient guard checks, so the prefetch reads
// whether a control sends a message as well as what it does. X's public post
// composer (/compose/post) binds no recipient, so only control_effect is read
// there.
const GUARDED_PAGE = 'https://x.com/messages';
const settle = async (turns = 20) => { for (let i = 0; i < turns; i++) await new Promise(resolve => setImmediate(resolve)); };
const until = async (predicate, message) => {
  for (let i = 0; i < 400; i++) {
    if (predicate()) return;
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.fail(message);
};
// A promise that must settle soon: a hang fails the test instead of the run.
const within = async (promise, message, ms = 2000) => {
  let timer;
  const late = new Promise((_resolve, reject) => { timer = setTimeout(() => reject(new Error(`timed out: ${message}`)), ms); });
  try {
    return await Promise.race([promise, late]);
  } finally {
    clearTimeout(timer);
  }
};

for (const browser of ['chrome', 'firefox']) {
  const { Agent } = await import(`../src/${browser}/src/agent/agent.js`);
  const { projectTraceEventData } = await import(`../src/${browser}/src/trace/privacy.js`);
  const { resolveAdapterWorkflowJob } = await import(`../src/${browser}/src/agent/adapters.js`);

  function setup({ request = 'Post Hello on X', contract = rawContract(), authorize = () => true,
    pageUrl = 'https://x.com/compose/post' } = {}) {
    const provider = { model: 'fake-checker', chat: async () => ({ content: '{}' }) };
    const agent = new Agent({ getActive: () => provider });
    const tabId = 811;
    const f = { agent, tabId, provider, contract, authorize, calls: [], probes: [], readings: [], holds: {},
      pageUrl };
    agent.useSiteAdapters = true;
    agent._persist = () => {};
    agent._currentUrl = async () => f.pageUrl;
    agent.conversations.set(tabId, [{ role: 'system', content: 'system' }, { role: 'user', content: request }]);
    f.guard = agent._startPlanExecutionGuard(tabId, 'act', { requestKind: 'execute', requiresStateChange: true, requiresSubmission: true });
    agent._chatWithCostAllowance = async (usedProvider, messages, options, cost, meta) => {
      assert.equal(usedProvider, provider);
      const signal = options?.signal || null;
      const call = { name: meta.generationName, startedAt: Date.now(), endedAt: null, done: false, cost, signal, aborted: false };
      f.calls.push(call);
      // Like a provider that honors its request's signal.
      const aborted = () => {
        call.aborted = true;
        const error = new Error('The request was aborted.');
        error.name = 'AbortError';
        return error;
      };
      const input = JSON.parse(messages[1].content);
      if (meta.generationName === 'social_publication_authorization') call.key = input.key;
      if (signal?.aborted) throw aborted();
      const hold = f.holds[meta.generationName];
      if (hold) {
        delete f.holds[meta.generationName];
        hold.started = true;
        await new Promise((resolve, reject) => {
          hold.promise.then(resolve);
          if (f.honorAbort !== false) signal?.addEventListener('abort', () => reject(aborted()), { once: true });
        });
      }
      call.endedAt = Date.now();
      call.done = true;
      if (meta.generationName === 'social_publication_authorization') {
        const authorized = f.authorize(input);
        return { content: JSON.stringify({ key: input.key, actionId: input.action.id, authorized,
          reason: authorized ? 'The draft matches the request.' : 'The draft does not match the request.' }) };
      }
      return { content: JSON.stringify(f.contract) };
    };
    f.detected = { isSubmit: true, publicationControl: true, publicationResourceUrls: [], publicationResourceUrlsComplete: true,
      frameDocumentIdentity: 'https://x.com/compose/post|fixture-document-1',
      publicationAccountIdentity: 'twitter:alice', publicationAccountIdentityComplete: true, publicationSnapshot: snapshot() };
    // The same probe answers the prefetch (its publish-control hint) and the click.
    agent._detectLikelySubmitAction = async (_tabId, name, args, options = {}) => {
      f.probes.push({ name, args: structuredClone(args), captionPass: options.captionPass || 'collect' });
      const detected = structuredClone(f.detected);
      // One probe can see a changed composer while later ones do not.
      if (f.probeOnce) {
        Object.assign(detected, f.probeOnce);
        f.probeOnce = null;
      }
      return detected;
    };
    agent._readPageTexts = async (_tabId, kind, texts, _context, options = {}) => { f.readings.push({ kind, texts: [...texts], options }); };
    f.hold = name => { const gate = deferred(); f.holds[name] = gate; return gate; };
    f.named = name => f.calls.filter(call => call.name === name);
    f.write = (args = { ref_id: 'ref_7', text: 'Hello', clear: true }) => agent._socialPublicationPrefetch(
      tabId, 'type_ax', args, { success: true, verified: true }, provider);
    f.click = () => agent._workflowPreSubmitDispatchBlock(tabId, 'click_ax', { ref_id: 'ref_9' }, f.detected, provider);
    f.pending = () => agent._socialPublicationContractPrefetches?.get(f.guard) || null;
    f.applySteering = text => {
      agent._runningTabs.add(tabId);
      agent._beginSteeringRun(tabId, () => {}, { detachedRequestId: 'prefetch-steering' });
      assert.equal(agent.steerMessage(tabId, text, { requestId: 'prefetch-steering', messageId: 'revision' }).accepted, true);
      assert.equal(agent._applyPendingSteering(tabId, agent.conversations.get(tabId), () => {}), true);
      agent._finishSteeringRun(tabId);
      agent._runningTabs.delete(tabId);
    };
    return f;
  }

  test(`${browser}: the contract is compiled after the write, before the click, which then runs no checker`, async () => {
    const f = setup();
    const status = await f.write();
    assert.equal(status, 'authorized');
    assert.deepEqual(f.calls.map(call => call.name), ['social_publication_contract', 'social_publication_authorization']);
    // The compiled contract waits beside the run; the run itself is unchanged.
    const compiled = f.pending().compiled;
    assert.equal(compiled.contract.status, 'ready');
    assert.equal(f.guard.socialPublication, null);
    // The probe asked for the composer's own publish control, beside the
    // editor that was written, and went straight to the final pass.
    assert.deepEqual(f.probes[0], { name: 'click_ax', args: { __wbPublicationPrefetch: { editorRef: 'ref_7' } }, captionPass: 'final' });
    const clickAt = Date.now();
    assert(f.calls.every(call => call.done && call.endedAt <= clickAt));
    assert.equal(await f.click(), null);
    assert.equal(f.calls.length, 2, 'the click compiled nothing and audited nothing');
    assert.equal(f.guard.socialPublication, compiled, 'the click installed the contract it would have compiled');
    assert.equal(f.pending(), null);
    assert.equal(f.guard.socialPublication.dispatch.key, f.named('social_publication_authorization')[0].key);
    assert.equal(f.guard.socialPublication.prefetchedAudit, undefined, 'a verdict decides one click only');
  });

  test(`${browser}: the prefetched contract stays out of the run until the click installs it`, async () => {
    const f = setup();
    assert.equal(await f.write(), 'authorized');
    // Ordinary tool calls before the click neither bind the publish workflow
    // nor see a publication target, exactly as when nothing was prefetched.
    assert.equal(await f.agent._adoptLiveSocialPublishWorkflow(f.tabId, f.provider), false);
    assert.equal(f.guard.siteWorkflow, null);
    assert.equal(f.guard.socialPublication, null);
    assert.deepEqual(f.agent._missingSocialPublishTargets(f.guard), []);
    assert.equal(await f.click(), null);
    assert.equal(f.guard.siteWorkflow.adapterName, 'twitter');
    assert.equal(f.guard.siteWorkflow.job.id, 'publish-post');
    assert.equal(f.calls.length, 2);
  });

  test(`${browser}: the compile starts when a composer write begins, and the draft audit joins it`, async () => {
    const f = setup();
    const contract = f.hold('social_publication_contract');
    // The write is still being prepared: only the contract can start.
    const early = f.agent._socialPublicationContractPrefetch(f.tabId, 'type_ax', { ref_id: 'ref_7', text: 'Hello' }, f.provider);
    await until(() => contract.started, 'the compile started before the write finished');
    assert.equal(f.named('social_publication_authorization').length, 0);
    assert.equal(f.agent._socialPublicationContractPrefetch(f.tabId, 'type_ax', { ref_id: 'ref_7', text: 'Hello' }, f.provider), null,
      'a compile in flight is not started twice');
    // The write finished: the draft audit waits for the same compile.
    const afterWrite = f.write();
    await settle();
    assert.equal(f.named('social_publication_authorization').length, 0, 'the audit needs the contract first');
    contract.release();
    assert.equal(await early, 'contract_ready');
    assert.equal(await afterWrite, 'authorized');
    assert.deepEqual(f.calls.map(call => call.name), ['social_publication_contract', 'social_publication_authorization']);
    assert.equal(await f.click(), null);
    assert.equal(f.calls.length, 2);
  });

  test(`${browser}: a click during the background compile waits for it instead of compiling again`, async () => {
    const f = setup();
    const contract = f.hold('social_publication_contract');
    const prefetch = f.write();
    await until(() => contract.started, 'the background compile started');
    let clicked = false;
    const click = f.click().then(result => { clicked = true; return result; });
    await settle();
    assert.equal(clicked, false, 'the click waits for the compile in flight');
    assert.equal(f.guard.socialPublication, null, 'nothing is installed while the background compile runs');
    contract.release();
    assert.equal(await click, null);
    assert.equal(await prefetch, 'authorized');
    assert.equal(f.named('social_publication_contract').length, 1, 'one compile for prefetch and click');
    assert.equal(f.named('social_publication_authorization').length, 1, 'the click awaited the prefetched audit');
    assert.equal(f.guard.socialPublication.dispatch.key, f.named('social_publication_authorization')[0].key);
  });

  test(`${browser}: a click during the background audit of the same draft awaits it`, async () => {
    const f = setup();
    const audit = f.hold('social_publication_authorization');
    const prefetch = f.write();
    await until(() => audit.started, 'the background audit started');
    let clicked = false;
    const click = f.click().then(result => { clicked = true; return result; });
    await settle();
    assert.equal(clicked, false, 'the click waits for the audit in flight');
    audit.release();
    assert.equal(await click, null);
    await prefetch;
    assert.deepEqual(f.calls.map(call => call.name), ['social_publication_contract', 'social_publication_authorization']);
  });

  test(`${browser}: a changed draft, account, page or document after the prefetch is audited again at the click`, async () => {
    for (const change of ['draft', 'account', 'page', 'document']) {
      // A composed body lets the changed draft pass the click's preflight, so
      // only the binding key tells it apart from the audited one.
      const f = setup({ request: 'Tweet about my blog post',
        contract: rawContract([rawAction('p1', 'twitter', 'about my blog post', 'compose')]) });
      assert.equal(await f.write(), 'authorized', change);
      const prefetchedKey = f.named('social_publication_authorization')[0].key;
      if (change === 'draft') f.detected.publicationSnapshot.posts[0].bodyText = 'A different post about the blog';
      if (change === 'account') f.detected.publicationSnapshot.account = 'twitter:bob';
      if (change === 'page') f.pageUrl = 'https://x.com/home';
      if (change === 'document') f.detected.frameDocumentIdentity = 'https://x.com/compose/post|fixture-document-2';
      assert.equal(await f.click(), null, change);
      const audits = f.named('social_publication_authorization');
      assert.equal(audits.length, 2, `${change}: the click ran its own audit`);
      assert.notEqual(audits[1].key, prefetchedKey, change);
      assert.equal(f.guard.socialPublication.dispatch.key, audits[1].key, change);
      assert.equal(f.named('social_publication_contract').length, 1, change);
    }
  });

  test(`${browser}: a denied prefetched verdict blocks exactly like a denial at the click`, async () => {
    const deny = () => false;
    const prefetched = setup({ authorize: deny });
    assert.equal(await prefetched.write(), 'denied');
    const denied = await prefetched.click();
    assert.equal(prefetched.named('social_publication_authorization').length, 1, 'the stored verdict decided');
    const live = setup({ authorize: deny });
    const expected = await live.click();
    assert.deepEqual(denied, expected);
    assert.equal(denied.noDispatch, true);
    assert.equal(denied.failureRecovery.code, 'publication_audit_denied');
    assert.equal(denied.failureRecovery.retryMode, 'publication_audit_bypass');
    for (const key of ['deniedAuditKey', 'deniedAudit', 'dispatch']) {
      assert.deepEqual(prefetched.guard.socialPublication[key], live.guard.socialPublication[key], key);
    }
    // The cached denial holds for another attempt, and the user's Retry
    // grant applies to it exactly as to a live denial.
    assert.deepEqual(await prefetched.click(), denied);
    assert.equal(prefetched.calls.length, 2);
    assert.equal(prefetched.agent._grantSocialPublicationAuditRetry(prefetched.tabId, denied.failureRecovery), true);
    assert.equal(await prefetched.click(), null);
    assert.equal(prefetched.guard.socialPublication.dispatch.auditBypassed, true);
    assert.equal(prefetched.calls.length, 2);
  });

  test(`${browser}: steering or Stop during the background audit leaves no usable verdict`, async () => {
    for (const interruption of ['steering', 'stop']) {
      const f = setup();
      const audit = f.hold('social_publication_authorization');
      const prefetch = f.write();
      await until(() => audit.started, 'the background audit started');
      const audited = f.pending().compiled;
      if (interruption === 'steering') f.applySteering('Actually post Goodbye instead');
      else f.agent.abort(f.tabId);
      audit.release();
      assert.equal(await prefetch, 'changed', interruption);
      assert.equal(audited.prefetchedAudit, undefined, interruption);
      if (interruption === 'steering') {
        assert.equal(f.pending(), null, 'the correction dropped the background contract');
        assert.equal(f.guard.socialPublication, null);
        // The corrected task is compiled and audited again at the click.
        f.contract = rawContract([rawAction('p2', 'twitter', 'Goodbye', 'exact')], 'p2');
        f.contract.actions[0].posts[0].body.source = ref('Goodbye', 'steering_message0');
        f.detected.publicationSnapshot.posts[0].bodyText = 'Goodbye';
        assert.equal(await f.click(), null);
        assert.equal(f.named('social_publication_contract').length, 2);
        assert.equal(f.named('social_publication_authorization').length, 2);
      }
    }
  });

  test(`${browser}: steering or Stop during the background compile leaves no contract behind`, async () => {
    for (const interruption of ['steering', 'stop']) {
      const f = setup();
      const contract = f.hold('social_publication_contract');
      const prefetch = f.write();
      await until(() => contract.started, 'the background compile started');
      if (interruption === 'steering') f.applySteering('Actually post Goodbye instead');
      else f.agent.abort(f.tabId);
      contract.release();
      assert.equal(await prefetch, 'skipped', interruption);
      assert.equal(f.guard.socialPublication, null, `${interruption}: the guard is left as the prefetch found it`);
      assert.equal(f.pending(), null, interruption);
      assert.equal(f.named('social_publication_authorization').length, 0, interruption);
    }
  });

  test(`${browser}: a background check sends nothing for a run that stopped or was replaced, and never charges the next run`, async () => {
    for (const stage of ['social_publication_contract', 'social_publication_authorization']) {
      const f = setup();
      const { agent, tabId } = f;
      const startingRun = new AbortController();
      agent._runAbortStates.set(tabId, { controller: startingRun, dispose() {} });
      agent.currentCostState.set(tabId, { run: 'the run that wrote the draft' });
      // Hold the check where it awaits trace persistence: after its last
      // liveness check, before inference.
      const tracing = deferred();
      const traced = agent._tracePlannerAttemptRequest;
      let held = false;
      agent._tracePlannerAttemptRequest = async (...args) => {
        if (!held && args[4] === stage) {
          held = true;
          await tracing.promise;
        }
        return traced.apply(agent, args);
      };
      const prefetch = f.write();
      await until(() => held, `${stage}: the background check reached trace persistence`);
      const sent = f.calls.length;
      // Stop, then the next run starts on the tab with its own guard, signal
      // and allowance.
      agent.abort(tabId);
      agent._runAbortStates.set(tabId, { controller: new AbortController(), dispose() {} });
      agent.abortFlags.delete(tabId);
      const nextCost = { run: 'the next run' };
      agent.currentCostState.set(tabId, nextCost);
      agent._startPlanExecutionGuard(tabId, 'act', { requestKind: 'execute', requiresStateChange: true, requiresSubmission: true });
      tracing.release();
      assert.equal(await within(prefetch, `${stage}: the stale prefetch ends`),
        stage === 'social_publication_contract' ? 'skipped' : 'changed', stage);
      assert.equal(f.calls.length, sent, `${stage}: the stale check was never sent`);
      assert(f.calls.every(call => call.cost !== nextCost), `${stage}: the next run was not charged`);
    }
  });

  test(`${browser}: a background check carries the signal and allowance of the run that started it`, async () => {
    const f = setup();
    const { agent, tabId } = f;
    const startingRun = new AbortController();
    const startingCost = { run: 'the run that wrote the draft' };
    agent._runAbortStates.set(tabId, { controller: startingRun, dispose() {} });
    agent.currentCostState.set(tabId, startingCost);
    const audit = f.hold('social_publication_authorization');
    const prefetch = f.write();
    await until(() => audit.started, 'the background audit started');
    const [compile] = f.named('social_publication_contract');
    const [request] = f.named('social_publication_authorization');
    assert.equal(compile.cost, startingCost, 'the compile is charged to the run that started it');
    assert.equal(request.cost, startingCost, 'the audit is charged to the run that started it');
    // Stopping that run cancels the request in flight.
    startingRun.abort();
    await settle();
    audit.release();
    assert.equal(await within(prefetch, 'the stopped prefetch ends'), 'changed');
    assert.equal(request.aborted, true, 'the request in flight was cancelled');
    assert.equal(f.pending()?.compiled?.prefetchedAudit, undefined, 'a cancelled audit stores no verdict');
  });

  test(`${browser}: an in-browser model that cannot cancel a request gets no background checks`, async () => {
    // WebGPU runs one request at a time and ignores the request's signal: a
    // superseded background check would hold its queue ahead of the
    // replacement and of the agent's next turn.
    const f = setup();
    const { agent, tabId, provider } = f;
    provider.name = 'webgpu';
    assert.equal(agent._socialPublicationContractPrefetch(tabId, 'type_ax', { ref_id: 'ref_7', text: 'Hello' }, provider), null,
      'no background compile when the write starts');
    assert.equal(f.write(), null, 'no background compile or audit after the write');
    await settle();
    assert.equal(f.calls.length, 0, 'nothing was sent in the background');
    assert.equal(f.pending(), null);
    assert.equal(await f.click(), null, 'the click checks on its own');
    assert.deepEqual(f.calls.map(call => call.name), ['social_publication_contract', 'social_publication_authorization']);
  });

  test(`${browser}: a background check counts every request in flight at its most, and a request beside it counts the check`, async () => {
    const agent = new Agent({});
    const tabId = 977;
    const gates = [];
    const provider = { name: 'metered', model: 'metered', config: {},
      chat: async () => { const gate = deferred(); gates.push(gate); return gate.promise; } };
    agent._isCostMeteredProvider = () => true;
    agent._getCostAllowanceState = async () => ({ sessionLimitUsd: 1, totalLimitUsd: 100, totalSpentUsd: 0 });
    agent._estimateUsageCostUsd = () => 0.3; // the most a request can cost
    agent._extractUsageCostUsd = (_provider, usage) => usage?.cost_usd || 0; // what it cost
    const costState = { spentUsd: 0.5 };
    const ask = (content, context = {}) => agent._chatWithCostAllowance(provider, [{ role: 'user', content }], {}, costState,
      { tabId, ...context });
    // The run's own request is in flight: a background check counts it at its
    // most, and $0.50 spent + $0.30 + its own $0.30 could pass the $1 limit.
    const main = ask('next turn');
    await until(() => gates.length === 1, 'the run\'s request started');
    await assert.rejects(ask('audit', { background: true }), error => agent._isCostAllowanceError(error),
      'the background check does not start');
    assert.equal(gates.length, 1, 'nothing was sent for the background check');
    gates[0].release({ content: 'ok', usage: { cost_usd: 0.2 } });
    await main;
    assert.equal(costState.spentUsd, 0.7);
    // A background check in flight ($0.40 + $0.30): a request beside it that
    // would pass the limit only with the check's most waits for its actual
    // cost, like a request made after it.
    costState.spentUsd = 0.4;
    const background = ask('audit', { background: true });
    await until(() => gates.length === 2, 'the background check started');
    costState.spentUsd = 0.8;
    const next = ask('next turn');
    await settle();
    assert.equal(gates.length, 2, 'the next request waits for the check in flight');
    gates[1].release({ content: 'ok', usage: { cost_usd: 0.05 } });
    await background;
    await until(() => gates.length === 3, 'the next request starts once the check cost $0.05');
    gates[2].release({ content: 'ok', usage: { cost_usd: 0.1 } });
    await next;
    assert.ok(Math.abs(costState.spentUsd - 0.95) < 1e-9, `spent ${costState.spentUsd}`);
    // Over the limit on what was spent alone, a request is refused at once.
    costState.spentUsd = 1;
    await assert.rejects(ask('after the limit'), error => agent._isCostAllowanceError(error));
    assert.equal(gates.length, 3);
  });

  test(`${browser}: a held request counts its prompt by its bytes, so dense text is not under-reserved`, async () => {
    const agent = new Agent({});
    const usages = [];
    agent._isCostMeteredProvider = () => true;
    agent._estimateUsageCostUsd = (_provider, usage) => { usages.push(usage); return 0.01; };
    const bytes = text => new TextEncoder().encode(text).length;
    const texts = ['市場'.repeat(500), '😀'.repeat(500), 'a'.repeat(1000)];
    for (const text of texts) {
      agent._holdCostAllowance({ config: {} }, [{ role: 'user', content: text }], { maxTokens: 10 }, null).release();
    }
    // No tokenizer spends less than one byte of text per token.
    texts.forEach((text, index) => assert.ok(usages[index].prompt_tokens >= bytes(text),
      `${index}: ${usages[index].prompt_tokens} tokens held for ${bytes(text)} bytes`));
    assert.equal(usages[0].completion_tokens, 10);
    assert.equal(agent._costHolds?.size || 0, 0);
    // Every field a provider forwards counts, not only the content: a long
    // model-supplied tool_call_id, a name, the tool calls themselves.
    const id = 'call_' + '市'.repeat(2000);
    const metadata = [
      { role: 'assistant', content: null, tool_calls: [{ id, type: 'function', function: { name: 'click_ax', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: id, name: 'click_ax', content: 'ok' },
    ];
    assert.ok(agent._promptTokenUpperBound(metadata) >= 2 * bytes(id), 'the tool_call_id is held where it is sent');
    // An image counts its allowance, never its data; the text beside it counts.
    const data = 'data:image/png;base64,' + 'A'.repeat(200000);
    const imageBlocks = agent._promptTokenUpperBound([{ role: 'user', content: [
      { type: 'text', text: 'look' }, { type: 'image_url', image_url: { url: data } }] }]);
    const imageInline = agent._promptTokenUpperBound([{ role: 'user', content: `look ${data}` }]);
    for (const held of [imageBlocks, imageInline]) {
      assert.ok(held >= 2 * Math.ceil(Agent.IMAGE_CHAR_COST / 4), `${held}: the image allowance`);
      assert.ok(held < 200000, `${held}: the image data itself is not counted`);
    }
  });

  test(`${browser}: a consequential click a card or the permission gate stops still records predispatch_timing`, async () => {
    const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
    const run = async (name, args, { submitChoice = 'once', permissionChoice = 'deny' } = {}) => {
      const f = setup();
      const { agent, tabId, provider } = f;
      assert.equal(await f.write(), 'authorized');
      agent.currentRunId.set(tabId, 'prefetch-run');
      agent._skipPermissionGate = false;
      agent._ensureGateSetting = async () => false;
      agent.permissions.hydrate = async () => {};
      agent.permissions.check = () => ({ allowed: false, needsPrompt: true });
      agent.permissions.record = async () => {};
      agent._promptSubmitConfirmation = async () => { await wait(15); return submitChoice; };
      agent._promptPermission = async () => { await wait(15); return permissionChoice; };
      agent._recordProgressObservation = async () => null;
      agent._autoRecordProgressAction = () => null;
      agent._progressWarningForAction = () => '';
      agent._captureFormValidationState = async () => [];
      agent._waitForFormValidationFailure = async () => null;
      agent._readCompletionResult = async () => null;
      agent._messageRecipientGuardBlock = async () => null;
      agent._captchaMutationPreflight = async () => null;
      const dispatched = [];
      agent.executeTool = async (_tabId, tool) => { dispatched.push(tool); return { success: true, dispatched: true }; };
      const notes = [];
      agent._recordPredispatchTiming = (_tabId, step, timing) => notes.push({ step, timing });
      const messages = [];
      await agent._executeToolBatch(tabId, [{ id: 'post', function: { name, arguments: JSON.stringify(args) } }],
        messages, () => {}, provider, '', new Set([name]), 5);
      return { dispatched, notes, result: String(messages.at(-1)?.content || '') };
    };
    // The Post click's own confirmation card, declined.
    const declined = await run('click_ax', { ref_id: 'ref_9' }, { submitChoice: 'deny' });
    // The permission gate after the card: the frame's host denied, and a
    // frame whose host cannot be identified.
    const denied = await run('iframe_click', { urlFilter: 'x.com', selector: '[data-testid="tweetButton"]' });
    const unidentified = await run('iframe_click', { urlFilter: '', selector: '[data-testid="tweetButton"]' });
    for (const [label, outcome, stage] of [[`${browser} card declined`, declined, 'submitConfirmationMs'],
      [`${browser} permission denied`, denied, 'permissionMs'], [`${browser} host unidentified`, unidentified, 'permissionMs']]) {
      assert.deepEqual(outcome.dispatched, [], `${label}: nothing was sent`);
      assert.equal(outcome.notes.length, 1, `${label}: the blocked click records its timing (${outcome.result.slice(0, 160)})`);
      const [{ step, timing }] = outcome.notes;
      assert.equal(step, 5, label);
      assert.equal(timing.outcome, 'blocked', label);
      assert.equal(typeof timing[stage], 'number', `${label}: ${stage}`);
      assert.equal(typeof timing.totalMs, 'number', label);
    }
    assert.ok(declined.notes[0].timing.submitConfirmationMs >= 10, 'the wait on the confirmation card is recorded');
    assert.ok(denied.notes[0].timing.permissionMs >= 10, 'the wait on the permission card is recorded');
  });

  test(`${browser}: a consequential call stopped before its cards, or whose preparation fails, still records predispatch_timing`, async () => {
    const run = async (name, args, stub) => {
      const f = setup();
      const { agent, tabId, provider } = f;
      agent.currentRunId.set(tabId, 'prefetch-run');
      agent._skipPermissionGate = true;
      agent._ensureGateSetting = async () => true;
      agent._persistNow = async () => ({ ok: true });
      agent.isApiMutationsAllowed = () => false;
      agent._recordProgressObservation = async () => null;
      agent._autoRecordProgressAction = () => null;
      agent._progressWarningForAction = () => '';
      agent._captureFormValidationState = async () => [];
      agent._waitForFormValidationFailure = async () => null;
      agent._readCompletionResult = async () => null;
      agent._messageRecipientGuardBlock = async () => null;
      agent._captchaMutationPreflight = async () => null;
      stub(agent);
      const dispatched = [];
      agent.executeTool = async (_tabId, tool) => { dispatched.push(tool); return { success: true, dispatched: true }; };
      const notes = [];
      agent._recordPredispatchTiming = (_tabId, step, timing) => notes.push({ step, timing });
      const messages = [];
      await agent._executeToolBatch(tabId, [{ id: 'call', function: { name,
        arguments: typeof args === 'string' ? args : JSON.stringify(args) } }],
        messages, () => {}, provider, '', new Set([name]), 6);
      return { dispatched, notes, result: String(messages.find(message => message.role === 'tool')?.content || '') };
    };
    const click = ['click_ax', { ref_id: 'ref_9' }];
    // The page did not answer the CAPTCHA safety check in time.
    const preparationFails = agent => {
      agent._captchaMutationPreflight = async () => {
        const error = new Error('The page did not answer in time.');
        error.code = 'content_action_timeout';
        throw error;
      };
    };
    for (const [label, [name, args], stub, outcome, stage] of [
      ['CAPTCHA gate', click, agent => {
        agent._captchaGateBlockResult = () => ({ success: false, blocked: true, noDispatch: true,
          error: 'A verification challenge is active.' });
        agent._observeHuggingFaceSignupRecovery = async () => '';
      }, 'blocked', 'captchaGateMs'],
      ['clarification authorization', click, agent => {
        agent._clarificationAuthorizationBlock = () => ({ result: { success: false, blocked: true,
          error: 'Answer the clarification first.' } });
      }, 'blocked', 'clarificationMs'],
      ['API mutation without /allow-api', ['fetch_url', { url: 'https://api.example.com/items', method: 'POST', body: '{}' }],
        () => {}, 'blocked', 'clarificationMs'],
      // Any other stop before dispatch: noted when the batch ends, arguments
      // that cannot be used included.
      ['failed preparation', click, preparationFails, 'not_dispatched', 'stoppedMs'],
      ['unreadable arguments', ['click_ax', '{"ref_id": "ref_9"'], () => {}, 'not_dispatched', 'stoppedMs'],
      ['invalid arguments', ['click_ax', { ref_id: 9 }], () => {}, 'not_dispatched', 'stoppedMs'],
    ]) {
      const stopped = await run(name, args, stub);
      assert.deepEqual(stopped.dispatched, [], `${label}: nothing was sent`);
      assert.equal(stopped.notes.length, 1, `${label}: one timing note (${stopped.result.slice(0, 160)})`);
      const [{ step, timing }] = stopped.notes;
      assert.equal(step, 6, label);
      assert.equal(timing.tool, name, label);
      assert.equal(timing.outcome, outcome, label);
      assert.equal(typeof timing[stage], 'number', `${label}: ${stage}`);
      assert.equal(typeof timing.totalMs, 'number', label);
    }
    // A read stopped the same way records nothing.
    assert.equal((await run('get_accessibility_tree', {}, preparationFails)).notes.length, 0);
  });

  test(`${browser}: every predispatch stage the agent records survives the trace projection`, async () => {
    const fs = await import('node:fs/promises');
    const source = await fs.readFile(new URL(`../src/${browser}/src/agent/agent.js`, import.meta.url), 'utf8');
    const stages = new Set();
    for (const pattern of [/predispatch\.(?:lap|add)\('([A-Za-z]+Ms)'/g, /timedCheck\('([A-Za-z]+Ms)'/g,
      /_predispatchStage\(tabId, '([A-Za-z]+Ms)'/g, /'(publicationAudit(?:Awaited|Reused)Ms)'/g]) {
      for (const match of source.matchAll(pattern)) stages.add(match[1]);
    }
    assert.ok(stages.has('unverifiedStepCardMs'), 'the wait on an unverified-step card is a stage');
    assert.ok(stages.size >= 20, `only ${stages.size} stages found`);
    const extra = Object.fromEntries([...stages].map(stage => [stage, 5]));
    const projected = projectTraceEventData('note', { step: 1, note: 'predispatch_timing',
      extra: { ...extra, tool: 'click_ax', outcome: 'dispatched' } });
    for (const stage of stages) assert.equal(projected.extra[stage], 5, `${stage} is dropped from durable traces`);
  });

  test(`${browser}: a background check is traced to the run that started it, and not at all once that run moved on`, async () => {
    // Bound: a repair attempt is traced to the starting run even when the
    // tab's run id changed while the first attempt ran.
    {
      const f = setup();
      const { agent, tabId } = f;
      agent._runAbortStates.set(tabId, { controller: new AbortController(), dispose() {} });
      agent.currentRunId.set(tabId, 'run-A');
      const traced = [];
      agent._tracePlannerAttemptRequest = async (runId, _step, _provider, _messages, phase, attempt) => {
        traced.push([phase, attempt, runId]);
      };
      const chat = agent._chatWithCostAllowance;
      let invalid = true;
      agent._chatWithCostAllowance = async (...args) => {
        if (invalid && args[4].generationName === 'social_publication_contract') {
          invalid = false;
          agent.currentRunId.set(tabId, 'run-X');
          return { content: 'not a contract' };
        }
        return chat(...args);
      };
      assert.equal(await within(f.write(), 'the bound prefetch ends'), 'authorized');
      assert.deepEqual(traced, [
        ['social_publication_contract', 1, 'run-A'],
        ['social_publication_contract', 2, 'run-A'],
        ['social_publication_authorization', 1, 'run-A'],
      ]);
    }
    // Moved on: when the next run takes the tab right before a request, the
    // request is neither traced nor sent.
    for (const stage of ['social_publication_contract', 'social_publication_authorization']) {
      const f = setup();
      const { agent, tabId } = f;
      agent._runAbortStates.set(tabId, { controller: new AbortController(), dispose() {} });
      agent.currentRunId.set(tabId, 'run-A');
      const traced = [];
      agent._tracePlannerAttemptRequest = async (runId, _step, _provider, _messages, phase) => { traced.push({ runId, phase }); };
      const chatOptions = agent._socialPublicationChatOptions;
      let replaced = false;
      agent._socialPublicationChatOptions = function (...args) {
        if (!replaced && (args[3] === true) === (stage === 'social_publication_authorization')) {
          replaced = true;
          agent._runAbortStates.set(tabId, { controller: new AbortController(), dispose() {} });
          agent.currentRunId.set(tabId, 'run-B');
          agent._startPlanExecutionGuard(tabId, 'act', { requestKind: 'execute', requiresStateChange: true, requiresSubmission: true });
        }
        return chatOptions.apply(this, args);
      };
      await within(f.write(), `${stage}: the stale prefetch ends`);
      assert.equal(replaced, true, stage);
      assert.equal(traced.some(entry => entry.runId === 'run-B'), false, `${stage}: nothing was traced to the next run`);
      assert.equal(traced.some(entry => entry.phase === stage), false, `${stage}: the abandoned request was not traced`);
      assert.equal(f.named(stage).length, 0, `${stage}: the abandoned request was not sent`);
    }
  });

  test(`${browser}: the end of the run that started a background check cancels it, not only a Stop`, async () => {
    for (const stage of ['social_publication_contract', 'social_publication_authorization']) {
      const f = setup();
      const { agent, tabId } = f;
      agent._runAbortStates.set(tabId, { controller: new AbortController(), dispose() {} });
      const held = f.hold(stage);
      const prefetch = f.write();
      await until(() => held.started, `${stage}: the background check started`);
      const [request] = f.named(stage);
      // The run finishes normally: no Stop, its abort controller is only disposed.
      agent._releaseRunEntry(tabId);
      await settle();
      assert.equal(request.aborted, true, `${stage}: the request in flight was cancelled when its run ended`);
      held.release();
      assert.notEqual(await within(prefetch, `${stage}: the prefetch settles`), 'authorized', stage);
      assert.equal(agent._socialPublicationBackgroundAborts?.get(tabId)?.size || 0, 0, `${stage}: nothing is left to cancel`);
    }
  });

  test(`${browser}: a run's background checks end before its trace closes`, async () => {
    for (const stage of ['social_publication_contract', 'social_publication_authorization']) {
      const f = setup();
      const { agent, tabId } = f;
      agent._runAbortStates.set(tabId, { controller: new AbortController(), dispose() {} });
      const held = f.hold(stage);
      let settled = false;
      const prefetch = f.write().then(status => { settled = true; return status; });
      await until(() => held.started, `${stage}: the background check started`);
      const [request] = f.named(stage);
      // _endTraceRun flushes its last records right before trace.endRun.
      let atTraceEnd = null;
      agent._flushAdapterMatchTraceRun = async () => { atTraceEnd = { aborted: request.aborted, settled }; };
      await within(agent._endTraceRun(tabId, 'run-A', 'done', 'Posted.'), `${stage}: the trace closes`);
      assert.deepEqual(atTraceEnd, { aborted: true, settled: true },
        `${stage}: the check was still running when its run's trace closed`);
      held.release();
      assert.notEqual(await prefetch, 'authorized', stage);
      assert.equal(agent._socialPublicationBackgroundRuns?.get(tabId)?.size || 0, 0, `${stage}: nothing is left running`);
    }
  });

  test(`${browser}: a prefetch that reaches the draft the click is auditing defers to the click`, async () => {
    const f = setup();
    // The click compiles the contract and audits the draft itself; its audit
    // is still in flight.
    const audit = f.hold('social_publication_authorization');
    const click = f.click();
    await until(() => audit.started, 'the click\'s own audit started');
    try {
      // A write's prefetch, slower than the click, reaches the same draft now.
      assert.equal(await within(f.write(), 'the prefetch does not wait for the click'), 'cached', 'the prefetch defers to the click');
      assert.equal(f.named('social_publication_authorization').length, 1, 'no second checker request for the same draft');
    } finally {
      audit.release();
    }
    assert.equal(await within(click, 'the click finishes'), null);
    assert.equal(f.named('social_publication_authorization').length, 1);
    // Once the click decided, a prefetch of another draft audits as before.
    f.detected.frameDocumentIdentity = 'https://x.com/compose/post|fixture-document-2';
    assert.equal(await f.write(), 'authorized');
    assert.equal(f.named('social_publication_authorization').length, 2);
  });

  test(`${browser}: a newer draft cancels the background audit of the older one, and a click awaiting it audits on its own`, async () => {
    const f = setup();
    const audit = f.hold('social_publication_authorization');
    const first = f.write();
    await until(() => audit.started, 'the first background audit started');
    const [stale] = f.named('social_publication_authorization');
    // The click on Post awaits the audit of its own draft.
    let clicked = false;
    const click = f.click().then(result => { clicked = true; return result; });
    await settle();
    assert.equal(clicked, false, 'the click awaits the audit in flight');
    // Another write changes the composer: its audit supersedes the first.
    f.probeOnce = { frameDocumentIdentity: 'https://x.com/compose/post|fixture-document-2' };
    const second = f.write();
    try {
      assert.equal(await within(first, 'the superseded audit settles'), 'changed');
      assert.equal(stale.aborted, true, 'its request was cancelled');
      assert.equal(await within(click, 'the click goes on without the superseded audit'), null);
      assert.equal(await within(second, 'the newer audit ends'), 'authorized');
    } finally {
      audit.release();
    }
    const audits = f.named('social_publication_authorization');
    assert.equal(audits.length, 3, 'the cancelled audit, the newer draft\'s and the click\'s own');
    const own = audits.filter(call => call !== stale && call.key === stale.key);
    assert.equal(own.length, 1, 'the click audited the draft it probed');
    assert.equal(f.guard.socialPublication.dispatch.key, stale.key);
    assert.notEqual(f.guard.socialPublication.prefetchedAudit?.key, stale.key, 'the cancelled audit stored no verdict');
    // With a provider that cannot cancel its request, the superseded audit
    // still settles at once, and its late verdict is not stored.
    const stuck = setup();
    stuck.honorAbort = false;
    const blocked = stuck.hold('social_publication_authorization');
    const older = stuck.write();
    await until(() => blocked.started, 'the background audit started');
    const [late] = stuck.named('social_publication_authorization');
    stuck.probeOnce = { frameDocumentIdentity: 'https://x.com/compose/post|fixture-document-2' };
    const newer = stuck.write();
    try {
      assert.equal(await within(older, 'the superseded audit settles without its provider'), 'changed');
      assert.equal(await within(newer, 'the newer audit ends'), 'authorized');
    } finally {
      blocked.release();
    }
    await settle();
    assert.equal(late.done, true);
    assert.notEqual(stuck.guard.socialPublication?.prefetchedAudit?.key ?? stuck.pending()?.compiled?.prefetchedAudit?.key, late.key,
      'the late verdict of the superseded audit is not stored');
    // The same draft written again joins the audit already running for it.
    const again = setup();
    const held = again.hold('social_publication_authorization');
    const one = again.write();
    await until(() => held.started, 'the background audit started');
    const two = again.write();
    await settle();
    held.release();
    assert.equal(await within(one, 'the first prefetch ends'), 'authorized');
    assert.equal(await within(two, 'the joined prefetch ends'), 'authorized');
    assert.equal(again.named('social_publication_authorization').length, 1, 'one audit for the same draft');
  });

  test(`${browser}: a click on a draft changed without a new write cancels the old background audit before its own`, async () => {
    for (const change of ['draft', 'account']) {
      // A composed body lets the changed draft pass the click's preflight, so
      // only the binding key tells it apart from the draft being audited.
      let abortedWhenOwnAuditRan = null;
      const f = setup({ request: 'Tweet about my blog post',
        contract: rawContract([rawAction('p1', 'twitter', 'about my blog post', 'compose')]),
        authorize: input => {
          if (f.stale && input.key !== f.stale.key) abortedWhenOwnAuditRan = f.stale.aborted;
          return true;
        } });
      const audit = f.hold('social_publication_authorization');
      const prefetch = f.write();
      await until(() => audit.started, `${change}: the background audit started`);
      [f.stale] = f.named('social_publication_authorization');
      // The composer changes without another write (the user edited the draft
      // or switched accounts), so no newer prefetch supersedes the audit.
      if (change === 'draft') f.detected.publicationSnapshot.posts[0].bodyText = 'A different post about the blog';
      if (change === 'account') f.detected.publicationSnapshot.account = 'twitter:bob';
      let result;
      try {
        result = await within(f.click(), `${change}: the click runs its own audit`);
      } finally {
        audit.release();
      }
      assert.equal(result, null, change);
      assert.equal(abortedWhenOwnAuditRan, true, `${change}: the stale request was cancelled before the click audited`);
      assert.equal(f.stale.aborted, true, change);
      assert.equal(await within(prefetch, `${change}: the dropped prefetch settles`), 'changed', change);
      const audits = f.named('social_publication_authorization');
      assert.equal(audits.length, 2, `${change}: the cancelled audit and the click's own`);
      assert.notEqual(audits[1].key, f.stale.key, change);
      assert.equal(f.guard.socialPublication.dispatch.key, audits[1].key, `${change}: the click bound the draft it probed`);
      assert.equal(f.guard.socialPublication.prefetchedAudit, undefined, `${change}: no stale verdict was stored`);
    }
    // A correction replaces the contract the audit checks against: the audit
    // is cancelled with the background compile that produced that contract.
    const corrected = setup();
    const held = corrected.hold('social_publication_authorization');
    const prefetch = corrected.write();
    await until(() => held.started, 'the background audit started');
    const [stale] = corrected.named('social_publication_authorization');
    try {
      corrected.applySteering('Actually post Goodbye instead');
      assert.equal(stale.aborted, true, 'the correction cancelled the audit request');
      assert.equal(await within(prefetch, 'the corrected prefetch settles'), 'changed');
    } finally {
      held.release();
    }
    // So does a clarification, when the audit checks the run's own contract.
    const bound = setup();
    bound.guard.siteWorkflow = resolveAdapterWorkflowJob('https://x.com/compose/post', 'publish-post');
    bound.guard.siteWorkflowUrl = 'https://x.com/compose/post';
    const installed = await bound.agent._ensureSocialPublicationContract(bound.tabId, bound.provider);
    const boundHeld = bound.hold('social_publication_authorization');
    const boundPrefetch = bound.write();
    await until(() => boundHeld.started, 'the background audit of the run\'s contract started');
    const [boundStale] = bound.named('social_publication_authorization');
    try {
      bound.agent._recordSocialPublicationClarification(bound.tabId, bound.guard, 'Which account?', 'alice', 'user');
      assert.equal(installed.needsRecompile, true);
      assert.equal(boundStale.aborted, true, 'the clarification cancelled the audit of the replaced contract');
      assert.equal(await within(boundPrefetch, 'the prefetch settles'), 'changed');
    } finally {
      boundHeld.release();
    }
    // A click whose sources differ from a settled background compile drops it
    // and compiles its own: an audit still running against the dropped
    // contract is cancelled with it.
    const g = setup();
    const audit = g.hold('social_publication_authorization');
    const background = g.write();
    await until(() => audit.started, 'the background audit of the prefetched contract started');
    const [orphan] = g.named('social_publication_authorization');
    assert.ok(g.pending()?.compiled, 'the background compile settled');
    g.agent.conversations.get(g.tabId).push({ role: 'assistant', content: 'Draft: Hello' });
    try {
      assert.equal(await within(g.click(), 'the click compiles and audits its own'), null);
      assert.equal(orphan.aborted, true, 'the audit of the dropped contract was cancelled');
      assert.equal(await within(background, 'the dropped prefetch settles'), 'changed');
    } finally {
      audit.release();
    }
    assert.equal(g.guard.socialPublication.sources.draft0, 'Draft: Hello');
  });

  test(`${browser}: a correction or a compile of other sources cancels a background compile in flight`, async () => {
    const f = setup();
    const contract = f.hold('social_publication_contract');
    const prefetch = f.write();
    await until(() => contract.started, 'the background compile started');
    const [stale] = f.named('social_publication_contract');
    f.applySteering('Actually post Goodbye instead');
    try {
      assert.equal(await within(prefetch, 'the corrected prefetch ends'), 'skipped');
    } finally {
      contract.release();
    }
    assert.equal(stale.aborted, true, 'the correction cancelled the compile request');
    // A click whose sources differ from a background compile cancels it and
    // compiles its own.
    const g = setup();
    const held = g.hold('social_publication_contract');
    const background = g.write();
    await until(() => held.started, 'the background compile started');
    const [other] = g.named('social_publication_contract');
    g.agent.conversations.get(g.tabId).push({ role: 'assistant', content: 'Draft: Hello' });
    try {
      assert.equal(await within(g.click(), 'the click compiles its own contract'), null);
      assert.equal(await within(background, 'the cancelled prefetch ends'), 'skipped');
    } finally {
      held.release();
    }
    assert.equal(other.aborted, true, 'the background compile of other sources was cancelled');
    assert.equal(g.guard.socialPublication.sources.draft0, 'Draft: Hello');
  });

  test(`${browser}: a failed background compile leaves the click its own two attempts`, async () => {
    const f = setup();
    let failures = 2;
    const chat = f.agent._chatWithCostAllowance;
    f.agent._chatWithCostAllowance = async (...args) => {
      if (args[4].generationName === 'social_publication_contract' && failures-- > 0) {
        f.calls.push({ name: 'social_publication_contract', failed: true });
        throw new Error('HTTP 503: temporarily unavailable');
      }
      return chat(...args);
    };
    assert.equal(await f.write(), 'skipped');
    assert.equal(f.guard.socialPublication, null);
    assert.equal(f.pending(), null);
    assert.equal(await f.click(), null);
    assert.equal(f.named('social_publication_contract').length, 3);
  });

  test(`${browser}: a contract whose sources changed after the prefetch is compiled again at the click`, async () => {
    const f = setup();
    assert.equal(await f.write(), 'authorized');
    const prefetchedState = f.pending().compiled;
    // A plain assistant message later in the run is a draft source the click
    // would have compiled from.
    f.agent.conversations.get(f.tabId).push({ role: 'assistant', content: 'Draft: Hello' });
    assert.equal(await f.click(), null);
    assert.notEqual(f.guard.socialPublication, prefetchedState);
    assert.equal(f.guard.socialPublication.sources.draft0, 'Draft: Hello');
    assert.equal(f.named('social_publication_contract').length, 2);
    assert.equal(f.named('social_publication_authorization').length, 2, 'the new contract is audited again');
  });

  test(`${browser}: drafts, ordinary pages and failed writes start no prefetch`, async () => {
    const cases = [
      ['no submission planned', f => { f.guard.requiresSubmission = false; }],
      ['not a social composer page', f => { f.pageUrl = 'https://example.com/editor'; }],
      ['no publish control beside the editor', f => { f.detected = { isSubmit: false, resolvedEditableTarget: true }; }],
      ['failed write', f => { f.result = { success: false, noDispatch: true }; f.atStart = false; }],
      ['a submitting field write', f => { f.name = 'set_field'; f.args = { ref_id: 'ref_7', text: 'Hello', submit: true }; }],
      // The planner bound the run to another job on the site: not a post.
      ['a run bound to another site job', f => { f.guard.siteWorkflow = { adapterName: 'twitter', job: { id: 'send-message' } }; }],
    ];
    for (const [label, prepare] of cases) {
      const f = setup();
      f.name = 'type_ax'; f.args = { ref_id: 'ref_7', text: 'Hello' }; f.result = { success: true };
      prepare(f);
      // The contract compile can start with the write; the audit needs its result.
      if (f.atStart !== false) await f.agent._socialPublicationContractPrefetch(f.tabId, f.name, f.args, f.provider);
      await f.agent._socialPublicationPrefetch(f.tabId, f.name, f.args, f.result, f.provider);
      assert.equal(f.calls.length, 0, label);
      assert.equal(f.guard.socialPublication, null, label);
      assert.equal(f.pending(), null, label);
    }
  });

  test(`${browser}: a run bound to the publish job audits the draft against the contract compiled at its start`, async () => {
    const f = setup();
    f.guard.siteWorkflow = resolveAdapterWorkflowJob('https://x.com/compose/post', 'publish-post');
    f.guard.siteWorkflowUrl = 'https://x.com/compose/post';
    const installed = await f.agent._ensureSocialPublicationContract(f.tabId, f.provider);
    assert.equal(installed.contract.status, 'ready');
    assert.equal(await f.write(), 'authorized');
    assert.equal(f.pending(), null, 'nothing to compile in the background');
    assert.equal(await f.click(), null);
    assert.equal(f.guard.socialPublication, installed);
    assert.deepEqual(f.calls.map(call => call.name), ['social_publication_contract', 'social_publication_authorization']);
    // A clarification asks for a new contract: it is compiled in the
    // background from the clarified sources and installed by the next click.
    f.agent._recordSocialPublicationClarification(f.tabId, f.guard, 'Which account?', 'alice', 'user');
    assert.equal(installed.needsRecompile, true);
    f.detected.frameDocumentIdentity = 'https://x.com/compose/post|fixture-document-2';
    assert.equal(await f.write(), 'authorized');
    assert.equal(f.guard.socialPublication, installed, 'the run keeps its state until a caller installs the new one');
    const recompiled = f.pending().compiled;
    assert.equal(recompiled.sources.clarification_answer0, 'alice');
    assert.equal(await f.click(), null);
    assert.equal(f.guard.socialPublication, recompiled);
    assert.deepEqual(f.calls.map(call => call.name), ['social_publication_contract', 'social_publication_authorization',
      'social_publication_contract', 'social_publication_authorization']);
  });

  test(`${browser}: the prefetch reads the composer's captions the click and recipient guard would read`, async () => {
    // X's public post composer binds no recipient, so only what each control
    // does is read there. On an X route whose sends the recipient guard
    // checks, whether a control sends a message is read too.
    for (const [pageUrl, kinds] of [['https://x.com/compose/post', ['control_effect']],
      [GUARDED_PAGE, ['control_effect', 'message_control']]]) {
      const f = setup({ pageUrl });
      f.detected.publicationPrefetchCaptions = ['Post', 'Close', 'Choose audience'];
      assert.equal(await f.agent._socialPublicationPrefetch(f.tabId, 'type_text',
        { selector: '[data-testid="tweetTextarea_0"]', text: 'Hello', clear: true }, { success: true }, f.provider), 'authorized');
      assert.deepEqual(f.probes[0].args, { __wbPublicationPrefetch: { editorSelector: '[data-testid="tweetTextarea_0"]' } });
      assert.deepEqual(f.readings.map(reading => reading.kind).sort(), kinds, pageUrl);
      for (const reading of f.readings) assert.deepEqual(reading.texts, ['Post', 'Close', 'Choose audience']);
    }
  });

  test(`${browser}: a caption read in flight is joined by a later prefetch and by the click, never asked twice`, async () => {
    const f = setup({ pageUrl: GUARDED_PAGE });
    const { agent, tabId } = f;
    agent._runAbortStates.set(tabId, { controller: new AbortController(), dispose() {} });
    f.detected.publicationPrefetchCaptions = ['Post'];
    // A model's answers, stored when a read settles; reads stay in flight
    // until released. As in _readPageTexts, a text read before is not asked
    // of a model again.
    const answers = new Map();
    agent._pageTextReading = (kind, text) => answers.get(`${kind}:${text}`) ?? null;
    const reads = [];
    agent._readPageTexts = (_tabId, kind, texts, _context, options = {}) => {
      const unread = texts.filter(text => !answers.has(`${kind}:${text}`));
      if (!unread.length) return Promise.resolve();
      return new Promise(resolve => {
        reads.push({ kind, background: !!options.background, release: () => {
          for (const text of unread) answers.set(`${kind}:${text}`, 'publish');
          resolve();
        } });
      });
    };
    const first = f.write();
    await until(() => reads.length === 2, 'the first prefetch reads the caption');
    assert.deepEqual(reads.map(read => [read.kind, read.background]).sort(),
      [['control_effect', true], ['message_control', true]]);
    // A second prefetch, and the click's submit probe and recipient guard,
    // join the reads in flight instead of asking a model again.
    const settled = { second: false, effect: false, control: false };
    const second = f.write({ ref_id: 'ref_7', text: 'Hello', clear: true }).then(value => { settled.second = true; return value; });
    const effect = agent._readControlEffects(tabId, ['Post']).then(() => { settled.effect = true; });
    const control = agent._readUnreadPageTexts(tabId, [{ kind: 'message_control', text: 'Post' }])
      .then(value => { settled.control = true; return value; });
    await settle();
    assert.equal(reads.length, 2, 'nothing was asked twice');
    assert.deepEqual(settled, { second: false, effect: false, control: false }, 'each waits for the read in flight');
    for (const read of reads) read.release();
    await within(effect, 'the click has its caption reading');
    assert.equal(await within(control, 'the recipient guard has its reading'), true);
    await within(first, 'the first prefetch ends');
    await within(second, 'the second prefetch ends');
    assert.equal(reads.length, 2, 'still nothing was asked twice');
    assert.equal(agent._controlEffectReading('Post'), 'publish');
    assert.equal(agent._socialPublicationPrefetchReading?.size || 0, 0, 'no read is left in flight');
  });

  test(`${browser}: a prefetch that only joins another run's caption reads stops waiting when its own run stops or ends`, async () => {
    for (const end of ['run end', 'Stop']) {
      const f = setup({ pageUrl: GUARDED_PAGE });
      const { agent, tabId } = f;
      const otherTab = tabId + 1;
      agent._pageTextReading = () => null;
      const reads = [];
      agent._readPageTexts = (_tabId, kind) => new Promise(resolve => { reads.push({ kind, resolve }); });
      const runA = new AbortController(), runB = new AbortController();
      const binding = (signal, runId) => ({ signal, costState: null, current: () => !signal.aborted, runId });
      // One run reads the caption; another tab's prefetch only joins its reads.
      const first = agent._socialPublicationPrefetchReadings(tabId, ['Post'], f.pageUrl, null, binding(runA.signal, 'run-A'));
      await until(() => reads.length === 2, `${end}: the first run reads the caption`);
      let joinedSettled = false;
      const joined = agent._socialPublicationPrefetchReadings(otherTab, ['Post'], f.pageUrl, null, binding(runB.signal, 'run-B'))
        .then(value => { joinedSettled = true; return value; });
      await settle();
      assert.equal(reads.length, 2, `${end}: the caption is not asked twice`);
      assert.equal(joinedSettled, false, `${end}: the joining prefetch waits for the read in flight`);
      // The joining run stops or ends: its wait stops, while the read goes on.
      if (end === 'Stop') runB.abort();
      else agent._cancelSocialPublicationBackground(otherTab);
      assert.deepEqual(await within(joined, `${end}: the joining prefetch stops waiting`), []);
      assert.equal(agent._socialPublicationBackgroundAborts?.get(otherTab)?.size || 0, 0, `${end}: nothing is left to cancel`);
      assert.equal(runA.signal.aborted, false, `${end}: the reading run is unaffected`);
      for (const read of reads) read.resolve();
      await within(first, `${end}: the reading run ends with its reads`);
      assert.equal(agent._socialPublicationPrefetchReading?.size || 0, 0, `${end}: no read is left in flight`);
    }
  });

  test(`${browser}: the prefetch's caption reads belong to the run that started it`, async () => {
    const f = setup({ pageUrl: GUARDED_PAGE });
    const { agent, tabId } = f;
    agent._runAbortStates.set(tabId, { controller: new AbortController(), dispose() {} });
    agent.currentRunId.set(tabId, 'run-A');
    const costState = { spentUsd: 0 };
    agent.currentCostState.set(tabId, costState);
    f.detected.publicationPrefetchCaptions = ['Post', 'Close'];
    // Both reads stay in flight (awaiting settings or a model).
    const reads = [];
    agent._readPageTexts = (_tabId, kind, texts, _context, options = {}) => new Promise(resolve => {
      reads.push({ kind, texts: [...texts], background: options.background, resolve });
    });
    const prefetch = f.write();
    await until(() => reads.length === 2, 'both caption reads started');
    for (const { kind, background } of reads) {
      assert.ok(background, `${kind}: a background read`);
      assert.equal(background.costState, costState, `${kind}: charged to the run that started it`);
      assert.equal(background.runId, 'run-A', `${kind}: traced to that run`);
      assert.equal(background.current(), true, `${kind}: that run still owns the tab`);
      assert.equal(background.signal.aborted, false, kind);
    }
    // The run finishes normally (no Stop): its caption reads end with it.
    agent._releaseRunEntry(tabId);
    for (const { kind, background } of reads) {
      assert.equal(background.signal.aborted, true, `${kind}: cancelled when its run ended`);
      assert.equal(background.current(), false, kind);
    }
    await within(prefetch, 'the prefetch does not wait for the cancelled reads');
    assert.equal(agent._socialPublicationBackgroundAborts?.get(tabId)?.size || 0, 0, 'nothing is left to cancel');
    for (const read of reads) read.resolve();
  });

  test(`${browser}: a background caption read is charged to its run as a background request, and none starts once that run moved on`, async () => {
    const agent = new Agent({});
    const tabId = 979;
    const provider = { name: 'checker', model: 'checker', chat: async () => ({ content: '{}' }) };
    agent._jevSettings = async () => null; // no decision model: the active model reads
    const sent = [];
    agent._chatWithCostAllowance = async (_provider, _messages, options, costState, context) => {
      sent.push({ costState, context, signal: options?.signal });
      return { content: '{}' };
    };
    agent.currentRunId.set(tabId, 'run-B');
    agent.currentCostState.set(tabId, { spentUsd: 0.25 }); // the allowance of a later run
    const traced = [];
    agent.recordSystemOneVerdict = (_tabId, metadata, context) => traced.push(context);
    const runCost = { spentUsd: 0 };
    let live = true;
    const controller = new AbortController();
    const background = { signal: controller.signal, costState: runCost, runId: 'run-A', current: () => live };
    await agent._semanticDecisions(tabId, 'control_effect', { items: [{ text: 'Post' }] }, { provider, background });
    assert.equal(sent.length, 1);
    assert.equal(sent[0].costState, runCost, 'charged to the run that started it, not the tab\'s current run');
    assert.equal(sent[0].context.background, true, 'held as a background request');
    // The run moved on: nothing is sent, and the read is not counted as unanswered.
    live = false;
    await agent._readPageTexts(tabId, 'control_effect', ['Close'], {}, { background });
    assert.equal(sent.length, 1, 'no request once its run moved on');
    assert.equal(agent._unansweredPageTexts?.size || 0, 0, 'a read cut short is asked again later');
    // A cancelled one: likewise.
    live = true;
    controller.abort();
    await agent._semanticDecisions(tabId, 'control_effect', { items: [{ text: 'Choose audience' }] }, { provider, background });
    assert.equal(sent.length, 1, 'no request once its run ended');
    assert.equal(traced.every(context => context?.runId === 'run-A'), true, 'traced only to the run that started it');
  });

  test(`${browser}: a decision-model request holds its cost until it settles, as a background one for a background read`, async () => {
    const agent = new Agent({});
    const tabId = 982;
    agent._getCostAllowanceState = async () => ({ sessionLimitUsd: 1, totalLimitUsd: 100, totalSpentUsd: 0 });
    agent._recordCostUsage = async () => null;
    const config = { provider: 'typesafe', config: { category: 'cloud', inputCostPerMillionUsd: 1, outputCostPerMillionUsd: 1 } };
    const runCost = { spentUsd: 0 };
    const held = [];
    const client = { evaluate: async ({ beforeRequest, onUsage }) => {
      await beforeRequest();
      held.push([...(agent._costHolds || [])].map(hold => ({ background: hold.background, costState: hold.costState, usd: hold.usd })));
      await onUsage({ usage: { input_tokens: 10, output_tokens: 1 } });
      return { answers: {} };
    } };
    const args = { config, state: { context: 'x'.repeat(4000) }, questions: { item_0: {} } };
    await agent.evaluateSystemOne(tabId, client, args, { costState: runCost, runId: 'run-A', isCurrent: () => true, background: true });
    await agent.evaluateSystemOne(tabId, client, args, { costState: runCost, runId: 'run-A', isCurrent: () => true });
    assert.equal(held.length, 2);
    assert.deepEqual(held.map(list => list.length), [1, 1], 'one hold per request in flight');
    assert.equal(held[0][0].background, true, 'a background read is held as a background request');
    assert.equal(held[0][0].costState, runCost, 'against the allowance of its run');
    assert.ok(held[0][0].usd > 0, 'at its most');
    assert.equal(held[1][0].background, false);
    assert.equal(agent._costHolds?.size || 0, 0, 'released once the request settled');
  });

  test(`${browser}: a correction cancels the prefetch's caption reads, and an answer that outlived its run is kept nowhere`, async () => {
    // A correction cancels the reads the prefetch started, with its contract and audit.
    {
      const f = setup({ pageUrl: GUARDED_PAGE });
      const { agent, tabId } = f;
      agent._runAbortStates.set(tabId, { controller: new AbortController(), dispose() {} });
      f.detected.publicationPrefetchCaptions = ['Post', 'Close'];
      const reads = [];
      agent._readPageTexts = (_tabId, kind, texts, _context, options = {}) => new Promise(resolve => {
        reads.push({ kind, background: options.background, resolve });
      });
      const prefetch = f.write();
      await until(() => reads.length === 2, 'both caption reads started');
      f.applySteering('Make it shorter.');
      for (const { kind, background } of reads) assert.equal(background.signal.aborted, true, `${kind}: cancelled by the correction`);
      await within(prefetch, 'the prefetch settles');
      for (const read of reads) read.resolve();
    }
    // An answer that arrives after its run moved on is neither returned,
    // cached nor stored as a reading: the next read asks again.
    {
      const provider = { name: 'checker', model: 'checker', chat: async () => ({ content: '{}' }) };
      const agent = new Agent({ getActive: () => provider });
      const tabId = 983;
      agent._jevSettings = async () => null;
      let live = true;
      let sent = 0;
      agent._chatWithCostAllowance = async () => {
        sent += 1;
        live = false; // the run moves on while the request is in flight
        return { content: JSON.stringify({ answers: [{ item: 0, choice: 'publish' }] }) };
      };
      const background = { signal: new AbortController().signal, costState: { spentUsd: 0 }, runId: 'run-A', current: () => live };
      const [late] = await agent._semanticDecisions(tabId, 'control_effect', { items: [{ text: 'Post' }] }, { provider, background });
      assert.equal(late.choice, null, 'the late answer is dropped');
      live = true;
      await agent._readPageTexts(tabId, 'control_effect', ['Post'], {}, { background });
      assert.equal(sent, 2, 'nothing was cached, so the next read asks again');
      assert.equal(agent._pageTextReading('control_effect', 'Post'), null, 'nor is the late answer stored as a reading');
      // The same answer within a live run is kept as before.
      live = true;
      agent._chatWithCostAllowance = async () => { sent += 1; return { content: JSON.stringify({ answers: [{ item: 0, choice: 'publish' }] }) }; };
      await agent._readPageTexts(tabId, 'control_effect', ['Post'], {}, { background });
      assert.equal(agent._pageTextReading('control_effect', 'Post'), 'publish');
    }
  });

  test(`${browser}: an upload into the composer last written audits the draft again`, async () => {
    const f = setup({ request: 'Tweet about my blog post',
      contract: rawContract([rawAction('p1', 'twitter', 'about my blog post', 'compose')]) });
    assert.equal(await f.write(), 'authorized');
    f.detected.frameDocumentIdentity = 'https://x.com/compose/post|fixture-document-after-upload';
    assert.equal(await f.agent._socialPublicationPrefetch(f.tabId, 'upload_file', { selector: 'input[type=file]' },
      { success: true, attachmentState: 'page_consumed' }, f.provider), 'authorized');
    assert.deepEqual(f.probes.at(-1).args, { __wbPublicationPrefetch: { editorRef: 'ref_7' } });
    assert.equal(await f.click(), null);
    assert.equal(f.named('social_publication_authorization').length, 2);
  });

  test(`${browser}: a consequential click records predispatch_timing with stage durations only`, async () => {
    const f = setup();
    const { agent, tabId, provider } = f;
    assert.equal(await f.write(), 'authorized');
    agent.currentRunId.set(tabId, 'prefetch-run');
    agent._skipPermissionGate = true;
    agent._ensureGateSetting = async () => true;
    agent._recordProgressObservation = async () => null;
    agent._autoRecordProgressAction = () => null;
    agent._progressWarningForAction = () => '';
    agent._captureFormValidationState = async () => [];
    agent._waitForFormValidationFailure = async () => null;
    agent._readCompletionResult = async () => null;
    agent._messageRecipientGuardBlock = async () => null;
    agent._captchaMutationPreflight = async () => null;
    const dispatched = [];
    agent.executeTool = async (_tabId, name) => { dispatched.push(name); return { success: true, dispatched: true }; };
    const notes = [];
    agent._recordPredispatchTiming = (_tabId, step, timing) => notes.push({ step, timing });
    const messages = [];
    await agent._executeToolBatch(tabId, [{ id: 'post', function: { name: 'click_ax', arguments: JSON.stringify({ ref_id: 'ref_9' }) } }],
      messages, () => {}, provider, '', new Set(['click_ax']), 4);
    assert.deepEqual(dispatched, ['click_ax']);
    assert.equal(f.calls.length, 2, 'the click reused the prefetched contract and verdict');
    assert.equal(notes.length, 1);
    const [{ step, timing }] = notes;
    assert.equal(step, 4);
    assert.equal(timing.tool, 'click_ax');
    assert.equal(timing.outcome, 'dispatched');
    for (const stage of ['captchaGateMs', 'submitPreflightMs', 'submitProbeMs', 'workflowPreSubmitMs', 'workflowDispatchMs',
      'publicationContractMs', 'publicationAuditReusedMs', 'publicationRereadMs', 'recipientGuardMs', 'checkpointMs',
      'pipelinePublicationMs', 'attemptCheckpointMs', 'preDispatchMs', 'executeToolMs', 'totalMs']) {
      assert.equal(typeof timing[stage], 'number', stage);
      assert(timing[stage] >= 0, stage);
    }
    assert.equal(timing.publicationAuditMs, undefined, 'no audit ran at the click');
    const projected = projectTraceEventData('note', { step, note: 'predispatch_timing',
      extra: { ...timing, tool: 'click_ax', outcome: 'dispatched', pageUrl: 'https://PRIVATE.invalid', draft: 'PRIVATE' } });
    assert.equal(projected.note, 'predispatch_timing');
    assert.equal(projected.extra.tool, 'click_ax');
    assert.equal(projected.extra.publicationAuditReusedMs, timing.publicationAuditReusedMs);
    assert.equal(JSON.stringify(projected).includes('PRIVATE'), false);
    assert(Object.values(projected.extra).every(value => typeof value === 'number' || ['click_ax', 'dispatched'].includes(value)));
  });

  test(`${browser}: navigation and typing record predispatch_timing too, and a read leaves no timing record behind`, async () => {
    const run = async (name, args) => {
      const provider = { model: 'fake-checker', chat: async () => ({ content: '{}' }) };
      const agent = new Agent({ getActive: () => provider });
      const tabId = 812;
      agent._persist = () => {};
      agent._currentUrl = async () => 'https://example.com/search';
      agent.conversations.set(tabId, [{ role: 'system', content: 'system' }, { role: 'user', content: 'Search the site for hello' }]);
      agent._startPlanExecutionGuard(tabId, 'act', { requestKind: 'execute', requiresStateChange: true });
      agent.currentRunId.set(tabId, 'timing-run');
      agent._skipPermissionGate = true;
      agent._ensureGateSetting = async () => true;
      agent._recordProgressObservation = async () => null;
      agent._autoRecordProgressAction = () => null;
      agent._progressWarningForAction = () => '';
      agent._captureFormValidationState = async () => [];
      agent._waitForFormValidationFailure = async () => null;
      agent._readCompletionResult = async () => null;
      agent._messageRecipientGuardBlock = async () => null;
      agent._captchaMutationPreflight = async () => null;
      agent._detectLikelySubmitAction = async () => ({ isSubmit: false });
      const dispatched = [];
      agent.executeTool = async (_tabId, tool) => { dispatched.push(tool); return { success: true, dispatched: true }; };
      const notes = [];
      agent._recordPredispatchTiming = (_tabId, step, timing) => notes.push({ step, timing });
      await agent._executeToolBatch(tabId, [{ id: 'call', function: { name, arguments: JSON.stringify(args) } }],
        [], () => {}, provider, '', new Set([name]), 7);
      return { agent, tabId, dispatched, notes };
    };
    // None of these is a submit; the permission capability each needs makes
    // it consequential.
    for (const [name, args] of [['navigate', { url: 'https://example.com/next' }],
      ['type_text', { selector: '#q', text: 'hello' }], ['set_field', { ref_id: 'ref_3', text: 'hello' }]]) {
      const { agent, tabId, dispatched, notes } = await run(name, args);
      assert.deepEqual(dispatched, [name], name);
      assert.equal(notes.length, 1, `${name}: its timing is recorded`);
      assert.equal(notes[0].timing.tool, name);
      assert.equal(notes[0].timing.outcome, 'dispatched');
      assert.equal(agent._predispatchTimings?.has(tabId) || false, false, `${name}: no record is left open`);
    }
    // A read gets no note, and its record for the tab goes when its batch ends.
    const read = await run('get_accessibility_tree', {});
    assert.deepEqual(read.dispatched, ['get_accessibility_tree']);
    assert.equal(read.notes.length, 0);
    assert.equal(read.agent._predispatchTimings?.has(read.tabId) || false, false, 'the read left its timing record behind');
    // The end of a run drops whatever record is still open.
    read.agent._predispatchTimer(read.tabId);
    assert.equal(read.agent._predispatchTimings.has(read.tabId), true);
    read.agent._releaseRunEntry(read.tabId);
    assert.equal(read.agent._predispatchTimings.has(read.tabId), false, 'the end of the run dropped the open record');
  });
}

// The prefetch probe, in a real page: it must find the composer's own Post
// button from the editor just written, and report the same binding snapshot
// and document as the click on that button will, so their keys match.
test('the prefetch probe resolves the written composer\'s Post button and binds the same draft as the click', async () => {
  const { chromium } = await import('playwright');
  const fs = await import('node:fs');
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext();
    await context.route('**/*', route => route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><html><body></body></html>' }));
    const page = await context.newPage();
    for (const build of ['chrome', 'firefox']) {
      const { Agent } = await import(`../src/${build}/src/agent/agent.js`);
      await page.goto('https://x.com/compose/post');
      await page.setContent(`<nav><a data-testid="AppTabBar_Profile_Link" href="/alice">Profile</a></nav>
        <main><div id="inline"><div><div contenteditable="true" role="textbox" aria-label="Post text" data-testid="tweetTextarea_0">Inline draft</div></div>
          <div><button type="button" data-testid="tweetButtonInline">Post</button></div></div></main>
        <div role="dialog" aria-modal="true" id="dialog"><button type="button" aria-label="Close">x</button>
          <div><div><div><div contenteditable="true" role="textbox" aria-label="Post text" data-testid="tweetTextarea_0">Hello</div></div></div></div>
          <nav aria-label="Composer tools"><button type="button" aria-label="Add photos or video">Media</button></nav>
          <div><button type="button" data-testid="tweetButton">Post</button></div></div>`);
      await page.addScriptTag({ content: fs.readFileSync(`src/${build}/src/content/accessibility-tree.js`, 'utf8') });
      const refs = await page.evaluate(() => ({
        dialogEditor: window.__wb_ax_ref(document.querySelector('#dialog [role="textbox"]')),
        dialogPost: window.__wb_ax_ref(document.querySelector('#dialog [data-testid="tweetButton"]')),
        inlineEditor: window.__wb_ax_ref(document.querySelector('#inline [role="textbox"]')),
        inlinePost: window.__wb_ax_ref(document.querySelector('#inline [data-testid="tweetButtonInline"]')),
      }));
      const probe = args => page.evaluate(({ source, args }) => Function('return (' + source + ')')()('click_ax', args),
        { source: Agent._submitActionProbe.toString(), args: { __wbCaptionPass: 'final', ...args } });
      for (const [editor, post, body] of [[refs.dialogEditor, refs.dialogPost, 'Hello'], [refs.inlineEditor, refs.inlinePost, 'Inline draft']]) {
        const prefetch = await probe({ __wbPublicationPrefetch: { editorRef: editor } });
        const click = await probe({ ref_id: post });
        assert.equal(prefetch?.isSubmit, true, build);
        assert.equal(prefetch.publicationControl, true, build);
        assert.equal(click.publicationControl, true, build);
        assert.deepEqual(prefetch.publicationSnapshot, click.publicationSnapshot, build);
        assert.equal(prefetch.frameDocumentIdentity, click.frameDocumentIdentity, build);
        assert.deepEqual(prefetch.publicationSnapshot.posts.map(post => post.bodyText), [body], build);
        assert.equal(prefetch.publicationSnapshot.account, 'twitter:alice', build);
        assert(Array.isArray(prefetch.publicationPrefetchCaptions) && prefetch.publicationPrefetchCaptions.includes('Post'), build);
        assert.equal(click.publicationPrefetchCaptions, undefined, 'only the prefetch asks for captions');
      }
      // The dialog's other controls are among the captions the click reads.
      const dialogCaptions = (await probe({ __wbPublicationPrefetch: { editorRef: refs.dialogEditor } })).publicationPrefetchCaptions;
      for (const caption of ['Close', 'Add photos or video']) assert(dialogCaptions.includes(caption), `${build}: ${caption}`);
      // A selector naming both editors, or two publish controls beside the
      // editor, resolve to nothing rather than to a guess.
      assert.equal(await probe({ __wbPublicationPrefetch: { editorSelector: '[data-testid="tweetTextarea_0"]' } }), null, build);
      await page.evaluate(() => {
        const second = document.createElement('button');
        second.type = 'button'; second.dataset.testid = 'tweetButton'; second.textContent = 'Post all';
        document.querySelector('#dialog').append(second);
      });
      assert.equal(await probe({ __wbPublicationPrefetch: { editorRef: refs.dialogEditor } }), null, build);
      // Only X's own post editor prepares a post: a form's text area or an
      // unmarked editable beside a Post button does not.
      for (const field of ['<textarea id="field">Draft</textarea>', '<div id="field" contenteditable="true" role="textbox">Draft</div>']) {
        await page.setContent(`<nav><a data-testid="AppTabBar_Profile_Link" href="/alice">Profile</a></nav>
          <form>${field}<button type="button" data-testid="tweetButtonInline">Post</button></form>`);
        await page.addScriptTag({ content: fs.readFileSync(`src/${build}/src/content/accessibility-tree.js`, 'utf8') });
        const fieldRef = await page.evaluate(() => window.__wb_ax_ref(document.querySelector('#field')));
        const postRef = await page.evaluate(() => window.__wb_ax_ref(document.querySelector('button')));
        assert.equal((await probe({ ref_id: postRef })).publicationControl, true, `${build}: the click itself stays guarded`);
        assert.equal(await probe({ __wbPublicationPrefetch: { editorRef: fieldRef } }), null, `${build}: ${field}`);
      }
      // Bluesky's post editor is its ProseMirror editor.
      await page.goto('https://bsky.app/');
      await page.setContent(`<nav><a href="/profile/alice.bsky.social">Profile</a></nav>
        <div role="dialog" aria-modal="true"><div class="ProseMirror" contenteditable="true" role="textbox"><p>Hello</p></div>
          <button type="button" data-testid="composerPublishBtn">Post</button></div>`);
      await page.addScriptTag({ content: fs.readFileSync(`src/${build}/src/content/accessibility-tree.js`, 'utf8') });
      const bluesky = await page.evaluate(() => ({ editor: window.__wb_ax_ref(document.querySelector('.ProseMirror')),
        post: window.__wb_ax_ref(document.querySelector('[data-testid="composerPublishBtn"]')) }));
      const prefetch = await probe({ __wbPublicationPrefetch: { editorRef: bluesky.editor } });
      const click = await probe({ ref_id: bluesky.post });
      assert.equal(prefetch?.publicationControl, true, build);
      assert.deepEqual(prefetch.publicationSnapshot, click.publicationSnapshot, build);
      assert.equal(prefetch.publicationSnapshot.account, 'bluesky:alice.bsky.social', build);
      assert.deepEqual(prefetch.publicationSnapshot.posts.map(post => post.bodyText), ['Hello'], build);
      assert.equal(await probe({ __wbPublicationPrefetch: { editorSelector: '.ProseMirror' } }).then(result => result?.publicationControl), true, build);
    }
  } finally {
    await browser.close();
  }
});

test('Chrome and Firefox share the publication prefetch', async () => {
  const { Agent: Chrome } = await import('../src/chrome/src/agent/agent.js');
  const { Agent: Firefox } = await import('../src/firefox/src/agent/agent.js');
  for (const name of ['_socialPublicationPrefetch', '_socialPublicationContractPrefetch', '_socialPublicationPrefetchHint',
    '_socialPublicationPrefetchAllowed', '_socialPublicationStateCurrent', '_socialPublicationPrefetchRun', '_socialPublicationPrefetchAudit',
    '_socialPublicationPrefetchReadings', '_socialPublicationPrefetchedVerdict', '_socialPublicationAuditRun',
    '_socialPublicationCompile', '_ensureSocialPublicationContract', '_predispatchTimer', '_predispatchStage',
    '_recordPredispatchTiming', '_socialPublicationBackgroundAbort', '_socialPublicationBackgroundCall',
    '_socialPublicationBackgroundSettle', '_invalidateSocialPublicationContract']) {
    assert.equal(typeof Chrome.prototype[name], 'function', name);
    assert.equal(Chrome.prototype[name].toString(), Firefox.prototype[name].toString(), name);
  }
});
