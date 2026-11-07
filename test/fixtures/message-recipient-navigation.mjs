import { strict as assert } from 'node:assert';
import { guardProbeWithReadings, probeWithReadings, stubPageTextReadings } from '../semantic-decision-stub.mjs';

export function registerMessageRecipientNavigationFixtures({
  test, firefoxTest, setupContentHtml, call, Agent, FirefoxAgent,
}) {
  // The recipient guard's page check, run as the agent runs it: control names
  // it consulted unread are read by the fixtures' model oracle first.
  const guardCall = (page, params) => guardProbeWithReadings(next => call(page, 'probe_message_recipient_guard', next), params);
  for (const [kind, register, AgentClass] of [
    ['chrome', test, Agent],
    ['firefox', firefoxTest, FirefoxAgent],
  ]) {
    const setup = async (page) => {
      // Keep the real origin and URL parsing without contacting LinkedIn.
      await page.route('**/*', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html>' }));
      await page.goto('https://www.linkedin.com/feed/');
      await setupContentHtml(page, `<!doctype html>
        <style>
          body { margin: 0; font: 16px sans-serif; }
          nav { display: flex; gap: 30px; padding: 20px; }
          a, button { display: inline-block; padding: 8px; }
          #chat { position: fixed; right: 20px; bottom: 20px; width: 360px; }
          #body { width: 260px; height: 60px; }
          #chat h2 { position: fixed; right: 200px; top: 80px; margin: 0; }
        </style>
        <nav aria-label="Primary">
          <a id="home" class="destination" href="/feed/">Home</a>
          <a id="jobs" class="destination" href="/jobs/"><span id="jobs-label">Jobs</span></a>
          <a id="messaging" href="/messaging/">Messaging</a>
        </nav>
        <main>
          <a id="portfolio" href="https://portfolio.example/"><span id="portfolio-label">View my portfolio</span></a>
          <a id="contact-info" href="/in/alice/overlay/contact-info/">Contact info</a>
        </main>
        <div id="contact-info-dialog" role="dialog" aria-modal="true" hidden>
          <button id="close-contact-info" type="button">Close</button>
          <a id="contact-profile" href="/in/alice/">linkedin.com/in/alice</a>
          <a id="safety-portfolio" href="/safety/go/?url=https%3A%2F%2Fportfolio.example%2F">portfolio.example</a>
          <a id="legacy-portfolio" href="/redir/redirect?url=https%3A%2F%2Flegacy-portfolio.example%2F">legacy-portfolio.example</a>
        </div>
        <form id="chat" hidden>
          <h2>Alice</h2><textarea id="body">Hello Alice</textarea><button id="send" type="button">Send</button>
        </form>`, kind);
      await page.evaluate(() => {
        window.fixtureClicks = [];
        document.addEventListener('click', event => {
          const target = event.target.closest('a,button');
          if (target) { event.preventDefault(); window.fixtureClicks.push(target.id); }
        });
      });
      const agent = new AgentClass({ getActive: () => ({ supportsVision: false }) });
      agent._messageRecipientContentProbe = (_, params) => call(page, 'probe_message_recipient_guard', params);
      // Control names are read by the fixtures' model oracle, as the agent's
      // model reads them before the recipient guard decides.
      stubPageTextReadings(agent);
      const guard = (tool, args) => agent._messageRecipientGuardBlock(1, tool, args, page.url());
      const probe = (tool, args) => guardCall(page, { tool, args, adapterName: 'linkedin' });
      return { agent, guard, probe };
    };

    const setupMessageHistory = async page => {
      await page.route('**/*', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html>' }));
      await page.goto('https://www.linkedin.com/messaging/thread/example/');
      await setupContentHtml(page, `<!doctype html><style>
        body { margin:0; font:16px sans-serif } button { padding:8px }
        #rail { position:absolute;left:30px;top:30px;width:270px;height:500px;list-style:none;padding:0 }
        #rail li { height:90px } #rail h3 { margin:0;padding:10px;height:30px }
        #history { position:absolute;left:350px;top:80px;width:400px;height:340px;overflow:auto }
        #preview { width:220px;height:140px } #preview img { width:190px;height:100px }
        #composer { position:absolute;left:350px;top:430px;width:400px;height:200px }
        textarea { width:300px;height:70px } #viewer { position:fixed;left:330px;top:80px;width:420px;height:320px;background:white;border:2px solid black;z-index:10 }
      </style><ul id="rail" aria-label="Conversation List" class="msg-conversations-container__conversations-list">
        <li id="row" tabindex="0" aria-label="Ipek conversation"><h3 id="row-label">Ipek conversation</h3><button id="row-options" type="button"><span id="row-options-label">Conversation options</span></button></li>
      </ul><div id="history" class="msg-s-message-list" role="log">
        <div class="msg-s-event-listitem"><h4>Ipek</h4>
          <button id="preview" type="button" aria-label="Click or press enter to display in the image preview">
            <img id="preview-image" alt="Event invitation" src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7">
          </button>
        </div>
      </div><form id="composer" class="msg-form"><h2>Conversation with Ipek</h2>
        <textarea aria-label="Write a message">Existing unsent draft</textarea><button id="send" type="button">Send</button>
      </form><div id="viewer" role="dialog" aria-modal="true" hidden><h2>Ipek's workshop invitation</h2>
        <p>Browser workshop. October 8, 2026. 14:00–15:00. Europe/Istanbul.</p><button id="close-viewer" type="button">Close preview</button>
      </div>`, kind);
      await page.evaluate(() => {
        document.querySelector('#preview').addEventListener('click', () => { document.querySelector('#viewer').hidden = false; });
        document.querySelector('#close-viewer').addEventListener('click', () => { document.querySelector('#viewer').hidden = true; });
        window.sentMessages = 0;
        document.querySelector('#send').addEventListener('click', () => { window.sentMessages++; });
      });
      const agent = new AgentClass({ getActive: () => ({ supportsVision: false }) });
      agent.conversations.set(1, [{ role: 'system', content: 'sys' }, { role: 'user', content: 'Read Ipek’s event invitation.' }]);
      agent._startPlanExecutionGuard(1, 'act', { requiresStateChange: false, requiresSubmission: false });
      agent._messageRecipientContentProbe = (_, params) => call(page, 'probe_message_recipient_guard', params);
      // Control names are read by the fixtures' model oracle, as the agent's
      // model reads them before the recipient guard decides.
      stubPageTextReadings(agent);
      return { agent, guard: (tool, args) => agent._messageRecipientGuardBlock(1, tool, args, page.url()) };
    };

    register(`${kind}: steering after a submission permits verified social recovery controls`, async page => {
      await page.route('**/*', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html>' }));
      for (const [url, label, publishId] of [
        ['https://x.com/compose/post', 'Close', 'tweetButton'],
        ['https://bsky.app/', 'Cancel', 'composerPublishBtn'],
        ['https://bsky.app/', 'Keep editing', 'composerPublishBtn'],
      ]) {
        await page.goto(url);
        await setupContentHtml(page, `<!doctype html><div role="dialog">
          <div role="textbox" contenteditable="true">Existing draft</div>
          <button id="recover" type="button" aria-label="${label}"><span id="recover-label">${label}</span></button>
          <button id="publish" type="button" data-testid="${publishId}">Post</button>
          <button id="draft-tool" type="button">Other action</button>
          <button id="unknown" data-testid="composerOtherAction">Other action</button>
        </div>`, kind);
        await page.evaluate(() => {
          window.recoveryClicks = 0; window.publishClicks = 0;
          document.querySelector('#recover').onclick = () => window.recoveryClicks++;
          document.querySelector('#publish').onclick = () => window.publishClicks++;
        });
        const agent = new AgentClass({ getActive: () => ({ supportsVision: false }) });
        agent.conversations.set(1, [{ role: 'system', content: 'sys' }, { role: 'user', content: 'Inspect the previous publication.' }]);
        const guard = agent._startPlanExecutionGuard(1, 'act', { requiresStateChange: true });
        guard.steeringPriorSubmission = { dispatched: true, observedAfterSubmit: false };
        // Captions are read the way the agent runs the probe: unread ones by
        // the fixtures' model oracle before the final pass.
        const probe = (tool, args) => probeWithReadings((name, passArgs) => page.evaluate(({ source, tool, args }) =>
          Function('return (' + source + ')')()(tool, args), { source: AgentClass._submitActionProbe.toString(), tool: name, args: passArgs }),
        tool, args);
        const tree = await call(page, 'get_accessibility_tree', { filter: 'visible', maxChars: 20000 });
        const ref = new RegExp(`button "${label}" \\[([^\\]]+)\\]`).exec(tree.pageContent)?.[1];
        assert.ok(ref, tree.pageContent);
        const point = await page.locator('#recover').evaluate(el => {
          const rect = el.getBoundingClientRect(); return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
        });
        for (const [tool, args] of [
          ['click', { selector: '#recover-label' }], ['click', { text: label, textMatch: 'exact' }],
          ['click_ax', { ref_id: ref }], ['click', point],
        ]) {
          const detected = await probe(tool, args);
          assert.equal(detected?.resolvedNonSubmitTarget, true, `${label}/${tool}: real target is safe`);
          assert.equal(agent._steeringPriorSubmissionBlock(1, tool, args, detected), null, `${label}/${tool}`);
          assert.equal((await call(page, tool, args)).success, true);
        }
        // A plain type=button tool of the app-identified composer (one editor,
        // a strong publish control beside it) only edits the unsent draft, so
        // it cannot repeat the earlier submission.
        const toolArgs = { selector: '#draft-tool' };
        const tool = await probe('click', toolArgs);
        assert.equal(tool?.resolvedDraftControl, true, `${label}: composer tool is draft-local`);
        assert.equal(agent._steeringPriorSubmissionBlock(1, 'click', toolArgs, tool), null, `${label}: composer tool`);
        // Publishing again waits for the earlier post to be reconciled. A
        // typeless button with an app test id the probe does not know, and a
        // selector that matches nothing, are unidentified targets.
        for (const [selector, reason] of [
          ['#publish', 'prior_effect_unreconciled'], ['#unknown', 'target_unresolved'], ['#missing', 'target_unresolved'],
        ]) {
          const args = { selector };
          const block = agent._steeringPriorSubmissionBlock(1, 'click', args, await probe('click', args));
          assert.equal(block?.noDispatch, true, `${label}: ${selector}`);
          assert.equal(block.actionGuard?.reason, reason, `${label}: ${selector}`);
        }
        assert.deepEqual(await page.evaluate(() => [window.recoveryClicks, window.publishClicks]), [4, 0]);
      }
    });

    register(`${kind}: LinkedIn history previews and native conversation rows are not sends`, async page => {
      const { guard } = await setupMessageHistory(page);
      const tree = await call(page, 'get_accessibility_tree', { filter: 'visible', maxChars: 20000 });
      const previewRef = /button "Click or press enter to display in the image preview" \[([^\]]+)\]/.exec(tree.pageContent)?.[1];
      const sendRef = /button "Send" \[([^\]]+)\]/.exec(tree.pageContent)?.[1];
      assert.ok(previewRef, tree.pageContent);
      assert.ok(sendRef, tree.pageContent);
      const rect = await page.locator('#preview').evaluate(el => { const r=el.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}; });
      for (const [tool, args] of [
        ['click', { selector: '#preview' }], ['click', { text: 'Click or press enter to display in the image preview' }],
        ['click_ax', { ref_id: previewRef }], ['click', rect], ['click', { selector: '#preview-image' }],
        ['click', { selector: '#row' }], ['click', { selector: '#row-label' }], ['click', { text: 'Ipek conversation' }],
      ]) assert.equal(await guard(tool, args), null, JSON.stringify({tool,args}));
      for (const selector of ['#row-options', '#row-options-label', '#send']) {
        assert.equal((await guard('click', { selector }))?.noDispatch, true, selector);
      }
      const sendPoint = await page.locator('#send').evaluate(el => {const r=el.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};});
      for (const [tool,args] of [['click',{text:'Send'}],['click_ax',{ref_id:sendRef}],['click',sendPoint]]) {
        assert.equal((await guard(tool,args))?.noDispatch,true,JSON.stringify({tool,args}));
      }
      await page.locator('#row-options').evaluate(el => {el.style='position:absolute;left:0;top:0;width:270px;height:90px';});
      assert.equal((await guard('click',{selector:'#row'}))?.noDispatch,true,'row center over nested action');
      await page.locator('textarea').focus();
      assert.equal((await guard('press_keys', { key: 'Enter' }))?.noDispatch, true);
      assert.equal(await page.evaluate(() => window.sentMessages), 0);
    });

    register(`${kind}: localized LinkedIn attachment viewers open across selector, text, AX, and coordinate targeting`, async page => {
      const { guard } = await setupMessageHistory(page);
      for (const label of ['Görsel önizlemesinde görüntülemek için tıklayın veya Enter tuşuna basın',
        'Cliquez ou appuyez sur Entrée pour afficher un aperçu de l’image',
        'Clique ou pressione Enter para exibir na visualização da imagem']) {
        await page.locator('#preview').evaluate((el, label) => el.setAttribute('aria-label', label), label);
        const tree = await call(page, 'get_accessibility_tree', { filter: 'visible', maxChars: 20000 });
        const ref = tree.pageContent.split('\n').find(line => line.includes(`button "${label}"`))?.match(/\[([^\]]+)\]/)?.[1];
        assert.ok(ref, tree.pageContent);
        const point = await page.locator('#preview').evaluate(el => {
          const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
        });
        for (const [tool, args] of [['click', { selector: '#preview' }], ['click', { text: label, textMatch: 'exact' }],
          ['click_ax', { ref_id: ref }], ['click', point], ['click', { selector: '#preview-image' }]]) {
          assert.equal(await guard(tool, args), null, `${label}/${tool}`);
          assert.equal((await call(page, tool, args)).success, true);
          assert.equal(await page.locator('#viewer').isVisible(), true);
          await page.locator('#close-viewer').click();
        }
      }
      assert.equal(await page.evaluate(() => window.sentMessages), 0);
    });

    register(`${kind}: form-free LinkedIn previews need no explicit button type`, async page => {
      for (const tag of ['button', 'div']) {
        const { guard } = await setupMessageHistory(page);
        await page.evaluate(tag => {
          const original = document.querySelector('#preview');
          original.removeAttribute('type');
          if (tag === 'div') {
            const control = document.createElement('div');
            for (const attribute of original.attributes) control.setAttribute(attribute.name, attribute.value);
            control.setAttribute('role', 'button'); control.tabIndex = 0;
            control.append(...original.childNodes); original.replaceWith(control);
            control.onclick = () => { document.querySelector('#viewer').hidden = false; };
          }
        }, tag);
        const tree = await call(page, 'get_accessibility_tree', { filter: 'visible', maxChars: 20000 });
        const ref = /button "Click or press enter to display in the image preview" \[([^\]]+)\]/.exec(tree.pageContent)?.[1];
        assert.ok(ref, tree.pageContent);
        const point = await page.locator('#preview').evaluate(el => {
          const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
        });
        for (const [tool, args] of [['click', { selector: '#preview' }], ['click', { text: 'Click or press enter to display in the image preview' }],
          ['click_ax', { ref_id: ref }], ['click', point]]) {
          assert.equal(await guard(tool, args), null, `${tag}/${tool}`);
          assert.equal((await call(page, tool, args)).success, true);
          assert.equal(await page.locator('#viewer').isVisible(), true);
          await page.locator('#close-viewer').click();
        }
        assert.equal(await page.evaluate(() => window.sentMessages), 0);
      }
    });

    register(`${kind}: LinkedIn preview lookalikes and hidden or occluded images stay protected`, async page => {
      const { guard } = await setupMessageHistory(page);
      for (const change of ['no-image', 'composer', 'hidden', 'transparent', 'ancestor-transparent', 'occluded', 'disabled', 'commit-label', 'commit-text',
        'localized-send', 'submit', 'external-form', 'outside-history', 'small-icon', 'menu', 'image-hidden']) {
        await page.evaluate(change => {
          const button=document.querySelector('#preview');
          window.originalPreview=button.cloneNode(true);
          if(change==='no-image')button.querySelector('img').remove();
          if(change==='composer')document.querySelector('#composer').append(button);
          if(change==='hidden')button.hidden=true;
          if(change==='transparent')button.style.opacity='0';
          if(change==='ancestor-transparent')button.parentElement.style.opacity='0';
          if(change==='disabled')button.disabled=true;
          if(change==='commit-label')button.title='Send';
          if(change==='commit-text'){button.title='View image';button.append('Send');}
          if(change==='localized-send')button.setAttribute('aria-label','Gönder');
          if(change==='submit')button.type='submit';
          if(change==='external-form'){button.removeAttribute('type');button.setAttribute('form','composer');}
          if(change==='outside-history')document.body.append(button);
          if(change==='small-icon')button.querySelector('img').style='width:20px;height:20px';
          if(change==='menu')button.setAttribute('aria-haspopup','menu');
          if(change==='image-hidden')button.querySelector('img').style.visibility='hidden';
          if(change==='occluded') {
            const cover=document.createElement('div');cover.id='cover';
            cover.style='position:fixed;left:350px;top:80px;width:400px;height:340px;z-index:20;background:white';document.body.append(cover);
          }
        }, change);
        assert.equal((await guard('click', { selector:'#preview' }))?.noDispatch, true, change);
        await page.evaluate(() => {
          document.querySelector('#preview').remove(); document.querySelector('.msg-s-event-listitem').append(window.originalPreview);
          document.querySelector('.msg-s-event-listitem').style.opacity='';
          document.querySelector('#cover')?.remove();
        });
      }
      await page.evaluate(() => {document.querySelector('#viewer').hidden=false;});
      assert.equal((await guard('click', {selector:'#preview'}))?.noDispatch,true,'background image behind modal');
    });

    register(`${kind}: Ipek steering replays a message invitation into exactly one calendar event`, async page => {
      const { agent, guard } = await setupMessageHistory(page);
      agent._persist = () => {}; agent._persistSubmittedTurn = async () => {};
      agent._getTabUrlTitle = async () => ({tabUrl:page.url(),tabTitle:'Messaging'});
      agent._ensureProgressSessionForCurrentTask = async () => {};
      agent._plannerMode = () => 'off';
      agent._runPlannerIntentGate = async (_tab,enriched) => {
        assert.match(enriched.content,/Add this event to my Google Calendar/); assert.match(enriched.content,/Ipek/);
        return {proceed:true,requestKind:'execute',requiresStateChange:true,requiresSubmission:true};
      };
      agent.conversations.set(1,[{role:'system',content:'sys'},{role:'user',content:'Add this event to my Google Calendar.'}]);
      agent._startPlanExecutionGuard(1,'act',{requiresStateChange:true,requiresSubmission:true});
      agent._beginSteeringRun(1,()=>{},{detachedRequestId:'replay'});
      agent._runningTabs.add(1);
      assert.equal(agent.steerMessage(1,'Use Ipek’s message',{requestId:'replay',messageId:'ipek'}).accepted,true);
      const refresh=await agent._revalidatePendingSteering(1,agent.conversations.get(1),()=>{},'act',null,null,{});
      assert.equal(refresh.gate.proceed,true);
      await page.evaluate(() => {
        const recent=document.createElement('div');recent.style.height='500px';recent.textContent='Emre: a recent photo';
        document.querySelector('#history').append(recent);
        document.querySelector('#history').scrollTop=10000;
      });
      assert.equal((await guard('click',{selector:'#preview'}))?.noDispatch,true,'earlier invitation must be brought into view');
      const scrolled=await call(page,'scroll',{direction:'up',amount:700,x:550,y:250});
      assert.equal(scrolled.success,true,JSON.stringify(scrolled));
      assert.equal(await guard('click',{selector:'#preview'}),null);
      assert.equal((await call(page,'click',{selector:'#preview'})).success,true);
      const invitation=await call(page,'get_page_info_cdp',{});
      assert.match(JSON.stringify(invitation),/Browser workshop/);
      assert.match(JSON.stringify(invitation),/October 8, 2026/);
      assert.match(JSON.stringify(invitation),/Europe\/Istanbul/);
      await page.goto('https://calendar.google.com/calendar/u/0/r');
      await setupContentHtml(page, `<!doctype html><form>
        <input id="title" aria-label="Event title"><input id="date" aria-label="Date"><input id="start" aria-label="Start time">
        <input id="end" aria-label="End time"><input id="zone" aria-label="Time zone"><button id="save" type="button">Save</button>
      </form><div id="confirmation" role="status"></div>`,kind);
      await page.evaluate(() => {
        window.savedEvents=[];
        document.querySelector('#save').addEventListener('click',()=>{
          window.savedEvents.push(Object.fromEntries(['title','date','start','end','zone'].map(key=>[key,document.getElementById(key).value])));
          document.querySelector('#confirmation').textContent='Event saved';
        });
      });
      for(const [key,text] of Object.entries({title:'Browser workshop',date:'2026-10-08',start:'14:00',end:'15:00',zone:'Europe/Istanbul'})) {
        assert.equal((await call(page,'type',{selector:'#'+key,text,clear:true})).success,true);
      }
      assert.equal((await call(page,'click',{selector:'#save'})).success,true);
      assert.deepEqual(await page.evaluate(()=>window.savedEvents),[{title:'Browser workshop',date:'2026-10-08',start:'14:00',end:'15:00',zone:'Europe/Istanbul'}]);
      assert.match(JSON.stringify(await call(page,'get_page_info_cdp',{})),/Event saved/);
      assert.equal(agent._planExecutionGuards.get(1).taskDrifted,false);
      agent._finishSteeringRun(1);agent._runningTabs.delete(1);
    });

    register(`${kind}: X sent DM completes with the open composer and exact outgoing delivery evidence`, async (page) => {
      const { agent } = await setup(page);
      const url = 'https://x.com/i/chat/123-456';
      await page.goto(url);
      await setupContentHtml(page, `<!doctype html><style>
        body {margin:0} [dir=auto] {white-space:pre-wrap} #header {position:fixed;left:400px;top:20px}
        textarea {position:fixed;left:400px;bottom:20px;width:400px;height:50px}
        #send {position:fixed;left:820px;bottom:20px}
        [role=log] {position:fixed;left:400px;top:100px;width:400px;height:300px;overflow:auto}
      </style><a id="header" href="https://x.com/altryne"><div data-testid="dm-conversation-username">Alex Volkov</div></a>
      <div role="log" data-testid="dm-message-scroller" aria-busy="false"></div>
      <textarea data-testid="dm-composer-textarea" aria-label="Unencrypted message"></textarea>
      <button id="send" type="button">Send</button>`, kind);
      const body = 'Hey Alex, check out webbrain.one.\nHappy to share a demo.';
      const params = {tool:'observe_active_conversation',adapterName:'twitter',expectedMessageBody:body};
      const observe = () => guardCall(page, params);
      const addRow = async (id, status='sent', outgoing=true, text=body) => page.evaluate(({id,status,outgoing,text})=>{
        const row=document.createElement('div');row.dataset.testid='message-'+id;
        row.dataset.sendStatus=status;row.className=outgoing?'justify-end':'justify-start';
        const content=document.createElement('div');content.dataset.testid='message-text-'+id;
        const span=document.createElement('span');span.dir='auto';span.textContent=text;
        content.append(span);content.append('12:39 PM');row.append(content);
        document.querySelector('[role=log]').append(row);
      },{id,status,outgoing,text});
      await addRow('old');
      await addRow('hidden');
      await page.locator('[data-testid="message-hidden"]').evaluate(el => { el.hidden = true; });
      await addRow('already-pending', 'sending');
      const pinned=await agent._pinActiveConversationMessagingTarget(1,{target_kind:'active_conversation',recipients:[]},url);
      assert.equal(pinned.ok,true,JSON.stringify(pinned));
      assert.equal(pinned.target.recipients[0].identity,'@altryne');
      const workflow=agent._resolvePlannerSiteWorkflow(url,{
        request_kind:'execute',site_job:null,requires_submission:true,messaging:pinned.target,
      });
      assert.equal(workflow?.job.id,'send-message');
      assert.equal(agent._resolvePlannerSiteWorkflow('https://x.com/home',{
        request_kind:'execute',requires_submission:true,messaging:pinned.target,
      }),null);
      const guard=agent._startPlanExecutionGuard(1,'act',{
        requestKind:'execute',requiresStateChange:true,requiresSubmission:true,
        messaging:pinned.target,siteWorkflow:workflow,
      });
      let metadataCalls = 0;
      agent._chatWithCostAllowance = async () => {
        metadataCalls++;
        return { content: JSON.stringify({
          mode: 'inactive', allowedActions: [], forbiddenActions: [], targets: [],
          workflowFields: [{ field: 'body', value: body }], confidence: 0.99,
        }) };
      };
      const startup = {
        progressLedgerPolicy: 'disabled', taskText: 'Send the reviewed message to Alex.',
        pageScope: url, provider: { chat: async () => ({ content: '{}' }) },
      };
      await agent._ensureProgressSessionForCurrentTask(1, { ...startup, provider: {} });
      assert.notEqual(guard.workflowMetadataRequirementsResolved, true, 'missing classifier cannot resolve fields');
      const session = await agent._ensureProgressSessionForCurrentTask(1, startup);
      assert.equal(session.mode, 'inactive');
      assert.equal(guard.workflowMetadataRequirementsResolved, true);
      assert.deepEqual(guard.workflowMetadataRequirements, [{ field: 'body', value: body }]);
      await agent._ensureProgressSessionForCurrentTask(1, startup);
      assert.equal(metadataCalls, 1, 'resolved fields are not classified again');
      assert.equal(await agent._messageRecipientGuardBlock(1,'click',{selector:'textarea'},url),null);
      await page.locator('textarea').fill(body);
      const execution={};
      assert.equal(await agent._messageRecipientGuardBlock(1,'click',{selector:'#send'},url,execution),null);
      assert.equal(execution.messageRecipientBodyBaselineCount,1);
      assert.equal(execution.messageRecipientGuardRequired,true);
      await page.evaluate(() => {
        window.fixtureSends = 0;
        document.querySelector('#send').addEventListener('click', () => { window.fixtureSends++; });
      });
      await addRow('arrived-between-probe-and-dispatch', 'sent', false);
      const stale = await call(page, 'click', {selector:'#send', ...execution});
      assert.equal(stale.noDispatch, true, 'the bound message baseline must survive to dispatch');
      assert.equal(await page.evaluate(() => window.fixtureSends), 0);
      await page.locator('[data-testid="message-arrived-between-probe-and-dispatch"]').evaluate(el => el.remove());
      assert.equal(await agent._messageRecipientGuardBlock(1,'click',{selector:'#send'},url,execution),null);
      const clicked = await call(page, 'click', {selector:'#send', ...execution});
      assert.equal(clicked.success, true, JSON.stringify(clicked));
      assert.equal(await page.evaluate(() => window.fixtureSends), 1);
      // The actual UI uses type=button, not an HTML form submit.
      agent._recordCompletionSubmitAttempt(1,{isSubmit:false},'click',{selector:'#send'},url,url,
        clicked,'doc','doc',execution);
      const submit=agent._completionSubmitStates.get(1);
      assert.equal(submit.dispatched,true);
      assert.equal(submit.workflowBinding.recipientBound,true);
      assert.notEqual(submit.workflowBinding.metadataIncomplete, true);
      assert.deepEqual(submit.workflowBinding.preDispatchMessageIds,
        ['message-old', 'message-hidden', 'message-already-pending']);
      submit.observedAfterSubmit=true;
      const state={relevantFormCount:1,openDialogCount:0,liveRegionMessages:[]};
      const evidence=probe=>agent._workflowTerminalEvidenceFromDone(1,state,url,{submit,relevantForms:1,verifiedFinalSubmit:false},probe);
      await page.locator('textarea').fill('');
      assert.equal(evidence(await observe()),null,'old identical sent bubble cannot satisfy this dispatch');
      await page.locator('[data-testid="message-hidden"]').evaluate(el => { el.hidden = false; });
      assert.equal(evidence(await observe()), null, 'revealing an old matching bubble is not delivery');
      await page.locator('[data-testid="message-already-pending"]').evaluate(el => { el.dataset.sendStatus = 'sent'; });
      assert.equal(evidence(await observe()), null, 'an earlier pending send is not the current send');
      await addRow('loaded-history');
      await page.locator('[data-testid="message-loaded-history"]').evaluate(el => el.parentElement.prepend(el));
      assert.equal(evidence(await observe()), null, 'newly mounted older history is not delivery');
      await addRow('incoming','sent',false);
      await addRow('pending','sending');
      await addRow('failed','failed');
      await addRow('different','sent',true,'Something else');
      assert.equal(evidence(await observe()),null,'incoming, pending, failed or different bodies cannot prove delivery');
      assert.ok(agent._completionPageWarning(1,'Sent','success',state,url));
      await addRow('new');
      const probe=await observe();
      assert.equal(probe.matchingOutgoingMessageCount,5);
      const terminal=evidence(probe);
      assert.equal(terminal?.verificationKind,'message_sent');
      assert.equal(agent._completionPageWarning(1,'Sent','success',state,url,terminal),null);
      assert.equal(evidence({...probe,composerEmpty:false}),null);
      assert.equal(evidence({...probe,strongRecipientCandidates:[{identity:'@someoneelse',role:'to'}]}),null);
      assert.equal(agent._workflowTerminalEvidenceFromDone(1,state,'https://x.com/i/chat/123-789',
        {submit,relevantForms:1},probe),null,'another conversation cannot satisfy the dispatch');
      assert.equal(evidence({...probe,matchingOutgoingMessageIds:['message-old']}),null);
      assert.equal(evidence({...probe,existingMessageIds:['message-new']}),null, 'missing prior tail fails closed');
      assert.equal(evidence({...probe,existingMessageIds:undefined}),null, 'incomplete observation fails closed');
      delete submit.workflowBinding.preDispatchMessageIds;
      assert.equal(evidence(probe),null, 'a legacy count-only binding cannot prove an X send');
      submit.workflowBinding.preDispatchMessageIds = [];
      assert.equal(evidence(probe), null,
        'relabeling a nonempty X history as empty cannot fabricate a first-message baseline');
      await addRow('new');
      assert.equal(evidence(await observe()),null, 'duplicate message identities fail closed');
    });

    register(`${kind}: X named DM recipients resolve header aliases and retain the canonical handle`, async (page) => {
      const { agent } = await setup(page);
      const url = 'https://x.com/i/chat/123-456';
      await page.goto(url);
      await setupContentHtml(page, `<!doctype html><style>
        #header {position:fixed;left:400px;top:20px}
        textarea {position:fixed;left:400px;bottom:20px;width:400px;height:50px}
        #send {position:fixed;left:820px;bottom:20px}
        [role=log] {position:fixed;left:400px;top:100px;width:400px;height:300px}
      </style><a id="header" href="/altryne"><span data-testid="dm-conversation-username">Alex Volkov</span></a>
      <div role="log" data-testid="dm-message-scroller" aria-busy="false"></div>
      <textarea data-testid="dm-composer-textarea"></textarea><button id="send" type="button">Send</button>`, kind);
      await page.evaluate(() => {
        window.fixtureSends = 0;
        document.querySelector('#send').addEventListener('click', () => {
          const composer = document.querySelector('textarea');
          const row = document.createElement('div');
          row.dataset.testid = 'message-' + ++window.fixtureSends;
          row.dataset.sendStatus = 'sent'; row.className = 'justify-end';
          const content = document.createElement('div'); content.dataset.testid = 'message-text-' + window.fixtureSends;
          const body = document.createElement('span'); body.dir = 'auto'; body.textContent = composer.value;
          content.append(body); row.append(content); document.querySelector('[role=log]').append(row);
          composer.value = '';
        });
      });
      const named = identity => ({target_kind:'named', recipients:[{identity,role:'to'}]});
      const canonical = named('@altryne');
      const workflow = agent._resolvePlannerSiteWorkflow(url, {
        request_kind:'execute', requires_submission:true, messaging:named('Alex Volkov'),
      });
      const start = messaging => {
        const guard = agent._startPlanExecutionGuard(1, 'act', {
          requestKind:'execute', requiresStateChange:true, requiresSubmission:true, messaging, siteWorkflow:workflow,
        });
        guard.workflowMetadataRequirementsResolved = true;
        return guard;
      };
      const send = execution => agent._messageRecipientGuardBlock(1,'click',{selector:'#send'},url,execution);
      for (const timing of ['planning', 'after-navigation']) {
        for (const identity of ['Alex Volkov', 'altryne', '@altryne']) {
          // The plan can start on the conversation or reach it later.
          const pinned = await agent._pinActiveConversationMessagingTarget(
            1, named(identity), timing === 'planning' ? url : 'https://x.com/home',
          );
          assert.equal(pinned.ok, true);
          assert.deepEqual(pinned.target, timing === 'planning' ? canonical : named(identity));
          const guard = start(pinned.target);
          await page.locator('textarea').fill('Hello Alex');
          const execution = {};
          assert.equal(await send(execution), null, JSON.stringify({timing,identity}));
          assert.deepEqual(guard.messaging, canonical, 'bind the account handle before dispatch');
          const clicked = await call(page, 'click', {selector:'#send', ...execution});
          assert.equal(clicked.success, true, JSON.stringify(clicked));
          agent._recordCompletionSubmitAttempt(1,{isSubmit:false},'click',{selector:'#send'},url,url,
            clicked,'doc','doc',execution);
          const submit = agent._completionSubmitStates.get(1);
          assert.deepEqual(submit.workflowBinding.recipientTargets, canonical.recipients);
          submit.observedAfterSubmit = true;
          const probe = await guardCall(page, {
            tool:'observe_active_conversation', adapterName:'twitter', expectedMessageBody:'Hello Alex',
          });
          const terminal = agent._workflowTerminalEvidenceFromDone(1,{relevantFormCount:1},url,
            {submit,relevantForms:1,verifiedFinalSubmit:false},probe);
          assert.equal(terminal?.verificationKind, 'message_sent', 'display-name sends can complete');
        }
      }
      assert.equal(await page.evaluate(() => window.fixtureSends), 6);

      await page.locator('textarea').fill('Another message');
      for (const target of [named('Alex'), named('Someone Else'), named('@someoneelse'),
        {target_kind:'named', recipients:[{identity:'Alex Volkov',role:'bcc'}]},
        {target_kind:'named', recipients:['Alex Volkov','Someone Else']}]) {
        const guard = start(target);
        const before = structuredClone(guard.messaging);
        assert.equal((await send({}))?.noDispatch, true, JSON.stringify(target));
        assert.deepEqual(guard.messaging, before, 'a mismatch cannot change the authorized target');
      }
      await page.locator('#header').evaluate(el => {
        const duplicate = el.cloneNode(true); duplicate.id='other-header';
        duplicate.href='/someoneelse'; duplicate.style.cssText='position:fixed;left:400px;top:55px'; el.after(duplicate);
      });
      start(named('Alex Volkov'));
      assert.equal((await send({}))?.noDispatch, true, 'ambiguous headers cannot resolve a name');
      await page.locator('#other-header').evaluate(el => el.remove());

      const guard = start(named('Alex Volkov'));
      const execution = {};
      assert.equal(await send(execution), null);
      assert.deepEqual(guard.messaging, canonical);
      // A different account must not inherit authorization, even when its
      // display name is the old handle or the same display-name alias.
      await page.locator('#header').evaluate(el => { el.href='/someoneelse'; });
      const stale = await call(page,'click',{selector:'#send', ...execution});
      assert.equal(stale.noDispatch, true, 'recipient changed between preflight and dispatch');
      for (const label of ['Alex Volkov','@altryne']) {
        await page.locator('#header span').evaluate((el,label) => { el.textContent=label; },label);
        assert.equal((await send({}))?.noDispatch, true, 'canonical handle cannot be rebound through an alias');
        assert.deepEqual(guard.messaging, canonical);
      }
      assert.equal(await page.evaluate(() => window.fixtureSends), 6, 'blocked retries never dispatch');
    });

    register(`${kind}: X group DMs pin the visible conversation route and header`, async (page) => {
      const { agent } = await setup(page);
      const url = 'https://x.com/i/chat/group-123';
      await page.goto(url);
      await setupContentHtml(page, `<!doctype html><style>
        #header {position:fixed;left:400px;top:20px}
        textarea {position:fixed;left:400px;bottom:20px;width:400px;height:50px}
        #send {position:fixed;left:820px;bottom:20px}
        [role=log] {position:fixed;left:400px;top:100px;width:400px;height:300px}
      </style><div id="header" data-testid="dm-conversation-username">Study Group</div>
      <div role="log" data-testid="dm-message-scroller" aria-busy="false"></div>
      <textarea data-testid="dm-composer-textarea"></textarea><button id="send" type="button">Send</button>`, kind);
      await page.evaluate(() => {
        window.fixtureSends = 0;
        document.querySelector('#send').addEventListener('click', () => {
          const composer = document.querySelector('textarea');
          const row = document.createElement('div');
          row.dataset.testid = 'message-' + ++window.fixtureSends;
          row.dataset.sendStatus = 'sent'; row.className = 'justify-end';
          const content = document.createElement('div'); content.dataset.testid = 'message-text-' + window.fixtureSends;
          const body = document.createElement('span'); body.dir = 'auto'; body.textContent = composer.value;
          content.append(body); row.append(content); document.querySelector('[role=log]').append(row);
          composer.value = '';
        });
      });
      const group = { target_kind: 'named', recipients: [{ identity: 'x-dm-group:group-123', role: 'to' }] };
      const named = identity => ({ target_kind: 'named', recipients: [{ identity, role: 'to' }] });
      const activePin = await agent._pinActiveConversationMessagingTarget(
        1, { target_kind: 'active_conversation', recipients: [] }, url,
      );
      assert.equal(activePin.ok, true, JSON.stringify(activePin));
      assert.equal(activePin.target.target_kind, 'named');
      assert.deepEqual(activePin.target.recipients.map(({ identity, role }) => ({ identity, role })), group.recipients,
        'the active group gets a route-bound identity');
      const namedPin = await agent._pinActiveConversationMessagingTarget(1, named('Study Group'), url);
      assert.deepEqual(namedPin.target, group, 'the visible group name resolves to that route');
      const handlePin = await agent._pinActiveConversationMessagingTarget(1, named('@studygroup'), url);
      assert.deepEqual(handlePin.target, named('@studygroup'), 'a group label cannot stand in for an account handle');

      const workflow = agent._resolvePlannerSiteWorkflow(url, {
        request_kind: 'execute', requires_submission: true, messaging: activePin.target,
      });
      const guard = agent._startPlanExecutionGuard(1, 'act', {
        requestKind: 'execute', requiresStateChange: true, requiresSubmission: true,
        messaging: activePin.target, siteWorkflow: workflow,
      });
      guard.workflowMetadataRequirementsResolved = true;
      await page.locator('textarea').fill('Hello Study Group');
      const execution = {};
      assert.equal(await agent._messageRecipientGuardBlock(1, 'click', { selector: '#send' }, url, execution), null);
      assert.deepEqual(guard.messaging, group);
      const clicked = await call(page, 'click', { selector: '#send', ...execution });
      assert.equal(clicked.success, true, JSON.stringify(clicked));
      agent._recordCompletionSubmitAttempt(1, { isSubmit: false }, 'click', { selector: '#send' },
        url, url, clicked, 'doc', 'doc', execution);
      const submit = agent._completionSubmitStates.get(1);
      submit.observedAfterSubmit = true;
      const terminalProbe = await guardCall(page, {
        tool: 'observe_active_conversation', adapterName: 'twitter', expectedMessageBody: 'Hello Study Group',
      });
      const terminal = agent._workflowTerminalEvidenceFromDone(1, { relevantFormCount: 1 }, url,
        { submit, relevantForms: 1, verifiedFinalSubmit: false }, terminalProbe);
      assert.equal(terminal?.verificationKind, 'message_sent', 'the group send has delivery evidence');

      await page.locator('textarea').fill('This must not send');
      const staleExecution = {};
      assert.equal(await agent._messageRecipientGuardBlock(1, 'click', { selector: '#send' }, url, staleExecution), null);
      await page.evaluate(() => history.pushState({}, '', '/i/chat/group-456'));
      const stale = await call(page, 'click', { selector: '#send', ...staleExecution });
      assert.equal(stale.noDispatch, true, 'a changed conversation route invalidates the dispatch binding');
      assert.equal(await page.evaluate(() => window.fixtureSends), 1, 'the stale retry never dispatches');
    });

    register(`${kind}: X conversation navigation is not classified as sending a message`, async (page) => {
      const { agent } = await setup(page);
      await page.goto('https://x.com/i/chat/123-456');
      await setupContentHtml(page, `<!doctype html><style>
        a,button {display:inline-block;padding:12px} textarea {position:fixed;left:400px;bottom:20px}
      </style><nav><a id="home" href="/home">Home</a></nav>
      <header><button id="back" type="button" data-testid="dm-conversation-back-button">Back</button>
      <a id="profile" href="/altryne"><span data-testid="dm-conversation-username">Alex Volkov</span></a></header>
      <div role="log" data-testid="dm-message-scroller"><a id="message-link" href="/altryne">Message link</a></div>
      <textarea data-testid="dm-composer-textarea">Unsent draft</textarea><button id="send">Send</button>`, kind);
      await page.evaluate(() => {
        window.fixtureClicks = [];
        document.addEventListener('click', event => {
          const el = event.target.closest('a,button');
          if (el) { event.preventDefault(); window.fixtureClicks.push(el.id); }
        });
      });
      const url = page.url();
      const guard = (tool, args) => agent._messageRecipientGuardBlock(1, tool, args, url);
      // No recipient authorization exists in this read-only task.
      agent._startPlanExecutionGuard(1, 'act', {
        requestKind: 'execute', requiresStateChange: false, requiresSubmission: false,
      });
      for (const [id, label] of [['profile', 'Alex Volkov'], ['back', 'Back'], ['home', 'Home']]) {
        const ref_id = await page.locator('#' + id).evaluate(el => window.__wb_ax_ref(el));
        for (const [tool, args] of [['click', {selector:'#'+id}], ['click', {text:label}], ['click_ax', {ref_id}]]) {
          assert.equal(await guard(tool, args), null, JSON.stringify({id,tool,args}));
          const clicked = await call(page, tool, args);
          assert.equal(clicked.success, true, JSON.stringify(clicked));
        }
      }
      assert.deepEqual(await page.evaluate(() => window.fixtureClicks),
        ['profile','profile','profile','back','back','back','home','home','home']);
      const messageLinkProbe = await guardCall(page, {
        tool:'click', args:{selector:'#message-link'}, adapterName:'twitter',
      });
      assert.notEqual(messageLinkProbe.navigation, true, 'message content is not trusted header navigation');
      for (const selector of ['#send']) {
        assert.equal((await guard('click', {selector}))?.noDispatch, true, selector);
      }
      await page.locator('#profile').evaluate(el => el.setAttribute('href', 'javascript:void(0)'));
      assert.notEqual((await guardCall(page, {
        tool:'click', args:{selector:'#profile'}, adapterName:'twitter',
      })).navigation, true, 'unsafe destinations are not trusted header navigation');
      await page.locator('#back').evaluate(el => {
        const form = document.createElement('form'); el.before(form); form.append(el);
      });
      assert.equal((await guard('click', {selector:'#back'}))?.noDispatch, true, 'form lookalike');
      await page.evaluate(() => {
        const modal = document.createElement('div'); modal.role = 'dialog'; modal.setAttribute('aria-modal','true');
        modal.style.cssText = 'position:fixed;inset:0;background:white'; modal.textContent='Confirm';
        document.body.append(modal);
      });
      assert.equal((await guard('click', {selector:'#home'}))?.noDispatch, true, 'blocking modal');
      assert.equal(await page.locator('textarea').inputValue(), 'Unsent draft');
    });

    register(`${kind}: an aria-hidden assigned slot cannot make Send ambiguous`, async (page) => {
      await setup(page);
      await page.evaluate(() => {
        document.querySelector('#chat').hidden = false;
        const host = document.createElement('div');
        const duplicate = document.createElement('button');
        duplicate.id = 'slotted-hidden-send';
        duplicate.slot = 'hidden-send';
        duplicate.type = 'button';
        duplicate.textContent = 'Send';
        host.append(duplicate);
        document.body.append(host);
        host.attachShadow({ mode: 'open' }).innerHTML = '<slot name="hidden-send" aria-hidden="true"></slot>';
      });
      const result = await call(page, 'click', { text: 'Send', textMatch: 'exact' });
      assert.equal(result.success, true, JSON.stringify(result));
      assert.deepEqual(await page.evaluate(() => window.fixtureClicks), ['send'],
        'the assigned hidden control must not be a click candidate');
    });

    const addPostEntry = async (page, shadow = false) => page.evaluate((shadow) => {
      const host = document.createElement('section');
      host.id = 'post-entry';
      document.querySelector('main').prepend(host);
      const root = shadow ? host.attachShadow({ mode: 'open' }) : host;
      root.innerHTML = '<button id="start-post" type="button" style="padding:12px"><span>Start a post</span></button>';
      const button = root.querySelector('button');
      button.addEventListener('click', () => {
        const dialog = document.createElement('div');
        dialog.id = 'post-composer';
        dialog.setAttribute('role', 'dialog');
        dialog.setAttribute('aria-modal', 'true');
        dialog.style.cssText = 'position:fixed;inset:100px;background:white';
        dialog.innerHTML = '<div contenteditable="true">Draft</div><button type="button">Post</button>';
        document.body.append(dialog);
      });
      const rect = button.getBoundingClientRect();
      return { ref_id: window.__wb_ax_ref(button.querySelector('span')), x: rect.x + 10, y: rect.y + 10 };
    }, shadow);

    register(`${kind}: LinkedIn Start a post opens without a message recipient across targeting methods`, async (page) => {
      const { guard, probe } = await setup(page);
      for (const shadow of [false, true]) {
        const target = await addPostEntry(page, shadow);
        for (const chatOpen of [false, true]) {
          await page.evaluate(open => { document.querySelector('#chat').hidden = !open; }, chatOpen);
          // Both agents expose the full collector, including open shadow roots.
          const elements = await call(page, 'get_interactive_elements_cdp', {});
          const index = elements.find(element => element.text === 'Start a post')?.index;
          assert.ok(Number.isInteger(index), JSON.stringify(elements));
          const strategies = [
            ['click', { text: 'Start a post' }],
            ['click_ax', { ref_id: target.ref_id }],
            ['click', { index }],
            ['click', { x: target.x, y: target.y, coordinate_space: 'css' }],
            ...(!shadow ? [['click', { selector: '#start-post' }]] : []),
          ];
          for (const [tool, args] of strategies) {
            const result = await probe(tool, args);
            assert.equal(result.conclusive, true, JSON.stringify({ shadow, chatOpen, tool, args, result }));
            assert.equal(result.messageSend, false);
            assert.equal(await guard(tool, args), null);
            const clicked = await call(page, tool, args);
            assert.equal(clicked.success, true, JSON.stringify({ shadow, chatOpen, tool, args, clicked }));
            assert.equal(await page.locator('#post-composer').count(), 1,
              JSON.stringify({ shadow, chatOpen, tool, args, clicked }));
            // Opening a composer must not authorize its eventual publication.
            assert.equal((await guard('click', { text: 'Post' }))?.noDispatch, true);
            await page.locator('#post-composer').evaluate(el => el.remove());
          }
        }
        await page.locator('#post-entry').evaluate(el => el.remove());
      }
    });

    register(`${kind}: LinkedIn public Post is not a private-message send`, async (page) => {
      const { agent, guard, probe } = await setup(page);
      for (const route of ['/feed/','/sharing/compose']) {
        await page.evaluate(route=>history.replaceState({},'',route),route);
        for (const modal of [true,false]) {
          if (!modal && route === '/feed/') continue;
          await page.evaluate(modal=>{
            document.querySelector('main').innerHTML=`<section id="public" ${modal?'role="dialog" aria-modal="true"':''}>
              <div role="button">Post to Anyone</div><div contenteditable="true" role="textbox">Announcement</div>
              <button id="publish" type="button" data-control-name="share.post"><span>Post</span></button></section>`;
            document.getElementById('chat').hidden=true;
          },modal);
          const publishWorkflow = agent._resolvePlannerSiteWorkflow(page.url(), {
            request_kind: 'execute', site_job: 'publish-post', requires_submission: true,
          });
          assert.equal(publishWorkflow?.job?.id, 'publish-post');
          agent._startPlanExecutionGuard(1, 'act', {
            requestKind: 'execute', requiresStateChange: true, requiresSubmission: true,
            siteWorkflow: publishWorkflow,
          });
          const target=await page.evaluate(()=>{
            const span=document.querySelector('#publish span'),rect=span.getBoundingClientRect();
            return {ref_id:window.__wb_ax_ref(span),x:rect.x+2,y:rect.y+2};
          });
          const elements=await call(page,'get_interactive_elements_cdp',{});
          const index=elements.find(el=>el.text==='Post')?.index;
          for(const [tool,args] of [['click',{text:'Post'}],['click',{index}],['click_ax',{ref_id:target.ref_id}],
            ['click',{selector:'#publish span'}],['click',{x:target.x,y:target.y,coordinate_space:'css'}]]) {
            const observed=await probe(tool,args);
            assert.equal(observed.publicPost,true,JSON.stringify({route,modal,tool,args,observed}));
            assert.equal(observed.messageSend,false);
            assert.equal(await guard(tool,args),null);
          }
          // Public-composer proof cannot be borrowed by an adjacent DM, even
          // if the DM's button is misleadingly labelled Post.
          await page.evaluate(()=>{
            document.querySelector('#public').removeAttribute('aria-modal');
            document.querySelector('#public').removeAttribute('role');
            document.getElementById('chat').hidden=false;
            document.getElementById('send').textContent='Post';
          });
          assert.equal((await guard('click',{selector:'#send'}))?.noDispatch,true);
          assert.equal(agent._planExecutionGuards.get(1)?.messaging,null);
        }
      }
    });

    register(`${kind}: LinkedIn public-post classification requires matching composer evidence`, async (page) => {
      const {guard}=await setup(page);
      await page.evaluate(()=>history.replaceState({},'','/sharing/compose'));
      for(const variant of ['no-audience','two-editors','send-label','message-scope','form','hidden-audience']) {
        await page.evaluate(variant=>{
          document.querySelector('main').innerHTML=`<section role="dialog" aria-modal="true" ${variant==='message-scope'?'data-conversation-id="alice"':''}>
            ${variant==='form'?'<form>':''}
            ${variant==='no-audience'?'':`<div role="button" ${variant==='hidden-audience'?'hidden':''}>Post to Anyone</div>`}
            <div contenteditable="true">Draft</div>${variant==='two-editors'?'<div contenteditable="true">Other</div>':''}
            <button id="publish" type="button" ${variant==='send-label'?'aria-label="Send"':''}>Post</button>
            ${variant==='form'?'</form>':''}</section>`;
        },variant);
        assert.equal((await guard('click',{selector:'#publish'}))?.noDispatch,true,variant);
      }
    });

    // LinkedIn's server-driven share composer, as it renders today: only the
    // screen carries a stable marker; its controls have generated classes
    // and no data-control-name.
    const composeShareScreen = (page, { postLabel = 'Post', editors = 1, scope = '' } = {}) => page.evaluate(
      ({ postLabel, editors, scope }) => {
        document.getElementById('share-dialog')?.remove();
        const dialog = document.createElement('dialog');
        dialog.id = 'share-dialog';
        dialog.setAttribute('data-testid', 'dialog');
        dialog.setAttribute('aria-labelledby', 'dialog-header');
        dialog.innerHTML = `<div><div data-testid="dialog-content" ${scope}>
            <div data-sdui-screen="com.linkedin.sdui.flagshipnav.sharing.ShareCompose">
              <header id="dialog-header"><div id="audience" role="button" tabindex="0" aria-expanded="false">Post to Anyone</div></header>
              ${'<div class="i0lme8" contenteditable="true" role="textbox">Announcement</div>'.repeat(editors)}
              <button id="emoji" class="i0lmel" type="button" aria-label="Show Emoji Picker" aria-haspopup="dialog" aria-expanded="false">☺</button>
              <button id="publish" class="i0lmel i0lmek" type="button" componentkey="e70cd7cc-0374-459c-b8c9-4c6b56099738"><span>${postLabel}</span></button>
            </div></div></div>
          <button id="dismiss" type="button" aria-label="Dismiss">×</button>`;
        document.body.append(dialog);
        dialog.showModal();
        document.getElementById('chat').hidden = true;
      }, { postLabel, editors, scope });

    register(`${kind}: LinkedIn's server-driven share composer posts in any language, and its other controls only edit the draft`, async (page) => {
      const { agent, guard, probe } = await setup(page);
      await page.evaluate(() => history.replaceState({}, '', '/sharing/compose'));
      const plan = (overrides = {}) => agent._startPlanExecutionGuard(1, 'act', {
        requestKind: 'execute', requiresStateChange: true, requiresSubmission: true, ...overrides });
      // The submit probe, run as the agent runs it: it decides the submit
      // card, the submission receipt and the record of a possible post.
      const submitProbe = (tool, args) => probeWithReadings((name, passArgs) => page.evaluate(({ source, tool, args }) =>
        Function('return (' + source + ')')()(tool, args), { source: AgentClass._submitActionProbe.toString(), tool: name, args: passArgs }),
      tool, args);
      // The task started on another site: no LinkedIn workflow, and no
      // private message named. Its plan requires the submission. The first
      // Post binds the live LinkedIn publish-post job, so the post is
      // recorded and verified as a LinkedIn task's post, and waits for the
      // next turn. Under that job the post goes through.
      const resolved = [];
      agent._ensureWorkflowMetadataRequirements = async (tabId, _opts, _taskText, pageScope) => {
        resolved.push(pageScope);
        const state = agent._planExecutionGuards.get(tabId);
        state.workflowMetadataRequirements = [{ field: 'body', value: 'Announcement' }];
        state.workflowMetadataRequirementsResolved = true;
        state.workflowMetadataRequirementsIncomplete = false;
      };
      plan();
      await composeShareScreen(page);
      const adopted = await guard('click', { selector: '#publish' });
      assert.equal(adopted?.reasonCode, 'publish_workflow_adopted', JSON.stringify(adopted));
      assert.equal(adopted.noDispatch, true);
      assert.equal(adopted.workflowRearmed, true);
      const bound = agent._planExecutionGuards.get(1);
      assert.equal(bound.siteWorkflow?.adapterName, 'linkedin');
      assert.equal(bound.siteWorkflow?.job?.id, 'publish-post');
      assert.equal(bound.workflowMetadataRequirementsResolved, true);
      assert.deepEqual(resolved, [page.url()]);
      for (const postLabel of ['Post', 'Gönder']) {
        await composeShareScreen(page, { postLabel });
        const ref = await page.evaluate(() => window.__wb_ax_ref(document.querySelector('#publish span')));
        for (const [tool, args] of [['click', { selector: '#publish' }], ['click', { text: postLabel }], ['click_ax', { ref_id: ref }]]) {
          const observed = await probe(tool, args);
          assert.equal(observed.publicPost, true, JSON.stringify({ postLabel, tool, args, observed }));
          assert.equal(observed.messageSend, false);
          assert.equal(await guard(tool, args), null, `${postLabel} ${tool}: the planned post goes through`);
          const submit = await submitProbe(tool, args);
          assert.equal(submit?.isSubmit, true, `${postLabel} ${tool}: the post is a submission ${JSON.stringify(submit)}`);
          assert.equal(submit.publicationControl, true, `${postLabel} ${tool}: the post is a publication`);
        }
      }
      assert.equal(resolved.length, 1, 'the job is bound once');
      // The submission record binds the post's stable URL and content.
      const binding = agent._workflowSubmitBindingForAttempt(1, page.url(), {}, { isSubmit: true, publicationControl: true });
      assert.equal(binding?.verificationKind, 'published_resource');
      assert.equal(binding.adapterName, 'linkedin');
      assert.deepEqual(binding.metadataRequirements, [{ field: 'body', value: 'Announcement' }]);
      // A run set up for another task's workflow does not post.
      plan({ siteWorkflow: agent._resolvePlannerSiteWorkflow('https://github.com/acme/site/edit/main/README.md',
        { request_kind: 'execute', site_job: 'edit-file-and-commit' }) });
      assert.equal(agent._planExecutionGuards.get(1).siteWorkflow?.adapterName, 'github');
      const otherTask = await guard('click', { selector: '#publish' });
      assert.equal(otherTask?.reasonCode, 'public_post_not_authorized');
      assert.match(otherTask.error, /set up for a different task/);
      assert.equal(agent._planExecutionGuards.get(1).siteWorkflow?.adapterName, 'github');
      // With site adapters off no job can be bound, as on any other site: the
      // planned post goes through the normal submission gates.
      plan();
      agent.useSiteAdapters = false;
      assert.equal(await guard('click', { selector: '#publish' }), null);
      assert.equal(agent._planExecutionGuards.get(1).siteWorkflow, null);
      agent.useSiteAdapters = true;
      // The draft's other controls are not sends, and not the post.
      await composeShareScreen(page);
      for (const selector of ['#emoji', '#audience', '[contenteditable="true"]']) {
        const observed = await probe('click', { selector });
        assert.equal(observed.conclusive, true, selector);
        assert.equal(observed.messageSend, false, selector);
        assert.notEqual(observed.publicPost, true, selector);
        assert.equal(await guard('click', { selector }), null, selector);
        assert.notEqual((await submitProbe('click', { selector }))?.publicationControl, true, selector);
      }
      // A task that names a private message to send, or asks for no
      // submission at all, does not post.
      plan({ messaging: { target_kind: 'named', recipients: [{ identity: 'Alice', role: 'to' }] } });
      const messageTask = await guard('click', { selector: '#publish' });
      assert.equal(messageTask?.reasonCode, 'public_post_not_authorized');
      assert.match(messageTask.error, /authorizes a private message, not a public post/);
      plan({ requiresSubmission: false, requiresStateChange: false });
      const readTask = await guard('click', { selector: '#publish' });
      assert.equal(readTask?.reasonCode, 'public_post_not_authorized');
      assert.match(readTask.error, /does not ask to publish anything/);
      // Without the screen's own evidence (a second editor, or a messaging
      // scope around it), the composer keeps the old refusal.
      plan();
      for (const variant of [{ editors: 2 }, { scope: 'data-conversation-id="alice"' }]) {
        await composeShareScreen(page, variant);
        assert.equal((await guard('click', { selector: '#publish' }))?.noDispatch, true, JSON.stringify(variant));
        assert.notEqual((await submitProbe('click', { selector: '#publish' }))?.publicationControl, true, JSON.stringify(variant));
      }
      await page.evaluate(() => document.getElementById('share-dialog')?.remove());
    });

    register(`${kind}: LinkedIn post entry classification rejects send and publish lookalikes`, async (page) => {
      const { guard, probe } = await setup(page);
      await addPostEntry(page);
      for (const [attribute, value] of [
        ['type', 'submit'], ['aria-label', 'Send'], ['form', 'chat'], ['disabled', ''], ['aria-disabled', 'true'],
      ]) {
        await page.locator('#start-post').evaluate((el, [key, value]) => el.setAttribute(key, value), [attribute, value]);
        assert.notEqual((await probe('click', { selector: '#start-post' })).composerSetup, true, attribute);
        if (attribute === 'aria-label') assert.equal((await guard('click', { selector: '#start-post' }))?.noDispatch, true);
        await page.locator('#start-post').evaluate((el, key) => el.removeAttribute(key), attribute);
      }
      for (const label of ['Post', 'Send', 'Start a post and send', 'Photo']) {
        await page.locator('#start-post').evaluate((el, text) => { el.textContent = text; }, label);
        assert.notEqual((await probe('click', { selector: '#start-post' })).composerSetup, true, label);
        if (/Send|send/.test(label)) assert.equal((await guard('click', { selector: '#start-post' }))?.noDispatch, true, label);
      }
      await page.locator('#start-post').evaluate(el => { el.textContent = 'Start a post'; });
      await page.evaluate(() => history.replaceState(null, '', '/messaging/'));
      assert.equal((await guard('click', { text: 'Start a post' }))?.noDispatch, true, 'messaging route');
      await page.evaluate(() => history.replaceState(null, '', '/feed/'));
      for (const markup of ['<form></form>', '<article></article>', '<div role="dialog"></div>', '<div role="log"></div>']) {
        await page.evaluate(markup => {
          const wrapper = document.createElement('div');
          wrapper.id = 'entry-wrapper';
          wrapper.innerHTML = markup;
          document.querySelector('main').append(wrapper);
          wrapper.firstChild.append(document.querySelector('#post-entry'));
        }, markup);
        assert.notEqual((await probe('click', { text: 'Start a post' })).composerSetup, true, markup);
        await page.evaluate(() => {
          document.querySelector('main').append(document.querySelector('#post-entry'));
          document.querySelector('#entry-wrapper').remove();
        });
      }
      await page.evaluate(() => document.body.append(document.querySelector('#post-entry')));
      assert.notEqual((await probe('click', { text: 'Start a post' })).composerSetup, true, 'outside feed main');
      assert.deepEqual(await page.evaluate(() => window.fixtureClicks), []);
    });

    register(`${kind}: LinkedIn post entry respects blocking shadow dialogs and ambiguous targets`, async (page) => {
      const { guard } = await setup(page);
      const { ref_id } = await addPostEntry(page, true);
      await page.evaluate(() => {
        const host = document.createElement('div');
        host.id = 'shadow-modal';
        document.body.append(host);
        host.attachShadow({ mode: 'open' }).innerHTML = '<div role="dialog" aria-modal="true" style="position:fixed;inset:0;background:white"><button>Start a post</button></div>';
      });
      assert.equal((await guard('click_ax', { ref_id }))?.noDispatch, true, 'background control');
      assert.equal((await guard('click', { text: 'Start a post' }))?.noDispatch, true, 'dialog control');
      await page.locator('#shadow-modal').evaluate(el => el.remove());
      await page.evaluate(() => document.querySelector('main').insertAdjacentHTML('beforeend', '<button>Start a post</button>'));
      assert.equal((await guard('click', { text: 'Start a post' }))?.noDispatch, true, 'ambiguous controls');
      await page.locator('#post-entry').evaluate(el => el.remove());
      assert.equal((await guard('click_ax', { ref_id }))?.noDispatch, true, 'stale reference');
    });

    register(`${kind}: LinkedIn missing composer does not recommend alternate click retries`, async (page) => {
      const { guard } = await setup(page);
      const result = await guard('click', { selector: '#close-contact-info' });
      // Use a visible unresolved action so this is a classification failure,
      // not a stale/missing target that a fresh page read could repair.
      await page.evaluate(() => document.querySelector('main').insertAdjacentHTML('beforeend', '<div class="msg-form"><button id="unknown">Unknown action</button></div>'));
      const missingComposer = await guard('click', { selector: '#unknown' });
      assert.equal(missingComposer?.noDispatch, true);
      assert.equal(missingComposer?.reasonCode, 'message_send_classification_inconclusive');
      assert.equal(missingComposer?.retryable, false);
      assert.match(missingComposer?.error, /no message composer/i);
      assert.notEqual(result?.retryable, false, 'unresolved target should retain fresh-target recovery');
    });

    register(`${kind}: LinkedIn Home and Jobs navigate with closed and open message composers (#2999)`, async (page) => {
      const { guard, probe } = await setup(page);
      for (const open of [false, true]) {
        await page.evaluate(open => { document.querySelector('#chat').hidden = !open; }, open);
        const ref = await page.evaluate(() => window.__wb_ax_ref(document.querySelector('#jobs-label')));
        for (const [tool, args, expected] of [
          ['click', { text: 'Jobs', textMatch: 'exact' }, 'jobs'],
          ['click', { text: 'Home' }, 'home'],
          ['click_ax', { ref_id: ref }, 'jobs'],
          ['click', { selector: '.destination', matchIndex: 1 }, 'jobs'],
          ['click', { text: 'Messag', textMatch: 'prefix' }, 'messaging'],
        ]) {
          const result = await probe(tool, args);
          assert.equal(result.conclusive, true, JSON.stringify(result));
          assert.equal(result.messageSend, false);
          assert.equal(await guard(tool, args), null);
          const clicked = await call(page, tool, args);
          assert.equal(clicked.success, true, JSON.stringify(clicked));
          assert.equal(await page.evaluate(() => window.fixtureClicks.at(-1)), expected);
        }
      }
    });

    register(`${kind}: LinkedIn ordinary document links bypass the message recipient guard (#3010)`, async (page) => {
      const { guard, probe } = await setup(page);
      for (const open of [false, true]) {
        await page.evaluate(open => { document.querySelector('#chat').hidden = !open; }, open);
        const portfolioRef = await page.evaluate(
          () => window.__wb_ax_ref(document.querySelector('#portfolio-label')),
        );
        for (const [tool, args, expected] of [
          ['click', { text: 'View my portfolio', textMatch: 'exact' }, 'portfolio'],
          ['click_ax', { ref_id: portfolioRef }, 'portfolio'],
          ['click', { text: 'Contact info', textMatch: 'exact' }, 'contact-info'],
        ]) {
          const result = await probe(tool, args);
          assert.equal(result.conclusive, true, JSON.stringify(result));
          assert.equal(result.messageSend, false);
          assert.equal(result.navigation, true);
          assert.equal(await guard(tool, args), null);
          const clicked = await call(page, tool, args);
          assert.equal(clicked.success, true, JSON.stringify(clicked));
          assert.equal(await page.evaluate(() => window.fixtureClicks.at(-1)), expected);
        }
      }
    });

    register(`${kind}: LinkedIn contact-info safety redirects navigate inside the modal (#3010)`, async (page) => {
      const { guard, probe } = await setup(page);
      await page.evaluate(() => {
        history.replaceState(null, '', '/in/alice/overlay/contact-info/');
        document.querySelector('#contact-info-dialog').hidden = false;
      });
      for (const open of [false, true]) {
        await page.evaluate(open => { document.querySelector('#chat').hidden = !open; }, open);
        const safetyRef = await page.evaluate(
          () => window.__wb_ax_ref(document.querySelector('#safety-portfolio')),
        );
        for (const [tool, args, expected] of [
          ['click', { text: 'portfolio.example', textMatch: 'exact' }, 'safety-portfolio'],
          ['click_ax', { ref_id: safetyRef }, 'safety-portfolio'],
          ['click', { text: 'legacy-portfolio.example', textMatch: 'exact' }, 'legacy-portfolio'],
        ]) {
          const result = await probe(tool, args);
          assert.equal(result.conclusive, true, JSON.stringify(result));
          assert.equal(result.messageSend, false);
          assert.equal(result.navigation, true);
          assert.equal(await guard(tool, args), null);
          const clicked = await call(page, tool, args);
          assert.equal(clicked.success, true, JSON.stringify(clicked));
          assert.equal(await page.evaluate(() => window.fixtureClicks.at(-1)), expected);
        }
      }
      for (const href of [
        '#',
        'mailto:alice@example.com',
        'https://portfolio.example/',
        '/safety/go/',
        '/safety/go/?url=javascript%3Aalert(1)',
        '/safety/go/?url=https%3A%2F%2Flinkedin.com%2Fmessaging%2Fsend',
        '/safety/go/?url=https%3A%2F%2Fm.linkedin.com%2Fmessaging%2Fsend',
        '/safety/go/?url=https%3A%2F%2Fm.linkedin.com.%2Fmessaging%2Fsend',
      ]) {
        await page.locator('#safety-portfolio').evaluate((el, value) => el.setAttribute('href', value), href);
        const args = { text: 'portfolio.example', textMatch: 'exact' };
        const result = await probe('click', args);
        assert.notEqual(result.navigation, true, `${href}: ${JSON.stringify(result)}`);
        assert.equal((await guard('click', args))?.noDispatch, true, `${href}: recipient guard must fail closed`);
      }
    });

    register(`${kind}: LinkedIn contact-info redirects honor composed-tree safety boundaries`, async (page) => {
      const { guard, probe } = await setup(page);
      const refs = await page.evaluate(() => {
        history.replaceState(null, '', '/in/alice/overlay/contact-info/');
        document.querySelector('#chat').hidden = false;
        const dialog = document.querySelector('#contact-info-dialog');
        dialog.hidden = false;
        const addShadowLink = (parent, hostId, text) => {
          const host = document.createElement('span');
          host.id = hostId;
          parent.append(host);
          const shadow = host.attachShadow({ mode: 'open' });
          shadow.innerHTML = `<a href="/safety/go/?url=https%3A%2F%2Fportfolio.example%2F" style="display:inline-block;padding:8px">${text}</a>`;
          return window.__wb_ax_ref(shadow.querySelector('a'));
        };
        const form = document.createElement('form');
        dialog.append(form);
        const action = document.createElement('span');
        action.dataset.action = 'send';
        dialog.append(action);
        return {
          safe: addShadowLink(dialog, 'shadow-safe-host', 'Shadow safe link'),
          form: addShadowLink(form, 'shadow-form-host', 'Shadow form link'),
          action: addShadowLink(action, 'shadow-action-host', 'Shadow action link'),
        };
      });
      const safeArgs = { ref_id: refs.safe };
      const safe = await probe('click_ax', safeArgs);
      assert.equal(safe.navigation, true, JSON.stringify(safe));
      assert.equal(await guard('click_ax', safeArgs), null);
      for (const ref_id of [refs.form, refs.action]) {
        const args = { ref_id };
        const result = await probe('click_ax', args);
        assert.equal(result.navigationBlocked, true, JSON.stringify(result));
        assert.equal(result.conclusive, false, JSON.stringify(result));
        assert.equal((await guard('click_ax', args))?.noDispatch, true);
      }
    });

    register(`${kind}: LinkedIn safety redirects cannot escape a shadow-root modal`, async (page) => {
      const { guard, probe } = await setup(page);
      const ref_id = await page.evaluate(() => {
        history.replaceState(null, '', '/in/alice/overlay/contact-info/');
        document.querySelector('#chat').hidden = false;
        const modal = document.createElement('div');
        modal.setAttribute('role', 'dialog');
        modal.setAttribute('aria-modal', 'true');
        modal.style.cssText = 'position:fixed;inset:0;background:white';
        document.body.append(modal);
        const host = document.createElement('span');
        modal.append(host);
        const shadow = host.attachShadow({ mode: 'open' });
        shadow.innerHTML = '<a href="/safety/go/?url=https%3A%2F%2Fportfolio.example%2F" style="display:inline-block;padding:8px">Shadow modal link</a>';
        return window.__wb_ax_ref(shadow.querySelector('a'));
      });
      const args = { ref_id };
      const result = await probe('click_ax', args);
      assert.equal(result.navigationBlocked, true, JSON.stringify(result));
      assert.equal(result.conclusive, false, JSON.stringify(result));
      assert.equal((await guard('click_ax', args))?.noDispatch, true);
    });

    register(`${kind}: LinkedIn Contact info ownership crosses open shadow roots`, async (page) => {
      const { guard, probe } = await setup(page);
      await page.evaluate(() => {
        history.replaceState(null, '', '/in/alice/overlay/contact-info/');
        const dialog = document.querySelector('#contact-info-dialog');
        dialog.hidden = false;
        const profile = document.querySelector('#contact-profile');
        const host = document.createElement('span');
        dialog.append(host);
        host.attachShadow({ mode: 'open' }).append(profile);
      });
      const args = { text: 'portfolio.example', textMatch: 'exact' };
      const result = await probe('click', args);
      assert.equal(result.navigation, true, JSON.stringify(result));
      assert.equal(await guard('click', args), null);
    });

    register(`${kind}: LinkedIn Contact info ownership follows flattened slots`, async (page) => {
      const { guard, probe } = await setup(page);
      const ref_id = await page.evaluate(() => {
        history.replaceState(null, '', '/in/alice/overlay/contact-info/');
        document.querySelector('#contact-info-dialog').remove();
        const host = document.createElement('div');
        const profile = document.createElement('a');
        profile.slot = 'profile';
        profile.href = '/in/alice/';
        profile.textContent = 'linkedin.com/in/alice';
        host.append(profile);
        document.body.append(host);
        const shadow = host.attachShadow({ mode: 'open' });
        shadow.innerHTML = `
          <div role="dialog" aria-modal="true" style="position:fixed;inset:0;background:white">
            <slot name="profile"></slot>
            <a id="slotted-ownership-link" href="/safety/go/?url=https%3A%2F%2Fportfolio.example%2F"
              style="display:inline-block;padding:8px">Slotted ownership link</a>
          </div>`;
        return window.__wb_ax_ref(shadow.querySelector('#slotted-ownership-link'));
      });
      const args = { ref_id };
      const result = await probe('click_ax', args);
      assert.equal(result.navigation, true, JSON.stringify(result));
      assert.equal(await guard('click_ax', args), null);
    });

    register(`${kind}: LinkedIn Contact info recognizes shadow-root overlay content siblings`, async (page) => {
      const { guard, probe } = await setup(page);
      for (const [index, contentClass] of ['DialogContent', 'ModalContent'].entries()) {
        const ref_id = await page.evaluate(({ contentClass, index }) => {
          history.replaceState(null, '', '/in/alice/overlay/contact-info/');
          document.querySelector('#chat').hidden = false;
          const host = document.createElement('div');
          host.id = `shadow-sibling-modal-host-${index}`;
          document.body.append(host);
          const shadow = host.attachShadow({ mode: 'open' });
          shadow.innerHTML = `
            <div class="DialogOverlay" style="position:fixed;inset:0;background:rgba(0,0,0,.5)"></div>
            <div class="${contentClass}" style="position:fixed;inset:40px;background:white">
              <a href="/in/alice/">linkedin.com/in/alice</a>
              <a id="sibling-modal-link" href="/safety/go/?url=https%3A%2F%2Fportfolio.example%2F"
                style="display:inline-block;padding:8px">Sibling modal link</a>
            </div>`;
          return window.__wb_ax_ref(shadow.querySelector('#sibling-modal-link'));
        }, { contentClass, index });
        const args = { ref_id };
        const result = await probe('click_ax', args);
        assert.equal(result.navigation, true, `${contentClass}: ${JSON.stringify(result)}`);
        assert.equal(await guard('click_ax', args), null);
        await page.evaluate((index) => {
          document.querySelector(`#shadow-sibling-modal-host-${index}`)?.remove();
        }, index);
      }
      const ref_id = await page.evaluate(() => {
        const host = document.createElement('div');
        host.id = 'shadow-content-without-overlay-host';
        document.body.append(host);
        const shadow = host.attachShadow({ mode: 'open' });
        shadow.innerHTML = `
          <div class="DialogContent" style="position:fixed;inset:40px;background:white">
            <a href="/in/alice/">linkedin.com/in/alice</a>
            <a id="content-without-overlay-link"
              href="/safety/go/?url=https%3A%2F%2Fportfolio.example%2F"
              style="display:inline-block;padding:8px">Unbacked content link</a>
          </div>`;
        return window.__wb_ax_ref(shadow.querySelector('#content-without-overlay-link'));
      });
      const result = await probe('click_ax', { ref_id });
      assert.equal(result.navigationBlocked, true, JSON.stringify(result));
      assert.equal(result.conclusive, false, JSON.stringify(result));
      assert.equal((await guard('click_ax', { ref_id }))?.noDispatch, true);
    });

    register(`${kind}: LinkedIn non-blocking dialogs cannot claim Contact info redirects`, async (page) => {
      const { guard, probe } = await setup(page);
      await page.evaluate(() => {
        history.replaceState(null, '', '/in/alice/overlay/contact-info/');
        document.querySelector('#chat').hidden = false;
        document.body.insertAdjacentHTML('beforeend', `
          <div role="dialog" style="position:fixed;inset:120px;background:white">
            <a href="/in/alice/">linkedin.com/in/alice</a>
            <a id="non-blocking-dialog-link" href="/safety/go/?url=https%3A%2F%2Fportfolio.example%2F">Non-blocking dialog link</a>
          </div>`);
      });
      const args = { selector: '#non-blocking-dialog-link' };
      const result = await probe('click', args);
      assert.equal(result.navigationBlocked, true, JSON.stringify(result));
      assert.equal(result.conclusive, false, JSON.stringify(result));
      assert.equal((await guard('click', args))?.noDispatch, true);
    });

    register(`${kind}: LinkedIn safety redirects cannot escape a heuristic modal`, async (page) => {
      const { guard, probe } = await setup(page);
      await page.evaluate(() => {
        history.replaceState(null, '', '/in/alice/overlay/contact-info/');
        document.querySelector('#chat').hidden = false;
        const modal = document.createElement('div');
        modal.className = 'modal show';
        modal.style.cssText = 'position:fixed;inset:0;background:white';
        modal.innerHTML = '<a id="heuristic-modal-link" href="/safety/go/?url=https%3A%2F%2Fportfolio.example%2F" style="display:inline-block;padding:8px">Heuristic modal link</a>';
        document.body.append(modal);
      });
      const args = { selector: '#heuristic-modal-link' };
      const result = await probe('click', args);
      assert.equal(result.navigationBlocked, true, JSON.stringify(result));
      assert.equal(result.conclusive, false, JSON.stringify(result));
      assert.equal((await guard('click', args))?.noDispatch, true);
    });

    register(`${kind}: LinkedIn safety redirects cannot escape a shadow-root heuristic modal`, async (page) => {
      const { guard, probe } = await setup(page);
      const ref_id = await page.evaluate(() => {
        history.replaceState(null, '', '/in/alice/overlay/contact-info/');
        document.querySelector('#chat').hidden = false;
        const host = document.createElement('div');
        document.body.append(host);
        const shadow = host.attachShadow({ mode: 'open' });
        shadow.innerHTML = `
          <div class="modal show" style="position:fixed;inset:0;background:white">
            <a href="/safety/go/?url=https%3A%2F%2Fportfolio.example%2F" style="display:inline-block;padding:8px">Shadow heuristic modal link</a>
          </div>`;
        return window.__wb_ax_ref(shadow.querySelector('a'));
      });
      const args = { ref_id };
      const result = await probe('click_ax', args);
      assert.equal(result.navigationBlocked, true, JSON.stringify(result));
      assert.equal(result.conclusive, false, JSON.stringify(result));
      assert.equal((await guard('click_ax', args))?.noDispatch, true);
    });

    register(`${kind}: LinkedIn recipient guard rejects ambiguous navigation and action lookalikes`, async (page) => {
      const { guard, probe } = await setup(page);
      const messageActionHrefs = [
        '/messaging/compose/',
        '/messaging/send/',
        'https://linkedin.com/messaging/send/',
        'https://m.linkedin.com/messaging/send/',
        'https://m.linkedin.com./messaging/send/',
      ];
      await page.evaluate(() => { document.querySelector('#chat').hidden = false; });
      for (const href of messageActionHrefs) {
        await page.locator('#jobs').evaluate((el, value) => el.setAttribute('href', value), href);
        const args = { text: 'Jobs' };
        const result = await probe('click', args);
        assert.equal(result.navigationBlocked, true, `${href}: ${JSON.stringify(result)}`);
        assert.equal((await guard('click', args))?.noDispatch, true, href);
      }
      await page.evaluate(() => { document.querySelector('#chat').hidden = true; });
      for (const href of [
        '/safety/go/?url=https%3A%2F%2Fportfolio.example%2F',
        '/safety/go/',
        '/safety/go/?url=javascript%3Aalert(1)',
        '/safety/go/?url=https%3A%2F%2Fwww.linkedin.com%2Fmessaging%2Fsend',
        '/safety/go/?url=https%3A%2F%2Flinkedin.com%2Fmessaging%2Fsend',
        '/safety/go/?url=https%3A%2F%2Fm.linkedin.com%2Fmessaging%2Fsend',
        '/safety/go/?url=https%3A%2F%2Fm.linkedin.com.%2Fmessaging%2Fsend',
      ]) {
        await page.locator('#jobs').evaluate((el, href) => el.setAttribute('href', href), href);
        assert.equal((await guard('click', { text: 'Jobs' }))?.noDispatch, true, href);
      }
      await page.locator('#jobs').evaluate(el => el.setAttribute('href', '/jobs/'));
      for (const [attribute, value] of [['role', 'button'], ['data-action', 'send'], ['onclick', 'void(0)'], ['download', 'jobs']]) {
        await page.locator('#jobs').evaluate((el, [name, value]) => el.setAttribute(name, value), [attribute, value]);
        assert.equal((await guard('click', { text: 'Jobs' }))?.noDispatch, true, attribute);
        await page.locator('#jobs').evaluate((el, name) => el.removeAttribute(name), attribute);
      }
      await page.evaluate(() => {
        document.querySelector('#chat').hidden = false;
        document.querySelector('#send').textContent = 'Jobs';
      });
      assert.equal((await guard('click', { text: 'Jobs' }))?.noDispatch, true, 'duplicate action label');
      // Text wins over selector at dispatch; matchIndex must also agree with
      // dispatch rather than accidentally approving the first selector match.
      await page.locator('#send').evaluate(el => { el.textContent = 'Send'; el.classList.add('destination'); });
      assert.equal((await guard('click', { text: 'Send', selector: '#jobs' }))?.noDispatch, true);
      assert.equal((await guard('click', { selector: '.destination', matchIndex: 2 }))?.noDispatch, true);
      assert.equal((await guard('click_ax', { ref_id: 'ref_missing' }))?.noDispatch, true);
      assert.deepEqual(await page.evaluate(() => window.fixtureClicks), []);
    });

    register(`${kind}: LinkedIn recipient guard disambiguates passive labels like click dispatch`, async (page) => {
      const { agent, guard } = await setup(page);
      await page.evaluate(() => {
        document.querySelector('#chat').hidden = false;
        document.querySelector('#send').insertAdjacentHTML('beforebegin', '<label for="send">Send</label>');
      });
      agent._planExecutionGuards.set(1, { messaging: { target_kind: 'named', recipients: ['Alice'] } });
      for (const args of [
        { text: 'Send', textMatch: 'exact' },
        { text: 'Sen', textMatch: 'prefix' },
        { text: 'end', textMatch: 'contains' },
        { text: 'Send' },
      ]) {
        const execution = {};
        assert.equal(await agent._messageRecipientGuardBlock(1, 'click', args, page.url(), execution), null);
        assert.equal(execution.messageRecipientGuardRequired, true);
        assert.ok(execution.messageRecipientDispatchBinding?.token);
        const clicked = await call(page, 'click', { ...args, ...execution });
        assert.equal(clicked.success, true, JSON.stringify(clicked));
        assert.equal(await page.evaluate(() => window.fixtureClicks.at(-1)), 'send');
      }
      await page.locator('#send').evaluate(el => el.insertAdjacentHTML('afterend', '<button type="button">Send</button>'));
      assert.equal((await guard('click', { text: 'Send' }))?.noDispatch, true, 'two interactive matches must remain ambiguous');
      assert.deepEqual(await page.evaluate(() => window.fixtureClicks), ['send', 'send', 'send', 'send']);
    });

    register(`${kind}: LinkedIn recipient guard accepts shadow controls inside the active modal`, async (page) => {
      const { agent, guard } = await setup(page);
      const ref = await page.evaluate(() => {
        const chat = document.querySelector('#chat');
        chat.hidden = false;
        const modal = document.createElement('div');
        modal.id = 'modal';
        modal.setAttribute('role', 'dialog');
        modal.setAttribute('aria-modal', 'true');
        modal.style.cssText = 'position:fixed;inset:0;background:white';
        document.body.append(modal);
        modal.append(chat);
        const host = document.createElement('span');
        host.id = 'send-host';
        document.querySelector('#send').replaceWith(host);
        const shadow = host.attachShadow({ mode: 'open' });
        shadow.innerHTML = '<button id="shadow-send" type="button" style="padding:8px">Send</button>';
        const send = shadow.querySelector('button');
        send.addEventListener('click', event => {
          event.preventDefault();
          window.fixtureClicks.push(send.id);
        });
        // This is exactly the distinction that ordinary contains() misses.
        if (modal.contains(send)) throw new Error('fixture target must cross a shadow boundary');
        return window.__wb_ax_ref(send);
      });
      agent._planExecutionGuards.set(1, { messaging: { target_kind: 'named', recipients: ['Alice'] } });
      const args = { ref_id: ref };
      const execution = {};
      assert.equal(await agent._messageRecipientGuardBlock(1, 'click_ax', args, page.url(), execution), null);
      assert.equal(execution.messageRecipientGuardRequired, true);
      assert.ok(execution.messageRecipientDispatchBinding?.token);
      const clicked = await call(page, 'click_ax', { ...args, ...execution });
      assert.equal(clicked.success, true, JSON.stringify(clicked));
      assert.deepEqual(await page.evaluate(() => window.fixtureClicks), ['shadow-send']);
      // Moving the same host outside the modal must not grant background access.
      await page.locator('#send-host').evaluate(host => document.body.append(host));
      assert.equal((await guard('click_ax', args))?.noDispatch, true);
      assert.deepEqual(await page.evaluate(() => window.fixtureClicks), ['shadow-send']);
    });

    register(`${kind}: LinkedIn navigation respects modal scope and preserves send authorization`, async (page) => {
      const { agent, guard, probe } = await setup(page);
      await page.evaluate(() => {
        document.querySelector('#chat').hidden = false;
        document.body.insertAdjacentHTML('beforeend', '<div id="modal" role="dialog" aria-modal="true" style="position:fixed;inset:80px;background:white"><button>Jobs</button></div>');
      });
      assert.equal((await guard('click', { text: 'Jobs' }))?.noDispatch, true, 'modal text must not resolve background link');
      assert.equal((await guard('click', { selector: '#jobs' }))?.noDispatch, true, 'background selector must not bypass modal');
      await page.locator('#modal').evaluate(el => el.remove());
      const send = await probe('click', { text: 'Send' });
      assert.equal(send.messageSend, true, JSON.stringify(send));
      assert.deepEqual(send.strongIdentityCandidates, ['Alice']);
      assert.equal((await guard('click', { text: 'Send' }))?.noDispatch, true, 'missing recipient');
      agent._planExecutionGuards.set(1, { messaging: { target_kind: 'named', recipients: ['Bob'] } });
      assert.equal((await guard('click', { text: 'Send' }))?.noDispatch, true, 'wrong recipient');
      agent._planExecutionGuards.set(1, { messaging: { target_kind: 'named', recipients: ['Alice'] } });
      const execution = {};
      assert.equal(await agent._messageRecipientGuardBlock(1, 'click', { text: 'Send' }, page.url(), execution), null);
      assert.equal(execution.messageRecipientGuardRequired, true);
      assert.ok(execution.messageRecipientDispatchBinding?.token);
      // A verified navigation classification must never permit replaying a
      // send binding after the action or conversation changed.
      await page.locator('#chat h2').evaluate(el => { el.textContent = 'Bob'; });
      const stale = await call(page, 'consume_message_recipient_dispatch_binding', execution);
      assert.equal(stale.noDispatch, true);
      assert.deepEqual(await page.evaluate(() => window.fixtureClicks), []);
    });
  }
}
