import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { fixtureFixedChoiceReply } from '../semantic-decision-stub.mjs';

// Exercise the installed MV3 background, provider, Agent and content transport.
// A loopback provider returns deterministic calls; browser actions remain real.
const browserBatch = process.argv.includes('--batch');
const browserBatchDisabled = process.argv.includes('--batch-disabled');
const batchComparison = browserBatch || browserBatchDisabled;
const fullForm = process.argv.includes('--full-form') || browserBatch || browserBatchDisabled;
const debugBindings = process.argv.includes('--debug-binding');
const out = path.resolve(process.env.WEBBRAIN_QUALITY_ARTIFACTS || 'ci/artifacts/quality-audit-2026-10-07/integration-mv3');
await fs.mkdir(out, { recursive: true });
const body = `<!doctype html><style>body{font:18px sans-serif;margin:32px;max-width:900px}label{display:block;margin:18px 0}input,button{font:inherit;padding:8px}aside{position:absolute;right:35px;top:20px}</style>
<title>WebBrain owned MV3 fixture</title><h1>QA contact form</h1><aside>Live counter: <span id="counter">0</span></aside>
<form id="qa-form"><label>Name <input name="name" required></label><label>Email <input name="email" type="email" required></label>
<label>Plan <select name="plan"><option value="standard">Standard</option><option value="pro">Pro</option></select></label>
<label>Message <textarea name="message" required></textarea></label><button>Submit QA form</button></form><p id="result" role="status"></p>
<script>window.counterTicks=0;setInterval(()=>document.querySelector('#counter').textContent=String(++counterTicks),80);document.querySelector('form').onsubmit=async e=>{e.preventDefault();await fetch('/submit',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(Object.fromEntries(new FormData(e.target)))});document.querySelector('#result').textContent='QA submission recorded';};</script>`;
const providerCalls = [];
const submissions = [];
let fakeRefs = {}, actionCalls = 0;
const server = http.createServer(async (request, response) => {
  if (request.url === '/submit') {
    let text = ''; for await (const chunk of request) text += chunk;
    submissions.push(JSON.parse(text)); response.writeHead(200, { 'Content-Type': 'application/json' }); response.end('{"ok":true}'); return;
  }
  if (request.url === '/v1/chat/completions') {
    let text = ''; for await (const chunk of request) text += chunk;
    const input = JSON.parse(text); providerCalls.push(input);
    await new Promise(resolve => setTimeout(resolve, 240));
    const isAction = Array.isArray(input.tools) && input.tools.length > 0;
    const isCompletionEvaluation = String(input.messages?.[0]?.content || '').startsWith('Evaluate only the observable requirements of the genuine user task');
    const number = actionCalls;
    // WebBrain's fixed-choice questions, read the way a model would read
    // this fixture: its submission receipt says the submission was recorded.
    const fixedChoice = fixtureFixedChoiceReply(input.messages);
    let completion;
    if (fixedChoice) completion = { role: 'assistant', content: fixedChoice };
    else if (isCompletionEvaluation) completion = { role: 'assistant', content: JSON.stringify({ outcome: 'uncertain', reason: 'Exercise the deterministic inline-submit evidence fallback.' }) };
    else if (!isAction) completion = { role: 'assistant', content: JSON.stringify({ request_kind: 'execute', scope_relation: 'new', deliverables: [fullForm ? 'Submit and verify the owned QA form' : 'Fill the Name field'], requires_state_change: true, requires_submission: fullForm, messaging: null, completion_requirements: { download: false }, allows_planner_shaped_result: false, allows_app_state_tool_evidence: false, read_scope: 'visible_page', summary: fullForm ? 'Fill the owned form, submit once and verify its confirmation.' : 'Fill the owned Name field and leave the form unsubmitted.', steps: [{ id: '1', action: fullForm ? 'Fill all specified fields, submit once and verify confirmation.' : 'Fill Name with WebBrain QA.' }], memory: { use_progress_ledger: false, progress_action: null }, scheduling: null, risks: [] }) };
    else {
      actionCalls++;
      const steps = [{ name: 'set_field', args: { ref_id: fakeRefs.name, text: 'WebBrain QA' } }];
      if (fullForm) steps.push(
        { name: 'set_field', args: { ref_id: fakeRefs.email, text: 'qa-audit@picment.xyz' } },
        ...(!batchComparison ? [{ name: 'type_ax', args: { ref_id: fakeRefs.plan, text: 'Pro' } }] : []),
        { name: 'set_field', args: { ref_id: fakeRefs.message, text: 'Passive update verification.' } },
        { name: 'click_ax', args: { ref_id: fakeRefs.submit } },
        { name: 'get_accessibility_tree', args: { filter: 'visible' } },
      );
      const plannedSteps = browserBatch ? [
        { name: 'browser_batch', args: { actions: steps.slice(0, -1).map(step => ({ name: step.name, input: step.args })) } },
        steps.at(-1),
      ] : steps;
      const step = plannedSteps[number] || { name: 'done', args: { summary: 'The owned form test is complete.', outcome: 'success' } };
      const fn = { name: step.name, arguments: JSON.stringify(step.args) };
      completion = { role: 'assistant', content: '', tool_calls: [{ id: `mv3-${number}`, type: 'function', function: fn }] };
    }
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ id: `completion-${providerCalls.length}`, choices: [{ message: completion, finish_reason: isAction ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 20 } }));
    return;
  }
  response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); response.end(body);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${server.address().port}/form`;
const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'webbrain-integration-mv3-'));
let context;
try {
  let extension = path.resolve('src/chrome');
  if (debugBindings) {
    extension = path.join(profile, 'owned-extension'); await fs.cp(path.resolve('src/chrome'), extension, { recursive: true });
    const monitorFile = path.join(extension, 'src/content/page-monitor.js');
    const monitor = await fs.readFile(monitorFile, 'utf8');
    await fs.writeFile(monitorFile, monitor.replace('  window.__wbPageMonitor = {', `  window.__qualityDebug = params => {
      const snapshot = modelSnapshots.get(params.snapshotToken), target = modelTarget(params), before = snapshot?.targets.get(target), after = actionFootprint(target);
      return { interventionRevision, interventionUnreported, pendingDOM, snapshotIntervention: snapshot?.interventionRevision,
        bindingAvailable: !!before, afterAvailable: !!after, contextChanged: before?.context !== after?.context,
        beforeContext: before?.context, afterContext: after?.context, hitChanged: before?.hit !== after?.hit,
        differences: ['nodes', 'ancestors'].flatMap(key => (before?.[key] || []).flatMap((item, index) => {
          const current = after?.[key]?.[index]; return item.node !== current?.node || item.value !== current?.value
            ? [{ key, index, node: item.node.tagName + '#' + item.node.id, identityChanged: item.node !== current?.node, before: item.value, after: current?.value }] : [];
        })) };
    };
  window.__wbPageMonitor = {`));
  }
  context = await chromium.launchPersistentContext(profile, { headless: true, channel: 'chromium', args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`] });
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker', { timeout: 30000 });
  const id = new URL(worker.url()).host;
  const harness = await context.newPage(); await harness.goto(`chrome-extension://${id}/src/ui/settings.html`);
  const message = (action, data = {}) => harness.evaluate(({ action, data }) => chrome.runtime.sendMessage({ target: 'background', action, ...data }), { action, data });
  await harness.evaluate(async () => {
    window.events = [];
    chrome.runtime.onMessage.addListener(event => { if (event.action === 'agent_update') events.push({ type: event.type, data: event.data }); });
    await chrome.storage.local.set({ helpImproveWebBrain: false, planBeforeActMode: 'off', planBeforeAct: false, planReviewMode: 'never', screenshotFallback: false, autoScreenshot: false, maxAgentSteps: 12, systemOneEnabled: false, tracingEnabled: false, agentAllowLocalNetwork: true, askBeforeConsequentialActions: false, openaiAskStreamingEnabled: false });
  });
  if (browserBatchDisabled) await harness.evaluate(async () => {
    await chrome.storage.local.set({ browserBatchEnabled: false });
    // Only the local setting owns this switch; an unrelated session key cannot enable it.
    await chrome.storage.session.set({ browserBatchEnabled: true });
  });
  await worker.evaluate(async debugBindings => {
    globalThis.integrationProbe = { transports: [], feedback: [] };
    chrome.runtime.onMessage.addListener(message => {
      if (message.action === 'page_feedback') integrationProbe.feedback.push({ ...message.feedback, at: Date.now() });
    });
    const send = chrome.tabs.sendMessage.bind(chrome.tabs);
    chrome.tabs.sendMessage = async (tabId, message, options) => {
      const result = await send(tabId, message, options);
      if (debugBindings && message.action === 'page_monitor_validate_model' && !result.ready) {
        const diagnostic = await chrome.scripting.executeScript({ target: { tabId }, func: params => window.__qualityDebug?.(params), args: [message.params] });
        integrationProbe.bindingDiagnostics ??= []; integrationProbe.bindingDiagnostics.push(diagnostic[0]?.result);
      }
      if (/page_monitor|set_field/.test(message.action)) integrationProbe.transports.push({ action: message.action, at: Date.now(), params: { tool: message.params?.tool, ref_id: message.params?.ref_id, allowPassiveRebase: message.params?.allowPassiveRebase, expectedModelSnapshot: !!message.params?.expectedModelSnapshot, operationId: message.params?.operationId, fenceOnly: message.params?.fenceOnly }, result });
      return result;
    };
  }, debugBindings);
  assert.equal((await message('update_provider', { providerId: 'openrouter', config: { apiKey: 'owned-fixture-fake-key', baseUrl: `http://127.0.0.1:${server.address().port}/v1`, model: 'minimax/minimax-m3', contextWindow: 1000000, enabled: true, supportsAskStreaming: false, ...(browserBatch || browserBatchDisabled ? { promptTier: 'mid' } : {}) } })).ok, true);
  assert.equal((await message('set_active_provider', { providerId: 'openrouter' })).ok, true);
  const page = await context.newPage(); await page.goto(url);
  const tabId = await harness.evaluate(async url => (await chrome.tabs.query({})).find(tab => tab.url === url)?.id, url);
  const observation = await harness.evaluate(tabId => chrome.tabs.sendMessage(tabId, { target: 'content', action: 'get_accessibility_tree', params: { filter: 'visible' } }), tabId);
  for (const [name, pattern] of [['name', /textbox "Name"/], ['email', /textbox "Email"/], ['plan', /combobox "Plan\b/], ['message', /textbox "Message"/], ['submit', /button "Submit QA form"/]]) {
    fakeRefs[name] = observation.pageContent.split('\n').find(line => pattern.test(line))?.match(/\[(ref_\d+)\]/)?.[1];
    assert.ok(fakeRefs[name], observation.pageContent);
  }
  const text = fullForm ? `Fill and submit this owned QA form exactly once: Name WebBrain QA; email qa-audit@picment.xyz; ${batchComparison ? 'leave plan Standard' : 'plan Pro'}; message Passive update verification. Verify the recorded confirmation before finishing.` : 'Fill Name with WebBrain QA only. Do not submit. Finish after that field is filled.';
  const started = performance.now();
  const result = await message('chat', { tabId, text, mode: 'act', requestId: 'mv3-owned-field', locale: 'en' });
  const elapsedMs = Math.round(performance.now() - started);
  const probe = await worker.evaluate(() => integrationProbe);
  const events = await harness.evaluate(() => events);
  const value = await page.locator('[name=name]').inputValue();
  await fs.writeFile(path.join(out, browserBatch ? 'batch-form-evidence.json' : browserBatchDisabled ? 'batch-disabled-form-evidence.json' : fullForm ? 'full-form-evidence.json' : 'evidence.json'), JSON.stringify({ result, value, submissions, events, probe, providerCalls, elapsedMs },
    (_key, value) => typeof value === 'string' && value.startsWith('data:image/') ? '[owned fixture screenshot omitted]' : value, 2));
  assert.equal(value, 'WebBrain QA', `Installed extension must dispatch the field despite unrelated updates: ${JSON.stringify(result)}`);
  const fieldResult = events.find(event => event.type === 'tool_result' && event.data?.name === 'set_field')?.data?.result;
  assert.equal(fieldResult?.success, true, JSON.stringify(fieldResult));
  if (fullForm) {
    assert.equal(submissions.length, 1, JSON.stringify(events.filter(event => event.type === 'tool_result')));
    assert.deepEqual(submissions[0], { name: 'WebBrain QA', email: 'qa-audit@picment.xyz', plan: batchComparison ? 'standard' : 'pro', message: 'Passive update verification.' });
    assert.match(await page.locator('#result').textContent(), /recorded/);
    const doneResult = result.updates.findLast(event => event.type === 'tool_result' && event.data?.name === 'done')?.data?.result;
    assert.equal(doneResult?.done, true, JSON.stringify(doneResult));
    assert.equal(doneResult?.outcome, 'success', JSON.stringify(doneResult));
    assert.notEqual(doneResult?.success, false, JSON.stringify(doneResult));
    assert.equal(events.findLast(event => event.type === 'run_complete')?.data?.status, 'completed');
    assert.equal(result.content, 'The owned form test is complete.');
    const evaluations = providerCalls.filter(call => String(call.messages?.[0]?.content || '').startsWith('Evaluate only the observable requirements of the genuine user task'));
    assert.ok(evaluations.length > 0, 'The installed completion evaluator must be exercised');
    for (const evaluation of evaluations) {
      const content = evaluation.messages.find(message => message.role === 'user')?.content;
      const state = JSON.parse(Array.isArray(content) ? content.find(block => block.type === 'text')?.text : content);
      assert.equal((Array.isArray(state) ? state[0] : state).task, text,
        'The completion evaluator must receive only the original user-authored task');
    }
  } else assert.equal(submissions.length, 0);
  if (browserBatch) {
    assert.equal(events.filter(event => event.type === 'tool_call' && event.data?.name === 'browser_batch').length, 1);
    assert.equal(events.filter(event => event.type === 'tool_result' && event.data?.name === 'browser_batch').length, 1);
    let observedBatchResult = false;
    for (const request of providerCalls) {
      const pending = new Set();
      for (const message of request.messages || []) {
        for (const call of message.tool_calls || []) {
          assert.ok(!call.id.includes('::'), 'Execution-only child IDs must never reach the provider.');
          pending.add(call.id);
        }
        if (message.role === 'tool') {
          assert.ok(pending.delete(message.tool_call_id), 'Every result must answer an original assistant call exactly once.');
          if (message.tool_call_id === 'mv3-0') observedBatchResult = true;
          assert.ok(!message.tool_call_id.includes('::'));
        } else if (message.role === 'user') {
          assert.equal(pending.size, 0, 'Supplemental user content must follow all tool results.');
        }
      }
      assert.equal(pending.size, 0);
    }
    assert.ok(observedBatchResult, 'The next model request must include the folded parent result.');
  }
  if (browserBatchDisabled) {
    assert.ok(providerCalls.every(request => !(request.tools || []).some(tool => tool.function?.name === 'browser_batch')));
    assert.ok(events.every(event => event.data?.name !== 'browser_batch'));
  }
  console.log(JSON.stringify({ passed: true, fullForm, browserBatch, browserBatchDisabled, elapsedMs, actionCalls, fieldResult, providerCalls: providerCalls.length, submitted: submissions.length, passiveTicks: await page.evaluate(() => counterTicks) }));
} finally {
  await context?.close(); await new Promise(resolve => server.close(resolve));
  const resolved = path.resolve(profile);
  if (!resolved.startsWith(path.resolve(os.tmpdir()) + path.sep + 'webbrain-integration-mv3-')) throw new Error('Unexpected temporary profile path.');
  await fs.rm(resolved, { recursive: true, force: true });
}
