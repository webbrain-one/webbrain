import assert from 'node:assert/strict';
import { test } from 'node:test';

for (const build of ['chrome', 'firefox']) {
  const { pageFeedbackMethods } = await import(`../src/${build}/src/agent/page-feedback.js`);
  const tab = 901;
  const makeAgent = () => {
    const frame = { token: 'document-token', id: 'document-id' };
    const run = { token: 'run-token', url: 'https://example.test/task', events: new Map(), frames: new Map([[0, frame]]) };
    run.modelState = { token: run.token, url: run.url, frames: new Map([[0, { ...frame }]]), steeringRevision: 0 };
    const agent = Object.assign({ _pageFeedbackRuns: new Map([[tab, run]]), currentRunId: new Map(),
      _hasPendingSteering: () => false,
      conversations: new Map([[tab, []]]), _appOwnedUserMessage: (content, kind) => ({ role: 'user', content, webbrainAppOwnedKind: kind }) }, pageFeedbackMethods);
    return { agent, run };
  };
  const noDispatch = { success: false, pageFeedbackPending: true, noDispatch: true, dispatched: false };

  test(`${build}: a concrete API request ignores replaced ad documents but keeps root, steering and replay fences`, () => {
    const args = { url: 'https://api.mail.test/accounts', method: 'POST', body: '{"address":"fresh@example.test"}' };
    const { agent, run } = makeAgent();
    run.modelState.frames.set(7, { token: 'old-ad', id: 'old-ad' });
    run.frames.set(7, { token: 'new-ad', id: 'new-ad' });
    run.events.set('ad', { kind: 'navigation', source: 'unknown', frameId: 7 });
    assert.equal(agent._pageFeedbackBlocksCall(tab, 'fetch_url', args), false);
    for (const extra of [{ replayRequestId: 'captured-post' }, { apiReplayRequestId: 'captured-post' }])
      assert.equal(agent._pageFeedbackBlocksCall(tab, 'fetch_url', { ...args, ...extra }), true);
    agent._hasPendingSteering = () => true;
    assert.equal(agent._pageFeedbackBlocksCall(tab, 'fetch_url', args), true);
    agent._hasPendingSteering = () => false;
    run.events.set('human', { kind: 'click', source: 'user', frameId: 7 });
    assert.equal(agent._pageFeedbackBlocksCall(tab, 'fetch_url', args), true);
    run.events.delete('human');
    run.frames.set(0, { token: 'new-root', id: 'new-root' });
    assert.equal(agent._pageFeedbackBlocksCall(tab, 'fetch_url', args), true);
  });

  test(`${build}: response refresh retains an API fallback across ad reloads and counter changes during the refresh`, async t => {
    const { agent, run } = makeAgent();
    const priorChrome = globalThis.chrome, priorBrowser = globalThis.browser;
    const api = { tabs: { get: async () => ({ url: run.url }) }, webNavigation: { getAllFrames: async () => [
      { frameId: 0, documentId: 'document-id' }, { frameId: 7, documentId: 'new-ad' },
    ] } };
    globalThis.chrome = api; globalThis.browser = api;
    t.after(() => { globalThis.chrome = priorChrome; globalThis.browser = priorBrowser; });
    run.documents = new Map([[0, { id: 'document-id' }]]);
    run.modelState.documentId = 'document-id';
    run.modelState.frames.set(7, { token: 'old-ad', id: 'old-ad' });
    run.frames.set(7, { token: 'new-ad', id: 'new-ad' });
    run.events.set('ad', { kind: 'navigation', source: 'unknown', frameId: 7 });
    Object.assign(agent, { _checkAbort: () => false, _waitForPageFeedbackIdle: async () => {},
      _runAbortSignal: () => null, _throwIfAborted: () => {}, _monitoringRetryCurrent: () => null,
      _wrapUntrusted: (_name, value) => value, _persist: () => {}, _shouldAutoScreenshot: () => false,
      executeTool: async () => {
        run.events.set('counter', { kind: 'dom', source: 'page', frameId: 0, target: 'span#counter' });
        return { success: true, pageContent: 'heading "Inbox"' };
      } });
    const request = { function: { name: 'fetch_url', arguments: JSON.stringify({
      url: 'https://api.mail.test/accounts', method: 'POST', body: '{"address":"fresh@example.test"}',
    }) } };
    assert.equal(await agent._applyPendingPageFeedback(tab, [], () => {}, { workflow: true, responseToolCalls: [request] }), false);
    assert.equal(run.passiveSupersessionStreak || 0, 0);
  });

  test(`${build}: preparation failures consume the retry budget before delayed DOM feedback arrives`, () => {
    const { agent, run } = makeAgent();
    for (let attempt = 0; attempt < 5; attempt++) {
      assert.equal(agent._accountPageFeedbackNoDispatch(tab, 'type_ax', noDispatch), true);
    }
    assert.equal(run.recoveryResult?.code, 'page_unstable', 'A content guard may reject immediately while its DOM callback is still coalesced');
    assert.equal(run.passiveSupersessionStreak, 5);
  });

  test(`${build}: later human feedback resets unresolved preparation retries`, () => {
    const { agent, run } = makeAgent();
    for (let attempt = 0; attempt < 4; attempt++) agent._accountPageFeedbackNoDispatch(tab, 'type_ax', noDispatch);
    run.events.set('human', { kind: 'click', source: 'user', frameId: 0, target: 'button#human' });
    agent._accountPageFeedbackNoDispatch(tab, 'type_ax', noDispatch);
    assert.equal(run.passiveSupersessionStreak, 0);
    assert.equal(run.recoveryResult, undefined);
  });

  test(`${build}: pending steering supersedes a terminal recovery from the previous task`, () => {
    const { agent, run } = makeAgent();
    run.passiveSupersessionStreak = 5;
    run.recoveryResult = { code: 'page_unstable', message: 'Old task could not dispatch safely.' };
    agent._hasPendingSteering = () => true;
    assert.equal(agent._pageFeedbackRecoveryResult(tab, [], () => {}), null,
      'The next user instruction must reach steering revalidation before old-task recovery can terminate');
    assert.equal(run.passiveSupersessionStreak, 0);
    assert.ok(!run.recoveryResult);
  });
}
