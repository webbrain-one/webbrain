import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { build as bundle } from 'esbuild';
import { fixturePageTextReply } from '../semantic-decision-stub.mjs';

// Installed MV3 regression with a separately labelled scripted provider. The
// real background, Agent, monitor, side-panel Retry, native input and completion
// gates run unchanged. These owned social-shaped shells exercise unsupported
// generic controls. Actual ProseMirror model/view owns the managed editors;
// the full native social composer contracts are covered by their own suites.
const providerLabel = 'deterministic scripted provider; installed production runtime';
const out = path.resolve(process.env.WEBBRAIN_QUALITY_ARTIFACTS
  || 'ci/artifacts/quality-audit-2026-10-13/relaxed-monitoring-retry-mv3');
await fs.mkdir(out, { recursive: true });
const body = 'Owned retry draft: exact spaces  and Turkish ıİşŞğĞüÜöÖçÇ 🧠.';
const editorBundle = (await bundle({ entryPoints: [path.resolve('test/fixtures/bluesky-composer-editor.mjs')],
  bundle: true, write: false, format: 'iife', globalName: 'qaEditorLibrary', platform: 'browser' })).outputFiles[0].text;
const cases = [
  { name: 'generic_editor_menu', url: 'https://relaxed-monitoring.webbrain.invalid/editor', editorName: 'Owned draft', menuName: 'Formatting options' },
  { name: 'generic_preparation_editor_menu', url: 'https://relaxed-monitoring.webbrain.invalid/preparation-editor', editorName: 'Owned draft', menuName: 'Formatting options', preparationOnly: true },
  { name: 'generic_managed_editor_menu', url: 'https://relaxed-monitoring.webbrain.invalid/managed-editor', editorName: 'Owned draft', menuName: 'Formatting options', managed: true },
  { name: 'x_shaped_draft', url: 'https://x.com/home', editorName: 'Post text', menuName: 'Composer options', managed: true },
  { name: 'bluesky_shaped_draft', url: 'https://bsky.app/', editorName: "What's up?", menuName: 'Draft options', managed: true },
].filter(item => !process.env.WEBBRAIN_QUALITY_RELAXED_CASE || item.name === process.env.WEBBRAIN_QUALITY_RELAXED_CASE);
assert.ok(cases.length, 'Select an existing relaxed-monitoring Retry case.');

const textOf = content => typeof content === 'string' ? content : Array.isArray(content)
  ? content.filter(part => part?.type === 'text').map(part => part.text || '').join('\n') : '';
