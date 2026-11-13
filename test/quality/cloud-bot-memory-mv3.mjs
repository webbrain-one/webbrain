import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { chromium } from 'playwright';
import { fixtureFixedChoiceReply } from '../semantic-decision-stub.mjs';

// Installed production Cloud controller, Agent, content scripts, monitor and
// native CDP click. Only model responses and the authenticated owned callback
// ledger are deterministic; no production Cloud/browser service is contacted.
const out = path.resolve(process.env.WEBBRAIN_QUALITY_ARTIFACTS || 'ci/artifacts/quality-audit-2026-10-12/cloud-bot-memory-mv3');
await fs.mkdir(out, { recursive: true });
const payload = 'Owned memory record: exact spaces  and Turkish ıİşŞ 🧠.';
const target = { kind: 'id', namespace: '127.0.0.1:data-record-id', id: 'owned-record-42' };
const textOf = value => typeof value === 'string' ? value : Array.isArray(value)
  ? value.filter(part => part?.type === 'text').map(part => part.text || '').join('\n') : '';
function toolObject(content) {
  const text = textOf(content);
  for (let start = text.indexOf('{'); start >= 0; start = text.indexOf('{', start + 1)) {
    let depth = 0, quoted = false, escaped = false;
    for (let index = start; index < text.length; index++) {
      const char = text[index];
      if (quoted) { if (escaped) escaped = false; else if (char === '\\') escaped = true; else if (char === '"') quoted = false; }
      else if (char === '"') quoted = true;
      else if (char === '{') depth++;
      else if (char === '}' && --depth === 0) { try { return JSON.parse(text.slice(start, index + 1)); } catch { break; } }
    }
  }
  return null;
}
function latestTools(messages) {
  const names = new Map();
  for (const message of messages || []) for (const call of message.tool_calls || []) names.set(call.id, call.function?.name);
  return (messages || []).filter(message => message.role === 'tool')
    .map(message => ({ name: names.get(message.tool_call_id) || message.name, result: toolObject(message.content) }));
}
let current, context, order = 0;
const blocked = [], startupIntercepts = [], callbackCalls = [], saves = [], results = [], attempts = new Map(), envelopes = new Map();
const intent = { request_kind: 'execute', scope_relation: 'new', requires_state_change: true, requires_submission: true,
  messaging: null, deliverables: ['Save and verify the owned record exactly once.'], allows_planner_shaped_result: false,
  allows_app_state_tool_evidence: false, completion_requirements: { download: false }, read_scope: 'visible_page',
  summary: 'Save the owned form once and verify its persistent record.',
  steps: [{ id: '1', action: 'Observe the owned form, submit it once, then freshly read its saved record.' }],
  memory: { use_progress_ledger: false, progress_action: null }, scheduling: null, risks: [] };
