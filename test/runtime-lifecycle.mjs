import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { conformFixtureCompletionCall } from './quality/completion-provider-contract.mjs';

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

const now = Date.UTC(2026, 8, 9);
function makeJob(overrides = {}) {
  return {
    id: 'scheduled-1', kind: 'task', status: 'pending', tabId: 7, mode: 'act',
    title: 'Update the page', prompt: 'Complete the requested page task.',
    target: { type: 'current_tab', tabId: 7, originalUrl: 'https://example.com/' },
    schedule: { type: 'once' }, nextRunAt: new Date(now).toISOString(),
    scheduledAt: new Date(now).toISOString(), runCount: 0,
    ...overrides,
  };
}

function harness(mod, options = {}) {
  const store = { [mod.SCHEDULED_JOBS_KEY]: structuredClone(options.jobs || [makeJob()]) };
  const alarms = new Map();
  const events = [];
  const calls = { process: 0, authorize: 0 };
  const api = {
    storage: { local: {
      async get(keys) {
        return Object.fromEntries((Array.isArray(keys) ? keys : [keys])
          .map(key => [key, structuredClone(store[key])]));
      },
      async set(value) {
        await options.beforeWrite?.(value);
        Object.assign(store, structuredClone(value));
      },
    } },
    alarms: {
      async create(name, value) { alarms.set(name, value); },
      async clear(name) { return alarms.delete(name); },
    },
    tabs: { async get(id) { return { id, url: 'https://example.com/' }; } },
  };
  const agent = {
    isRunning: () => false,
    abort() {},
    setScheduledRunPolicy() {},
    clearScheduledRunPolicy() {},
    async requireExplicitClarificationAuthorization() { calls.authorize += 1; },
    async processMessage(...args) {
      calls.process += 1;
      if (options.process) return options.process(...args);
      args[2]('tool_result', { name: 'done', result: { done: true, success: true, outcome: 'success' } });
      return 'Completed';
    },
  };
  const manager = new mod.ScheduledJobManager({
    api, agent, now: () => now, loadProviders: options.loadProviders || (async () => {}),
    sendUpdate: (...args) => events.push(args), startAlarmKeepAlive: () => () => {},
  });
  return {
    manager, alarms, events, calls,
    jobs: () => structuredClone(store[mod.SCHEDULED_JOBS_KEY]),
    run: () => manager.handleAlarm(`${mod.SCHEDULED_ALARM_PREFIX}scheduled-1`),
  };
}

