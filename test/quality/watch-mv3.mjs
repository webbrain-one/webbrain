import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { chromium } from 'playwright';
import { fixtureFixedChoiceReply } from '../semantic-decision-stub.mjs';

// Optional real-time matrix: installed MV3, unchanged Agent/Scheduler, native
// chrome.alarms and an actual service-worker restart. Only the model and the
// exclusively owned loopback application are fixtures. No accounts/messages.
const out = path.resolve(process.env.WEBBRAIN_QUALITY_ARTIFACTS || 'ci/artifacts/quality-audit-2026-10-07/watch-mv3');
await fs.mkdir(out, { recursive: true });
const marker = 'OWNED_INSTALLED_WATCH_KEEP';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const textOf = content => typeof content === 'string' ? content : Array.isArray(content)
  ? content.filter(block => block?.type === 'text').map(block => block.text || '').join('\n') : '';
function toolObject(content) {
  const text = textOf(content);
  for (let start = text.indexOf('{'); start >= 0; start = text.indexOf('{', start + 1)) {
    let depth = 0, quoted = false, escaped = false;
    for (let index = start; index < text.length; index++) {
      const character = text[index];
      if (quoted) { if (escaped) escaped = false; else if (character === '\\') escaped = true; else if (character === '"') quoted = false; }
      else if (character === '"') quoted = true;
      else if (character === '{') depth++;
      else if (character === '}' && --depth === 0) { try { return JSON.parse(text.slice(start, index + 1)); } catch { break; } }
    }
  }
  return null;
}
function currentRun(messages) {
  const start = messages.findLastIndex(message => message.role === 'user' && textOf(message.content).includes('Condition and action:')
    && textOf(message.content).includes(marker));
  assert.ok(start >= 0, 'The genuine current scheduled watch task must reach the provider.');
  const current = messages.slice(start), names = new Map();
  for (const message of current) for (const call of message.tool_calls || []) names.set(call.id, call.function?.name);
  return { task: textOf(messages[start].content), tools: current.filter(message => message.role === 'tool')
    .map(message => ({ name: names.get(message.tool_call_id) || message.name, result: toolObject(message.content) })) };
}
const application = {
  main: { release: 'release-10', unavailable: false, acknowledgements: [] },
  failure: { release: 'release-20', unavailable: false, acknowledgements: [] },
};
const metrics = { installedMV3: true, realIntervalSeconds: 30, startedAt: Date.now(), phases: [],
  providerRequests: 0, actionCalls: 0, judgeCalls: 0, blockedRemoteRequests: 0,
  externalMessages: 0, accountsCreated: [], calls: [], observedAlerts: [], alarms: [], workerRestart: null, stop: null };
