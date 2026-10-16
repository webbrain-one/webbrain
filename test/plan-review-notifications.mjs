import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const read = (build, name) => fs.readFileSync(new URL(`../src/${build}/src/${name}`, import.meta.url), 'utf8');
const storageArea = { get: async () => ({}), set: async () => {}, remove: async () => {} };
globalThis.chrome = globalThis.browser = {
  storage: { local: storageArea, session: storageArea },
  runtime: { getURL: value => value, sendMessage: async () => ({}) },
};
const builds = await Promise.all(['chrome', 'firefox'].map(async build => ({
  build,
  source: read(build, 'background.js'),
  Journal: (await import(`../src/${build}/src/run-ui-journal.js`)).RunUiJournal,
  Agent: (await import(`../src/${build}/src/agent/agent.js`)).Agent,
})));

// Execute production functions with controlled extension APIs. Loading the
// entire worker would also start schedulers, providers, and network services.
function extract(source, name) {
  const match = new RegExp(`^([ \\t]*)(?:export )?(?:async )?function ${name}\\(`, 'm').exec(source);
  assert.ok(match, `Missing production function ${name}`);
  const start = match.index;
  const end = source.indexOf(`\n${match[1]}}`, start);
  assert.ok(end > start, `Missing production function boundary ${name}`);
  return source.slice(start, end + match[1].length + 2).replace(/^export /, '');
}

function between(source, from, to) {
  const start = source.indexOf(from), end = source.indexOf(to, start + from.length);
  assert.ok(start >= 0 && end > start, `Missing production section ${from}`);
  return source.slice(start, end);
}

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

async function flush() {
  // The delivery path awaits several mocked extension APIs in sequence.
  // A task boundary drains that whole Promise chain without guessing its depth.
  await new Promise(resolve => setImmediate(resolve));
}

function deliveryHarness(item, options = {}) {
  const messages = [], audio = [], attention = [], stopped = [];
  const pendingClarifications = new Map();
  const journal = new item.Journal();
  const api = {
    runtime: { sendMessage: async message => { messages.push(message); } },
    tabs: { sendMessage: async (_tabId, message) => { stopped.push(message); } },
    storage: { session: { remove: async () => {} } },
    action: { setBadgeText: async () => {} },
  };
  const context = vm.createContext({
    runUiJournal: journal,
    agent: {
      currentRunId: new Map([[77, 'runtime-1']]),
      hasDurableSubmittedTurn: async () => false,
      _pendingClarifications: pendingClarifications,
      _capturePendingClarificationForUi: (tabId, requestId, data) => {
        if (options.captureClarification === false) return false;
        const existing = pendingClarifications.get(tabId)?.get(data.clarifyId);
        pendingClarifications.set(tabId, new Map([[data.clarifyId, existing || { requestId }]]));
        return true;
      },
      _pendingCurrentClarificationForUi: tabId => {
        const [clarifyId, entry] = pendingClarifications.get(tabId)?.entries().next().value || [];
        return entry ? { requestId: entry.requestId, clarifyId } : null;
      },
    },
    chrome: api, browser: api,
    playWatchAlert: async (...args) => { audio.push(args.at(-1)); },
    flashTabAttention: async value => { attention.push(value); },
    flashedBadgeTabs: new Set(), completionNotificationFocusHandlers: new Map(),
    runUiSnapshotReads: new Map(), runUiPersistenceFailures: new Map(),
    runUiPersistenceQueues: new Map(), runUiSnapshotPersistence: { cancel() {} },
    RUN_UI_PREFIX: 'run-ui:',
    flushRunUiSnapshot: async () => {},
    console,
  });
  const dedupe = item.source.match(/^const planReviewAlertIds = new WeakMap\(\);$/m)?.[0];
  assert.ok(dedupe, 'Production should track notified plan IDs per snapshot');
  vm.runInContext([
    dedupe,
    'const planReviewAttentionByTab = new Map();',
    'const attentionBadgeOwners = new Map();',
    ...['beginRunUiSnapshot', 'finishRunUiSnapshot', 'clearRunUiSnapshot', 'recordRunUiEvent', 'sendAgentUpdate', 'clearAttentionBadge', 'clearPlanReviewAttention', 'notifyPlanReview', 'sendAgentRunComplete', 'sendScheduledAgentUpdate']
      .map(name => extract(item.source, name)),
  ].join('\n'), context);
  if (options.begin !== false) journal.begin(77, 'request-1', { mode: 'act' });
  return { context, journal, messages, audio, attention, stopped, pendingClarifications };
}

function visualHarness(item, options = {}) {
  const notifications = [], cleared = [], sent = [], badges = [], badgeColors = [], focused = [], timers = [];
  const clicked = [], closed = [], injected = [];
  const tab = { id: 77, windowId: 9, title: 'Owned task tab', active: false, ...options.tab };
  const api = {
    runtime: { getURL: value => `extension://test/${value}`, sendMessage: async () => ({}) },
    storage: { local: { get: options.getStored || (async () => options.stored || {}) } },
    tabs: {
      get: options.getTab || (async () => tab),
      sendMessage: async (tabId, message, deliveryOptions) => {
        sent.push({ tabId, message, options: deliveryOptions });
        if (options.sendContent) return options.sendContent(message, sent.length);
        return { started: options.started !== false };
      },
      update: async (tabId, change) => { focused.push({ tabId, ...change }); },
    },
    windows: {
      get: async () => ({ focused: options.focused === true }),
      update: async (windowId, change) => { focused.push({ windowId, ...change }); },
    },
    notifications: {
      onClicked: { addListener: fn => clicked.push(fn) },
      onClosed: { addListener: fn => closed.push(fn) },
      create: (details, callback) => {
        const id = `notification-${notifications.length + 1}`;
        notifications.push({ id, ...details });
        if (callback) callback(id);
        return Promise.resolve(id);
      },
      clear: (id, callback) => { cleared.push(id); callback?.(); return Promise.resolve(true); },
    },
  };
  api.action = api.browserAction = {
    setBadgeText: async value => { badges.push(value); },
    setBadgeBackgroundColor: async value => { badgeColors.push(value); },
  };
  const context = vm.createContext({
    chrome: api, browser: api, console,
    agent: { _injectCoreContentScripts: async tabId => {
      injected.push(tabId);
      if (options.inject) return options.inject(tabId);
      return true;
    } },
    flashedBadgeTabs: new Set(),
    setTimeout: (callback, delay) => { timers.push({ callback, delay }); return timers.length; },
  });
  vm.runInContext([
    'const planReviewAttentionByTab = new Map();',
    'const attentionBadgeOwners = new Map();',
    between(item.source, 'const COMPLETION_NOTIFICATION_VISIBLE_MS', 'async function showCompletionNotification('),
    extract(item.source, 'clearAttentionBadge'),
    extract(item.source, 'clearPlanReviewAttention'),
    extract(item.source, 'showCompletionNotification'),
    extract(item.source, 'flashTabAttention'),
  ].join('\n'), context);
  return { context, api, notifications, cleared, sent, badges, badgeColors, focused, timers, clicked, closed, injected };
}

