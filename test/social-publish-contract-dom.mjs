// Isolated DOM fixtures. Every request is fulfilled locally; no live account
// is opened and no publication is sent. Run with npm run test:social-contract:dom.
import { strict as assert } from 'node:assert';
import { chromium } from 'playwright';
import fs from 'node:fs';
import vm from 'node:vm';
import { defaultDecide, fixtureControlEffectReading, semanticQuestionOf } from './semantic-decision-stub.mjs';
const browser = await chromium.launch({headless:true});
let checked=0;
try {
  const context=await browser.newContext();
  await context.route('**/*',route=>route.fulfill({status:200,contentType:'text/html',body:'<!doctype html><html><body></body></html>'}));
  const page=await context.newPage();
  for(const build of ['chrome','firefox']){
    const {Agent}=await import(`../src/${build}/src/agent/agent.js`);
    const invariant=await import(`../src/${build}/src/agent/completion-invariant.js`);
    const source=fs.readFileSync(`src/${build}/src/agent/agent.js`,'utf8');
    const marker=source.indexOf('const publicationRecordRoot = ${publicationResourceRecordRoot.toString()};');
    const raw=source.slice(source.lastIndexOf('`',marker)+1,source.indexOf('`',marker+1));
    // The agent fills in its own run fact (formsUntouchedByRun, agent.js) when it
    // builds this probe; pass the value the fixture agent would compute.
    const completionProbeFor=formsUntouchedByRun=>vm.runInNewContext('`'+raw+'`',{...invariant,formsUntouchedByRun});
    const readPublished=(formsUntouchedByRun=false)=>page.evaluate(code=>Function('return ('+code+')')(),completionProbeFor(formsUntouchedByRun));

    // Compare preflight with the real content-script click handler, plus the
    // Chrome CDP resolver and pointer dispatch. A competing ARIA name must not
    // turn an actual submit into an editable-target exemption.
    const clickPage = await context.newPage();
    await clickPage.goto('https://example.com/settings');
    await clickPage.evaluate(() => {
      window.clickListeners = [];
      window.chrome = {runtime:{sendMessage:()=>{},onMessage:{addListener:fn=>window.clickListeners.push(fn)}}};
      window.browser = window.chrome;
    });
    for(const name of ['accessibility-tree.js','content.js'])await clickPage.addScriptTag({content:fs.readFileSync(`src/${build}/src/content/${name}`,'utf8')});
    const strategies = build === 'chrome' ? ['content', 'cdp'] : ['content'];
    for (const strategy of strategies) {
      for (const textMatch of [undefined, 'exact', 'prefix', 'contains']) {
        await clickPage.setContent('<form><input aria-label="Save" placeholder="Name"><button type="submit">Save</button></form><section hidden><button>Save</button></section><button style="visibility:hidden">Save</button>');
        await clickPage.evaluate(() => {
          window.submitCount = 0;
          document.querySelector('form').addEventListener('submit', event => { event.preventDefault(); window.submitCount++; });
        });
        const args = {text:'Save', ...(textMatch ? {textMatch} : {})};
        const preflight = await clickPage.evaluate(({source,args}) => Function('return ('+source+')')()('click',args),
          {source:Agent._submitActionProbe.toString(),args});
        if (strategy === 'content') {
          const result = await clickPage.evaluate(args => new Promise((resolve, reject) => {
            if (!window.clickListeners.length) return reject(new Error('Content click handler was not installed'));
            for (const listener of window.clickListeners) listener({target:'content',action:'click',params:args},{},resolve);
          }), args);
          assert.equal(result.success, false, JSON.stringify(result));
          assert.equal(result.dispatched, false);
          assert.match(result.error, /Ambiguous text match/);
          assert.equal(await clickPage.evaluate(() => window.submitCount), 0);
          const buttons=result.candidates.filter(candidate=>candidate.tag==='button');
          assert.equal(buttons.length,1,'The returned choices identify one native submit button.');
          // Recover using an actual freshly minted AX ref for the returned
          // native button; competing ARIA names never select it implicitly.
          const ref=await clickPage.evaluate(candidate=>new Promise(resolve=>{
            for(const listener of window.clickListeners)listener({target:'content',action:'get_accessibility_tree',params:{filter:'all'}},{},()=>{
              const target=document.elementFromPoint(candidate.cx,candidate.cy)?.closest('button');
              resolve(target?window.__wb_ax_ref(target):null);
            });
          }),buttons[0]);
          assert.match(ref,/^ref_\d+$/);
          const retryArgs={ref_id:ref};
          const retryProbe=await clickPage.evaluate(({source,args})=>Function('return ('+source+')')()('click_ax',args),{source:Agent._submitActionProbe.toString(),args:retryArgs});
          assert.equal(retryProbe?.isSubmit,true);
          assert.notEqual(retryProbe?.resolvedOrdinaryActivationTarget,true);
          const retry=await clickPage.evaluate(args=>new Promise(resolve=>{
            for(const listener of window.clickListeners)listener({target:'content',action:'click_ax',params:args},{},resolve);
          }),retryArgs);
          assert.equal(retry.success,true,JSON.stringify(retry));
        } else {
          // The scan is built once and evaluated again after the cursor glide.
          const start = source.indexOf('const textTargetScript = `', source.indexOf('// Text-based click with auto-fallback matching.'));
          assert(start >= 0, 'CDP text-click target script not found');
          const templateStart = source.indexOf('`', start);
          const templateEnd = source.indexOf('`;', templateStart + 1);
          // The scan tags the elements it reports with a per-call nonce so their
          // model-facing names can be resolved in the content-script world.
          const code = vm.runInNewContext(source.slice(templateStart, templateEnd + 1), {args, modelNameNonce: 'wbmn_contract'});
          const resolved = await clickPage.evaluate(code => Function('return ('+code+')')(), code);
          assert.equal(resolved.found, true);
          assert.equal(resolved.isSubmitControl, true);
          await clickPage.mouse.click(resolved.x, resolved.y);
        }
        assert.equal(await clickPage.evaluate(() => window.submitCount), 1, `${build}/${strategy}: executor submits`);
        assert.equal(preflight?.isSubmit, true, `${build}/${strategy}: preflight must classify the same submit`);
        assert.notEqual(preflight?.resolvedEditableTarget, true);
        checked++;
      }
    }
    await clickPage.close();

    if (build === 'chrome') {
      // Exercise the real CDP keyboard dispatch on this host. On macOS a
      // synthetic Meta+A without commands:['selectAll'] does not select text.
      const {cdpClient} = await import('../src/chrome/src/cdp/cdp-client.js');
      const typingPage = await context.newPage();
      await typingPage.goto('https://x.com/compose/post');
      const session = await context.newCDPSession(typingPage);
      const originals = {attach:cdpClient.attach,sendCommand:cdpClient.sendCommand};
      const commands = [];
      cdpClient.attach = async () => ({attached:true});
      cdpClient.sendCommand = async (_tab, method, params) => {
        commands.push({method,params});
        return session.send(method,params);
      };
      try {
        for (const route of ['selector','focused']) {
          for (const tag of ['input','textarea','div']) {
            await typingPage.setContent(tag === 'div'
              ? '<div id="editor" contenteditable="true" role="textbox">Old tweet text must disappear.</div>'
              : `<${tag} id="editor"></${tag}>`);
            const editor = typingPage.locator('#editor');
            if (tag !== 'div') await editor.fill('Old tweet text must disappear.');
            await editor.focus();
            const text='Replacement tweet ①';
            const agent = new Agent({});
            agent._showAgentTarget=()=>{};
            const result=route === 'selector'
              ? await cdpClient.typeText(1,'#editor',text,true)
              : await agent.executeTool(1,'type_text',{text,clear:true});
            assert.equal(result.success,true,`${route}/${tag}: ${JSON.stringify(result)}`);
            assert.equal(result.verified,true,`${route}/${tag}: replacement verified`);
            assert.equal(await editor.evaluate(el=>el.isContentEditable?el.textContent:el.value),text);
            assert.equal(agent._uncertainTextMutations.has(1),false);
            checked++;
          }
        }
        assert(commands.some(({method,params})=>method==='Input.dispatchKeyEvent' && params.type==='keyDown' && params.commands?.includes('selectAll')));
        assert(!commands.some(({method,params})=>method==='Input.dispatchKeyEvent' && params.type==='keyUp' && params.commands?.length));
      } finally {
        Object.assign(cdpClient,originals);
        await session.detach();
        await typingPage.close();
      }
    }

    // Bluesky uses ProseMirror paragraphs. Verify the actual content-script
    // readback, digest, CDP paths and publication probe against the same DOM.
    const editorPage = await context.newPage();
    await editorPage.goto('https://bsky.app/');
    await editorPage.evaluate(() => {
      window.fieldListeners = [];
      window.chrome = {runtime:{sendMessage:()=>{},onMessage:{addListener:fn=>window.fieldListeners.push(fn)}}};
      window.browser = window.chrome;
      window.__wb_ax_lookup = () => document.querySelector('.ProseMirror');
    });
    await editorPage.addScriptTag({content:fs.readFileSync(`src/${build}/src/content/content.js`,'utf8')});
    const readField = (action, params) => editorPage.evaluate(({action,params}) => new Promise(resolve => {
      for (const listener of window.fieldListeners) listener({target:'content',action,params},{},resolve);
    }), {action,params});
    const announcement = 'WebBrain 35.0.0 is coming with a lot of fixes.\n\nCheck out the changelog: https://github.com/webbrain-one/webbrain/blob/main/CHANGELOG.md';
    const escape = text => text.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    const paragraphs = text => text.split('\n').map(line => `<p>${line ? escape(line) : '<br class="ProseMirror-trailingBreak">'}</p>`).join('');
    const editorCases = [
      [announcement, paragraphs(announcement)],
      [' Leading \n\nline \n', paragraphs(' Leading \n\nline \n')],
      ['a\nb', '<p>a<br>b</p>'],
      ['a\n', '<p>a<br><br class="ProseMirror-trailingBreak"></p>'],
      ['', '<p><br class="ProseMirror-trailingBreak"></p>'],
    ];
    const {cdpClient} = build === 'chrome' ? await import('../src/chrome/src/cdp/cdp-client.js') : {};
    const oldEvaluate = cdpClient?.evaluate;
    if (cdpClient) cdpClient.evaluate = async (_tab, code) => ({result:{value:await editorPage.evaluate(code => eval(code),code)}});
    try {
      for (const [expected,html] of editorCases) {
        await editorPage.setContent(`<nav><a href="/profile/alice.bsky.social">Profile</a></nav><div role="dialog"><div class="ProseMirror" contenteditable="true" style="white-space:pre-wrap">${html}</div><button id="publish" type="button" data-testid="composerPublishBtn">Post</button></div>`);
        const verification = await readField('ax_verify_field_value',{ref_id:'editor',expected});
        assert.equal(verification.verified,true,`${build}: semantic exact readback ${JSON.stringify(expected)}`);
        assert.equal(verification.actual,expected);
        assert.equal((await readField('ax_verify_field_value',{ref_id:'editor',expected:expected.replace(/\n/g,'\r\n')})).verified,true,'CRLF remains canonically equivalent');
        const wrong = await readField('ax_verify_field_value',{ref_id:'editor',expected:expected+' '});
        assert.equal(wrong.verified,false,'a missing space cannot be normalized away');
        const digest = await readField('field_value_digest',{ref_id:'editor',expected});
        assert.equal(digest.verified,true);
        assert.equal(digest.valueLength,expected.length);
        const {createHash} = await import('node:crypto');
        assert.equal(digest.valueSha256,createHash('sha256').update(expected).digest('hex'));
        const detected = await editorPage.evaluate(source => Function('return ('+source+')')()('click',{selector:'#publish'}),Agent._submitActionProbe.toString());
        assert.equal(detected.publicationSnapshot.posts[0].bodyText,expected,'preflight must read the same text as typing');
        if (cdpClient) {
          assert.equal(await cdpClient.verifyTextEntry(1,{selector:'.ProseMirror',text:expected,clear:true}),true);
          assert.equal(await cdpClient.verifyTextEntry(1,{selector:'.ProseMirror',text:expected.replace(/\n/g,'\r\n'),clear:true}),true);
          assert.equal(await cdpClient.verifyTextEntry(1,{selector:'.ProseMirror',text:expected+' ',clear:true}),null);
          const signature = await cdpClient.textEntrySignature(1,{selector:'.ProseMirror'});
          await editorPage.locator('.ProseMirror p').last().evaluate(el => el.append(' suffix'));
          assert.equal(await cdpClient.verifyTextEntry(1,{selector:'.ProseMirror',text:' suffix',beforeSignature:signature}),true);
        }
        checked++;
      }
      // Actual hard breaks must not receive innerText's expanded-newline
      // tolerance: these are two document line breaks, not three.
      await editorPage.setContent('<div class="ProseMirror" contenteditable="true"><p>a</p><p><br class="ProseMirror-trailingBreak"></p><p>b</p></div>');
      assert.equal((await readField('ax_verify_field_value',{ref_id:'editor',expected:'a\n\n\nb'})).verified,false);
      checked++;
    } finally {
      if (cdpClient) cdpClient.evaluate = oldEvaluate;
      await editorPage.close();
    }

    const probe=async(selector='#publish')=>page.evaluate(({source,selector})=>{
      const fn=Function('return ('+source+')')();
      return fn('click',{selector});
    },{source:Agent._submitActionProbe.toString(),selector});
    for(const platform of ['twitter','bluesky']){
      await page.goto(platform==='twitter'?'https://x.com/home':'https://bsky.app/');
      // Run the real probe wrapper and dispatch gate against ordinary forms
      // on social domains, including an unrelated composer on the same page.
      const publishId=platform==='twitter'?'tweetButtonInline':'composerPublishBtn';
      const providerScope={chat:async()=>({content:'{}'})};
      const scopeAgent=new Agent({getActive:()=>providerScope}),scopeTab=909;
      scopeAgent.useSiteAdapters=true;scopeAgent._persist=()=>{};scopeAgent._currentUrl=async()=>page.url();
      scopeAgent.conversations.set(scopeTab,[{role:'system',content:'system'},{role:'user',content:'Save my profile settings. Do not publish anything.'}]);
      const scopeGuard=scopeAgent._startPlanExecutionGuard(scopeTab,'act',{requestKind:'execute',requiresStateChange:true,requiresSubmission:true});
      let scopeCalls=0;
      // Button captions are read by a model (the fixtures' oracle) before a
      // click; only publication model calls are counted.
      scopeAgent._chatWithCostAllowance=async(_provider,messages,_options,_cost,meta)=>{
        const kind=String(meta?.generationName||'').match(/^semantic_(.+)$/)?.[1];
        if(kind) return {content:JSON.stringify(defaultDecide(kind,semanticQuestionOf(scopeAgent,messages)))};
        scopeCalls++;return {content:JSON.stringify({version:1,status:'none',actions:[],requirements:null,prohibited:[],reason:'Settings only.'})};};
      const previousChrome=globalThis.chrome;
      globalThis.chrome={scripting:{executeScript:async({func,args})=>[{result:await page.evaluate(({source,args})=>Function('return ('+source+')')()(...args),{source:func.toString(),args})}]}};
      try {
        // Bluesky's desktop launcher has an accessible name but no composeFAB
        // test ID. Visible text, icon-only and nested targets all open a draft:
        // a model reads the caption as opening an editor, in any language.
        const launchers = platform === 'bluesky' ? [
          '<button id="launch" type="button" aria-label="Compose new post"><span>New Post</span></button>',
          '<button id="launch" type="button" aria-label="Compose new post"><svg width="30" height="30"></svg></button>',
          '<div id="launch" role="button" aria-label="Compose new post"><span>New Post</span></div>',
          '<div role="dialog"><button id="launch" type="button" aria-label="Compose new post">New Post</button></div>',
          '<button id="launch" data-testid="composeFAB">Compose new post</button>',
        ] : ['<button id="launch" data-testid="SideNav_NewTweet_Button">Compose new post</button>'];
        const notSubmit = detected => detected?.isSubmit === false
          && (detected.resolvedNonSubmitTarget === true || detected.resolvedOrdinaryActivationTarget === true);
        for (const html of launchers) {
          await page.setContent(html);
          await page.evaluate(() => { window.__wb_ax_lookup = () => document.getElementById('launch'); });
          const clickText = await page.locator('#launch').evaluate(el => el.innerText || el.ariaLabel);
          for (const [name, args] of [['click_ax', {ref_id:'launch'}], ['click', {text:clickText,textMatch:'exact'}], ['click', {selector:'#launch'}]]) {
            const detected = await scopeAgent._detectLikelySubmitAction(scopeTab,name,args);
            assert.equal(notSubmit(detected),true,`${build}/${platform}: launcher ${name}`);
            assert.equal(await scopeAgent._workflowPreSubmitDispatchBlock(scopeTab,name,args,detected,providerScope),null);
            checked++;
          }
        }
        if (platform === 'twitter') {
          const {guardRecentSubmitClick:guard}=await import(`../src/${build}/src/agent/submit-click-guard.js`);
          // What a model read each caption as.
          const guardRecentSubmitClick=(...args)=>guard(...args,async caption=>fixtureControlEffectReading(caption));
          await page.setContent('<div role="dialog"><div contenteditable="true">First tweet</div><button id="add" type="button" data-testid="addButton" aria-label="Add post"><svg width="24" height="24"></svg></button><button id="publish" type="button" data-testid="tweetButton">Post all</button></div>');
          const recent=new Map();
          for(let i=0;i<3;i++) {
            const args={text:'Add post'};
            const detected=await scopeAgent._detectLikelySubmitAction(scopeTab,'click',args);
            assert.equal(detected?.resolvedNonSubmitTarget,true);
            assert.equal(await guardRecentSubmitClick(recent,scopeTab,args,async()=>page.url(),()=>100000+i*1000,detected),null);
            checked++;
          }
          assert.equal((await probe()).isSubmit,true,'actual thread publication stays guarded');
        }
        if (platform === 'bluesky') {
          for (const label of ['Cancel','Keep editing']) {
            const composer = '<div role="dialog"><div contenteditable="true">Draft</div><button data-testid="composerPublishBtn">Post</button>CONTROL</div>';
            const button = `<button id="recover" type="button" aria-label="${label}"><span>${label}</span></button>`;
            for (const nested of [false,true]) {
              await page.setContent(composer.replace('CONTROL',nested ? `<div role="alertdialog">${button}</div>` : button));
              if (label === 'Cancel' && nested) continue;
              await page.evaluate(() => { window.__wb_ax_lookup = () => document.querySelector('#recover span'); });
              for (const [name,args] of [['click_ax',{ref_id:'recover'}],['click',{text:label,textMatch:'exact'}],['click',{selector:'#recover span'}]]) {
                const detected = await scopeAgent._detectLikelySubmitAction(scopeTab,name,args);
                assert.equal(notSubmit(detected),true,`${build}: ${label}/${name}`);
                assert.equal(await scopeAgent._workflowPreSubmitDispatchBlock(scopeTab,name,args,detected,providerScope),null);
                checked++;
              }
            }
            for (const attrs of ['data-testid="composerPublishBtn"','data-testid="unknown"','aria-label="Publish post"','type="submit"']) {
              await page.setContent(composer.replace('CONTROL',`<button id="recover" ${attrs}>${label}</button>`));
              const detected = await scopeAgent._detectLikelySubmitAction(scopeTab,'click',{selector:'#recover'});
              assert.notEqual(notSubmit(detected),true,'conflicting publish/form identity must remain guarded');
              assert((await scopeAgent._workflowPreSubmitDispatchBlock(scopeTab,'click',{selector:'#recover'},detected,providerScope)).noDispatch);
              checked++;
            }
          }
          for (const html of [
            '<button id="launch" type="button" aria-label="Publish post">Post</button>',
            '<form><button id="launch" type="submit" aria-label="Compose new post">New Post</button><textarea>Hello</textarea><button data-testid="composerPublishBtn">Post</button></form>',
            '<div role="dialog"><div contenteditable="true">Hello</div><button id="launch" data-testid="composerPublishBtn" aria-label="Compose new post">Post</button></div>',
          ]) {
            await page.setContent(html);
            const detected = await scopeAgent._detectLikelySubmitAction(scopeTab,'click',{selector:'#launch'});
            assert.notEqual(notSubmit(detected),true,'publish and form controls are not ordinary launchers');
            assert((await scopeAgent._workflowPreSubmitDispatchBlock(scopeTab,'click',{selector:'#launch'},detected,providerScope)).noDispatch);
            checked++;
          }
          // The negative fixtures may compile a none contract; start the
          // unrelated-form checks below from their original empty guard.
          scopeGuard.socialPublication=null;
          scopeCalls=0;
        }
        await scopeAgent._ensureProgressSessionForCurrentTask(scopeTab,{provider:providerScope,taskText:'Save profile settings',progressLedgerPolicy:'disabled'});
        assert.equal(await scopeAgent._adoptLiveSocialPublishWorkflow(scopeTab,providerScope),false);
        for(const external of [false,true]){
          const save=`<button id="save" ${external?'form="settings"':''}><span>Kaydet</span></button>`;
          await page.setContent(`<main><form id="settings"><input id="name" value="Alice"><textarea id="bio">My profile</textarea>${external?'':save}</form>${external?save:''}<div id="other-composer"><div contenteditable="true" role="textbox">Unrelated draft</div><button data-testid="${publishId}">Post</button></div></main>`);
          for(const [name,args] of [['click',{selector:'#save span'}],['press_keys',{key:'Enter'}]]){
            await page.locator('#name').focus();
            const ordinary=await scopeAgent._detectLikelySubmitAction(scopeTab,name,args);
            assert.equal(ordinary.isSubmit,true);
            assert.equal(ordinary.publicationControl,false,'own form is distinct from the nearby composer');
            assert.equal(ordinary.publicationSnapshot,null);
            assert.equal(await scopeAgent._workflowPreSubmitDispatchBlock(scopeTab,name,args,ordinary,providerScope),null);
            assert.equal(scopeCalls,0);checked++;
          }
        }
        // Exercise the actual batch caller with the actual injected detector.
        // Only the final tool execution is simulated; the caller must collect
        // composer ownership before either publication guard sees set_field.
        scopeAgent._skipPermissionGate=true;scopeAgent._ensureGateSetting=async()=>true;
        scopeAgent._recordProgressObservation=async()=>null;scopeAgent._autoRecordProgressAction=()=>null;
        scopeAgent._progressWarningForAction=()=>'';scopeAgent._captureFormValidationState=async()=>[];
        scopeAgent._waitForFormValidationFailure=async()=>null;
        for(const kind of ['search','composer','missing']){
          for(const submit of [true,false]){
            scopeAgent._clearLoopState(scopeTab); // Each fixture is a separate attempted action.
            await page.setContent(kind==='search'
              ? '<form><input id="field" type="search" name="q"><button>Search</button></form>'
              : kind==='composer'
                ? `<form><textarea id="field">Draft</textarea><button data-testid="${publishId}">Post</button></form>`
                : '<main>No resolved field</main>');
            await page.evaluate(()=>{window.__wb_ax_lookup=ref=>document.getElementById(ref);});
            let executions=0;
            scopeAgent.executeTool=async()=>{executions++;return {success:true,dispatched:true};};
            const messages=[];
            await scopeAgent._executeToolBatch(scopeTab,[{id:'set_field_case',function:{name:'set_field',arguments:JSON.stringify({ref_id:'field',text:'Hello',submit})}}],messages,()=>{},providerScope,'',new Set(['set_field']),1);
            const result=JSON.parse(scopeAgent._unwrapUntrusted(messages.find(m=>m.tool_call_id==='set_field_case').content));
            const reachesDispatch=!submit || kind==='search';
            assert.equal(executions,reachesDispatch?1:0,kind+' submit='+submit+' batch dispatch');
            assert.equal(result.success,reachesDispatch,kind+' submit='+submit+' batch result');
            if(!reachesDispatch) assert.equal(result.noDispatch,true);
            assert.equal(scopeCalls,0,'no publication model call for ordinary forms or bundled submission rejection');
            checked++;
          }
        }
        // A localized composer, an unnamed Post button, and an incomplete
        // composer all stay guarded. Implicit Enter must not become a bypass.
        for(const kind of ['localized','unnamed','incomplete']){
          await page.setContent(`<form id="composer">${kind==='incomplete'?'':'<textarea id="body">Hello</textarea>'}<button id="publish" ${kind==='unnamed'?'':`data-testid="${publishId}"`}>${kind==='unnamed'?'Post':'Yayınla'}</button></form>`);
          const detected=await scopeAgent._detectLikelySubmitAction(scopeTab,'click',{selector:'#publish'});
          assert.equal(detected.publicationControl,true,kind);
          assert((await scopeAgent._workflowPreSubmitDispatchBlock(scopeTab,'click',{selector:'#publish'},detected,providerScope)).noDispatch);
          if(kind!=='incomplete'){
            await page.locator('#body').focus();
            const implicit=await scopeAgent._detectLikelySubmitAction(scopeTab,'press_keys',{key:'Enter'});
            assert.equal(implicit.publicationControl,true,kind+' implicit submission');
            assert((await scopeAgent._workflowPreSubmitDispatchBlock(scopeTab,'press_keys',{key:'Enter'},implicit,providerScope)).noDispatch);
          }
          checked++;
        }
        assert.equal(scopeCalls,1,'one cached none contract, no authorization call');
        assert.equal(scopeGuard.siteWorkflow,null);
        // Cached none intent still permits a subsequent ordinary settings save.
        await page.setContent('<form><textarea>Bio</textarea><button id="save">Save</button></form>');
        const ordinary=await scopeAgent._detectLikelySubmitAction(scopeTab,'click',{selector:'#save'});
        assert.equal(await scopeAgent._workflowPreSubmitDispatchBlock(scopeTab,'click',{selector:'#save'},ordinary,providerScope),null);
        assert.equal(scopeCalls,1);checked++;
        const opaque=await scopeAgent._detectLikelySubmitAction(scopeTab,'execute_js',{code:'publish()'});
        assert((await scopeAgent._workflowPreSubmitDispatchBlock(scopeTab,'execute_js',{code:'publish()'},opaque,providerScope)).noDispatch);checked++;
      } finally {if(previousChrome===undefined) delete globalThis.chrome;else globalThis.chrome=previousChrome;}
      const body='Beginning ① Ａ 👨‍👩‍👧\n\n'+ 'long exact body '.repeat(650)+'END';
      await page.setContent(`<nav><a ${platform==='twitter'?'data-testid="AppTabBar_Profile_Link" href="/alice"':'href="/profile/alice.bsky.social"'}>Profile</a></nav><main><div id="composer"><div contenteditable="true" role="textbox" id="body" style="white-space:pre-wrap"></div><button id="publish" data-testid="${platform==='twitter'?'tweetButtonInline':'composerPublishBtn'}">Post</button></div></main>`);
      await page.locator('#body').fill(body);
      const result=await probe();
      assert.equal(result?.isSubmit,true,`${build}/${platform}: submit target`);
      assert.equal(result.publicationResourceUrlsComplete,true);
      assert.deepEqual(result.publicationResourceUrls,[]);
      assert.equal(result.publicationSnapshot?.complete,true,`${build}/${platform}: complete composer`);
      assert.equal(result.publicationSnapshot.posts[0].bodyText,body);
      assert.deepEqual(result.publicationSnapshot.posts[0].attachments,[]);
      assert.equal(result.publicationSnapshot.posts[0].context.kind,'post');
      checked++;
      // A link preview is not an uploaded attachment. Avatar/emoji images also
      // cannot satisfy the user's requested media count.
      await page.locator('#composer').evaluate(el=>{
        const box=document.createElement('div');box.setAttribute('data-testid','linkPreview');
        box.innerHTML='<img src="data:image/svg+xml,<svg xmlns=\"http://www.w3.org/2000/svg\"/>" width="40" height="40">';
        el.append(box);
        const image=document.createElement('img');image.src='https://cdn.example/chart.png';image.width=80;image.height=60;image.alt='①';el.append(image);
      });
      const withMedia=await probe();
      assert.equal(withMedia.publicationSnapshot.posts[0].attachments.length,1);
      assert.equal(withMedia.publicationSnapshot.posts[0].attachments[0].alt,'①');
      checked++;
      // A missing parent in a reply composer is incomplete relationship
      // evidence; it must never be represented as permission for a new post.
      await page.locator('#composer').evaluate(el=>{const hint=document.createElement('span');hint.dataset.testid='replyingTo';hint.textContent='Replying to someone';el.append(hint);});
      const reply=await probe();
      assert.equal(reply.publicationSnapshot.complete,false);
      checked++;
      // Standard inline replies expose replyingTo, but no descendant status
      // link. Their parent comes from the active permalink route.
      const parent=platform==='twitter'?'https://x.com/bob/status/1111111111111111111':'https://bsky.app/profile/bob.bsky.social/post/3parent';
      const otherParent=platform==='twitter'?'https://x.com/carol/status/3333333333333333333':'https://bsky.app/profile/carol.bsky.social/post/3other';
      await page.evaluate(parent=>history.replaceState({},'',parent+'?source=fixture#reply'),parent);
      const inlineReply=await probe();
      assert.equal(inlineReply.publicationSnapshot.complete,true,'active thread identifies an inline reply parent');
      assert.deepEqual(inlineReply.publicationSnapshot.posts[0].context,{kind:'reply',target:parent});checked++;
      // A modal can target a different reply in the same thread. Its explicit
      // context wins; the background route must not fill missing modal proof.
      await page.locator('#composer').evaluate(el=>el.setAttribute('role','dialog'));
      assert.equal((await probe()).publicationSnapshot.complete,false);checked++;
      await page.locator('#composer').evaluate((el,parent)=>{
        const card=document.createElement('article');card.dataset.testid='replyToPost';card.id='reply-parent';
        const link=document.createElement('a');link.href=parent;link.textContent='Parent';card.append(link);el.append(card);
      },otherParent);
      const modalReply=await probe();
      assert.equal(modalReply.publicationSnapshot.complete,true);
      assert.equal(modalReply.publicationSnapshot.posts[0].context.target,otherParent);checked++;
      // A second possible parent stays ambiguous even on a known thread route.
      await page.locator('#reply-parent').evaluate((el,parent)=>{const a=document.createElement('a');a.href=parent;a.textContent='Other parent';el.append(a);},parent);
      assert.equal((await probe()).publicationSnapshot.complete,false);checked++;
      await page.locator('#reply-parent').evaluate(el=>el.remove());
      await page.locator('#composer').evaluate(el=>el.removeAttribute('role'));
      await page.evaluate(()=>history.replaceState({},'','/home?next=/bob/status/1111111111111111111'));
      // An authored body link cannot supply missing reply relationship proof.
      await page.locator('#body').evaluate((el,parent)=>{const a=document.createElement('a');a.href=parent;a.textContent='link';el.append(a);},parent);
      assert.equal((await probe()).publicationSnapshot.complete,false);checked++;
      await page.evaluate(parent=>history.replaceState({},'',parent),parent);
      await page.locator('[data-testid="replyingTo"]').evaluate(el=>el.remove());
      const ordinary=await probe();
      assert.deepEqual(ordinary.publicationSnapshot.posts[0].context,{kind:'post',target:null});checked++;

      // Each attachment must have exactly one observed owner in a thread.
      await page.setContent(`<nav><a ${platform==='twitter'?'data-testid="AppTabBar_Profile_Link" href="/alice"':'href="/profile/alice.bsky.social"'}>Profile</a></nav><div id="composer"><section id="first"><div contenteditable="true" role="textbox">First</div><img src="https://cdn.example/one.png" width="40" height="40"></section><section><div contenteditable="true" role="textbox">Second</div><img src="https://cdn.example/two.png" width="40" height="40"></section><button id="publish" data-testid="${platform==='twitter'?'tweetButtonInline':'composerPublishBtn'}">Post</button></div>`);
      const thread=await probe();
      assert.equal(thread.publicationSnapshot.complete,true);
      assert.deepEqual(thread.publicationSnapshot.posts.map(p=>p.attachments.length),[1,1]);checked++;
      await page.locator('#composer').evaluate(el=>el.append(el.querySelector('img').cloneNode()));
      const unowned=await probe();
      assert.equal(unowned.publicationSnapshot.complete,false,'unassigned thread media cannot disappear');checked++;

      // Exercise the actual injected completion probe, including its bounds.
      const permalink=platform==='twitter'?'https://x.com/alice/status/2222222222222222222':'https://bsky.app/profile/alice.bsky.social/post/3abc';
      const card=platform==='twitter'?'tweet':'feedItem-by-alice';
      const bodyId=platform==='twitter'?'tweetText':'postText';
      await page.setContent(`<article data-testid="${card}" id="published"><a href="${permalink}">timestamp</a><div data-testid="${bodyId}">Hello</div>${Array.from({length:13},(_,i)=>`<img src="https://cdn.example/${i}.png" alt="image" width="20" height="20">`).join('')}</article>`);
      let published=(await readPublished()).workflowResourceRecords[0];
      assert.equal(published.attachments.length,13,'attachments beyond twelve must not disappear');
      assert.equal(published.attachmentsComplete,true);checked++;
      // The forms run fact never changes what a published record reads as.
      assert.deepEqual((await readPublished(true)).workflowResourceRecords[0],published);checked++;
      await page.locator('#published').evaluate(el=>{for(let i=0;i<8;i++)el.append(el.querySelector('img').cloneNode());});
      published=(await readPublished()).workflowResourceRecords[0];
      assert.equal(published.attachmentsComplete,false,'overflow cannot prove an exact media count');checked++;
      await page.locator('#published').evaluate(el=>{
        [...el.querySelectorAll('img')].slice(1).forEach(node=>node.remove());
        el.querySelector('img').alt='a'.repeat(25001);
      });
      published=(await readPublished()).workflowResourceRecords[0];
      assert.equal(published.attachmentsComplete,false,'truncated alt text cannot prove exactness');checked++;
      await page.locator('#published').evaluate((el,bodyId)=>{
        el.querySelector('img').alt='image';
        for(let i=0;i<8;i++)el.append(el.querySelector(`[data-testid="${bodyId}"]`).cloneNode(true));
      },bodyId);
      published=(await readPublished()).workflowResourceRecords[0];
      assert.equal(published.bodyTextComplete,false,'overflow cannot prove a complete body');checked++;
      if (platform === 'bluesky') {
        // Current Bluesky detail markup: the timestamp is plain text and the
        // rich-text div has data-word-wrap, not a postText test ID. Exercise
        // real extraction through dispatch-bound completion, including the
        // exact paragraphs and shortened changelog link from the failing run.
        const body = announcement.replace('35.0.0', '36.0.0');
        const changelog = 'https://github.com/webbrain-one/webbrain/blob/main/CHANGELOG.md';
        const bodyHtml = escape(body).replace(changelog, `<a href="${changelog}">github.com/webbrain-one...</a>`);
        const detailCard = `<div data-testid="postThreadItem-by-alice.bsky.social" id="detail"><div><a href="/profile/alice.bsky.social"><div>Alice</div><div>@alice.bsky.social</div></a></div><div><div data-word-wrap="1" dir="auto" style="white-space:pre-wrap" id="detail-body">${bodyHtml}</div><div>4:36 PM · Sep 9, 2026</div><button>Reply</button></div></div>`;
        const detailHtml = `<main><div data-testid="postThreadScreen">${detailCard}</div></main>`;
        const composerHtml = `<nav><a href="/profile/alice.bsky.social">Profile</a></nav><div role="dialog"><div class="ProseMirror" contenteditable="true" style="white-space:pre-wrap">${paragraphs(body)}</div><button id="publish" data-testid="composerPublishBtn">Post</button></div>`;
        const verifyDetail = async (html, url = permalink, options = {}) => {
          const origin = options.origin || 'https://bsky.app/profile/alice.bsky.social/post/deleted';
          const dispatchResult = options.dispatchResult || {success:true,dispatched:true};
          await page.evaluate(url => history.replaceState({}, '', url), origin);
          await page.setContent(`${options.background || ''}${composerHtml}`);
          const provider = {chat:async()=>({content:'{}'})}, agent = new Agent({getActive:()=>provider}), tab = 912;
          agent.useSiteAdapters=true;agent._persist=()=>{};agent._currentUrl=async()=>page.url();
          agent.conversations.set(tab,[{role:'system',content:'system'},{role:'user',content:`Post exactly ${body} on Bluesky without attachments.`}]);
          const guard = agent._startPlanExecutionGuard(tab,'act',{requestKind:'execute',requiresStateChange:true,requiresSubmission:true});
          const raw = {version:1,status:'ready',actions:[{id:'p1',platform,account:null,posts:[{body:{kind:'exact',source:{source:'request',start:body,end:body}},media:{kind:'count',type:'any',format:null,min:0,max:0},context:{kind:'post',target:null}}]}],requirements:'p1',prohibited:[],reason:'Fixture request.'};
          agent._chatWithCostAllowance=async(_p,messages,_o,_c,meta)=>{
            const input=JSON.parse(messages[1].content);
            return {content:JSON.stringify(meta.generationName==='social_publication_authorization'?{key:input.key,actionId:input.action.id,authorized:true,reason:'Fixture audit.'}:raw)};
          };
          agent._detectLikelySubmitAction=async()=>probe();
          const detected=await probe();
          assert.equal(await agent._workflowPreSubmitDispatchBlock(tab,'click',{selector:'#publish'},detected,provider),null);
          agent._beginCompletionInvariant(tab);
          agent._recordCompletionToolResult(tab,'click',{selector:'#publish'},dispatchResult);
          agent._recordCompletionSubmitAttempt(tab,detected,'click',{selector:'#publish'},origin,origin,dispatchResult);
          await page.evaluate(url => history.replaceState({}, '', url), url);
          await page.setContent(html);
          const state=await readPublished(agent._completionFormsUntouchedByRun(tab));
          agent._recordCompletionToolResult(tab,'read_page',{}, {success:true,url:page.url(),content:'Observed published post.'});
          const terminal=agent._workflowTerminalEvidenceFromDone(tab,state,page.url(),agent._completionSubmissionEvidence(tab,state,page.url()));
          if (terminal) guard.workflowTerminalEvidence=terminal;
          return {state,terminal,missing:agent._missingSocialPublishTargets(guard),baseline:detected.publicationResourceUrls,baselineComplete:detected.publicationResourceUrlsComplete};
        };
        let result = await verifyDetail(detailHtml);
        const detail = result.state.workflowResourceRecords.find(r=>r.url===permalink);
        assert(detail, 'current permalink binds to the focused post without a self-link');
        assert.equal(detail.bodyText,body.replace(changelog,'github.com/webbrain-one...'));
        assert.equal(detail.bodyTextComplete,true);
        assert.equal(detail.contextComplete,true,'a standalone detail retains complete context');
        assert.equal(detail.links.find(l=>l.authored)?.href,changelog,'authored URL survives probe serialization');
        assert(result.terminal,`${build}: real Bluesky detail markup completes the publication`);
        assert.deepEqual(result.missing,[],'the social completion guard accepts the verified publication');checked++;
        // Bluesky names one account either by handle or by DID, and the detail
        // route may name the author by DID while the focused card renders the
        // handle. Binding must not assume the two read identically.
        const did='did:plc:alicebskyhandle';
        const didPermalink=`https://bsky.app/profile/${did}/post/3abc`;
        result=await verifyDetail(detailHtml,didPermalink);
        let didRecord=result.state.workflowResourceRecords.find(r=>r.url===didPermalink);
        assert(didRecord,'a DID detail route binds to its handle-rendered focused card');
        assert.equal(didRecord.bodyText,body.replace(changelog,'github.com/webbrain-one...'));
        assert.equal(didRecord.bodyTextComplete,true);
        assert.equal(didRecord.contextComplete,true,'a DID-backed standalone detail retains complete context');
        assert(result.terminal,`${build}: DID-backed detail page completes the publication`);
        assert.deepEqual(result.missing,[],'the completion guard accepts a DID-backed detail');checked++;
        // Relaxed DID matching must still fail closed under ambiguity: only a
        // unique anchorless focused card may borrow the route.
        result=await verifyDetail(detailHtml.replace(detailCard,detailCard+detailCard),didPermalink);
        assert.equal(result.state.workflowResourceRecords.some(r=>r.url===didPermalink),false,'a duplicate focused card cannot borrow a DID route');
        assert.equal(result.terminal,null,`${build}: duplicate cards cannot bind a DID route`);
        assert.deepEqual(result.missing,['bluesky']);checked++;
        const nativeBody = `<div data-word-wrap="1" dir="auto" style="white-space:pre-wrap" id="detail-body">${bodyHtml}</div>`;
        const nativeQuote = `<div role="link" tabindex="0"><a href="/profile/bob.bsky.social">Bob</a><div data-word-wrap="1" style="white-space:pre-wrap">${bodyHtml}</div></div>`;
        for (const [label,html,expectedBody] of [
          ['native quote-only',detailHtml.replace(nativeBody,nativeQuote),''],
          ['native body plus quote',detailHtml.replace(nativeBody,nativeBody+nativeQuote),body.replace(changelog,'github.com/webbrain-one...')],
          ['native quote with media',detailHtml.replace(nativeBody,nativeQuote.replace('</div>','<img src="https://cdn.example/quoted.png" width="30" height="30"></div>')),''],
        ]) {
          result=await verifyDetail(html);
          const record=result.state.workflowResourceRecords.find(r=>r.url===permalink);
          assert.equal(record?.bodyText,expectedBody,`${build}: ${label} excludes quoted text`);
          assert.deepEqual(record?.attachments,[],`${build}: ${label} excludes quoted media`);
          assert.equal(record?.contextComplete,false,'an unresolved native quote remains incomplete context');
          assert.equal(result.terminal,null,`${build}: ${label} cannot fulfill a standalone post`);
          assert.deepEqual(result.missing,['bluesky']);checked++;
        }
        const nativeParent='<div data-testid="postThreadItem-by-bob.bsky.social"><a href="/profile/bob.bsky.social">Bob</a><a href="/profile/bob.bsky.social/post/parent">Earlier</a><div data-word-wrap="1">Parent text</div></div>';
        for (const [label,leading] of [
          ['wrapped parent',`<div><div>${nativeParent}</div></div>`],
          ['unresolved parent gap',`<div>${nativeParent}</div><div>Continue thread</div>`],
        ]) {
          result=await verifyDetail(detailHtml.replace(detailCard,leading+`<div><div>${detailCard}</div></div>`));
          const record=result.state.workflowResourceRecords.find(r=>r.url===permalink);
          assert.equal(record?.bodyText,body.replace(changelog,'github.com/webbrain-one...'),'the matching authored body is still observed');
          assert.equal(record?.replyToUrl,'','unresolved native parent is not guessed');
          assert.equal(record?.contextComplete,false,'missing parent URL does not mean standalone');
          assert.equal(result.terminal,null,`${build}: native ${label} cannot fulfill a standalone post`);
          assert.deepEqual(result.missing,['bluesky']);checked++;
        }
        // Opening and closing a composer over an existing identical post
        // does not publish anything. Its anchorless route must be in the
        // pre-dispatch baseline even when the modal hides the underlying UI.
        for (const [label,dispatchResult] of [
          ['acknowledged click without publication',{success:true,dispatched:true}],
          ['uncertain dispatch',{success:false,outcomeUnknown:true}],
        ]) {
          for (const background of [detailHtml,detailHtml.replace('<main>','<main aria-hidden="true" style="display:none">')]) {
            result=await verifyDetail(detailHtml,permalink,{
              origin:permalink+'?view=thread#post',background,dispatchResult,
            });
            assert.equal(result.terminal,null,`${build}: ${label} cannot reuse an existing detail post`);
            assert.equal(result.baselineComplete,true);
            assert(result.baseline.some(url=>url.startsWith(permalink)),`${build}: current detail URL is captured before dispatch`);
            assert.deepEqual(result.missing,['bluesky'],label);checked++;
          }
        }
        // The added route counts toward the baseline bound; overflow must
        // remain incomplete, and the route cannot be truncated out itself.
        for (const count of [199,200]) {
          await page.evaluate(url=>history.replaceState({},'',url),permalink);
          const links=Array.from({length:count},(_,i)=>`<a href="/profile/bob.bsky.social/post/baseline${i}">${i}</a>`).join('');
          await page.setContent(links+composerHtml);
          const baseline=await probe();
          assert.equal(baseline.publicationResourceUrls[0],permalink);
          assert.equal(baseline.publicationResourceUrls.length,200);
          assert.equal(baseline.publicationResourceUrlsComplete,count===199);checked++;
        }
        // The focused card is first in the DOM, but its route-derived record
        // used to be appended after every neighbor and lost at the 40 cap.
        for (const count of [39,40,60]) {
          const neighbors=Array.from({length:count},(_,i)=>`<div data-testid="postThreadItem-by-bob.bsky.social"><a href="/profile/bob.bsky.social/post/neighbor${i}">Earlier ${i}</a><div data-word-wrap="1">Unrelated body ${i}</div></div>`).join('');
          result=await verifyDetail(detailHtml.replace(detailCard,detailCard+neighbors));
          assert(result.state.workflowResourceRecords.some(record=>record.url===permalink),`${build}: focused evidence survives ${count} neighboring records`);
          assert(result.state.workflowResourceRecords.length<=40,'the resource-record bound is preserved');
          assert(result.terminal,`${build}: focused publication completes with ${count} neighbors`);
          assert.deepEqual(result.missing,[]);checked++;
        }
        for (const [label, html, url] of [
          ['wrong author',detailHtml.replaceAll('alice.bsky.social','bob.bsky.social')],
          ['conflicting permalink',detailHtml.replace('<div>4:36 PM', '<a href="/profile/alice.bsky.social/post/other">Earlier post</a><div>4:36 PM')],
          ['duplicate focused card',detailHtml.replace(detailCard,detailCard+detailCard)],
          ['hidden focused card',detailHtml.replace('<main>','<main style="display:none">')],
          ['feed card',detailHtml.replace('postThreadItem-by-','feedItem-by-')],
          ['missing thread screen',detailHtml.replace('postThreadScreen','profileScreen')],
          ['quoted focused card',detailHtml.replace(detailCard,`<div data-testid="embeddedPost">${detailCard}</div>`)],
          ['feed route',detailHtml,'https://bsky.app/'],
          ['wrong body',detailHtml.replace('36.0.0','37.0.0')],
          ['wrong link',detailHtml.replace(changelog,'https://example.com/wrong')],
          ['reply instead of post',detailHtml.replace('id="detail"','id="detail" data-in-reply-to-url="https://bsky.app/profile/bob.bsky.social/post/parent"')],
          ['quote instead of post',detailHtml.replace('</button>','</button><div data-testid="embeddedPost"><a href="/profile/bob.bsky.social/post/quoted">Quoted post</a></div>')],
          ['body only in preview',detailHtml.replace(bodyHtml,`<a href="https://example.com/card"><div data-word-wrap="1">${escape(body)}</div></a>`).replace('data-word-wrap="1" dir="auto"','dir="auto"')],
          ['body only in quote',detailHtml.replace(bodyHtml,`<div data-testid="embeddedPost"><div data-word-wrap="1">${bodyHtml}</div></div>`).replace('data-word-wrap="1" dir="auto"','dir="auto"')],
        ]) {
          result=await verifyDetail(html,url);
          assert.equal(result.terminal,null,`${build}: ${label} cannot complete the publication`);
          assert.deepEqual(result.missing,['bluesky'],label);checked++;
        }
        const preview = '<a href="https://example.com/preview"><div data-word-wrap="1">Preview title</div></a>';
        result=await verifyDetail(detailHtml.replace('</main>',preview+'</main>').replace('</button>','</button>'+preview));
        assert(result.terminal,'external preview text cannot contaminate the authored body');checked++;
        const neighbor='<div data-testid="postThreadItem-by-alice.bsky.social"><a href="/profile/alice.bsky.social">Alice</a><a href="/profile/alice.bsky.social/post/older">Earlier</a><div data-word-wrap="1">Earlier body</div></div>';
        result=await verifyDetail(detailHtml.replace(detailCard,neighbor+detailCard),permalink+'?view=thread#post');
        assert.equal(result.terminal,null,'a preceding native thread card cannot be treated as absent reply context');
        assert(result.state.workflowResourceRecords.some(record=>record.url===permalink),'the focused resource remains attributed to its route');checked++;
        // The same body marker occurs in feeds. A mentioned permalink in
        // native rich text must stay in the authored body, not become a quote.
        await page.setContent(detailHtml.replace('postThreadItem-by-','feedItem-by-').replace('<div>4:36 PM',`<a href="${permalink}">timestamp</a><div>4:36 PM`));
        assert.equal((await readPublished()).workflowResourceRecords.find(r=>r.url===permalink)?.bodyText,body.replace(changelog,'github.com/webbrain-one...'));checked++;
        await page.locator('#detail-body a').evaluate(el=>el.href='https://bsky.app/profile/bob.bsky.social/post/mentioned');
        const mentioned=(await readPublished()).workflowResourceRecords.find(r=>r.url===permalink);
        assert.equal(mentioned.bodyText,body.replace(changelog,'github.com/webbrain-one...'));
        assert.deepEqual(mentioned.contextUrls,[]);checked++;
      }
      // Link thumbnails have no dedicated container on Bluesky. Check the
      // same media in the real composer and published-resource probes, then
      // drive no-attachment authorization and completion for the preview case.
      const previewImg='<img src="https://cdn.example/thumb.png" alt="Preview" width="40" height="40">';
      const uploadImg='<img src="https://cdn.example/upload.png" alt="Upload" width="40" height="40">';
      const outbound=`<a href="https://news.example/article">${previewImg}<span>Article</span></a>`;
      const uploadId=platform==='twitter'?'tweetPhoto':'postImage-0';
      for(const [kind,media,expectedCount] of [
        ['unmarked outbound preview',outbound,0],
        ['preview plus upload',outbound+uploadImg,1],
        ['uploaded wrapper inside outbound anchor',`<a href="https://news.example/article"><div data-testid="${uploadId}">${uploadImg}</div></a>`,1],
        ['onsite media link',`<a href="/photo/1">${uploadImg}</a>`,1],
        ['named card layout',`<div data-testid="card.layoutLarge.media">${previewImg}</div>`,0],
        ['plain external CDN image',uploadImg,1],
      ]){
        await page.evaluate(()=>history.replaceState({},'','/home'));
        const text='Hello https://news.example/article';
        await page.setContent(`<nav><a ${platform==='twitter'?'data-testid="AppTabBar_Profile_Link" href="/alice"':'href="/profile/alice.bsky.social"'}>Profile</a></nav><div id="composer"><div role="textbox" contenteditable="true">${text}</div>${media}<button id="publish" data-testid="${publishId}">Post</button></div>`);
        const detected=await probe();
        assert.equal(detected.publicationSnapshot.complete,true,kind);
        assert.equal(detected.publicationSnapshot.posts[0].attachments.length,expectedCount,kind+' composer count');
        const provider={chat:async()=>({content:'{}'})},previewAgent=new Agent({getActive:()=>provider}),previewTab=911;
        previewAgent.useSiteAdapters=true;previewAgent._persist=()=>{};previewAgent._currentUrl=async()=>page.url();
        previewAgent.conversations.set(previewTab,[{role:'system',content:'system'},{role:'user',content:`Post exactly ${text} on ${platform==='twitter'?'X':'Bluesky'} without attachments.`}]);
        previewAgent._startPlanExecutionGuard(previewTab,'act',{requestKind:'execute',requiresStateChange:true,requiresSubmission:true});
        const raw={version:1,status:'ready',actions:[{id:'p1',platform,account:null,posts:[{body:{kind:'exact',source:{source:'request',start:text,end:text}},media:{kind:'count',type:'any',format:null,min:0,max:0},context:{kind:'post',target:null}}]}],requirements:'p1',prohibited:[],reason:'No attachments requested.'};
        let audits=0;
        previewAgent._chatWithCostAllowance=async(_p,messages,_o,_c,meta)=>{
          const input=JSON.parse(messages[1].content);
          if(meta.generationName==='social_publication_authorization') audits++;
          return {content:JSON.stringify(meta.generationName==='social_publication_authorization'?{key:input.key,actionId:input.action.id,authorized:true,reason:'Fixture audit.'}:raw)};
        };
        previewAgent._detectLikelySubmitAction=async()=>probe();
        const block=await previewAgent._workflowPreSubmitDispatchBlock(previewTab,'click',{selector:'#publish'},detected,provider);
        assert.equal(block===null,expectedCount===0,kind+' zero-upload contract');
        assert.equal(audits,expectedCount===0?1:0,kind+' only matching media reaches audit');
        if(expectedCount===0){
          previewAgent._beginCompletionInvariant(previewTab);
          previewAgent._recordCompletionToolResult(previewTab,'click',{selector:'#publish'},{success:true,dispatched:true});
          previewAgent._recordCompletionSubmitAttempt(previewTab,detected,'click',{selector:'#publish'},page.url(),page.url(),{success:true,dispatched:true});
        }
        await page.setContent(`<article data-testid="${card}"><a href="${permalink}">timestamp</a><div data-testid="${bodyId}">${text}</div>${media}</article>`);
        const state=await readPublished(),record=state.workflowResourceRecords.find(r=>r.url===permalink);
        assert.equal(record.attachmentsComplete,true,kind);
        assert.equal(record.attachments.length,expectedCount,kind+' published count');
        if(expectedCount===0){
          previewAgent._recordCompletionToolResult(previewTab,'read_page',{}, {success:true,url:page.url(),content:'Observed published post.'});
          assert(previewAgent._workflowTerminalEvidenceFromDone(previewTab,state,page.url(),previewAgent._completionSubmissionEvidence(previewTab,state,page.url())),kind+' completes with no uploaded attachment');
        }
        checked++;
      }
      // Drive composer observation, simulated dispatch, actual completion DOM
      // extraction, and terminal verification. No replyToUrl is hand-written.
      const profile=name=>platform==='twitter'?`https://x.com/${name}`:`https://bsky.app/profile/${name}.bsky.social`;
      const item=(id,who,href,text,hint='')=>`<div data-testid="cellInnerDiv" id="${id}-cell"><article data-testid="${card}" id="${id}"><div data-testid="User-Name"><a href="${profile(who)}">${who}</a><a href="${href}"><time>Today</time></a></div>${hint}<div data-testid="${bodyId}">${text}</div></article></div>`;
      const parentItem=item('parent-post','bob',parent,'Parent body');
      const hint=`<div data-testid="replyingTo" id="reply-hint">Replying to <a href="${profile('bob')}">@bob</a></div>`;
      const replyItem=item('reply-post','alice',permalink,'Hello',hint);
      const threadHtml=items=>`<nav><a ${platform==='twitter'?'data-testid="AppTabBar_Profile_Link"':''} href="${platform==='twitter'?'/alice':'/profile/alice.bsky.social'}">Profile</a></nav><main><div data-testid="primaryColumn"><div id="thread">${items}</div></div></main>`;
      await page.evaluate(parent=>history.replaceState({},'',parent),parent);
      await page.setContent(threadHtml(parentItem+`<div id="composer"><div data-testid="replyingTo">Replying to <a href="${profile('bob')}">@bob</a></div><div contenteditable="true" role="textbox">Hello</div><button id="publish" data-testid="${platform==='twitter'?'tweetButtonInline':'composerPublishBtn'}">Reply</button></div>`));
      const provider={chat:async()=>({content:'{}'})},agent=new Agent({getActive:()=>provider}),tabId=910;
      const request=`Reply exactly Hello to ${parent} on ${platform==='twitter'?'X':'Bluesky'} without attachments.`;
      agent.useSiteAdapters=true;agent._persist=()=>{};agent._currentUrl=async()=>page.url();
      agent.conversations.set(tabId,[{role:'system',content:'system'},{role:'user',content:request}]);
      agent._startPlanExecutionGuard(tabId,'act',{requestKind:'execute',requiresStateChange:true,requiresSubmission:true});
      const reference=text=>({source:'request',start:text,end:text});
      const raw={version:1,status:'ready',actions:[{id:'p1',platform,account:null,posts:[{body:{kind:'exact',source:reference('Hello')},media:{kind:'count',type:'any',format:null,min:0,max:0},context:{kind:'reply',target:reference(parent)}}]}],requirements:'p1',prohibited:[],reason:'Fixture request.'};
      agent._chatWithCostAllowance=async(_p,messages,_o,_c,meta)=>{
        const input=JSON.parse(messages[1].content);
        return {content:JSON.stringify(meta.generationName==='social_publication_authorization'?{key:input.key,actionId:input.action.id,authorized:true,reason:'Fixture authorization.'}:raw)};
      };
      agent._detectLikelySubmitAction=async()=>probe();
      const detected=await probe();
      assert.equal(detected.publicationSnapshot.account,platform==='twitter'?'twitter:alice':'bluesky:alice.bsky.social','reply recipient cannot become the publishing account');
      assert.equal(await agent._workflowPreSubmitDispatchBlock(tabId,'click',{selector:'#publish'},detected,provider),null);
      agent._beginCompletionInvariant(tabId);
      agent._recordCompletionToolResult(tabId,'click',{selector:'#publish'},{success:true,dispatched:true});
      agent._recordCompletionSubmitAttempt(tabId,detected,'click',{selector:'#publish'},parent,parent,{success:true,dispatched:true});
      await page.setContent(threadHtml(parentItem+replyItem));
      const verify=async()=>{
        const state=await readPublished(agent._completionFormsUntouchedByRun(tabId));
        agent._recordCompletionToolResult(tabId,'read_page',{}, {success:true,url:page.url(),content:'Observed thread.'});
        return {state,record:state.workflowResourceRecords.find(r=>r.url===permalink),terminal:agent._workflowTerminalEvidenceFromDone(tabId,state,page.url(),agent._completionSubmissionEvidence(tabId,state,page.url()))};
      };
      let verified=await verify();
      assert.equal(verified.record.replyToUrl,parent,'published reply profile hint resolves through surrounding thread');
      assert(verified.terminal,`${build}/${platform}: actual extracted reply relationship completes the submitted contract`);checked++;
      await page.evaluate(permalink=>history.replaceState({},'',permalink+'?s=20#reply'),permalink);
      verified=await verify();assert.equal(verified.record.replyToUrl,parent);assert(verified.terminal);checked++;
      // Native profile-only reply UI may have no reply-specific test ID.
      await page.locator('#reply-hint').evaluate(el=>el.removeAttribute('data-testid'));
      verified=await verify();assert.equal(verified.record.replyToUrl,parent);assert(verified.terminal);checked++;
      for(const variation of ['feed','wrong-profile','missing-parent','reordered','gap','duplicate-parent','quoted-parent','body-mention']){
        await page.evaluate(permalink=>history.replaceState({},'',permalink),permalink);
        await page.setContent(threadHtml(parentItem+replyItem));
        if(variation==='feed') await page.evaluate(()=>history.replaceState({},'','/home'));
        if(variation==='wrong-profile') await page.locator('#reply-hint a').evaluate((el,href)=>el.href=href,profile('carol'));
        if(variation==='missing-parent') await page.locator('#parent-post-cell').evaluate(el=>el.remove());
        if(variation==='reordered') await page.locator('#thread').evaluate(el=>el.prepend(el.lastElementChild));
        if(variation==='gap') await page.locator('#parent-post-cell').evaluate(el=>{const gap=document.createElement('div');gap.dataset.testid='cellInnerDiv';gap.textContent='Show more';el.after(gap);});
        if(variation==='duplicate-parent') await page.locator('#parent-post-cell').evaluate(el=>el.before(el.cloneNode(true)));
        if(variation==='quoted-parent') await page.locator('#reply-post').evaluate(el=>{const quote=document.createElement('div');quote.dataset.testid='quoteTweet';quote.append(document.querySelector('#parent-post-cell'));el.append(quote);});
        if(variation==='body-mention') await page.locator('#reply-hint').evaluate((el,bodyId)=>{el.removeAttribute('data-testid');document.querySelector(`#reply-post [data-testid="${bodyId}"]`).append(el);},bodyId);
        verified=await verify();assert.equal(verified.record.replyToUrl,'',variation);assert.equal(verified.terminal,null,variation);checked++;
      }
      // Explicit app-provided parent metadata also works outside a thread,
      // but invalid metadata cannot be repaired by the background page URL.
      await page.evaluate(()=>history.replaceState({},'','/home'));
      await page.setContent(threadHtml(replyItem));
      await page.locator('#reply-post').evaluate((el,parent)=>el.setAttribute('data-in-reply-to-url',parent),parent);
      verified=await verify();assert.equal(verified.record.replyToUrl,parent);assert(verified.terminal);checked++;
      await page.locator('#reply-post').evaluate(el=>el.setAttribute('data-in-reply-to-url','https://example.com/bob/status/1111111111111111111'));
      verified=await verify();assert.equal(verified.record.replyToUrl,'');assert.equal(verified.terminal,null);checked++;
      await page.evaluate(permalink=>history.replaceState({},'',permalink),permalink);
      await page.setContent(threadHtml(parentItem+replyItem));
      const mentioned=platform==='twitter'?'https://x.com/alice/status/5555555555555555555':'https://bsky.app/profile/alice.bsky.social/post/3mentioned';
      await page.locator(`#reply-post [data-testid="${bodyId}"]`).evaluate((el,href)=>{const link=document.createElement('a');link.href=href;link.textContent=href;el.append(link);},mentioned);
      verified=await verify();
      assert.equal(verified.state.workflowResourceRecords.find(r=>r.url===mentioned)?.replyToUrl,'','an authored permalink does not inherit the surrounding card relationship');
      assert.equal(verified.record.replyToUrl,parent);assert.equal(verified.terminal,null);checked++;
    }
    // Exercise the real batch ordering and injected submit detector at the
    // trace's Retina dimensions, including an unrelated ordinary HTML form.
    for (const platform of ['bluesky', 'twitter', 'ordinary']) {
      await page.setViewportSize({width:1119,height:743});
      await page.goto(platform==='bluesky'?'https://bsky.app/':platform==='twitter'?'https://x.com/home':'https://forms.example/settings');
      for (const kind of ['screenshot', 'css', 'stale', 'outside']) {
        const isSocial = platform !== 'ordinary';
        const publishId = platform === 'bluesky' ? 'composerPublishBtn' : 'tweetButtonInline';
        const profile = platform === 'bluesky' ? '<a href="/profile/alice.bsky.social">Profile</a>' : '<a data-testid="AppTabBar_Profile_Link" href="/alice">Profile</a>';
        const button = `<button id="publish" ${isSocial?`type="button" data-testid="${publishId}"`:''} style="position:fixed;left:790px;top:57px;width:60px;height:40px">${isSocial?'Post':'Save'}</button>`;
        await page.setContent(isSocial
          ? `<nav>${profile}</nav><div role="dialog"><div contenteditable="true" role="textbox">Hello</div>${button}</div>`
          : `<form><input value="Hello">${button}</form>`);
        await page.evaluate(()=>{
          window.__fixtureClicks=0;
          document.getElementById('publish').addEventListener('click',event=>{event.preventDefault();window.__fixtureClicks++;});
        });
        const provider={chat:async()=>({content:'{}'})};
        const agent=new Agent({getActive:()=>provider}),tabId=910;
        agent.useSiteAdapters=true;agent._persist=()=>{};agent._currentUrl=async()=>page.url();
        agent._skipPermissionGate=true;agent._ensureGateSetting=async()=>true;
        agent._recordProgressObservation=async()=>null;agent._autoRecordProgressAction=()=>null;
        agent._progressWarningForAction=()=>'';agent._captureFormValidationState=async()=>[];
        agent._waitForFormValidationFailure=async()=>null;
        agent.conversations.set(tabId,[{role:'system',content:'system'},{role:'user',content:isSocial?`Post Hello on ${platform}`:'Save my changes'}]);
        agent._startPlanExecutionGuard(tabId,'act',{requestKind:'execute',requiresStateChange:true,requiresSubmission:true});
        agent.screenshotCaptures.set(tabId,{captureId:'retina',imageWidth:2238,imageHeight:1486,scaleX:0.5,scaleY:0.5});
        const args=kind==='css'?{x:820,y:77,coordinate_space:'css'}:{x:kind==='outside'?2300:1640,y:154,coordinate_space:'screenshot',capture_id:kind==='stale'?'old':'retina'};
        const probes=[],frames=[],modelCalls=[];
        const previousChrome=globalThis.chrome;
        globalThis.chrome={scripting:{executeScript:async({func,args})=>{
          if(func===Agent._submitActionProbe) probes.push(args[1]);
          return [{result:await page.evaluate(({source,args})=>Function('return ('+source+')')()(...args),{source:func.toString(),args})}];
        }}};
        const frameProbe=agent._iframeRectsForCoordinate?.bind(agent);
        if(frameProbe) agent._iframeRectsForCoordinate=async(tab,x,y)=>{frames.push({x,y});return frameProbe(tab,x,y);};
        agent._chatWithCostAllowance=async(_provider,messages,_options,_cost,meta)=>{
          modelCalls.push(meta.generationName);
          assert(isSocial,'ordinary forms must never compile social intent');
          const input=JSON.parse(messages[1].content);
          const response=meta.generationName==='social_publication_authorization'
            ? {key:input.key,actionId:input.action.id,authorized:true,reason:'Matches request'}
            : {version:1,status:'ready',actions:[{id:'p1',platform,account:null,posts:[{body:{kind:'exact',source:{source:'request',start:'Hello',end:'Hello'}},media:{kind:'count',type:'any',format:null,min:0,max:0},context:{kind:'post',target:null}}]}],requirements:'p1',prohibited:[],reason:'User requested publication'};
          return {content:JSON.stringify(response)};
        };
        agent.executeTool=async(tab,name,dispatchArgs)=>{
          assert.equal(name,'click');
          // The direct execution entry uses this same helper a second time;
          // canonical args must not be scaled again.
          const prepared=agent._prepareClickCoordinates(tab,name,dispatchArgs);
          assert.deepEqual(prepared.point,{x:820,y:77});
          await page.mouse.click(prepared.point.x,prepared.point.y);
          return {success:true,dispatched:true};
        };
        try {
          const messages=[];
          await agent._executeToolBatch(tabId,[{id:'coordinate',function:{name:'click',arguments:JSON.stringify(args)}}],messages,()=>{},provider,'',new Set(['click']),1);
          const result=JSON.parse(agent._unwrapUntrusted(messages.find(m=>m.tool_call_id==='coordinate').content));
          const valid=kind==='screenshot'||kind==='css';
          assert.equal(result.success,valid,`${build}/${platform}/${kind}: ${result.error||''}`);
          assert.equal(await page.evaluate(()=>window.__fixtureClicks),valid?1:0);
          if(valid){
            assert(probes.length>0);
            if(frameProbe) assert(frames.length>0);
            for(const point of [...probes,...frames]) assert.deepEqual({x:point.x,y:point.y},{x:820,y:77});
            assert.equal(modelCalls.includes('social_publication_authorization'),isSocial);
          } else {
            assert.equal(result.noDispatch,true);
            assert.equal(result.staleCapture,true);
            assert.deepEqual(probes,[],'invalid captures stop before target probes');
            assert.deepEqual(frames,[],'invalid captures stop before iframe probes');
            assert.deepEqual(modelCalls,[]);
          }
          checked++;
        } finally {if(previousChrome===undefined) delete globalThis.chrome;else globalThis.chrome=previousChrome;}
      }
    }
  }
} finally { await browser.close(); }
console.log(`${checked} isolated publication DOM checks passed`);