let held = null, providerError = null;
const html = kind => `<!doctype html><html><head><title>Owned watch ${kind}</title>
<style>body{font:18px sans-serif;margin:40px}button{font:inherit;padding:15px;margin-top:20px}</style></head>
<body><h1>Owned release watch ${kind}</h1><p id="release"></p><p id="count"></p>
<p id="availability"></p><button id="ack" type="button"></button><p role="status" id="receipt"></p>
<script>
async function refresh(){const state=await(await fetch('/state/${kind}',{cache:'no-store'})).json();
const update=(id,text)=>{const node=document.getElementById(id);if(node.textContent!==text)node.textContent=text;};
update('release','QA release: '+state.release);update('count','Acknowledgements for current release: '+state.count);
update('availability',state.unavailable?'QA check unavailable':'QA check available');
update('ack','Acknowledge '+state.release);update('receipt',state.count?'Acknowledgement recorded for '+state.release:'');
document.getElementById('ack').disabled=state.unavailable;}
document.getElementById('ack').onclick=async()=>{await fetch('/ack/${kind}',{method:'POST',headers:{'Content-Type':'application/json'},
body:JSON.stringify({release:document.getElementById('release').textContent.replace('QA release: ','')})});await refresh();};
refresh();setInterval(refresh,250);
</script></body></html>`;
const server = http.createServer(async (request, response) => {
  try {
    const route = new URL(request.url, 'http://127.0.0.1');
    const match = route.pathname.match(/^\/(state|ack)\/(main|failure)$/);
    if (match) {
      const state = application[match[2]];
      if (match[1] === 'ack') {
        assert.equal(request.method, 'POST');
        let body = ''; for await (const chunk of request) body += chunk;
        const payload = JSON.parse(body);
        assert.equal(state.unavailable, false); assert.equal(payload.release, state.release);
        state.acknowledgements.push({ release: payload.release, at: Date.now() });
      }
      response.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      response.end(JSON.stringify({ release: state.release, unavailable: state.unavailable,
        count: state.acknowledgements.filter(item => item.release === state.release).length })); return;
    }
    if (['/main', '/failure'].includes(route.pathname)) {
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); response.end(html(route.pathname.slice(1))); return;
    }
    if (route.pathname !== '/v1/chat/completions') { response.writeHead(404); response.end(); return; }
    let body = ''; for await (const chunk of request) body += chunk;
    const input = JSON.parse(body), system = textOf(input.messages?.[0]?.content);
    metrics.providerRequests++;
    await sleep(180);
    const isJudge = system.startsWith('Evaluate only the observable requirements of the genuine user task');
    const isAction = Array.isArray(input.tools) && input.tools.length > 0;
    // WebBrain's fixed-choice questions carry short page texts (the receipt
    // line), not the task; read them the way a model would.
    const fixedChoice = fixtureFixedChoiceReply(input.messages);
    let completion;
    if (fixedChoice) {
      metrics.fixedChoiceQuestions = (metrics.fixedChoiceQuestions || 0) + 1;
      completion = { role: 'assistant', content: fixedChoice };
    } else if (isJudge) {
      metrics.judgeCalls++;
      // A positive independent verdict is based on a fresh native read AND
      // the actual owned server acknowledgement; it cannot manufacture a send.
      const evidence = input.messages.slice(1).map(message => textOf(message.content)).join('\n');
      const release = evidence.match(/Acknowledgement recorded for (release-\d+)/)?.[1];
      const acknowledged = release && application.main.acknowledgements.filter(item => item.release === release).length === 1;
      completion = { role: 'assistant', content: JSON.stringify({ outcome: acknowledged ? 'succeeded' : 'uncertain',
        reason: acknowledged ? 'Fresh native confirmation and the exact owned server record agree.' : 'No independently matching fresh acknowledgement.' }) };
    } else if (!isAction) {
      assert.ok(JSON.stringify(input.messages).includes(marker), 'Intent must classify the genuine watch task.');
      completion = { role: 'assistant', content: JSON.stringify({ request_kind: 'execute', scope_relation: 'new',
        requires_state_change: true, requires_submission: false, messaging: null,
        deliverables: ['Check the current owned release and acknowledge only a distinct new release.'],
        allows_planner_shaped_result: false, allows_app_state_tool_evidence: false,
        completion_requirements: { download: false }, read_scope: 'visible_page',
        summary: 'Observe the current release, establish its baseline, then acknowledge distinct events once.',
        steps: [{ id: '1', action: 'Read, detect a distinct release, arm its stable alert, acknowledge once and verify.' }],
        memory: { use_progress_ledger: false, progress_action: null }, scheduling: null, risks: [] }) };
    } else {
      const { task, tools } = currentRun(input.messages), last = tools.at(-1);
      let name = 'get_accessibility_tree', args = { filter: 'all' };
      const lastRead = tools.findLast(tool => tool.name === 'get_accessibility_tree');
      const tree = lastRead?.result?.pageContent || '';
      const release = tree.match(/QA release: (release-\d+)/)?.[1];
      if (last?.name === 'get_accessibility_tree') {
        assert.equal(last.result?.error, undefined, last.result?.error || 'Fresh native watch read failed.');
        assert.equal(typeof last.result?.pageContent, 'string', 'Fresh native watch read must return its actual AX tree.');
        assert.ok(release, tree);
        if (tree.includes('QA check unavailable')) {
          name = 'done'; args = { outcome: 'failed', summary: `Observed ${release}; the owned check is unavailable.` };
        } else if (tools.some(tool => tool.name === 'click_ax')) {
          assert.match(tree, new RegExp(`Acknowledgement recorded for ${release}`));
          name = 'done'; args = { outcome: 'success', summary: `Observed ${release}; acknowledgement count 1.` };
        } else if (task.includes('Previous observation: none.')) {
          name = 'done'; args = { outcome: 'partial', summary: `Observed ${release}; established baseline; acknowledgement count 0.` };
        } else {
          // Intentionally present the same stable event again after restart.
          // The real beep tool must reject repetition before any native click.
          name = 'beep'; args = { event_key: release, message: `Owned distinct release ${release}` };
        }
      } else if (last?.name === 'beep') {
        assert.equal(last.result?.success, true, last.result?.error || 'Native watch alert could not be armed.');
        assert.equal(last.result.eventKey, release, 'The actual provider-visible alert must match the freshly read native event.');
        metrics.observedAlerts.push({ at: Date.now(), release, eventKey: last.result.eventKey,
          armed: last.result.armed === true, duplicate: last.result.duplicate === true });
        if (last.result.duplicate === true) {
          name = 'done'; args = { outcome: 'partial', summary: `Observed ${release}; unchanged event; acknowledgement count 1.` };
        } else {
          assert.equal(last.result.armed, true);
          const line = tree.split('\n').find(line => line.includes(`button "Acknowledge ${release}"`));
          const ref = line?.match(/\[(ref_\d+)\]/)?.[1]; assert.ok(ref, tree);
          name = 'click_ax'; args = { ref_id: ref };
          if (release === 'release-13') await new Promise(resolve => { held = { release, releaseResponse: resolve, at: Date.now() }; });
        }
      } else if (last?.name === 'click_ax') {
        assert.equal(last.result?.success, true, JSON.stringify(last.result));
      } else if (last?.name === 'done') {
        // A newly delivered page-feedback event can interrupt terminal return
        // after an otherwise valid done. Re-observe; never repeat the action.
        assert.ok(last.result?.done === true || last.result?.blockedDone === true,
          `Unexpected terminal watch result: ${JSON.stringify(last.result)}`);
      }
      metrics.actionCalls++; assert.ok(metrics.actionCalls <= 45, 'Watch must not enter a tight model loop.');
      metrics.calls.push({ at: Date.now(), name, release, outcome: args.outcome });
      completion = { role: 'assistant', content: '', tool_calls: [{ id: `watch-${metrics.actionCalls}`, type: 'function',
        function: { name, arguments: JSON.stringify(args) } }] };
    }
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ id: `owned-watch-${metrics.providerRequests}`, choices: [{ message: completion,
      finish_reason: isAction ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 25 } }));
  } catch (error) {
    providerError ||= error.message;
    response.writeHead(500, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ error: error.message }));
  }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'webbrain-watch-mv3-'));
