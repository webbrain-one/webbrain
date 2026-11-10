import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { chromium, firefox } from 'playwright';
import { Agent as ChromeAgent } from '../src/chrome/src/agent/agent.js';
import { Agent as FirefoxAgent } from '../src/firefox/src/agent/agent.js';

// Production Agent/monitor transport over an owned native client. The large
// unrelated inventory omits Close from ordinary bounded AX; app-owned scoped
// observation must precede inference, rather than rebind its later decision.
const html=`<!doctype html><style>body{margin:0;font:16px sans-serif}aside{position:absolute;width:260px}#main{position:absolute;left:280px;width:950px;height:780px}header{height:70px}[role=button],button{padding:8px}#messages{height:600px;overflow-y:scroll}#messages>[role=row]{height:40px}[contenteditable]{min-height:32px;width:600px}#inventory{position:absolute;top:10px;left:600px;width:400px}#inventory button{height:20px}[data-testid=chat-info-drawer]{position:fixed;right:0;top:0;width:260px;background:white;z-index:2}</style>
<aside data-testid="chat-list"><div role="row"><div aria-selected="true"><span data-testid="cell-frame-title">Owned Contact</span></div></div></aside><div id="main" data-testid="conversation-panel-wrapper"><header data-testid="conversation-header"><div id="carrier" role="button" tabindex="0" data-testid="conversation-info-header"><span data-testid="conversation-info-header-chat-title-name">Owned Contact</span></div><button id="call" type="button">Call</button></header><div id="messages" data-testid="conversation-panel-messages"></div><footer><div id="composer" contenteditable="true" role="textbox" data-testid="conversation-compose-box-input" aria-placeholder="Type a message"></div><button id="send" type="button" aria-label="Send">Send</button></footer></div><section id="inventory"></section>`;

