// A run that deleted a post through the site's own confirmation dialog, in
// vision mode, ends on success. Two things used to stand in the way on a
// Mastodon profile, which always shows an empty composer: the done probe
// counted that composer as a task form left unsent, and the native
// confirmation's receipt carried no document (a vision run reads no
// accessibility tree), so the completion verdict could never certify it. A
// composer that holds text the run typed still keeps done from succeeding.
// Page capture, transport and the independent judge are simulated; the
// Agent's tool batch, done path, guards and receipts are real.
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { test } from 'node:test';
import { fixtureFixedChoiceReply } from './semantic-decision-stub.mjs';

const area = { get: async () => ({ systemOneEnabled: false }), set: async () => {}, remove: async () => {} };
globalThis.chrome = globalThis.browser = { storage: { local: area, session: area }, runtime: { getURL: v => `extension://fixture/${v}` } };
const profileUrl = 'https://mastodon.example.test/@qa_account_a';
const task = 'Delete my test post that says Owned QA post 1.';

for (const build of ['chrome', 'firefox']) {
  const { Agent } = await import(`../src/${build}/src/agent/agent.js`);
  const invariant = await import(`../src/${build}/src/agent/completion-invariant.js`);
  const cdp = build === 'chrome' ? (await import('../src/chrome/src/cdp/cdp-client.js')).cdpClient : null;

  test(`${build}: typing, keys and scripts count as entering text; clicks, navigation and reads do not`, () => {
    const after = (name, args = {}, result = { success: true, dispatched: true }) =>
      invariant.recordCompletionToolResult(invariant.createCompletionInvariantState('run'), name, args, result);
    for (const name of ['type_text', 'type_ax', 'set_field', 'iframe_type', 'execute_js', 'drag_at', 'chat_send']) {
      assert.equal(after(name, { text: 'x' }).fieldTextEntered, true, name);
    }
    assert.equal(after('press_keys', { keys: 'a' }).fieldTextEntered, true);
    for (const name of ['click', 'click_ax', 'iframe_click', 'set_checked', 'navigate', 'go_back', 'read_page',
      'get_accessibility_tree', 'auto_screenshot']) {
      assert.equal(after(name).fieldTextEntered, undefined, name);
    }
    // A write that provably never went out entered nothing.
    assert.equal(after('type_text', { text: 'x' }, { success: false, noDispatch: true, dispatched: false }).fieldTextEntered, undefined);
    // Later reads and clicks keep the record.
    let state = after('type_text', { text: 'x' });
    for (const name of ['click', 'read_page']) state = invariant.recordCompletionToolResult(state, name, {}, { success: true });
    assert.equal(state.fieldTextEntered, true);
  });

  test(`${build}: forms count as untouched only while the run typed nothing and sent only native confirmations`, () => {
    const agent = new Agent({ getActive: () => null });
    agent._progressTaskKeyHash = () => 'owned-task';
    agent._progressTaskAnchorText = () => task;
    agent._planExecutionGuards.set(1, { enabled: true, taskKey: 'owned-task', requiresSubmission: true, requiresStateChange: true });
    assert.equal(agent._completionFormsUntouchedByRun(1), false, 'Without a run nothing is known');
    agent._beginCompletionInvariant(1);
    assert.equal(agent._completionFormsUntouchedByRun(1), true);
    const click = () => agent._recordCompletionToolResult(1, 'click', { x: 10, y: 10 }, { success: true, dispatched: true });
    const receipt = semanticCommit => agent._recordCompletionSubmitAttempt(1, { isSubmit: true, semanticCommit, mutationKind: 'delete' },
      'click', { x: 10, y: 10 }, profileUrl, profileUrl, { success: true, dispatched: true }, 'doc', 'doc');
    click(); assert.equal(agent._completionFormsUntouchedByRun(1), true);
    receipt(true); assert.equal(agent._completionFormsUntouchedByRun(1), true, 'A native confirmation sends no form');
    click(); receipt(false); assert.equal(agent._completionFormsUntouchedByRun(1), false, 'An ordinary submit sent a form');
    click(); receipt(true);
    assert.equal(agent._completionSubmitStates.get(1).formSentEarlier, true);
    assert.equal(agent._completionFormsUntouchedByRun(1), false, 'A later confirmation does not undo an earlier sent form');
    agent._beginCompletionInvariant(1);
    agent._recordCompletionToolResult(1, 'type_text', { text: 'Hello' }, { success: true, dispatched: true });
    assert.equal(agent._completionFormsUntouchedByRun(1), false, 'Typed text may sit in any form');
    // A steering revision starts the objective over, not what the run typed.
    agent._recordCompletionToolResult(1, 'read_page', {}, { success: true, url: profileUrl, text: 'Profile' });
    agent._resetCompletionForSteeringRevision(1);
    assert.equal(agent._completionFormsUntouchedByRun(1), false);
  });

  // The real tool batch, with page, permission and guard checks stood in for:
  // what document a click's receipt is bound to, as it is dispatched.
  async function dispatchClick(detected) {
    const tab = 61;
    const provider = { model: 'owned-offline', supportsVision: false, supportsTools: true, promptTier: 'full',
      contextWindow: 128000, config: { category: 'local' }, chat() {} };
    const agent = new Agent({ getActive: () => provider, getProvider: () => provider });
    agent.conversations.set(tab, [{ role: 'system', content: 'System' }, { role: 'user', content: task }]);
    agent.conversationModes.set(tab, 'act');
    agent._progressTaskKeyHash = () => 'owned-task';
    agent._progressTaskAnchorText = () => task;
    agent._persist = () => {}; agent._persistNow = async () => ({ ok: true });
    agent._ensureProgressSessionForCurrentTask = async () => {};
    agent._currentUrl = async () => profileUrl;
    Object.assign(agent, { _skipPermissionGate: true, _ensureGateSetting: async () => true,
      _chromeProtectedPageFailure: async () => null, _captchaMutationPreflight: async () => null, _adoptLiveSocialPublishWorkflow: async () => false,
      _workflowPreSubmitDispatchBlock: async () => null, _messageRecipientGuardBlock: async () => null, _captureFormValidationState: async () => [],
      _waitForFormValidationFailure: async () => null, _readControlEffect: async () => {},
      _withContentActionDeadline: async fn => fn(new AbortController().signal), _preflightRichTextToolbarTarget: async () => ({ block: null }),
      _socialPublicationPreSubmitBlock: async () => null, _auditRichTextToolbarTarget: async () => {}, _shouldAutoScreenshot: () => false,
      _resourceMutationPreSubmitBlock: async () => null, _steeringPriorSubmissionBlock: () => null });
    agent._detectLikelySubmitAction = async () => structuredClone(detected);
    const seen = { liveReads: 0, atDispatch: null };
    // The content script's live document identity (field_value_digest).
    agent._liveTextMutationScope = async () => { seen.liveReads++; return { documentToken: 'native-document-1', pageUrl: profileUrl }; };
    agent.executeTool = async () => {
      seen.atDispatch = String(agent._lastAxScopes.get(tab)?.documentToken || '');
      return { success: true, dispatched: true };
    };
    agent._beginCompletionInvariant(tab);
    agent._startPlanExecutionGuard(tab, 'act', { requestKind: 'execute', requiresStateChange: true, requiresSubmission: true });
    const call = { id: 'call_confirm', type: 'function', function: { name: 'click', arguments: '{"selector":"#confirm"}' } };
    const messages = agent.conversations.get(tab);
    messages.push({ role: 'assistant', content: '', tool_calls: [call] });
    await agent._executeToolBatch(tab, [call], messages, () => {}, provider, null, new Set(['click']), 1,
      { beforeConsequentialTool: async () => true });
    return { ...seen, receipt: agent._completionSubmitStates.get(tab) };
  }

  test(`${build}: the dispatch path binds a click on a native confirmation to the live document`, async () => {
    const confirm = { isSubmit: true, semanticCommit: true, mutationKind: 'delete', url: profileUrl,
      host: 'mastodon.example.test', frameDocumentIdentity: `${profileUrl}|1` };
    const native = await dispatchClick(confirm);
    assert.equal(native.receipt?.dispatched, true);
    assert.equal(native.receipt?.semanticCommit?.documentToken, 'native-document-1', 'The receipt names the document the click was sent in');
    assert.equal(native.atDispatch, 'native-document-1');
    assert.equal(native.liveReads, 1, 'The page is asked once, before the click');
    // An ordinary submit is not a native confirmation: no extra page read.
    const ordinary = await dispatchClick({ ...confirm, semanticCommit: false, mutationKind: 'submit',
      validationSubmitEvidence: 'strong', method: 'POST' });
    assert.equal(ordinary.liveReads, 0);
    assert.equal(ordinary.receipt?.semanticCommit, null);
  });

  async function fixture({ verdict = 'succeeded', composerText = '', typed = false } = {}) {
    const savedChrome = globalThis.chrome, savedBrowser = globalThis.browser;
    const savedCdp = cdp ? Object.fromEntries(['attach', 'sendCommand', 'evaluate'].map(k => [k, cdp[k]])) : null;
    const h = { url: profileUrl, key: 'owned-delete-task', identityEpoch: 1000, documentToken: 'native-document-1',
      tree: 'main "No posts here."\n textbox "What is on your mind?"\n button "Publish"', judges: 0 };
    const rect = () => ({ width: 200, height: 40 });
    const element = (tagName, extra = {}) => ({ tagName, getBoundingClientRect: rect, getAttribute: () => null, closest: () => null, ...extra });
    // Mastodon's always-present composer: one textarea and seven buttons, in a
    // form with no name. It holds `composerText`.
    const composer = element('FORM', { id: '', querySelector: () => null,
      querySelectorAll: selector => selector.startsWith('input:not') ? [element('TEXTAREA', { value: composerText, required: false })]
        : selector.startsWith('button') ? Array.from({ length: 7 }, () => element('BUTTON', { type: 'button', innerText: '', value: '' }))
          : [] });
    const context = () => ({ location: { href: h.url }, performance: { timeOrigin: h.identityEpoch },
      document: { title: 'Profile', readyState: 'complete', body: { innerText: h.tree }, activeElement: null,
        querySelector: () => null, querySelectorAll: selector => selector === 'form' ? [composer] : [] },
      window: { getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1' }) },
      getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1' }), URL, Map, Set });
    const evaluate = code => vm.runInNewContext(code, context());
    const api = { storage: { local: area, session: area }, runtime: { getURL: v => `extension://fixture/${v}` },
      tabs: { get: async () => ({ id: 51, url: h.url }), executeScript: async (_tab, { code }) => [evaluate(code)] } };
    globalThis.chrome = globalThis.browser = api;
    if (cdp) { cdp.attach = async () => {}; cdp.sendCommand = async () => ({}); cdp.evaluate = async (_tab, code) => ({ result: { value: evaluate(code) } }); }
    h.provider = { model: 'owned-offline', supportsVision: false, config: { category: 'local' }, chat() {} };
    const agent = h.agent = new Agent({ getActive: () => h.provider });
    agent.conversationModes.set(51, 'act');
    agent._progressTaskKeyHash = () => h.key;
    agent._progressTaskAnchorText = () => task;
    agent._captureViewportProbe = async () => ({ url: h.url, title: 'Profile', readyState: 'complete' });
    agent.systemOneContext = () => ({ isCurrent: () => true });
    agent.recordSystemOneVerdict = () => {};
    // The content script's live document identity (field_value_digest).
    agent._liveTextMutationScope = async () => ({ documentToken: h.documentToken, pageUrl: h.url });
    agent.executeTool = async (_tab, name) => {
      assert.equal(name, 'get_accessibility_tree');
      return { success: true, pageUrl: h.url, pageContent: h.tree };
    };
    agent._chatWithCostAllowance = async (_provider, messages) => {
      const reading = fixtureFixedChoiceReply(messages);
      if (reading) return { content: reading };
      h.judges++;
      return { content: JSON.stringify({ outcome: verdict, reason: 'The post is no longer on the profile.' }) };
    };
    h.guard = agent._startPlanExecutionGuard(51, 'act', { requestKind: 'execute', requiresStateChange: true, requiresSubmission: true });
    agent._beginCompletionInvariant(51);
    const record = (name, args, result) => {
      agent._markPlanExecutionToolCall(51, name, result, { consequential: name !== 'auto_screenshot' });
      agent._recordCompletionToolResult(51, name, args, result);
    };
    const observe = () => agent._recordCompletionToolResult(51, 'auto_screenshot', {}, {
      success: true, method: 'image_attach', _attachImage: true, pageUrl: h.url });
    if (typed) { record('type_text', { text: composerText || 'Draft' }, { success: true, dispatched: true }); observe(); }
    // The post's menu, then its Delete item: vision clicks, no receipts.
    for (const point of [{ x: 1300, y: 750 }, { x: 1245, y: 1096 }]) {
      record('click', point, { success: true, dispatched: true, method: 'cdp-vision-pointer' }); observe();
    }
    // What the dispatch path does before it sends a native confirmation.
    h.confirm = async ({ refresh = true } = {}) => {
      if (refresh) await agent._refreshLiveDocumentScope?.(51);
      const before = String(agent._lastAxScopes.get(51)?.documentToken || '');
      const result = { success: true, dispatched: true, method: 'cdp-vision-pointer' };
      record('click', { x: 1281, y: 657 }, result);
      h.submit = agent._recordCompletionSubmitAttempt(51, { isSubmit: true, semanticCommit: true, mutationKind: 'delete' },
        'click', { x: 1281, y: 657 }, h.url, h.url, result, before, String(agent._lastAxScopes.get(51)?.documentToken || ''));
      observe();
    };
    h.done = () => agent._executeToolImpl(51, 'done', { outcome: 'success', summary: 'The test post was deleted.' });
    // The run loop asks the plan-execution guard about a done that went through.
    h.planRefusal = result => agent._planOnlyTerminalDecision(51, result.summary, { viaDone: true, outcome: result.outcome });
    h.close = () => { globalThis.chrome = savedChrome; globalThis.browser = savedBrowser; if (cdp) Object.assign(cdp, savedCdp); };
    return h;
  }

  test(`${build}: a vision run's native deletion is certified by the verdict on its own document and ends on success`, async () => {
    const h = await fixture();
    try {
      assert.equal(h.agent._lastAxScopes.get(51), undefined, 'A vision run has read no accessibility tree');
      await h.confirm();
      assert.equal(h.submit.semanticCommit.documentToken, 'native-document-1', 'The commit is bound to the live document');
      const result = await h.done();
      assert.equal(result.done, true, JSON.stringify(result));
      assert.equal(result.outcome, 'success');
      assert.equal(h.judges, 1);
      assert.equal(h.guard.verifiedSubmissionEvidence, true);
      assert.equal(result.verification.completionWarning, null, 'The empty composer is not a form left unsent');
      assert.equal(h.planRefusal(result), null);
      assert.equal(h.agent._guardCaveatLine(51), '', 'No "could not verify" caveat contradicts the verdict');
    } finally { h.close(); }
  });

  test(`${build}: a document that replaced the one the deletion was sent in cannot be certified`, async () => {
    const h = await fixture();
    try {
      await h.confirm();
      h.documentToken = 'native-document-2';
      const result = await h.done();
      assert.notEqual(h.guard.verifiedSubmissionEvidence, true);
      assert.match(h.planRefusal(result)?.nudge || '', /PLAN EXECUTION BLOCK/);
    } finally { h.close(); }
  });

  test(`${build}: without a document the deletion stays unverified, as before`, async () => {
    const h = await fixture();
    try {
      await h.confirm({ refresh: false });
      assert.equal(h.submit.semanticCommit.documentToken, '');
      const result = await h.done();
      assert.notEqual(h.guard.verifiedSubmissionEvidence, true);
      assert.match(h.planRefusal(result)?.nudge || '', /PLAN EXECUTION BLOCK/);
    } finally { h.close(); }
  });

  test(`${build}: before a verdict, the empty composer is not what refuses done; a typed draft still is`, async () => {
    for (const [name, options, pageBlock] of [
      ['untouched composer', {}, false],
      ['composer holding text this run typed', { composerText: 'Owned draft', typed: true }, true],
      ['emptied composer on a run that typed', { typed: true }, true],
    ]) {
      const h = await fixture({ verdict: 'uncertain', ...options });
      try {
        await h.confirm();
        const result = await h.done();
        const pageState = result.pageState || result.verification?.pageState;
        assert.equal(pageState.relevantFormCount, pageBlock ? 1 : 0, name);
        if (pageBlock) {
          assert.equal(result.completionPageBlock, true, `${name}: ${JSON.stringify(result)}`);
          assert.match(result.error, /task-relevant form is still visible/);
        } else {
          // The deletion is still unproven: the plan guard asks for the result.
          assert.equal(result.done, true, `${name}: ${JSON.stringify(result)}`);
          assert.equal(result.verification.completionWarning, null, name);
          assert.match(h.planRefusal(result)?.nudge || '', /PLAN EXECUTION BLOCK/, name);
        }
      } finally { h.close(); }
    }
  });
}
