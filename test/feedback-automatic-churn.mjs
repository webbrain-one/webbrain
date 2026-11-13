// Real Agent loop and page-feedback methods with mocked browser/content APIs
// (unit level, both builds). Automatic page churn must not hard-supersede
// revalidatable decisions, and every supersession it causes is bounded.
import assert from 'node:assert/strict';
import { test } from 'node:test';

const PAGE_URL = 'https://shop.example/item/1';
const TREE = 'main [ref_main]\n heading "Blue shoes" [ref_h]\n button "Add to cart" [ref_add]';
const area = { get: async () => ({}), set: async () => {}, remove: async () => {} };
const pages = new Map();
let snapshots = 0;
const api = {
  storage: { local: area, session: area },
  runtime: { getURL: value => `extension://test/${value}`, sendMessage: async () => ({}) },
  tabs: {
    get: async id => ({ id, url: PAGE_URL, title: 'Shop' }),
    sendMessage: async (id, message) => {
      const page = pages.get(id) || {};
      if (message.action === 'page_monitor_capture_model') {
        return { ready: true, runToken: message.params.runToken, documentToken: page.documentToken ?? 'main-token', snapshotToken: 'snapshot-' + (++snapshots),
          targetCount: 2, focusedTargetAvailable: false, page: { success: true, url: PAGE_URL, pageContent: page.tree ?? TREE } };
      }
      if (message.action === 'page_monitor_validate_model') {
        (page.validations ??= []).push(message.params.snapshotToken);
        const changed = page.targetChanged === true;
        return { ready: !changed, ...(changed ? { reason: 'target_changed' } : {}), runToken: message.params.runToken,
          documentToken: page.documentToken ?? 'main-token', snapshotToken: message.params.snapshotToken };
      }
      if (message.action === 'page_monitor_prepare') {
        (page.preparations ??= []).push(message.params);
        page.onPrepare?.(message.params);
        return { ready: true, modelBindingValid: true };
      }
      return { ready: true };
    },
  },
  webNavigation: { getAllFrames: async ({ tabId }) => [{ frameId: 0, parentFrameId: -1,
    documentId: pages.get(tabId)?.documentId ?? 'main-document', url: PAGE_URL },
    { frameId: 1, parentFrameId: 0, documentId: 'ad-document', url: 'https://ads.example/slot' }] },
  scripting: { executeScript: async () => [{ result: null }] },
};
globalThis.chrome = api;
globalThis.browser = api;
let nextTab = 7400;

function makeAgent(Agent, next) {
  const provider = { name: 'automatic churn test', model: 'test', promptTier: 'full', contextWindow: 128000,
    supportsTools: true, supportsVision: false,
    chat: messages => next(messages),
    async *chatStream(messages) {
      const response = await next(messages);
      if (response.content) yield { type: 'text', content: response.content };
      if (response.toolCalls) yield { type: 'tool_call', content: response.toolCalls.map((call, index) => ({ ...call, index })) };
      yield { type: 'done' };
    } };
  const agent = new Agent({ getActive: () => provider, getProvider: () => provider, getVisionProvider: async () => null });
  Object.assign(agent, {
    _hydrate: async () => {}, _persist: () => {}, _persistNow: async () => ({ ok: true }), _persistSubmittedTurn: async () => {},
    _startTraceRun: async () => null, _endTraceRun: async () => {}, _beginReadCompleteness: async () => null,
    _manageContext: async () => {}, _checkCostAllowance: async () => null, _recordCostUsage: async () => null,
    _currentUrl: async () => PAGE_URL, _getTabUrlTitle: async () => ({ tabUrl: PAGE_URL, tabTitle: 'Shop' }),
    _maybeEmitAskModeHandoff: async () => {}, _maybeReinjectAdapter: async () => {}, _ensureProgressSessionForCurrentTask: async () => {},
    _plannerMode: () => 'off',
    _runPlannerIntentGate: async () => ({ proceed: true, requestKind: 'execute', requiresStateChange: false, requiresSubmission: false }),
    _skipPermissionGate: true, _ensureGateSetting: async () => true, _adoptLiveSocialPublishWorkflow: async () => false,
    _isFormValidationCandidate: () => false, _preflightRichTextToolbarTarget: async () => ({ block: null }),
    _auditRichTextToolbarTarget: async () => {}, _shouldAutoScreenshot: () => false, _pageFeedbackIdleMs: 0,
    _completionDoneBlock: () => null,
  });
  for (const name of ['_chromeProtectedPageFailure', '_captchaMutationPreflight', '_workflowPreSubmitDispatchBlock',
    '_messageRecipientGuardBlock', '_detectLikelySubmitAction', '_socialPublicationPreSubmitBlock']) agent[name] = async () => null;
  return agent;
}

// Content monitors for the main document and an embedded ad frame.
function bindFrames(agent, tab) {
  const make = (frameId, documentId, documentToken, url) => {
    const from = { tab: { id: tab }, frameId, documentId, url };
    const state = agent.pageMonitorState(from, documentToken);
    assert.equal(state.active, true);
    let seq = 0;
    return value => assert.equal(agent.observePageFeedback(from, { ...state, seq: ++seq, revision: seq,
      kind: 'dom', source: 'page', target: 'span#price', ...value }).accepted, true);
  };
  const page = pages.get(tab) || {};
  return { main: make(0, page.documentId ?? 'main-document', page.documentToken ?? 'main-token', PAGE_URL),
    child: make(1, 'ad-document', 'ad-token', 'https://ads.example/slot') };
}