for (const browser of ['chrome', 'firefox']) {
  const mod = await import(`../src/${browser}/src/agent/scheduler.js`);
  const { runUiUpdatesForCurrentTask } = await import(`../src/${browser}/src/run-ui-journal.js`);

  for (const operation of ['cancelJob', 'pauseJob', 'deleteJob']) {
    test(`${browser}: ${operation} during provider startup prevents agent dispatch`, async () => {
      const entered = deferred();
      const providers = deferred();
      const h = harness(mod, { loadProviders: async () => { entered.resolve(); await providers.promise; } });
      const run = h.run();
      await entered.promise;
      assert.equal(h.jobs()[0].status, 'running');
      const result = await h.manager[operation]('scheduled-1');
      assert.equal(result.ok, true);
      providers.resolve();
      await run;
      assert.equal(h.calls.process, 0);
      assert.equal(h.manager.isRunning(7), false);
      if (operation === 'pauseJob') {
        assert.equal((await h.manager.resumeJob('scheduled-1')).ok, true);
        await h.run();
        assert.equal(h.calls.process, 1, 'a later occurrence must get a fresh cancellation identity');
      }
    });
  }

  test(`${browser}: resume alarm during cancelled startup is rearmed after its owner releases`, async () => {
    const entered = deferred();
    const providers = deferred();
    const h = harness(mod, { loadProviders: async () => { entered.resolve(); await providers.promise; } });
    const alarmName = `${mod.SCHEDULED_ALARM_PREFIX}scheduled-1`;
    const original = h.run();
    await entered.promise;
    assert.equal((await h.manager.pauseJob('scheduled-1')).ok, true);
    assert.equal((await h.manager.resumeJob('scheduled-1')).ok, true);
    assert.equal(h.alarms.delete(alarmName), true, 'the resumed one-shot alarm fires and is consumed');
    await h.run();
    assert.equal(h.calls.process, 0, 'the cancelled owner must unwind before a new run starts');
    assert.equal(h.alarms.size, 0);
    providers.resolve();
    await original;
    assert.equal(h.jobs()[0].status, 'pending');
    assert.ok(h.alarms.get(alarmName).when > now, 'the consumed alarm must be restored');
    assert.equal(h.alarms.delete(alarmName), true);
    await h.run();
    assert.equal(h.calls.process, 1, 'only the fresh resumed occurrence may execute');
    assert.equal(h.jobs()[0].status, 'completed');
    assert.equal(h.alarms.size, 0);
  });

  for (const finalAction of ['pauseJob', 'cancelJob', 'deleteJob']) {
    test(`${browser}: deferred resume alarm does not undo a later ${finalAction}`, async () => {
      const entered = deferred();
      const providers = deferred();
      const h = harness(mod, { loadProviders: async () => { entered.resolve(); await providers.promise; } });
      const original = h.run();
      await entered.promise;
      await h.manager.pauseJob('scheduled-1');
      await h.manager.resumeJob('scheduled-1');
      h.alarms.delete(`${mod.SCHEDULED_ALARM_PREFIX}scheduled-1`);
      await h.run();
      assert.equal((await h.manager[finalAction]('scheduled-1')).ok, true);
      providers.resolve();
      await original;
      assert.equal(h.calls.process, 0);
      assert.equal(h.alarms.size, 0);
      if (finalAction === 'deleteJob') assert.equal(h.jobs().length, 0);
      else assert.equal(h.jobs()[0].status, finalAction === 'pauseJob' ? 'paused' : 'cancelled');
    });
  }

  test(`${browser}: duplicate alarm for a live startup does not schedule another occurrence`, async () => {
    const entered = deferred();
    const providers = deferred();
    const h = harness(mod, { loadProviders: async () => { entered.resolve(); await providers.promise; } });
    const original = h.run();
    await entered.promise;
    await h.run();
    providers.resolve();
    await original;
    assert.equal(h.calls.process, 1);
    assert.equal(h.jobs()[0].status, 'completed');
    assert.equal(h.alarms.size, 0);
  });

  test(`${browser}: conversation clear invalidates a scheduled startup`, async () => {
    const entered = deferred();
    const providers = deferred();
    const h = harness(mod, { loadProviders: async () => { entered.resolve(); await providers.promise; } });
    const run = h.run();
    await entered.promise;
    await h.manager.cancelForConversation(7, null);
    providers.resolve();
    await run;
    assert.equal(h.calls.process, 0);
    assert.equal(h.jobs()[0].status, 'cancelled');
  });

  test(`${browser}: resuming a paused unknown action requires reconciliation`, async () => {
    const h = harness(mod, { jobs: [makeJob({ status: 'paused', pendingToolCall: { name: 'click' } })] });
    const resumed = await h.manager.resumeJob('scheduled-1');
    assert.equal(resumed.ok, true);
    assert.equal(h.jobs()[0].status, 'needs_user_input');
    assert.equal(h.jobs()[0].clarificationRequired, true);
    assert.equal(h.alarms.size, 0);
  });

  test(`${browser}: unavailable session storage cannot acknowledge a run UI checkpoint`, async () => {
    const source = await readFile(new URL(`../src/${browser}/src/background.js`, import.meta.url), 'utf8');
    const start = source.indexOf('function persistRunUiSnapshot(');
    const end = source.indexOf('\nconst runUiSnapshotPersistence', start);
    assert.ok(start >= 0 && end > start);
    const persist = new Function('chrome', 'browser', `
      const RUN_UI_PREFIX = 'runUi:';
      const runUiPersistenceQueues = new Map();
      const runUiPersistenceFailures = new Map();
      const cloneRunUiSnapshot = structuredClone;
      const compactRunUiSnapshotForPersist = structuredClone;
      ${source.slice(start, end)}
      return persistRunUiSnapshot;
    `)({ storage: {} }, { storage: {} });
    assert.equal(await persist(7, { requestId: 'req-1', pendingToolCall: { name: 'click' } }), false);
  });

  test(`${browser}: cancellation after process entry aborts its signal`, async () => {
    const entered = deferred();
    const h = harness(mod, { process: async (_tab, _message, _update, _mode, _attachments, runOptions) => {
      entered.resolve(runOptions);
      await new Promise(resolve => runOptions.signal.addEventListener('abort', resolve, { once: true }));
      assert.equal(runOptions.isDetachedStartCancelled(), true);
      return 'Stopped';
    } });
    const run = h.run();
    const runOptions = await entered.promise;
    await h.manager.cancelJob('scheduled-1');
    await run;
    assert.equal(runOptions.signal.aborted, true);
    assert.equal(h.jobs()[0].status, 'cancelled');
  });

  test(`${browser}: consequential hook acknowledges only a completed durable write`, async () => {
    const checkpointWrite = deferred();
    const releaseWrite = deferred();
    let hookReturned = false;
    const h = harness(mod, {
      beforeWrite: async value => {
        if (value[mod.SCHEDULED_JOBS_KEY]?.[0]?.pendingToolCall) {
          checkpointWrite.resolve();
          await releaseWrite.promise;
        }
      },
      process: async (_tab, _message, _update, _mode, _attachments, runOptions) => {
        assert.equal(await runOptions.beforeConsequentialTool({ name: 'click' }), true);
        hookReturned = true;
        assert.equal(h.jobs()[0].pendingToolCall.name, 'click');
        await runOptions.afterConsequentialTool({ name: 'click', result: { success: true } });
        return 'Completed';
      },
    });
    const run = h.run();
    await checkpointWrite.promise;
    assert.equal(hookReturned, false);
    assert.equal(h.jobs()[0].pendingToolCall, null);
    releaseWrite.resolve();
    await run;
    assert.equal(hookReturned, true);
  });

  test(`${browser}: pending checkpoint failure rejects before simulated page dispatch`, async () => {
    let dispatched = false;
    const h = harness(mod, {
      beforeWrite: async value => {
        if (value[mod.SCHEDULED_JOBS_KEY]?.[0]?.pendingToolCall) throw new Error('storage unavailable');
      },
      process: async (_tab, _message, _update, _mode, _attachments, runOptions) => {
        try {
          await runOptions.beforeConsequentialTool({ name: 'click' });
          dispatched = true;
        } catch (error) {
          assert.match(error.message, /storage unavailable/);
        }
        assert.equal(h.jobs()[0].pendingToolCall, null);
        return 'No dispatch';
      },
    });
    await h.run();
    assert.equal(dispatched, false);
  });

  test(`${browser}: uncertain outcome survives settlement and restart without replay`, async () => {
    let interrupted;
    const h = harness(mod, { process: async (_tab, _message, _update, _mode, _attachments, runOptions) => {
      assert.equal(await runOptions.beforeConsequentialTool({ name: 'click' }), true);
      assert.equal(await runOptions.afterConsequentialTool({ name: 'click', outcomeUnknown: true }), false);
      assert.equal(await runOptions.beforeConsequentialTool({ name: 'click' }), false);
      interrupted = h.jobs();
      return 'Result unknown';
    } });
    await h.run();
    assert.equal(h.jobs()[0].status, 'needs_user_input');
    assert.equal(h.jobs()[0].reconciliationRequired, true);
    const restored = harness(mod, { jobs: interrupted });
    await restored.manager.restoreAlarms();
    assert.equal(restored.jobs()[0].status, 'needs_user_input');
    assert.equal(restored.alarms.size, 0);
    await restored.run();
    assert.equal(restored.calls.process, 0);
  });

  test(`${browser}: known prior action still requires reconciliation after interrupted occurrence`, async () => {
    let interrupted;
    const h = harness(mod, { process: async (_tab, _message, _update, _mode, _attachments, runOptions) => {
      assert.equal(await runOptions.beforeConsequentialTool({ name: 'click' }), true);
      assert.equal(await runOptions.afterConsequentialTool({ name: 'click', result: { success: true } }), true);
      interrupted = h.jobs();
      assert.equal(interrupted[0].pendingToolCall, null);
      return 'Completed';
    } });
    await h.run();
    const restored = harness(mod, { jobs: interrupted });
    await restored.manager.restoreAlarms();
    assert.equal(restored.jobs()[0].status, 'needs_user_input');
    assert.equal(restored.alarms.size, 0);
  });

  test(`${browser}: read-only or definitely undispatched attempts can resume automatically`, async () => {
    let undispatched;
    const h = harness(mod, { process: async (_tab, _message, _update, _mode, _attachments, runOptions) => {
      assert.equal(await runOptions.beforeConsequentialTool({ name: 'click' }), true);
      await runOptions.afterConsequentialTool({ name: 'click', result: { success: false, noDispatch: true } });
      undispatched = h.jobs();
      return 'No click was sent';
    } });
    await h.run();
    for (const jobs of [[makeJob({ status: 'running' })], undispatched]) {
      const restored = harness(mod, { jobs });
      await restored.manager.restoreAlarms();
      assert.equal(restored.jobs()[0].status, 'queued');
      assert.equal(restored.alarms.size, 1);
    }
  });

  for (const source of ['recurring', 'watch']) {
    test(`${browser}: ${source} persistence stop retains prior effects and schedules no retry`, async () => {
      const h = harness(mod, {
        jobs: [makeJob({
          source: source === 'watch' ? 'watch' : 'user',
          schedule: { type: 'recurring', interval_minutes: 1 },
          ...(source === 'watch' ? { watch: { intervalSeconds: 30, keep: true } } : {}),
        })],
        process: async (_tab, _message, update, _mode, _attachments, runOptions) => {
          assert.equal(await runOptions.beforeConsequentialTool({ name: 'click' }), true);
          await runOptions.afterConsequentialTool({ name: 'click', result: { success: true } });
          update('run_status', { status: 'persistence_degraded' });
          return 'Stopped before the next action because its checkpoint could not be saved.';
        },
      });
      await h.run();
      const job = h.jobs()[0];
      assert.equal(job.status, 'needs_user_input');
      assert.equal(job.lastOutcome, 'failed');
      assert.equal(job.clarificationRequired, true);
      assert.equal(job.reconciliationRequired, true);
      assert.equal(job.completedConsequentialAction.name, 'click');
      assert.match(job.lastError, /checkpoint could not be saved/);
      assert.equal(job.runCount, 0);
      assert.equal(h.alarms.size, 0);
    });
  }

  test(`${browser}: persistence stop is a failed background result`, async () => {
    const source = await readFile(new URL(`../src/${browser}/src/background.js`, import.meta.url), 'utf8');
    const start = source.indexOf('function isClarificationRequiredRunUpdate(');
    const end = source.indexOf('\nfunction finishRunUiSnapshot', start);
    assert.ok(start >= 0 && end > start);
    const { terminalRunUiStatus, runUpdatesSucceeded } = new Function('runUiUpdatesForCurrentTask', `
      ${source.slice(start, end)}
      return { terminalRunUiStatus, runUpdatesSucceeded };
    `)(runUiUpdatesForCurrentTask);
    const updates = [{ type: 'run_status', data: { status: 'persistence_degraded' } }];
    assert.equal(terminalRunUiStatus('Checkpoint unavailable', updates), 'failed');
    assert.equal(runUpdatesSucceeded(updates), false);
    assert.equal(terminalRunUiStatus('Completed', []), 'completed');
  });

  test(`${browser}: Run now after reconciliation stop requires explicit authorization`, async () => {
    const h = harness(mod, {
      jobs: [makeJob({ status: 'running', pendingToolCall: { name: 'click', executionId: 'old' } })],
      process: async (_tab, message, update, _mode, _attachments, runOptions) => {
        assert.match(message, /reconcile the previous result first/);
        assert.equal(h.calls.authorize, 1);
        assert.equal(await runOptions.beforeConsequentialTool({ name: 'click' }), true);
        await runOptions.afterConsequentialTool({ name: 'click', result: { noDispatch: true } });
        update('tool_result', { name: 'done', result: { done: true, success: true, outcome: 'success' } });
        return 'Reconciled';
      },
    });
    await h.manager.restoreAlarms();
    assert.equal((await h.manager.runNow('scheduled-1')).ok, true);
    await h.run();
    assert.equal(h.jobs()[0].status, 'completed');
  });
}


