import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { chromium } from 'playwright';
import { fixedChoiceQuestion, fixtureFixedChoiceReply } from '../semantic-decision-stub.mjs';

// The questions a messaging page's own checks read its texts with.
const MESSAGING_TEXT_KINDS = ['message_control', 'message_field', 'message_author', 'message_status'];

// Whole installed MV3. Native selectors come from the privacy-safe current
// WhatsApp contact/header/drawer/message captures; all people, phones, bodies,
// opaque ids and network responses below belong only to this intercepted lab.
const out = path.resolve(process.env.WEBBRAIN_QUALITY_ARTIFACTS || 'ci/artifacts/quality-audit-2026-10-07/whatsapp-contact-mv3');
await fs.mkdir(out, { recursive: true });
const marker = 'OWNED_WA_CONTACT_MV3';
const scenario = process.argv.find(value => value.startsWith('--case='))?.slice(7) || 'positive';
assert.ok(['positive', 'action_guards_off', 'bootstrap_native', 'native_scroll_latest', 'native_prepared_repair', 'postwrite_debt', 'stop', 'stop_pending', 'steering', 'peer_switch', 'virtual_floor', 'restart_pending', 'restart_same_prompt', 'worker_resume', 'document_resume', 'late_drawer'].includes(scenario));
const guardsOff = scenario === 'action_guards_off';
const preparedCase = scenario === 'native_prepared_repair';
const latestCase = preparedCase || scenario === 'native_scroll_latest';
const restartCase = ['restart_pending', 'restart_same_prompt', 'worker_resume', 'document_resume', 'stop_pending'].includes(scenario);
const heldRestartCase = ['restart_pending', 'restart_same_prompt', 'document_resume', 'stop_pending'].includes(scenario);
const peer = 'WebBrain Contact QA';
// The native bootstrap run starts with only the user's phone. WhatsApp shows
// a saved name in its header and formats this number separately in Contact info.
const recipient = guardsOff ? '+15550100999' : scenario === 'bootstrap_native' ? '+15550100123' : peer;
const reply = 'Keep the recipient bound to its native contact identity and verify each new outgoing message before retrying.';
const task = guardsOff ? `In this isolated fixture, send the same QA message three times, exercising Send, Enter and chat_send. The requested number is ${recipient}. ${marker}` : `This is an isolated QA conversation with ${recipient}, the only authorized recipient in the open conversation. Answer its two existing questions together in one useful generated reply about browser-agent reliability. Verify that reply was delivered and stop after the contact confirms it was recorded. Do not send any other message. ${marker}`;
const fixtureUrl = 'https://web.whatsapp.com/?owned-contact-qa';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
// Keep a single real task bounded; the paired actual-Agent bootstrap suite
// checks every call/search/menu control independently without provoking the
// production nonprogress guard by repeating eight knowingly invalid clicks.
const bootstrapRejectedControls = ['whole header', 'Send'];
const textOf = value => typeof value === 'string' ? value : Array.isArray(value)
  ? value.filter(block => block?.type === 'text').map(block => block.text || '').join('\n') : '';
function toolObject(content) {
  const text = textOf(content);
  for (let start = text.indexOf('{'); start >= 0; start = text.indexOf('{', start + 1)) {
    let depth = 0, quoted = false, escaped = false;
    for (let cursor = start; cursor < text.length; cursor++) {
      const char = text[cursor];
      if (quoted) { if (escaped) escaped = false; else if (char === '\\') escaped = true; else if (char === '"') quoted = false; }
      else if (char === '"') quoted = true;
      else if (char === '{') depth++;
      else if (char === '}' && --depth === 0) { try { return JSON.parse(text.slice(start, cursor + 1)); } catch { break; } }
    }
  }
  return null;
}
function toolsOf(messages) {
  const names = new Map();
  for (const message of messages) for (const call of message.tool_calls || []) names.set(call.id, call.function?.name);
  return messages.filter(message => message.role === 'tool').map(message => ({ id: message.tool_call_id, name: names.get(message.tool_call_id) || message.name,
    result: toolObject(message.content), content: textOf(message.content) }));
}
function refFor(tree, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return String(tree || '').split('\n').find(line => new RegExp(`button "${escaped}"`).test(line))?.match(/\[(ref_\d+)\]/)?.[1];
}
const fixture = `<!doctype html><html><head><title>Owned native WhatsApp contact lab</title>
<style>body{margin:0;font:16px sans-serif;display:flex}aside{width:230px;padding:20px}#main{width:820px;padding:20px}header{height:70px;display:flex;align-items:center}button,[role=button]{padding:12px;font:inherit;cursor:pointer}[data-testid=conversation-panel-messages]{height:320px;overflow:auto}[role=row]{padding:8px}[data-testid=msg-container]{padding:10px;display:block}[data-testid=msg-meta]{display:inline-block}[data-icon]{display:inline-block;width:16px;height:16px}[contenteditable]{min-height:45px;border:1px solid #aaa;padding:10px}[data-testid=chat-info-drawer]{position:fixed;right:0;top:0;bottom:0;width:330px;background:white;border-left:2px solid #ddd;padding:18px;z-index:10}[data-testid=chat-info-drawer] span{display:block;padding:12px}</style></head><body>
<aside><div data-testid="chat-list"><div role="row"><div aria-selected="true"><span data-testid="cell-frame-title">${peer}</span></div></div>${preparedCase ? Array.from({ length: 45 }, (_, index) => `<div role="row" style="height:12px;padding:0;overflow:hidden;white-space:nowrap"><div role="button" tabindex="0" aria-selected="false" aria-label="Owned inert QA conversation ${index}: ${'bounded sidebar navigation metadata '.repeat(5)}" style="height:12px;line-height:12px;padding:0"><span data-testid="cell-frame-title">Owned inert QA conversation ${index}</span></div></div>`).join('') : ''}</div>${scenario === 'bootstrap_native' ? '<button aria-label="Unrelated QA control" id="qa-unrelated">Unrelated QA control</button>' : ''}</aside>
<div id="main" data-testid="conversation-panel-wrapper"><header data-testid="conversation-header"><div style="display:flex;align-items:center;flex:1"><div role="button" tabindex="0" aria-label="Avatar QA" data-qa-forbidden="true"><span>Avatar</span></div><div role="button" tabindex="0" data-testid="conversation-info-header" data-tab="6"><div><div><div data-testid="conversation-info-header-chat-title-name"><div><div><span data-testid="conversation-info-header-chat-title" dir="auto">${peer}</span></div></div></div></div></div></div></div><div style="display:flex">${['Voice call', 'Video call', 'Search', 'Menu'].map(label => `<button type="button" aria-label="${label}" data-qa-forbidden="true"><span>${label}</span></button>`).join('')}</div></header>
<div data-testid="conversation-panel-body"><div data-testid="conversation-panel-messages"></div></div><footer><div data-testid="conversation-compose-box-input" contenteditable="true" role="textbox" aria-placeholder="Type a message" data-tab="10" data-lexical-editor="true"></div><div id="qa-action-wrap"><button aria-label="${scenario === 'postwrite_debt' ? 'Voice message' : 'Send'}">${scenario === 'postwrite_debt' ? 'Voice' : 'Send'}</button></div></footer></div>
<script>
window.qaReplies=JSON.parse(sessionStorage.getItem('owned-qa-replies')||'[]');window.qaDrawer={opened:0,closed:0,avatarUpdates:0,hoverEvents:0,focusEvents:0,pressEvents:0,identityStable:true};window.qaDeliveryDelay=120;window.qaRemoveFloor=false;window.qaUnrelatedClicks=0;window.qaForbiddenClicks=0;window.qaEditor={handled:0,rerenders:0,enter:0,sendClicks:0};window.qaNativeInputs=[];
const transcript=document.querySelector('[data-testid="conversation-panel-messages"]'),composer=document.querySelector('[contenteditable]');
window.qaRow=(id,text,direction,tail=true)=>{const outer=document.createElement('div');outer.setAttribute('role','row');const row=document.createElement('div');row.dataset.id=id;row.dataset.testid='conv-msg-'+id;const container=document.createElement('div');container.dataset.testid='msg-container';const authored=document.createElement('div');authored.setAttribute('data-pre-plain-text','[10:00, 10/8/2026] '+(direction==='incoming'?'${peer}':'Owned QA')+': ');const body=document.createElement('span');body.dataset.testid='selectable-text';body.textContent=text;authored.append(body);container.append(authored);if(tail){const icon=document.createElement('span');icon.dataset.icon=direction==='incoming'?'tail-in':'tail-out';container.append(icon);}const meta=document.createElement('div');meta.dataset.testid='msg-meta';if(direction==='outgoing'){const delivered=document.createElement('span');delivered.setAttribute('aria-label','Delivered');delivered.textContent='✓✓';meta.append(delivered);}container.append(meta);row.append(container);outer.append(row);return outer;};
${latestCase ? "for(let index=0;index<46;index++)transcript.append(qaRow('QA'+String(index).padStart(18,'0'),'Earlier owned QA note '+index,'outgoing'));" : ''}
transcript.append(qaRow('${latestCase ? 'QA000000000000000046' : 'opaque_old_Z'}','Earlier unrelated QA outgoing note','outgoing'),qaRow('${latestCase ? 'QA000000000000000047' : 'opaque_first_X'}','How do we prevent sending to another contact?','incoming'),qaRow('${latestCase ? 'QA000000000000000048' : 'opaque_second_A'}','How do we prevent duplicate replies?','incoming',false));
for(const stored of qaReplies)transcript.append(qaRow('opaque_remounted_Q',stored,'outgoing'));
window.qaOpenDrawer=()=>{qaDrawer.opened++;const drawer=document.createElement('section');drawer.dataset.testid='chat-info-drawer';drawer.innerHTML='<header><button type="button" tabindex="0" data-tab="4" aria-label="Close"><span data-icon="x" aria-hidden="true">×</span></button></header><div><div data-testid="contact-info-header">Contact info</div><span data-testid="contact-info-subtitle selectable-text">${peer}</span><span data-testid="selectable-text">+1 (555) 010-0123</span><div data-qa-avatar><span data-testid="loading-spinner">Loading avatar</span></div></div>';const button=drawer.querySelector('button'),icon=button.querySelector('span'),subtitle=drawer.querySelector('[data-testid="contact-info-subtitle selectable-text"]'),phone=drawer.querySelector('[data-testid="selectable-text"]');const stable=()=>drawer.querySelector('[data-testid="contact-info-subtitle selectable-text"]')===subtitle&&drawer.querySelector('[data-testid="selectable-text"]')===phone&&subtitle.textContent==='${peer}'&&phone.textContent==='+1 (555) 010-0123';const decorate=kind=>{qaDrawer[kind+'Events']++;button.classList.add('qa-'+kind);icon.setAttribute('aria-label',kind==='press'?'Closing contact info':'Close contact info');qaDrawer.identityStable&&=stable();};button.addEventListener('pointerenter',()=>decorate('hover'));button.addEventListener('focus',()=>decorate('focus'));button.addEventListener('pointerdown',()=>decorate('press'));button.onclick=()=>{decorate('press');qaDrawer.closed++;qaDrawer.identityStable&&=stable();drawer.remove();};document.body.append(drawer);setTimeout(()=>{if(!drawer.isConnected)return;const avatar=document.createElement('span');avatar.textContent='Owned QA avatar';drawer.querySelector('[data-qa-avatar]').replaceChildren(avatar);qaDrawer.avatarUpdates++;qaDrawer.identityStable&&=stable();},20);};
document.querySelector('[data-testid="conversation-info-header"]').onclick=qaOpenDrawer;
document.querySelector('#qa-unrelated')?.addEventListener('click',()=>qaUnrelatedClicks++);
document.querySelectorAll('[data-qa-forbidden]').forEach(node=>node.addEventListener('click',()=>qaForbiddenClicks++));
window.qaSend=()=>{const text=composer.innerText.trim();if(!text)return;qaReplies.push(text);sessionStorage.setItem('owned-qa-replies',JSON.stringify(qaReplies));composer.replaceChildren();composer.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'deleteContentBackward'}));if(qaRemoveFloor)transcript.replaceChildren(qaRow('opaque_history_Q',text,'outgoing'));setTimeout(()=>{transcript.append(qaRow('opaque_new_B_'+qaReplies.length,text,'outgoing'));transcript.scrollTop=transcript.scrollHeight;setTimeout(()=>{transcript.append(qaRow('opaque_terminal_C','QA dialogue complete: the generated reply was recorded.','incoming'));transcript.scrollTop=transcript.scrollHeight;},140);},qaDeliveryDelay);};
composer.addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.shiftKey){qaEditor.enter++;e.preventDefault();qaSend();}});document.querySelector('#qa-action-wrap').onclick=e=>{if(e.target.closest('button')?.getAttribute('aria-label')==='Send'){qaEditor.sendClicks++;qaSend();}};
${scenario === 'postwrite_debt' ? `composer.addEventListener('beforeinput',e=>{qaNativeInputs.push({trusted:e.isTrusted,inputType:e.inputType,data:e.data});if(e.inputType!=='insertText'||qaEditor.handled)return;e.preventDefault();qaEditor.handled++;composer.textContent=e.data;setTimeout(()=>{qaEditor.rerenders++;document.querySelector('#qa-action-wrap').innerHTML='<button aria-label="Send">Send</button>';},15);});` : ''}
</script></body></html>`;
const intent = { request_kind: 'execute', scope_relation: 'new', requires_state_change: true, requires_submission: true,
  messaging: { target_kind: 'named', recipients: [recipient] }, deliverables: ['One generated reply answering both QA questions and independently verified delivery.'],
  expected_items: null, allows_planner_shaped_result: false, allows_app_state_tool_evidence: false,
  completion_requirements: { download: false }, read_scope: 'visible_page',
  summary: 'Answer the two questions together in one reply, verify native delivery and the final confirmation.',
  steps: [{ id: '1', action: 'Identify the authorized native contact, observe both questions, reply once and verify completion.' }],
  memory: { use_progress_ledger: false, progress_action: null }, scheduling: null, risks: [] };