const call = (id, name, args) => ({ toolCalls: [{ id, function: { name, arguments: JSON.stringify(args) } }] });
const AUTOMATIC = {
  child_frame_dom: (agent, tab, frames) => frames.child({ kind: 'dom', source: 'page', target: 'div#ad' }),
  page_focus: (agent, tab, frames) => frames.main({ kind: 'activity', source: 'page', target: 'input#search' }),
  iframe_focus: (agent, tab, frames) => frames.main({ kind: 'activity', source: 'page', target: 'iframe#ad' }),
  unknown_scroll: (agent, tab, frames) => frames.main({ kind: 'scroll', source: 'unknown', target: 'div#carousel', viewport: { x: 400, y: 0 } }),
  unknown_dom: (agent, tab, frames) => frames.main({ kind: 'dom', source: 'unknown', target: 'div#feed' }),
  synthetic_input: (agent, tab, frames) => frames.main({ kind: 'input', source: 'page', target: 'input#q' }),
  child_navigation: (agent, tab) => agent.observePageNavigation({ tabId: tab, frameId: 1, parentFrameId: 0, documentId: 'ad-document-2',
    url: 'https://ads.example/slot?r=' + Math.random(), transitionType: 'auto_subframe', transitionQualifiers: [] }, 'committed'),
};

