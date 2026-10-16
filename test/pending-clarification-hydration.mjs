import assert from 'node:assert/strict';
import test, { after, before } from 'node:test';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import { chromium } from 'playwright';

const area = { get: async () => ({}), set: async () => {}, remove: async () => {} };
globalThis.chrome = globalThis.browser = { storage: { local: area, session: area }, runtime: { getURL: x => x, sendMessage: async () => ({}) } };
const builds = await Promise.all(['chrome', 'firefox'].map(async build => ({
  build, Agent: (await import(`../src/${build}/src/agent/agent.js`)).Agent,
  journalModule: await import(`../src/${build}/src/run-ui-journal.js`),
  source: await fs.readFile(new URL(`../src/${build}/src/ui/sidepanel.js`, import.meta.url), 'utf8'),
  background: await fs.readFile(new URL(`../src/${build}/src/background.js`, import.meta.url), 'utf8'),
  recoveryUi: await fs.readFile(new URL(`../src/${build}/src/ui/failure-recovery.js`, import.meta.url), 'utf8'),
})));
function extract(source, name) {
  source = source.replace(/\r\n/g, '\n');
  const start = source.search(new RegExp(`^(?:async )?function ${name}\\(`, 'm'));
  assert.ok(start >= 0, name);
  const end = source.indexOf('\n}', start);
  assert.ok(end > start, name);
  return source.slice(start, end + 2);
}
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
let browser;
before(async () => { browser = await chromium.launch({ headless: true }); });
after(async () => { await browser?.close(); });

function fixture(build) {
  const provider = { name: 'owned', model: 'owned', config: { endpoint: 'http://owned.invalid', account: 'owned-account' } };
  const agent = new build.Agent({ getActive: () => provider });
  const tab = 73, request = 'owned-current-request', runId = 'owned-current-runtime';
  agent._persist = () => {}; agent._runningTabs.add(tab); agent.currentRunId.set(tab, runId);
  agent.conversations.set(tab, [{ role: 'system', content: 'Owned fixture context.' }, { role: 'user', content: 'Inspect the owned test page.' }]);
  agent._beginSteeringRun(tab, () => {}, { detachedRequestId: request });
  agent.getConversationState = async () => ({ conversationId: 'owned-conversation' });
  agent.hasDurableSubmittedTurn = async () => true;
  const journal = new build.journalModule.RunUiJournal(); journal.begin(tab, request);
  const messages = [], waits = [];
  const context = vm.createContext({ agent, runUiJournal: journal,
    recordRunUiEvent: (tabId, requestId, type, data) => journal.record(tabId, requestId, type, data, agent.currentRunId.get(tabId)),
    // Background alert delivery has its own suite; this harness exercises
    // genuine clarification authority and sidepanel hydration without audio.
    notifyPlanReview() {}, clearPlanReviewAttention() {}, planReviewAttentionByTab: new Map(),
    chrome: { runtime: { sendMessage: async msg => { messages.push(structuredClone(msg)); } } },
    detachedRunStarts: new Map(), detachedRunFailures: new Map(), runUiPersistenceFailures: new Map(),
    getRunUiSnapshot: async tabId => journal.get(tabId), runUiSnapshotForRequest: build.journalModule.runUiSnapshotForRequest,
    console, Date, structuredClone,
  });
  const normalized = build.background.replace(/\r\n/g, '\n');
  context.browser = context.chrome;
  const start = normalized.indexOf("    case 'agent_run_state': {");
  const end = normalized.indexOf("    case 'agent_run_ack': {", start);
  assert.ok(start >= 0 && end > start);
  vm.runInContext(extract(build.background, 'sendAgentUpdate') + `\nasync function publicState(msg, sender = {}) { switch(msg.action) { ${normalized.slice(start, end)} } }`, context);
  const f = { ...build, provider, agent, tab, request, runId, journal, messages, context, waits,
    state: () => context.publicState({ action: 'agent_run_state', tabId: tab, requestId: request }),
    emit: (type, data) => context.sendAgentUpdate(tab, request, type, data),
    permission() { let prompt; const promise = agent._promptPermission(tab, 'click', 'owned.invalid', (type, data) => { prompt = data; f.emit(type, data); }); waits.push(promise); return { promise, prompt }; },
    async ordinary() { let prompt; agent.clarifyTimeoutSec = 30; const ready = deferred();
      const promise = agent._executeToolImpl(tab, 'clarify', { question: 'Choose an owned test option.', options: ['first', 'second'] },
        (type, data) => { prompt = data; f.emit(type, data); ready.resolve(); });
      waits.push(promise);
      promise.then(() => { if (!prompt) ready.resolve(); });
      await ready.promise; assert.ok(prompt, 'Actual ordinary clarify producer emitted its prompt');
      return { promise, prompt, entry: agent._pendingClarifications.get(tab).get(prompt.clarifyId) }; },
    async close() { agent._cancelClarifications(tab, 'Owned fixture cleanup'); await Promise.all(waits); },
  };
  return f;
}