// Exercise the real background entry function before any run is reserved.
const chatInputVM = await import('node:vm');
function chatInputFunction(source, name) {
  source = source.replace(/\r\n/g, '\n');
  const start = source.search(new RegExp('^(?:async )?function ' + name + '\\(', 'm'));
  if (start < 0) return '';
  const end = source.indexOf('\n}', start);
  assert.ok(end > start, name + ': complete function');
  return source.slice(start, end + 2);
}
async function chatInputFixture(browser) {
  const source = await readFile(new URL('../src/' + browser + '/src/background.js', import.meta.url), 'utf8');
  const effects = { providers:0, detached:0, run:0, claim:0 };
  const reached = new Error('owned_fixture_run_entry');
  const context = {
    providerManager:{ providers:new Map(), load:async () => { effects.providers++; } },
    EMERGENCY_DOWNLOAD_ACTION:'owned_emergency',
    standaloneRunProviderId:async () => null,
    launchDetachedRun:(action, msg) => { effects.detached++; return { ok:true, accepted:true, action, text:msg.text, attachments:msg.attachments, workflowId:msg.workflowId }; },
    contextMenuStorage:{ reserve:async (_tab,_prompt,_claim,launch) => { effects.claim++; return { ...launch(), reserved:true }; } },
    assertRunCanStart:() => { effects.run++; throw reached; },
    assertNoActiveTabRun:() => { effects.run++; throw reached; },
  };
  for (const key of ['planBeforeActReady','planReviewReady','customSkillsReady','userMemoryReady','imageGenConfigReady','browserBatchEnabledReady',
    'alwaysAllowApiMutationsReady','strictSecretModeReady','webMcpEnabledReady','screenshotRedactionReady','imageBudgetReady','researchEscalationReady']) context[key] = Promise.resolve();
  const functions = ['assertChatRequestInput', 'handleMessage'].map(name => chatInputFunction(source,name)).join('\n');
  chatInputVM.runInNewContext(functions + '\nglobalThis.request = handleMessage;', context);
  return { effects, reached, request:msg => context.request({ tabId:73, ...msg }, {}) };
}
for (const browser of ['chrome','firefox']) {
  for (const [label, payload] of [
    ['wrong message field', { message:'Read the owned page; send nothing.' }],
    ['missing text', {}], ['null text', { text:null }], ['empty text', { text:'' }],
    ['whitespace text', { text:' \t\r\n ' }], ['object text', { text:{ task:'Read only.' } }],
    ['numeric text', { text:0 }], ['attachment metadata without data', { attachments:[{ kind:'text',name:'owned.txt' }] }],
    ['blank workflow', { workflowId:' \t ' }],
    ['wrong text type despite attachment', { text:[], attachments:[{kind:'text',textContent:'owned data'}] }],
  ]) {
    test(browser + ': malformed new chat rejects ' + label + ' before startup', async () => {
      for (const action of ['chat_start','chat','chat_stream']) {
        const f = await chatInputFixture(browser);
        await assert.rejects(f.request({ action, ...payload }), error => error.code === 'invalid_chat_input' && error.status === 400);
        assert.deepEqual(f.effects, { providers:0, detached:0, run:0, claim:0 });
      }
    });
  }
  test(browser + ': invalid claimed chat does not consume its context-menu claim', async () => {
    const f = await chatInputFixture(browser);
    await assert.rejects(f.request({action:'chat_start',contextMenuClaim:{promptId:'owned-prompt',claimantId:'owned-claim'}}), error => error.code === 'invalid_chat_input');
    assert.deepEqual(f.effects,{providers:0,detached:0,run:0,claim:0});
  });
  test(browser + ': real new task reaches detached/direct/streamed routes without rewriting text', async () => {
    const text = ' Read the owned page; send nothing. ';
    const f = await chatInputFixture(browser);
    const accepted = await f.request({action:'chat_start',text});
    assert.equal(accepted.accepted,true); assert.equal(accepted.text,text);
    for (const action of ['chat','chat_stream']) await assert.rejects(f.request({action,text}), error => error === f.reached);
    assert.equal(f.effects.detached,1); assert.equal(f.effects.run,2);
  });
  test(browser + ': attachment-only requests retain supported current payloads', async () => {
    for (const attachment of [{kind:'text',name:'owned.txt',textContent:''},
      {kind:'image',name:'owned.png',dataUrl:'data:image/png;base64,AA=='},
      {kind:'document',name:'owned.pdf',dataUrl:'data:application/pdf;base64,AA=='}]) {
      const f = await chatInputFixture(browser);
      const attachments = [attachment];
      const accepted = await f.request({action:'chat_start',text:'',attachments});
      assert.equal(accepted.accepted,true); assert.equal(accepted.attachments,attachments);
      await assert.rejects(f.request({action:'chat',attachments}), error => error === f.reached);
      await assert.rejects(f.request({action:'chat_stream',attachments}), error => error.code === 'invalid_chat_input');
    }
  });
  test(browser + ': saved workflow-only start is preserved but not invented for streaming', async () => {
    const f = await chatInputFixture(browser);
    const accepted = await f.request({action:'chat_start',workflowId:'owned-saved-workflow'});
    assert.equal(accepted.accepted,true); assert.equal(accepted.workflowId,'owned-saved-workflow');
    await assert.rejects(f.request({action:'chat',workflowId:'owned-saved-workflow'}), error => error === f.reached);
    await assert.rejects(f.request({action:'chat_stream',workflowId:'owned-saved-workflow'}), error => error.code === 'invalid_chat_input');
  });
  test(browser + ': explicit continuation without a new text task is unchanged', async () => {
    const f = await chatInputFixture(browser);
    const result = await f.request({action:'continue_start'});
    assert.equal(result.accepted,true); assert.equal(result.action,'continue');
    assert.equal(f.effects.detached,1);
  });
  test(browser + ': valid claimed task reaches exactly one reservation', async () => {
    const f = await chatInputFixture(browser);
    const accepted = await f.request({action:'chat_start',text:'Read the owned page.',contextMenuClaim:{promptId:'owned-prompt',claimantId:'owned-claim'}});
    assert.equal(accepted.reserved,true); assert.equal(f.effects.claim,1); assert.equal(f.effects.detached,1);
  });
}