const metrics = { calls: [], requests: 0, judges: 0, observedIncoming: [], blockedRemoteRequests: 0, externalMessages: 0, accountsCreated: [] };
let providerError = null, stage = 'initial', observation = null, repair = null, doneAttempts = 0, held = null, heldOnce = false, phase = 1, restartReads = 0;
async function consumeOwnedLatestRepair(messages, tools) {
  const issued = metrics.nativeLatestRepair, sequence = tools.slice(-3);
  assert.deepEqual(sequence.map(tool => tool.name), ['get_accessibility_tree', 'scroll', 'chat_observe']);
  assert.equal(new Set(sequence.map(tool => tool.id)).size, 3);
  const calls = messages.flatMap(message => message.role === 'assistant' ? message.tool_calls || [] : []);
  const actual = sequence.map(tool => {
    assert.match(tool.id, /^owned_chat_read_[a-f0-9-]+$/);
    const matches = calls.filter(call => call.id === tool.id);
    assert.equal(matches.length, 1, 'Each consumed result must have its actual ordinary assistant tool call.');
    assert.equal(matches[0].function?.name, tool.name);
    assert.notEqual(tool.result?.skipped, true); assert.notEqual(tool.result?.noDispatch, true);
    return { ...tool, args: JSON.parse(matches[0].function.arguments) };
  });
  const [tree, scroll, observed] = actual, fresh = observed.result;
  assert.deepEqual(tree.args, { ref_id: issued.ref });
  assert.ok(String(tree.result?.pageContent).includes(`[${issued.ref}]`));
  assert.deepEqual(scroll.args, { ref_id: issued.ref, direction: 'bottom' });
  assert.equal(scroll.result?.success, true); assert.equal(scroll.result?.movedContainer, true);
  assert.equal(scroll.result?.movedWindow, false); assert.equal(scroll.result?.origin, 'ref_id:' + issued.ref);
  assert.equal(scroll.result.containerScrollYBefore, scroll.result.containerScrollHeight
    - scroll.result.containerClientHeight - issued.before.gap);
  assert.equal(scroll.result.containerScrollY, scroll.result.containerScrollHeight - scroll.result.containerClientHeight);
  assert.deepEqual(observed.args, { reconcile_pending_outbound: false });
  assert.equal(fresh?.success, true); assert.equal(fresh.threadKey, issued.threadKey);
  assert.equal(fresh.composer?.ref, issued.composerRef); assert.equal(fresh.composer?.empty, true);
  assert.equal(fresh.chatWorkflow?.pendingOutbound, false);
  assert.equal(fresh.nativeChatReadRepair, undefined); assert.equal(fresh.nativeWhatsappRepair, undefined);
  assert.deepEqual(fresh.chatWorkflow.newMessages.map(row => row.text),
    ['How do we prevent sending to another contact?', 'How do we prevent duplicate replies?']);
  assert.ok(fresh.chatWorkflow.newMessages.every(row => row.direction === 'incoming'));
  assert.equal(new Set(fresh.chatWorkflow.newMessages.map(row => row.id)).size, 2);
  assert.equal(metrics.observedIncoming.length, 2);
  const scrollResults = tools.filter(tool => tool.name === 'scroll');
  const actualScrollResults = scrollResults.filter(tool => tool.result?.success === true
    && tool.result?.skipped !== true && tool.result?.noDispatch !== true);
  const skippedScrollResults = scrollResults.filter(tool => tool.id !== scroll.id);
  assert.equal(actualScrollResults.length, 1); assert.equal(actualScrollResults[0].id, scroll.id);
  assert.equal(skippedScrollResults.length, preparedCase ? 1 : 0);
  assert.ok(skippedScrollResults.every(tool => tool.result?.skipped === true
    && tool.result?.noDispatch === true && tool.result?.dispatched === false));
  assert.equal(calls.filter(call => call.function?.name === 'chat_send').length, 0);
  const transport = await worker.evaluate(() => __ownedLatestTransport.records);
  const paneReads = transport.filter(record => record.action === 'get_accessibility_tree' && record.ref_id === issued.ref);
  const paneScrolls = transport.filter(record => record.action === 'scroll' && record.ref_id === issued.ref);
  assert.equal(paneReads.length, 1); assert.equal(paneScrolls.length, 1);
  const paneRead = paneReads[0], paneScroll = paneScrolls[0];
  const freshRead = transport.find(record => record.sequence > paneScroll.sequence && record.action === 'observe_chat');
  assert.ok(freshRead); assert.ok(paneRead.sequence < paneScroll.sequence);
  assert.ok([paneRead, paneScroll, freshRead].every(record => record.ownerMatchesInitial
    && record.tabId === tabId && record.frameId === 0));
  assert.equal(paneRead.axDocumentMatchesInitial, true); assert.equal(paneScroll.success, true);
  assert.equal(freshRead.success, true); assert.equal(freshRead.threadKey, issued.threadKey);
  assert.equal(freshRead.composerRef, issued.composerRef); assert.equal(freshRead.readRepair, undefined);
  const guard = transport.filter(record => record.action === 'page_monitor_dispatch' && record.ref_id === issued.ref);
  assert.equal(guard.length, 1); assert.equal(guard[0].kind, 'scroll');
  assert.equal(guard[0].ready, true); assert.equal(guard[0].runMatchesInitial, true);
  assert.equal(guard[0].dispatchDocumentMatchesInitial, true);
  const captures = transport.filter(record => record.action === 'page_monitor_capture_model');
  assert.ok(captures.length); assert.ok(captures.every(record => record.ready && record.ownerMatchesInitial
    && record.runMatchesInitial && record.monitorDocumentMatchesInitial));
  const native = await page.evaluate(() => ({ gap: transcript.scrollHeight - transcript.clientHeight - transcript.scrollTop,
    replies: qaReplies.length, enter: qaEditor.enter, clicks: qaEditor.sendClicks,
    url: location.href, timeOrigin: performance.timeOrigin, peer: document.querySelector('[data-testid=conversation-info-header-chat-title]')?.textContent,
    composerEmpty: composer.textContent === '' }));
  assert.equal(native.gap, 0); assert.equal(native.replies, 0); assert.equal(native.enter, 0); assert.equal(native.clicks, 0);
  assert.deepEqual({ url: native.url, timeOrigin: native.timeOrigin, peer: native.peer, composerEmpty: native.composerEmpty },
    metrics.nativeLatestDocumentBefore);
  metrics.nativeLatestRepair.scopedRead = true; metrics.nativeLatestRepair.actualScroll = true;
  metrics.nativeLatestRepair.after = { gap: native.gap, replies: native.replies, enter: native.enter, clicks: native.clicks };
  metrics.nativeLatestRepair.ownedHandoff = { toolIds: actual.map(tool => tool.id), paneRef: issued.ref,
    sameOwner: true, sameRunAndMonitorDocument: true, sameAxDocument: true, sameNativeDocument: true,
    oneActualScroll: true, noSendBeforeRepair: true };
  return fresh;
}
const initialObservationCalls = new Set();
let initialObservationRetries = 0;
const server = http.createServer(async (request, response) => {
  try {
    assert.equal(request.url, '/v1/chat/completions');
    let body = ''; for await (const chunk of request) body += chunk;
    const input = JSON.parse(body); metrics.requests++; await sleep(240);
    if (input.messages?.length === 1 && input.messages[0].role === 'user' && textOf(input.messages[0].content) === 'Hi' && !input.tools?.length) {
      // Opening the real sidepanel runs its ordinary provider connectivity
      // probe. It has no task/tools and must not enter the fixture planner.
      metrics.connectivityProbes = (metrics.connectivityProbes || 0) + 1;
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'Hello.' }, finish_reason: 'stop' }] })); return;
    }
    if (textOf(input.messages?.[0]?.content).startsWith("Answer one fixed-choice question for a browser agent's safety check.")) {
      // WebBrain reads some short texts with a fixed-choice question (what a
      // final summary does, for example). This fixture's model reads only the
      // chat's own texts (what its controls and fields do, whose a message is,
      // what a status says), as a model would; other questions get no
      // reading, which leaves their checks as they were.
      metrics.fixedChoiceQuestions = (metrics.fixedChoiceQuestions || 0) + 1;
      const content = MESSAGING_TEXT_KINDS.includes(fixedChoiceQuestion(input.messages)?.kind)
        ? fixtureFixedChoiceReply(input.messages) : '{"choice":"","evidence":""}';
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }] })); return;
    }
    if (!JSON.stringify(input.messages).includes(marker)) {
      metrics.unmatchedRequest = { systemPrefix: textOf(input.messages?.[0]?.content).slice(0, 100),
        roles: input.messages?.map(message => message.role), lengths: input.messages?.map(message => textOf(message.content).length) };
    }
    assert.ok(JSON.stringify(input.messages).includes(marker), 'Each generation retains exact owned user task authority.');
    const system = textOf(input.messages[0]?.content), isJudge = system.startsWith('Evaluate only the observable requirements of the genuine user task');
    let completion;
    const corrected = JSON.stringify(input.messages).includes('STOP_SENDING_OBSERVE_ONLY');
    if (isJudge) { metrics.judges++; completion = { role: 'assistant', content: '{"outcome":"uncertain","reason":"Require independent exact native delivery proof."}' }; }
    else if (corrected && system.startsWith('You are the intent and compact planning subsystem for WebBrain')) completion = { role: 'assistant', content: JSON.stringify({ ...intent,
      request_kind: 'respond', requires_state_change: false, requires_submission: false, messaging: null,
      scope_relation: 'narrow', read_scope: 'none', summary: 'Explain that no reply was sent after the correction.', steps: [], deliverables: ['A brief explanation.'] }) };
    else if (corrected) completion = { role: 'assistant', content: 'No reply was sent; the newer instruction revoked sending.' };
    else if (!input.tools?.length) completion = { role: 'assistant', content: JSON.stringify(scenario === 'restart_pending' && phase === 2
      ? { ...intent, requires_state_change: false, requires_submission: false, messaging: null,
          summary: 'Read the uncertain interrupted delivery without sending or retrying.', deliverables: ['An honest delivery verification.'] }
      : intent) };
    else {
      const tools = toolsOf(input.messages), last = tools.at(-1);
      if (last?.name === 'chat_observe' && typeof last.result?.chatWorkflow?.pendingOutbound === 'boolean') {
        (metrics.pendingObservations ||= []).push({ phase, pending: last.result.chatWorkflow.pendingOutbound });
      }
      for (const tool of tools) for (const row of tool.result?.chatWorkflow?.newMessages || []) if (row.direction === 'incoming'
          && !metrics.observedIncoming.some(prior => prior.id === row.id)) metrics.observedIncoming.push({ id: row.id, text: row.text });
      if (last?.name === 'chat_observe' && last.result?.success) observation = last.result;
      const modelPage = input.messages.filter(message => message.role === 'user'
        && textOf(message.content).startsWith('[BROWSER STATE: current page observed immediately before this decision.'))
        .map(message => {
          const page = toolObject(message.content)?.page;
          return (typeof page === 'string' ? toolObject(page) : page)?.pageContent || '';
        }).at(-1) || '';
      const preparedTarget = (kind, ref) => (metrics.nativePreparedTargets ||= []).push({
        kind, ref, modelVisible: modelPage.includes(`[${ref}]`), modelObservationChars: modelPage.length,
      });
      if (stage === 'initial_observation_pending' && initialObservationCalls.has(last?.id)) {
        assert.equal(last.name, 'chat_observe', 'Consume only the exact current-phase native observation result.');
        (metrics.initialObservationResults ||= []).push({ phase, callId: last.id, success: last.result?.success });
        initialObservationCalls.clear();
        stage = 'observed';
      }
      let name, args = {};
      if (guardsOff && stage === 'observed') {
        observation = last.result;
        assert.equal(observation.success, true, last.content);
        stage = 'off_drafted'; name = 'set_field'; args = { ref_id: observation.composer.ref, text: reply, clear: true };
      } else if (stage === 'off_drafted') {
        assert.equal(await page.locator('[contenteditable]').innerText(), reply, last.content);
        stage = 'off_read_send'; name = 'get_accessibility_tree'; args = { filter: 'visible' };
      } else if (stage === 'off_read_send') {
        const ref = refFor(last.result?.pageContent || last.content, 'Send'); assert.ok(ref);
        stage = 'off_clicked'; name = 'click_ax'; args = { ref_id: ref };
      } else if (stage === 'off_clicked') {
        assert.equal(await page.evaluate(() => qaReplies.length), 1, last.content);
        stage = 'off_second'; name = 'set_field'; args = { ref_id: observation.composer.ref, text: reply, clear: true };
      } else if (stage === 'off_second') {
        assert.equal(await page.locator('[contenteditable]').innerText(), reply, last.content);
        stage = 'off_entered'; name = 'press_keys'; args = { key: 'Enter' };
      } else if (stage === 'off_entered') {
        assert.equal(await page.evaluate(() => qaReplies.length), 2, last.content);
        stage = 'off_chat_sent'; name = 'chat_send'; args = { thread_key: observation.threadKey, composer_ref: observation.composer.ref, text: reply };
      } else if (stage === 'off_chat_sent' && last.name === 'press_keys') {
        // Incoming page feedback may cancel a proposed model turn before
        // the tool executes. Re-propose only after inspecting our fixture.
        assert.equal(await page.evaluate(() => qaReplies.length), 2);
        assert.ok(metrics.calls.filter(call => call.name === 'chat_send').length < 3);
        name = 'chat_send'; args = { thread_key: observation.threadKey, composer_ref: observation.composer.ref, text: reply };
      } else if (stage === 'off_chat_sent') {
        assert.equal(last.name, 'chat_send', last.content);
        assert.equal(await page.evaluate(() => qaReplies.length), 3, last.content);
        assert.equal(last.result?.deliveryVerified, false, 'a dispatched Enter is not a delivery receipt');
        name = 'done'; args = { outcome: 'success', summary: 'The fixture recorded three submissions.' };
      } else if (latestCase && ['latest_read', 'latest_scrolled'].includes(stage) && last?.name === 'chat_observe') {
        observation = await consumeOwnedLatestRepair(input.messages, tools);
        stage = 'sent'; name = 'chat_send'; args = { thread_key: observation.threadKey,
          composer_ref: observation.composer.ref, text: reply };
      } else if (stage === 'initial') {
        initialObservationCalls.clear(); initialObservationRetries = 0;
        stage = preparedCase ? 'prepared_wrong_read' : 'initial_observation_pending';
        name = preparedCase ? 'get_accessibility_tree' : 'chat_observe';
        if (preparedCase) args = { filter: 'visible', maxChars: 12000 };
      }
      else if (stage === 'initial_observation_pending') {
        // Feedback can discard a proposed read before its handler executes.
        // A retained tool result from the interrupted run cannot advance the
        // new phase. Repeat only this read until its own real result arrives.
        assert.ok(++initialObservationRetries <= 3, 'Current native observation must settle within bounded read-only retries.');
        (metrics.initialObservationRetries ||= []).push({ phase, retainedTool: last?.name || null,
          retainedCallId: last?.id || null, proposedCallIds: [...initialObservationCalls] });
        name = 'chat_observe';
      }
      else if (stage === 'prepared_wrong_read') {
        assert.equal(last.name, 'get_accessibility_tree');
        const ref = refFor(last.result?.pageContent || last.content, 'Send');
        assert.ok(ref, 'Only an actually observed wrong Send ref may test the native recipient guard.');
        stage = 'prepared_wrong'; name = 'click_ax'; args = { ref_id: ref };
      } else if (stage === 'prepared_wrong') {
        assert.equal(last.name, 'click_ax'); assert.equal(last.result?.noDispatch, true);
        assert.equal(await page.evaluate(() => qaReplies.length), 0);
        assert.equal(await page.evaluate(() => qaDrawer.opened), 0);
        metrics.nativePreparedWrongSendBlocked = true;
        stage = 'initial_observation_pending'; name = 'chat_observe';
      }
      else if (stage === 'observed') {
        assert.equal(last.name, 'chat_observe');
        if (scenario === 'worker_resume' && phase === 2 && last.result?.success === true) {
          observation = last.result; stage = 'verified'; name = 'chat_observe';
        } else {
          assert.equal(last.result?.success, false, 'Each new owner must establish its own guarded canonical contact proof.');
          repair = last.result?.nativeWhatsappRepair;
          assert.equal(repair?.phase, 'open_contact', 'An unbound native contact must identify its exact guarded title carrier.');
          assert.match(repair.ref_id, /^ref_\d+$/);
          if (preparedCase) {
            preparedTarget('carrier', repair.ref_id);
            metrics.nativeBootstrapRef = { freshAx: modelPage.includes(`[${repair.ref_id}]`), titleCarrier: true };
            stage = 'header_clicked'; name = 'click_ax'; args = { ref_id: repair.ref_id };
          } else {
            stage = 'header_read'; name = 'get_accessibility_tree'; args = scenario === 'bootstrap_native'
              ? { filter: 'visible' } : { ref_id: repair.ref_id };
          }
        }
      }
      else if ((stage === 'header_read' && scenario === 'bootstrap_native') || stage === 'bootstrap_wrong_read') {
        const tree = String(last.result?.pageContent || last.content);
        const label = bootstrapRejectedControls[metrics.nativeBootstrapRejected?.length || 0];
        const ref = label === 'whole header' ? tree.match(/banner[^\n]*\[(ref_\d+)\]/)?.[1] : refFor(tree, label);
        assert.ok(ref, 'Use the freshly observed wrong-control ref: ' + label);
        stage = 'bootstrap_wrong'; name = 'click_ax'; args = { ref_id: ref };
      } else if (stage === 'bootstrap_wrong') {
        assert.equal(last.result?.noDispatch, true, 'Contact bootstrap may authorize only its exact native title carrier.');
        assert.equal(last.result?.messageRecipientGuard, true);
        (metrics.nativeBootstrapRejected ||= []).push(bootstrapRejectedControls[metrics.nativeBootstrapRejected?.length || 0]);
        const native = await page.evaluate(() => ({ replies: qaReplies.length, unrelatedClicks: qaUnrelatedClicks,
          forbiddenClicks: qaForbiddenClicks, drawer: qaDrawer.opened, enters: qaEditor.enter, sendClicks: qaEditor.sendClicks }));
        assert.deepEqual(native, { replies: 0, unrelatedClicks: 0, forbiddenClicks: 0, drawer: 0, enters: 0, sendClicks: 0 });
        if (metrics.nativeBootstrapRejected.length < bootstrapRejectedControls.length) {
          stage = 'bootstrap_wrong_read'; name = 'get_accessibility_tree'; args = { filter: 'visible' };
        } else { stage = 'bootstrap_repair_observed'; name = 'chat_observe'; }
      } else if (stage === 'bootstrap_repair_observed') {
        assert.equal(last.name, 'chat_observe'); assert.equal(last.result?.success, false);
        repair = last.result?.nativeWhatsappRepair; assert.equal(repair?.phase, 'open_contact');
        assert.match(repair.ref_id, /^ref_\d+$/);
        stage = 'bootstrap_header_read'; name = 'get_accessibility_tree'; args = { ref_id: repair.ref_id };
      } else if (stage === 'header_read' || stage === 'bootstrap_header_read') {
        assert.equal(last.name, 'get_accessibility_tree');
        const tree = String(last.result?.pageContent || last.content);
        // Use the actual native title carrier observed in this fresh tree.
        // Its current native name is nested under noninteractive wrappers.
        const ref = repair.ref_id;
        assert.ok(tree.includes(`[${ref}]`), 'The exact tool-returned carrier must occur in the fresh anchored AX read.');
        metrics.nativeBootstrapRef = { freshAx: true, titleCarrier: true };
        stage = 'header_clicked'; name = 'click_ax'; args = { ref_id: ref };
      } else if (stage === 'header_clicked') { assert.equal(last.result?.success, true, last.content); stage = 'drawer_observed'; name = 'chat_observe'; }
      else if (stage === 'drawer_observed') {
        assert.equal(last.name, 'chat_observe'); assert.equal(last.result?.success, false);
        repair = last.result?.nativeWhatsappRepair; assert.equal(repair?.phase, 'close_contact');
        assert.match(repair.ref_id, /^ref_\d+$/);
        // Exercise native hover/focus decoration before the explicit fresh
        // scoped read. Agent identity repair and Close still run through the
        // actual guarded tool path; this pointer movement dispatches nothing.
        const close = page.locator('[data-testid="chat-info-drawer"] header button[aria-label="Close"]');
        await close.hover(); await close.focus();
        if (preparedCase) {
          preparedTarget('close', repair.ref_id);
          stage = 'prepared_drawer_closed'; name = 'click_ax'; args = { ref_id: repair.ref_id };
        } else { stage = 'drawer_read'; name = 'get_accessibility_tree'; args = { ref_id: repair.ref_id }; }
      }
      else if (stage === 'drawer_read') {
        // Native focus/hover feedback can supersede the response containing
        // the first read before its handler executes. Wait for an actual AX
        // tool result rather than advancing from merely proposed tool output.
        if (last.name === 'chat_observe') {
          assert.equal(last.result?.nativeWhatsappRepair?.phase, 'close_contact');
          assert.ok((metrics.nativeCloseReadRefreshes = (metrics.nativeCloseReadRefreshes || 0) + 1) <= 3,
            'The bounded native Close activity must settle before its fresh scoped read.');
          repair = last.result.nativeWhatsappRepair;
          name = 'get_accessibility_tree'; args = { ref_id: repair.ref_id };
        } else {
          assert.equal(last.name, 'get_accessibility_tree');
          const tree = String(last.result?.pageContent || last.content), ref = repair.ref_id;
          assert.ok(tree.includes(`[${ref}]`), 'Use the actual current tool-returned Close ref after its anchored AX read.');
          stage = 'drawer_closed'; name = 'click_ax'; args = { ref_id: ref };
        }
      } else if (stage === 'prepared_drawer_closed') {
        if (last.name === 'chat_observe') {
          assert.equal(last.result?.nativeWhatsappRepair?.phase, 'close_contact');
          assert.ok((metrics.nativePreparedCloseRefreshes = (metrics.nativePreparedCloseRefreshes || 0) + 1) <= 3);
          repair = last.result.nativeWhatsappRepair; preparedTarget('close', repair.ref_id);
          name = 'click_ax'; args = { ref_id: repair.ref_id };
        } else {
          assert.equal(last.name, 'click_ax'); assert.equal(last.result?.success, true, last.content);
          assert.equal(last.result?._nativeWhatsappReadRepair, true);
          stage = 'bound'; name = 'chat_observe';
        }
      } else if (stage === 'drawer_closed') { assert.equal(last.result?.success, true, last.content); stage = 'bound'; name = 'chat_observe'; }
      else if (stage === 'bound') {
        if (latestCase && metrics.nativeLatestRepair?.actualScroll && last.name === 'scroll') {
          assert.ok((metrics.nativeLatestObserveRefreshes = (metrics.nativeLatestObserveRefreshes || 0) + 1) <= 3,
            'The native scroll feedback must settle before the explicit fresh observation.');
          name = 'chat_observe';
        } else {
        assert.equal(last.name, 'chat_observe');
        assert.equal(last.result?.success, true, 'Fresh guarded native drawer proof must establish a general contact: ' + last.content);
        assert.ok(observation?.threadKey && observation?.composer?.ref);
        if (latestCase && !metrics.nativeLatestRepair) {
          const hint = last.result?.nativeChatReadRepair;
          assert.equal(hint?.phase, 'read_latest', 'A verified native contact outside its latest viewport must expose its scoped read repair.');
          assert.equal(hint.direction, 'bottom'); assert.match(hint.ref_id, /^ref_\d+$/);
          const native = await page.evaluate(() => ({ replies: qaReplies.length, enter: qaEditor.enter,
            clicks: qaEditor.sendClicks, gap: transcript.scrollHeight - transcript.clientHeight - transcript.scrollTop,
            rows: transcript.querySelectorAll('[role="row"] [data-id][data-testid^="conv-msg-"]').length }));
          assert.equal(native.replies, 0); assert.equal(native.enter, 0); assert.equal(native.clicks, 0);
          assert.ok(Math.abs(native.gap - 246.667) <= 1); assert.equal(native.rows, 49);
          assert.equal(metrics.observedIncoming.length, 0, 'Historical mounted rows must not claim latest-message completeness.');
          metrics.nativeLatestRepair = { before: native, ref: hint.ref_id, threadKey: observation.threadKey, composerRef: observation.composer.ref };
          if (preparedCase) {
            preparedTarget('transcript', hint.ref_id);
            metrics.nativeLatestRepair.scopedRead = modelPage.includes(`[${hint.ref_id}]`);
            stage = 'latest_scrolled'; name = 'scroll'; args = { ref_id: hint.ref_id, direction: 'bottom' };
          } else { stage = 'latest_read'; name = 'get_accessibility_tree'; args = { ref_id: hint.ref_id }; }
        } else {
        if (phase === 1) assert.equal(metrics.observedIncoming.length, 2,
          'Tail-in plus continuous same-sender no-tail question must both be observed.');
        if (restartCase && phase === 2) { stage = 'verified'; name = 'chat_observe'; }
        else { stage = 'sent'; name = 'chat_send'; args = { thread_key: observation.threadKey, composer_ref: observation.composer.ref, text: reply }; }
        }
        }
      } else if (stage === 'latest_read') {
        assert.equal(last.name, 'get_accessibility_tree');
        assert.ok(String(last.result?.pageContent || last.content).includes(`[${metrics.nativeLatestRepair.ref}]`));
        metrics.nativeLatestRepair.scopedRead = true;
        stage = 'latest_scrolled'; name = 'scroll'; args = { ref_id: metrics.nativeLatestRepair.ref, direction: 'bottom' };
      } else if (stage === 'latest_scrolled') {
        assert.equal(last.name, 'scroll'); assert.equal(last.result?.success, true, last.content);
        const native = await page.evaluate(() => ({ gap: transcript.scrollHeight - transcript.clientHeight - transcript.scrollTop,
          replies: qaReplies.length, enter: qaEditor.enter, clicks: qaEditor.sendClicks }));
        assert.ok(Math.abs(native.gap) <= 4); assert.equal(native.replies, 0); assert.equal(native.enter, 0); assert.equal(native.clicks, 0);
        metrics.nativeLatestRepair.after = native; metrics.nativeLatestRepair.actualScroll = true;
        stage = 'bound'; name = 'chat_observe';
      } else if (stage === 'sent') {
        if (scenario === 'postwrite_debt' && !metrics.postwriteAttempt) {
          const native = await page.evaluate(() => ({ editor: qaEditor, replies: qaReplies.length, draft: composer.innerText, inputs: qaNativeInputs }));
          assert.equal(native.editor.handled, 1); assert.equal(native.editor.rerenders, 1);
          assert.equal(native.editor.enter, 0); assert.equal(native.editor.sendClicks, 0); assert.equal(native.replies, 0);
          assert.equal(native.draft, reply, 'A readonly certificate must preserve the exact page-owned native draft.');
          assert.equal(last.name, 'chat_send'); assert.equal(last.result?.dispatch?.verified, true, last.content);
          assert.deepEqual(native.inputs, [{ trusted: true, inputType: 'insertText', data: reply }],
            'The controlled editor must receive one real browser input, without synthetic transport provenance.');
          assert.equal(last.result?.dispatch?.trusted, true, last.content);
          assert.equal(last.result?.dispatch?.method, 'set_field_cdp_fallback', last.content);
          assert.equal(last.result?.dispatch?.pageHandledBeforeInput, undefined, last.content);
          assert.equal(last.result?.dispatch?.submitted, false, last.content);
          assert.equal(last.result?.dispatch?.submissionDispatched, false, last.content);
          assert.equal(last.result?.dispatch?.submissionBlockedBeforeDispatch, true, last.content);
          assert.equal(last.result?.dispatch?.submissionOutcomeUnknown, false, last.content);
          assert.equal(last.result?.dispatch?.outcomeUnknown, true, last.content);
          assert.equal(last.result?.dispatch?.retryable, false, last.content);
          assert.equal(last.result?.chatWorkflow?.pendingOutbound, true, last.content);
          metrics.postwriteAttempt = { verifiedDraft: true, entered: false, clicked: false, pending: true };
          stage = 'postwrite_read'; name = 'get_accessibility_tree'; args = { filter: 'visible' };
        } else
        if (scenario === 'peer_switch') {
          // Native selection feedback may suppress the prepared send before
          // its handler is called; either boundary must retain no dispatch.
          // The run's one contact check is spent once the selection changed,
          // and the observation before the send says so, final.
          assert.ok(last.result?.noDispatch === true || last.result?.reason === 'chat_root_unverified'
            || (last.result?.reason === 'native_whatsapp_contact_check_spent' && last.result?.retryable === false), last.content);
          name = 'done'; args = { outcome: 'partial', summary: 'The native contact changed; no reply was dispatched.' };
        }
        else { assert.notEqual(last.result?.dispatched, false, last.content); stage = 'verified'; name = 'chat_observe'; }
      } else if (stage === 'postwrite_read') {
        assert.equal(last.name, 'get_accessibility_tree');
        const ref = refFor(last.result?.pageContent || last.content, 'Send'); assert.ok(ref, 'Read the new native Send button after the footer rerender.');
        stage = 'postwrite_blocked_send'; name = 'click_ax'; args = { ref_id: ref };
      } else if (stage === 'postwrite_blocked_send') {
        assert.equal(last.name, 'click_ax'); assert.equal(last.result?.noDispatch, true, last.content);
        assert.equal(await page.evaluate(() => qaReplies.length), 0);
        metrics.postwriteAttempt.freshSendBlocked = true;
        stage = 'postwrite_pending'; name = 'chat_observe';
      } else if (stage === 'postwrite_pending') {
        assert.equal(last.result?.chatWorkflow?.pendingOutbound, true, last.content);
        assert.ok(last.result?.chatWorkflow?.pendingOutboundKey);
        stage = 'postwrite_reconciled'; name = 'chat_observe'; args = { reconcile_pending_outbound: true,
          pending_outbound_key: last.result.chatWorkflow.pendingOutboundKey };
      } else if (stage === 'postwrite_reconciled') {
        assert.equal(last.result?.success, true, last.content); assert.equal(last.result?.chatWorkflow?.pendingOutbound, false, last.content);
        metrics.postwriteAttempt.manuallyReconciled = true;
        assert.ok(last.result.composer?.ref); stage = 'postwrite_cleared'; name = 'set_field'; args = { ref_id: last.result.composer.ref, text: '', clear: true, submit: false };
      } else if (stage === 'postwrite_cleared') {
        assert.equal(last.result?.success, true, last.content); assert.equal(last.result?.verified, true, last.content);
        // Native editing may retain its sole caret BR; the shipped semantic
        // readback must still prove empty rather than treating it as a body.
        assert.equal(await page.evaluate(() => composer.textContent), '');
        stage = 'postwrite_clear_read'; name = 'get_accessibility_tree'; args = { filter: 'visible' };
      } else if (stage === 'postwrite_clear_read') {
        assert.equal(last.name, 'get_accessibility_tree'); stage = 'postwrite_ready'; name = 'chat_observe';
      } else if (stage === 'postwrite_ready') {
        assert.equal(last.result?.success, true, last.content); assert.equal(last.result?.chatWorkflow?.pendingOutbound, false, last.content);
        assert.equal(last.result.composer?.empty, true); stage = 'sent'; name = 'chat_send';
        args = { thread_key: last.result.threadKey, composer_ref: last.result.composer.ref, text: reply };
      } else if (stage === 'verified') {
        // A fresh incoming bubble can arrive while this observation response
        // is generated. The actual Agent then consumes page feedback and
        // discards that pre-change response before dispatch. Read again;
        // never repeat the uncertain already dispatched message.
        assert.ok(['chat_send', 'chat_observe', 'done'].includes(last.name));
        if (last.name === 'chat_observe') assert.equal(last.result?.success, true, last.content);
        const deliveries = tools.filter(tool => tool.result?.chatDeliveryVerification || tool.result?.chatGoalDeliveryVerification || tool.result?.chatDeliveryProgress);
        if (last.result?.chatDeliveryVerification || last.result?.chatGoalDeliveryVerification) {
          (metrics.nativeDeliveryProofs ||= []).push({ phase, current: !!last.result.chatDeliveryVerification,
            priorGoal: !!last.result.chatGoalDeliveryVerification });
        }
        if (heldRestartCase && phase === 2 && ++restartReads >= 2) {
          assert.equal(last.result?.chatWorkflow?.pendingOutbound, true, 'A new owner must not borrow the old opaque delivery floor.');
          name = 'done'; args = { outcome: 'partial', summary: 'One reply was dispatched before interruption. Its lost private continuity remains unverified; no resend occurred.' };
        } else if (!deliveries.length || !metrics.observedIncoming.some(row => row.text.startsWith('QA dialogue complete:'))) { name = 'chat_observe'; }
        else { doneAttempts++; assert.ok(doneAttempts <= 3); name = 'done'; args = { outcome: 'success', summary: 'Both QA questions answered in one generated native delivered reply and terminal confirmation observed.' }; }
      } else throw Error('Unknown fixture stage');
      metrics.calls.push({ name, args });
      const callId = `owned-wa-${metrics.calls.length}`;
      if (stage === 'initial_observation_pending') {
        assert.equal(name, 'chat_observe'); initialObservationCalls.add(callId);
      }
      completion = { role: 'assistant', content: '', tool_calls: [{ id: callId, type: 'function', function: { name, arguments: JSON.stringify(args) } }] };
      if (['stop', 'steering', 'peer_switch'].includes(scenario) && name === 'chat_send' && !heldOnce) {
        heldOnce = true;
        await new Promise(resolve => { held = { release: resolve }; });
        held = null;
      }
      if (restartCase && phase === 1 && name === 'chat_observe' && stage === 'verified' && !heldOnce) {
        heldOnce = true; await new Promise(resolve => { held = { release: resolve }; }); held = null;
      }
      if (scenario === 'late_drawer' && phase === 1 && name === 'click_ax' && stage === 'drawer_closed' && !heldOnce) {
        heldOnce = true; await new Promise(resolve => { held = { release: resolve }; }); held = null;
      }
    }
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ id: `completion-${metrics.requests}`, choices: [{ message: completion, finish_reason: completion.tool_calls ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 30 } }));
  } catch (error) { providerError ||= error.message; response.writeHead(500, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ error: error.message })); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'webbrain-whatsapp-contact-mv3-'));
