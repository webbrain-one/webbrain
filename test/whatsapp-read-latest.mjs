import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { chromium, firefox } from 'playwright';
import { Agent as ChromeAgent } from '../src/chrome/src/agent/agent.js';
import { Agent as FirefoxAgent } from '../src/firefox/src/agent/agent.js';
import { stubPageTextReadings } from './semantic-decision-stub.mjs';

// A real native scroll root 246 px short of its latest messages must not
// establish a send floor. Every contact, message and browser request is owned.
const body = 'Owned exact latest-view reply';
const html = `<!doctype html><style>body{margin:0;font:16px sans-serif}aside{position:absolute;width:260px}#main{position:absolute;left:280px;width:950px;height:780px}header{height:70px}[role=button],button{padding:8px}#messages{height:600px;overflow-y:scroll}#messages>[role=row]{height:40px}[contenteditable]{min-height:32px;width:600px}[data-testid=chat-info-drawer]{position:fixed;right:0;top:0;width:260px;background:white}</style>
<aside data-testid="chat-list"><div role="row"><div aria-selected="true"><span data-testid="cell-frame-title">Owned Contact</span></div></div></aside>
<div id="main" data-testid="conversation-panel-wrapper"><header data-testid="conversation-header"><div id="carrier" role="button" tabindex="0" data-testid="conversation-info-header"><span data-testid="conversation-info-header-chat-title-name">Owned Contact</span></div></header><div id="messages" data-testid="conversation-panel-messages"></div><footer><div id="composer" contenteditable="true" role="textbox" data-testid="conversation-compose-box-input" aria-placeholder="Type a message">${body}</div><button id="send" type="button" aria-label="Send">Send</button></footer></div>`;

