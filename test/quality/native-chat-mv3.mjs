import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { telegramLab, telegramRaceLab } from './native-chat-fixture.mjs';
import { fixturePageTextReply } from '../semantic-decision-stub.mjs';
import { scaled } from '../lib/time-budget.mjs';
import { writeTimeoutEvidence } from './native-chat-timeout-evidence.mjs';

// Whole installed background -> intent planner -> Agent -> native content
// dispatch -> completion. Only the provider is deterministic; no Agent gate,
// recipient check, observation, transport, or completion helper is mocked.
const out = path.resolve(process.env.WEBBRAIN_QUALITY_ARTIFACTS
  || 'ci/artifacts/quality-audit-2026-10-07/native-chat-mv3');
await fs.mkdir(out, { recursive: true });
// Each path must finish its chat run, alongside the paths running with it, in
// time. In passing QA runs the slowest path took about 51 s; under heavier load
// paths missed the former 60 s budget. This one leaves room for that and scales
// with WEBBRAIN_TEST_TIMEOUT_SCALE.
const PATH_BUDGET_MS = scaled(120000);
const fixtureUrl = 'https://web.telegram.org/k/#123456';
const task = 'This is an isolated QA dialogue with WebBrain QA Bot, the only intended recipient in the currently open conversation. You are authorized to generate and send brief useful replies about browser-agent quality within this conversation. Answer its six questions, one reply per question, using your own wording. Observe each new incoming question and verify delivery after each send. Stop when the bot confirms all six replies were recorded. Keep the conversation on this page.';
const replies = [
  'Test a full form submission and independently verify its confirmation.',
  'Track the outgoing message identity and compare it before repeating a send.',
  'Accept the new instruction and revoke actions that it no longer authorizes.',
  'Stop promptly and preserve an honest account of actions already dispatched.',
  'Keep consumed incoming identities across resumes and virtual-list remounts.',
  'Verify the final result from fresh evidence and report any unresolved blocker.',
];
assert.ok(replies.every(reply => !task.includes(reply)), 'The user authorizes a goal; the provider generates its replies.');
const structuredPath = value => ['structured', 'structured_prefill', 'same_body_race'].includes(value);
const ledgerPath = value => ['generic_submit', 'structured_prefill', 'same_body_race'].includes(value);
const repliesFor = value => value === 'same_body_race' ? ['ok', 'ok'] : replies;
const taskFor = value => value === 'same_body_race' ? task.replaceAll('six', 'two') + ' Use the same brief acknowledgment for both distinct questions.' : task;

function textContent(content) {
  return typeof content === 'string' ? content : Array.isArray(content)
    ? content.filter(block => block?.type === 'text').map(block => block.text || '').join('\n') : '';
}
function toolObject(content) {
  const text = textContent(content);
  // Tool JSON may be inside the real nonce-bound untrusted-page envelope.
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
    .map(message => ({ name: names.get(message.tool_call_id) || message.name,
      result: toolObject(message.content), content: textContent(message.content) }));
}
function intent(dispatchPath) {
  return { request_kind: 'execute', scope_relation: 'new', requires_state_change: true,
    requires_submission: true, messaging: { target_kind: 'named', recipients: ['WebBrain QA Bot'] },
    deliverables: [`${repliesFor(dispatchPath).length} brief generated replies, each independently delivered in the authorized QA chat.`],
    expected_items: ledgerPath(dispatchPath) ? { count: repliesFor(dispatchPath).length, item_type: 'reply', ordered: true, required_fields: [] } : null,
    allows_planner_shaped_result: false, allows_app_state_tool_evidence: false,
    completion_requirements: { download: false }, read_scope: 'visible_page',
    summary: 'Observe and answer each of the six questions in this authorized conversation, verify delivery, and stop at its terminal confirmation.',
    steps: [{ id: '1', action: 'Observe the active conversation, generate and send six brief relevant replies one at a time, and verify its final confirmation.' }],
    memory: { use_progress_ledger: ledgerPath(dispatchPath), progress_action: ledgerPath(dispatchPath) ? 'process_item' : null }, scheduling: null, risks: [] };
}

