import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { test } from 'node:test';
import { chromium, firefox } from 'playwright';
import { telegramLab } from './quality/native-chat-fixture.mjs';

for (const [build, engine] of [['chrome', chromium], ['firefox', firefox]]) {
  const sources = await Promise.all(['accessibility-tree.js','page-monitor.js','rich-text-toolbar-heuristic.js','chat-observation.js','content.js']
    .map(file => fs.readFile(new URL(`../src/${build}/src/content/${file}`, import.meta.url), 'utf8')));
  test(`${build}: owned native draft recovery retains the real pre-Enter boundary`, { timeout:60000 }, async t => {
    const browser = await engine.launch({ headless:true });
    try {
      const context = await browser.newContext({ viewport:{width:1200,height:900} });
      await context.route('**/*', route => route.fulfill({ contentType:'text/html', body:telegramLab }));
      const page = await context.newPage();
      const call = (action, params={}) => page.evaluate(({action,params}) => deliver(action,params), {action,params});
      const reset = async (mode='scroll') => {
        await page.goto('about:blank'); await page.goto('https://web.telegram.org/k/#123456');
        await page.evaluate(mode => {
          window.listeners=[]; window.feedback=[]; window.enters=0; window.trustedDraftInputs=0;
          window.chrome=window.browser={runtime:{getURL:x=>x,onMessage:{addListener(fn){listeners.push(fn);},removeListener(){}},
            async sendMessage(msg){if(msg.action==='get_page_monitor_state')return {active:true,runToken:'owned-draft-test',documentToken:msg.documentToken};
              if(msg.action==='page_feedback'){feedback.push(msg);return {accepted:true};}return {};}}};
          window.deliver=(action,params={})=>new Promise(resolve=>{
            for(const fn of listeners){let answered=false;const r=fn({target:'content',action,params:{runToken:'owned-draft-test',...params}}, {},v=>{answered=true;resolve(v);});
              if(answered||r===true)break;}});
          const input=document.querySelector('[contenteditable]');
          input.addEventListener('keydown',event=>{if(event.key==='Enter')enters++;});
          input.addEventListener('input',event=>{if(event.isTrusted)trustedDraftInputs++;});
          // Create enough real history for one native pixel of overflow.
          for(let i=0;i<20;i++)row('Owned old history '+i);
          const historyPane=document.querySelector('.bubbles-scrollable');
          if(historyPane.scrollHeight <= historyPane.clientHeight + 1)throw new Error('Native chat fixture must have scrollable history');
          input.addEventListener('input',()=>{
            if(window.draftWindowArmed||!input.textContent)return;
            window.draftWindowArmed=true;
            if(mode==='scroll')setTimeout(()=>{const pane=document.querySelector('.bubbles-scrollable');pane.scrollTop=pane.scrollHeight-pane.clientHeight-1;},20);
            if(mode.startsWith('resize')) {
              const pane=document.querySelector('.bubbles-scrollable');
              input.style.minHeight='51px'; pane.style.height=(pane.clientHeight-8)+'px';
              if(mode==='resize-class-cleanup') {
                input.classList.add('layout-changing-height','layout-animating');
                window.finishOwnLayout=()=>input.classList.remove('layout-changing-height','layout-animating');
              }
              if(mode==='resize-peer')document.querySelector('.peer-title').dataset.peerId='987654';
              if(mode==='resize-floor')row('An additional actual incoming message');
              if(mode==='resize-pending')document.querySelector('.bubble').classList.add('is-sending');
              if(mode==='resize-document')history.replaceState({},'',location.pathname+'#987654');
            }
          });
        }, mode);
        for(const source of sources) await page.addScriptTag({content:source});
        await page.waitForFunction(()=>__wbPageMonitor?.active);
        await page.waitForTimeout(180);
      };
      const prepare = async (binding=null, structured=true) => {
        const snapshot=await call('page_monitor_capture_model',{includeTree:true});
        const ref=await page.locator('[contenteditable]').evaluate(el=>__wb_ax_ref(el));
        const params={ref_id:ref,text:'Owned exact draft',clear:true,submit:true,_nativeChatOwner:'private-owner-1',_nativeChatDraftPreparation:structured,
          ...(binding?{_nativeChatDraftBinding:binding}:{})};
        const probe=await call('probe_message_recipient_guard',{tool:'set_field',args:params,adapterName:'telegram',bindDispatch:true,_nativeChatOwner:'private-owner-1'});
        assert.equal(probe.conclusive,true,JSON.stringify(probe)); assert.ok(probe.messageRecipientDispatchBinding?.token);
        const operationId=crypto.randomUUID();
        const prepared=await call('page_monitor_prepare',{operationId,allowPassiveRebase:true,tool:'set_field',...params});
        assert.equal(prepared.ready,true,JSON.stringify(prepared));
        const dispatch=await call('page_monitor_dispatch',{operationId,kind:'input',fenceOnly:true});
        assert.equal(dispatch.ready,true,JSON.stringify(dispatch));
        return {...params,messageRecipientGuardRequired:true,messageRecipientDispatchBinding:probe.messageRecipientDispatchBinding,pageFeedbackGuard:dispatch.guard};
      };
      const blockedDraft = async () => {
        const params=await prepare(); const result=await call('set_field',params);
        assert.equal(result.verified,true,JSON.stringify(result));
        assert.equal(result.dispatched,true,'The original draft was genuinely written.');
        assert.equal(result.submissionBlockedBeforeDispatch,true,JSON.stringify(result));
        assert.equal(result.submissionDispatched,false); assert.equal(result.outcomeUnknown,true);
        assert.ok(result._nativeChatDraftBinding?.token,'Only the live original native binding mints a draft lease.');
        assert.equal(await page.evaluate(()=>enters),0); assert.deepEqual(await page.evaluate(()=>qaReplies),[]);
        await call('page_monitor_finish',{operationId:params.pageFeedbackGuard.operationId});
        await page.evaluate(()=>{const pane=document.querySelector('.bubbles-scrollable');pane.scrollTop=pane.scrollHeight;});
        await page.waitForTimeout(180);
        return result._nativeChatDraftBinding;
      };
      await t.test('fresh owned observation and a new guarded action submit the exact existing draft once',async()=>{
        await reset();const binding=await blockedDraft();
        const observation=await call('observe_chat',{_nativeChatOwner:'private-owner-1',_nativeChatDraftBinding:binding});
        assert.equal(observation._nativeChatDraftCurrent,true);assert.equal(observation.composer.empty,false);
        const result=await call('set_field',await prepare(binding));
        assert.equal(result.submissionDispatched,true,JSON.stringify(result));
        assert.equal(await page.evaluate(()=>enters),1);assert.deepEqual(await page.evaluate(()=>qaReplies),['Owned exact draft']);
        assert.equal((await call('observe_chat',{_nativeChatOwner:'private-owner-1',_nativeChatDraftBinding:binding}))._nativeChatDraftCurrent,undefined,'Lease is one-use.');
      });
      for(const mutation of ['draft-change-return','header-peer-return','editor-replace-return','new-outgoing','incoming','human-input','different-owner','different-body','history-gap']) await t.test(`no recovery after ${mutation}`,async()=>{
        await reset();const binding=await blockedDraft();
        await page.evaluate(mutation=>{
          const input=document.querySelector('[contenteditable]'),header=document.querySelector('.peer-title');
          if(mutation==='draft-change-return'){const n=[...input.childNodes].find(n=>n.nodeType===Node.TEXT_NODE)||input.querySelector('span')?.firstChild;const v=n.nodeValue;n.nodeValue='Other draft';n.nodeValue=v;}
          if(mutation==='header-peer-return'){header.dataset.peerId='987654';header.dataset.peerId='123456';}
          if(mutation==='editor-replace-return'){const p=input.parentNode,next=input.nextSibling;input.remove();p.insertBefore(input,next);}
          if(mutation==='new-outgoing')row('Other actual outgoing',true);
          if(mutation==='incoming')row('New incoming question');
          if(mutation==='history-gap'){const pane=document.querySelector('.bubbles-scrollable');pane.scrollTop=0;}
        },mutation);
        if(mutation==='human-input'){await page.locator('[contenteditable]').focus();await page.keyboard.press('ArrowLeft');}
        const params={_nativeChatOwner:mutation==='different-owner'?'other-private-owner':'private-owner-1',_nativeChatDraftBinding:binding,
          ...(mutation==='different-body'?{text:'Other draft'}:{})};
        const observation=await call('observe_chat',params);
        assert.equal(observation._nativeChatDraftCurrent,undefined);
        const ref=await page.locator('[contenteditable]').evaluate(el=>__wb_ax_ref(el));
        const result=await call('set_field',{...params,ref_id:ref,text:mutation==='different-body'?'Other draft':'Owned exact draft',clear:true,submit:true});
        assert.equal(result.noDispatch,true,JSON.stringify(result));assert.equal(await page.evaluate(()=>enters),0);
        assert.deepEqual(await page.evaluate(()=>qaReplies),[]);
      });

      await t.test('latest-only read-only observation retains the exact lease until ordinary viewport repair',async()=>{
        await reset();const binding=await blockedDraft();
        await page.evaluate(()=>{const pane=document.querySelector('.bubbles-scrollable');pane.scrollTop=pane.scrollHeight-pane.clientHeight-12;});
        await page.waitForTimeout(180);
        const away=await call('observe_chat',{_nativeChatOwner:'private-owner-1',_nativeChatDraftBinding:binding});
        assert.equal(away.nativeLatestPosition.atLatest,false);assert.equal(away._nativeChatDraftRetained,true,JSON.stringify(away));
        assert.equal(away._nativeChatDraftCurrent,undefined);assert.equal(away.composer.available,false);
        assert.equal(await page.evaluate(()=>enters),0);assert.deepEqual(await page.evaluate(()=>qaReplies),[]);
        assert.equal(away.nativeChatReadRepair.phase,'read_latest');
        const repaired=await call('scroll',{ref_id:away.nativeChatReadRepair.ref_id,direction:'bottom'});
        assert.equal(repaired.success,true,JSON.stringify(repaired));await page.waitForTimeout(180);
        const fresh=await call('observe_chat',{_nativeChatOwner:'private-owner-1',_nativeChatDraftBinding:binding});
        assert.equal(fresh._nativeChatDraftCurrent,true,JSON.stringify(fresh));assert.equal(fresh._nativeChatDraftRetained,undefined);
        const result=await call('set_field',await prepare(binding));assert.equal(result.submissionDispatched,true,JSON.stringify(result));
        assert.equal(await page.evaluate(()=>enters),1);assert.deepEqual(await page.evaluate(()=>qaReplies),['Owned exact draft']);
      });
      await t.test('own composer resize before recipient consumption retains only an exact read-only draft',async()=>{
        await reset('resize');const params=await prepare();const result=await call('set_field',params);
        assert.equal(result.reasonCode,'native_chat_baseline_changed_before_dispatch',JSON.stringify(result));
        assert.equal(result.success,false);assert.equal(result.verified,true);assert.equal(result.dispatched,true);
        assert.equal(result.submissionDispatched,false);assert.equal(result.submissionOutcomeUnknown,false);
        assert.equal(result.submissionBlockedBeforeDispatch,true);assert.equal(result.draftMutationDispatched,true);
        assert.equal(result.outcomeUnknown,true,'Typing is still a page mutation, even though explicit Enter was blocked.');
        assert.ok(result._nativeChatDraftBinding?.token);assert.equal(await page.evaluate(()=>enters),0);
        assert.ok(await page.evaluate(()=>trustedDraftInputs)>0,'The real synchronous browser writer emitted trusted input.');
        assert.deepEqual(await page.evaluate(()=>qaReplies),[]);
        const geometry=await page.evaluate(()=>{const p=document.querySelector('.bubbles-scrollable');return {gap:p.scrollHeight-p.clientHeight-p.scrollTop};});
        assert.equal(geometry.gap,8,'The application layout alone moved the viewport away from latest.');
        await call('page_monitor_finish',{operationId:params.pageFeedbackGuard.operationId});
        const binding=result._nativeChatDraftBinding;
        const retained=await call('observe_chat',{_nativeChatOwner:'private-owner-1',_nativeChatDraftBinding:binding});
        assert.equal(retained.nativeLatestPosition.atLatest,false);assert.equal(retained._nativeChatDraftRetained,true);
        assert.equal(retained._nativeChatDraftCurrent,undefined);assert.equal(retained.composer.available,false);
        assert.equal(retained.nativeChatReadRepair.phase,'read_latest');
        assert.equal(await page.evaluate(()=>enters),0);assert.deepEqual(await page.evaluate(()=>qaReplies),[]);
        const repair=await call('scroll',{ref_id:retained.nativeChatReadRepair.ref_id,direction:'bottom'});
        assert.equal(repair.success,true,JSON.stringify(repair));await page.waitForTimeout(180);
        const fresh=await call('observe_chat',{_nativeChatOwner:'private-owner-1',_nativeChatDraftBinding:binding});
        assert.equal(fresh._nativeChatDraftCurrent,true,JSON.stringify(fresh));assert.equal(fresh.nativeLatestPosition.atLatest,true);
        const sent=await call('set_field',await prepare(binding));assert.equal(sent.submissionDispatched,true,JSON.stringify(sent));
        assert.equal(await page.evaluate(()=>enters),1);assert.deepEqual(await page.evaluate(()=>qaReplies),['Owned exact draft']);
      });
      await t.test('own editor layout-class cleanup preserves the exact draft through issued latest repair',async()=>{
        await reset('resize-class-cleanup');const params=await prepare();const result=await call('set_field',params);
        assert.equal(result.submissionDispatched,false);assert.equal(result.submissionOutcomeUnknown,false);
        assert.ok(result._nativeChatDraftBinding?.token);assert.equal(await page.evaluate(()=>enters),0);
        await call('page_monitor_finish',{operationId:params.pageFeedbackGuard.operationId});
        const binding=result._nativeChatDraftBinding;
        const away=await call('observe_chat',{_nativeChatOwner:'private-owner-1',_nativeChatDraftBinding:binding});
        assert.equal(away._nativeChatDraftRetained,true);assert.equal(away.nativeLatestPosition.atLatest,false);
        assert.equal(away.nativeChatReadRepair.phase,'read_latest');assert.equal(away.composer.available,false);
        const repair=await call('scroll',{ref_id:away.nativeChatReadRepair.ref_id,direction:'bottom'});
        assert.equal(repair.success,true);await page.waitForTimeout(180);
        await page.evaluate(()=>finishOwnLayout());
        const fresh=await call('observe_chat',{_nativeChatOwner:'private-owner-1',_nativeChatDraftBinding:binding});
        assert.equal(fresh._nativeChatDraftCurrent,true,JSON.stringify(fresh));assert.equal(fresh.nativeLatestPosition.atLatest,true);
        assert.equal(fresh.composer.empty,false);assert.equal(await page.locator('[contenteditable]').textContent(),'Owned exact draft');
        const ownInputs=await page.evaluate(()=>trustedDraftInputs);
        const sent=await call('set_field',await prepare(binding));assert.equal(sent.submissionDispatched,true,JSON.stringify(sent));
        assert.equal(await page.evaluate(()=>trustedDraftInputs),ownInputs,'Recovery submits the existing exact draft without another native write.');
        assert.equal(await page.evaluate(()=>enters),1);assert.deepEqual(await page.evaluate(()=>qaReplies),['Owned exact draft']);
      });
      await t.test('a layout class that currently hides the owned composer never grants draft recovery',async()=>{
        await reset();const binding=await blockedDraft();
        await page.evaluate(()=>{const style=document.createElement('style');style.textContent='.layout-hidden{display:none!important}';document.head.append(style);document.querySelector('[contenteditable]').classList.add('layout-hidden');});
        const observed=await call('observe_chat',{_nativeChatOwner:'private-owner-1',_nativeChatDraftBinding:binding});
        assert.equal(observed._nativeChatDraftCurrent,undefined);assert.equal(observed._nativeChatDraftRetained,undefined);
        const ref=await page.locator('[contenteditable]').evaluate(el=>__wb_ax_ref(el));
        const attempted=await call('set_field',{ref_id:ref,text:'Owned exact draft',submit:true,_nativeChatOwner:'private-owner-1',_nativeChatDraftBinding:binding});
        assert.equal(attempted.noDispatch,true);assert.equal(await page.evaluate(()=>enters),0);assert.deepEqual(await page.evaluate(()=>qaReplies),[]);
      });
      await t.test('a pending-status class change-and-return on another native node still retires the lease',async()=>{
        await reset();const binding=await blockedDraft();
        await page.evaluate(()=>{const row=document.querySelector('.bubble');row.classList.add('is-sending');row.classList.remove('is-sending');});
        const observed=await call('observe_chat',{_nativeChatOwner:'private-owner-1',_nativeChatDraftBinding:binding});
        assert.equal(observed._nativeChatDraftCurrent,undefined);assert.equal(observed._nativeChatDraftRetained,undefined);
        const ref=await page.locator('[contenteditable]').evaluate(el=>__wb_ax_ref(el));
        const attempted=await call('set_field',{ref_id:ref,text:'Owned exact draft',submit:true,_nativeChatOwner:'private-owner-1',_nativeChatDraftBinding:binding});
        assert.equal(attempted.noDispatch,true);assert.equal(await page.evaluate(()=>enters),0);assert.deepEqual(await page.evaluate(()=>qaReplies),[]);
      });

      for (const mutation of ['foreign-class','hidden-return','disabled-current','own-removal-return','class-reorder']) await t.test(`no draft recovery after composer ${mutation}`,async()=>{
        await reset(mutation==='own-removal-return'?'resize-class-cleanup':'scroll');
        let binding;
        if(mutation==='class-reorder')await page.evaluate(()=>document.querySelector('[contenteditable]').classList.add('preexisting-layout-token'));
        if(mutation==='own-removal-return') {
          const params=await prepare();const result=await call('set_field',params);
          assert.equal(result.submissionDispatched,false);assert.equal(result.submissionOutcomeUnknown,false);
          assert.ok(result._nativeChatDraftBinding?.token);binding=result._nativeChatDraftBinding;
          await call('page_monitor_finish',{operationId:params.pageFeedbackGuard.operationId});
          const away=await call('observe_chat',{_nativeChatOwner:'private-owner-1',_nativeChatDraftBinding:binding});
          assert.equal(away._nativeChatDraftRetained,true);assert.equal(away.nativeChatReadRepair.phase,'read_latest');
          assert.equal((await call('scroll',{ref_id:away.nativeChatReadRepair.ref_id,direction:'bottom'})).success,true);
          await page.waitForTimeout(180);
        } else binding=await blockedDraft();
        const history=await page.evaluate(mutation=>{
          const input=document.querySelector('[contenteditable]');
          if(mutation==='foreign-class')input.classList.add('unrelated-application-state');
          if(mutation==='class-reorder') {const classes=[...input.classList];input.setAttribute('class',classes.reverse().join(' '));return classes.length>1;}
          if(mutation==='disabled-current')input.setAttribute('aria-disabled','true');
          if(mutation==='hidden-return') {
            const style=document.createElement('style');style.textContent='.layout-hidden{display:none!important}';document.head.append(style);
            input.classList.add('layout-hidden');const hidden=input.getBoundingClientRect().height===0;input.classList.remove('layout-hidden');return hidden;
          }
          if(mutation==='own-removal-return') {input.classList.remove('layout-animating');input.classList.add('layout-animating');}
          return true;
        },mutation);
        assert.equal(history,true,'The hidden-return case genuinely reached hidden layout before restoration.');
        const observed=await call('observe_chat',{_nativeChatOwner:'private-owner-1',_nativeChatDraftBinding:binding});
        assert.equal(observed._nativeChatDraftCurrent,undefined);assert.equal(observed._nativeChatDraftRetained,undefined);
        const ref=await page.locator('[contenteditable]').evaluate(el=>__wb_ax_ref(el));
        const attempted=await call('set_field',{ref_id:ref,text:'Owned exact draft',submit:true,_nativeChatOwner:'private-owner-1',_nativeChatDraftBinding:binding});
        assert.equal(attempted.noDispatch,true);assert.equal(await page.evaluate(()=>enters),0);assert.deepEqual(await page.evaluate(()=>qaReplies),[]);
      });

      await t.test('real user type-and-return during the asynchronous verification retires pre-Enter ownership',async()=>{
        await reset('resize');const params=await prepare();
        await page.evaluate(()=>{
          const originalSetTimeout=window.setTimeout;
          const gate=window.__qaOuterVerificationGate={captured:0,released:0,ready:false,releaseRequested:false,originalSetTimeout,releaseHeld:null};
          window.setTimeout=function(callback,delay,...args){
            if(window.draftWindowArmed===true&&typeof callback==='function'&&typeof delay==='number'&&delay===80){
              window.setTimeout=originalSetTimeout;
              gate.captured++;
              return Reflect.apply(originalSetTimeout,window,[()=>{
                gate.releaseHeld=()=>{
                  if(gate.released!==0)throw new Error('The outer verification callback was already released.');
                  gate.released++;
                  return Reflect.apply(callback,window,args);
                };
                gate.ready=true;
                if(gate.releaseRequested)gate.releaseHeld();
              },delay]);
            }
            return Reflect.apply(originalSetTimeout,window,[callback,delay,...args]);
          };
        });
        const waiting=call('set_field',params);
        try {
          await page.waitForFunction(()=>draftWindowArmed===true);
          await page.waitForFunction(()=>__qaOuterVerificationGate.ready===true);
          assert.equal(await page.evaluate(()=>__qaOuterVerificationGate.captured),1);
          assert.equal(await page.evaluate(()=>window.setTimeout===__qaOuterVerificationGate.originalSetTimeout),true);
          const trustedBefore=await page.evaluate(()=>trustedDraftInputs);
          await page.keyboard.type('x');await page.keyboard.press('Backspace');
          assert.equal(await page.locator('[contenteditable]').textContent(),'Owned exact draft');
          assert.ok(await page.evaluate(()=>trustedDraftInputs)>trustedBefore,'Real keyboard input occurred while the outer verification callback was held.');
          assert.equal(await page.evaluate(()=>__qaOuterVerificationGate.released),0);
        } finally {
          await page.evaluate(()=>{
            const gate=__qaOuterVerificationGate;
            window.setTimeout=gate.originalSetTimeout;
            gate.releaseRequested=true;
            if(gate.ready&&gate.released===0)gate.releaseHeld();
          });
        }
        const result=await waiting;
        assert.equal(await page.evaluate(()=>__qaOuterVerificationGate.captured),1);
        assert.equal(await page.evaluate(()=>__qaOuterVerificationGate.released),1);
        assert.equal(await page.locator('[contenteditable]').textContent(),'Owned exact draft');
        assert.equal(result.success,false);assert.equal(result.verified,true,JSON.stringify(result));
        assert.equal(result.submissionDispatched,false);assert.equal(result.submissionOutcomeUnknown,false);
        assert.equal(result._nativeChatDraftBinding,undefined,'Real input outside the synchronous writer is never attributed to the agent.');
        assert.equal(await page.evaluate(()=>enters),0);assert.deepEqual(await page.evaluate(()=>qaReplies),[]);
      });
      for(const mode of ['resize-peer','resize-floor','resize-pending','resize-document']) await t.test(`pre-Enter ${mode} reports no submit without minting an unsafe lease`,async()=>{
        await reset(mode);const params=await prepare();const result=await call('set_field',params);
        assert.equal(result.success,false,JSON.stringify(result));assert.equal(result.verified,true);
        assert.equal(result.dispatched,true);assert.equal(result.submissionDispatched,false);
        assert.equal(result.submissionOutcomeUnknown,false);assert.equal(result.submissionBlockedBeforeDispatch,true);
        assert.equal(result.outcomeUnknown,true);assert.equal(result._nativeChatDraftBinding,undefined);
        assert.equal(await page.evaluate(()=>enters),0);assert.deepEqual(await page.evaluate(()=>qaReplies),[]);
      });
      await t.test('real wheel intervention retires a latest-only lease instead of promoting it',async()=>{
        await reset();const binding=await blockedDraft();const pane=page.locator('.bubbles-scrollable');await pane.hover();await page.mouse.wheel(0,-30);await page.waitForTimeout(180);
        const observation=await call('observe_chat',{_nativeChatOwner:'private-owner-1',_nativeChatDraftBinding:binding});
        assert.equal(observation._nativeChatDraftCurrent,undefined);assert.equal(observation._nativeChatDraftRetained,undefined);
        assert.equal(await page.evaluate(()=>enters),0);assert.deepEqual(await page.evaluate(()=>qaReplies),[]);
      });
      await t.test('generic field submission never exposes a structured draft lease',async()=>{
        await reset();const result=await call('set_field',await prepare(null,false));
        assert.equal(result.verified,true);assert.equal(result.dispatched,true);
        assert.equal(result.submissionBlockedBeforeDispatch,true);assert.equal(result.submissionDispatched,false);
        assert.equal(result._nativeChatDraftBinding,undefined);assert.equal(await page.evaluate(()=>enters),0);
      });
      await t.test('a real Enter without delivery remains uncertain and has no recoverable pre-Enter lease',async()=>{
        await reset('none');await page.evaluate(()=>{document.querySelector('[contenteditable]').addEventListener('keydown',e=>{if(e.key==='Enter'){e.stopImmediatePropagation();e.preventDefault();}},true);});
        const result=await call('set_field',await prepare());
        assert.equal(result.submissionDispatched,true);assert.equal(result.submissionBlockedBeforeDispatch,false);
        assert.equal(result._nativeChatDraftBinding,undefined);assert.equal(result.outcomeUnknown,true);
        assert.deepEqual(await page.evaluate(()=>qaReplies),[]);
      });
      await context.close();
    } finally { await browser.close(); }
  });
}