for (const build of ['chrome', 'firefox']) {
  const { Agent } = await import(`../src/${build}/src/agent/agent.js`);
  const policy = await import(`../src/${build}/src/agent/page-feedback-policy.js`);
  const { beforePageAgentDispatch } = await import(`../src/${build}/src/agent/page-feedback.js`);

  test(`${build}: automatic classifier separates page churn from intervention and unknown navigation`, () => {
    const automatic = [
      { kind: 'dom', source: 'page', frameId: 0, target: 'span' }, { kind: 'dom', source: 'unknown', frameId: 0, target: 'div' },
      { kind: 'dom', source: 'page', frameId: 3, target: 'div' }, { kind: 'activity', source: 'page', frameId: 0, target: 'input#q' },
      { kind: 'activity', source: 'page', frameId: 0, target: 'iframe#editor' }, { kind: 'input', source: 'page', frameId: 0, target: 'input#q' },
      { kind: 'scroll', source: 'unknown', frameId: 0, target: 'html' }, { kind: 'scroll', source: 'page', frameId: 2, target: 'div' },
      { kind: 'resize', source: 'page', frameId: 2, target: 'viewport' }, { kind: 'resize', source: 'unknown', frameId: 2, target: 'viewport' },
      { kind: 'navigation', source: 'unknown', frameId: 1 }, { kind: 'navigation', source: 'page', frameId: 4 },
    ];
    const strict = [
      ...['click', 'input', 'selection', 'scroll', 'activity', 'dom', 'navigation'].map(kind => ({ kind, source: 'user', frameId: 0, target: 'a' })),
      { kind: 'navigation', source: 'unknown', frameId: 0 }, { kind: 'navigation', source: 'page', frameId: 0 },
      { kind: 'resize', source: 'unknown', frameId: 0, target: 'viewport' },
      { kind: 'dom', source: 'page', frameId: 0, target: 'style' }, { kind: 'dom', source: 'unknown', frameId: 1, target: 'link#theme' },
      { kind: 'activity', source: 'page', frameId: 0, target: 'base' }, { kind: 'activity', source: 'unknown', frameId: 0, target: 'input' },
      { kind: 'input', source: 'unknown', frameId: 0, target: 'input' }, { kind: 'click', source: 'page', frameId: 0, target: 'button' },
      { kind: 'selection', source: 'page', frameId: 0, target: 'p' }, { kind: 'constructor', source: 'page', frameId: 0 }, null,
    ];
    for (const event of automatic) assert.equal(policy.isAutomaticPageFeedbackEvent(event), true, JSON.stringify(event));
    for (const event of strict) assert.equal(policy.isAutomaticPageFeedbackEvent(event), false, JSON.stringify(event));
    assert.equal(policy.isAutomaticPageFeedback(automatic), true);
    assert.equal(policy.isAutomaticPageFeedback([...automatic, strict[0]]), false, 'One user event makes the batch an intervention');
    assert.equal(policy.isAutomaticPageFeedback([]), false);
  });

  test(`${build}: automatic churn retains reads, independent tools and Act completions but keeps unsafe and legacy non-DOM fences`, () => {
    const page = { success: true, pageContent: TREE };
    const state = { url: PAGE_URL, page };
    const keep = (name, args, events, current = page, scope = state) =>
      policy.canRetainPageFeedbackCalls([{ function: { name, arguments: JSON.stringify(args) } }], scope, current, events);
    const childDom = [{ kind: 'dom', source: 'page', frameId: 1, target: 'div' }];
    const focus = [{ kind: 'activity', source: 'page', frameId: 0, target: 'input#search' }];
    const scroll = [{ kind: 'scroll', source: 'unknown', frameId: 0, target: 'div#feed' }];
    for (const events of [childDom, focus, scroll]) {
      assert.equal(keep('read_page', {}, events), true);
      assert.equal(keep('calculate', { expression: '2 + 2' }, events), true);
      assert.equal(keep('click', { x: 10, y: 20 }, events), false, 'Coordinates stay fenced');
      assert.equal(keep('execute_js', { code: 'save()' }, events), false, 'Scripts stay fenced');
      // An Act completion survives automatic churn; its batch verifies it.
      assert.equal(keep('done', { summary: 'Done', outcome: 'success' }, events), true, 'Act completion survives automatic churn');
      // Ask answers keep their own scope classification and passive-only fence.
      assert.equal(keep('done', { summary: 'The price is 12' }, events, page, { ...state, runMode: 'ask' }), false,
        'Ask answers keep passive-only retention');
      // A user gesture during inference still supersedes the completion.
      assert.equal(keep('done', { summary: 'Done', outcome: 'success' },
        [...events, { kind: 'click', source: 'user', frameId: 0, target: 'button#other' }]), false, 'User input supersedes a completion');
      assert.equal(keep('done', { summary: 'Done', outcome: 'success' },
        [...events, { kind: 'navigation', source: 'unknown', frameId: 0 }]), false, 'Main-frame navigation supersedes a completion');
    }
    assert.equal(keep('chat_observe', {}, focus), false, 'Read preparation stays fenced after page focus changes');
    assert.equal(keep('chat_observe', {}, scroll), true);
    // Legacy AX comparison (no private footprint) certifies text only.
    assert.equal(keep('click_ax', { ref_id: 'ref_add' }, childDom), true);
    assert.equal(keep('click_ax', { ref_id: 'ref_add' }, [{ kind: 'dom', source: 'unknown', frameId: 0, target: 'div' }]), true);
    assert.equal(keep('click_ax', { ref_id: 'ref_add' }, scroll), false);
    assert.equal(keep('click_ax', { ref_id: 'ref_add' }, [{ kind: 'navigation', source: 'unknown', frameId: 1 }]), false);
    assert.equal(keep('click_ax', { ref_id: 'ref_add' }, childDom, { ...page, pageContent: TREE.replace('Blue shoes', 'Red shoes') }), false,
      'A changed owner/entity still supersedes a legacy target');
    const bound = { ...state, actionBinding: { snapshotToken: 'private', runToken: 'run', documentToken: 'doc' } };
    for (const events of [childDom, focus, scroll]) assert.equal(keep('click_ax', { ref_id: 'ref_add' }, events, page, bound), true,
      'A private footprint is a revalidation candidate under automatic churn');
    for (const event of [{ kind: 'click', source: 'user', frameId: 0, target: 'button' }, { kind: 'navigation', source: 'unknown', frameId: 0 },
      { kind: 'resize', source: 'unknown', frameId: 0, target: 'viewport' }]) {
      assert.equal(keep('read_page', {}, [event]), false);
      assert.equal(keep('click_ax', { ref_id: 'ref_add' }, [event], page, bound), false);
    }
  });

  test(`${build}: scroll intent survives automatic text changes without granting mixed batches or intervention a bypass`, () => {
    const page = { success: true, pageContent: TREE };
    const state = { url: PAGE_URL, page };
    const changed = { ...page, pageContent: TREE + '\n status "Updated moments ago" [ref_clock]' };
    const automatic = [
      { kind: 'dom', source: 'page', frameId: 0, target: 'span#clock' },
      { kind: 'dom', source: 'unknown', frameId: 0, target: 'div#feed' },
    ];
    const retains = (name, args, events = automatic) => policy.canRetainPageFeedbackCalls(
      [{ function: { name, arguments: JSON.stringify(args) } }], state, changed, events);
    const inputs = [{ direction: 'down', amount: 600 }, { direction: 'bottom', ref_id: 'ref_main' },
      { direction: 'down', x: 320, y: 500 }];
    for (const input of inputs) {
      assert.equal(policy.pageFeedbackCallPolicy('scroll', input, state, changed, automatic).kind, 'scroll');
      assert.equal(retains('scroll', input), true, 'Unrelated fresh AX text must not invalidate scrolling');
      assert.equal(retains('scroll', input, [{ kind: 'dom', source: 'page', frameId: 0, target: 'span#clock' }]), true);
      for (const event of [{ kind: 'scroll', source: 'user', frameId: 0, target: 'html' },
        { kind: 'navigation', source: 'unknown', frameId: 0 }]) {
        assert.equal(retains('scroll', input, [...automatic, event]), false);
      }
    }
    const batch = { actions: inputs.map(input => ({ name: 'scroll', input })) };
    assert.equal(policy.pageFeedbackCallPolicy('browser_batch', batch, state, changed, automatic).kind, 'scroll');
    assert.equal(retains('browser_batch', batch), true, 'Scroll-only batches use the same freshness policy');
    for (const action of [{ name: 'click', input: { x: 320, y: 500 } },
      { name: 'execute_js', input: { code: 'save()' } }]) {
      assert.equal(retains('browser_batch', { actions: [...batch.actions, action] }), false,
        'Adding a fenced action must not inherit scroll retention');
    }
    for (const input of [{ direction: 'down', frameId: 2 }, { direction: 'down', targetFrame: 2 },
      { direction: 'down', allFrames: true }]) assert.equal(retains('scroll', input), false,
      'Only the current top document has this scroll policy');
    assert.equal(retains('browser_batch', { actions: [] }), false);
    assert.equal(retains('browser_batch', { actions: [{ name: 'browser_batch', input: batch }] }), false);
  });

  for (const streaming of [false, true]) {
    for (const scenario of [
      { name: 'viewport scroll', input: { direction: 'down', amount: 600 } },
      { name: 'pane ref scroll', input: { direction: 'bottom', ref_id: 'ref_main' } },
      { name: 'batched coordinate scroll', input: { direction: 'down', x: 320, y: 500 }, batch: true },
    ]) {
      test(`${build}: ${streaming ? 'stream' : 'chat'} ${scenario.name} executes once through continuous DOM and AX text updates`, async () => {
        const tab = nextTab++, dispatched = [], updates = [];
        let agent, frames, requests = 0, terminal = null;
        pages.set(tab, {});
        agent = makeAgent(Agent, async () => {
          requests++;
          assert.ok(requests <= 2, 'Automatic changes must not regenerate the same scroll or completed answer');
          pages.get(tab).tree = TREE + `\n status "Refresh ${requests}" [ref_clock]`;
          // Each model call overlaps real main-document updates, including
          // unattributed effects. The fresh AX tree changes as well.
          frames.main({ kind: 'dom', source: 'page', target: 'span#clock' });
          frames.main({ kind: 'dom', source: 'unknown', target: 'div#feed' });
          AUTOMATIC.child_navigation(agent, tab, frames);
          if (requests > 1) return call('finished', 'done', { summary: 'Scrolled down', outcome: 'success' });
          return scenario.batch
            ? call('scroll-batch', 'browser_batch', { actions: [{ name: 'scroll', input: scenario.input }] })
            : call('scroll-once', 'scroll', scenario.input);
        });
        agent.maxSteps = 7;
        agent._endTraceRun = async (_tab, _run, status) => { terminal = status; };
        agent._enrichUserMessageWithCurrentPage = async (_tab, _messages, content) => { frames = bindFrames(agent, tab); return { role: 'user', content }; };
        pages.get(tab).onPrepare = params => {
          if (params.tool === 'scroll') frames.main({ kind: 'dom', source: 'unknown', target: 'div#during-prepare' });
        };
        agent._executeToolWithLifecycle = async (_tab, tool, args, _update, context) => {
          if (tool === 'get_accessibility_tree') return { success: true, pageContent: pages.get(tab).tree ?? TREE };
          if (tool === 'scroll') {
            frames.main({ kind: 'dom', source: 'unknown', target: 'div#before-scroll' });
            await beforePageAgentDispatch(api, tab, { kind: 'scroll', fenceOnly: true });
            context._contentActionDispatchState.started = true;
          }
          dispatched.push({ tool, args });
          return tool === 'done' ? { done: true, success: true, summary: args.summary, outcome: args.outcome }
            : { success: true, dispatched: true, moved: true, movedWindow: true, scrollY: 600 };
        };
        try {
          const options = { detachedRequestId: 'scroll-churn-' + tab, askStreamingEnabled: false };
          const update = (type, data) => updates.push({ type, data });
          const result = streaming ? await agent.processMessageStream(tab, 'Scroll down', update, 'act', options)
            : await agent.processMessage(tab, 'Scroll down', update, 'act', [], options);
          assert.equal(result, 'Scrolled down');
          assert.equal(requests, 2);
          assert.deepEqual(dispatched.map(item => item.tool), ['scroll', 'done']);
          assert.deepEqual(dispatched[0].args, scenario.input, 'Keep the original pane/coordinate intent');
          const prepared = pages.get(tab).preparations.filter(item => item.tool === 'scroll');
          assert.equal(prepared.length, 1, 'There is one scroll preparation and dispatch');
          assert.equal(prepared[0].allowPassiveRebase, true, 'The content dispatch fence can rebase automatic changes');
          if (scenario.batch) {
            const result = updates.find(event => event.type === 'tool_result' && event.data.name === 'browser_batch');
            assert.equal(result?.data.result.success, true);
            assert.equal(result.data.result.summary, '[browser_batch] ran 1 of 1 actions');
          }
          assert.notEqual(terminal, 'page_unstable');
          assert.equal(agent._pageFeedbackRuns.size, 0);
        } finally { pages.delete(tab); }
      });
    }
  }

  for (const streaming of [false, true]) {
    for (const intervention of ['user_scroll', 'main_document_replacement']) {
      test(`${build}: ${streaming ? 'stream' : 'chat'} ${intervention} still supersedes stale scroll intent`, async () => {
        const tab = nextTab++, dispatched = [];
        let agent, frames, requests = 0;
        pages.set(tab, {});
        agent = makeAgent(Agent, async () => {
          requests++;
          if (requests === 1) {
            if (intervention === 'user_scroll') frames.main({ kind: 'scroll', source: 'user', target: 'html', viewport: { x: 0, y: 600 } });
            else {
              Object.assign(pages.get(tab), { documentId: 'main-document-next', documentToken: 'main-token-next' });
              agent.observePageNavigation({ tabId: tab, frameId: 0, parentFrameId: -1,
                documentId: 'main-document-next', url: PAGE_URL, transitionType: 'reload', transitionQualifiers: [] }, 'committed');
              // The replacement content script joins the run before the
              // refreshed observation and next model decision.
              frames = bindFrames(agent, tab);
            }
            return call('stale-scroll', 'scroll', { direction: 'down', amount: 111 });
          }
          if (requests === 2) return call('fresh-scroll', 'scroll', { direction: 'down', amount: 222 });
          assert.equal(requests, 3);
          return call('finished', 'done', { summary: 'Scrolled from the fresh page', outcome: 'success' });
        });
        agent.maxSteps = 7;
        agent._enrichUserMessageWithCurrentPage = async (_tab, _messages, content) => { frames = bindFrames(agent, tab); return { role: 'user', content }; };
        agent._executeToolWithLifecycle = async (_tab, tool, args) => {
          if (tool === 'get_accessibility_tree') return { success: true, pageContent: TREE };
          dispatched.push({ tool, args });
          return tool === 'done' ? { done: true, success: true, summary: args.summary, outcome: args.outcome }
            : { success: true, dispatched: true, moved: true, movedWindow: true, scrollY: 222 };
        };
        try {
          const options = { detachedRequestId: 'scroll-intervention-' + tab, askStreamingEnabled: false };
          const result = streaming ? await agent.processMessageStream(tab, 'Scroll down', () => {}, 'act', options)
            : await agent.processMessage(tab, 'Scroll down', () => {}, 'act', [], options);
          assert.equal(result, 'Scrolled from the fresh page');
          assert.equal(requests, 3, 'The model must reconsider scrolling after intervention or document replacement');
          assert.deepEqual(dispatched.map(item => item.tool), ['scroll', 'done']);
          assert.equal(dispatched[0].args.amount, 222, 'The pre-intervention scroll is never dispatched');
        } finally { pages.delete(tab); }
      });
    }
  }

  // OpenAI-compatible relays send "" for a call without arguments. A timeline
  // ticking behind the page must not supersede that read until page_unstable:
  // it is retained and runs once with {}, as the executor reads it.
  for (const streaming of [false, true]) {
    test(`${build}: ${streaming ? 'stream' : 'chat'} an argument-less read survives passive churn and runs with {}`, async () => {
      const tab = nextTab++, dispatched = [];
      let agent, frames, requests = 0, terminal = null;
      pages.set(tab, {});
      agent = makeAgent(Agent, async () => {
        requests++;
        frames.main({ kind: 'dom', source: 'page', target: 'div#timeline' });
        if (dispatched.some(item => item.tool === 'read_page')) return call('finished', 'done', { summary: 'Read the page', outcome: 'success' });
        return { toolCalls: [{ id: 'bare-read-' + requests, function: { name: 'read_page', arguments: '' } }] };
      });
      agent.maxSteps = 12;
      agent._endTraceRun = async (_tab, _run, status) => { terminal = status; };
      agent._enrichUserMessageWithCurrentPage = async (_tab, _messages, content) => { frames = bindFrames(agent, tab); return { role: 'user', content }; };
      agent._executeToolWithLifecycle = async (_tab, tool, args) => {
        if (tool === 'get_accessibility_tree') return { success: true, pageContent: TREE };
        dispatched.push({ tool, args });
        return tool === 'done' ? { done: true, success: true, summary: args.summary, outcome: args.outcome }
          : { success: true, pageContent: TREE };
      };
      try {
        const options = { detachedRequestId: 'bare-read-' + tab, askStreamingEnabled: false };
        const result = streaming ? await agent.processMessageStream(tab, 'Read the page', () => {}, 'act', options)
          : await agent.processMessage(tab, 'Read the page', () => {}, 'act', [], options);
        assert.notEqual(terminal, 'page_unstable');
        assert.deepEqual(dispatched.map(item => item.tool), ['read_page', 'done']);
        assert.deepEqual(dispatched[0].args, {});
        assert.equal(requests, 2, 'The argument-less read is not regenerated');
        assert.equal(result, 'Read the page');
      } finally { pages.delete(tab); }
    });
  }

  test(`${build}: a deterministic scroll without model state dispatches on a quiet page`, async () => {
    const tab = nextTab++, agent = makeAgent(Agent, async () => assert.fail('No inference'));
    const dispatched = [];
    const input = { direction: 'down', amount: 600 };
    pages.set(tab, {});
    await agent._claimRunEntry(tab, 'interactive');
    try {
      bindFrames(agent, tab);
      const run = agent._pageFeedbackRuns.get(tab);
      assert.equal(run.modelState, undefined, 'Saved workflow replay has no pre-inference observation');
      assert.equal(run.events.size, 0);
      agent._executeToolWithLifecycle = async (_tab, tool, args) => {
        assert.equal(tool, 'scroll');
        await beforePageAgentDispatch(api, tab, { kind: 'scroll', fenceOnly: true });
        dispatched.push({ tool, args });
        return { success: true, dispatched: true, moved: true, movedWindow: true };
      };
      const result = await agent.executeTool(tab, 'scroll', input);
      assert.equal(result.success, true);
      assert.equal(result.dispatched, true);
      assert.notEqual(result.pageFeedbackPending, true);
      assert.deepEqual(dispatched, [{ tool: 'scroll', args: input }]);
      assert.equal(run.modelState, undefined);
    } finally { pages.delete(tab); agent._releaseRunEntry(tab); }
  });

  for (const change of ['steering_revision', 'run_mode']) {
    for (const phase of ['preparation', 'dispatch_boundary']) {
      test(`${build}: ${change} during scroll ${phase} fences dispatch even without page events`, async () => {
        const tab = nextTab++, agent = makeAgent(Agent, async () => assert.fail('No inference'));
        let handlerCalls = 0;
        pages.set(tab, {});
        await agent._claimRunEntry(tab, 'interactive');
        try {
          agent._runModeOverrides.set(tab, 'act');
          const steering = { acceptedIds: new Set(), messages: [] };
          agent._steeringRuns.set(tab, steering);
          bindFrames(agent, tab);
          const messages = [{ role: 'system', content: '' }, { role: 'user', content: 'Scroll down' }];
          agent.conversations.set(tab, messages);
          await agent._capturePageFeedbackModelState(tab, messages);
          const run = agent._pageFeedbackRuns.get(tab);
          const changeAuthority = () => {
            assert.equal(run.events.size, 0, 'The regression requires an empty page-feedback queue');
            if (change === 'steering_revision') steering.acceptedIds.add('accepted-correction');
            else agent._runModeOverrides.set(tab, 'ask');
          };
          pages.get(tab).onPrepare = params => {
            if (params.tool === 'scroll' && phase === 'preparation') changeAuthority();
          };
          agent._executeToolWithLifecycle = async (_tab, tool) => {
            if (tool === 'get_accessibility_tree') return { success: true, pageContent: TREE };
            assert.equal(tool, 'scroll');
            handlerCalls++;
            assert.equal(phase, 'dispatch_boundary', 'A change during preparation rejects before the scroll handler');
            changeAuthority();
            await assert.rejects(beforePageAgentDispatch(api, tab, { kind: 'scroll', fenceOnly: true }),
              error => error?.code === 'page_feedback_pending', 'The owner fence checks authority before its empty-queue return');
            return { success: false, noDispatch: true, dispatched: false, pageFeedbackPending: true };
          };
          const result = await agent.executeTool(tab, 'scroll', { direction: 'down', amount: 600 });
          assert.equal(result.noDispatch, true);
          assert.equal(result.pageFeedbackPending, true);
          assert.equal(handlerCalls, phase === 'preparation' ? 0 : 1);
          assert.equal(run.events.size, 0);
          assert.equal(pages.get(tab).preparations.filter(item => item.tool === 'scroll').length, 1);
        } finally {
          pages.delete(tab);
          agent._steeringRuns.delete(tab);
          agent._runModeOverrides.delete(tab);
          agent._releaseRunEntry(tab);
        }
      });
    }
  }

  if (build === 'chrome') {
    test('chrome: the initial scroll preparation uses the same last-interaction pane as dispatch', async () => {
      const tab = nextTab++, agent = makeAgent(Agent, async () => assert.fail('No inference'));
      const dispatched = [];
      pages.set(tab, {});
      await agent._claimRunEntry(tab, 'interactive');
      try {
        bindFrames(agent, tab);
        const messages = [{ role: 'system', content: '' }, { role: 'user', content: 'Scroll down in this pane' }];
        agent.conversations.set(tab, messages);
        await agent._capturePageFeedbackModelState(tab, messages);
        agent._lastInteractionRect.set(tab, { x: 300, y: 400, w: 40, h: 80, ts: Date.now(), url: PAGE_URL });
        pages.get(tab).onPrepare = params => {
          if (params.tool === 'scroll') assert.deepEqual({ x: params.x, y: params.y }, { x: 320, y: 440 },
            'The first content-monitor preparation must already target the last-interaction pane');
        };
        agent._executeToolWithLifecycle = async (_tab, tool, args) => {
          if (tool === 'get_accessibility_tree') return { success: true, pageContent: TREE };
          assert.equal(tool, 'scroll');
          dispatched.push(args);
          return { success: true, dispatched: true, moved: true, movedContainer: true };
        };
        assert.equal((await agent.executeTool(tab, 'scroll', { direction: 'down', amount: 600 })).success, true);
        assert.deepEqual(dispatched, [{ direction: 'down', amount: 600, x: 320, y: 440, origin: 'last_interaction' }]);
        const prepared = pages.get(tab).preparations.filter(item => item.tool === 'scroll');
        assert.equal(prepared.length, 1);
        assert.equal(prepared[0].allowPassiveRebase, true);
      } finally { pages.delete(tab); agent._releaseRunEntry(tab); }
    });
  }

  for (const [name, emit] of Object.entries(AUTOMATIC)) {
    test(`${build}: a bound action revalidates through ${name} and dispatches on the first decision`, async () => {
      const tab = nextTab++, updates = [], dispatched = [];
      let agent, frames, requests = 0;
      pages.set(tab, {});
      agent = makeAgent(Agent, async () => {
        requests++;
        if (requests === 1) { emit(agent, tab, frames); return call('add-1', 'click_ax', { ref_id: 'ref_add' }); }
        return call('finished', 'done', { summary: 'Added to cart', outcome: 'success' });
      });
      agent.maxSteps = 6;
      agent._enrichUserMessageWithCurrentPage = async (_tab, _messages, content) => { frames = bindFrames(agent, tab); return { role: 'user', content }; };
      agent._executeToolWithLifecycle = async (_tab, tool, args) => {
        if (tool === 'get_accessibility_tree') return { success: true, pageContent: TREE };
        dispatched.push(tool);
        return tool === 'done' ? { done: true, success: true, summary: args.summary, outcome: args.outcome }
          : { success: true, dispatched: true, verified: true };
      };
      try {
        const result = await agent.processMessage(tab, 'Add the blue shoes to the cart', (type, data) => updates.push({ type, data }), 'act', [],
          { detachedRequestId: 'automatic-' + tab, askStreamingEnabled: false });
        assert.equal(result, 'Added to cart');
        assert.deepEqual(dispatched, ['click_ax', 'done'], 'Automatic churn must not discard the revalidated decision');
        assert.equal(requests, 2);
        assert.ok(pages.get(tab).validations.length >= 1, 'The private footprint was revalidated');
        assert.equal(agent._pageFeedbackRuns.size, 0);
      } finally { pages.delete(tab); }
    });
  }

  for (const streaming of [false, true]) {
    test(`${build}: ${streaming ? 'stream' : 'chat'} continuous churn with a changed bound target stops at the bounded budget`, async () => {
      const tab = nextTab++, updates = [], dispatched = [];
      let agent, frames, requests = 0, terminal = null;
      pages.set(tab, { targetChanged: true });
      agent = makeAgent(Agent, async () => {
        requests++;
        assert.ok(requests <= 5, 'Automatic churn must count toward page_unstable instead of resetting it');
        frames.child({ kind: 'dom', source: 'page', target: 'div#ad' });
        return call('add-' + requests, 'click_ax', { ref_id: 'ref_add' });
      });
      agent.maxSteps = 9;
      agent._endTraceRun = async (_tab, _run, status) => { terminal = status; };
      agent._enrichUserMessageWithCurrentPage = async (_tab, _messages, content) => { frames = bindFrames(agent, tab); return { role: 'user', content }; };
      agent._executeToolWithLifecycle = async (_tab, tool) => {
        if (tool === 'get_accessibility_tree') return { success: true, pageContent: TREE };
        dispatched.push(tool); return { success: true, dispatched: true };
      };
      try {
        const options = { detachedRequestId: 'bounded-' + tab, askStreamingEnabled: false };
        const update = (type, data) => updates.push({ type, data });
        const result = streaming ? await agent.processMessageStream(tab, 'Add the blue shoes', update, 'act', options)
          : await agent.processMessage(tab, 'Add the blue shoes', update, 'act', [], options);
        assert.match(result, /could not validate the next action/);
        assert.doesNotMatch(result, /page kept changing/, 'A recovery message must describe failed validation rather than claim visible change');
        assert.equal(terminal, 'page_unstable');
        assert.equal(requests, 5);
        assert.deepEqual(dispatched, [], 'A changed bound target is never dispatched');
        assert.ok(pages.get(tab).validations.length >= 5, 'Each automatic batch consulted the private footprint');
      } finally { pages.delete(tab); }
    });
  }

  for (const streaming of [false, true]) {
    test(`${build}: ${streaming ? 'stream' : 'chat'} a finished task under continuous ad-frame churn ends with its answer`, async () => {
      const tab = nextTab++, dispatched = [];
      let agent, frames, requests = 0, terminal = null;
      pages.set(tab, {});
      agent = makeAgent(Agent, async () => {
        requests++;
        // The ad frame ticks during every inference, as on many real pages.
        frames.child({ kind: 'dom', source: 'page', target: 'div#ad' });
        frames.main({ kind: 'scroll', source: 'unknown', target: 'div#carousel', viewport: { x: 100 * requests, y: 0 } });
        return requests === 1 ? call('add-1', 'click_ax', { ref_id: 'ref_add' })
          : call('finished-' + requests, 'done', { summary: 'Added to cart', outcome: 'success' });
      });
      agent.maxSteps = 8;
      agent._endTraceRun = async (_tab, _run, status) => { terminal = status; };
      agent._enrichUserMessageWithCurrentPage = async (_tab, _messages, content) => { frames = bindFrames(agent, tab); return { role: 'user', content }; };
      agent._executeToolWithLifecycle = async (_tab, tool, args) => {
        if (tool === 'get_accessibility_tree') return { success: true, pageContent: TREE };
        dispatched.push(tool);
        return tool === 'done' ? { done: true, success: true, summary: args.summary, outcome: args.outcome }
          : { success: true, dispatched: true, verified: true };
      };
      try {
        const options = { detachedRequestId: 'finished-' + tab, askStreamingEnabled: false };
        const result = streaming ? await agent.processMessageStream(tab, 'Add the blue shoes', () => {}, 'act', options)
          : await agent.processMessage(tab, 'Add the blue shoes', () => {}, 'act', [], options);
        assert.equal(result, 'Added to cart');
        assert.equal(requests, 2, 'Automatic churn must not send a finished answer back to the model');
        assert.deepEqual(dispatched, ['click_ax', 'done']);
        assert.notEqual(terminal, 'page_unstable');
      } finally { pages.delete(tab); }
    });
  }

  for (const [kind, target] of [['click', 'button#other'], ['input', 'input#q'], ['activity', 'textarea#note']]) {
    test(`${build}: a genuine user ${kind === 'activity' ? 'keypress' : kind} during inference still supersedes and waits for idle`, async () => {
      const tab = nextTab++, dispatched = [], starts = [];
      let agent, frames, requests = 0, userAt = 0;
      pages.set(tab, {});
      agent = makeAgent(Agent, async messages => {
        starts.push(Date.now()); requests++;
        if (requests === 1) {
          frames.main({ kind, source: 'user', target }); userAt = Date.now();
          return call('add-1', 'click_ax', { ref_id: 'ref_add' });
        }
        if (requests === 2) {
          assert.doesNotMatch(JSON.stringify(messages), /PAGE KEEPS CHANGING/, 'User intervention starts a fresh budget');
          return call('add-2', 'click_ax', { ref_id: 'ref_add' });
        }
        return call('finished', 'done', { summary: 'Added to cart', outcome: 'success' });
      });
      agent._pageFeedbackIdleMs = 120; agent.maxSteps = 6;
      agent._enrichUserMessageWithCurrentPage = async (_tab, _messages, content) => { frames = bindFrames(agent, tab); return { role: 'user', content }; };
      agent._executeToolWithLifecycle = async (_tab, tool, args, _update, context) => {
        if (tool === 'get_accessibility_tree') return { success: true, pageContent: TREE };
        dispatched.push(tool);
        return tool === 'done' ? { done: true, success: true, summary: args.summary } : { success: true, dispatched: true };
      };
      try {
        assert.equal(await agent.processMessage(tab, 'Add the blue shoes', () => {}, 'act', [], { detachedRequestId: 'user-' + tab }), 'Added to cart');
        assert.equal(requests, 3, 'The stale decision is reconsidered after the user intervention');
        assert.deepEqual(dispatched, ['click_ax', 'done'], 'Only the fresh decision is dispatched');
        assert.ok(starts[1] - userAt >= 100, 'The next decision waited for the user idle gate');
      } finally { pages.delete(tab); }
    });
  }

  test(`${build}: unknown DOM fences new input unless it is the current call's own post-input effect`, async () => {
    const { beforePageAgentDispatch } = await import(`../src/${build}/src/agent/page-feedback.js`);
    const tab = nextTab++, agent = makeAgent(Agent, async () => assert.fail('No inference'));
    pages.set(tab, {});
    await agent._claimRunEntry(tab, 'interactive');
    try {
      const frames = bindFrames(agent, tab);
      const messages = [{ role: 'system', content: '' }, { role: 'user', content: 'Search for blue shoes' }];
      agent.conversations.set(tab, messages);
      await agent._capturePageFeedbackModelState(tab, messages);
      const fence = () => beforePageAgentDispatch(api, tab, { kind: 'input', fenceOnly: true });
      const vetoed = error => error?.code === 'page_feedback_pending';
      const typeahead = target => frames.main({ kind: 'dom', source: 'unknown', target });
      const calls = [];
      agent._executeToolWithLifecycle = async (_tab, tool, _args, _update, context) => {
        if (tool === 'get_accessibility_tree') return { success: true, pageContent: TREE };
        const phase = calls.shift();
        if (phase === 'own') {
          await fence(); // First key: only inference-time churn is pending.
          context._contentActionDispatchState.started = true;
          typeahead('ul#suggestions'); // The first key's own render.
          await fence(); // The next key of the same call continues.
          return { success: true, dispatched: true };
        }
        // A change during this call's preparation fences its first input.
        assert.equal(phase, 'preparation', `unexpected ${tool}`);
        typeahead('ul#late');
        await assert.rejects(fence(), vetoed, phase);
        return { success: false, dispatched: false, noDispatch: true };
      };
      const bound = { ref_id: 'ref_add', text: 'blue shoes' };
      // Unknown DOM observed while no action is in flight is page churn.
      typeahead('div#live-table');
      calls.push('own');
      assert.equal((await agent.executeTool(tab, 'type_ax', bound)).success, true,
        'The current call types through its own typeahead renders');
      // A later action in the same batch must not inherit those effects: it is
      // refused before any input (at its own dispatch gate).
      const next = await agent.executeTool(tab, 'click_ax', { ref_id: 'ref_add' });
      assert.equal(next.noDispatch, true); assert.equal(next.pageFeedbackPending, true);
      // After a fresh observation the queue is clear; a change during the next
      // call's preparation fences it again.
      await agent._applyPendingPageFeedback(tab, messages);
      await agent._capturePageFeedbackModelState(tab, messages);
      calls.push('preparation');
      assert.equal((await agent.executeTool(tab, 'type_ax', bound)).noDispatch, true);
      assert.deepEqual(calls, []);
    } finally { pages.delete(tab); agent._releaseRunEntry(tab); }
  });

  test(`${build}: coalesced feedback keeps the strongest attribution and storms cannot evict intervention evidence`, async () => {
    const agent = makeAgent(Agent, async () => assert.fail('No inference')), tab = nextTab++;
    await agent._claimRunEntry(tab, 'interactive');
    try {
      const run = agent._pageFeedbackRuns.get(tab);
      const source = key => run.events.get(key)?.source;
      agent._queuePageFeedback(tab, { kind: 'dom', source: 'unknown', frameId: 0, target: 'div#feed' });
      agent._queuePageFeedback(tab, { kind: 'dom', source: 'page', frameId: 0, target: 'div#feed' });
      assert.equal(source('0:dom:div#feed'), 'unknown', 'Unknown attribution is not downgraded to page churn');
      agent._queuePageFeedback(tab, { kind: 'scroll', source: 'user', frameId: 0, target: 'html' });
      agent._queuePageFeedback(tab, { kind: 'scroll', source: 'unknown', frameId: 0, target: 'html' });
      assert.equal(source('0:scroll:html'), 'user', 'A later momentum scroll cannot hide the user gesture');
      agent._queuePageFeedback(tab, { kind: 'navigation', source: 'user', frameId: 2, before: '', after: 'https://a.example/' });
      agent._queuePageFeedback(tab, { kind: 'navigation', source: 'unknown', frameId: 2, before: '', after: 'https://a.example/next' });
      assert.equal(source('2:navigation:'), 'user');
      agent._queuePageFeedback(tab, { kind: 'dom', source: 'page', frameId: 0, target: 'span#late' });
      agent._queuePageFeedback(tab, { kind: 'dom', source: 'unknown', frameId: 0, target: 'span#late' });
      assert.equal(source('0:dom:span#late'), 'unknown', 'Stronger later evidence still upgrades the key');
      run.events.clear();
      agent._queuePageFeedback(tab, { kind: 'click', source: 'user', frameId: 0, target: 'button#buy' });
      for (let index = 0; index < 60; index++) agent._queuePageFeedback(tab, { kind: 'dom', source: 'page', frameId: 1, target: `div#ad${index}` });
      assert.equal(run.events.size, 32);
      assert.equal(source('0:click:button#buy'), 'user', 'A DOM storm cannot evict the user intervention');
    } finally { agent._releaseRunEntry(tab); }
  });

  test(`${build}: a terminal receipt and its verifier reads do not reset the supersession budget`, async () => {
    const tab = nextTab++, agent = makeAgent(Agent, async () => assert.fail('No inference'));
    pages.set(tab, {});
    await agent._claimRunEntry(tab, 'interactive');
    try {
      const frames = bindFrames(agent, tab);
      const messages = [{ role: 'system', content: '' }, { role: 'user', content: 'Add the blue shoes' }];
      agent.conversations.set(tab, messages);
      await agent._capturePageFeedbackModelState(tab, messages);
      const run = agent._pageFeedbackRuns.get(tab);
      const args = { summary: 'Added to cart', outcome: 'success' };
      const doneCall = { id: 'done', function: { name: 'done', arguments: JSON.stringify(args) } };
      agent._executeToolWithLifecycle = async (_tab, tool) => {
        if (tool === 'get_accessibility_tree') return { success: true, pageContent: TREE };
        assert.equal(tool, 'done');
        // Completion verification reads through the same wrapper while an ad frame churns.
        assert.equal((await agent.executeTool(tab, 'get_accessibility_tree', { maxChars: 5500 })).success, true);
        frames.child({ kind: 'dom', source: 'page', target: 'div#ad' });
        return { done: true, success: true, summary: args.summary };
      };
      // Automatic ad-frame churn alone no longer supersedes the completion.
      assert.equal((await agent.executeTool(tab, 'done', args, () => {}, {})).done, true);
      agent._resetPageFeedbackProgress(tab);
      assert.equal(await agent._applyPendingPageFeedback(tab, messages, () => {}, { responseToolCalls: [doneCall] }), false,
        'An Act completion survives automatic churn');
      // An unattributed top-level viewport change is strict but not user input:
      // each superseded completion counts toward the bounded budget.
      agent._executeToolWithLifecycle = async (_tab, tool) => {
        if (tool === 'get_accessibility_tree') return { success: true, pageContent: TREE };
        assert.equal(tool, 'done');
        assert.equal((await agent.executeTool(tab, 'get_accessibility_tree', { maxChars: 5500 })).success, true);
        frames.main({ kind: 'resize', source: 'unknown', target: 'viewport', viewport: { width: 1000 + run.revision, height: 700 } });
        return { done: true, success: true, summary: args.summary };
      };
      for (let attempt = 1; attempt <= 5; attempt++) {
        assert.equal((await agent.executeTool(tab, 'done', args, () => {}, {})).done, true);
        agent._resetPageFeedbackProgress(tab); // the batch's successful-dispatch hook
        assert.equal(await agent._applyPendingPageFeedback(tab, messages, () => {}, { responseToolCalls: [doneCall] }), true);
        assert.equal(run.passiveSupersessionStreak, attempt, 'A superseded terminal candidate is not page progress');
      }
      assert.equal(run.recoveryResult?.code, 'page_unstable');
      const stop = agent._pageFeedbackRecoveryResult(tab, messages, () => {});
      assert.equal(stop?.status, 'page_unstable');
      // Genuine progress and user intervention still restart the budget.
      run.passiveSupersessionStreak = 3; delete run.recoveryResult;
      agent._executeToolWithLifecycle = async () => ({ success: true, pageContent: TREE });
      await agent.executeTool(tab, 'get_accessibility_tree', {});
      agent._resetPageFeedbackProgress(tab);
      assert.equal(run.passiveSupersessionStreak, 0, 'A successful read is progress');
      run.passiveSupersessionStreak = 3;
      frames.main({ kind: 'click', source: 'user', target: 'button#other' });
      assert.equal(agent._pageFeedbackRecoveryResult(tab, messages, () => {}), null);
      assert.equal(run.passiveSupersessionStreak, 0, 'User intervention starts fresh');
    } finally { pages.delete(tab); agent._releaseRunEntry(tab); }
  });
}