async function panel(f, options = {}) {
  const page = await browser.newPage();
  const calls = [];
  await page.exposeFunction('ownedRpc', async (action, data) => {
    calls.push({ action, ...data });
    if (action === 'agent_run_ack') { if (options.beforeAck) await options.beforeAck(); return { matched: f.journal.acknowledge(f.tab, data.requestId, data.seq) }; }
    if (action === 'agent_run_state') {
      if (options.beforeState) await options.beforeState();
      const state = await f.state();
      if (options.afterState) return options.afterState(structuredClone(state));
      return state;
    }
    if (action === 'clarify_response') {
      if (options.beforeAnswer) await options.beforeAnswer();
      return { matched: f.agent.submitClarifyResponse(f.tab, data.clarifyId, data.answer, data.source) };
    }
    throw new Error(`Unexpected hydration RPC: ${action}`);
  });
  const names = ['applyActiveRunState', 'handleAgentUpdateMessage', 'ensureCurrentRunAssistant', 'isTerminalRunUiStatus', 'isFinishedRunUiStatus',
    'renderClarifyCard', 'addRunProgressReplayGapNote', 'clarificationSubmissionKey', 'invalidateUnresolvedClarifyCards',
    'restorePendingCurrentClarification', 'submitClarify', 'restoreActiveRunState', 'placeAnsweredClarifyCardInTimeline', 'workflowHealingTargetLabel',
    'syncFailureRecoveryButtons', 'bindFailureRecoveryCard', 'renderFailureRecoveryCard', 'reconcileFailureRecoveryCards'];
  const functions = names.map(name => extract(f.source, name)).join('\n');
  const helpers = `${f.journalModule.runUiDiscardedBeforeSeq.toString()}\n${f.journalModule.runUiUnavailableBeforeSeq.toString()}\n${f.recoveryUi.replaceAll('export function ', 'function ')}`;
  await page.evaluate(({ functions, helpers, tab, options }) => {
    document.body.innerHTML = '<div id="messages"><div class="message assistant"><div class="message-content"><div class="message-text"></div></div></div></div>';
    const noop = () => {};
    Object.assign(window, { messagesEl: document.querySelector('#messages'), currentTabId: tab, renderedTabId: tab,
      currentAssistantEl: document.querySelector('.assistant'), localRunRequestIds: new Map(options.staleLocalOwner ? [[tab, 'newer-local-request']] : []),
      processingTabs: new Set(), agentMode: 'act', isProcessing: false,
      submittedClarificationIds: new Set(), clearedConversationRunRequestIds: new Set(), cancelledRunRecoveryRequestIds: new Set(),
      streamedAssistantTextByEl: new WeakMap(), failedConversationClearRecoveryTabs: new Set(), soundCount: 0,
      CAPABILITY_LABEL: { click: 'click' }, t: x => x, sameTabId: (a,b) => Number(a) === Number(b), normalizePlanReviewTabId: Number,
      isConversationClearInProgress: () => false, reconcileRunMessageAttachmentState: noop,
      reconcilePersistedStagedScreenshots: async () => {}, sendToBackground: (action, data) => window.ownedRpc(action, data),
      refreshConversationScopeState: numeric => window.ownedRpc('agent_run_state', { tabId: numeric }), adoptRestoredRunState: async () => {},
      invalidatePlanReviewCards: noop, setTabProcessing: noop, hideRecommendedActions: noop, setTabAbortRequested: noop,
      setPlanReviewAwaiting: noop, parseCostAllowanceError: () => null,
      isTabAbortRequested: () => window.abortPending === true, showActivity: noop, startThinkingActivity: noop,
      syncSendButtonState: noop, hideActivity: noop, playClarifySound: () => window.soundCount++,
      addMessage: () => { const node = document.createElement('div'); node.className = 'message assistant'; node.innerHTML = '<div class="message-content"><div class="message-text"></div></div>'; window.messagesEl.appendChild(node); return node; },
      maybeShowPermissionEducationHint: async () => {}, scrollToBottom: noop,
      getOrCreateStepsContainer: () => document.querySelector('.message-content'), clearClarifyCountdown: noop,
      startClarifyCountdown: (card, value) => { card.dataset.originalDeadline = String(value.deadlineTs); },
      applyClarifyTimeoutExtension: data => { const card = document.querySelector(`[data-clarify-id="${CSS.escape(data.clarifyId)}"]`); if(card) card.dataset.deadlineTs = String(data.deadlineTs); },
      schedulePersist: noop, keepClarifyAliveWhileTyping: noop,
    });
    (0, eval)(helpers + '\n' + functions);
  }, { functions, helpers, tab: f.tab, options: { staleLocalOwner: options.staleLocalOwner } });
  return { page, calls,
    apply: async state => page.evaluate(state => window.applyActiveRunState(window.currentTabId, state), state || await f.state()),
    shape: () => page.evaluate(() => ({ cards: document.querySelectorAll('.clarify-card').length,
      enabled: document.querySelectorAll('.clarify-card button:not(:disabled)').length, permissionCards: document.querySelectorAll('.clarify-card[data-permission="1"]').length,
      sound: window.soundCount, cursor: Number(window.currentAssistantEl.dataset.lastRenderedSeq || 0), request: window.currentAssistantEl.dataset.runRequestId || '' })),
    async clearHtml() { await page.evaluate(() => { window.messagesEl.innerHTML = '<div class="message assistant"><div class="message-content"><div class="message-text"></div></div></div>'; window.currentAssistantEl = document.querySelector('.assistant'); }); },
    close: () => page.close(),
  };
}