// Exercise the actual installed fixture's provider branch without launching its
// browser/server. Native ACK permits a receipt read, never an input retry.
async function literalReceiptFixture() {
  const source = await readFile(new URL('./quality/literal-frame-mv3.mjs', import.meta.url), 'utf8');
  const policyStart = source.indexOf('function acknowledgedNativeReceiptDecision(');
  const policy = policyStart < 0 ? '' : source.slice(policyStart, source.indexOf('const providerRecoveryChecks', policyStart));
  const chooserStart = source.indexOf('      const tools = toolsFrom(input.messages)');
  const chooser = source.slice(chooserStart, source.indexOf('      assert.ok(current.calls.length', chooserStart));
  assert.ok(chooserStart >= 0 && chooser.includes('let step'), 'Use the genuine fixture provider branch');
  const digest = text => createHash('sha256').update(text).digest('hex');
  const choose = chatInputVM.runInNewContext(`${policy}\n(function(current, history) {
    const input = { messages: history }, kind = 'rich', toolsFrom = messages => messages;
    ${chooser}\nreturn step;
  })`, { digest });
  const body = 'Exact saved document 🧠', ref = 'ref_123';
  const entry = () => ({ body, url: 'https://literal.fixture.invalid/rich', calls: [{ name: 'click_ax', args: { ref_id: ref } }] });
  const acknowledgement = { success: false, method: 'cdp-native-button', initialTrustedNativeButton: true, ref_id: ref,
    nativeInputAcknowledged: true, observationInterrupted: true, dispatched: true, outcomeUnknown: true,
    retryable: false, trusted: false, verified: false };
  const receipt = `Owned QA receipt: saved exactly once. SHA256 ${digest(body)}; characters ${body.length}`;
  return { choose, entry, acknowledgement, receipt };
}