for(const [build,engine,Agent] of [['chrome',chromium,ChromeAgent],['firefox',firefox,FirefoxAgent]]) test(`${build}: private native targets receive genuine AX before inference only`,async t=>{
  const browser=await engine.launch({headless:true});
  let agent;
  try{
    const files=['page-monitor-shadow.js','rich-text-toolbar-heuristic.js','accessibility-tree.js','whatsapp-phone.js','chat-observation.js','page-monitor.js','content.js'];
    const sources=await Promise.all(files.map(file=>readFile(file==='page-monitor.js'&&process.env.WEBBRAIN_NATIVE_PREPARATION_MONITOR?process.env.WEBBRAIN_NATIVE_PREPARATION_MONITOR:new URL(`../src/${build}/src/content/${file}`,import.meta.url),'utf8')));
    const page=await browser.newPage({viewport:{width:1280,height:800}});
    await page.route('**/*',route=>route.fulfill({contentType:'text/html',body:html}));
    const tabId=95;let documentId='owned-doc';let captureHook=null;let lastModelValidation=null;
    const sender=()=>({tab:{id:tabId},frameId:0,documentId,url:page.url()});
    await page.exposeFunction('qaState',message=>agent.pageMonitorState(sender(),message.documentToken,message.frameName));
    await page.exposeFunction('qaFeedback',message=>agent.observePageFeedback(sender(),message.feedback));
    const call=(action,params={},extra={})=>page.evaluate(({action,params,extra})=>new Promise((resolve,reject)=>{
      if(!window.qaHandlers?.length){resolve({});return;}
      const timeout=setTimeout(()=>reject(new Error('No owned transport response: '+action)),3000);
      let answered=false;
      const respond=value=>{answered=true;clearTimeout(timeout);resolve(value);};
      for(const listener of qaHandlers){const async=listener({target:'content',action,params,...extra},{},respond);if(answered||async===true)break;}
    }),{action,params,extra});
    const api={tabs:{get:async()=>({id:tabId,url:page.url()}),sendMessage:async(_,message)=>{
      const result=await call(message.action,message.params||{},message);
      if(message.action==='page_monitor_validate_model')lastModelValidation={ready:result?.ready===true,
        reason:result?.reason||null,uncertified:result?.uncertified===true};
      if(message.action==='page_monitor_capture_model'&&captureHook)await captureHook();return result;
    }},webNavigation:{getAllFrames:async()=>[{frameId:0,documentId,url:page.url(),parentFrameId:-1}]}};
    globalThis.chrome=globalThis.browser=api;
    async function prepare(){
      await page.goto('https://web.whatsapp.com/');
      const provider={model:'owned-model',config:{model:'owned-model'},supportsVision:false};
      agent=new Agent({getActive:()=>provider});agent._runningTabs.add(tabId);
      agent.conversations.set(tabId,[{role:'system',content:'Owned system.'},{role:'user',content:'Reply once to the currently open Owned Contact.',webbrainResumeTaskId:'owned-preparation-task'}]);
      agent._beginCompletionInvariant(tabId);agent._planExecutionGuards.set(tabId,{messaging:{target_kind:'named',recipients:['Owned Contact']},requiresSubmission:true});
      agent._currentUrl=async()=>page.url();agent._sendDevContentAction=(_,action,params)=>call(action,params);
      await agent._beginPageFeedbackRun(tabId,'owned-fixture');
      await page.evaluate(()=>{
        window.qaHandlers=[];window.qaSent=0;window.qaOpened=0;window.qaClosed=0;
        const runtime={getURL:x=>x,onMessage:{addListener:fn=>qaHandlers.push(fn)},sendMessage:message=>message.action==='get_page_monitor_state'?qaState(message):message.action==='page_feedback'?qaFeedback(message):Promise.resolve({})};window.chrome=window.browser={runtime};
        for(let i=0;i<180;i++){const button=document.createElement('button');button.textContent='Owned unrelated visible inventory control '+i+' '+'.'.repeat(80);inventory.append(button);}
        const sidebar=document.createElement('div');sidebar.style.cssText='height:700px;overflow:hidden;font-size:6px;line-height:6px';
        for(let i=0;i<110;i++){const row=document.createElement('div');row.setAttribute('role','row');const cell=document.createElement('div');cell.setAttribute('role','gridcell');const title=document.createElement('span');title.dataset.testid='cell-frame-title';title.textContent='Owned unrelated native contact '+i+' '+'.'.repeat(100);cell.append(title);row.append(cell);sidebar.append(row);}document.querySelector('aside').append(sidebar);
        for(let i=0;i<49;i++){const row=document.createElement('div');row.setAttribute('role','row');row.innerHTML='<div data-id="owned-'+i+'" data-testid="conv-msg-owned-'+i+'"><div data-testid="msg-container"><div data-pre-plain-text="[12:00, 08/10/2026] Owned Contact: "><span data-testid="selectable-text">Owned question '+i+'</span></div><span data-icon="tail-in">◁</span><span data-testid="msg-meta"></span></div></div>';messages.append(row);}window.qaInitialTranscriptScrollAck = null;
        messages.addEventListener('scroll', event => {
          if (event.isTrusted && event.target === messages
              && Math.abs(messages.scrollHeight - messages.clientHeight - messages.scrollTop) <= 4) {
            window.qaInitialTranscriptScrollAck = { trusted: true, scrollTop: messages.scrollTop,
              scrollHeight: messages.scrollHeight, clientHeight: messages.clientHeight, timeOrigin: performance.timeOrigin };
          }
        }, { once: true });
        messages.scrollTop=messages.scrollHeight;
        carrier.onclick=()=>{qaOpened++;const drawer=document.createElement('div');drawer.dataset.testid='chat-info-drawer';drawer.innerHTML='<header><button type="button" aria-label="Close">Close</button></header><div data-testid="contact-info-header">Contact info</div><span id="subtitle" data-testid="contact-info-subtitle selectable-text">Owned Contact</span><span id="phone" data-testid="selectable-text">+90 555 000 00 01</span>';drawer.querySelector('button').onclick=()=>{qaClosed++;drawer.remove();};document.body.append(drawer);};send.onclick=()=>qaSent++;
      });
      // Finish the fixture's actual native initial scroll before attaching
      // the production monitor. A wall-clock sleep cannot acknowledge a queued
      // browser scroll, which correctly fences later prepared actions.
      await page.waitForFunction(() => window.qaInitialTranscriptScrollAck?.trusted === true
        && window.qaInitialTranscriptScrollAck.timeOrigin === performance.timeOrigin
        && Math.abs(messages.scrollHeight - messages.clientHeight - messages.scrollTop) <= 4,
        null, { polling: 'raf', timeout: 5000 });
      for(const source of sources)await page.addScriptTag({content:source});
      await page.waitForFunction(()=>__wbPageMonitor?.active);await page.waitForTimeout(180);
      const observe=()=>agent._observeChatWorkflow(tabId);
      const capture=async()=>{
        await page.waitForTimeout(180);
        await agent._applyPendingPageFeedback(tabId,agent.conversations.get(tabId),()=>{});
        await agent._capturePageFeedbackModelState(tabId,agent.conversations.get(tabId));
        return agent._pageFeedbackRuns.get(tabId).modelState;
      };
      const validate=async(tool,ref_id,state)=>{
        lastModelValidation=null;
        const result=await agent._validatePageFeedbackAction(tabId,tool,{ref_id},state);
        if(result===false){
          const run=agent._pageFeedbackRuns.get(tabId);
          const native=await page.evaluate(ref=>{const target=window.__wb_ax_lookup?.(ref);return{
            initialScrollAck:window.qaInitialTranscriptScrollAck,
            latest:Math.abs(messages.scrollHeight-messages.clientHeight-messages.scrollTop)<=4,
            targetConnected:target?.isConnected===true,targetTag:target?.tagName||null,
            targetRole:target?.getAttribute('role')||null,monitorActive:window.__wbPageMonitor?.active===true};},ref_id);
          console.error('Native read preparation validation refused '+JSON.stringify({build,tool,ref_id,
            bindingPresent:!!state?.actionBinding,modelStateSame:run?.modelState===state,
            stateCurrent:!!run&&agent._pageFeedbackStateCurrent(tabId,run,state),
            events:[...run?.events.values()||[]],contentValidation:lastModelValidation,native}));
        }
        return result;
      };
      const dispatch=async(ref_id,state)=>{
        const context={};const block=await agent._messageRecipientGuardBlock(tabId,'click_ax',{ref_id},page.url(),context);if(block)return block;
        const run=agent._pageFeedbackRuns.get(tabId),operationId='owned-operation-'+crypto.randomUUID();
        const certified=await validate('click_ax',ref_id,state);assert.notEqual(certified,false,'The actual model observation must cover this original target.');
        const prepared=await call('page_monitor_prepare',{runToken:run.token,operationId,tool:'click_ax',ref_id,allowPassiveRebase:certified===true,...(certified===true?{expectedModelSnapshot:state.actionBinding.snapshotToken}:{})});assert.equal(prepared.ready,true,JSON.stringify(prepared));
        const receipt=await call('page_monitor_dispatch',{runToken:run.token,operationId,kind:'click',fenceOnly:true});
        const result=await call('click_ax',{ref_id,...context,pageFeedbackGuard:receipt.guard,_nativeChatOwner:agent._nativeChatOwnerScope(tabId)});
        await call('page_monitor_finish',{runToken:run.token,operationId});return result;
      };
      return{provider,observe,capture,validate,dispatch};
    }
    await t.test('correct carrier and original Close need no extra model AX tool',async()=>{
      const f=await prepare(),first=await f.observe(),openedState=await f.capture();
      assert.ok(openedState.page.pageContent.includes(`[${first.nativeWhatsappRepair.ref_id}]`));
      assert.notEqual(await f.validate('click_ax',first.nativeWhatsappRepair.ref_id,openedState),false);
      assert.equal((await f.dispatch(first.nativeWhatsappRepair.ref_id,openedState)).success,true);
      await page.waitForTimeout(35);const current=await f.observe(),closedState=await f.capture();
      assert.equal(current.nativeWhatsappRepair.phase,'close_contact');
      assert.notEqual(await f.validate('click_ax',current.nativeWhatsappRepair.ref_id,closedState),false,'The actual monitor must cover original Close before a model decision can use it.');
      assert.ok(closedState.page.pageContent.includes('[CURRENT REQUESTED ACTION CONTEXT]'),'This is the real bounded scoped observation, not a hint exemption.');
      assert.ok(closedState.page.pageContent.includes(`[${current.nativeWhatsappRepair.ref_id}]`));
      const wrongRef=await page.locator('#send').evaluate(node=>__wb_ax_ref(node));
      const wrongContext={};assert.equal((await agent._messageRecipientGuardBlock(tabId,'click_ax',{ref_id:wrongRef},page.url(),wrongContext)).noDispatch,true);
      assert.equal((await f.dispatch(current.nativeWhatsappRepair.ref_id,closedState)).success,true);
      assert.equal((await f.observe()).success,true);assert.deepEqual(await page.evaluate(()=>({opened:qaOpened,closed:qaClosed,sent:qaSent})),{opened:1,closed:1,sent:0});
      const content=agent.conversations.get(tabId).filter(x=>x.webbrainAppOwnedKind==='page_action_observation').map(x=>x.content).join('');
      assert.equal(content.includes(agent._nativeChatOwnerScope(tabId)),false,'Private owner is never model page data.');
    });
    await t.test('canonical historical transcript gets genuine pre-inference AX without sending',async()=>{
      const f=await prepare(),initial=await f.observe();let state=await f.capture();await f.dispatch(initial.nativeWhatsappRepair.ref_id,state);await page.waitForTimeout(30);const drawer=await f.observe();state=await f.capture();await f.dispatch(drawer.nativeWhatsappRepair.ref_id,state);
      await page.evaluate(()=>{messages.scrollTop=messages.scrollHeight-messages.clientHeight-246;});
      const historical=await f.observe();state=await f.capture();
      assert.ok(historical.nativeChatReadRepair?.ref_id);assert.ok(state.page.pageContent.includes(`[${historical.nativeChatReadRepair.ref_id}]`));
      const scrolled=await agent.executeTool(tabId,'scroll',{ref_id:historical.nativeChatReadRepair.ref_id,direction:'bottom'},()=>{},{});
      const parsed=typeof scrolled==='string'?JSON.parse(scrolled):scrolled;assert.equal(parsed.success,true,JSON.stringify(parsed));
      assert.equal(await page.evaluate(()=>Math.abs(messages.scrollHeight-messages.clientHeight-messages.scrollTop)<=4),true);assert.equal(await page.evaluate(()=>qaSent),0);
    });
    for(const drift of ['Stop','owner','provider','peer','phone-change-return','preexisting-drawer'])await t.test(`private target refuses ${drift}`,async()=>{
      const f=await prepare(),first=await f.observe();let state=await f.capture();await f.dispatch(first.nativeWhatsappRepair.ref_id,state);await page.waitForTimeout(35);await f.observe();
      const owner=agent._nativeChatOwnerScope(tabId);
      const snapshot=await page.evaluate(owner=>{window.qaNativeSnapshot=__wb_native_chat_read_target(owner);return{phase:qaNativeSnapshot?.phase,hasTarget:!!qaNativeSnapshot?.target};},owner);assert.equal(snapshot.phase,'close_contact');assert.equal(snapshot.hasTarget,true);
      if(drift==='Stop'){agent.abortFlags.set(tabId,true);await call('page_monitor_state',{}, {active:false,runToken:agent._pageFeedbackRuns.get(tabId).token});}
      if(drift==='owner')await page.evaluate(()=>__wb_update_native_chat_owner('different-owned-authority'));
      if(drift==='provider'){f.provider.config.account='another-owned-account';await f.observe();}
      if(drift==='peer')await page.evaluate(()=>document.querySelector('[data-testid="conversation-header"]').replaceWith(document.querySelector('[data-testid="conversation-header"]').cloneNode(true)));
      if(drift==='phone-change-return')await page.evaluate(()=>{const original=phone.textContent;phone.textContent='+90 555 000 00 02';phone.textContent=original;});
      if(drift==='preexisting-drawer')await page.evaluate(()=>{const original=document.querySelector('[data-testid="chat-info-drawer"]');original.replaceWith(original.cloneNode(true));});
      assert.equal(await page.evaluate(()=>__wb_native_chat_read_target_matches(qaNativeSnapshot)),false);assert.equal(await page.evaluate(()=>qaSent+qaClosed),0);
    });
    await t.test('provider changes during the asynchronous capture reply cannot publish its certificate',async()=>{
      const f=await prepare();await f.observe();captureHook=async()=>{f.provider.config.account='changed-during-owned-capture';};
      const state=await f.capture();captureHook=null;assert.equal(state.actionBinding,undefined);assert.equal(await page.evaluate(()=>qaSent),0);
    });
    for(const drift of ['Stop','document'])await t.test(`${drift} during capture cannot publish an earlier native certificate`,async()=>{
      const f=await prepare();await f.observe();
      captureHook=async()=>{
        if(drift==='Stop'){agent.abortFlags.set(tabId,true);await call('page_monitor_state',{}, {active:false,runToken:agent._pageFeedbackRuns.get(tabId).token});}
        else{documentId='replacement-owned-document';await page.goto('https://web.whatsapp.com/?replacement');}
      };
      const state=await f.capture();captureHook=null;assert.equal(state.actionBinding,undefined);assert.equal(await page.evaluate(()=>window.qaSent||0),0);
    });
    await t.test('identity mutation inside bounded AX is caught before snapshot publication',async()=>{
      const f=await prepare(),first=await f.observe();let state=await f.capture();await f.dispatch(first.nativeWhatsappRepair.ref_id,state);await page.waitForTimeout(35);await f.observe();
      await page.evaluate(()=>{const original=__generateAccessibilityTree;window.__generateAccessibilityTree=(...args)=>{const result=original(...args);if(document.querySelector('#phone')){const value=phone.textContent;phone.textContent='+90 555 000 00 02';phone.textContent=value;}return result;};});
      state=await f.capture();assert.equal(state.actionBinding,undefined);assert.equal(await page.evaluate(()=>qaClosed+qaSent),0);
    });
    await t.test('certified native Close retains app-owned contact repair bookkeeping',async()=>{
      const f=await prepare(),transport=api.tabs.sendMessage;
      const commands=[],routes=[];
      let client,session,originalAttach;
      const runtime=api.runtime,debuggerApi=api.debugger,query=api.tabs.query;
      try{
        api.runtime={getURL:value=>value};api.tabs.query=async()=>[{id:tabId,url:page.url()}];
        if(build==='chrome'){
          ({cdpClient:client}=await import('../src/chrome/src/cdp/cdp-client.js'));
          originalAttach=client.attach;session=await page.context().newCDPSession(page);
          client.attach=async()=>client.sessions.set(tabId,{});
          api.debugger={sendCommand:(_target,method,params,callback)=>{
            if(method==='Input.dispatchMouseEvent')commands.push(params.type);
            session.send(method,params).then(callback,error=>{
              api.runtime.lastError={message:error.message};callback();delete api.runtime.lastError;
            });
          }};
        }
        api.tabs.sendMessage=async(id,message)=>{
          if(message.action==='click_ax')routes.push({ref:message.params.ref_id,
            nativePrepare:message.params._prepareTrustedNativeButton===true,
            certified:!!agent._pageFeedbackRuns.get(tabId)?.dispatchCall?.expectedModelSnapshot});
          return transport(id,message);
        };
        const execute=async(ref_id,state)=>{
          const context={};
          assert.equal(await agent._messageRecipientGuardBlock(tabId,'click_ax',{ref_id},page.url(),context),null);
          assert.equal(context.nativeWhatsappReadRepairOwner,agent._nativeChatOwnerScope(tabId));
          assert.ok(state.actionBinding?.snapshotToken,'The real pre-decision capture must certify the original target.');
          const run=agent._pageFeedbackRuns.get(tabId);
          const certified=await f.validate('click_ax',ref_id,state);
          assert.equal(certified,true,'The original native Close must have a current private model certificate.');
          const prepared=await call('page_monitor_prepare',{runToken:run.token,operationId:'certified-contact-'+crypto.randomUUID(),
            tool:'click_ax',ref_id,expectedModelSnapshot:state.actionBinding.snapshotToken,allowPassiveRebase:true});
          assert.equal(prepared.ready,true,JSON.stringify(prepared));
          run.dispatchCall={name:'click_ax',args:{ref_id},modelState:state,
            expectedModelSnapshot:state.actionBinding.snapshotToken,dispatchState:{started:false},allowPassiveRebase:true};
          const ax=await call('get_accessibility_tree',{ref_id});
          assert.ok(ax.documentToken&&ax.refScopeUrl,'Use the actual AX document identity, not the monitor token.');
          agent._lastAxScopes.set(tabId,{documentToken:ax.documentToken,pageUrl:ax.refScopeUrl});
          return agent.executeTool(tabId,'click_ax',{ref_id},null,context);
        };
        const first=await f.observe(),openedState=await f.capture();
        assert.equal((await f.dispatch(first.nativeWhatsappRepair.ref_id,openedState)).success,true);
        await page.waitForTimeout(35);
        const current=await f.observe(),closedState=await f.capture();
        assert.equal(current.nativeWhatsappRepair.phase,'close_contact');
        const closeRef=current.nativeWhatsappRepair.ref_id;
        assert.equal(await page.evaluate(ref=>__wb_ax_lookup(ref)?.tagName,closeRef),'BUTTON');
        const closed=await execute(closeRef,closedState);
        assert.equal(closed.success,true,JSON.stringify(closed));
        const observed=await f.observe();
        const native=await page.evaluate(()=>({opened:qaOpened,closed:qaClosed,sent:qaSent}));
        console.log('Owned certified contact route '+JSON.stringify({build,native,
          closeInitialTrusted:closed.initialTrustedNativeButton===true,
          closeRepair:closed._nativeWhatsappReadRepair===true,
          canonicalObserved:observed.success===true,
          nextRepair:observed.nativeWhatsappRepair?.phase||null,
          closeRoutes:routes.filter(row=>row.ref===closeRef),commands}));
        assert.deepEqual(native,{opened:1,closed:1,sent:0});
        assert.equal(observed.success,true,'Closing the fresh owned drawer must establish canonical contact identity.');
        assert.equal(closed._nativeWhatsappReadRepair,true);
        assert.notEqual(closed.initialTrustedNativeButton,true);
        assert.ok(routes.some(row=>row.ref===closeRef&&row.certified),'Exercise the actual certified Agent dispatch route.');
        assert.equal(routes.some(row=>row.ref===closeRef&&row.nativePrepare),false);
        assert.deepEqual(commands,[],'Read-only contact repair cannot bypass its content hook through native input.');
      }finally{
        api.tabs.sendMessage=transport;api.runtime=runtime;api.debugger=debuggerApi;api.tabs.query=query;
        if(client){client.attach=originalAttach;client.sessions.delete(tabId);await session?.detach();}
      }
    });
  }finally{agent?._finishPageFeedbackRun(95);await browser.close();}
});