const html = scenario => `<!doctype html><meta charset="utf-8"><title>Owned record memory QA</title>
<style>body{font:18px sans-serif;margin:40px}input,button{font:inherit;padding:12px;margin:10px;min-width:220px}</style>
<main><h1>Save owned record</h1><form method="post" action="/fixture/${scenario}/save" data-record-id="owned-record-42">
<label>Owned record contents<input name="payload" value="${payload}" readonly></label>
<button id="save" type="submit">Save owned record</button></form></main>
<script>document.querySelector('form').addEventListener('submit',event=>localStorage.setItem('owned-memory-submit-${scenario}',
JSON.stringify({trusted:event.isTrusted,submitter:event.submitter?.id,payload:document.querySelector('input').value})),true);</script>`;
const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url, 'http://127.0.0.1');
    let raw = ''; for await (const part of request) raw += part;
    if (url.pathname.startsWith('/api/internal/bot-memory/')) {
      const memory = envelopes.get(url.pathname.split('/').at(-1));
      assert.ok(memory, 'Callback must use the exact app-run scope.');
      assert.equal(request.headers.authorization, 'Bearer ' + memory.callbackToken, 'Callback authentication must be run scoped.');
      const { operation, args } = JSON.parse(raw);
      callbackCalls.push({ scenario: current.name, operation, args, order: ++order });
      if (current.fault === 'callback-unavailable' && operation === 'prepare') { response.writeHead(503).end(); return; }
      let value;
      if (operation === 'prepare') {
        assert.equal(args.tool.name, 'click_ax'); assert.equal(args.observation.elementFacts.found, true);
        const observed = args.observation.targets.find(item => JSON.stringify(item) === JSON.stringify(target));
        assert.deepEqual(observed, target, 'Reservation target must originate in actual selected form DOM.');
        const previous = [...attempts.values()].find(item => item.botId === memory.botId && item.status !== 'failed_before_dispatch');
        if (previous) value = { allowed: false, reason: previous.status === 'verified' ? 'duplicate' : 'uncertain', previous };
        else {
          const attempt = { id: randomUUID(), botId: memory.botId, runId: memory.runId, requestId: args.requestId,
            actionKey: 'save_record', target: observed, status: 'reserved', createdAt: Date.now() };
          attempts.set(attempt.id, attempt);
          value = { allowed: true, readOnly: false,
            reservation: { attemptId: attempt.id, requestId: args.requestId, actionKey: attempt.actionKey, target: observed } };
        }
      } else if (operation === 'dispatch') {
        const attempt = attempts.get(args.attemptId);
        assert.equal(attempt?.botId, memory.botId); assert.equal(attempt?.runId, memory.runId);
        assert.equal(attempt.requestId, args.requestId);
        if (attempt.status !== 'reserved') {
          // Native fetch can replay a connection-reset POST before exposing its
          // failure. The durable app ledger never acknowledges dispatch twice.
          response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ acknowledged: false, attempt: null })); return;
        }
        attempt.status = 'dispatched'; attempt.dispatchedAt = Date.now(); attempt.dispatchOrder = order;
        if (current.fault === 'lost-ack') { attempt.lostAcknowledgement = true; request.socket.destroy(); return; }
        value = { acknowledged: true, attempt };
      } else if (operation === 'verify') {
        const attempt = attempts.get(args.attemptId);
        assert.equal(attempt?.botId, memory.botId); assert.equal(args.evidence.source, 'runtime');
        assert.deepEqual(JSON.parse(args.evidence.facts.observedTarget), target);
        assert.ok(args.evidence.observedAt >= attempt.dispatchedAt);
        const saved = saves.find(item => item.botId === memory.botId);
        const verified = !!saved && args.evidence.facts.pageText.includes('Saved owned record')
          && args.evidence.facts.pageText.includes(payload) && args.evidence.url.endsWith('/record');
        if (verified) { attempt.status = 'verified'; attempt.verifyOrder = order; }
        value = { verified, status: attempt.status, attempt };
      } else if (operation === 'resolve') {
        const attempt = attempts.get(args.attemptId);
        assert.equal(attempt?.botId, memory.botId);
        assert.ok(['failed_before_dispatch', 'uncertain'].includes(args.status)); attempt.status = args.status;
        value = { status: attempt.status, attempt };
      } else throw new Error('Unexpected owned callback operation: ' + operation);
      response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(value)); return;
    }
    const fixture = /^\/fixture\/([^/]+)\/(edit|save|record)$/.exec(url.pathname);
    if (fixture) {
      const [, scenario, action] = fixture;
      if (action === 'edit') { response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(html(scenario)); return; }
      if (action === 'save') {
        assert.equal(request.method, 'POST'); assert.equal(scenario, current.name);
        const attempt = [...attempts.values()].find(item => item.botId === current.botId && item.status === 'dispatched');
        assert.ok(attempt, 'A durable dispatch acknowledgement must precede any real browser form POST.');
        const body = Object.fromEntries(new URLSearchParams(raw)); assert.deepEqual(body, { payload });
        saves.push({ scenario, botId: current.botId, body, order: ++order, attemptId: attempt.id });
        response.writeHead(303, { Location: `/fixture/${scenario}/record` }).end(); return;
      }
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(`<!doctype html><meta charset="utf-8">
<title>Saved owned record</title><main data-record-id="owned-record-42"><h1>Saved owned record</h1>
<div role="status">Owned record saved successfully</div><p style="white-space:pre-wrap">${payload}</p><a href="/fixture/${scenario}/record">Owned record receipt</a></main>`); return;
    }
    if (url.pathname === '/v1/chat/completions') {
      const input = JSON.parse(raw), system = textOf(input.messages?.[0]?.content);
      current.requests++;
      // WebBrain reads short page texts (the record page's saved notice) with
      // fixed-choice questions that carry only those texts, not the task.
      const fixedChoice = fixtureFixedChoiceReply(input.messages);
      if (fixedChoice) {
        assert.equal(JSON.stringify(input.messages).includes(current.memory.callbackToken), false);
        response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ id: 'owned-memory-model',
          choices: [{ message: { role: 'assistant', content: fixedChoice }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 100, completion_tokens: 30 } })); return;
      }
      assert.ok(JSON.stringify(input.messages).includes(current.marker), 'The actual Agent must retain the owned task.');
      assert.equal(JSON.stringify(input.messages).includes(current.memory.callbackToken), false);
      assert.equal(JSON.stringify(input.messages).includes(current.memory.callbackUrl), false);
      let completion;
      if (system.startsWith('Evaluate only the observable requirements of the genuine user task'))
        completion = { role: 'assistant', content: JSON.stringify({ outcome: 'uncertain', reason: 'Require actual saved page and native submission proof.' }) };
      else if (!input.tools?.length) completion = { role: 'assistant', content: JSON.stringify(intent) };
      else {
        const step = current.steps++, tools = latestTools(input.messages), last = tools.at(-1);
        let call;
        if (step === 0) call = { name: 'get_accessibility_tree', args: { filter: 'all' } };
        else if (step === 1) {
          const tree = tools.findLast(item => item.name === 'get_accessibility_tree')?.result?.pageContent;
          const ref = String(tree).split('\n').find(line => /button "Save owned record"/.test(line))?.match(/\[(ref_\d+)\]/)?.[1];
          assert.ok(ref, String(tree)); call = { name: 'click_ax', args: { ref_id: ref } };
        } else if (step === 2) {
          current.clickResult = tools.findLast(item => item.name === 'click_ax')?.result;
          if (current.positive) await current.page.waitForURL('**/record', { timeout: 15000 });
          call = { name: 'get_accessibility_tree', args: { filter: 'all' } };
        } else {
          assert.equal(last?.name, 'get_accessibility_tree');
          call = { name: 'done', args: { outcome: current.positive ? 'success' : 'partial',
            summary: current.positive ? 'The owned record was saved once and freshly verified.' : 'Memory withheld the browser write; no new record was submitted.' } };
        }
        current.calls.push(call);
        completion = { role: 'assistant', content: '', tool_calls: [{ id: `owned-memory-${current.name}-${step}`,
          type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args) } }] };
      }
      response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ id: 'owned-memory-model',
        choices: [{ message: completion, finish_reason: completion.tool_calls ? 'tool_calls' : 'stop' }],
        usage: { prompt_tokens: 100, completion_tokens: 30 } })); return;
    }
    response.writeHead(404).end();
  } catch (error) {
    if (current) current.serverError = error.stack;
    if (!response.headersSent) response.writeHead(500, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ error: error.message }));
  }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'webbrain-cloud-memory-mv3-'));