test('literal Save fixture reads the real receipt after native ACK uncertainty and never repeats Save', async () => {
  const f = await literalReceiptFixture(), entry = f.entry();
  const read = f.choose(entry, [{ name: 'click_ax', result: f.acknowledgement }]);
  assert.equal(read.name, 'read_page');
  assert.equal(entry.receiptReconciliation.receiptVerified, false);
  const done = f.choose(entry, [{ name: 'read_page', result: { text: f.receipt, hasMore: false } }]);
  assert.equal(done.name, 'done'); assert.equal(done.args.outcome, 'success');
  assert.equal(entry.receiptReconciliation.receiptVerified, true);
  assert.equal(entry.receiptReconciliation.inputReplayAllowed, false);
  assert.equal(entry.calls.length, 1);
});

test('literal Save fixture cannot promote lost ACK or mismatched receipt to success', async () => {
  const f = await literalReceiptFixture();
  const failed = f.choose(f.entry(), [{ name: 'click_ax', result: { ...f.acknowledgement, nativeInputAcknowledged: false } }]);
  assert.equal(failed.name, 'done'); assert.equal(failed.args.outcome, 'failed');
  for (const result of [{ text: 'No receipt yet', hasMore: false },
    { text: f.receipt.replace(/SHA256 [a-f0-9]+/, 'SHA256 ' + '0'.repeat(64)), hasMore: false },
    { text: f.receipt, url: 'https://foreign.fixture.invalid/', hasMore: false },
    { success: false, error: 'Read failed' }]) {
    const entry = f.entry();
    f.choose(entry, [{ name: 'click_ax', result: f.acknowledgement }]);
    const refused = f.choose(entry, [{ name: 'read_page', result }]);
    assert.equal(refused.args.outcome, 'failed'); assert.equal(entry.calls.length, 1);
  }
});