function toolObject(content) {
  const text = textOf(content);
  // Preserve the production nonce-bound untrusted-page envelope.
  for (let start = text.indexOf('{'); start >= 0; start = text.indexOf('{', start + 1)) {
    let depth = 0, quoted = false, escaped = false;
    for (let cursor = start; cursor < text.length; cursor++) {
      const char = text[cursor];
      if (quoted) { if (escaped) escaped = false; else if (char === '\\') escaped = true; else if (char === '"') quoted = false; }
      else if (char === '"') quoted = true;
      else if (char === '{') depth++;
      else if (char === '}' && --depth === 0) {
        try { return JSON.parse(text.slice(start, cursor + 1)); } catch { break; }
      }
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
function intent(current) {
  return { request_kind: 'execute', scope_relation: 'new', requires_state_change: true,
    requires_submission: false, messaging: null,
    deliverables: ['The exact owned draft is present once and the local options menu is open.'],
    allows_planner_shaped_result: false, allows_app_state_tool_evidence: false,
    completion_requirements: { download: false }, read_scope: 'visible_page',
    summary: 'Write the exact owned draft, open its local options once, freshly verify both and leave it unsubmitted.',
    steps: [{ id: '1', action: `Write ${current.editorName}, observe ${current.menuName}, open its options and verify the draft.` }],
    memory: { use_progress_ledger: false, progress_action: null }, scheduling: null, risks: [] };
}
function fixtureHtml(specification) {
  const social = ['x_shaped_draft', 'bluesky_shaped_draft'].includes(specification.name);
  const shell = specification.name === 'x_shaped_draft'
    ? '<div class="tabs"><button type="button" role="tab" aria-selected="true">For you</button><button type="button" role="tab" aria-selected="false">Following</button></div>'
    : specification.name === 'bluesky_shaped_draft'
      ? '<div class="tabs"><button type="button" role="tab" aria-selected="true">Following</button><button type="button" role="tab" aria-selected="false">Discover</button></div>' : '';
  // No entity/form/dialog/heading owner is supplied. The generic fallback is
  // intentional, even when an app-like surrounding shell is present.
  return `<!doctype html><meta charset="utf-8"><title>Owned ${specification.name} Retry fixture</title><style>
body{margin:0;background:#fff;color:#111;font:17px system-ui}.layout{margin:22px;display:flex;gap:28px}
.navigation{width:150px}.work-area{width:620px}.tabs{display:flex;gap:20px;height:62px}
#composer{padding:16px;border:1px solid #bbb;width:570px}#editor{height:120px;padding:8px;border:1px solid #777;white-space:pre-wrap}#editor p{margin:0}
.toolbar{display:flex;justify-content:space-between;margin-top:14px}button{font:inherit;padding:8px;cursor:pointer}
aside{width:240px;padding:12px;border:1px solid #ddd}#feed-item{height:80px}#menu{padding:12px;margin-top:8px;border:1px solid #777}
</style>${specification.managed ? '<script src="/owned-fixture/editor.js"></script>' : ''}<div class="layout">${social ? '<div class="navigation">Owned QA profile<br>Local intercepted timeline</div>' : ''}
<div class="work-area">${shell}<div id="composer">${specification.managed ? '<div id="editor-host"></div><button id="publish" disabled hidden aria-disabled="true">Post</button>' : `<div id="editor" role="textbox" contenteditable="true" aria-label="${specification.editorName.replaceAll('"', '&quot;')}" aria-multiline="true"></div>`}
<div class="toolbar"><button id="options" type="button">${specification.menuName}</button>${social ? '<button type="button" disabled>Post</button>' : ''}</div>
<div id="menu" hidden><span>Owned local formatting menu is open</span></div><div id="draft-result" role="status"></div></div></div>
<aside><span id="counter">Passive feed revision 0</span><div id="feed-item">Unrelated local feed update 0</div></aside></div><script>
window.qaEvents=[];window.qaInputCount=0;window.qaOptionsClicks=0;window.qaTicks=0;
${specification.managed ? `qaEditorLibrary.mountEditor('');qaEditorView.dom.id='editor';qaEditorView.dom.setAttribute('aria-label',${JSON.stringify(specification.editorName)});` : ''}
window.qaOriginalEditor=document.querySelector('#editor');window.qaOriginalOptions=document.querySelector('#options');
window.qaPassiveTick=()=>{qaTicks++;document.querySelector('#counter').textContent='Passive feed revision '+qaTicks;
  document.querySelector('#feed-item').textContent='Unrelated local feed update '+qaTicks;};
// The preparation case intentionally outruns the DOM debounce: local pending
// changes must preserve the original unsupported-context diagnosis too.
setInterval(qaPassiveTick,${specification.preparationOnly ? 80 : 200});
for(const type of ['beforeinput','input','paste'])qaOriginalEditor.addEventListener(type,event=>{
  qaEvents.push({type,trusted:event.isTrusted,inputType:event.inputType,data:event.data});
  if(type==='input')qaInputCount++;
},true);
qaOriginalOptions.addEventListener('click',event=>{
  qaOptionsClicks++;qaEvents.push({type:'options-click',trusted:event.isTrusted});
  document.querySelector('#menu').hidden=false;
  document.querySelector('#draft-result').textContent='Owned draft verified: '+qaOriginalEditor.innerText;
});
window.qaSnapshot=()=>({draft:${specification.managed ? 'qaSnapshotEditor().model' : 'qaOriginalEditor.innerText'},editorSame:qaOriginalEditor===document.querySelector('#editor'),
  optionsSame:qaOriginalOptions===document.querySelector('#options'),optionsClicks:qaOptionsClicks,inputCount:qaInputCount,
  menuOpen:!document.querySelector('#menu').hidden,ticks:qaTicks,events:qaEvents});
</script>`;
}

let current, context, worker, harness, panel;
const summaries = [], blockedRemote = [], auxiliaryRequests = [];
const server = http.createServer(async (request, response) => {
  try {
    if (request.url !== '/v1/chat/completions') { response.writeHead(404).end(); return; }
    let raw = ''; for await (const part of request) raw += part;
    const input = JSON.parse(raw), system = textOf(input.messages?.[0]?.content);
    let completion;
    if (!input.tools?.length && input.messages?.length === 1 && input.messages[0].role === 'user' && system === 'Hi') {
      // The installed settings/panel tests the configured provider normally.
      auxiliaryRequests.push(input);
      completion = { role: 'assistant', content: 'Owned scripted provider ready.' };
    } else if (system.startsWith('Extract stable user preferences for WebBrain memory.')) {
      auxiliaryRequests.push(input);
      completion = { role: 'assistant', content: '{"memories":[]}' };
    } else if (fixturePageTextReply(input.messages)) {
      // A status the page showed is read with a question that carries only
      // that text, not the task; read it the way a model would.
      auxiliaryRequests.push(input);
      completion = { role: 'assistant', content: fixturePageTextReply(input.messages) };
    } else {
      if (!current || !JSON.stringify(input.messages).includes(current.marker)) {
        auxiliaryRequests.push(input);
        assert.fail(`Every action provider request must retain the authentic owned task; unexpected subsystem: ${system.slice(0, 160)}`);
      }
      current.requests.push({ phase: current.phase, input });
      if (system.startsWith("Compile the user's social-publication intent across languages.")) {
        current.compilers++;
        completion = { role: 'assistant', content: JSON.stringify({ version: 1, status: 'none',
          actions: [], requirements: null, prohibited: [], reason: 'The authentic owned task requests an unsubmitted draft and local options only.' }) };
      } else if (system.startsWith('Evaluate only the observable requirements of the genuine user task')) {
        current.judges++;
        const state = await current.page.evaluate(() => qaSnapshot());
        assert.equal(state.draft, body); assert.equal(state.menuOpen, true); assert.equal(state.optionsClicks, 1);
        completion = { role: 'assistant', content: JSON.stringify({ outcome: 'succeeded',
          reason: 'Fresh page evidence shows the exact unsubmitted owned draft and its opened local options.' }) };
      } else if (!input.tools?.length) completion = { role: 'assistant', content: JSON.stringify(intent(current)) };
      else {
        const tools = latestTools(input.messages), last = tools.at(-1);
        const writes = tools.filter(tool => tool.name === 'set_field' && tool.result?.success === true);
        const clicks = tools.filter(tool => tool.name === 'click_ax' && (tool.result?.success === true || tool.result?.dispatched === true));
        let call;
        if (!writes.length) call = { name: 'set_field', args: { ref_id: current.refs.editor, text: body, clear: true } };
        else if (!clicks.length && last?.name !== 'get_accessibility_tree') call = { name: 'get_accessibility_tree', args: { filter: 'all' } };
        else if (!clicks.length) call = { name: 'click_ax', args: { ref_id: current.refs.options } };
        else if (last?.name !== 'get_accessibility_tree') call = { name: 'get_accessibility_tree', args: { filter: 'all' } };
        else {
          assert.ok(last.result?.pageContent?.includes(body.replace(/\s+/g, ' ')), 'Completion requires fresh draft evidence from the normal reader.');
          assert.ok(last.result.pageContent.includes('Owned local formatting menu is open'));
          call = { name: 'done', args: { outcome: 'success', summary: 'The exact owned draft and its opened local options were freshly verified.' } };
        }
        if (current.phase === 'strict') {
          current.strictDecisions++;
          assert.ok(current.strictDecisions <= 5, 'Strict unsupported context must stop after its five normal rejections.');
          assert.equal(call.name, 'set_field');
        } else current.retryDecisions++;
        assert.ok(current.calls.length < 20, 'An owned Retry must make bounded progress.');
        // Real page activity occurs after production model capture, throughout
        // inference and native preparation. The original target stays mounted.
        const beforeTicks = await current.page.evaluate(() => { qaPassiveTick(); return qaTicks; });
        await new Promise(resolve => setTimeout(resolve, 360));
        const afterTicks = await current.page.evaluate(() => qaTicks);
        assert.ok(afterTicks > beforeTicks, 'Passive churn must continue while every decision is in flight.');
        current.calls.push({ phase: current.phase, ...call, beforeTicks, afterTicks });
        completion = { role: 'assistant', content: '', tool_calls: [{ id: `owned-relaxed-${current.name}-${current.calls.length}`,
          type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args) } }] };
      }
    }
    response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ id: 'owned-relaxed-scripted-provider',
      choices: [{ message: completion, finish_reason: completion.tool_calls ? 'tool_calls' : 'stop' }],
      usage: { prompt_tokens: 100, completion_tokens: 30 } }));
  } catch (error) {
    if (current) current.providerError = error.stack;
    response.writeHead(500, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: error.message }));
  }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'webbrain-relaxed-monitoring-retry-mv3-'));
const evidenceReplacer = (key, value) => ['relaxedMonitorGrantToken', 'grantToken'].includes(key) && value
  ? '[private grant redacted]' : typeof value === 'string' && value.startsWith('data:image/') ? '[owned screenshot omitted]' : value;

try {
  const extension = path.join(profile, 'extension');
  await fs.cp(path.resolve('src/chrome'), extension, { recursive: true });
  // Read-only diagnostics in a disposable extension clone. No Agent method or
  // production decision is replaced, including recovery and completion.
  await fs.appendFile(path.join(extension, 'src/background.js'), '\nglobalThis.relaxedFixtureAgent = agent;\n');
  await fs.appendFile(path.join(extension, 'src/ui/sidepanel.js'),
    '\nglobalThis.relaxedFixturePanelState = () => ({ currentTabId, renderedTabId, isProcessing });\n');
  context = await chromium.launchPersistentContext(profile, { headless: true, channel: 'chromium', viewport: { width: 1280, height: 1000 },
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`,
      '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1'] });
  await context.route('**/*', async route => {
    const request = route.request(), requested = new URL(request.url());
    if (requested.hostname === '127.0.0.1' && requested.port === String(server.address().port)) return route.continue();
    const specification = cases.find(item => requested.href === item.url);
    if (specification && request.isNavigationRequest() && request.method() === 'GET')
      return route.fulfill({ contentType: 'text/html', body: fixtureHtml(specification) });
    if (cases.some(item => new URL(item.url).origin === requested.origin)
        && requested.pathname === '/owned-fixture/editor.js' && request.method() === 'GET')
      return route.fulfill({ contentType: 'text/javascript', body: editorBundle });
    if (/^https?:$/.test(requested.protocol)) {
      blockedRemote.push({ method: request.method(), origin: requested.origin }); return route.abort('blockedbyclient');
    }
    return route.continue();
  });
  worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker', { timeout: 30000 });
  // The worker can be reported before its extension APIs and module have
  // finished loading; wait for both before wrapping them.
  for (let attempt = 0; attempt < 200; attempt++) {
    const ready = await worker.evaluate(() => !!(globalThis.chrome?.tabs && globalThis.chrome?.debugger && globalThis.relaxedFixtureAgent))
      .catch(() => false);
    if (ready) break;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  await worker.evaluate(() => {
    const send = chrome.tabs.sendMessage.bind(chrome.tabs), command = chrome.debugger.sendCommand.bind(chrome.debugger), fetchOriginal = fetch.bind(globalThis);
    globalThis.relaxedFixtureProbe = { transports: [], commands: [], monitorStateRequests: [], blocked: [] };
    chrome.tabs.sendMessage = async (...args) => {
      const result = await send(...args), message = args[1];
      if (/page_monitor|set_field|type_ax|click_ax|ax_prepare|ax_resolve/.test(message.action)) relaxedFixtureProbe.transports.push({ tabId: args[0],
        action: message.action, params: { tool: message.params?.tool, ref_id: message.params?.ref_id,
          runToken: message.params?.runToken || message.runToken, snapshotToken: message.params?.snapshotToken,
          expectedModelSnapshot: message.params?.expectedModelSnapshot,
          relaxedMonitorGrantToken: message.params?.relaxedMonitorGrantToken, operationId: message.params?.operationId,
          fenceOnly: message.params?.fenceOnly, allowPassiveRebase: message.params?.allowPassiveRebase }, result });
      return result;
    };
    chrome.debugger.sendCommand = (...args) => {
      relaxedFixtureProbe.commands.push({ method: args[1], params: args[2] }); return command(...args);
    };
    chrome.runtime.onMessage.addListener((message, sender) => {
      if (message.action === 'get_page_monitor_state') relaxedFixtureProbe.monitorStateRequests.push({ tabId: sender.tab?.id,
        documentToken: message.documentToken, frameId: sender.frameId });
    });
    globalThis.fetch = (input, options) => {
      const target = new URL(typeof input === 'string' ? input : input.url);
      if (target.hostname === '127.0.0.1' || ['chrome-extension:', 'data:', 'blob:'].includes(target.protocol)) return fetchOriginal(input, options);
      relaxedFixtureProbe.blocked.push({ method: options?.method || 'GET', origin: target.origin });
      return Promise.reject(new Error('The owned relaxed Retry fixture blocks external service requests.'));
    };
  });
  harness = await context.newPage();
  const extensionOrigin = `chrome-extension://${new URL(worker.url()).host}`;
  await harness.goto(`${extensionOrigin}/src/ui/settings.html`);
  const message = (action, data = {}) => harness.evaluate(({ action, data }) => chrome.runtime.sendMessage({ target: 'background', action, ...data }), { action, data });
  await harness.evaluate(() => {
    window.relaxedFixtureUpdates = [];
    chrome.runtime.onMessage.addListener(event => { if (event.action === 'agent_update') relaxedFixtureUpdates.push(event); });
    return chrome.storage.local.set({ onboardingComplete: true, pinCoachmarkPending: false, helpImproveWebBrain: false,
      tracingEnabled: false, autoScreenshot: false, screenshotFallback: false, visionMode: 'off',
      planBeforeActMode: 'off', planBeforeAct: false, planReviewMode: 'never', maxAgentSteps: 12,
      systemOneEnabled: false, agentAllowLocalNetwork: true, askBeforeConsequentialActions: false, openaiAskStreamingEnabled: false });
  });
  assert.equal((await message('update_provider', { providerId: 'openrouter', config: { apiKey: 'owned-fixture-fake-key',
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`, model: 'minimax/minimax-m3', enabled: true,
    contextWindow: 1000000, supportsAskStreaming: false } })).ok, true);
  assert.equal((await message('set_active_provider', { providerId: 'openrouter' })).ok, true);
  panel = await context.newPage();
  const panelErrors = [];
  panel.on('pageerror', error => panelErrors.push(error.message));
  await panel.goto(`${extensionOrigin}/src/ui/sidepanel.html`);
  await panel.waitForFunction(() => typeof relaxedFixturePanelState === 'function');
  await panel.evaluate(() => {
    window.relaxedFixturePanelRequests = [];
    const send = chrome.runtime.sendMessage.bind(chrome.runtime);
    chrome.runtime.sendMessage = (...args) => {
      const value = args[0];
      if (['chat_start', 'failure_recovery_response', 'continue_start'].includes(value?.action)) relaxedFixturePanelRequests.push(structuredClone(value));
      return send(...args);
    };
  });
  for (const specification of cases) {
    const page = await context.newPage(), pageErrors = [];
    page.on('pageerror', error => pageErrors.push(error.message));
    await page.goto(specification.url); await page.waitForSelector('#editor');
    const tabId = await harness.evaluate(async url => (await chrome.tabs.query({})).findLast(tab => tab.url === url)?.id, specification.url);
    assert.ok(tabId);
    await page.bringToFront();
    await panel.waitForFunction(tabId => {
      const state = relaxedFixturePanelState(); return state.currentTabId === tabId && state.renderedTabId === tabId && !state.isProcessing;
    }, tabId);
    const tree = await harness.evaluate(tabId => chrome.tabs.sendMessage(tabId, { target: 'content', action: 'get_accessibility_tree', params: { filter: 'all' } }), tabId);
    const lines = tree.pageContent.split('\n'), ref = name => lines.find(line => line.includes(`"${name}"`))?.match(/\[(ref_\d+)\]/)?.[1];
    const refs = { editor: ref(specification.editorName), options: ref(specification.menuName) };
    assert.ok(refs.editor && refs.options, tree.pageContent);
    current = { ...specification, tabId, page, refs, marker: `Owned relaxed Retry scenario ${specification.name}.`,
      phase: 'strict', requests: [], calls: [], strictDecisions: 0, retryDecisions: 0, compilers: 0, judges: 0 };
    const probeStart = await worker.evaluate(() => ({ commands: relaxedFixtureProbe.commands.length,
      transports: relaxedFixtureProbe.transports.length, monitorStateRequests: relaxedFixtureProbe.monitorStateRequests.length }));
    const requestStart = await panel.evaluate(() => relaxedFixturePanelRequests.length);
    const task = `In this isolated owned local QA fixture, write exactly this draft into ${specification.editorName}:\n${body}\n`
      + `Then freshly observe ${specification.menuName}, click it exactly once, and verify both the draft and the local menu. Leave all submission controls untouched. ${current.marker}`;
    // The side panel picks the mode per message (Automatic mode); /act runs this one in Act.
    await panel.locator('#user-input').fill(`/act ${task}`); await panel.locator('#btn-send').click();
    const card = panel.locator('.failure-recovery-card[data-retry-mode="action_monitoring_relaxed"]');
    await card.waitFor({ timeout: 60000 });
    const retryButton = card.locator('[data-recovery-choice="retry"]');
    await retryButton.waitFor({ state: 'visible' });
    await panel.waitForFunction(() => {
      const card = document.querySelector('.failure-recovery-card[data-retry-mode="action_monitoring_relaxed"]');
      return card?.dataset.recoveryCurrent === 'true' && !card.querySelector('[data-recovery-choice="retry"]').disabled;
    });
    const strictState = await page.evaluate(() => qaSnapshot());
    const stopped = await message('agent_run_state', { tabId });
    const recovery = stopped.pendingFailureRecovery;
    const strictProbe = await worker.evaluate(start => ({ commands: relaxedFixtureProbe.commands.slice(start.commands),
      transports: relaxedFixtureProbe.transports.slice(start.transports) }), probeStart);
    assert.equal(current.providerError, undefined, current.providerError);
    assert.equal(stopped.running, false); assert.equal(current.strictDecisions, 5);
    assert.equal(stopped.runUi?.status, 'failed'); assert.equal(stopped.runUi?.runSucceeded, false);
    assert.equal(recovery?.code, 'action_context_unverified'); assert.equal(recovery?.retryMode, 'action_monitoring_relaxed');
    assert.match(recovery.recoveryId, /^recovery_[a-z0-9]+$/); assert.equal(await card.count(), 1);
    assert.equal(await panel.locator('.error-retry-btn').count(), 0, 'The explicit monitoring recovery must own the only Retry card.');
    assert.match(await card.locator('.failure-recovery-note').innerText(), /relax.*monitoring.*once/i);
    const strictRejected = strictProbe.transports.filter(item => item.action === 'page_monitor_validate_model' && item.result?.uncertified === true && item.result.ready === false);
    assert.equal(new Set(strictRejected.map(item => item.params.snapshotToken)).size, 5, JSON.stringify(strictProbe.transports));
    if (specification.preparationOnly) assert.ok(strictProbe.transports.some(item => item.action === 'page_monitor_dispatch'
      && item.result?.ready === false), 'The preparation case must hit the real last dispatch fence.');
    else assert.equal(strictRejected.length, 5, JSON.stringify(strictProbe.transports));
    assert.equal(strictProbe.commands.filter(command => command.method === 'Input.insertText').length, 0);
    assert.equal(strictState.draft, ''); assert.equal(strictState.optionsClicks, 0); assert.deepEqual(strictState.events, []);
    assert.ok(strictState.ticks > 5); assert.equal(strictState.editorSame, true); assert.equal(strictState.optionsSame, true);
    current.phase = 'retry';
    await retryButton.click();
    // A second physical choice is ignored once the real handler locks the
    // consumed card. Replayed delivery uses the original real UI requestId.
    await retryButton.evaluate(button => button.click());
    await panel.waitForFunction(start => relaxedFixturePanelRequests.slice(start)
      .some(request => request.action === 'failure_recovery_response' && request.choice === 'retry'), requestStart);
    const retryRequest = await panel.evaluate(start => relaxedFixturePanelRequests.slice(start)
      .find(request => request.action === 'failure_recovery_response' && request.choice === 'retry'), requestStart);
    assert.ok(retryRequest.requestId); assert.equal(retryRequest.recoveryId, recovery.recoveryId);
    const replay = await panel.evaluate(request => chrome.runtime.sendMessage(request), retryRequest);
    assert.equal(replay.accepted, true); assert.equal(replay.requestId, retryRequest.requestId);
    const terminalDeadline = Date.now() + 60000;
    let finished;
    do {
      finished = await message('agent_run_state', { tabId, requestId: retryRequest.requestId });
      if (!finished.running && !finished.starting && finished.runUi?.requestId === retryRequest.requestId
          && ['completed', 'failed', 'stopped', 'cancelled'].includes(finished.runUi.status) && finished.runUi.endedAt != null) break;
      await new Promise(resolve => setTimeout(resolve, 90));
    } while (Date.now() < terminalDeadline);
    current.finished = finished;
    assert.equal(finished.running, false, 'The retry must finish within the fixture deadline.');
    assert.equal(finished.starting, false);
    const completedReplay = await panel.evaluate(request => chrome.runtime.sendMessage(request), retryRequest);
    assert.equal(completedReplay.accepted, true); assert.equal(completedReplay.requestId, retryRequest.requestId);
    const afterReplay = await message('agent_run_state', { tabId, requestId: retryRequest.requestId });
    assert.equal(afterReplay.running, false); assert.equal(afterReplay.starting, false);
    assert.equal(afterReplay.runUi?.runId, finished.runUi?.runId, 'A replay after completion must keep the original retry run.');
    const lifecycle = await worker.evaluate(tabId => ({ feedbackRunPresent: relaxedFixtureAgent._pageFeedbackRuns.has(tabId),
      reservedRetryPresent: relaxedFixtureAgent._failureRecovery.monitoringRetries.has(tabId) }), tabId);
    const state = await page.evaluate(() => qaSnapshot());
    const runEvents = await harness.evaluate(tabId => relaxedFixtureUpdates.filter(event => event.tabId === tabId), tabId);
    const probe = await worker.evaluate(start => ({ commands: relaxedFixtureProbe.commands.slice(start.commands),
      transports: relaxedFixtureProbe.transports.slice(start.transports), monitorStateRequests: relaxedFixtureProbe.monitorStateRequests.slice(start.monitorStateRequests),
      blocked: relaxedFixtureProbe.blocked }), probeStart);
    const panelRequests = await panel.evaluate(start => relaxedFixturePanelRequests.slice(start), requestStart);
    const tools = runEvents.filter(event => event.requestId === retryRequest.requestId && event.type === 'tool_result').map(event => event.data);
    const evidence = { providerLabel, specification, task, initialTree: tree, strictState, stopped, recovery, strictRejected,
      retryRequest, replay, completedReplay, finished, afterReplay, lifecycle, state, runEvents, tools, probe, panelRequests, panelErrors, pageErrors,
      provider: { ...current, page: undefined }, blockedRemote };
    await fs.writeFile(path.join(out, `${specification.name}-evidence.json`), JSON.stringify(evidence, evidenceReplacer, 2));
    assert.equal(current.providerError, undefined, current.providerError); assert.deepEqual(pageErrors, []); assert.deepEqual(panelErrors, []);
    assert.equal(finished.runUi?.status, 'completed', JSON.stringify(finished.runUi));
    assert.equal(finished.runUi.kind, 'continue'); assert.notEqual(finished.runUi.runId, stopped.runUi.runId);
    assert.equal(finished.pendingFailureRecovery, null);
    assert.deepEqual(lifecycle, { feedbackRunPresent: false, reservedRetryPresent: false }, 'The completed retry must release its run-local grant.');
    const complete = runEvents.filter(event => event.type === 'run_complete');
    assert.deepEqual([...new Set(complete.map(event => event.requestId))], [stopped.runUi.requestId, retryRequest.requestId]);
    assert.equal(panelRequests.filter(request => request.action === 'chat_start').length, 1);
    assert.deepEqual([...new Set(panelRequests.filter(request => request.action === 'failure_recovery_response').map(request => request.requestId))], [retryRequest.requestId]);
    assert.equal(panelRequests.filter(request => request.action === 'continue_start').length, 0);
    assert.equal(state.draft, body); assert.equal(state.editorSame, true); assert.equal(state.optionsSame, true);
    assert.equal(state.optionsClicks, 1); assert.equal(state.menuOpen, true); assert.ok(state.ticks > strictState.ticks);
    const insertions = probe.commands.filter(command => command.method === 'Input.insertText');
    assert.equal(insertions.length, specification.managed ? 1 : 0);
    if (specification.managed) assert.equal(insertions[0].params.text, body);
    assert.ok(state.events.some(event => event.type === 'input' && event.trusted));
    if (specification.managed) assert.ok(state.events.every(event => event.trusted));
    assert.equal(state.inputCount, 1, 'The owned editor receives one actual input effect.');
    assert.equal(tools.filter(tool => tool.name === 'set_field').length, 1); assert.equal(tools.find(tool => tool.name === 'set_field')?.result.success, true);
    assert.equal(tools.filter(tool => tool.name === 'click_ax').length, 1);
    // Durable UI projection intentionally retains only public terminal fields.
    assert.equal(tools.findLast(tool => tool.name === 'done')?.result.outcome, 'success');
    assert.equal(finished.runUi.successfulDone, true); assert.equal(finished.runUi.runSucceeded, true);
    assert.ok(current.judges > 0, 'Normal production completion evaluation must run.');
    assert.ok(probe.monitorStateRequests.some(request => request.tabId === tabId && request.documentToken), 'Content must establish run state through get_page_monitor_state.');
    const privateTokens = [...new Set(probe.transports.map(item => item.params?.relaxedMonitorGrantToken).filter(Boolean))];
    assert.equal(privateTokens.length, 1, 'One retry run has one private relaxed monitoring grant.');
    assert.notEqual(privateTokens[0], recovery.recoveryId);
    const granted = probe.transports.filter(item => item.params?.relaxedMonitorGrantToken === privateTokens[0]);
    assert.ok(granted.some(item => item.action === 'page_monitor_validate_model' && item.result?.ready === true));
    assert.ok(granted.some(item => item.action === 'page_monitor_prepare' && item.params.expectedModelSnapshot), 'Native preparation keeps its model snapshot plus private grant.');
    const publicPayloads = JSON.stringify({ provider: current.requests, auxiliaryRequests, runEvents, recovery,
      card: await card.evaluate(element => element.outerHTML), panelRequests });
    for (const token of privateTokens) assert.equal(publicPayloads.includes(token), false, 'The monitor grant must remain absent from provider and chat payloads.');
    summaries.push({ scenario: specification.name, strictRejections: 5, strictValidationResponses: strictRejected.length, retryRuns: 1,
      nativeInsertions: insertions.length, optionsClicks: state.optionsClicks, passiveTicks: state.ticks, grantPrivate: true, outcome: finished.runUi.status });
    await page.close();
  }
  assert.ok(blockedRemote.every(request => ['GET', 'HEAD', 'OPTIONS'].includes(request.method)), 'No external mutation may be attempted.');
  const blockedBackground = await worker.evaluate(() => relaxedFixtureProbe.blocked);
  assert.ok(blockedBackground.every(request => ['GET', 'HEAD', 'OPTIONS'].includes(request.method)));
  await fs.writeFile(path.join(out, 'summary.json'), JSON.stringify({ passed: true, installedMV3: true, realRecoveryButton: true,
    providerLabel, summaries, externalMutations: 0, blockedRemote, blockedBackground }, null, 2));
  console.log(JSON.stringify({ passed: true, installedMV3: true, realRecoveryButton: true, providerLabel, cases: summaries, externalMutations: 0 }));
} catch (error) {
  const diagnostic = { providerLabel, error: error.stack, auxiliaryRequests, provider: current ? { ...current, page: undefined } : null,
    state: await current?.page?.evaluate(() => qaSnapshot()).catch(() => null), blockedRemote,
    runState: current && await harness?.evaluate(tabId => chrome.runtime.sendMessage({ target: 'background', action: 'agent_run_state', tabId }), current.tabId).catch(() => null),
    updates: await harness?.evaluate(() => relaxedFixtureUpdates).catch(() => null),
    panelState: await panel?.evaluate(() => ({ state: relaxedFixturePanelState(), requests: relaxedFixturePanelRequests,
      messages: document.querySelector('#messages')?.innerText })).catch(() => null),
    probe: await worker?.evaluate(() => relaxedFixtureProbe).catch(() => null) };
  await fs.writeFile(path.join(out, 'failure-evidence.json'), JSON.stringify(diagnostic, evidenceReplacer, 2));
  throw error;
} finally {
  await context?.close(); await new Promise(resolve => server.close(resolve));
  const resolved = path.resolve(profile);
  assert.ok(resolved.startsWith(path.resolve(os.tmpdir()) + path.sep + 'webbrain-relaxed-monitoring-retry-mv3-'));
  await fs.rm(resolved, { recursive: true, force: true });
}