function audioHarness(item, options = {}) {
  const messages = [], frequencies = [], timers = [];
  let ensureCalls = 0, contexts = 0;
  const api = {
    storage: { local: { get: options.getStored || (async () => options.stored || {}) } },
    runtime: { sendMessage: async message => { messages.push(message); return { ok: true }; } },
  };
  class AudioContext {
    constructor() { contexts++; this.currentTime = 10; this.state = options.suspended ? 'suspended' : 'running'; }
    async resume() { await options.resume?.(); this.state = 'running'; }
    createOscillator() {
      return {
        frequency: { setValueAtTime: frequency => frequencies.push(frequency) },
        connect: () => ({ connect() {} }), start() {}, stop() {},
      };
    }
    createGain() { return { gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} } }; }
  }
  const context = vm.createContext({
    chrome: api, browser: api, AudioContext, console,
    ensureOffscreen: async () => { ensureCalls++; await options.ensure?.(); },
    setTimeout: callback => { timers.push(callback); return timers.length; },
  });
  if (item.build === 'chrome') {
    vm.runInContext(extract(item.source, 'playWatchAlert'), context);
  } else {
    vm.runInContext(read(item.build, 'watch-alert.js').replace(/^export /gm, ''), context);
  }
  return {
    context, messages, frequencies, timers,
    get ensureCalls() { return ensureCalls; },
    get contexts() { return contexts; },
    play(payload) {
      return item.build === 'chrome' ? context.playWatchAlert(payload) : context.playWatchAlert(api, payload);
    },
  };
}

function offscreenAudioHarness(options = {}) {
  const frequencies = [], timers = [], ownershipQueries = [];
  let listener;
  class AudioContext {
    constructor() { this.currentTime = 10; this.state = options.suspended ? 'suspended' : 'running'; }
    async resume() { await options.resume?.(); this.state = 'running'; }
    createOscillator() {
      return {
        frequency: { setValueAtTime: frequency => frequencies.push(frequency) },
        connect: () => ({ connect() {} }), start() {}, stop() {},
      };
    }
    createGain() { return { gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} } }; }
  }
  const context = vm.createContext({
    AudioContext, console,
    setTimeout: callback => { timers.push(callback); return timers.length; },
    chrome: { runtime: {
      onMessage: { addListener: fn => { listener = fn; } },
      sendMessage: async query => {
        ownershipQueries.push(query);
        return { ok: true, current: options.isCurrent?.() !== false };
      },
    } },
  });
  vm.runInContext(read('chrome', 'offscreen/watch-audio.js'), context);
  assert.equal(typeof listener, 'function');
  return {
    frequencies, timers, ownershipQueries,
    play(payload) {
      return new Promise(resolve => {
        const handled = listener({ target: 'offscreen-watch-audio', action: 'play_watch_alert', ...payload }, {}, resolve);
        assert.equal(handled, true, 'The production host keeps the response channel open');
      });
    },
  };
}