let context, harness, page, worker, tabId, run;
async function runInstalledFixture() {
  const extension = path.join(profile, 'owned-extension');
  await fs.cp(path.resolve(process.env.WEBBRAIN_QUALITY_EXTENSION || 'src/chrome'), extension, { recursive: true });
  metrics.sourceSha256 = Object.fromEntries(await Promise.all(['agent/agent.js', 'agent/completion-invariant.js', 'agent/whatsapp-recipient.js', 'content/whatsapp-phone.js', 'content/chat-observation.js', 'content/content.js'].map(async name =>
    [name, createHash('sha256').update(await fs.readFile(path.join(extension, 'src', name))).digest('hex')])));
  await fs.appendFile(path.join(extension, 'src/background.js'), '\nglobalThis.__ownedWhatsAppBoot = crypto.randomUUID();\n');
  if (scenario === 'postwrite_debt') await fs.appendFile(path.join(extension, 'src/background.js'),
    '\nimport { cdpClient as ownedClearCdp } from "./cdp/cdp-client.js"; globalThis.__ownedClearCdp = ownedClearCdp;\n');
  if (scenario === 'postwrite_debt') await fs.appendFile(path.join(extension, 'src/ui/sidepanel.js'), `
// Owned installed test access to the shipped module's actual card renderer.
globalThis.__ownedWhatsAppRenderPending = async (tabId, prompt) => {
  currentTabId = tabId; await loadTabChat(tabId);
  if (document.querySelector('.clarify-card[data-clarify-id="' + prompt.clarifyId + '"]')) return;
  currentAssistantEl = addMessage('assistant', ''); renderClarifyCard(prompt);
};
`);
  if (process.env.WEBBRAIN_QUALITY_WA_DIAGNOSTIC === '1') await fs.appendFile(path.join(extension, 'src/background.js'), `
globalThis.__ownedWhatsAppDiagnostics = [];
globalThis.__ownedWhatsAppSnapshot = tabId => {
  const guard = agent._planExecutionGuards.get(tabId), state = agent.completionInvariants.get(tabId);
  const receipt = agent.chatSessions.get(tabId)?.completionReceipt;
  return { guard: !!guard, requiresSubmission: guard?.requiresSubmission === true,
    verifiedSubmission: guard?.verifiedSubmissionEvidence === true,
    evidenceTaskMatches: !!guard?.taskKey && guard.evidenceTaskKey === guard.taskKey,
    currentTaskMatches: !!guard?.taskKey && agent._progressTaskKeyHash(tabId) === guard.taskKey,
    successfulTasks: guard?.successfulTaskToolCalls || 0, successfulConsequential: guard?.successfulConsequentialToolCalls || 0,
    hadAction: state?.hadAction === true, lastAction: !!state?.lastAction, sequence: state?.sequence || 0,
    verificationDebt: state?.verificationDebt === true, receipt: !!receipt,
    receiptMatchesGoal: !!receipt && agent._chatCompletionReceiptMatchesGoal(tabId, receipt),
    originRunMatchesCurrent: !!receipt && receipt.originRunToken === state?.runToken,
    guardNativeEvidence: !!guard?.nativeChatDeliveryEvidence,
    mode: agent._effectiveRunMode(tabId), actionMode: agent._isActionMode(agent._effectiveRunMode(tabId)) };
};
for (const name of ['_nativeChatTerminalEvidence', '_completionSubmissionEvidence', '_executionEvidenceSatisfied']) {
  const original = agent[name];
  agent[name] = function (...args) {
    const result = Reflect.apply(original, this, args);
    const tabId = name === '_executionEvidenceSatisfied'
      ? [...this._planExecutionGuards].find(entry => entry[1] === args[0])?.[0] : args[0];
    if (__ownedWhatsAppDiagnostics.length < 80) __ownedWhatsAppDiagnostics.push({ name,
      state: __ownedWhatsAppSnapshot(tabId), result: name === '_executionEvidenceSatisfied' ? result : !!result,
      priorVerifiedGoal: result?.priorVerifiedGoal === true, verifiedFinalSubmit: result?.verifiedFinalSubmit === true,
      inputGoal: args[1]?.chatGoalDeliveryVerification?.schema === 'webbrain-chat-goal-completion/1' });
    return result;
  };
}
import { cdpClient as ownedDiagnosticCdp } from './cdp/cdp-client.js';
for (const [object, name, doneOnly] of [[agent, '_executeToolImpl', true], [agent, '_captureViewportProbe', false],
  [ownedDiagnosticCdp, 'attach', false], [ownedDiagnosticCdp, 'sendCommand', false]]) {
  const original = object[name];
  object[name] = function (...args) {
    if (doneOnly && args[1] !== 'done') return Reflect.apply(original, this, args);
    const record = data => { if (__ownedWhatsAppDiagnostics.length < 120)
      __ownedWhatsAppDiagnostics.push({ name, command: name === 'sendCommand' ? args[1] : undefined,
        ...(object === agent ? { state: __ownedWhatsAppSnapshot(args[0]) } : {}), ...data }); };
    try {
      return Promise.resolve(Reflect.apply(original, this, args)).then(result => {
        if (doneOnly) record({ internalDone: result?.done === true, outcome: result?.outcome,
          verificationPresent: !!result?.verification, completionWarning: !!result?.verification?.completionWarning,
          blockedDone: result?.blockedDone === true, completionOutcome: result?.completionDecision?.outcome });
        return result;
      }, error => { record({ errorCode: String(error?.code || ''), error: String(error?.message || error).slice(0, 180) }); throw error; });
    } catch (error) { record({ errorCode: String(error?.code || ''), error: String(error?.message || error).slice(0, 180) }); throw error; }
  };
}
`);
  context = await chromium.launchPersistentContext(profile, { headless: true, channel: 'chromium', viewport: { width: 1280, height: 900 },
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`, '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1'] });
  await context.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.origin === 'https://web.whatsapp.com') return route.fulfill({ contentType: 'text/html', body: fixture });
    if (url.hostname === '127.0.0.1' || url.protocol === 'chrome-extension:') return route.continue();
    metrics.blockedRemoteRequests++; return route.abort('blockedbyclient');
  });
  worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  await worker.evaluate(() => { const native = fetch.bind(globalThis); globalThis.fetch = (input, options) => {
    const url = new URL(typeof input === 'string' ? input : input.url);
    return url.hostname === '127.0.0.1' || ['chrome-extension:', 'data:', 'blob:'].includes(url.protocol)
      ? native(input, options) : Promise.reject(new Error('Owned lab blocks external worker requests.')); }; });
  if (scenario === 'postwrite_debt') await worker.evaluate(async () => {
    globalThis.__ownedClearTransport = [];
    const send = chrome.tabs.sendMessage.bind(chrome.tabs);
    chrome.tabs.sendMessage = async (...args) => {
      const result = await send(...args), action = args[1]?.action;
      if (['ax_prepare_native_chat_clear', 'ax_verify_native_chat_clear', 'ax_release_native_chat_clear'].includes(action))
        __ownedClearTransport.push({ action, success: result?.success, hasToken: !!result?.token });
      return result;
    };
    const cdpClient = __ownedClearCdp;
    const capture = cdpClient.captureTextClearReceipt.bind(cdpClient);
    cdpClient.captureTextClearReceipt = async (...args) => {
      const receipt = await capture(...args);
      __ownedClearTransport.push({ action: 'captureTextClearReceipt', captured: !!receipt });
      return receipt && { ...receipt, async verify() {
        const verified = await receipt.verify();
        __ownedClearTransport.push({ action: 'verifyTextClearReceipt', verified }); return verified;
      } };
    };
  });
  if (latestCase) await worker.evaluate(() => {
    globalThis.__ownedLatestTransport = { records: [] };
    let owner = '', monitorDocument = '', axDocument = '', runToken = '';
    const send = chrome.tabs.sendMessage.bind(chrome.tabs);
    chrome.tabs.sendMessage = async (tabId, message, options) => {
      const result = await send(tabId, message, options);
      if (!['page_monitor_capture_model', 'page_monitor_prepare', 'page_monitor_dispatch',
        'get_accessibility_tree', 'scroll', 'observe_chat'].includes(message.action)) return result;
      const params = message.params || {}, currentOwner = params._nativeChatOwner || params.nativeChatOwner || '';
      if (message.action === 'page_monitor_capture_model') {
        if (!owner && params.nativeChatOwner) owner = params.nativeChatOwner;
        if (!monitorDocument && result?.documentToken) monitorDocument = result.documentToken;
        if (!axDocument && result?.page?.documentToken) axDocument = result.page.documentToken;
        if (!runToken && params.runToken) runToken = params.runToken;
      }
      if (!axDocument && message.action === 'get_accessibility_tree' && result?.documentToken)
        axDocument = result.documentToken;
      const expectedAx = params.expectedDocumentToken;
      const dispatchDocument = params.dispatchBinding?.documentToken || result?.guard?.documentToken;
      __ownedLatestTransport.records.push({ sequence: __ownedLatestTransport.records.length + 1,
        action: message.action, ref_id: params.ref_id, direction: params.direction,
        kind: params.kind, toolName: params.toolName, tabId, frameId: options?.frameId ?? 0,
        hasOwner: !!currentOwner, ownerMatchesInitial: !!owner && currentOwner === owner,
        runMatchesInitial: params.runToken ? params.runToken === runToken : null,
        ready: result?.ready, success: result?.success, noDispatch: result?.noDispatch,
        monitorDocument: message.action === 'page_monitor_capture_model' ? result?.documentToken : undefined,
        monitorDocumentMatchesInitial: message.action === 'page_monitor_capture_model'
          ? !!monitorDocument && result?.documentToken === monitorDocument : undefined,
        axDocument: message.action === 'get_accessibility_tree' ? result?.documentToken : result?.page?.documentToken,
        axDocumentMatchesInitial: (result?.documentToken && message.action === 'get_accessibility_tree')
          ? result.documentToken === axDocument : result?.page?.documentToken ? result.page.documentToken === axDocument : undefined,
        expectedAxDocumentMatchesInitial: expectedAx ? expectedAx === axDocument : null,
        dispatchDocumentMatchesInitial: dispatchDocument ? dispatchDocument === monitorDocument : null,
        threadKey: result?.threadKey, composerRef: result?.composer?.ref,
        readRepair: result?.nativeChatReadRepair, pendingOutbound: result?.chatWorkflow?.pendingOutbound,
      });
      return result;
    };
  });
  const extensionId = new URL(worker.url()).host;
  harness = await context.newPage(); await harness.goto(`chrome-extension://${extensionId}/src/ui/settings.html`);
  const message = (action, data = {}) => harness.evaluate(({ action, data }) => chrome.runtime.sendMessage({ target: 'background', action, ...data }), { action, data });
  await harness.evaluate(async scenario => { window.qaRun = { finished: false, events: [] }; chrome.runtime.onMessage.addListener(event => {
    if (event.action === 'agent_update' && event.requestId === 'owned-wa-contact') qaRun.events.push({ type: event.type, data: event.data }); });
    await chrome.storage.local.set({ helpImproveWebBrain: false, planBeforeActMode: 'off', planBeforeAct: false, planReviewMode: 'never',
      screenshotFallback: false, autoScreenshot: false, visionMode: 'off', maxAgentSteps: scenario === 'postwrite_debt' ? 32 : scenario === 'bootstrap_native' ? 28 : 20, systemOneEnabled: false, tracingEnabled: false,
      agentAllowLocalNetwork: true, askBeforeConsequentialActions: false, openaiAskStreamingEnabled: false,
      ...(scenario === 'postwrite_debt' ? { onboardingComplete: true, pinCoachmarkPending: false } : {}) }); }, scenario);
  if (guardsOff) {
    await harness.locator('[data-tab="advanced"]').click();
    const toggle = harness.locator('#toggle-enforce-action-guards');
    assert.equal(await toggle.isChecked(), true);
    await toggle.locator('..').click();
    await harness.waitForFunction(async () => (await chrome.storage.local.get('enforceActionGuards')).enforceActionGuards === false);
  }
  assert.equal((await message('update_provider', { providerId: 'openrouter', config: { apiKey: 'owned-fixture-fake-key',
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`, model: 'minimax/minimax-m3', contextWindow: 1000000, enabled: true, supportsAskStreaming: false } })).ok, true);
  assert.equal((await message('set_active_provider', { providerId: 'openrouter' })).ok, true);
  page = await context.newPage(); await page.goto(fixtureUrl);
  if (latestCase) await page.evaluate(() => {
    transcript.scrollTop = transcript.scrollHeight - transcript.clientHeight - 246.667;
  });
  if (latestCase) {
    metrics.nativeLatestInitial = await page.evaluate(() => ({
      gap: transcript.scrollHeight - transcript.clientHeight - transcript.scrollTop,
      rows: transcript.querySelectorAll('[role="row"] [data-id][data-testid^="conv-msg-"]').length,
      idsAreOpaque20Chars: [...transcript.querySelectorAll('[data-id]')].every(row => /^[A-Za-z0-9_-]{20}$/.test(row.dataset.id)),
      replies: qaReplies.length, enter: qaEditor.enter, clicks: qaEditor.sendClicks,
    }));
    assert.ok(Math.abs(metrics.nativeLatestInitial.gap - 246.667) <= 1);
    assert.equal(metrics.nativeLatestInitial.rows, 49); assert.equal(metrics.nativeLatestInitial.idsAreOpaque20Chars, true);
  }
  if (scenario === 'virtual_floor') await page.evaluate(() => { qaRemoveFloor = true; });
  if (restartCase) await page.evaluate(() => { qaDeliveryDelay = 4000; });
  tabId = await harness.evaluate(async url => (await chrome.tabs.query({})).find(tab => tab.url === url)?.id, fixtureUrl); assert.ok(tabId);
  if (latestCase) metrics.nativeLatestDocumentBefore = await page.evaluate(() => ({ url: location.href,
    timeOrigin: performance.timeOrigin, peer: document.querySelector('[data-testid=conversation-info-header-chat-title]')?.textContent,
    composerEmpty: composer.textContent === '' }));
  const started = Date.now();
  await harness.evaluate(({ tabId, text }) => { chrome.runtime.sendMessage({ target: 'background', action: 'chat', tabId, text,
    mode: 'act', requestId: 'owned-wa-contact', locale: 'en' }).then(result => { qaRun.result = result; qaRun.finished = true; },
    error => { qaRun.result = { error: error.message }; qaRun.finished = true; }); }, { tabId, text: task });
  if (scenario === 'postwrite_debt') {
    await harness.waitForFunction(() => qaRun.events.some(event => event.type === 'clarify' && event.data?.pendingReconciliation === true)
      || qaRun.finished, null, { timeout: 30000 });
    const prompt = await harness.evaluate(() => qaRun.events.findLast(event => event.type === 'clarify' && event.data?.pendingReconciliation === true)?.data);
    assert.ok(prompt, 'Only the app-owned pending-send reconciliation prompt may authorize recovery.');
    const native = await page.evaluate(() => ({ replies: qaReplies.length, draft: composer.innerText,
      enters: qaEditor.enter, clicks: qaEditor.sendClicks }));
    assert.deepEqual(native, { replies: 0, draft: reply, enters: 0, clicks: 0 }, 'The manual operator independently proves no native Send callback occurred.');
    const panel = await context.newPage(); await panel.goto(`chrome-extension://${extensionId}/src/ui/sidepanel.html`);
    await panel.waitForFunction(() => typeof __ownedWhatsAppRenderPending === 'function');
    // Render the actual emitted application card with the shipped panel UI;
    // click its genuine manual option rather than manufacturing an Agent answer.
    await panel.evaluate(({ tabId, prompt }) => __ownedWhatsAppRenderPending(tabId, prompt), { tabId, prompt });
    const card = panel.locator(`.clarify-card[data-clarify-id="${prompt.clarifyId}"]`);
    assert.equal(await card.getAttribute('data-pending-reconciliation'), '1');
    assert.ok((await card.innerText()).includes(reply), 'The exact uncertain body must be visible to the manual operator.');
    await card.getByRole('button', { name: 'I verified this message was not delivered; clear this pending send', exact: true }).click();
    metrics.postwriteAttempt.manualCardClicked = true;
  }
  if (['stop', 'steering', 'peer_switch'].includes(scenario)) {
    const deadline = Date.now() + 15000;
    while (!held && Date.now() < deadline && !await harness.evaluate(() => qaRun.finished)) await sleep(50);
    assert.ok(held, 'Hold the actual generated send before its real Agent/native dispatch.');
    assert.equal(await page.evaluate(() => qaReplies.length), 0);
    if (scenario === 'stop') await message('abort', { tabId });
    else if (scenario === 'steering') {
      const sidepanel = await context.newPage(); await sidepanel.goto(`chrome-extension://${extensionId}/src/ui/sidepanel.html`);
      const accepted = await sidepanel.evaluate(({ tabId, marker }) => chrome.runtime.sendMessage({ target: 'background', action: 'chat_steer',
        tabId, requestId: 'owned-wa-contact', messageId: 'owned-wa-correction', text: `${marker} STOP_SENDING_OBSERVE_ONLY: Do not send any reply. Explain that sending was revoked.` }), { tabId, marker });
      assert.equal(accepted.accepted, true, JSON.stringify(accepted));
    } else await page.evaluate(() => {
      // A same-name switch and return is observable through native selection
      // mutation history. Neither a title nor the old WeakMap proof survives.
      const selected = document.querySelector('[aria-selected]'); selected.setAttribute('aria-selected', 'false'); selected.setAttribute('aria-selected', 'true');
    });
    held.release();
  }
  if (restartCase) {
    const deadline = Date.now() + 15000;
    while (!held && Date.now() < deadline && !await harness.evaluate(() => qaRun.finished)) await sleep(50);
    assert.ok(held, 'Hold the first actual observation after the uncertain send was durably saved.');
    assert.equal(await page.evaluate(() => qaReplies.length), 1);
    const stored = await harness.evaluate(async marker => {
      const all = { ...await chrome.storage.local.get(null), ...await chrome.storage.session.get(null) };
      const entry = Object.values(all).find(value => value?.chatWorkflow && JSON.stringify(value.messages).includes(marker));
      return { pending: entry?.chatWorkflow.pendingOutbound, threadKey: entry?.chatWorkflow.threadKey };
    }, marker);
    assert.ok(stored.pending, 'An actual dispatch must have durable uncertainty before interruption.');
    if (scenario === 'stop_pending') {
      const boot = await worker.evaluate(() => __ownedWhatsAppBoot);
      await message('abort', { tabId }); held.release();
      await harness.waitForFunction(() => qaRun.finished, null, { timeout: 10000 });
      const stopped = await harness.evaluate(() => qaRun.events.findLast(event => event.type === 'run_complete')?.data?.status);
      assert.equal(stopped, 'stopped');
      assert.equal(await worker.evaluate(() => __ownedWhatsAppBoot), boot, 'Stop is independent from worker heap loss.');
      metrics.userStop = { afterDispatch: true, status: stopped, workerHeapPreserved: true };
    } else {
    const session = await context.newCDPSession(harness), versions = new Map(), states = [];
    session.on('ServiceWorker.workerVersionUpdated', ({ versions: updates }) => updates.forEach(version => {
      versions.set(version.versionId, version);
      if (version.scriptURL.startsWith(`chrome-extension://${extensionId}/`)) states.push(version.runningStatus);
    }));
    await session.send('ServiceWorker.enable');
    const findEnd = Date.now() + 5000; let version;
    while (!version && Date.now() < findEnd) { version = [...versions.values()].find(value => value.runningStatus === 'running'
      && value.scriptURL.startsWith(`chrome-extension://${extensionId}/`)); if (!version) await sleep(50); }
    assert.ok(version); const boot = await worker.evaluate(() => __ownedWhatsAppBoot);
    await session.send('ServiceWorker.stopWorker', { versionId: version.versionId });
    held.release(); await sleep(250); await message('get_providers');
    worker = context.serviceWorkers().find(current => current.url().startsWith(`chrome-extension://${extensionId}/`)) || worker;
    assert.notEqual(await worker.evaluate(() => __ownedWhatsAppBoot), boot, 'Restart must discard the real worker heap.');
    await harness.waitForFunction(() => qaRun.finished, null, { timeout: 10000 });
    metrics.interruptedRun = await harness.evaluate(() => ({ resultKeys: Object.keys(qaRun.result || {}), finished: qaRun.finished }));
    metrics.workerRestart = { nativeStop: true, states, freshGlobal: true, durablePending: true };
    }
    // Wait for the genuine late native bubble. Its existence alone cannot
    // restore the private mounted-tail proof lost with the original owner.
    await page.waitForFunction(() => !!document.querySelector('[data-id="opaque_new_B_1"]'), null, { timeout: 10000 });
    if (scenario === 'document_resume') {
      const before = await page.evaluate(() => performance.timeOrigin);
      await page.reload(); assert.notEqual(await page.evaluate(() => performance.timeOrigin), before);
      assert.equal(await page.locator('[data-id="opaque_remounted_Q"]').count(), 1);
      metrics.workerRestart.documentReplaced = true;
    }
    phase = 2; stage = 'initial'; observation = null;
    await harness.evaluate(({ tabId, text, scenario }) => {
      qaRun = { finished: false, events: [] };
      const continuation = ['worker_resume', 'document_resume', 'stop_pending'].includes(scenario);
      chrome.runtime.sendMessage({ target: 'background', action: continuation ? 'continue' : 'chat', tabId,
        ...(continuation ? {} : { text }), mode: 'act', requestId: 'owned-wa-contact', locale: 'en' })
        .then(result => { qaRun.result = result; qaRun.finished = true; }, error => { qaRun.result = { error: error.message }; qaRun.finished = true; });
    }, { tabId, text: scenario === 'restart_same_prompt' ? task
      : `${task} This is an interrupted delivery check: inspect it and do not resend the already dispatched reply.`, scenario });
  }
  if (scenario === 'late_drawer') {
    const deadline = Date.now() + 15000;
    while (!held && Date.now() < deadline && !await harness.evaluate(() => qaRun.finished)) await sleep(50);
    assert.ok(held); assert.equal(await page.evaluate(() => qaReplies.length), 0);
    assert.deepEqual(await page.evaluate(() => ({ opened: qaDrawer.opened, closed: qaDrawer.closed })),
      { opened: 1, closed: 0 });
    assert.equal(await page.evaluate(() => qaDrawer.identityStable), true);
    await message('abort', { tabId }); held.release();
    await harness.waitForFunction(() => qaRun.finished, null, { timeout: 10000 });
    metrics.interruptedRun = await harness.evaluate(() => ({ final: qaRun.result?.content,
      cancelled: qaRun.events.some(event => event.type === 'run_status' && event.data.status === 'cancelled') }));
    assert.equal(metrics.interruptedRun.cancelled, true);
    // This native close arrives after Stop; the expired pending phone hash
    // cannot certify the next task. Its initial native read must fail until
    // the new task performs another complete guarded drawer round trip.
    await page.locator('[data-testid="chat-info-drawer"] header button[aria-label="Close"]').click();
    phase = 2; stage = 'initial'; observation = null;
    await harness.evaluate(({ tabId, text }) => {
      qaRun = { finished: false, events: [] };
      chrome.runtime.sendMessage({ target: 'background', action: 'chat', tabId, text, mode: 'act', requestId: 'owned-wa-contact', locale: 'en' })
        .then(result => { qaRun.result = result; qaRun.finished = true; }, error => { qaRun.result = { error: error.message }; qaRun.finished = true; });
    }, { tabId, text: task });
  }
  try { await harness.waitForFunction(() => qaRun.finished, null, { timeout: 60000 }); }
  catch (error) { await message('abort', { tabId }); throw error; }
  run = await harness.evaluate(() => qaRun);
  if (!run.result?.updates) run.result.updates = run.events;
  const native = await page.evaluate(() => ({ replies: qaReplies, drawer: qaDrawer, editor: qaEditor, unrelatedClicks: qaUnrelatedClicks, forbiddenClicks: qaForbiddenClicks,
    composer: document.querySelector('[contenteditable]').innerText,
    recipientLabelAbsent: !document.querySelector('[contenteditable]').hasAttribute('aria-label'),
    genericPlaceholder: document.querySelector('[contenteditable]').getAttribute('aria-placeholder') === 'Type a message',
    rows: [...document.querySelectorAll('[data-id]')].map(row => ({ id: row.dataset.id, text: row.querySelector('[data-testid="selectable-text"]')?.textContent })) }));
  const done = run.result?.updates?.findLast(event => event.type === 'tool_result' && event.data?.name === 'done')?.data?.result;
  const terminal = run.events.findLast(event => event.type === 'run_complete')?.data;
  const state = await message('agent_run_state', { tabId, requestId: 'owned-wa-contact' });
  const runUi = { status: state.runUi?.status, successfulDone: state.runUi?.successfulDone, runSucceeded: state.runUi?.runSucceeded };
  const durableChat = await harness.evaluate(async marker => {
    const all = { ...await chrome.storage.local.get(null), ...await chrome.storage.session.get(null) };
    const entry = Object.values(all).find(value => value?.chatWorkflow && JSON.stringify(value.messages).includes(marker));
    return { pendingOutbound: entry?.chatWorkflow.pendingOutbound || null, threadKey: entry?.chatWorkflow.threadKey || null };
  }, marker);
  if (process.env.WEBBRAIN_QUALITY_WA_DIAGNOSTIC === '1') metrics.diagnostics = await worker.evaluate(tabId => ({
    events: globalThis.__ownedWhatsAppDiagnostics || [], final: globalThis.__ownedWhatsAppSnapshot?.(tabId) || null,
  }), tabId);
  if (scenario === 'postwrite_debt') metrics.clearTransport = await worker.evaluate(() => __ownedClearTransport);
  if (latestCase) {
    metrics.latestTransport = await worker.evaluate(() => __ownedLatestTransport);
    metrics.nativeLatestDocumentAfter = await page.evaluate(() => ({ url: location.href, timeOrigin: performance.timeOrigin,
      peer: document.querySelector('[data-testid=conversation-info-header-chat-title]')?.textContent, composerEmpty: composer.textContent === '' }));
  }
  await fs.writeFile(path.join(out, 'evidence.json'), JSON.stringify({ scenario, elapsedMs: Date.now() - started, metrics, native, run, runUi, durableChat, providerError, finalUrl: page.url() },
    (_key, value) => typeof value === 'string' && value.startsWith('data:image/') ? '[owned screenshot omitted]' : value, 2));
  assert.equal(providerError, null, providerError);
  if (guardsOff) {
    assert.deepEqual(native.replies, [reply, reply, reply]);
    assert.equal(native.drawer.opened, 0);
    assert.equal(native.editor.sendClicks, 1);
    assert.equal(native.editor.enter, 2);
    assert.equal(terminal?.status, 'completed');
    console.log(JSON.stringify({ passed: true, scenario, installedMV3: true, send: 1, enter: 1, chatSend: 1, externalMessages: 0 }));
    return;
  }
  assert.deepEqual(metrics.initialObservationResults.map(result => result.phase),
    restartCase || scenario === 'late_drawer' ? [1, 2] : [1],
    'Every phase must consume its own genuinely executed native observation before advancing.');
  assert.equal(new Set(metrics.initialObservationResults.map(result => result.callId)).size,
    metrics.initialObservationResults.length, 'An earlier run observation cannot stand in for the current phase.');
  if (scenario === 'worker_resume') { assert.ok(native.drawer.opened >= 1 && native.drawer.opened <= 2); assert.equal(native.drawer.closed, native.drawer.opened); }
  else { assert.equal(native.drawer.opened, ['restart_pending', 'restart_same_prompt', 'late_drawer', 'stop_pending'].includes(scenario) ? 2 : 1);
    assert.equal(native.drawer.closed, ['restart_pending', 'restart_same_prompt', 'late_drawer', 'stop_pending'].includes(scenario) ? 2 : 1); }
  assert.equal(native.composer, '');
  assert.equal(native.drawer.identityStable, true, 'Close decoration and avatar loading must retain the original exact phone/subtitle nodes and values.');
  assert.equal(native.drawer.avatarUpdates, native.drawer.opened);
  assert.ok(native.drawer.hoverEvents >= native.drawer.opened); assert.ok(native.drawer.focusEvents >= native.drawer.opened);
  assert.ok(native.drawer.pressEvents >= native.drawer.closed);
  assert.equal(native.recipientLabelAbsent, true); assert.equal(native.genericPlaceholder, true);
  assert.deepEqual(metrics.nativeBootstrapRef, { freshAx: true, titleCarrier: true });
  if (['positive', 'bootstrap_native', 'native_scroll_latest', 'native_prepared_repair', 'postwrite_debt', 'late_drawer', 'worker_resume'].includes(scenario)) {
    assert.deepEqual(native.replies, [reply], 'Only one exact generated reply may reach the owned contact.');
    // Background Continue publishes the compact tool-result envelope, which
    // retains outcome/summary while the actual run UI records accepted done.
    if (scenario !== 'worker_resume') assert.equal(done?.done, true, JSON.stringify(done));
    assert.equal(done?.outcome, 'success', JSON.stringify(done));
    assert.equal(terminal?.status, 'completed');
    assert.equal(runUi.successfulDone, true); assert.equal(runUi.runSucceeded, true);
    if (scenario === 'worker_resume') assert.ok(metrics.nativeDeliveryProofs?.some(proof => proof.phase === 2 && proof.priorGoal),
      'Trusted Continue must freshly restore an exact app-owned prior-goal delivery proof.');
    else assert.ok(metrics.judges > 0, 'An uncertain real evaluator must leave exact native proof required.');
    assert.ok(metrics.observedIncoming.some(row => row.text.startsWith('QA dialogue complete:')));
    if (scenario === 'postwrite_debt') {
      assert.deepEqual(metrics.postwriteAttempt, { verifiedDraft: true, entered: false, clicked: false, pending: true,
        freshSendBlocked: true, manualCardClicked: true, manuallyReconciled: true });
      assert.deepEqual(native.editor, { handled: 1, rerenders: 1, enter: 1, sendClicks: 0 });
      assert.deepEqual(metrics.clearTransport, [
        { action: 'ax_prepare_native_chat_clear', success: true, hasToken: true },
        { action: 'captureTextClearReceipt', captured: true },
        { action: 'verifyTextClearReceipt', verified: true },
        { action: 'ax_verify_native_chat_clear', success: true, hasToken: false },
        { action: 'ax_release_native_chat_clear', success: true, hasToken: false },
      ], 'One genuine native clear must pass both the CDP event receipt and the same-conversation private proof.');
      assert.equal(durableChat.pendingOutbound, null);
    }
    if (scenario === 'bootstrap_native') {
      assert.deepEqual(metrics.nativeBootstrapRejected, bootstrapRejectedControls);
      assert.equal(native.unrelatedClicks, 0);
      assert.equal(native.forbiddenClicks, 0);
      assert.equal(native.editor.enter + native.editor.sendClicks, 1);
      assert.equal(durableChat.pendingOutbound, null);
    }
    if (latestCase) {
      assert.equal(metrics.nativeLatestRepair.scopedRead, true); assert.equal(metrics.nativeLatestRepair.actualScroll, true);
      const executedScrolls = run.result.updates.filter(event => event.type === 'tool_call' && event.data?.name === 'scroll');
      const allScrollResults = run.result.updates.filter(event => event.type === 'tool_result' && event.data?.name === 'scroll');
      const completedScrolls = allScrollResults.filter(event => event.data.result?.success === true
        && event.data.result?.skipped !== true && event.data.result?.noDispatch !== true);
      const skippedScrolls = allScrollResults.filter(event => !completedScrolls.includes(event));
      assert.equal(executedScrolls.length, 1); assert.equal(completedScrolls.length, 1);
      assert.equal(skippedScrolls.length, preparedCase ? 1 : 0);
      assert.ok(skippedScrolls.every(event => event.data.result?.skipped === true
        && event.data.result?.noDispatch === true && event.data.result?.dispatched === false));
      assert.deepEqual(executedScrolls[0].data.args, { ref_id: metrics.nativeLatestRepair.ref, direction: 'bottom' });
      assert.equal(completedScrolls[0].data.result.success, true);
      assert.equal(completedScrolls[0].data.result.containerScrollY,
        completedScrolls[0].data.result.containerScrollHeight - completedScrolls[0].data.result.containerClientHeight);
      assert.equal(metrics.nativeLatestRepair.ownedHandoff?.oneActualScroll, true);
      assert.equal(native.editor.enter + native.editor.sendClicks, 1); assert.equal(durableChat.pendingOutbound, null);
    }
    if (preparedCase) {
      assert.equal(metrics.nativePreparedWrongSendBlocked, true);
      assert.deepEqual([...new Set(metrics.nativePreparedTargets.map(target => target.kind))].sort(), ['carrier', 'close', 'transcript']);
      assert.ok(metrics.nativePreparedTargets.every(target => target.modelVisible),
        'Every exact native repair must have fresh model-visible pre-inference AX evidence.');
      assert.equal(metrics.calls.filter(call => call.name === 'get_accessibility_tree').length, 1,
        'Only the initial rejected Send is explicitly read; carrier/Close/transcript are actually prepared before inference.');
    }
  } else if (scenario === 'virtual_floor' || heldRestartCase) {
    assert.deepEqual(native.replies, [reply]); assert.notEqual(done?.outcome, 'success');
    assert.equal(runUi.successfulDone, false, 'Finishing an honest partial answer must never mark the uncertain send successful.');
    assert.equal(runUi.runSucceeded, false);
    assert.ok(metrics.pendingObservations?.some(observation => observation.pending && (!restartCase || observation.phase === 2)),
      'Actual provider-visible native observation must retain delivery uncertainty.');
    assert.ok(durableChat.pendingOutbound, 'The uncertainty must remain in the real durable conversation, not just its display.');
  } else {
    assert.deepEqual(native.replies, [], 'Stop/correction/contact switch must revoke the prepared send.');
    if (scenario === 'stop') {
      assert.equal(terminal?.status, 'stopped');
      assert.ok(run.events.some(event => event.type === 'run_status' && event.data.status === 'cancelled'));
    }
    if (scenario === 'steering') assert.match(run.result.content, /No reply was sent/);
    if (scenario === 'peer_switch') assert.ok(run.result.updates.some(event =>
      event.type === 'page_feedback' || (event.type === 'tool_result' && event.data.name === 'chat_send' && event.data.result.noDispatch === true)));
  }
  assert.equal(page.url(), fixtureUrl); assert.equal(metrics.calls.filter(call => call.name === 'chat_send').length, scenario === 'postwrite_debt' ? 2 : 1);
  console.log(JSON.stringify({ passed: true, scenario, installedMV3: true, contacts: 1, questions: 2, replies: native.replies.length, guardedDrawer: true, externalMessages: 0 }));
}
try {
  await runInstalledFixture();
} catch (error) {
  await fs.writeFile(path.join(out, 'failure.json'), JSON.stringify({ error: error.message, providerError, metrics,
    run: run || await harness?.evaluate(() => qaRun).catch(() => null),
    native: await page?.evaluate(() => ({ replies: qaReplies, drawer: qaDrawer })).catch(() => null) }, null, 2));
  throw error;
} finally {
  held?.release();
  await context?.close(); await new Promise(resolve => server.close(resolve));
  if (!path.resolve(profile).startsWith(path.resolve(os.tmpdir()) + path.sep + 'webbrain-whatsapp-contact-mv3-')) throw Error('Unexpected temporary profile.');
  await fs.rm(profile, { recursive: true, force: true });
}