test('native Delete fixture providers honor read-only recovery instead of emitting unavailable done(success)', async () => {
  for (const name of ['mastodon-deletion-mv3.mjs', 'mastodon-deletion-navigation-mv3.mjs']) {
    const source = await readFile(new URL('./quality/' + name, import.meta.url), 'utf8');
    const start = source.indexOf('    const step = actionCalls++');
    const body = source.slice(start, source.indexOf('    completion =', start));
    assert.ok(start >= 0 && body.includes('const call'), 'Exercise the actual native deletion provider branch');
    const choose = chatInputVM.runInNewContext(`(function(){${body}\nreturn typeof emitted === 'undefined' ? call : emitted;})`, {
      actionCalls: 9, judgeOutcome: 'succeeded', interruption: '', resource: 'https://owned.fixture.invalid/@qa/200',
      input: { tools: [{ type: 'function', function: { name: 'done', parameters: { properties: { outcome: { enum: ['partial', 'failed'] } } } } },
        { type: 'function', function: { name: 'get_accessibility_tree', parameters: {} } }] },
      conformFixtureCompletionCall, completionRecovery: { reads: 0 },
    });
    const read = choose();
    assert.equal(read.name, 'get_accessibility_tree', name + ' must read current state rather than violate the advertised schema');
  }
  const recovery = { reads: 0 }, input = { tools: [{ name: 'get_accessibility_tree' }] };
  const success = { name: 'done', args: { outcome: 'success', summary: 'Requested exact result verified' } };
  conformFixtureCompletionCall(input, success, recovery); conformFixtureCompletionCall(input, success, recovery);
  assert.throws(() => conformFixtureCompletionCall(input, success, recovery), /exhausted read-only recovery/);
  assert.equal(success.args.outcome, 'success', 'Unavailable success is never silently changed to partial');
});