for (const item of builds) {
  test(`${item.build}: only accepted live plans alert once per plan and request`, async () => {
    const h = deliveryHarness(item);
    h.context.sendAgentUpdate(77, 'stale-request', 'plan_review', { planId: 'stale-plan' });
    h.context.sendAgentUpdate(77, 'request-1', 'plan_auto_approved', { planId: 'auto-plan' });
    assert.equal(h.audio.length, 0);
    assert.equal(h.attention.length, 0);
    assert.equal(h.messages.length, 1, 'Only the current request can broadcast a UI event');

    h.context.sendAgentUpdate(77, 'request-1', 'plan_review', { planId: 'plan-1' });
    h.context.sendAgentUpdate(77, 'request-1', 'plan_review', { planId: 'plan-1' });
    await flush();
    assert.equal(h.audio.length, 1, 'Repeated delivery of the same plan must stay silent');
    assert.equal(h.attention.length, 1);
    assert.equal(h.audio[0].style, 'plan_review');
    if (item.build === 'chrome') {
      assert.deepEqual({ ...h.audio[0].planReview }, { tabId: 77, requestId: 'request-1', planId: 'plan-1' });
    }
    assert.equal(h.audio[0].isCurrent(), true);
    assert.equal(h.attention[0].tabId, 77);
    assert.equal(h.attention[0].success, false);
    assert.equal(h.attention[0].reason, 'plan_review');

    const priorCurrent = h.audio[0].isCurrent;
    h.context.sendAgentUpdate(77, 'request-1', 'plan_resolved', { planId: 'plan-1', decision: 'approved' });
    assert.equal(priorCurrent(), false, 'Resolution invalidates an alert still awaiting setup');
    h.context.sendAgentUpdate(77, 'request-1', 'plan_review', { planId: 'plan-2' });
    assert.equal(h.audio.length, 2, 'A revised plan needs a fresh alert');

    const revisedCurrent = h.audio[1].isCurrent;
    h.journal.begin(77, 'request-2', { mode: 'act' });
    assert.equal(revisedCurrent(), false, 'A new request must invalidate the previous alert');
    h.context.sendAgentUpdate(77, 'request-2', 'plan_review', { planId: 'plan-1' });
    assert.equal(h.audio.length, 3, 'Plan ID reuse in another request must not suppress its alert');
  });

  test(`${item.build}: scheduled runs use the same plan alert owner`, async () => {
    const h = deliveryHarness(item, { begin: false });
    const owner = { jobId: 'job-1', executionId: 'execution-1', mode: 'act', kind: 'resume' };
    h.context.sendScheduledAgentUpdate(77, 'scheduled_job', { event: 'running', job: { id: owner.jobId } }, owner);
    h.context.sendScheduledAgentUpdate(77, 'plan_review', { planId: 'scheduled-plan' }, owner);
    assert.equal(h.journal.get(77).status, 'awaiting_plan');
    assert.equal(h.audio.length, 1);
    assert.equal(h.attention.length, 1);
    h.context.sendScheduledAgentUpdate(77, 'plan_review', { planId: 'stale-execution-plan' }, { ...owner, executionId: 'old' });
    assert.equal(h.audio.length, 1, 'A different execution does not own the scheduled journal');
  });

  test(`${item.build}: only live owned clarification dialogs alert, once per ID and request`, async () => {
    const h = deliveryHarness(item);
    h.context.sendAgentUpdate(77, 'old-request', 'clarify', { clarifyId: 'old-dialog' });
    assert.equal(h.audio.length, 0);
    assert.equal(h.pendingClarifications.size, 0, 'Stale updates cannot become the live clarification');
    h.context.sendAgentUpdate(77, 'request-1', 'clarify', { clarifyId: 'clarify-1', question: 'Which account?' });
    h.context.sendAgentUpdate(77, 'request-1', 'clarify', { clarifyId: 'clarify-1', question: 'Which account?' });
    assert.equal(h.audio.length, 1);
    assert.equal(h.attention.length, 1);
    assert.equal(h.audio[0].style, 'clarify');
    assert.equal(h.audio[0].isCurrent(), true, 'The live dialog must be captured before alert ownership is checked');
    assert.equal(h.attention[0].reason, 'clarify');
    if (item.build === 'chrome') {
      assert.deepEqual({ ...h.audio[0].planReview }, {
        tabId: 77, requestId: 'request-1', clarifyId: 'clarify-1', reason: 'clarify',
      });
    }
    const oldCurrent = h.audio[0].isCurrent;
    h.context.sendAgentUpdate(77, 'request-1', 'clarify', { clarifyId: 'clarify-2', question: 'Which date?' });
    assert.equal(h.audio.length, 2, 'A new question in the same run needs a fresh alert');
    assert.equal(oldCurrent(), false);
    const revisedCurrent = h.audio[1].isCurrent;
    h.context.beginRunUiSnapshot(77, 'request-2', { mode: 'act' });
    assert.equal(revisedCurrent(), false);
    h.context.sendAgentUpdate(77, 'request-2', 'clarify', { clarifyId: 'clarify-1' });
    assert.equal(h.audio.length, 3, 'Dialog IDs reused by a new request must not suppress its alert');

    const unowned = deliveryHarness(item, { captureClarification: false });
    unowned.context.sendAgentUpdate(77, 'request-1', 'clarify', { clarifyId: 'not-live' });
    assert.equal(unowned.audio.length, 0, 'A replayed or already-settled dialog has no live alert authority');
    assert.equal(unowned.attention.length, 0);
  });

  for (const promptKind of ['permission', 'workflow']) {
    test(`${item.build}: actual ${promptKind} dialog alerts without optional trace or hydration authority`, async () => {
      const h = deliveryHarness(item);
      const provider = { name: 'owned', model: 'owned', config: { endpoint: 'https://owned.invalid' } };
      const agent = new item.Agent({ getActive: () => provider });
      agent._persist = () => {};
      if (promptKind === 'permission') {
        agent._runningTabs.add(77);
        agent.conversations.set(77, [
          { role: 'system', content: 'Owned test context.' },
          { role: 'user', content: 'Click the owned test page button.' },
        ]);
        agent._beginSteeringRun(77, () => {}, { detachedRequestId: 'request-1' });
      }
      h.context.agent = agent;
      const captures = [];
      const capture = agent._capturePendingClarificationForUi.bind(agent);
      agent._capturePendingClarificationForUi = (...args) => {
        const accepted = capture(...args);
        captures.push(accepted);
        return accepted;
      };
      let prompt;
      const emit = (type, data) => {
        prompt = data;
        h.context.sendAgentUpdate(77, 'request-1', type, data);
      };
      const candidate = { target: { role: 'button', name: 'Continue' } };
      const waiting = promptKind === 'permission'
        ? agent._promptPermission(77, 'click', 'owned.invalid', emit)
        : agent._promptWorkflowTargetHealing(77, { id: 'workflow-1', name: 'Owned workflow' },
          { id: 'step-1', tool: 'click_ax', target: {} }, 0, [candidate], emit);
      try {
        assert.ok(prompt?.clarifyId, 'The real prompt producer must emit a dialog');
        assert.equal(agent.currentRunId.has(77), false, 'Optional trace IDs are absent when diagnostics are disabled');
        assert.deepEqual(captures, [false], 'The stricter sidebar hydration capture cannot authorize this dialog');
        assert.equal(agent._pendingCurrentClarificationForUi(77), null);
        assert.ok(agent._pendingClarifications.get(77)?.get(prompt.clarifyId), 'The live prompt entry still owns its answer');
        assert.equal(h.audio.length, 1);
        assert.equal(h.audio[0].style, 'clarify');
        assert.equal(h.audio[0].isCurrent(), true);
        assert.equal(h.attention.length, 1);
        assert.equal(h.attention[0].reason, 'clarify');
        assert.equal(h.attention[0].isCurrent(), true, 'Tab title attention must use the same live prompt authority');
        assert.equal(agent.submitClarifyResponse(77, prompt.clarifyId, promptKind === 'permission' ? 'once' : 'candidate_0'), true);
        assert.deepEqual(await waiting, promptKind === 'permission' ? 'once' : candidate);
        assert.equal(h.audio[0].isCurrent(), false);
        assert.equal(h.attention[0].isCurrent(), false);
      } finally {
        agent._cancelClarifications(77, 'Owned fixture cleanup');
        agent._finishSteeringRun(77);
        await waiting;
      }
    });
  }

  test(`${item.build}: clarification audio loses ownership after settlement or a terminal snapshot`, () => {
    for (const invalidate of ['settled', 'replaced-entry', 'terminal']) {
      const h = deliveryHarness(item);
      h.context.sendAgentUpdate(77, 'request-1', 'clarify', { clarifyId: 'clarify-1' });
      const isCurrent = h.audio[0].isCurrent;
      assert.equal(isCurrent(), true);
      if (invalidate === 'settled') h.pendingClarifications.delete(77);
      if (invalidate === 'replaced-entry') h.pendingClarifications.set(77, new Map([['clarify-1', {}]]));
      if (invalidate === 'terminal') h.context.finishRunUiSnapshot(77, 'request-1', 'cancelled');
      assert.equal(isCurrent(), false, `${invalidate}: queued audio cannot outlive its dialog`);
    }
  });

  test(`${item.build}: automatic answers, task progress, termination and replacement clear clarification attention`, async () => {
    for (const transition of ['auto', 'progress', 'terminal', 'clear', 'new-request']) {
      const h = deliveryHarness(item);
      h.context.sendAgentUpdate(77, 'request-1', 'clarify', { clarifyId: 'clarify-1' });
      const attentionId = h.attention[0].attentionId;
      if (transition === 'auto') {
        h.pendingClarifications.delete(77);
        h.context.sendAgentUpdate(77, 'request-1', 'clarify_auto', { clarifyId: 'clarify-1' });
      } else if (transition === 'progress') {
        h.context.sendAgentUpdate(77, 'request-1', 'tool', { name: 'click' });
        assert.equal(h.stopped.length, 0, 'An unrelated update must not dismiss a still-pending dialog');
        h.pendingClarifications.delete(77);
        h.context.sendAgentUpdate(77, 'request-1', 'tool', { name: 'click' });
      } else if (transition === 'terminal') {
        const finished = h.context.finishRunUiSnapshot(77, 'request-1', 'completed');
        await h.context.sendAgentRunComplete(77, finished);
      } else if (transition === 'clear') {
        h.context.clearRunUiSnapshot(77);
      } else {
        h.context.beginRunUiSnapshot(77, 'request-2', { mode: 'act' });
      }
      await flush();
      assert.equal(h.stopped.length, 1, `${transition}: stop the presented dialog's tab warning`);
      assert.equal(h.stopped[0].action, 'attention_flash_stop');
      assert.equal(h.stopped[0].params.attentionId, attentionId);
      assert.equal(h.audio[0].isCurrent(), false);
    }
  });

  test(`${item.build}: only a matched clarification answer clears its live attention`, async () => {
    const h = deliveryHarness(item);
    h.context.agent.submitClarifyResponse = (tabId, clarifyId) => {
      if (!h.pendingClarifications.get(tabId)?.has(clarifyId)) return false;
      h.pendingClarifications.delete(tabId);
      return true;
    };
    h.context.getRunUiSnapshot = async tabId => h.journal.get(tabId);
    vm.runInContext(`async function respondToClarification(msg, sender = {}) {
      switch (msg.action) {
        ${between(item.source, "    case 'clarify_response': {", "    case 'plan_response': {")}
      }
    }`, h.context);
    h.context.sendAgentUpdate(77, 'request-1', 'clarify', { clarifyId: 'clarify-1' });
    const mismatched = await h.context.respondToClarification({ action: 'clarify_response', tabId: 77, clarifyId: 'old-dialog', answer: 'Yes' });
    assert.equal(mismatched.matched, false);
    assert.equal(h.stopped.length, 0);
    const matched = await h.context.respondToClarification({ action: 'clarify_response', tabId: 77, clarifyId: 'clarify-1', answer: 'Yes' });
    assert.equal(matched.matched, true);
    assert.equal(h.stopped.length, 1);
    assert.equal(h.stopped[0].params.attentionId, h.attention[0].attentionId);
    assert.equal(h.audio[0].isCurrent(), false);
  });

  test(`${item.build}: restoring sidebar clarification state does not replay notification audio`, () => {
    const h = deliveryHarness(item);
    h.context.sendAgentUpdate(77, 'request-1', 'clarify', { clarifyId: 'clarify-1' });
    const restored = deliveryHarness(item, { begin: false });
    restored.journal.restore(77, structuredClone(h.journal.get(77)));
    assert.equal(restored.audio.length, 0);
    assert.equal(restored.attention.length, 0);
    assert.doesNotMatch(extract(read(item.build, 'ui/sidepanel.js'), 'renderClarifyCard'), /playClarifySound\(/,
      'Both live delivery and cold sidebar rendering use background-owned audio');
  });

  test(`${item.build}: scheduled clarifications use the same live dialog notification owner`, () => {
    const h = deliveryHarness(item, { begin: false });
    const owner = { jobId: 'job-1', executionId: 'execution-1', mode: 'act', kind: 'resume' };
    h.context.sendScheduledAgentUpdate(77, 'scheduled_job', { event: 'running', job: { id: owner.jobId } }, owner);
    h.context.sendScheduledAgentUpdate(77, 'clarify', { clarifyId: 'scheduled-question' }, owner);
    assert.equal(h.audio.length, 1);
    assert.equal(h.audio[0].style, 'clarify');
    assert.equal(h.audio[0].isCurrent(), true);
    assert.equal(h.attention[0].reason, 'clarify');
    h.context.sendScheduledAgentUpdate(77, 'clarify', { clarifyId: 'unowned-question' }, { ...owner, executionId: 'old' });
    assert.equal(h.audio.length, 1);
  });

  test(`${item.build}: hidden plan reviews flash and show a warning notification`, async () => {
    const h = visualHarness(item);
    await h.context.flashTabAttention({ tabId: 77, success: false, reason: 'plan_review' });
    assert.equal(h.sent.length, 1);
    assert.equal(h.sent[0].message.params.reason, 'plan_review');
    assert.equal(h.notifications.length, 1, 'Plans need an alert even when the content script starts flashing');
    assert.match(h.notifications[0].title, /⚠️.*Plan.*review/);
    assert.equal(h.notifications[0].iconUrl, 'extension://test/icons/plan-review.png');
    assert.equal(h.notifications[0].silent, true, 'The distinct background chime owns sound');
    assert.equal(h.badges.length, 0, 'Successful content flashing does not need a toolbar fallback');

    const completion = visualHarness(item);
    await completion.context.flashTabAttention({ tabId: 77, success: true });
    assert.equal(completion.notifications.length, 0, 'Ordinary completion flashing keeps its existing behavior');
    assert.equal(completion.sent[0].message.params.reason, 'completion');
  });

  test(`${item.build}: clarification dialogs flash and display a warning notification`, async () => {
    const h = visualHarness(item);
    await h.context.flashTabAttention({ tabId: 77, success: false, reason: 'clarify' });
    assert.equal(h.sent.length, 1);
    assert.equal(h.sent[0].message.params.reason, 'clarify');
    assert.equal(h.notifications.length, 1);
    assert.match(h.notifications[0].title, /⚠️/);
    assert.match(h.notifications[0].title, /clarif|input|answer/i);
    assert.equal(h.notifications[0].iconUrl, 'extension://test/icons/plan-review.png');
    assert.equal(h.notifications[0].silent, true);
    assert.equal(h.badges.length, 0);
  });

  test(`${item.build}: restricted tabs receive an amber warning badge and actionable plan notification`, async () => {
    const h = visualHarness(item, { sendContent: async () => { throw new Error('No content receiver'); } });
    await h.context.flashTabAttention({ tabId: 77, success: false, reason: 'plan_review' });
    assert.equal(h.badges[0].text, '⚠');
    assert.equal(h.badgeColors[0].color, '#f59e0b');
    assert.equal(h.notifications.length, 1);
    h.clicked[0](h.notifications[0].id);
    await flush();
    assert.deepEqual(h.focused.map(value => ({ ...value })), [
      { windowId: 9, focused: true }, { tabId: 77, active: true },
    ]);
    h.clicked[0](h.notifications[0].id);
    await flush();
    assert.equal(h.focused.length, 2, 'The click action is consumed once');
    assert.equal(h.timers[0].delay, 12000);
    h.timers[0].callback();
    assert.deepEqual(h.cleared, [h.notifications[0].id]);
  });

  test(`${item.build}: missing content receivers are injected and retried in the top frame`, async () => {
    for (const missing of ['no-receiver', 'undefined']) {
      const h = visualHarness(item, { sendContent: async (_message, call) => {
        if (call === 1) {
          if (missing === 'no-receiver') throw new Error('Could not establish connection. Receiving end does not exist.');
          return undefined;
        }
        return { started: true };
      } });
      const result = await h.context.flashTabAttention({ tabId: 77, reason: 'plan_review' });
      assert.deepEqual(h.injected, [77], `${missing}: repair content injection before falling back`);
      assert.equal(h.sent.length, 2);
      assert.deepEqual({ ...h.sent[0].options }, { frameId: 0 });
      assert.deepEqual({ ...h.sent[1].options }, { frameId: 0 });
      assert.equal(result.mode, 'title-flash+notification');
      assert.equal(h.notifications.length, 1);
      assert.equal(h.badges.length, 0, 'Recovered title attention needs no toolbar fallback');
    }
  });

  test(`${item.build}: declined or failed content responses do not trigger reinjection`, async () => {
    for (const response of [{ started: false }, { error: 'Page cannot display attention' }]) {
      const h = visualHarness(item, { sendContent: async () => response });
      await h.context.flashTabAttention({ tabId: 77, reason: 'plan_review' });
      assert.equal(h.injected.length, 0);
      assert.equal(h.sent.length, 1);
      assert.equal(h.badges.at(-1).text, '⚠');
    }
    const h = visualHarness(item, { sendContent: async () => { throw new Error('Unexpected extension API failure'); } });
    await h.context.flashTabAttention({ tabId: 77, reason: 'plan_review' });
    assert.equal(h.injected.length, 0, 'Only a missing receiver is repairable by injection');
  });

  test(`${item.build}: attention that becomes stale during injection is not resent`, async () => {
    const wait = deferred();
    let current = true;
    const h = visualHarness(item, {
      sendContent: async () => undefined,
      inject: () => wait.promise,
    });
    const pending = h.context.flashTabAttention({ tabId: 77, reason: 'clarify', isCurrent: () => current });
    await flush();
    assert.deepEqual(h.injected, [77]);
    current = false;
    wait.resolve();
    await pending;
    assert.equal(h.sent.length, 1, 'Do not start a warning for an already answered dialog');
    assert.equal(h.badges.length, 0);
    assert.equal(h.notifications.length, 0);
  });

  test(`${item.build}: restricted pages keep warning fallback when content injection fails`, async () => {
    const h = visualHarness(item, {
      sendContent: async () => { throw new Error('Could not establish connection. Receiving end does not exist.'); },
      inject: async () => { throw new Error('Cannot access a chrome:// URL'); },
    });
    const result = await h.context.flashTabAttention({ tabId: 77, reason: 'clarify' });
    assert.deepEqual(h.injected, [77]);
    assert.equal(h.sent.length, 1);
    assert.equal(result.mode, 'badge+notification');
    assert.equal(h.badges.at(-1).text, '⚠');
    assert.equal(h.notifications.length, 1);
    assert.match(h.notifications[0].title, /⚠️/);
    assert.match(h.notifications[0].title, /clarif|input|answer/i);
  });

  test(`${item.build}: watched tabs and the visual opt-out suppress plan alerts`, async () => {
    const watched = visualHarness(item, { started: false, tab: { active: true }, focused: true });
    await watched.context.flashTabAttention({ tabId: 77, reason: 'plan_review' });
    assert.equal(watched.notifications.length, 0);
    assert.equal(watched.badges.length, 0);
    const muted = visualHarness(item, { stored: { completionFlashTab: false } });
    await muted.context.flashTabAttention({ tabId: 77, reason: 'plan_review' });
    assert.equal(muted.sent.length, 0);
    assert.equal(muted.notifications.length, 0);

    const unfocused = visualHarness(item, { started: false, tab: { active: true }, focused: false });
    await unfocused.context.flashTabAttention({ tabId: 77, reason: 'plan_review' });
    assert.equal(unfocused.notifications.length, 1, 'Selected tabs in another window still need attention');
  });

  test(`${item.build}: resolved plans cannot notify after awaited visual setup`, async () => {
    for (const stage of ['settings', 'content', 'notification-tab']) {
      const wait = deferred();
      let current = true, gets = 0;
      const options = stage === 'settings' ? { getStored: () => wait.promise }
        : stage === 'content' ? { sendContent: () => wait.promise }
          : { getTab: async () => { if (++gets === 2) await wait.promise; return { id: 77, active: false }; } };
      const h = visualHarness(item, options);
      const pending = h.context.flashTabAttention({ tabId: 77, reason: 'plan_review', isCurrent: () => current });
      await flush();
      current = false;
      wait.resolve(stage === 'content' ? { started: true } : {});
      await pending;
      assert.equal(h.notifications.length, 0, `${stage}: resolved or replaced plans must stay silent`);
      assert.equal(h.badges.length, 0, `${stage}: stale plans must not leave a badge`);
    }
  });

  test(`${item.build}: a plan resolved during content startup stops only its own flash`, async () => {
    const wait = deferred();
    let current = true;
    const h = visualHarness(item, {
      sendContent: message => message.action === 'attention_flash_start' ? wait.promise : { stopped: true },
    });
    const pending = h.context.flashTabAttention({
      tabId: 77, reason: 'plan_review', attentionId: 'request-1:plan-1', isCurrent: () => current,
    });
    await flush();
    current = false;
    wait.resolve({ started: true });
    await pending;
    assert.deepEqual(h.sent.map(row => row.message.action), ['attention_flash_start', 'attention_flash_stop']);
    assert.deepEqual(h.sent.map(row => row.message.params.attentionId), ['request-1:plan-1', 'request-1:plan-1']);
    assert.equal(h.notifications.length, 0);
    assert.equal(h.badges.length, 0);
  });

  test(`${item.build}: resolving a presented plan clears its flash, badge, and notification`, async () => {
    const h = visualHarness(item, { started: false });
    const journal = new item.Journal();
    h.context.runUiJournal = journal;
    h.context.agent = { currentRunId: new Map([[77, 'runtime-1']]) };
    h.context.playWatchAlert = async () => ({ ok: true });
    vm.runInContext([
      'const planReviewAlertIds = new WeakMap();',
      ...['recordRunUiEvent', 'sendAgentUpdate', 'notifyPlanReview'].map(name => extract(item.source, name)),
    ].join('\n'), h.context);
    journal.begin(77, 'request-1', { mode: 'act' });
    h.context.sendAgentUpdate(77, 'request-1', 'plan_review', { planId: 'plan-1' });
    await flush();
    assert.equal(h.notifications.length, 1);
    assert.equal(h.badges.at(-1).text, '⚠');
    const attentionId = h.sent[0].message.params.attentionId;
    h.context.clearPlanReviewAttention(77, 'old-request', 'plan-1');
    assert.equal(h.cleared.length, 0, 'Cleanup from another request cannot clear the presented plan');
    h.context.sendAgentUpdate(77, 'request-1', 'plan_resolved', { planId: 'plan-1', decision: 'approved' });
    await flush();
    assert.equal(h.sent.at(-1).message.action, 'attention_flash_stop');
    assert.equal(h.sent.at(-1).message.params.attentionId, attentionId);
    assert.equal(h.badges.at(-1).text, '');
    assert.deepEqual(h.cleared, [h.notifications[0].id]);
    h.clicked[0](h.notifications[0].id);
    await flush();
    assert.equal(h.focused.length, 0, 'A cleared plan notification no longer owns a focus handler');
  });

  test(`${item.build}: plan resolution during either badge setter clears the pending warning`, async () => {
    for (const stage of ['text', 'color']) {
      const wait = deferred();
      const h = visualHarness(item, { started: false });
      const method = stage === 'text' ? 'setBadgeText' : 'setBadgeBackgroundColor';
      const original = h.api.action[method];
      h.api.action[method] = async value => {
        await original(value);
        if (stage === 'color' || value.text === '⚠') await wait.promise;
      };
      const attention = { id: 'request-1:plan-1', requestId: 'request-1', planId: 'plan-1' };
      h.context.pendingAttention = attention;
      vm.runInContext('planReviewAttentionByTab.set(77, pendingAttention);', h.context);
      let current = true;
      const pending = h.context.flashTabAttention({
        tabId: 77, reason: 'plan_review', attentionId: attention.id, isCurrent: () => current,
      });
      await flush();
      assert.equal(attention.badge, true, `${stage}: cleanup must own the badge before waiting on its setter`);
      current = false;
      h.context.clearPlanReviewAttention(77, 'request-1', 'plan-1');
      await flush();
      wait.resolve();
      await pending;
      assert.equal(h.badges.at(-1).text, '', `${stage}: a resolved plan must not leave an amber warning`);
      assert.equal(h.notifications.length, 0, `${stage}: a resolved plan must not create a notification`);
      if (stage === 'text') assert.equal(h.badgeColors.length, 0, 'The stale path stops before changing badge color');
    }
  });

  test(`${item.build}: late plan badge cleanup preserves a newer completion badge`, async () => {
    const wait = deferred();
    const h = visualHarness(item, { started: false });
    const original = h.api.action.setBadgeText;
    h.api.action.setBadgeText = async value => {
      await original(value);
      if (value.text === '⚠') await wait.promise;
    };
    const attention = { id: 'request-1:plan-1', requestId: 'request-1', planId: 'plan-1' };
    h.context.pendingAttention = attention;
    vm.runInContext('planReviewAttentionByTab.set(77, pendingAttention);', h.context);
    let current = true;
    const pendingPlan = h.context.flashTabAttention({
      tabId: 77, reason: 'plan_review', attentionId: attention.id, isCurrent: () => current,
    });
    await flush();
    current = false;
    h.context.clearPlanReviewAttention(77, 'request-1', 'plan-1');
    await flush();
    await h.context.flashTabAttention({ tabId: 77, success: true });
    assert.equal(h.badges.at(-1).text, '✓');
    const writesBeforeOldPlanSettles = h.badges.length;
    wait.resolve();
    await pendingPlan;
    assert.equal(h.badges.length, writesBeforeOldPlanSettles, 'An older plan cannot clear the newer badge owner');
    assert.equal(h.badges.at(-1).text, '✓');
    assert.equal(h.badgeColors.at(-1).color, '#22c55e');
    assert.equal(h.notifications.length, 1);
    assert.match(h.notifications[0].title, /Task finished/);
  });

  test(`${item.build}: sound opt-out and stale setup suppress background playback`, async () => {
    for (const style of ['plan_review', 'clarify']) {
      const muted = audioHarness(item, { stored: { notifySound: false } });
      const result = await muted.play({ style });
      assert.equal(result.muted, true);
      assert.equal(muted.messages.length, 0);
      assert.equal(muted.contexts, 0);
      for (const stage of ['settings', ...(item.build === 'chrome' ? ['offscreen'] : ['resume'])]) {
        const wait = deferred();
        let current = true;
        const options = stage === 'settings' ? { getStored: () => wait.promise }
          : stage === 'offscreen' ? { ensure: () => wait.promise }
            : { suspended: true, resume: () => wait.promise };
        const h = audioHarness(item, options);
        const pending = h.play({ style, isCurrent: () => current });
        await flush();
        current = false;
        wait.resolve({});
        await pending;
        assert.equal(h.messages.length, 0, `${stage}: no offscreen sound message after ${style} resolves`);
        assert.equal(h.frequencies.length, 0, `${stage}: no oscillator after ${style} resolves`);
      }
    }
  });
}

test('Chrome and Firefox play the same distinct descending plan review chime', async () => {
  const chrome = read('chrome', 'offscreen/watch-audio.js');
  const chromeContext = vm.createContext({});
  vm.runInContext(extract(chrome, 'patternFor'), chromeContext);
  const firefox = builds.find(item => item.build === 'firefox');
  const firefoxContext = vm.createContext({});
  vm.runInContext(extract(read('firefox', 'watch-alert.js'), 'watchAlertPattern'), firefoxContext);
  const chromePattern = JSON.parse(JSON.stringify(chromeContext.patternFor('plan_review')));
  const firefoxPattern = JSON.parse(JSON.stringify(firefoxContext.watchAlertPattern('plan_review')));
  assert.deepEqual(chromePattern, firefoxPattern);
  assert.deepEqual(chromePattern.map(tone => tone.frequency), [880, 660]);
  assert.ok(chromePattern[1].at > chromePattern[0].duration, 'The warning has two separate tones');
  assert.notDeepEqual(chromePattern, JSON.parse(JSON.stringify(chromeContext.patternFor('default'))));
  assert.deepEqual(JSON.parse(JSON.stringify(chromeContext.patternFor('clarify'))), chromePattern);
  assert.deepEqual(JSON.parse(JSON.stringify(firefoxContext.watchAlertPattern('clarify'))), chromePattern,
    'Clarification uses the same distinct user-attention chime in both browsers');
  const h = audioHarness(firefox);
  const pending = h.play({ style: 'plan_review' });
  await flush();
  assert.deepEqual(h.frequencies, [880, 660], 'The selected plan pattern reaches real playback scheduling');
  for (const timer of h.timers) timer();
  await pending;
});

test('Chrome forwards the plan chime to its offscreen host after setup', async () => {
  const h = audioHarness(builds.find(item => item.build === 'chrome'));
  const planReview = { tabId: 77, requestId: 'request-1', planId: 'plan-1' };
  await h.play({ style: 'plan_review', planReview });
  assert.equal(h.ensureCalls, 1);
  assert.equal(h.messages.length, 1);
  assert.equal(h.messages[0].target, 'offscreen-watch-audio');
  assert.equal(h.messages[0].action, 'play_watch_alert');
  assert.equal(h.messages[0].style, 'plan_review');
  assert.deepEqual({ ...h.messages[0].planReview }, planReview);
});

test('Chrome forwards the clarification chime with dialog ownership to its offscreen host', async () => {
  const h = audioHarness(builds.find(item => item.build === 'chrome'));
  const planReview = { tabId: 77, requestId: 'request-1', reason: 'clarify', clarifyId: 'clarify-1' };
  await h.play({ style: 'clarify', planReview });
  assert.equal(h.ensureCalls, 1);
  assert.equal(h.messages.length, 1);
  assert.equal(h.messages[0].style, 'clarify');
  assert.deepEqual({ ...h.messages[0].planReview }, planReview);
});

test('Chrome offscreen host rechecks clarification ownership after waiting behind another alert', async () => {
  let current = true;
  const h = offscreenAudioHarness({ isCurrent: () => current });
  const prior = h.play({ style: 'short' });
  await flush();
  const planReview = { tabId: 77, requestId: 'request-1', reason: 'clarify', clarifyId: 'clarify-1' };
  const pending = h.play({ style: 'clarify', planReview });
  await flush();
  current = false;
  h.timers[0]();
  await prior;
  await pending;
  assert.deepEqual(h.frequencies, [740], 'An answered dialog must not sound after waiting in the queue');
  const query = h.ownershipQueries.at(-1);
  assert.equal(query.target, 'background-plan-audio');
  assert.deepEqual({ tabId: query.tabId, requestId: query.requestId, reason: query.reason, clarifyId: query.clarifyId }, planReview);
});

test('Firefox rechecks a plan that resolves while another alert occupies the audio queue', async () => {
  const h = audioHarness(builds.find(item => item.build === 'firefox'));
  const prior = h.play({ style: 'short' });
  await flush();
  assert.deepEqual(h.frequencies, [740]);
  let current = true;
  const pending = h.play({ style: 'plan_review', isCurrent: () => current });
  await flush();
  current = false;
  h.timers[0]();
  await prior;
  await pending;
  assert.deepEqual(h.frequencies, [740], 'A queued plan must not sound after its review is resolved');
});

test('Chrome offscreen host rechecks a plan after waiting behind another alert', async () => {
  let current = true;
  const h = offscreenAudioHarness({ isCurrent: () => current });
  const prior = h.play({ style: 'short' });
  await flush();
  assert.deepEqual(h.frequencies, [740]);
  assert.equal(h.ownershipQueries.length, 0, 'Ordinary watch alerts need no plan ownership lookup');
  const planReview = { tabId: 77, requestId: 'request-1', planId: 'plan-1' };
  const pending = h.play({ style: 'plan_review', planReview });
  await flush();
  current = false;
  h.timers[0]();
  await prior;
  await pending;
  assert.deepEqual(h.frequencies, [740], 'The resolved queued plan must not create oscillators');
  assert.ok(h.ownershipQueries.length > 0);
  const query = h.ownershipQueries.at(-1);
  assert.equal(query.target, 'background-plan-audio');
  assert.equal(query.action, 'is_current');
  assert.deepEqual({ tabId: query.tabId, requestId: query.requestId, planId: query.planId }, planReview);
});

test('Chrome offscreen host rechecks plan ownership after resuming audio', async () => {
  const wait = deferred();
  let current = true;
  const h = offscreenAudioHarness({ suspended: true, resume: () => wait.promise, isCurrent: () => current });
  const pending = h.play({ style: 'plan_review', planReview: { tabId: 77, requestId: 'request-1', planId: 'plan-1' } });
  await flush();
  current = false;
  wait.resolve();
  await pending;
  assert.deepEqual(h.frequencies, [], 'A plan resolved during resume must not sound');
  assert.ok(h.ownershipQueries.length > 0);
});

test('Chrome audio authority accepts only its offscreen host and the currently pending plan', () => {
  const item = builds.find(value => value.build === 'chrome');
  const journal = new item.Journal();
  let listener;
  const api = { runtime: {
    id: 'owned-extension',
    getURL: value => `chrome-extension://owned-extension/${value}`,
    onMessage: { addListener: fn => { listener = fn; } },
  } };
  const context = vm.createContext({ chrome: api, runUiJournal: journal });
  vm.runInContext(between(item.source, 'function isCurrentPlanReviewAudio(',
    'chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {'), context);
  const sender = { id: api.runtime.id, url: api.runtime.getURL('src/offscreen/offscreen.html') };
  const message = { target: 'background-plan-audio', action: 'is_current', tabId: 77, requestId: 'request-1', planId: 'plan-1' };
  journal.begin(77, 'request-1', { mode: 'act' });
  journal.record(77, 'request-1', 'plan_review', { planId: 'plan-1' });
  assert.equal(context.isCurrentPlanReviewAudio(message, sender), true);
  let response;
  listener(message, sender, value => { response = value; });
  assert.equal(response.current, true, 'The dedicated message listener reports the production authority verdict');
  assert.equal(context.isCurrentPlanReviewAudio(message, { ...sender, id: 'another-extension' }), false);
  assert.equal(context.isCurrentPlanReviewAudio(message, {
    ...sender, url: api.runtime.getURL('src/ui/sidepanel.html'),
  }), false, 'Another extension page cannot impersonate the offscreen audio host');
  assert.equal(context.isCurrentPlanReviewAudio(message, { ...sender, url: 'https://example.com/' }), false);
  for (const mismatch of [{ tabId: 78 }, { requestId: 'old-request' }, { planId: 'old-plan' }, { planId: '' }]) {
    assert.equal(context.isCurrentPlanReviewAudio({ ...message, ...mismatch }, sender), false);
  }
  journal.record(77, 'request-1', 'plan_resolved', { planId: 'plan-1', decision: 'approved' });
  assert.equal(context.isCurrentPlanReviewAudio(message, sender), false, 'Resolved plans cannot authorize queued audio');
  journal.begin(77, 'request-2', { mode: 'act' });
  journal.record(77, 'request-2', 'plan_review', { planId: 'plan-1' });
  assert.equal(context.isCurrentPlanReviewAudio(message, sender), false, 'A new request cannot authorize old queued audio');
  assert.equal(context.isCurrentPlanReviewAudio({ ...message, requestId: 'request-2' }, sender), true);
  journal.finish(77, 'request-2', 'cancelled', '');
  assert.equal(context.isCurrentPlanReviewAudio({ ...message, requestId: 'request-2' }, sender), false);
  response = undefined;
  listener({ ...message, target: 'background' }, sender, value => { response = value; });
  assert.equal(response, undefined, 'The authority listener ignores unrelated background messages');
});

test('Chrome audio authority requires the live request and dialog for clarification playback', () => {
  const item = builds.find(value => value.build === 'chrome');
  const journal = new item.Journal();
  const pendingEntry = {};
  const pending = new Map([[77, new Map([['clarify-1', pendingEntry]])]]);
  const attention = new Map([[77, { requestId: 'request-1', clarifyId: 'clarify-1', reason: 'clarify' }]]);
  const api = { runtime: {
    id: 'owned-extension',
    getURL: value => `chrome-extension://owned-extension/${value}`,
  } };
  const context = vm.createContext({
    chrome: api, runUiJournal: journal, planReviewAttentionByTab: attention,
    agent: { _pendingClarifications: pending },
  });
  vm.runInContext(extract(item.source, 'isCurrentPlanReviewAudio'), context);
  const sender = { id: api.runtime.id, url: api.runtime.getURL('src/offscreen/offscreen.html') };
  const message = { tabId: 77, requestId: 'request-1', reason: 'clarify', clarifyId: 'clarify-1' };
  journal.begin(77, 'request-1', { mode: 'act' });
  assert.equal(context.isCurrentPlanReviewAudio(message, sender), true);
  assert.equal(context.isCurrentPlanReviewAudio(message, { ...sender, id: 'another-extension' }), false);
  assert.equal(context.isCurrentPlanReviewAudio(message, {
    ...sender, url: api.runtime.getURL('src/ui/sidepanel.html'),
  }), false);
  for (const mismatch of [{ tabId: 78 }, { requestId: 'old-request' }, { clarifyId: 'old-dialog' }, { clarifyId: '' }]) {
    assert.equal(context.isCurrentPlanReviewAudio({ ...message, ...mismatch }, sender), false);
  }
  attention.set(77, { requestId: 'other-request', clarifyId: 'clarify-1' });
  assert.equal(context.isCurrentPlanReviewAudio(message, sender), false);
  attention.set(77, { requestId: 'request-1', clarifyId: 'old-dialog' });
  assert.equal(context.isCurrentPlanReviewAudio(message, sender), false);
  attention.set(77, { requestId: 'request-1', clarifyId: 'clarify-1' });
  pendingEntry.settled = true;
  assert.equal(context.isCurrentPlanReviewAudio(message, sender), false);
  pendingEntry.settled = false;
  pending.delete(77);
  assert.equal(context.isCurrentPlanReviewAudio(message, sender), false, 'An answered dialog cannot authorize queued audio');
  pending.set(77, new Map([['clarify-1', pendingEntry]]));
  journal.finish(77, 'request-1', 'completed', 'Done');
  assert.equal(context.isCurrentPlanReviewAudio(message, sender), false, 'Terminal snapshots cannot authorize dialog audio');
});