for (const build of builds) {
  test(`${build.build}: actual permission survives ACK, lost card HTML and repeated hydration without answering`, async () => {
    const f = fixture(build), wait = f.permission(), p = await panel(f);
    try {
      await p.apply(); assert.equal((await p.shape()).cards, 1); assert.equal(f.journal.get(f.tab).events.length, 0);
      await p.clearHtml(); await p.apply(); await p.apply();
      const shape = await p.shape(); assert.equal(shape.cards, 1); assert.equal(shape.permissionCards, 1); assert.equal(shape.sound, 0, 'Hydrated cards leave sound to the live background event');
      assert.equal(f.agent._pendingClarifications.get(f.tab).get(wait.prompt.clarifyId).settled, undefined);
      assert.equal(p.calls.filter(x => x.action === 'clarify_response').length, 0);
      await p.page.locator('.clarify-option[data-value="once"]').click();
      assert.equal(await wait.promise, 'once'); assert.equal(f.agent.activeRunState(f.tab).pendingCurrentClarification, null);
    } finally { await p.close(); await f.close(); }
  });

  test(`${build.build}: rejected local-owner replay neither relabels newer assistant nor ACKs`, async () => {
    const f = fixture(build); f.permission(); const p = await panel(f, { staleLocalOwner: true });
    try { assert.equal(await p.apply(), false); const shape = await p.shape(); assert.equal(shape.cards, 0); assert.equal(shape.request, '');
      assert.equal(f.journal.get(f.tab).ackedSeq, 0); assert.equal(f.journal.get(f.tab).events.length, 1); }
    finally { await p.close(); await f.close(); }
  });

  for (const change of ['settled', 'Stop', 'new-run', 'same-text-new-task', 'provider-object', 'provider-config', 'steering-revision', 'queued-steering', 'worker-loss']) {
    test(`${build.build}: live descriptor refuses ${change}`, async () => {
      const f = fixture(build), wait = f.permission();
      const originalEntry = f.agent._pendingClarifications.get(f.tab).get(wait.prompt.clarifyId);
      try {
        const before = f.agent.activeRunState(f.tab).pendingCurrentClarification;
        assert.equal(before.requestId, f.request); assert.equal(before.data.permission.host, 'owned.invalid');
        assert.equal(JSON.stringify(before).includes('owned-account'), false); before.data.options.push('forged');
        assert.equal(f.agent.activeRunState(f.tab).pendingCurrentClarification.data.options.length, 3);
        if (change === 'settled') f.agent._settleClarification(f.agent._pendingClarifications.get(f.tab).get(wait.prompt.clarifyId), { cancelled: true });
        if (change === 'Stop') f.agent.abortFlags.set(f.tab, true);
        if (change === 'new-run') f.agent.currentRunId.set(f.tab, 'new-runtime');
        if (change === 'same-text-new-task') f.agent.conversations.get(f.tab).push({ role: 'user', content: 'Inspect the owned test page.' });
        if (change === 'provider-object') f.agent.providerManager.getActive = () => ({ ...f.provider });
        if (change === 'provider-config') f.provider.config.endpoint = 'http://changed.invalid';
        if (change === 'steering-revision') f.agent._steeringRuns.get(f.tab).revision++;
        if (change === 'queued-steering') f.agent._steeringRuns.get(f.tab).messages.push({ id: 'new-correction', text: 'Only explain.' });
        if (change === 'worker-loss') f.agent._pendingClarifications.clear();
        assert.equal(f.agent.activeRunState(f.tab).pendingCurrentClarification, null);
      } finally { f.agent._settleClarification(originalEntry, { cancelled: true });
        await f.close(); }
    });
  }

  test(`${build.build}: current ordinary question keeps original deadline/input and newer extension`, async () => {
    const f = fixture(build), question = await f.ordinary(), p = await panel(f);
    try {
      await p.apply(); const deadline = question.entry.deadlineTs;
      await p.page.locator('.clarify-input').fill('Owned unfinished answer');
      question.entry.deadlineTs += 5000; await p.apply();
      assert.equal(await p.page.locator('.clarify-input').inputValue(), 'Owned unfinished answer');
      assert.equal(await p.page.locator('.clarify-card').getAttribute('data-deadline-ts'), String(deadline + 5000));
      assert.equal(question.entry.deadlineTs, deadline + 5000); assert.equal(p.calls.filter(x => x.action.includes('clarify')).length, 0);
    } finally { await p.close(); await f.close(); }
  });

  test(`${build.build}: genuine question arriving during deferred ACK survives stale no-pending state`, async () => {
    const f = fixture(build); f.emit('thinking', { step: 1 }); const gate = deferred(), started = deferred();
    const p = await panel(f, { beforeAck: async () => { started.resolve(); await gate.promise; } });
    try {
      const old = await f.state(); assert.equal(old.pendingCurrentClarification, null);
      const applying = p.apply(old); await started.promise; const wait = f.permission();
      await p.page.evaluate(msg => window.handleAgentUpdateMessage(msg), f.messages.at(-1));
      assert.equal((await p.shape()).cards, 1); gate.resolve(); await applying;
      assert.equal((await p.shape()).cards, 1); assert.equal((await p.shape()).sound, 0, 'Rendering and hydration must not replay notification audio');
      assert.equal(f.agent.activeRunState(f.tab).pendingCurrentClarification.clarifyId, wait.prompt.clarifyId);
    } finally { gate.resolve(); await p.close(); await f.close(); }
  });

  test(`${build.build}: answered A and genuine B during deferred state read restores only current B`, async () => {
    const f = fixture(build), a = f.permission(), gate = deferred(), started = deferred();
    const p = await panel(f, { beforeState: async () => { started.resolve(); await gate.promise; } });
    try {
      const applying = p.apply(); await started.promise;
      f.agent.submitClarifyResponse(f.tab, a.prompt.clarifyId, 'deny', 'user'); await a.promise;
      const b = f.permission(); await p.page.evaluate(msg => window.handleAgentUpdateMessage(msg), f.messages.at(-1));
      gate.resolve(); await applying;
      assert.equal((await p.shape()).cards, 1);
      assert.equal(await p.page.locator('.clarify-card').getAttribute('data-clarify-id'), b.prompt.clarifyId);
    } finally { gate.resolve(); await p.close(); await f.close(); }
  });

  test(`${build.build}: in-flight answer cannot recreate removed permission, then actual settlement remains one-use`, async () => {
    const f = fixture(build), wait = f.permission(), gate = deferred(), started = deferred();
    const p = await panel(f, { beforeAnswer: async () => { started.resolve(); await gate.promise; } });
    try {
      await p.apply(); await p.page.locator('.clarify-option[data-value="once"]').click(); await started.promise;
      await p.apply(); assert.equal((await p.shape()).cards, 0); assert.equal(p.calls.filter(x => x.action === 'clarify_response').length, 1);
      gate.resolve(); assert.equal(await wait.promise, 'once'); await p.apply(); assert.equal((await p.shape()).cards, 0);
    } finally { gate.resolve(); await p.close(); await f.close(); }
  });

  test(`${build.build}: Stop/new request during public state await cannot recover obsolete permission`, async () => {
    const f = fixture(build); f.permission(); const gate = deferred(), started = deferred();
    const p = await panel(f, { beforeState: async () => { started.resolve(); await gate.promise; } });
    try {
      const applying = p.apply(); await started.promise;
      await p.page.evaluate(tab => { window.abortPending = true; window.localRunRequestIds.set(tab, 'newer-owned-request'); }, f.tab);
      f.agent.abortFlags.set(f.tab, true); gate.resolve(); await applying;
      assert.equal((await p.shape()).sound, 0, 'Rendering and hydration must not replay notification audio'); assert.equal(f.agent.activeRunState(f.tab).pendingCurrentClarification, null);
      assert.equal(p.calls.filter(x => x.action === 'clarify_response').length, 0);
    } finally { gate.resolve(); await p.close(); await f.close(); }
  });

  test(`${build.build}: background state load rejects replaced journal owner after awaits`, async () => {
    const f = fixture(build); f.permission(); const gate = deferred(), started = deferred();
    f.agent.getConversationState = async () => { started.resolve(); await gate.promise; return {}; };
    try { const reading = f.state(); await started.promise; f.journal.begin(f.tab, 'newer-request'); gate.resolve();
      assert.equal((await reading).pendingCurrentClarification, null); }
    finally { gate.resolve(); await f.close(); }
  });

  for (const source of ['option', 'text']) test(`${build.build}: failed ordinary ${source} transport restores explicit controls without resending`, async () => {
    const f = fixture(build), question = await f.ordinary(); let rejected = false;
    const p = await panel(f, { beforeAnswer: async () => { if (!rejected) { rejected = true; throw new Error('Owned response transport failed before settlement'); } } });
    try {
      await p.apply();
      if (source === 'text') { await p.page.locator('.clarify-input').fill('Unsent owned answer'); await p.page.locator('.clarify-submit').click(); }
      else await p.page.locator('.clarify-option').first().click();
      await p.page.waitForFunction(() => !!document.querySelector('.clarify-card:not(.clarify-answered) button:not(:disabled)'));
      assert.equal(question.entry.settled, false);
      assert.equal(p.calls.filter(x => x.action === 'clarify_response').length, 1);
      if (source === 'text') assert.equal(await p.page.locator('.clarify-input').inputValue(), 'Unsent owned answer');
      await p.page.locator('.clarify-option').last().click(); await question.promise;
      assert.equal(p.calls.filter(x => x.action === 'clarify_response').length, 2);
    } finally { await p.close(); await f.close(); }
  });

  test(`${build.build}: failed permission transport recreates only the actual still-live prompt`, async () => {
    const f = fixture(build), wait = f.permission(); let rejected = false;
    const p = await panel(f, { beforeAnswer: async () => { if (!rejected) { rejected = true; throw new Error('Owned transport failure'); } } });
    try {
      await p.apply(); await p.page.locator('.clarify-option[data-value="once"]').click();
      await p.page.waitForFunction(() => document.querySelectorAll('.clarify-card[data-permission="1"]').length === 1);
      assert.equal(p.calls.filter(x => x.action === 'clarify_response').length, 1);
      await p.page.locator('.clarify-option[data-value="deny"]').click(); assert.equal(await wait.promise, 'deny');
    } finally { await p.close(); await f.close(); }
  });

  for (const initial of ['no-prompt', 'A']) test(`${build.build}: stale captured ${initial} response never removes genuine later B on the same run`, async () => {
    const f = fixture(build), a = initial === 'A' ? f.permission() : null;
    if (!a) f.emit('thinking', { step: 1 });
    const gate = deferred(), started = deferred();
    const p = await panel(f, { afterState: async captured => { started.resolve(); await gate.promise; return captured; } });
    try {
      const applying = p.apply(); await started.promise;
      if (a) { f.agent.submitClarifyResponse(f.tab, a.prompt.clarifyId, 'deny', 'user'); await a.promise; }
      const b = f.permission(); await p.page.evaluate(msg => window.handleAgentUpdateMessage(msg), f.messages.at(-1));
      gate.resolve(); await applying;
      assert.equal(await p.page.locator(`.clarify-card[data-clarify-id="${b.prompt.clarifyId}"]`).count(), 1);
      assert.equal(f.agent.activeRunState(f.tab).pendingCurrentClarification.clarifyId, b.prompt.clarifyId);
      assert.equal(p.calls.filter(x => x.action === 'clarify_response').length, 0);
    } finally { gate.resolve(); await p.close(); await f.close(); }
  });

  test(`${build.build}: old snapshot cannot relabel an assistant already owned by another runtime request`, async () => {
    const f = fixture(build); f.permission(); const p = await panel(f);
    try {
      await p.page.evaluate(() => { window.currentAssistantEl.dataset.runRequestId = 'newer-broadcast-request'; window.currentAssistantEl.dataset.runId = 'newer-runtime'; });
      await p.apply();
      assert.equal(await p.page.locator('.message.assistant[data-run-request-id="newer-broadcast-request"]').count(), 1);
      assert.equal(await p.page.locator('.message.assistant[data-run-request-id="newer-broadcast-request"] .clarify-card').count(), 0);
    } finally { await p.close(); await f.close(); }
  });

  test(`${build.build}: settled or worker-lost replay cannot revive a permission card`, async () => {
    const f = fixture(build), wait = f.permission(), p = await panel(f);
    try {
      f.agent.submitClarifyResponse(f.tab, wait.prompt.clarifyId, 'deny', 'user'); await wait.promise;
      await p.apply(); assert.equal((await p.shape()).cards, 0); assert.equal((await p.shape()).sound, 0);
      f.agent._runningTabs.delete(f.tab); await p.apply(); assert.equal((await p.shape()).cards, 0);
    } finally { await p.close(); await f.close(); }
  });

  for (const kind of ['grouped', 'submit', 'workflow']) test(`${build.build}: current ${kind} producer restores only bounded display metadata`, async () => {
    const f = fixture(build); let promise;
    if (kind === 'grouped') promise = f.agent._promptGroupedSearchPermission(f.tab, 'owned.invalid', f.emit);
    if (kind === 'submit') promise = f.agent._promptSubmitConfirmation(f.tab, { host: 'owned.invalid', summary: 'Owned synthetic form.', changedFields: [{ label: 'Name', value: 'Owned QA' }] }, f.emit);
    if (kind === 'workflow') promise = f.agent._promptWorkflowTargetHealing(f.tab, { id: 'owned-flow', name: 'Owned flow' }, { id: 'owned-step', tool: 'click_ax', target: { role: 'button', name: 'Old owned control' } }, 0,
      [{ target: { role: 'button', name: 'Owned candidate', config: { secret: 'must-not-project' } } }], f.emit);
    f.waits.push(promise); const p = await panel(f);
    try {
      const state = await f.state(); assert.ok(state.pendingCurrentClarification);
      assert.equal(JSON.stringify(state.pendingCurrentClarification).includes('must-not-project'), false);
      await p.apply(); await p.clearHtml(); await p.apply(); assert.equal((await p.shape()).cards, 1);
      assert.equal(p.calls.filter(x => x.action === 'clarify_response').length, 0);
    } finally { await p.close(); await f.close(); }
  });
}