let context, harness, worker;
const versions = new Map();
const snapshot = async () => harness.evaluate(async () => ({ jobs: (await chrome.storage.local.get('wb_scheduled_jobs')).wb_scheduled_jobs || [],
  tabs: (await chrome.tabs.query({})).map(tab => ({ id: tab.id, url: tab.url, active: tab.active })),
  alarms: await chrome.alarms.getAll(), firedAlarms: window.watchAlarms || [], events: window.watchEvents || [] }));
const record = async phase => {
  const state = await snapshot(); metrics.phases.push({ phase, elapsedMs: Date.now() - metrics.startedAt, ...state });
  await fs.writeFile(path.join(out, 'progress.json'), JSON.stringify({ metrics, application }, null, 2));
  console.log(JSON.stringify({ phase, elapsedMs: Date.now() - metrics.startedAt,
    jobs: state.jobs.map(job => ({ status: job.status, runCount: job.runCount, lastOutcome: job.lastOutcome,
      failures: job.watch?.consecutiveFailures, eventKey: job.watch?.lastTriggeredEventKey })),
    acknowledgements: application.main.acknowledgements.length }));
  return state;
};
try {
  // Pin this audited build even if the shared workspace receives a later pull.
  const extension = path.join(profile, 'extension'); await fs.cp(path.resolve('src/chrome'), extension, { recursive: true });
  metrics.sourceSha256 = Object.fromEntries(await Promise.all(['agent.js', 'scheduler.js', 'completion-runtime.js'].map(async name =>
    [name, createHash('sha256').update(await fs.readFile(path.join(extension, 'src/agent', name))).digest('hex')])));
  // Read-only instrumentation in the private cloned build, so worker restart
  // waits for Scheduler's alert/teardown tail as well as its persisted status.
  await fs.appendFile(path.join(extension, 'src/background.js'), '\nglobalThis.__ownedWatchScheduler = scheduler;globalThis.__ownedWatchBoot=crypto.randomUUID();\n');
  context = await chromium.launchPersistentContext(profile, { headless: true, channel: 'chromium',
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`,
      '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1'] });
  await context.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.hostname === '127.0.0.1' || url.protocol === 'chrome-extension:') return route.continue();
    if (/^https?:$/.test(url.protocol)) metrics.blockedRemoteRequests++;
    return route.abort('blockedbyclient');
  });
  worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker', { timeout: 30_000 });
  const guardWorker = async () => worker.evaluate(() => {
    const send = fetch.bind(globalThis);
    globalThis.fetch = (input, options) => {
      const url = new URL(typeof input === 'string' ? input : input.url);
      return url.hostname === '127.0.0.1' || ['chrome-extension:', 'data:', 'blob:'].includes(url.protocol)
        ? send(input, options) : Promise.reject(new Error('Owned watch fixture blocks external network requests.'));
    };
  });
  await guardWorker();
  const extensionId = new URL(worker.url()).host;
  harness = await context.newPage(); await harness.goto(`chrome-extension://${extensionId}/src/ui/settings.html`);
  const message = (action, data = {}) => harness.evaluate(({ action, data }) => chrome.runtime.sendMessage({ target: 'background', action, ...data }), { action, data });
  await harness.evaluate(async () => {
    window.watchEvents = []; window.watchAlarms = [];
    chrome.alarms.onAlarm.addListener(alarm => watchAlarms.push({ name: alarm.name, scheduledTime: alarm.scheduledTime, at: Date.now() }));
    chrome.runtime.onMessage.addListener(event => {
      if (event.action === 'agent_update') watchEvents.push({ type: event.type, tabId: event.tabId, data: event.data, at: Date.now() });
    });
    await chrome.storage.local.set({ helpImproveWebBrain: false, tracingEnabled: false, autoScreenshot: false,
      screenshotFallback: false, visionMode: 'off', planBeforeActMode: 'off', planBeforeAct: false, planReviewMode: 'never',
      maxAgentSteps: 12, systemOneEnabled: false, agentAllowLocalNetwork: true, askBeforeConsequentialActions: false,
      openaiAskStreamingEnabled: false, scheduledTasksEnabled: true, scheduledRequireConsequentialConfirmation: false });
  });
  assert.equal((await message('update_provider', { providerId: 'openrouter', config: { apiKey: 'owned-fixture-fake-key',
    baseUrl: `${base}/v1`, model: 'minimax/minimax-m3', contextWindow: 1000000, enabled: true, supportsAskStreaming: false } })).ok, true);
  assert.equal((await message('set_active_provider', { providerId: 'openrouter' })).ok, true);
  const page = await context.newPage(); await page.goto(`${base}/main`);
  const initiating = await harness.evaluate(async url => (await chrome.tabs.query({})).find(tab => tab.url === url), `${base}/main`);
  assert.ok(initiating?.id);
  const create = async (tabId, suffix = '') => {
    const command = `/watch --keep --secs 30 ${marker}${suffix}: When a new release appears, acknowledge it exactly once on this owned page. Establish a baseline first. /beep`;
    return harness.evaluate(async ({ tabId, command }) => {
      const { parseWatchSlashCommand } = await import(chrome.runtime.getURL('src/ui/watch-command.js'));
      const parsed = parseWatchSlashCommand(command);
      if (!parsed.ok) throw new Error('The installed slash-command parser rejected the valid watch command.');
      return chrome.runtime.sendMessage({ target: 'background', action: 'create_watch_job', tabId,
        watch: { prompt: parsed.prompt, keep: parsed.keep, interval_seconds: parsed.intervalSeconds,
          beep: parsed.beep, beep_style: parsed.beepStyle } });
    }, { tabId, command });
  };
  const waitJob = async (jobId, predicate, label, timeout = 45_000) => {
    const end = Date.now() + timeout;
    do {
      assert.equal(providerError, null, providerError || 'Owned model fixture failed.');
      const state = await snapshot(), job = state.jobs.find(job => job.id === jobId);
      if (predicate(job, state)) return { job, state };
      if (job && ['needs_user_input', 'failed'].includes(job.status) && !predicate(job, state))
        throw new Error(`${label}: watch stopped unexpectedly: ${JSON.stringify(job)}`);
      await sleep(300);
    } while (Date.now() < end);
    throw new Error(`${label}: timed out waiting for actual native alarm: ${JSON.stringify(await snapshot())}`);
  };
  const created = await create(initiating.id); assert.equal(created.success, true, JSON.stringify(created));
  let { job, state } = await waitJob(created.jobId, job => job?.runCount === 1 && job.status === 'pending', 'Initial baseline');
  assert.equal(job.watch.baselineEstablished, true); assert.equal(job.lastOutcome, 'partial');
  assert.equal(application.main.acknowledgements.length, 0); assert.equal(job.watch.lastTriggeredEventKey, null);
  const helperId = job.target.tabId;
  assert.notEqual(helperId, initiating.id); assert.equal(state.tabs.find(tab => tab.id === helperId)?.active, false);
  assert.equal(state.tabs.find(tab => tab.id === initiating.id)?.url, `${base}/main`);
  assert.equal(state.tabs.find(tab => tab.id === initiating.id)?.active, initiating.active);
  assert.ok(state.alarms.some(alarm => alarm.name === `wb_scheduled_job:${created.jobId}`));
  assert.equal(state.firedAlarms.filter(alarm => alarm.name === `wb_scheduled_job:${created.jobId}`).length, 1);
  await record('baseline-native-alarm');

  application.main.release = 'release-11';
  ({ job } = await waitJob(created.jobId, job => job?.runCount === 2 && job.status === 'pending', 'First distinct event'));
  assert.equal(job.lastOutcome, 'success'); assert.equal(job.watch.lastTriggeredEventKey, 'release-11');
  assert.deepEqual(application.main.acknowledgements.map(item => item.release), ['release-11']);
  const settledEnd = Date.now() + 10_000;
  while (await worker.evaluate(jobId => __ownedWatchScheduler._executions.has(jobId), created.jobId)) {
    assert.ok(Date.now() < settledEnd, 'The actual scheduler must finish alert playback and release its alarm owner.');
    await sleep(100);
  }
  const session = await context.newCDPSession(harness);
  const nativeWorkerStates = [];
  session.on('ServiceWorker.workerVersionUpdated', ({ versions: updates }) => updates.forEach(version => {
    versions.set(version.versionId, version);
    if (version.scriptURL.startsWith(`chrome-extension://${extensionId}/`)) nativeWorkerStates.push(version.runningStatus);
  }));
  await session.send('ServiceWorker.enable');
  let version; const locateEnd = Date.now() + 5000;
  do { version = [...versions.values()].find(version => version.runningStatus === 'running' && version.scriptURL.startsWith(`chrome-extension://${extensionId}/`));
    if (!version) await sleep(100); } while (!version && Date.now() < locateEnd);
  assert.ok(version, 'Locate only the isolated extension worker.');
  const oldBoot = await worker.evaluate(() => globalThis.__ownedWatchBoot);
  nativeWorkerStates.length = 0;
  await session.send('ServiceWorker.stopWorker', { versionId: version.versionId });
  // The alert offscreen document may immediately wake the stopped worker.
  // DevTools' latest status can therefore already be running again. Prove
  // actual heap loss with the per-boot marker, never reset that marker here.
  await sleep(250);
  await message('get_providers');
  const restartEnd = Date.now() + 20_000;
  while (![...versions.values()].some(version => version.runningStatus === 'running' && version.scriptURL.startsWith(`chrome-extension://${extensionId}/`))
      && Date.now() < restartEnd) await sleep(100);
  assert.ok([...versions.values()].some(version => version.runningStatus === 'running' && version.scriptURL.startsWith(`chrome-extension://${extensionId}/`)));
  worker = context.serviceWorkers().find(current => current.url().startsWith(`chrome-extension://${extensionId}/`)) || worker;
  assert.notEqual(await worker.evaluate(() => globalThis.__ownedWatchBoot), oldBoot, 'Actual worker globals must be discarded.');
  await guardWorker();
  metrics.workerRestart = { at: Date.now(), nativeStopCommand: true, nativeWorkerStates, freshGlobal: true,
    persistedEventKey: (await snapshot()).jobs.find(item => item.id === created.jobId)?.watch.lastTriggeredEventKey };
  assert.equal(metrics.workerRestart.persistedEventKey, 'release-11');
  await record('worker-restarted');

  ({ job } = await waitJob(created.jobId, job => job?.runCount === 3 && job.status === 'pending', 'Same event after restart'));
  assert.equal(job.lastOutcome, 'partial'); assert.equal(job.watch.lastTriggeredEventKey, 'release-11');
  assert.deepEqual(application.main.acknowledgements.map(item => item.release), ['release-11']);
  assert.ok(metrics.observedAlerts.some(alert => alert.at >= metrics.workerRestart.at
    && alert.release === 'release-11' && alert.eventKey === 'release-11'
    && alert.duplicate === true && alert.armed === false),
  'The actual provider tool result after the native reboot must reject the persisted duplicate event.');
  assert.ok((await snapshot()).events.some(event => event.type === 'tool_result' && event.data?.name === 'beep'
    && event.data.result?.success === true), 'The compact UI transport must retain the native alert result.');
  await record('same-event-not-repeated');

  application.main.release = 'release-12';
  ({ job } = await waitJob(created.jobId, job => job?.runCount === 4 && job.status === 'pending', 'Second distinct event'));
  assert.equal(job.lastOutcome, 'success'); assert.equal(job.watch.lastTriggeredEventKey, 'release-12');
  assert.deepEqual(application.main.acknowledgements.map(item => item.release), ['release-11', 'release-12']);
  await record('new-event-once');

  application.main.release = 'release-13';
  await waitJob(created.jobId, job => job?.status === 'running' && !!held, 'Stop while model response is pending');
  const stopAt = Date.now(); assert.equal((await message('cancel_scheduled_job', { jobId: created.jobId })).ok, true);
  held.releaseResponse(); held = null; await sleep(1500);
  state = await snapshot(); job = state.jobs.find(item => item.id === created.jobId);
  assert.equal(job.status, 'cancelled'); assert.equal(state.tabs.some(tab => tab.id === helperId), false, 'Stop removes the owned helper.');
  assert.equal(state.alarms.some(alarm => alarm.name === `wb_scheduled_job:${created.jobId}`), false);
  assert.deepEqual(application.main.acknowledgements.map(item => item.release), ['release-11', 'release-12'], 'A late prepared click must not escape Stop.');
  const realAlarms = state.firedAlarms.filter(alarm => alarm.name === `wb_scheduled_job:${created.jobId}`);
  assert.equal(realAlarms.length, 5, 'Five genuine automatic polls cover baseline, two events, duplicate and Stop.');
  for (let index = 1; index < realAlarms.length; index++) assert.ok(realAlarms[index].at - realAlarms[index - 1].at >= 29_500,
    'The main matrix must use the actual 30-second interval, without clock or alarm acceleration.');
  metrics.alarms = realAlarms;
  metrics.stop = { status: job.status, helperClosed: true, alarmCleared: true, lateMutationCount: 0, elapsedMs: Date.now() - stopAt };
  await record('stop-helper-cleanup');

  const failurePage = await context.newPage(); await failurePage.goto(`${base}/failure`);
  const failureTab = await harness.evaluate(async url => (await chrome.tabs.query({})).find(tab => tab.url === url), `${base}/failure`);
  const failure = await create(failureTab.id, '_FAILURE'); assert.equal(failure.success, true);
  ({ job } = await waitJob(failure.jobId, job => job?.runCount === 1 && job.status === 'pending', 'Failure-case baseline'));
  const failureHelperId = job.target.tabId, baseline = job.watch.lastObservation;
  application.failure.unavailable = true;
  for (let count = 1; count <= 3; count++) {
    // The advertised Run now API creates a real one-shot chrome.alarms event;
    // no scheduler call, clock, Agent outcome or persisted job is mocked.
    assert.equal((await message('run_scheduled_job_now', { jobId: failure.jobId })).ok, true);
    ({ job, state } = await waitJob(failure.jobId, job => job?.watch.consecutiveFailures === count
      && job.status === (count === 3 ? 'failed' : 'pending'), `Failure ${count}`));
    assert.equal(job.watch.lastObservation, baseline, 'A failed check must not overwrite the trusted prior baseline.');
    assert.equal(job.lastOutcome, 'failed'); assert.equal(application.failure.acknowledgements.length, 0);
  }
  assert.equal(job.runCount, 4); assert.equal(state.tabs.some(tab => tab.id === failureHelperId), false);
  assert.equal(state.firedAlarms.filter(alarm => alarm.name === `wb_scheduled_job:${failure.jobId}`).length, 4);
  assert.equal(state.alarms.some(alarm => alarm.name === `wb_scheduled_job:${failure.jobId}`), false);
  assert.equal((await message('run_scheduled_job_now', { jobId: failure.jobId })).ok, false, 'A terminal failed watch is not silently revived.');
  await record('three-failures-stop-cleanup');
  metrics.elapsedMs = Date.now() - metrics.startedAt;
  metrics.passed = true;
  await fs.writeFile(path.join(out, 'evidence.json'), JSON.stringify({ metrics, application, final: await snapshot() },
    (_key, value) => typeof value === 'string' && value.startsWith('data:image/') ? '[owned screenshot omitted]' : value, 2));
  console.log(JSON.stringify({ passed: true, installedMV3: true, nativeAlarms: true, actualWorkerRestart: true,
    baselineWithoutMutation: true, distinctEvents: 2, acknowledgements: 2, duplicateSuppressed: true,
    stopHelperCleanup: true, threeFailureCleanup: true, externalMessages: 0, elapsedMs: metrics.elapsedMs }));
} catch (error) {
  await fs.writeFile(path.join(out, 'failure.json'), JSON.stringify({ error: error.message, providerError, metrics, application,
    state: harness ? await snapshot().catch(() => null) : null },
    (_key, value) => typeof value === 'string' && value.startsWith('data:image/') ? '[owned screenshot omitted]' : value, 2));
  throw error;
} finally {
  held?.releaseResponse();
  await context?.close(); await new Promise(resolve => server.close(resolve));
  const resolved = path.resolve(profile);
  if (!resolved.startsWith(path.resolve(os.tmpdir()) + path.sep + 'webbrain-watch-mv3-')) throw new Error('Unexpected temporary profile path.');
  await fs.rm(resolved, { recursive: true, force: true });
}
