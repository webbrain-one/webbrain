import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { chromium } from 'playwright';
import { telegramLab, telegramRaceLab } from './native-chat-fixture.mjs';
import { fixturePageTextReply } from '../semantic-decision-stub.mjs';
import { scaled } from '../lib/time-budget.mjs';
import { writeTimeoutEvidence } from './native-chat-timeout-evidence.mjs';

// Whole installed background -> intent planner -> Agent -> native content
// dispatch -> completion. Only the provider is deterministic; no Agent gate,
// recipient check, observation, transport, or completion helper is mocked.
const out = path.resolve(process.env.WEBBRAIN_QUALITY_ARTIFACTS
  || 'ci/artifacts/native-chat-presubmit');
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

// Pure fixture check: native browsers may report intermediate resize geometries.
// Two authored commands each require their own fresh exact-geometry acknowledgment;
// every observed native resize remains in the journal and keeps the same draft/floor.
function assertNativeResizePhases(boundary, consumed, expectedDraft) {
  const phases=boundary.resizePhases;
  assert.equal(phases?.length,2,'Exactly two authored viewport phases must be recorded.');
  assert.deepEqual(phases.map(phase=>phase.phase),['changed','restored']);
  assert.deepEqual(phases.map(phase=>[phase.requestedWidth,phase.requestedHeight]),[[1180,940],[1280,1000]]);
  assert.deepEqual(phases.map(phase=>[phase.width,phase.height]),[[1280,1000],[1180,940]]);
  const expectedIds=Array.from({length:9},(_,index)=>String(index+1));
  const floor=event=>{
    assert.equal(event.replies,4); assert.equal(event.enters,4); assert.equal(event.draft,expectedDraft);
    assert.deepEqual(event.ids,expectedIds);
  };
  const input=boundary.events.find(event=>event.kind==='fifth_draft_input');
  assert.ok(input && input.trusted===true); floor(input);
  const firstEnter=boundary.events.find(event=>event.kind==='before_enter');
  assert.ok(firstEnter,'The later genuine Enter must be recorded.');
  const resizeAcks=boundary.events.filter(event=>event.kind==='native_resize_ack');
  for(const ack of resizeAcks){
    assert.equal(ack.trusted,true); floor(ack);
    assert.ok(ack.monotonicAt>=input.monotonicAt && ack.monotonicAt<firstEnter.monotonicAt,
      'Every native resize acknowledgment must preserve the draft before the later Enter.');
  }
  const authoredAcks=phases.map((phase,index)=>{
    floor(phase); assert.equal(phase.index,index);
    assert.ok(Number.isInteger(phase.eventCursor) && phase.eventCursor>=0 && phase.eventCursor<=boundary.events.length);
    assert.ok(phase.monotonicAt>=input.monotonicAt);
    if(index)assert.ok(phase.eventCursor>phases[index-1].ackEventIndex);
    const end=phases[index+1]?.eventCursor??boundary.events.length;
    const eventIndex=boundary.events.findIndex((event,eventIndex)=>eventIndex>=phase.eventCursor && eventIndex<end
      && event.kind==='native_resize_ack' && event.trusted===true
      && event.width===phase.requestedWidth && event.height===phase.requestedHeight);
    assert.ok(eventIndex>=0,'The authored phase requires a fresh native acknowledgment of its exact requested geometry.');
    assert.equal(phase.ackEventIndex,eventIndex,'Bind the first matching fresh callback in this authored phase.');
    const ack=boundary.events[eventIndex];
    assert.ok(ack.monotonicAt>=phase.monotonicAt && ack.at>=phase.at);
    assert.ok(boundary.steps[index].monotonicAt>=ack.monotonicAt);
    return ack;
  });
  assert.ok(authoredAcks[0].monotonicAt-input.monotonicAt<80,
    'The acknowledged interruption must reach the actual 80ms pre-Enter window.');
  assert.ok(consumed && authoredAcks[0].at<=consumed.at && consumed.at<=phases[1].at
    && phases[1].at<=authoredAcks[1].at,'Only the actual consumed blocked result permits the restoration phase.');
  assert.ok(authoredAcks[1].monotonicAt<firstEnter.monotonicAt,
    'Restore and acknowledge the viewport before the later genuine Enter.');
  assert.deepEqual([resizeAcks.at(-1).width,resizeAcks.at(-1).height],[1280,1000],
    'The final observed native viewport must retain the acknowledged restored geometry.');
}

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
    .map(message => ({ id: message.tool_call_id, name: names.get(message.tool_call_id) || message.name,
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


const preparedDraftLab = telegramLab + `<script>
window.qaSubmissionBoundary={armed:false,enters:0,steps:[],events:[],resizePhases:[]};
const input=document.querySelector('.input-message-input');
function qaBoundarySnapshot(kind,event=null){return {kind,at:Date.now(),monotonicAt:performance.now(),
 trusted:event?.isTrusted??null,draft:input.textContent,replies:qaReplies.length,enters:qaSubmissionBoundary.enters,
 ids:[...document.querySelectorAll('.bubble')].map(node=>node.dataset.mid),width:innerWidth,height:innerHeight,
 visibility:document.visibilityState,focused:document.hasFocus()};}
window.addEventListener('resize',event=>{if(qaSubmissionBoundary.armed)
 qaSubmissionBoundary.events.push(qaBoundarySnapshot('native_resize_ack',event));},{passive:true});
document.addEventListener('keydown',event=>{if(qaSubmissionBoundary.armed&&event.target===input&&event.key==='Enter')
 qaSubmissionBoundary.events.push(qaBoundarySnapshot('before_enter',event));},true);
input.addEventListener('keydown',e=>{if(e.key==='Enter')qaSubmissionBoundary.enters++;});
input.addEventListener('input',event=>{
 if(qaSubmissionBoundary.armed||qaReplies.length!==4||!input.textContent)return;
 qaSubmissionBoundary.armed=true;
 qaSubmissionBoundary.events.push(qaBoundarySnapshot('fifth_draft_input',event));
 window.qaNativeViewportInterrupt().catch(error=>{qaSubmissionBoundary.error=error.message;});
});
</script>`;


let sourceStart;
async function sourceSnapshot(extension) {
  const rows=[];
  const walk=async dir=>{for(const entry of await fs.readdir(dir,{withFileTypes:true})){const name=path.join(dir,entry.name);
    if(entry.isDirectory())await walk(name);else if(entry.isFile())rows.push({path:path.relative(extension,name).replaceAll('\\','/'),sha256:createHash('sha256').update(await fs.readFile(name)).digest('hex')});}};
  await walk(extension);
  rows.sort((a,b)=>a.path.localeCompare(b.path));
  for(const file of [new URL(import.meta.url),new URL('./native-chat-fixture.mjs',import.meta.url)])rows.push({path:file.pathname,sha256:createHash('sha256').update(await fs.readFile(file)).digest('hex')});
  return {capturedAt:new Date().toISOString(),extension,sourceFiles:rows.length,files:rows};
}
async function beginSourceSnapshot(extension){sourceStart=await sourceSnapshot(extension);await fs.writeFile(path.join(out,'source-start.json'),JSON.stringify(sourceStart,null,2));}
async function finishSourceSnapshot(){if(!sourceStart)return;const finish=await sourceSnapshot(sourceStart.extension);
  const stable=JSON.stringify(sourceStart.files)===JSON.stringify(finish.files);
  await fs.writeFile(path.join(out,'source-verification.json'),JSON.stringify({...finish,sourceStable:stable,baseline:!!process.env.WEBBRAIN_CHAT_DRAFT_EXTENSION},null,2));
  assert.equal(stable,true,'Exact extension and fixture source remain unchanged during this run.');}

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
      if (current.path === 'structured_prefill'
          && last?.name === 'chat_send' && last.result?.reason === 'native_chat_submit_blocked_before_dispatch') {
        const callIndex = current.calls.findLastIndex(call => call.name === 'chat_send' && call.args.text === replies[4]);
        assert.ok(callIndex >= 0, 'The native block belongs to this fixture\'s fifth reply.');
        assert.equal(last.id, `${current.path}-${callIndex + 1}`, 'Consume the actual current send result, not old history or a generated proposal.');
        assert.equal(last.result.submissionDispatched, false);
        assert.equal(last.result.draftMutationDispatched, true);
        assert.equal(last.result.outcomeUnknown, true, 'The fixture does not forgive the dispatched draft.');
        assert.equal(last.result.submissionOutcomeUnknown,false);
        assert.equal(last.result.deliveryVerified,false);
        assert.equal(last.result.threadKey,'dom:telegram:k:123456:0');
        assert.equal(last.result.dispatch?.verified,true);
        assert.equal(last.result.dispatch?.submissionBlockedBeforeDispatch,true);
        assert.equal(last.result.dispatch?.ref_id,current.calls[callIndex].args.composer_ref);
        const actualDraft=await current.inspectBlockedDraft();
        assert.equal(actualDraft.draft,replies[4]); assert.equal(actualDraft.replies,4); assert.equal(actualDraft.enters,4);
        assert.deepEqual(actualDraft.ids,Array.from({length:9},(_,index)=>String(index+1)));
        if (current.blockedResultConsumed) {
          assert.equal(last.id,current.blockedResultConsumed.id,'A discarded read may expose only the identical already-consumed block.');
          assert.equal(last.result.messageKey,current.blockedResultConsumed.messageKey);
          assert.equal(last.result.dispatch.ref_id,current.blockedResultConsumed.composerRef);
          current.blockedResultReobserved??=[];
          current.blockedResultReobserved.push({id:last.id,at:Date.now()});
          assert.ok(current.blockedResultReobserved.length<=3,'Bounded read-only reconsideration cannot become a send retry loop.');
        } else {
          assert.equal(current.blockedResultConsumed, undefined, 'Only one actual blocked result can restore the fixture viewport.');
          current.blockedResultConsumed = { id:last.id, at:Date.now(), reason:last.result.reason,
            messageKey:last.result.messageKey,composerRef:last.result.dispatch.ref_id,draft:actualDraft };
          await current.restoreNativeViewport();
        }
      }
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
  const extension = path.resolve(process.env.WEBBRAIN_CHAT_DRAFT_EXTENSION || 'src/chrome');
  await beginSourceSnapshot(extension);
  context = await chromium.launchPersistentContext(profile, { headless: true, channel: 'chromium', viewport: { width: 1280, height: 1000 },
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`,
      '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1'] });
  await context.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.origin === 'https://web.telegram.org') return route.fulfill({ contentType: 'text/html',
      body: url.searchParams.get('fixture') === 'same_body_race' ? telegramRaceLab
        : url.searchParams.get('fixture') === 'structured_prefill' ? preparedDraftLab : telegramLab });
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
    const page = await context.newPage();
    if (dispatchPath === 'structured_prefill') {
      const record = kind => page.evaluate(kind => qaSubmissionBoundary.steps.push(qaBoundarySnapshot(kind)),kind);
      const acknowledgeResize = async (phaseName,width,height) => {
        const phase = await page.evaluate(({phaseName,width,height}) => {
          const phase={...qaBoundarySnapshot('native_viewport_phase_requested'),phase:phaseName,
            index:qaSubmissionBoundary.resizePhases.length,eventCursor:qaSubmissionBoundary.events.length,
            requestedWidth:width,requestedHeight:height};
          qaSubmissionBoundary.resizePhases.push(phase);
          return phase;
        },{phaseName,width,height});
        await page.setViewportSize({width,height});
        await page.waitForFunction(({width,height,eventCursor}) => qaSubmissionBoundary.events.some((event,index) =>
          index>=eventCursor && event.kind==='native_resize_ack' && event.trusted===true
          && event.width===width && event.height===height),
        {width,height,eventCursor:phase.eventCursor},{timeout:5000});
        const ack = await page.evaluate(({width,height,eventCursor,index}) => {
          const eventIndex=qaSubmissionBoundary.events.findIndex((event,eventIndex) => eventIndex>=eventCursor
            && event.kind==='native_resize_ack' && event.trusted===true && event.width===width && event.height===height);
          qaSubmissionBoundary.resizePhases[index].ackEventIndex=eventIndex;
          return qaSubmissionBoundary.events[eventIndex];
        },{width,height,eventCursor:phase.eventCursor,index:phase.index});
        assert.equal(ack.enters,4,'The actual native resize must be acknowledged before the fifth Enter; a late intervention is a fixture injection failure.');
        assert.equal(ack.replies,4);
        assert.equal(ack.draft,replies[4]);
        assert.deepEqual(ack.ids,Array.from({length:9},(_,index)=>String(index+1)));
      };
      let viewportChange = null;
      current.inspectBlockedDraft = () => page.evaluate(() => qaBoundarySnapshot('provider_consumed_blocked_draft'));
      await page.exposeBinding('qaNativeViewportInterrupt', () => {
        assert.equal(viewportChange,null,'Inject the native viewport interruption once.');
        viewportChange=(async()=>{
          await acknowledgeResize('changed',1180,940);
          await record('native_viewport_changed');
        })();
        return viewportChange;
      });
      current.restoreNativeViewport = async () => {
        assert.ok(viewportChange,'The actual fifth draft must start the viewport interruption.');
        await viewportChange;
        await acknowledgeResize('restored',1280,1000);
        await record('native_viewport_restored');
      };
    }
    await page.goto(ownedUrl);
    if (dispatchPath === 'structured_prefill') {
      await page.bringToFront();
      await page.waitForFunction(() => document.visibilityState==='visible' && document.hasFocus(),null,{timeout:5000});
      await page.evaluate(() => {qaSubmissionBoundary.foreground=qaBoundarySnapshot('foreground_before_task');});
    }
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
    const boundaryEvidence = dispatchPath === 'structured_prefill' ? await page.evaluate(() => window.qaSubmissionBoundary) : null;
    const evidence = { boundary:boundaryEvidence, path: dispatchPath, elapsedMs: Date.now() - started, finalUrl: page.url(),
      actualReplies, outgoingBodies, finalNativeText, run, provider: current, network: await worker.evaluate(() => nativeFixtureNetwork), externalMessages: 0 };
    await fs.writeFile(path.join(out, `${dispatchPath}-evidence.json`), JSON.stringify(evidence,
      (_key, value) => typeof value === 'string' && value.startsWith('data:image/') ? '[owned screenshot omitted]' : value, 2));
    assert.equal(current.providerError, undefined, current.providerError);
    if (dispatchPath === 'structured_prefill') {
      const boundary = await page.evaluate(() => qaSubmissionBoundary);
      const blocked = run.result.updates.filter(e => e.type==='tool_result' && e.data?.name==='chat_send'
        && e.data.result?.reason==='native_chat_submit_blocked_before_dispatch');
      assert.equal(blocked.length,1,'The real 80ms settle window must block exactly one explicit Enter.');
      assert.equal(blocked[0].data.result.submissionDispatched,false);
      assert.equal(blocked[0].data.result.draftMutationDispatched,true);
      assert.equal(blocked[0].data.result.outcomeUnknown,true,'Typing effects are not forgiven.');
      assert.ok(run.result.updates.some(e=>e.type==='tool_result' && e.data?.name==='chat_observe'
        && e.data.result?.ownedDraftRecovery?.available===true),'Only a fresh actual observation exposes recovery.');
      assert.equal(boundary.armed,true); assert.equal(boundary.steps.length,2);
      assert.ok(boundary.steps.every(step=>step.replies===4 && step.enters===4 && step.draft===replies[4]));
      assert.equal(boundary.enters,6,'Six physical Enter handlers, without duplicate submission.');
      assert.equal(JSON.stringify(run.result).includes('_nativeChatDraftBinding'),false,'Private draft tokens never enter model/public replies.');
      assert.equal(boundary.error,undefined,'The real native viewport injection and acknowledgment must succeed.');
      assert.equal(boundary.foreground.visibility,'visible'); assert.equal(boundary.foreground.focused,true);
      assertNativeResizePhases(boundary,current.blockedResultConsumed,replies[4]);
      evidence.boundary=boundary;
    }
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
    const feedbackSkips = dispatchPath === 'generic_submit' ? sendAttempts.filter(event => {
      const result = event.data.result;
      return result.pageFeedbackPending === true && result.noDispatch === true
        && result.dispatched === false && !result.outcomeUnknown;
    }) : [];
    assert.equal(feedbackSkips.length, current.feedbackRecoveries || 0);
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
      assert.equal(sendAttempts.length,8,'Six deliveries plus manual draft refusal and one known pre-Enter interruption.');
      assert.equal(sendAttempts[0].data.result.reason, 'composer_not_empty');
      assert.equal(sendAttempts[0].data.result.noDispatch, true);
      const drafts = actualResults.filter(event => event.data.name === 'set_field');
      assert.equal(drafts.length, 2);
      assert.ok(drafts.every(event => event.data.result.success === true && event.data.result.verified === true
        && !event.data.result.outcomeUnknown && !event.data.result.repeatBlocked));
      // The owned draft write keeps its original verification debt. Recovery
      // proves delivery, and the following independent native read may be the
      // first receipt that can retire that debt and process its reply row.
      const progressReceipts = actualResults.filter(event => ['chat_send', 'chat_observe'].includes(event.data.name))
        .map(event => event.data.result.chatDeliveryProgress).filter(Boolean);
      assert.deepEqual(progressReceipts.map(receipt => receipt.id),
        Array.from({ length: 6 }, (_, index) => `expected:${index + 1}`));
      assert.deepEqual(progressReceipts.map(receipt => receipt.counts.processed), [1, 2, 3, 4, 5, 6]);
      assert.equal(new Set(progressReceipts.map(receipt => receipt.messageId)).size, 6);
      assert.ok(nativeReads.some(result => result.chatDeliveryProgress?.id === 'expected:5'),
        'The recovered owned draft needs its independent post-submit native observation.');
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
      (dispatchPath === 'structured_prefill' ? 8 : expectedCount) + feedbackSkips.length);
    if (dispatchPath === 'generic') assert.equal(tools.filter(name => name === 'set_field').length, 6);
    assert.equal(tools.includes(structuredPath(dispatchPath) ? 'click_ax' : 'chat_send'), false,
      'Each fixture must exercise its intended public dispatch path.');
    summaries.push({ fixture: 'native-chat-presubmit', path: dispatchPath, passed: true, replies: actualReplies.length,
      elapsedMs: evidence.elapsedMs, toolCalls: tools.length, judges: current.judges,
      feedbackRecoveries: current.feedbackRecoveries || 0, externalMessages: 0 });
    console.log(JSON.stringify(summaries.at(-1)));
  }
  // Four separate native tabs also prove that concurrent runs retain their own
  // task and conversation authority. The fake provider never chooses refs or
  // bodies from the other tab, and both real Agent pipelines remain intact.
  // Keep completed tabs open until every concurrent run has settled: closing
  // one can resize a sibling during guarded action preparation. The finally
  // block closes this entire owned context after all delivery assertions.
  const paths = ['structured', 'generic', 'generic_submit', 'structured_prefill', 'same_body_race'].filter(value => !process.env.WEBBRAIN_QUALITY_CASE_FILTER
    || new RegExp(process.env.WEBBRAIN_QUALITY_CASE_FILTER).test(value));
  await Promise.all(paths.filter(value=>value!=='structured_prefill').map(verifyPath));
  // The controlled pre-Enter intervention owns the foreground renderer. Other
  // running tabs must not delay its native resize event beyond the real 80ms
  // product settle window. Every original delivery/recovery assertion remains.
  if(paths.includes('structured_prefill'))await verifyPath('structured_prefill');
  summaries.sort((a, b) => a.path.localeCompare(b.path));
  await fs.writeFile(path.join(out, 'summary.json'), JSON.stringify({ passed: true, accountsCreated: [], results: summaries }, null, 2));
} finally {
  await context?.close(); await new Promise(resolve => server.close(resolve));
  await finishSourceSnapshot();
  const resolved = path.resolve(profile);
  if (!resolved.startsWith(path.resolve(os.tmpdir()) + path.sep + 'webbrain-native-chat-mv3-'))
    throw new Error('Unexpected temporary profile path.');
  await fs.rm(resolved, { recursive: true, force: true });
}
