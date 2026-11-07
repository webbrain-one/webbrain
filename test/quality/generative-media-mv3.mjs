import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { chromium } from 'playwright';

// An installed extension, its real native side panel and the production Agent.
// Only the remote media HTTP transport is redirected to an owned loopback API.
// No GPU, credentials, external provider, Agent mocks or personal profile.
const out = path.resolve(process.env.WEBBRAIN_QUALITY_ARTIFACTS || 'ci/artifacts/quality-audit-2026-10-07/generative-media-mv3');
await fs.mkdir(out, { recursive: true });
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, label, timeout = 30_000) {
  const end = Date.now() + timeout;
  do { const result = await check(); if (result) return result; await sleep(50); } while (Date.now() < end);
  throw new Error(`Timed out: ${label}`);
}
function png(seed) {
  const width = 128, height = 128, data = Buffer.alloc((width * 4 + 1) * height);
  let value = seed;
  for (let y = 0; y < height; y++) for (let x = 0; x < width * 4; x++) {
    value = (Math.imul(value, 1664525) + 1013904223) >>> 0;
    data[y * (width * 4 + 1) + x + 1] = x % 4 === 3 ? 255 : value >>> 24;
  }
  const crc = bytes => { let n = 0xffffffff; for (const byte of bytes) { n ^= byte; for (let bit = 0; bit < 8; bit++) n = (n >>> 1) ^ ((n & 1) ? 0xedb88320 : 0); } return (n ^ 0xffffffff) >>> 0; };
  const chunk = (kind, bytes) => { const type = Buffer.from(kind), size = Buffer.alloc(4), sum = Buffer.alloc(4); size.writeUInt32BE(bytes.length); sum.writeUInt32BE(crc(Buffer.concat([type, bytes]))); return Buffer.concat([size, type, bytes, sum]); };
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(data)), chunk('IEND', Buffer.alloc(0))]);
}
const assets = { hosted: png(1), inline: png(2), newer: png(3), cancelled: png(4) };
const prompts = { hosted: 'Owned Comfy icon: Türkçe ıİşŞğĞüÜöÖçÇ.', inline: 'Owned inline icon: quotes "and" newline\nnext line.', cancelled: 'Owned cancelled job. Must not be displayed.', newer: 'Owned newer request on tab B.' };
const workflow = { '6': { class_type: 'CLIPTextEncode', inputs: { text: '{{prompt}}' } }, '9': { class_type: 'SaveImage', inputs: { images: ['6', 0], filename_prefix: 'owned-media-{{prompt}}' } } };
const jobs = [], cancellations = [], views = [], providerCalls = [], events = [], errors = [], attachments = [];
let activeCase = null, releaseLateHistory = null, lateHistoryResponded = false, context, attached, panel, harness, worker, server, profile;
let extensionId, tabA, tabB;
const summary = { passed: false, cases: [], assetSha256: Object.fromEntries(Object.entries(assets).map(([key, value]) => [key, sha(value)])), externalRequests: [] };
const workerLifecycle = { versionEvents: [], stopRequest: null, stopAcknowledgement: null, bootSamples: [] };
function recordOwnedWorkerVersion(entry) {
  if (typeof entry.scriptURL !== 'string' || !entry.scriptURL.startsWith('chrome-extension://' + extensionId + '/')) return;
  const transition = { index: workerLifecycle.versionEvents.length, at: Date.now(), monotonicMs: performance.now(), versionId: entry.versionId, registrationId: entry.registrationId, scriptURL: entry.scriptURL, targetId: entry.targetId, runningStatus: entry.runningStatus, status: entry.status };
  workerLifecycle.versionEvents.push(transition);
  const requested = workerLifecycle.stopRequest;
  if (!workerLifecycle.stopAcknowledgement && requested && transition.index >= requested.eventCursor && transition.monotonicMs >= requested.monotonicMs && transition.versionId === requested.versionId && transition.runningStatus === 'stopped') workerLifecycle.stopAcknowledgement = transition;
}
const json = (response, value) => { response.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }); response.end(JSON.stringify(value)); };
async function requestBody(request) { let text = ''; for await (const chunk of request) text += chunk; return text ? JSON.parse(text) : null; }
server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url, 'http://127.0.0.1');
    if (url.pathname === '/prompt') {
      const input = await requestBody(request), text = input.prompt?.['6']?.inputs?.text;
      const kind = Object.keys(prompts).find(key => prompts[key] === text);
      assert.ok(kind && kind !== 'inline', 'ComfyUI must receive only an exact owned prompt.');
      assert.deepEqual(input.prompt, { '6': { class_type: 'CLIPTextEncode', inputs: { text: prompts[kind] } }, '9': { class_type: 'SaveImage', inputs: { images: ['6', 0], filename_prefix: `owned-media-${prompts[kind]}` } } });
      assert.match(input.client_id, /^[\da-f-]{36}$/i);
      const job = { id: `owned_job_${jobs.length + 1}`, kind, polls: 0, clientId: input.client_id, prompt: input.prompt };
      jobs.push(job); json(response, { prompt_id: job.id }); return;
    }
    if (url.pathname.startsWith('/history/')) {
      const job = jobs.find(item => item.id === url.pathname.slice('/history/'.length)); assert.ok(job);
      job.polls++;
      if (job.kind === 'cancelled') {
        await new Promise(resolve => { releaseLateHistory = resolve; });
        lateHistoryResponded = true;
      } else if (job.polls === 1) { json(response, {}); return; }
      json(response, { [job.id]: { status: { completed: true, status_str: 'success' }, outputs: { '9': { images: [{ filename: `${job.kind}.png`, subfolder: 'owned', type: 'output' }] } } } }); return;
    }
    if (url.pathname === '/queue') { const input = await requestBody(request); assert.deepEqual(Object.keys(input), ['delete']); cancellations.push(input); json(response, {}); return; }
    if (url.pathname === '/interrupt') throw new Error('Stop must not interrupt somebody else\'s workflow.');
    if (url.pathname === '/view') {
      const kind = url.searchParams.get('filename')?.replace(/\.png$/, ''); assert.ok(assets[kind] && kind !== 'inline');
      assert.equal(url.searchParams.get('subfolder'), 'owned'); assert.equal(url.searchParams.get('type'), 'output');
      views.push(kind); response.writeHead(200, { 'Content-Type': 'image/png', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' }); response.end(assets[kind]); return;
    }
    if (url.pathname === '/inline/images/models') { json(response, { data: [{ id: 'owned-inline-image' }] }); return; }
    if (url.pathname === '/inline/images') {
      const input = await requestBody(request); assert.deepEqual(input, { model: 'owned-inline-image', prompt: prompts.inline });
      summary.inlineSubmissions = (summary.inlineSubmissions || 0) + 1;
      response.writeHead(200, { 'Content-Type': 'image/png' }); response.end(assets.inline); return;
    }
    if (url.pathname === '/v1/models') { json(response, { data: [{ id: 'owned/media-fixture' }] }); return; }
    if (url.pathname === '/v1/chat/completions') {
      const input = await requestBody(request), action = Array.isArray(input.tools) && input.tools.length > 0;
      const evaluation = String(input.messages?.[0]?.content || '').startsWith('Evaluate only the observable requirements of the genuine user task');
      providerCalls.push({ kind: activeCase?.kind, action, evaluation, names: input.tools?.map(tool => tool.function.name) || [] });
      let message;
      if (evaluation) message = { role: 'assistant', content: JSON.stringify({ outcome: 'succeeded', reason: 'The owned generation API returned the requested output, independently recorded by this fixture.' }) };
      else if (!action) message = { role: 'assistant', content: JSON.stringify({ request_kind: 'execute', scope_relation: 'new', deliverables: ['Generate exactly one owned media output'], expected_items: null, requires_state_change: true, requires_submission: false, messaging: null, completion_requirements: { download: false }, allows_planner_shaped_result: false, allows_app_state_tool_evidence: true, read_scope: 'visible_page', summary: 'Generate exactly one media output and show its save link.', steps: [{ id: '1', action: 'Generate the requested owned image.' }], memory: { use_progress_ledger: false, progress_action: null }, scheduling: null, risks: [] }) };
      else {
        assert.ok(activeCase, 'An action request belongs to a started owned task.');
        const step = activeCase.actionCount++;
        assert.ok(step < 8, 'Media completion must not loop indefinitely.');
        // Respect real completion freshness fences. A pending verdict can
        // temporarily expose only observation tools; inspect without replaying
        // the already successful (and potentially costly) generation.
        const canFinish = input.tools.some(tool => tool.function.name === 'done');
        const call = step === 0 ? { name: 'generate_image', arguments: JSON.stringify({ prompt: prompts[activeCase.kind] }) }
          : canFinish ? { name: 'done', arguments: JSON.stringify({ summary: `Owned ${activeCase.kind} media generation complete.`, outcome: 'success' }) }
            : { name: 'get_accessibility_tree', arguments: JSON.stringify({ maxChars: 5500 }) };
        if (step > 0 && !canFinish) summary.readonlyFreshnessRecoveries = (summary.readonlyFreshnessRecoveries || 0) + 1;
        assert.ok(input.tools.some(tool => tool.function.name === call.name), `${call.name} must be advertised by the actual Agent.`);
        message = { role: 'assistant', content: '', tool_calls: [{ id: `owned-media-${activeCase.kind}-${step}`, type: 'function', function: call }] };
      }
      json(response, { id: `owned-completion-${providerCalls.length}`, choices: [{ message, finish_reason: action ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 30 } }); return;
    }
    if (url.pathname === '/system_stats') { json(response, { system: { os: 'owned' }, devices: [] }); return; }
    response.writeHead(200, { 'Content-Type': 'text/html' }); response.end('<!doctype html><title>Owned media fixture</title><h1>Owned media fixture</h1><p>No form, messaging or external side effects.</p>');
  } catch (error) { errors.push(error.message); if (!response.headersSent) response.writeHead(500); response.end(error.message); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const tmpRoot = await fs.realpath(os.tmpdir());
profile = await fs.mkdtemp(path.join(tmpRoot, 'webbrain-media-mv3-'));
const extension = path.join(profile, 'owned-extension');
async function message(action, data = {}) { return harness.evaluate(({ action, data }) => chrome.runtime.sendMessage({ target: 'background', action, ...data }), { action, data }); }
async function currentEvents() { return harness.evaluate(() => window.mediaEvents); }
async function caseFinished(kind, tabId) {
  return until(async () => (await currentEvents()).findLast(event => event.tabId === tabId && event.type === 'run_complete' && event.at >= activeCase.startedAt), `${kind} terminal run`, 30_000);
}
async function configure(kind) {
  await harness.evaluate(({ kind, base, workflow }) => chrome.storage.local.set({ imageGenModel: kind === 'inline'
    ? { provider: 'openrouter', apiKey: 'owned-inline-not-a-real-key', model: 'owned-inline-image' }
    : { provider: 'comfyui', baseUrl: base, workflow } }), { kind, base, workflow });
}
async function start(kind) {
  console.log(JSON.stringify({ phase: 'start', kind }));
  activeCase = { kind, actionCount: 0, startedAt: Date.now() };
  await configure(kind);
  // The side panel picks the mode per message (Automatic mode); /act runs this one in Act.
  await panel.locator('#user-input').fill(`/act Generate exactly one image for OWNED_MEDIA_${kind.toUpperCase()}. Show the generated result and its save link. Use this exact generation prompt: ${prompts[kind]}`);
  await panel.locator('#btn-send').click();
}
async function imageHash(selector) {
  return panel.locator(selector).evaluate(async image => {
    const response = await fetch(image.src), bytes = await response.arrayBuffer();
    const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(x => x.toString(16).padStart(2, '0')).join('');
    return { sha256: digest, bytes: bytes.byteLength, width: image.naturalWidth, height: image.naturalHeight };
  });
}
async function openNativePanel(tabId) {
  await harness.evaluate(tabId => {
    const old = document.querySelector('#owned-open-media-panel'); old?.remove();
    const button = document.createElement('button'); button.id = 'owned-open-media-panel'; button.textContent = 'Open owned native media side panel';
    button.onclick = async () => { try { await chrome.sidePanel.setOptions({ tabId, path: 'src/ui/sidepanel.html', enabled: true }); await chrome.sidePanel.open({ tabId }); window.mediaPanelOpen = 'ok'; } catch (error) { window.mediaPanelOpen = error.message; } };
    window.mediaPanelOpen = ''; document.body.append(button);
  }, tabId);
  await harness.locator('#owned-open-media-panel').click();
  await harness.waitForFunction(() => window.mediaPanelOpen);
  assert.equal(await harness.evaluate(() => window.mediaPanelOpen), 'ok');
  // Playwright's initial browser connection does not auto-attach newly opened
  // Chrome side-panel targets. Reconnect after the native per-tab panel opens;
  // select its visible document instead of an earlier tab's hidden panel.
  const port = (await fs.readFile(path.join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0];
  attached = await chromium.connectOverCDP(`http://127.0.0.1:${port}`); attachments.push(attached);
  panel = await visibleNativePanel();
  await panel.locator('#user-input').waitFor();
  if (await panel.locator('#pin-coachmark').isVisible()) await panel.locator('#pin-coachmark-skip').click();
  await until(() => panel.locator('#btn-send').isEnabled(), 'real composer initialization');
}
async function visibleNativePanel() {
  return until(async () => {
    for (const page of attached.contexts()[0].pages().filter(page => page.url() === `chrome-extension://${extensionId}/src/ui/sidepanel.html`)) {
      // Headless Chrome reports retained per-tab panel documents as visible
      // even when they are not composited. Only the currently shown panel
      // receives animation frames, which are also required by native clicks.
      const rendered = await Promise.race([
        page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => resolve(document.visibilityState === 'visible')))).catch(() => false),
        sleep(500).then(() => false),
      ]);
      if (rendered) return page;
    }
    return null;
  }, 'the actual visible native side panel target');
}
try {
  await fs.cp(path.resolve('src/chrome'), extension, { recursive: true });
  const guard = `const nativeFetch = globalThis.fetch.bind(globalThis);\nglobalThis.__ownedMediaBoot = crypto.randomUUID();\nglobalThis.__ownedMediaBlocked = [];\nglobalThis.fetch = (input, options) => { const url = new URL(typeof input === 'string' ? input : input.url); if (url.origin === 'https://openrouter.ai' && ['/api/v1/images/models', '/api/v1/images'].includes(url.pathname)) return nativeFetch(${JSON.stringify(base)} + '/inline' + url.pathname.slice('/api/v1'.length), options); if (url.hostname === '127.0.0.1' || ['chrome-extension:', 'data:', 'blob:'].includes(url.protocol)) return nativeFetch(input, options); globalThis.__ownedMediaBlocked.push(url.origin); return Promise.reject(new Error('Owned media fixture blocks external network.')); };\n`;
  await fs.writeFile(path.join(extension, 'src/quality-media-network.js'), guard);
  const backgroundFile = path.join(extension, 'src/background.js');
  await fs.writeFile(backgroundFile, `import './quality-media-network.js';\n${await fs.readFile(backgroundFile, 'utf8')}`);
  context = await chromium.launchPersistentContext(profile, { headless: true, channel: 'chromium', acceptDownloads: true,
    viewport: { width: 1280, height: 1000 }, args: ['--remote-debugging-port=0', `--disable-extensions-except=${extension}`, `--load-extension=${extension}`, '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1'] });
  await context.route('**/*', route => { const url = new URL(route.request().url()); return url.hostname === '127.0.0.1' || ['chrome-extension:', 'data:', 'blob:'].includes(url.protocol) ? route.continue() : route.abort('blockedbyclient'); });
  worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker', { timeout: 30_000 }); extensionId = new URL(worker.url()).host;
  harness = await context.newPage(); await harness.goto(`chrome-extension://${extensionId}/src/ui/settings.html`);
  await harness.evaluate(async () => {
    window.mediaEvents = [];
    chrome.runtime.onMessage.addListener(event => { if (event.action === 'agent_update') mediaEvents.push({ type: event.type, tabId: event.tabId, requestId: event.requestId, at: Date.now(), data: event.data }); });
    await chrome.storage.local.set({ onboardingComplete: true, pinCoachmarkComplete: true, helpImproveWebBrain: false, planBeforeActMode: 'off', planBeforeAct: false, planReviewMode: 'never', screenshotFallback: false, autoScreenshot: false, maxAgentSteps: 8, systemOneEnabled: false, tracingEnabled: false, agentAllowLocalNetwork: true, askBeforeConsequentialActions: false, openaiAskStreamingEnabled: false, language: 'en' });
  });
  assert.equal((await message('update_provider', { providerId: 'openrouter', config: { apiKey: 'owned-local-llm-not-a-real-key', baseUrl: `${base}/v1`, model: 'owned/media-fixture', contextWindow: 1_000_000, enabled: true, supportsAskStreaming: false } })).ok, true);
  assert.equal((await message('set_active_provider', { providerId: 'openrouter' })).ok, true);
  const pageA = await context.newPage(); await pageA.goto(`${base}/fixture-a`);
  tabA = await harness.evaluate(async url => (await chrome.tabs.query({})).find(tab => tab.url === url)?.id, pageA.url()); assert.ok(tabA);
  await openNativePanel(tabA);
  const panelA = panel;
  console.log(JSON.stringify({ phase: 'native-panel-ready' }));

  await start('hosted');
  let terminal = await caseFinished('hosted', tabA); assert.equal(terminal.data.status, 'completed', JSON.stringify(terminal));
  await panel.locator('.generated-media img').waitFor(); await until(() => panel.locator('.generated-media img').evaluate(img => img.naturalWidth > 0), 'hosted preview decoding');
  assert.deepEqual(await imageHash('.generated-media img'), { sha256: sha(assets.hosted), bytes: assets.hosted.length, width: 128, height: 128 });
  assert.equal(jobs.length, 1); assert.equal(jobs[0].polls, 2); assert.equal(cancellations.length, 0);
  const hostedLink = await panel.locator('.generated-media a').getAttribute('href'); assert.match(hostedLink, /\/view\?filename=hosted\.png&subfolder=owned&type=output$/);
  const popupPromise = attached.contexts()[0].waitForEvent('page'); await panel.locator('.generated-media a').click(); const popup = await popupPromise; await popup.waitForLoadState();
  assert.equal(sha(Buffer.from(await popup.evaluate(async () => Array.from(new Uint8Array(await (await fetch(location.href)).arrayBuffer()))))), sha(assets.hosted)); await popup.close();
  await panel.reload(); await panel.locator('.generated-media img').waitFor();
  assert.equal((await imageHash('.generated-media img')).sha256, sha(assets.hosted));
  summary.cases.push({ name: 'hosted-comfy-queue-poll-panel-reopen-save', passed: true, queued: 1, polls: 2, bytes: assets.hosted.length });

  await start('inline'); terminal = await caseFinished('inline', tabA); assert.equal(terminal.data.status, 'completed', JSON.stringify(terminal));
  const inline = panel.locator('.generated-media[data-media-id]'); await inline.locator('img').waitFor();
  const mediaId = await inline.getAttribute('data-media-id'); assert.match(mediaId, /^[\da-f-]{36}$/i);
  await until(() => inline.locator('img').evaluate(img => img.naturalWidth > 0), 'stored inline preview decoding');
  assert.deepEqual(await imageHash('.generated-media[data-media-id] img'), { sha256: sha(assets.inline), bytes: assets.inline.length, width: 128, height: 128 });
  assert.equal(summary.inlineSubmissions, 1); assert.equal(jobs.length, 1);
  const downloadDirectory = path.join(profile, 'owned-downloads'); await fs.mkdir(downloadDirectory);
  const cdp = await context.newCDPSession(harness); await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloadDirectory, eventsEnabled: true });
  await inline.locator('a').click(); await until(async () => (await fs.readdir(downloadDirectory)).includes('webbrain-media.png'), 'native Save output download');
  assert.equal(sha(await fs.readFile(path.join(downloadDirectory, 'webbrain-media.png'))), sha(assets.inline));
  await panel.reload(); await panel.locator(`.generated-media[data-media-id="${mediaId}"] img`).waitFor();
  await until(() => panel.locator('.generated-media[data-media-id] img').evaluate(img => img.naturalWidth > 0), 'rehydrated inline image after panel reload');
  assert.equal((await imageHash('.generated-media[data-media-id] img')).sha256, sha(assets.inline));
  const versions = new Map(); cdp.on('ServiceWorker.workerVersionUpdated', ({ versions: entries }) => entries.forEach(entry => { versions.set(entry.versionId, entry); recordOwnedWorkerVersion(entry); }));
  await cdp.send('ServiceWorker.enable'); const version = await until(() => [...versions.values()].find(entry => entry.runningStatus === 'running' && entry.scriptURL.startsWith(`chrome-extension://${extensionId}/`)), 'owned worker native version');
  const oldBoot = await worker.evaluate(() => globalThis.__ownedMediaBoot);
  assert.match(oldBoot, /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i, 'Original heap must expose its native boot UUID.');
  workerLifecycle.bootSamples.push({ phase: 'before native stop', at: Date.now(), SHA256: sha(oldBoot), validUUID: true });
  workerLifecycle.stopRequest = { at: Date.now(), monotonicMs: performance.now(), versionId: version.versionId, scriptURL: version.scriptURL, eventCursor: workerLifecycle.versionEvents.length };
  await cdp.send('ServiceWorker.stopWorker', { versionId: version.versionId });
  workerLifecycle.stopRequest.returnedAt = Date.now(); workerLifecycle.stopRequest.latestStatusAtReturn = versions.get(version.versionId)?.runningStatus ?? null;
  await until(() => workerLifecycle.stopAcknowledgement, 'actual worker stopped');
  workerLifecycle.stopWaitResolved = { at: Date.now(), monotonicMs: performance.now(), latestRequestedVersionStatus: versions.get(version.versionId)?.runningStatus ?? null };
  await message('get_providers'); await until(() => [...versions.values()].some(entry => entry.runningStatus === 'running' && entry.scriptURL.startsWith(`chrome-extension://${extensionId}/`)), 'actual worker restarted');
  worker = context.serviceWorkers().find(current => current.url().startsWith(`chrome-extension://${extensionId}/`)) || worker;
  const freshBoot = await worker.evaluate(() => globalThis.__ownedMediaBoot);
  assert.match(freshBoot, /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i, 'Restarted heap must expose its native boot UUID.');
  workerLifecycle.bootSamples.push({ phase: 'after native restart', at: Date.now(), SHA256: sha(freshBoot), validUUID: true });
  assert.notEqual(freshBoot, oldBoot);
  await panel.reload(); await panel.locator(`.generated-media[data-media-id="${mediaId}"] img`).waitFor();
  await until(() => panel.locator('.generated-media[data-media-id] img').evaluate(img => img.naturalWidth > 0), 'rehydrated inline image after worker restart');
  assert.equal((await imageHash('.generated-media[data-media-id] img')).sha256, sha(assets.inline));
  assert.equal(summary.inlineSubmissions, 1, 'Panel/worker reopen must not generate again.');
  const storedHtml = await message('load_tab_chat', { tabId: tabA }); assert.ok(storedHtml.html.includes(mediaId)); assert.ok(!storedHtml.html.includes('data:image/png;base64,'), 'Inline bytes stay out of the serialized panel chat.');
  summary.cases.push({ name: 'inline-agent-idb-save-panel-and-worker-restart', passed: true, mediaId, bytes: assets.inline.length, generations: 1, workerRestarts: 1 });

  await start('cancelled'); await until(() => jobs.some(job => job.kind === 'cancelled') && releaseLateHistory, 'queued in-flight Comfy history request');
  const cancelledJob = jobs.find(job => job.kind === 'cancelled'); await panel.locator('#user-input').fill('Unsent draft A: keep this literal text.');
  await panel.locator('#btn-stop').click(); terminal = await caseFinished('cancelled', tabA); assert.equal(terminal.data.status, 'stopped', JSON.stringify(terminal));
  await until(() => cancellations.length === 1, 'Stop cancels only its owned prompt'); assert.deepEqual(cancellations, [{ delete: [cancelledJob.id] }]);
  assert.equal(await panel.locator('#user-input').inputValue(), 'Unsent draft A: keep this literal text.');
  const pageB = await context.newPage(); await pageB.goto(`${base}/fixture-b`); tabB = await harness.evaluate(async url => (await chrome.tabs.query({})).find(tab => tab.url === url)?.id, pageB.url()); assert.ok(tabB);
  await openNativePanel(tabB); await until(() => panel.locator('.generated-media').count().then(count => count === 0), 'tab B has no foreign assets');
  await panel.locator('#user-input').fill('Unsent draft B: not a generation request.'); await sleep(150);
  assert.equal(await panel.locator('.generated-media').count(), 0); assert.equal(await panel.locator('#user-input').inputValue(), 'Unsent draft B: not a generation request.');
  await start('newer'); await until(() => jobs.some(job => job.kind === 'newer'), 'newer owned request queued');
  await panel.locator('#user-input').fill('Newer unsent draft B: preserve after completion.'); releaseLateHistory();
  terminal = await caseFinished('newer', tabB); assert.equal(terminal.data.status, 'completed', JSON.stringify(terminal));
  await panel.locator('.generated-media img').waitFor(); assert.equal((await imageHash('.generated-media img')).sha256, sha(assets.newer));
  assert.equal(await panel.locator('.generated-media').count(), 1); assert.equal(await panel.locator('#user-input').inputValue(), 'Newer unsent draft B: preserve after completion.');
  assert.ok(lateHistoryResponded); assert.ok(!views.includes('cancelled')); assert.equal(jobs.filter(job => job.kind === 'cancelled').length, 1); assert.equal(jobs.filter(job => job.kind === 'newer').length, 1);
  // Headless Chromium can render animation frames for both tab-specific panel
  // documents. Reuse tab A's actual panel instead of selecting the first one.
  await harness.evaluate(tabId => chrome.tabs.update(tabId, { active: true }), tabA); panel = panelA; await until(() => panel.locator('.generated-media').count().then(count => count === 2), 'original tab retains only its two finished assets');
  assert.equal(await panel.locator('#user-input').inputValue(), 'Unsent draft A: keep this literal text.');
  const allEvents = await currentEvents();
  assert.ok(!allEvents.some(event => event.tabId === tabA && event.type === 'tool_result' && event.data?.name === 'generate_image' && event.data?.result?.url?.includes('cancelled.png')));
  summary.cases.push({ name: 'stop-inflight-queue-late-result-newer-tab-and-draft-ownership', passed: true, cancelCalls: 1, cancelledGenerations: 1, newerGenerations: 1, cancelledAssetPublished: false });
  summary.externalRequests = await worker.evaluate(() => globalThis.__ownedMediaBlocked);
  assert.deepEqual(errors, []); summary.passed = true;
  console.log(JSON.stringify({ passed: true, cases: summary.cases, comfyJobs: jobs.length, inlineSubmissions: summary.inlineSubmissions, cancellationCalls: cancellations.length }));
} catch (error) {
  summary.error = error.stack || error.message;
  workerLifecycle.failure = { at: Date.now(), monotonicMs: performance.now(), latestRequestedVersionStatus: workerLifecycle.versionEvents.findLast(event => event.versionId === workerLifecycle.stopRequest?.versionId)?.runningStatus ?? null };
  if (panel) { await panel.screenshot({ path: path.join(out, 'failure.png'), timeout: 5000 }).catch(() => {}); summary.panelText = (await panel.locator('#messages').innerText({ timeout: 5000 }).catch(() => '')).slice(-7000); }
  throw error;
} finally {
  releaseLateHistory?.();
  if (harness) events.push(...await currentEvents().catch(() => []));
  await fs.writeFile(path.join(out, 'evidence.json'), JSON.stringify({ summary, workerLifecycle, jobs, cancellations, views, providerCalls, events, serverErrors: errors }, (key, value) => typeof value === 'string' && value.startsWith('data:') ? '[owned media bytes omitted]' : value, 2));
  for (const browser of attachments.reverse()) await browser.close().catch(() => {});
  await context?.close().catch(() => {}); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  const resolved = await fs.realpath(profile); if (path.dirname(resolved) !== tmpRoot || !path.basename(resolved).startsWith('webbrain-media-mv3-')) throw new Error('Refusing unsafe temporary-profile cleanup.');
  await fs.rm(resolved, { recursive: true, force: true });
}