for (const [build, engine, Agent] of [['chrome', chromium, ChromeAgent], ['firefox', firefox, FirefoxAgent]]) test(`${build}: historical native viewport has actionable recovery without a send exemption`, async t => {
  const browser = await engine.launch({ headless: true });
  try {
    const sources = await Promise.all(['rich-text-toolbar-heuristic.js','accessibility-tree.js','whatsapp-phone.js','chat-observation.js','content.js']
      .map(file => readFile(new URL(`../src/${build}/src/content/${file}`, import.meta.url), 'utf8')));
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await page.route('**/*', route => route.fulfill({ contentType: 'text/html', body: html }));
    const call = (action, params = {}) => page.evaluate(message => new Promise(resolve => {
      for (const listener of qaHandlers) listener(message, {}, resolve);
    }), { target: 'content', action, params });
    async function prepare() {
      await page.goto('https://web.whatsapp.com/');
      await page.evaluate(() => {
        window.qaHandlers = []; window.qaSent = 0;
        const runtime = { getURL: x => x, onMessage: { addListener: fn => qaHandlers.push(fn) } };
        window.chrome = window.browser = { runtime };
        window.qaAdd = (id, text, outgoing = false) => {
          const row = document.createElement('div'); row.setAttribute('role','row');
          const node = document.createElement('div'); node.dataset.id = id; node.dataset.testid = 'conv-msg-' + id;
          node.innerHTML = '<div data-testid="msg-container"><div data-pre-plain-text="[12:00, 08/10/2026] '+(outgoing?'Owned Self':'Owned Contact')+': "><span data-testid="selectable-text"></span></div><span data-icon="tail-'+(outgoing?'out':'in')+'">◁</span><span data-testid="msg-meta">'+(outgoing?'<span aria-label="Delivered">✓✓</span>':'')+'</span></div>';
          node.querySelector('[data-testid="selectable-text"]').textContent = text; row.append(node); messages.append(row);
        };
        for(let i=0;i<49;i++) qaAdd('owned-history-'+i,'Owned question '+i);
        messages.scrollTop = messages.scrollHeight - messages.clientHeight - 246;
        carrier.onclick = () => {
          const drawer = document.createElement('div'); drawer.dataset.testid = 'chat-info-drawer';
          drawer.innerHTML = '<header><button type="button" aria-label="Close">Close</button></header><div data-testid="contact-info-header">Contact info</div><span data-testid="contact-info-subtitle selectable-text">Owned Contact</span><span data-testid="selectable-text">+90 555 000 00 01</span>';
          drawer.querySelector('button').onclick = () => drawer.remove(); document.body.append(drawer);
        };
        send.onclick = () => { qaSent++; qaAdd('owned-outgoing-'+qaSent,composer.textContent,true); composer.textContent=''; messages.scrollTop=messages.scrollHeight; };
      });
      for (const source of sources) await page.addScriptTag({ content: source });
      const provider = { model: 'owned-model', config: { model: 'owned-model' }, supportsVision: false };
      const agent = new Agent({ getActive: () => provider }), tabId = 94;
      // A model reads the page's texts (a sent message's status) in any language.
      stubPageTextReadings(agent);
      agent.conversations.set(tabId,[{role:'system',content:'Owned system.'},{role:'user',content:'Send this exact reply once to the currently open Owned Contact: '+body,webbrainResumeTaskId:'owned-latest-task'}]);
      agent._beginCompletionInvariant(tabId);
      agent._planExecutionGuards.set(tabId,{messaging:{target_kind:'named',recipients:['Owned Contact']},requiresSubmission:true});
      agent._currentUrl = async () => page.url(); agent._sendDevContentAction = (_, action, params) => call(action, params);
      if(build==='firefox') globalThis.browser={tabs:{sendMessage:(_,message)=>call(message.action,message.params)}};
      const observe = () => agent._observeChatWorkflow(tabId);
      const read = ref_id => call('get_accessibility_tree',{ref_id,filter:'all'});
      const guarded = async ref_id => {
        await read(ref_id); const context={};
        const block=await agent._messageRecipientGuardBlock(tabId,'click_ax',{ref_id},page.url(),context);
        if(block) return block;
        return call('click_ax',{ref_id,...context,_nativeChatOwner:agent._nativeChatOwnerScope(tabId)});
      };
      const initial=await observe(); assert.equal(initial.nativeWhatsappRepair?.phase,'open_contact');
      assert.equal((await guarded(initial.nativeWhatsappRepair.ref_id)).success,true);
      await page.waitForTimeout(30); const opened=await observe();
      assert.equal((await guarded(opened.nativeWhatsappRepair.ref_id)).success,true);
      return {agent,tabId,provider,observe,read,guarded};
    }
    await t.test('exact scoped scroll repairs the actual 246px gap before exactly one verified send',async()=>{
      const f=await prepare(), first=await f.observe();
      assert.equal(first.success,true); assert.deepEqual(first.chatWorkflow.newMessages,[]);
      assert.equal(first.nativeChatReadRepair?.phase,'read_latest','Successful canonical observation must explain its historical viewport.');
      const hint=first.nativeChatReadRepair; assert.equal(hint.direction,'bottom');
      assert.equal(await page.evaluate(ref=>__wb_ax_lookup(ref)===messages,hint.ref_id),true);
      assert.equal(await page.evaluate(()=>Math.round(messages.scrollHeight-messages.clientHeight-messages.scrollTop)),246);
      const sendRef=await page.locator('#send').evaluate(node=>__wb_ax_ref(node));
      const denied=await f.guarded(sendRef); assert.equal(denied.noDispatch,true); assert.equal(denied.reasonCode,'native_chat_baseline_unavailable');
      assert.deepEqual(denied.nativeChatReadRepair,hint);
      assert.deepEqual(await page.evaluate(()=>({sent:qaSent,floor:!!__wb_get_native_chat_context(composer)?.sendFloor})),{sent:0,floor:false});
      await f.read(hint.ref_id); const scrolled=await call('scroll',{ref_id:hint.ref_id,direction:hint.direction}); assert.equal(scrolled.success,true); assert.equal(scrolled.movedContainer,true);
      const fresh=await f.observe(); assert.equal(fresh.success,true); assert.equal(fresh.nativeChatReadRepair,undefined);
      assert.ok(fresh.chatWorkflow.newMessages.length>0); assert.equal(await page.evaluate(()=>qaSent),0);
      assert.equal(fresh.chatWorkflow.pendingOutbound,false,'Read-only latest recovery creates no pending send.');
      const sent=await f.guarded(sendRef); assert.equal(sent.success,true,JSON.stringify(sent));
      const after=await f.observe(); assert.equal(after.chatWorkflow.events.some(event=>event.type==='outgoing_verified'),true,'The real fresh native delivered row is observed after the one authorized send.');
      assert.equal(await page.evaluate(()=>qaSent),1); assert.equal(after.composer.empty,true);
      assert.equal(await page.evaluate(()=>!!__wb_get_native_chat_context(composer)?.sendFloor),true);
      assert.equal(await page.evaluate(expected=>__wb_observe_chat_dom({composerSelector:'#composer'}).nativeChatDeliveryProof?.body===expected,body),true,'Only the appended exact native delivered row creates proof.');
    });
    for(const drift of ['Stop','provider','peer','document']) await t.test(`old latest hint cannot authorize send after ${drift}`,async()=>{
      const f=await prepare(), first=await f.observe(); assert.ok(first.nativeChatReadRepair?.ref_id);
      const sendRef=await page.locator('#send').evaluate(node=>__wb_ax_ref(node));
      if(drift==='Stop') f.agent.abortFlags.set(f.tabId,true);
      if(drift==='provider') f.provider.config.account='different-owned-account';
      if(drift==='peer') await page.evaluate(()=>{document.querySelector('[data-testid="conversation-header"]').replaceWith(document.querySelector('[data-testid="conversation-header"]').cloneNode(true));});
      if(drift==='document') {
        await page.goto('https://web.whatsapp.com/?new-document');
        await page.evaluate(()=>{window.qaHandlers=[];window.qaSent=0;const runtime={getURL:x=>x,onMessage:{addListener:fn=>qaHandlers.push(fn)}};window.chrome=window.browser={runtime};});
        for(const source of sources) await page.addScriptTag({content:source});
      }
      const denied=await f.guarded(sendRef); assert.equal(denied.noDispatch,true,JSON.stringify(denied));
      assert.equal(await page.evaluate(()=>window.qaSent||0),0);
    });
    await t.test('public observation refuses forged or oversized latest guidance',async()=>{
      const f=await prepare(), observation=await f.agent._readChatObservation(f.tabId);
      const advanced={snapshot:{threadKey:'owned'},session:{},events:[],newMessages:[]};
      for(const nativeChatReadRepair of [{phase:'send',ref_id:'ref_owned',direction:'bottom'},{phase:'read_latest',ref_id:'javascript:send()',direction:'bottom'},{phase:'read_latest',ref_id:'ref_'+'a'.repeat(101),direction:'bottom'},{phase:'read_latest',ref_id:'ref_owned',direction:'top'}]) {
        assert.equal(f.agent._chatObservationResult({...observation,nativeChatReadRepair},advanced).nativeChatReadRepair,undefined);
      }
    });
  } finally { await browser.close(); }
});