const cases = new Map();
const server = http.createServer(async (request, response) => {
  let current;
  try {
    if (request.url !== '/v1/chat/completions') {
      response.writeHead(404); response.end('Owned provider endpoint only.'); return;
    }
    let body = ''; for await (const chunk of request) body += chunk;
    const input = JSON.parse(body);
    // What a status on the page says, read the way a model would read it.
    // These questions carry page text only, never a tab's task.
    const pageTextReply = fixturePageTextReply(input.messages);
    if (pageTextReply) {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ id: 'owned-page-text', choices: [{ message: { role: 'assistant', content: pageTextReply }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 100, completion_tokens: 10 } }));
      return;
    }
    const authority = JSON.stringify(input.messages || []);
    const matches = [...cases.values()].filter(entry => authority.includes(entry.marker));
    assert.equal(matches.length, 1, 'Every provider request must retain exactly its own tab task authority.');
    [current] = matches;
    current.requests.push(input);
    await new Promise(resolve => setTimeout(resolve, 240));
    const system = textContent(input.messages?.[0]?.content);
    const isJudge = system.startsWith('Evaluate only the observable requirements of the genuine user task');
    const isAction = Array.isArray(input.tools) && input.tools.length > 0;
    let completion;
    if (isJudge) {
      current.judges++;
      completion = { role: 'assistant', content: JSON.stringify({ outcome: 'uncertain',
        reason: 'Exercise independently verified native chat delivery and terminal evidence.' }) };
    } else if (!isAction) {
      current.intents.push(intent(current.path));
      completion = { role: 'assistant', content: JSON.stringify(intent(current.path)) };
    } else {
      const tools = latestTools(input.messages);
      const last = tools.at(-1);
      const observation = tools.findLast(tool => tool.name === 'chat_observe' && tool.result?.success === true)?.result;
      // A real send's public post-dispatch observation can deliver the next
      // incoming delta before chat_observe. Consume it once wherever it was
      // exposed; a later read correctly does not repeat consumed messages.
      for (const tool of tools) for (const row of tool.result?.chatWorkflow?.newMessages || []) {
        if (row.direction === 'incoming' && row.text.startsWith('QA dialogue complete:')) current.terminalObserved = true;
        if (row.direction === 'incoming' && !row.text.startsWith('QA dialogue complete:')
            && !current.observedIncoming.some(previous => previous.id === row.id)) {
          current.observedIncoming.push({ id: row.id, text: row.text });
        }
      }
      const sends = tools.filter(tool => tool.name === (structuredPath(current.path) ? 'chat_send' : 'click_ax'));
      const sent = current.path === 'generic_submit'
        ? new Set(tools.filter(tool => tool.name === 'chat_observe' && tool.result?.chatDeliveryVerification)
          .map(tool => tool.result.chatDeliveryVerification.messageId)).size
        : sends.filter(tool => tool.result?.success === true || tool.result?.deliveryVerified === true).length;
      let name, args, following = [];
      const fieldAndSend = () => {
        assert.ok(observation?.composer?.ref && current.sendRef, 'Use observed composer and Send refs.');
        name = 'set_field'; args = { ref_id: observation.composer.ref, text: replies[sent],
          ...(current.path === 'generic_submit' ? { submit: true } : {}) };
        if (current.path !== 'generic_submit') following = [{ name: 'click_ax', args: { ref_id: current.sendRef } }];
      };
      if (current.path === 'generic_submit' && last?.name === 'set_field'
          && last.result?.pageFeedbackPending === true && last.result.noDispatch === true
          && last.result.dispatched === false && !last.result.outcomeUnknown) {
        // Closing another owned concurrent tab can resize this viewport.
        // A positively undispatched send is safe to reconsider only after
        // explicit AX and native reads; uncertain dispatches never retry.
        current.feedbackRecoveries = (current.feedbackRecoveries || 0) + 1;
        assert.ok(current.feedbackRecoveries <= 4, 'Persistent browser changes prevent the owned send.');
        current.feedbackRecoveryRead = true;
        name = 'get_accessibility_tree'; args = { filter: 'visible' };
      } else if (current.feedbackRecoveryRead && last?.name === 'get_accessibility_tree') {
        assert.ok(last.result && !last.result.error && last.result.success !== false,
          'Recovery requires a successful explicit AX read.');
        current.feedbackRecoveryRead = false;
        name = 'chat_observe'; args = { rebind_thread_key: observation.threadKey,
          reconcile_pending_outbound: false, pending_outbound_key: '' };
      } else if (current.path === 'same_body_race') {
        for (const tool of tools) for (const row of tool.result?.chatWorkflow?.newMessages || []) {
          if (row.direction === 'incoming' && /^Confirm owned turn/.test(row.text)
              && !current.observedIncoming.some(previous => previous.id === row.id)) current.observedIncoming.push({ id: row.id, text: row.text });
        }
        const proofIds = new Set(tools.map(tool => tool.result?.chatDeliveryVerification?.messageId
          || tool.result?.chatDeliveryProgress?.messageId).filter(Boolean));
        const native = observation || tools.findLast(tool => tool.name === 'chat_send')?.result;
        if (!last || last.name === 'chat_send' || native?.chatWorkflow?.pendingOutbound) {
          name = 'chat_observe'; args = {};
        } else if (last.name === 'chat_observe' && proofIds.size === 2) {
          assert.ok(current.observedIncoming.length === 2);
          name = 'done'; args = { outcome: 'success', summary: 'Both distinct owned questions received exactly one independently verified acknowledgment.' };
        } else if (last.name === 'chat_observe') {
          assert.equal(last.result?.success, true, last.content);
          assert.ok(current.observedIncoming.length >= proofIds.size + 1);
          name = 'chat_send'; args = { thread_key: native.threadKey, composer_ref: native.composer.ref, text: 'ok' };
        } else if (last.name === 'done') { name = 'chat_observe'; args = {}; }
        else throw new Error('Unexpected native race result ' + last.name);
      } else if (current.path === 'structured_prefill' && sent === 0 && last?.name === 'chat_observe' && !current.prefillStage) {
        assert.equal(last.result?.success, true, last.content);
        current.prefillStage = 'draft'; name = 'set_field';
        args = { ref_id: observation.composer.ref, text: replies[0], clear: true, submit: false };
      } else if (current.path === 'structured_prefill' && current.prefillStage === 'draft' && last?.name === 'set_field') {
        assert.equal(last.result?.success, true, last.content);
        current.prefillStage = 'draft_guard'; name = 'chat_send';
        args = { thread_key: observation.threadKey, composer_ref: observation.composer.ref, text: replies[0] };
      } else if (current.path === 'structured_prefill' && current.prefillStage === 'draft_guard' && last?.name === 'chat_send') {
        assert.equal(last.result?.reason, 'composer_not_empty'); assert.equal(last.result.noDispatch, true);
        current.prefillStage = 'empty_clear'; name = 'set_field';
        args = { ref_id: observation.composer.ref, text: '', clear: true, submit: false };
      } else if (current.path === 'structured_prefill' && current.prefillStage === 'empty_clear' && last?.name === 'set_field') {
        assert.equal(last.result?.success, true, 'Explicit owned empty clear must settle without arming a rich-text recovery fence: ' + last.content);
        // The prior explicit composer write needs its own independent page
        // read. Verified chat sends cannot erase unrelated action debt.
        current.prefillStage = 'empty_verified'; name = 'get_accessibility_tree'; args = { filter: 'visible' };
      } else if (current.path === 'structured_prefill' && current.prefillStage === 'empty_verified' && last?.name === 'get_accessibility_tree') {
        current.prefillStage = 'complete'; name = 'chat_send';
        args = { thread_key: observation.threadKey, composer_ref: observation.composer.ref, text: replies[0] };
      } else if (!last || last.name === 'chat_send' || last.name === 'click_ax' || last.name === 'done') {
        name = 'chat_observe'; args = current.path === 'generic_submit'
          ? { rebind_thread_key: observation?.threadKey || 'dom:telegram:k:123456:0',
              reconcile_pending_outbound: false, pending_outbound_key: '' } : {};
      } else if (last.name === 'set_field') {
        assert.equal(last.result?.success, true, last.content);
        const tree = tools.findLast(tool => tool.name === 'get_accessibility_tree');
        const sendRef = (tree?.result?.pageContent || tree?.content || '').split('\n')
          .find(line => /button "Send"/.test(line))?.match(/\[(ref_\d+)\]/)?.[1];
        assert.ok(sendRef, 'Use the fresh app accessibility tree Send ref.');
        name = 'click_ax'; args = { ref_id: sendRef };
      } else if (last.name === 'get_accessibility_tree') {
        current.sendRef = (last.result?.pageContent || last.content || '').split('\n')
          .find(line => /button "Send"/.test(line))?.match(/\[(ref_\d+)\]/)?.[1];
        fieldAndSend();
      } else if (last.name === 'chat_observe') {
        assert.equal(last.result?.success, true, last.content);
        if ((sent >= 6 && !current.terminalObserved) || (sent < 6 && current.observedIncoming.length < sent + 1)) {
          // Browser background timers can delay the next bot turn. Waiting
          // reads are honest; no mutation is allowed without a new question.
          current.waitingReads = (current.waitingReads || 0) + 1;
          assert.ok(current.waitingReads <= 20, 'The owned bot never exposed its next incoming turn.');
          name = 'chat_observe'; args = current.path === 'generic_submit'
            ? { rebind_thread_key: observation.threadKey, reconcile_pending_outbound: false, pending_outbound_key: '' } : {};
        } else if (sent >= 6) {
          current.doneAttempts++;
          assert.ok(current.doneAttempts <= 3, 'A terminal gate remained blocked after fresh native observations.');
          name = 'done'; args = { outcome: 'success', summary: `All six generated replies were delivered and the owned QA dialogue confirmed completion (${current.path}).` };
        } else {
          assert.ok(current.observedIncoming.length >= sent + 1,
            `Reply ${sent + 1} requires its own publicly observed incoming question.`);
          assert.ok(observation.threadKey && observation.composer?.ref, 'Use the real native thread and composer binding.');
          if (structuredPath(current.path)) {
            name = 'chat_send';
            args = { thread_key: observation.threadKey, composer_ref: observation.composer.ref, text: replies[sent] };
          } else if (current.sendRef) fieldAndSend();
          else { name = 'get_accessibility_tree'; args = { filter: 'visible' }; }
        }
      } else throw new Error(`Unexpected actual tool response ${last.name}.`);
      completion = { role: 'assistant', content: '', tool_calls: [{ name, args }, ...following].map(call => {
        current.calls.push(call);
        return { id: `${current.path}-${current.calls.length}`, type: 'function',
          function: { name: call.name, arguments: JSON.stringify(call.args) } };
      }) };
    }
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ id: `owned-${current.path}-${current.requests.length}`,
      choices: [{ message: completion, finish_reason: isAction ? 'tool_calls' : 'stop' }],
      usage: { prompt_tokens: 100, completion_tokens: 20 } }));
  } catch (error) {
    if (current) current.providerError = error.message;
    response.writeHead(500, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ error: error.message }));
  }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const providerBase = `http://127.0.0.1:${server.address().port}/v1`;