try {
  const extension = path.join(profile, 'extension'); await fs.cp(path.resolve('src/chrome'), extension, { recursive: true });
  const sourceSha256 = Object.fromEntries(await Promise.all(['cloud-runs.js', 'agent/agent.js', 'agent/bot-memory.js', 'offscreen/cloud-bridge.js']
    .map(async file => [file, createHash('sha256').update(await fs.readFile(path.join(extension, 'src', file))).digest('hex')])));
  await fs.appendFile(path.join(extension, 'src/background.js'), '\nglobalThis.ownedCloudMemoryController = cloudRunController;\n');
  context = await chromium.launchPersistentContext(profile, { headless: true, channel: 'chromium', viewport: { width: 1280, height: 900 },
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`,
      '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1'] });
  const fromSettingsPage = request => {
    try {
      if (request.serviceWorker()) return false;
      const page = new URL(request.frame().url());
      return page.protocol === 'chrome-extension:' && page.pathname === '/src/ui/settings.html';
    } catch { return false; }
  };
  await context.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.origin === origin || url.protocol === 'chrome-extension:') return route.continue();
    if (url.origin === 'http://127.0.0.1:8327' && route.request().method() === 'GET'
        && ['/v1/models', '/models'].includes(url.pathname)) {
      // Keep automatic Companion discovery inside this disposable fixture.
      startupIntercepts.push(url.href); return route.fulfill({ status: 503, contentType: 'application/json', body: '{}' });
    }
    if (url.origin === 'https://webbrain.one' && route.request().method() === 'GET'
        && (route.request().isNavigationRequest() || url.pathname === '/apocalypse-comm.html')) {
      // Fresh installs and Settings can request welcome/announcement pages.
      // Supply wholly owned inert data so startup has no external contact.
      startupIntercepts.push(url.href); return route.fulfill({ contentType: 'text/html', body: '<title>Owned startup placeholder</title>' });
    }
    if (url.origin === 'https://api.webbrain.one' && url.pathname === '/v1/billing/status'
        && route.request().method() === 'GET' && fromSettingsPage(route.request())) {
      // Providers now live on the Settings page this fixture uses as its
      // message bridge, and it checks the selected WebBrain Compass
      // provider's billing status while it loads. Answer only that page,
      // with an inert status, so startup has no external contact.
      startupIntercepts.push(url.href); return route.fulfill({ status: 200, contentType: 'application/json', body: '{"subscription_status":"active"}' });
    }
    blocked.push({ origin: url.origin, path: url.pathname, type: route.request().resourceType(), method: route.request().method() }); return route.abort('blockedbyclient');
  });
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker', { timeout: 30000 });
  await worker.evaluate(() => {
    const native = fetch.bind(globalThis); globalThis.ownedMemoryBlocked = [];
    globalThis.fetch = (input, options) => {
      const url = new URL(typeof input === 'string' ? input : input.url);
      if (url.hostname === '127.0.0.1' || ['chrome-extension:', 'data:', 'blob:'].includes(url.protocol)) return native(input, options);
      ownedMemoryBlocked.push({ origin: url.origin }); return Promise.reject(new Error('Owned memory fixture blocks external services.'));
    };
  });
  const harness = await context.newPage();
  await harness.goto(`chrome-extension://${new URL(worker.url()).host}/src/ui/settings.html`);
  // Let Settings finish loading before the fixture changes storage and the
  // active provider, so its startup requests do not race the setup below.
  await harness.waitForFunction(() => document.documentElement.dataset.settingsReady === 'true');
  const message = (action, data = {}) => harness.evaluate(({ action, data }) => chrome.runtime.sendMessage({ target: 'background', action, ...data }), { action, data });
  await harness.evaluate(() => chrome.storage.local.set({ helpImproveWebBrain: false, tracingEnabled: false,
    autoScreenshot: false, screenshotFallback: false, planBeforeActMode: 'off', planBeforeAct: false, planReviewMode: 'never',
    visionMode: 'off', maxAgentSteps: 8, systemOneEnabled: false, agentAllowLocalNetwork: true, askBeforeConsequentialActions: false,
    openaiAskStreamingEnabled: false }));
  assert.equal((await message('update_provider', { providerId: 'openrouter', config: { apiKey: 'owned-memory-fixture-key',
    baseUrl: origin + '/v1', model: 'minimax/minimax-m3', enabled: true, contextWindow: 1000000, supportsAskStreaming: false } })).ok, true);
  assert.equal((await message('set_active_provider', { providerId: 'openrouter' })).ok, true);
  for (const spec of [
    { name: 'verified', botId: 'owned-bot', positive: true },
    { name: 'duplicate', botId: 'owned-bot' },
    { name: 'callback_unavailable', botId: 'owned-failure-bot', fault: 'callback-unavailable' },
    { name: 'lost_ack', botId: 'owned-lost-ack-bot', fault: 'lost-ack' },
    { name: 'lost_ack_repeat', botId: 'owned-lost-ack-bot' },
  ]) {
    const page = await context.newPage(), url = `${origin}/fixture/${spec.name}/edit`;
    await page.goto(url); await page.waitForSelector('#save');
    const tabId = await harness.evaluate(async url => (await chrome.tabs.query({})).findLast(tab => tab.url === url)?.id, url);
    assert.ok(tabId);
    const runId = 'app-run-' + spec.name, callbackToken = 'owned-local-scoped-memory-token-' + runId;
    const memory = { version: 1, botId: spec.botId, runId, policyVersion: 1,
      callbackUrl: origin + '/api/internal/bot-memory/' + runId, callbackToken,
      policy: { schemaVersion: 1, summary: 'Save each owned record once', timezone: 'UTC', confidence: 1,
        actions: [{ key: 'save_record', label: 'Save record', target: 'Owned record', effect: 'write', repeat: { mode: 'unique' }, evidenceFields: [] }] },
      context: { document: null, recentActions: [], totalActions: attempts.size } };
    envelopes.set(runId, memory); current = { ...spec, page, memory, marker: `Owned memory QA ${spec.name}.`, steps: 0, requests: 0, calls: [] };
    const before = saves.length;
    const started = await message('cloud_run', { task: `${current.marker} Save the existing contents of owned record 42 exactly once using its form. Freshly verify the saved record before finishing.`,
      task_memory: memory, tabId, mode: 'act', providerId: 'openrouter', expectedModel: 'minimax/minimax-m3' });
    assert.ok(started.runId, JSON.stringify(started));
    let snapshot;
    for (let poll = 0; poll < 180; poll++) {
      snapshot = await message('cloud_status', { runId: started.runId });
      if (['completed', 'failed', 'aborted'].includes(snapshot.status)) break;
      await page.waitForTimeout(250);
    }
    const persisted = await worker.evaluate(() => chrome.storage.session.get('webbrainCloudRunSnapshots'));
    const native = await page.evaluate(scenario => JSON.parse(localStorage.getItem('owned-memory-submit-' + scenario) || 'null'), spec.name);
    const publicEvidence = { snapshot, persisted };
    for (const value of [memory.callbackToken, memory.callbackUrl, JSON.stringify(memory)])
      assert.equal(JSON.stringify(publicEvidence).includes(value), false, 'Private callback configuration cannot reach public/persisted Cloud output.');
    assert.equal(current.serverError, undefined, current.serverError);
    assert.equal(saves.length - before, spec.positive ? 1 : 0, JSON.stringify({ snapshot, calls: current.calls, callbacks: callbackCalls.filter(row => row.scenario === spec.name) }));
    if (spec.positive) {
      assert.deepEqual(native, { trusted: true, submitter: 'save', payload });
      const saved = saves.at(-1), attempt = attempts.get(saved.attemptId);
      assert.equal(attempt.status, 'verified'); assert.ok(attempt.dispatchOrder < saved.order && saved.order < attempt.verifyOrder);
      assert.equal(snapshot.status, 'completed', JSON.stringify(snapshot));
    } else {
      assert.equal(native, null); assert.equal(current.clickResult?.noDispatch, true, JSON.stringify(current.clickResult));
      assert.equal(current.clickResult?.dispatched, false); assert.notEqual(snapshot.status, 'completed');
    }
    results.push({ scenario: spec.name, snapshot, native, callbacks: callbackCalls.filter(row => row.scenario === spec.name),
      saves: saves.filter(row => row.scenario === spec.name), requests: current.requests, calls: current.calls });
    await page.close();
  }
  assert.equal(saves.length, 1);
  const uncertain = [...attempts.values()].find(row => row.botId === 'owned-lost-ack-bot');
  assert.equal(uncertain.status, 'dispatched'); assert.equal(uncertain.lostAcknowledgement, true);
  for (const scenario of ['duplicate', 'callback_unavailable', 'lost_ack_repeat'])
    assert.equal(callbackCalls.filter(row => row.scenario === scenario && row.operation === 'dispatch').length, 0);
  const external = await worker.evaluate(() => ownedMemoryBlocked); assert.deepEqual(external, []); assert.deepEqual(blocked, []);
  await fs.writeFile(path.join(out, 'evidence.json'), JSON.stringify({ passed: true, installedMV3: true, sourceSha256, results, saves, startupIntercepts,
    attempts: [...attempts.values()], externalRequests: blocked.length + external.length }, null, 2));
  console.log(JSON.stringify({ passed: true, installedMV3: true, cases: results.length, nativeSubmissions: saves.length, externalRequests: 0 }));
} catch (error) {
  await fs.writeFile(path.join(out, 'failure.json'), JSON.stringify({ error: error.stack, scenario: current?.name,
    calls: current?.calls, serverError: current?.serverError, callbacks: callbackCalls, saves, results }, null, 2));
  throw error;
} finally {
  await context?.close(); await new Promise(resolve => server.close(resolve));
}