const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'webbrain-native-chat-mv3-'));
let context;
const summaries = [];
try {
  const extension = path.resolve('src/chrome');
  context = await chromium.launchPersistentContext(profile, { headless: true, channel: 'chromium', viewport: { width: 1280, height: 1000 },
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`,
      '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1'] });
  await context.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.origin === 'https://web.telegram.org') return route.fulfill({ contentType: 'text/html',
      body: url.searchParams.get('fixture') === 'same_body_race' ? telegramRaceLab : telegramLab });
    if (url.hostname === '127.0.0.1' || url.protocol === 'chrome-extension:') return route.continue();
    return route.abort('blockedbyclient');
  });
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker', { timeout: 30000 });
  await worker.evaluate(() => {
    const send = fetch.bind(globalThis);
    globalThis.nativeFixtureNetwork = { allowed: [], blocked: [] };
    globalThis.fetch = (input, options) => {
      const url = new URL(typeof input === 'string' ? input : input.url);
      if (url.hostname === '127.0.0.1' || ['chrome-extension:', 'data:', 'blob:'].includes(url.protocol)) {
        nativeFixtureNetwork.allowed.push(url.origin); return send(input, options);
      }
      nativeFixtureNetwork.blocked.push(url.origin);
      return Promise.reject(new Error('This isolated native chat fixture blocks external network requests.'));
    };
  });
  const extensionId = new URL(worker.url()).host;
  const harness = await context.newPage(); await harness.goto(`chrome-extension://${extensionId}/src/ui/settings.html`);
  const message = (action, data = {}) => harness.evaluate(({ action, data }) =>
    chrome.runtime.sendMessage({ target: 'background', action, ...data }), { action, data });
  await harness.evaluate(async () => {
    window.nativeRuns = {};
    chrome.runtime.onMessage.addListener(event => {
      if (event.action === 'agent_update' && nativeRuns[event.requestId])
        nativeRuns[event.requestId].events.push({ type: event.type, data: event.data });
    });
    await chrome.storage.local.set({ helpImproveWebBrain: false, planBeforeActMode: 'off', planBeforeAct: false,
      planReviewMode: 'never', screenshotFallback: false, autoScreenshot: false, visionMode: 'off', maxAgentSteps: 40,
      systemOneEnabled: false, tracingEnabled: false, agentAllowLocalNetwork: true,
      askBeforeConsequentialActions: false, openaiAskStreamingEnabled: false });
  });
  assert.equal((await message('update_provider', { providerId: 'openrouter', config: {
    apiKey: 'owned-fixture-fake-key', baseUrl: providerBase, model: 'minimax/minimax-m3',
    contextWindow: 1000000, enabled: true, supportsAskStreaming: false } })).ok, true);
  assert.equal((await message('set_active_provider', { providerId: 'openrouter' })).ok, true);

  async function verifyPath(dispatchPath) {
    const expectedReplies = repliesFor(dispatchPath), expectedCount = expectedReplies.length;
    const marker = `QA verification path: ${dispatchPath}.`;
    const current = { path: dispatchPath, marker, requests: [], calls: [], intents: [], observedIncoming: [], doneAttempts: 0, judges: 0 };
    cases.set(dispatchPath, current);
    const ownedUrl = fixtureUrl.replace('/k/#', `/k/?fixture=${dispatchPath}#`);
    const started = Date.now();
    const page = await context.newPage(); await page.goto(ownedUrl);
    const tabId = await harness.evaluate(async url => (await chrome.tabs.query({})).find(tab => tab.url === url)?.id, ownedUrl);
    assert.ok(tabId, 'Only the exact intercepted demo tab can receive this task.');
    const requestId = `native-mv3-${dispatchPath}`;
    await harness.evaluate(({ tabId, text, requestId }) => {
      const run = window.nativeRuns[requestId] = { finished: false, events: [] };
      chrome.runtime.sendMessage({ target: 'background', action: 'chat', tabId, text, mode: 'act', requestId, locale: 'en' })
        .then(result => { run.result = result; run.finished = true; }, error => { run.result = { error: error.message }; run.finished = true; });
    }, { tabId, text: `${taskFor(dispatchPath)}\n${marker}`, requestId });
    try { await harness.waitForFunction(id => nativeRuns[id]?.finished, requestId, { timeout: PATH_BUDGET_MS }); }
    catch (error) {
      await writeTimeoutEvidence({ out, dispatchPath, started, budgetMs: PATH_BUDGET_MS, error, harness, page, worker, message, tabId, requestId, current })
        .catch(failure => console.error(`Could not save ${dispatchPath} timeout evidence: ${failure.message}`));
      await message('abort', { tabId }); throw error;
    }
    const run = await harness.evaluate(id => nativeRuns[id], requestId);
    const actualReplies = await page.evaluate(() => qaReplies);
    const outgoingBodies = await page.locator('.bubble.is-out .message').evaluateAll(nodes => nodes.map(node =>
      [...node.childNodes].filter(child => child.nodeType === Node.TEXT_NODE).map(child => child.textContent).join('')));
    const finalNativeText = await page.locator('.bubble').last().innerText();
    // The broadcast UI event intentionally summarizes tool results. The actual
    // background reply retains the complete public done/evidence contract.
    const done = run.result?.updates?.findLast(event => event.type === 'tool_result' && event.data?.name === 'done')?.data?.result;
    const terminal = run.events.findLast(event => event.type === 'run_complete')?.data;
    const evidence = { path: dispatchPath, elapsedMs: Date.now() - started, finalUrl: page.url(),
      actualReplies, outgoingBodies, finalNativeText, run, provider: current, network: await worker.evaluate(() => nativeFixtureNetwork), externalMessages: 0 };
    await fs.writeFile(path.join(out, `${dispatchPath}-evidence.json`), JSON.stringify(evidence,
      (_key, value) => typeof value === 'string' && value.startsWith('data:image/') ? '[owned screenshot omitted]' : value, 2));
    assert.equal(current.providerError, undefined, current.providerError);
    assert.deepEqual(actualReplies, expectedReplies, 'Every generated reply must be delivered once, in question order.');
    assert.deepEqual(outgoingBodies, expectedReplies, 'Each reply must exist as exactly one native authored outgoing bubble.');
    assert.equal(new Set(current.observedIncoming.map(row => row.id)).size, expectedCount, 'Each reply needs its own observed incoming identity.');
    assert.match(finalNativeText, dispatchPath === 'same_body_race' ? /QA dialogue complete: both replies recorded/ : /QA dialogue complete: all six replies recorded/);
    assert.ok(current.intents.length > 0, 'Exercise normal intent planning through the installed provider.');
    assert.ok(current.intents.every(plan => plan.requires_submission === true && plan.messaging?.target_kind === 'named'));
    assert.ok(current.judges > 0, 'An uncertain real completion evaluator must leave native terminal proof authoritative.');
    assert.equal(done?.done, true, JSON.stringify(done));
    assert.equal(done?.outcome, 'success', JSON.stringify(done));
    assert.notEqual(done?.success, false, JSON.stringify(done));
    assert.equal(terminal?.status, 'completed', JSON.stringify(terminal));
    const actualResults = run.result.updates.filter(event => event.type === 'tool_result');
    const nativeReads = actualResults.filter(event => event.data.name === 'chat_observe').map(event => event.data.result);
    const verifiedDeliveries = nativeReads.filter(result => result.chatDeliveryVerification);
    assert.ok(verifiedDeliveries.length >= expectedCount, 'A fresh native observation must independently confirm each outgoing message; repeated read-only verification is allowed.');
    assert.equal(new Set(verifiedDeliveries.map(result => result.chatDeliveryVerification.messageId)).size, expectedCount);
    assert.ok(verifiedDeliveries.every(result => result.success === true && result.composer.empty === true
      && result.chatWorkflow.pendingOutbound === false && !result.chatWorkflow.userInput));
    const sendAttempts = actualResults.filter(event => event.data.name === (structuredPath(dispatchPath) ? 'chat_send'
      : dispatchPath === 'generic_submit' ? 'set_field' : 'click_ax'));
    // A send held back because the browser changed during it sends nothing:
    // these paths run in tabs of one browser, and a tab that closes resizes
    // the others, which page feedback reports. The model reads the chat again
    // and sends once more; exactly-once delivery is checked above by the
    // page's own replies and outgoing bubbles, not by counting attempts.
    const heldStructuredSend = result => result?.success !== true && result?.deliveryVerified !== true
      && ((result?.skipped === true && result.noDispatch === true && result.dispatched === false && !result.outcomeUnknown)
        || (result?.reason === 'native_chat_submit_blocked_before_dispatch' && result.submissionDispatched === false
          && result.submissionBlockReason === 'page_feedback_pending'));
    const feedbackSkips = dispatchPath === 'generic_submit' ? sendAttempts.filter(event => {
      const result = event.data.result;
      return result.pageFeedbackPending === true && result.noDispatch === true
        && result.dispatched === false && !result.outcomeUnknown;
    }) : structuredPath(dispatchPath) ? sendAttempts.filter(event => heldStructuredSend(event.data.result)) : [];
    if (dispatchPath === 'generic_submit') assert.equal(feedbackSkips.length, current.feedbackRecoveries || 0);
    else assert.ok(feedbackSkips.length <= 2, 'Browser changes held back a send more than twice.');
    // Each held send has page feedback around it: after the step before it
    // and before the next step after it. A skip for any other reason counts.
    for (const skip of structuredPath(dispatchPath) ? feedbackSkips : []) {
      const updates = run.result.updates, at = updates.indexOf(skip);
      const from = updates.slice(0, at).findLastIndex(event => event.type === 'tool_result');
      const next = updates.findIndex((event, index) => index > at && event.type === 'tool_call');
      assert.ok(updates.slice(from + 1, next < 0 ? updates.length : next).some(event => event.type === 'page_feedback'),
        'A send was held back without page feedback around it: ' + JSON.stringify(skip.data.result).slice(0, 300));
    }
    const dispatches = dispatchPath === 'structured_prefill' ? sendAttempts.filter(event => event.data.result.success === true)
      : sendAttempts.filter(event => !feedbackSkips.includes(event));
    assert.equal(dispatches.length, expectedCount);
    if (dispatchPath === 'same_body_race') {
      assert.equal(dispatches[0].data.result.dispatched, true);
      assert.equal(dispatches[0].data.result.chatWorkflow.pendingOutbound, true);
      assert.equal(dispatches[0].data.result.deliveryVerified, false, 'First acknowledgment is honestly pending until its delayed bubble arrives.');
      assert.equal(dispatches[1].data.result.success, true); assert.equal(dispatches[1].data.result.deliveryVerified, true);
      assert.ok(nativeReads.some(result => result.chatWorkflow?.pendingOutbound), 'Actual pending observation prevents a duplicate premature send.');
      const stored = await harness.evaluate(async marker => {
        const entries = await chrome.storage.session.get(null);
        const entry = Object.values(entries).find(value => value?.chatWorkflow && JSON.stringify(value.messages).includes(marker));
        return { bindings: entry?.chatWorkflow?.deliveredReplyBindings, pending: entry?.chatWorkflow?.pendingOutbound };
      }, marker);
      assert.equal(stored.pending, null); assert.equal(stored.bindings?.length, 2);
      assert.deepEqual(stored.bindings.map(binding => binding.messageId), ['telegram:k:123456:0:3', 'telegram:k:123456:0:4']);
      assert.ok(stored.bindings[0].replyAnchor.startsWith('telegram:k:123456:0:1:'));
      assert.ok(stored.bindings[1].replyAnchor.startsWith('telegram:k:123456:0:2:'));
      await fs.writeFile(path.join(out, 'same-body-race-persisted-bindings.json'), JSON.stringify(stored, null, 2));
    } else {
      assert.ok(dispatches.every(event => event.data.result.success === true));
      if (structuredPath(dispatchPath)) assert.ok(dispatches.every(event => event.data.result.deliveryVerified === true));
    }
    if (dispatchPath === 'structured_prefill') {
      assert.equal(sendAttempts.length, 7 + feedbackSkips.length);
      assert.equal(sendAttempts[0].data.result.reason, 'composer_not_empty');
      assert.equal(sendAttempts[0].data.result.noDispatch, true);
      const drafts = actualResults.filter(event => event.data.name === 'set_field');
      assert.equal(drafts.length, 2);
      assert.ok(drafts.every(event => event.data.result.success === true && event.data.result.verified === true
        && !event.data.result.outcomeUnknown && !event.data.result.repeatBlocked));
      // Each delivered reply processes its own reply row once, in order. A
      // send held back by page feedback leaves its draft typed; the send that
      // submits that draft proves delivery, and, as the presubmit harness
      // documents, the next native read may be the first receipt that
      // processes its row. Every other send carries its own receipt.
      const expectedIds = Array.from({ length: 6 }, (_, index) => `expected:${index + 1}`);
      const updates = run.result.updates;
      const receipts = dispatches.map(event => {
        const result = event.data.result;
        if (result.chatDeliveryProgress || !feedbackSkips.length) return result.chatDeliveryProgress;
        const at = updates.indexOf(event);
        assert.ok(feedbackSkips.some(skip => skip.data.result.messageKey === result.messageKey && updates.indexOf(skip) < at),
          'Only the send that submits a held draft may leave its receipt to the next native read: '
            + JSON.stringify(result).slice(0, 300));
        const read = updates.find((later, index) => index > at && later.type === 'tool_result');
        const sentId = result.chatWorkflow?.newMessages?.find(row => row.direction === 'outgoing')?.id;
        assert.equal(read?.data?.name, 'chat_observe', 'The submitted held draft needs its own native read next.');
        assert.ok(sentId && read.data.result?.chatDeliveryProgress?.messageId === sentId,
          'The native read after a submitted held draft must process that draft\'s own message.');
        return read.data.result.chatDeliveryProgress;
      });
      assert.deepEqual(receipts.map(receipt => receipt?.id), expectedIds);
      assert.deepEqual(receipts.map(receipt => receipt.counts.processed), [1, 2, 3, 4, 5, 6]);
      assert.equal(new Set(receipts.map(receipt => receipt.messageId)).size, 6);
      assert.deepEqual(actualResults.map(event => event.data.result?.chatDeliveryProgress?.id).filter(Boolean), expectedIds,
        'No reply row is processed twice or by any other result.');
      assert.equal(actualResults.filter(event => event.data.name === 'get_accessibility_tree').length, 1,
        'The recovered explicit empty write is independently observed before a self-verifying send.');
      assert.equal(run.events.some(event => event.type === 'tool_call' && event.data?.name === 'progress_update'), false);
    }
    if (dispatchPath === 'generic_submit') {
      assert.ok(dispatches.every(event => event.data.result.outcomeUnknown === true), 'Real Enter submission emptied the composer before its field verifier returned.');
      assert.ok(dispatches.every(event => event.data.result.chatSendVerification?.nextAction === 'chat_observe'),
        'An emptied uncertain submission must guide the model toward native observation before another send.');
      const ownedProgress = verifiedDeliveries.filter(result => result.chatDeliveryProgress);
      assert.deepEqual(ownedProgress.map(result => result.chatDeliveryProgress.id),
        Array.from({ length: 6 }, (_, index) => `expected:${index + 1}`));
      assert.deepEqual(ownedProgress.map(result => result.chatDeliveryProgress.counts.processed), [1, 2, 3, 4, 5, 6]);
      const redundantClicks = actualResults.filter(event => event.data.name === 'click_ax');
      assert.equal(redundantClicks.length, 6);
      assert.ok(redundantClicks.every(event => event.data.result.noDispatch === true && event.data.result.dispatched === false),
        'An empty-composer followup cannot dispatch a duplicate message.');
      assert.equal(run.events.some(event => event.type === 'tool_call' && event.data?.name === 'progress_update'), false,
        'Native delivery must reconcile only its own ordered reply placeholder.');
      const ordinaryReads = current.calls.filter(call => call.name === 'chat_observe');
      assert.ok(ordinaryReads.length >= 7);
      assert.ok(ordinaryReads.every(call => call.args.rebind_thread_key === 'dom:telegram:k:123456:0'
        && call.args.reconcile_pending_outbound === false && call.args.pending_outbound_key === ''),
        'Exercise filled optional arguments on the pristine first read and every later same-peer read without resetting the session.');
    }
    assert.equal(page.url(), ownedUrl, 'No navigation away from this exact intercepted demo conversation.');
    const tools = run.events.filter(event => event.type === 'tool_call').map(event => event.data?.name);
    assert.ok(tools.filter(name => name === 'chat_observe').length >= expectedCount + 1, 'Observe each question and the final independent confirmation.');
    assert.equal(tools.filter(name => name === (structuredPath(dispatchPath) ? 'chat_send'
      : dispatchPath === 'generic_submit' ? 'set_field' : 'click_ax')).length,
      (dispatchPath === 'structured_prefill' ? 7 : expectedCount) + feedbackSkips.length);
    if (dispatchPath === 'generic') assert.equal(tools.filter(name => name === 'set_field').length, 6);
    assert.equal(tools.includes(structuredPath(dispatchPath) ? 'click_ax' : 'chat_send'), false,
      'Each fixture must exercise its intended public dispatch path.');
    summaries.push({ path: dispatchPath, passed: true, replies: actualReplies.length,
      elapsedMs: evidence.elapsedMs, toolCalls: tools.length, judges: current.judges,
      feedbackRecoveries: current.feedbackRecoveries || 0, externalMessages: 0 });
    console.log(JSON.stringify(summaries.at(-1)));
  }
  // Separate native tabs also prove that concurrent runs retain their own
  // task and conversation authority. The fake provider never chooses refs or
  // bodies from the other tab, and both real Agent pipelines remain intact.
  // Keep completed tabs open until every concurrent run has settled: closing
  // one can resize a sibling during guarded action preparation. The finally
  // block closes this entire owned context after all delivery assertions.
  const paths = ['structured', 'generic', 'generic_submit', 'structured_prefill', 'same_body_race'].filter(value => !process.env.WEBBRAIN_QUALITY_CASE_FILTER
    || new RegExp(process.env.WEBBRAIN_QUALITY_CASE_FILTER).test(value));
  await Promise.all(paths.map(verifyPath));
  summaries.sort((a, b) => a.path.localeCompare(b.path));
  await fs.writeFile(path.join(out, 'summary.json'), JSON.stringify({ passed: true, accountsCreated: [], results: summaries }, null, 2));
} finally {
  await context?.close(); await new Promise(resolve => server.close(resolve));
  const resolved = path.resolve(profile);
  if (!resolved.startsWith(path.resolve(os.tmpdir()) + path.sep + 'webbrain-native-chat-mv3-'))
    throw new Error('Unexpected temporary profile path.');
  await fs.rm(resolved, { recursive: true, force: true });
}
