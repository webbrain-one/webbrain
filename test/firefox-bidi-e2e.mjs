import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { BidiSession } from '../firefox-companion/session.mjs';
import { nativeReplyMessages } from '../firefox-companion/native-messages.mjs';
const temporaryRoot = await realpath(tmpdir());
const profilePrefix = 'webbrain-firefox-test-';
const profile = await mkdtemp(join(temporaryRoot, profilePrefix));
const assertOwnedProfile = async () => {
  const resolved = await realpath(profile);
  const equal = (left, right) => process.platform === 'win32'
    ? left.toLowerCase() === right.toLowerCase() : left === right;
  assert.ok(equal(dirname(resolved), temporaryRoot) && basename(resolved).startsWith(profilePrefix),
    'Firefox cleanup must remain inside its owned temporary profile prefix.');
  return resolved;
};
await assertOwnedProfile();
const artifacts = resolve(process.env.WEBBRAIN_QUALITY_ARTIFACTS || 'ci/artifacts/quality-audit-2026-10-07/firefox-bidi-actual');
await mkdir(artifacts, { recursive: true });
await writeFile(join(profile, 'user.js'), `user_pref("browser.download.folderList", 2); user_pref("browser.download.dir", ${JSON.stringify(profile)}); user_pref("browser.download.useDownloadDir", true);`);
if (process.env.FIREFOX_TEST_DPR) await writeFile(join(profile, 'user.js'), `user_pref("layout.css.devPixelsPerPx", ${JSON.stringify(process.env.FIREFOX_TEST_DPR)});\n`, { flag: 'a' });
const server = createServer(async (_req, res) => {
  if (_req.url === '/native-capture' && _req.method === 'POST') {
    let body = '';
    for await (const chunk of _req) body += chunk;
    const message = JSON.parse(body);
    try {
      const result = message.command === 'connect' ? { connected: true }
        : message.command === 'captureFullPage' ? await session.captureFullPage(message.token, message.url)
          : (() => { throw new Error('Unexpected test command'); })();
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify([...nativeReplyMessages({ id: message.id, result })]));
    } catch (error) { res.end(JSON.stringify([{ id: message.id, error: error.message }])); }
    return;
  }
  if (_req.url === '/messages/') {
    res.setHeader('Content-Type', 'text/html');
    res.end(`<!doctype html><main style="height:90vh;display:flex;flex-direction:column;justify-content:space-between">
      <header><h1>Different recipient</h1></header><footer>
      <div id="draft" role="textbox" contenteditable="true" aria-label="Message">Test message</div>
      <button id="send" aria-label="Send">Send</button></footer></main>
      <script>const actions = [];
        const record = action => { actions.push(action); document.documentElement.dataset.actions = JSON.stringify(actions); };
        draft.focus();
        send.onclick = () => { record('Send'); draft.focus(); };
        draft.onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); record('Enter'); } };
      </script>`);
    return;
  }
  res.setHeader('Content-Type', 'text/html');
  res.end(`<button id="click">Click</button><input id="text"><input id="file" type="file"><script>
    window.events=[]; document.addEventListener('click',e=>events.push(['click',e.isTrusted]));
    document.addEventListener('input',e=>events.push(['input',e.isTrusted]));
    document.querySelector('#click').onclick=()=>{window.answer=confirm('Continue?')};
  </script>`);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${server.address().port}/`;
const firefox = spawn(process.env.FIREFOX_BINARY || (process.platform === 'darwin' ? '/Applications/Firefox.app/Contents/MacOS/firefox' : 'firefox'), ['--headless', '--remote-allow-system-access', '--no-remote', '--profile', profile, '--remote-debugging-port', '0'], {
  env: { ...process.env, MOZ_REMOTE_ALLOW_SYSTEM_ACCESS: '1' }, stdio: ['ignore', 'pipe', 'pipe'],
});
let session;
try {
  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Firefox did not start BiDi')), 20000);
    let output = '';
    firefox.stderr.on('data', data => { output += data; const match = output.match(/WebDriver BiDi listening on ws:\/\/127\.0\.0\.1:(\d+)/); if (match) { clearTimeout(timer); resolve(Number(match[1])); } });
    firefox.on('error', reject);
  });
  session = new BidiSession();
  await session.connect(port);
  await session.send('webExtension.install', { extensionData: { type: 'path', path: fileURLToPath(new URL('../src/firefox/', import.meta.url)) } });
  const { context } = await session.send('browsingContext.create', { type: 'tab' });
  await session.send('browsingContext.navigate', { context, url, wait: 'complete' });
  const evaluate = async expression => (await session.send('script.evaluate', { target: { context }, expression, awaitPromise: true })).result;
  const mark = async selector => {
    const token = crypto.randomUUID();
    await evaluate(`document.querySelector(${JSON.stringify(selector)}).setAttribute('data-webbrain-bidi', ${JSON.stringify(token)})`);
    return { token, url };
  };
  const runId = crypto.randomUUID();
  const binding = await mark('html'); await session.openRun(runId, binding.token, binding.url);
  assert.equal((await session.perform(runId, 'click', await mark('#click'))).success, true);
  assert.equal((await evaluate('window.answer')).value, false, 'unapproved confirm must be dismissed');
  assert.equal((await evaluate('events.some(e => e[0] === "click" && e[1])')).value, true);
  await evaluate(`document.querySelector('#click').onclick=()=>{window.answer=prompt('Input?')}`);
  await session.perform(runId, 'click', await mark('#click'));
  assert.equal((await evaluate('window.answer')).type, 'null');
  await evaluate(`document.querySelector('#click').onclick=()=>{alert('Notice');window.acknowledged=true}`);
  await session.perform(runId, 'click', await mark('#click'));
  assert.equal((await evaluate('window.acknowledged')).value, true);
  const typed = await session.perform(runId, 'field', { ...await mark('#text'), text: 'Hello Firefox', clear: true });
  assert.equal(typed.verified, true);
  assert.equal((await evaluate('document.querySelector("#text").value')).value, 'Hello Firefox');
  await evaluate(`document.querySelector('#text').setSelectionRange(1, 1)`);
  const appended = await session.perform(runId, 'type', { ...await mark('#text'), text: ' world' });
  assert.equal(appended.verified, true);
  assert.equal((await evaluate('document.querySelector("#text").value')).value, 'Hello Firefox world');
  assert.equal((await evaluate('events.some(e => e[0] === "input" && e[1])')).value, true);
  const uploaded = await session.perform(runId, 'upload', { ...await mark('#file'), filename: 'sample.txt', base64: Buffer.from('upload test').toString('base64') });
  assert.equal(uploaded.success, true);
  assert.equal((await evaluate('document.querySelector("#file").files[0].text()')).value, 'upload test');
  const tree = await session.send('browsingContext.getTree', {});
  const extensionContext = tree.contexts.find(item => item.url?.startsWith('moz-extension://'));
  assert.ok(extensionContext, 'installed extension opens onboarding');
  const extensionOrigin = new URL(extensionContext.url).origin === 'null' ? extensionContext.url.split('/').slice(0, 3).join('/') : new URL(extensionContext.url).origin;
  const extensionEval = async expression => {
    const result = await session.send('script.evaluate', { target: { context: extensionContext.context }, expression, awaitPromise: true });
    if (result.type === 'exception') throw new Error(result.exceptionDetails.text.replace(/data:image[^\s)]+/g, '[image omitted]').slice(0, 600));
    return result.result;
  };
  // Run the installed extension's actual recipient check and input transport
  // against the same local message page before and after using Settings.
  const messageUrl = url + 'messages/';
  const chatTab = (await extensionEval(`browser.tabs.create({url:${JSON.stringify(messageUrl)}}).then(tab => tab.id)`)).value;
  const prefs = await session.send('browsingContext.create', { type: 'tab' });
  await session.send('browsingContext.navigate', { context: prefs.context, url: extensionOrigin + '/src/ui/settings.html', wait: 'complete' });
  const checkPreference = async enabled => {
    const event = await session.send('script.callFunction', { target: { context: prefs.context }, awaitPromise: true,
      arguments: [{ type: 'boolean', value: enabled }], functionDeclaration: (async value => {
        document.querySelector('[data-tab="advanced"]').click();
        const input = document.getElementById('toggle-enforce-action-guards');
        if (input.checked !== value) input.click();
        for (let i = 0; i < 50; i++) {
          const stored = await browser.storage.local.get('enforceActionGuards');
          if ((stored.enforceActionGuards !== false) === value) return input.checked;
          await new Promise(resolve => setTimeout(resolve, 20));
        }
        throw new Error('Settings did not persist the preference');
      }).toString() });
    assert.equal(event.result?.value, enabled);
  };
  const exerciseSend = async (tab, messageUrl) => {
    const { Agent } = await import(browser.runtime.getURL('src/agent/agent.js'));
    const agent = new Agent({ getActive: () => null });
    agent.enforceActionGuards = (await browser.storage.local.get('enforceActionGuards')).enforceActionGuards !== false;
    agent._beginLeanRun(tab, 'act');
    agent._planExecutionGuards.set(tab, { requiresSubmission: true, requiresStateChange: true,
      messaging: { target_kind: 'named', recipients: ['Requested recipient'] } });
    await browser.tabs.update(tab, { active: true });
    await browser.tabs.executeScript(tab, { code: "document.getElementById('draft').focus()" });
    const outcomes = [];
    for (const [tool, args] of [['click', { selector: '#send' }], ['press_keys', { key: 'Enter' }]]) {
      const context = {};
      const blocked = await agent._messageRecipientGuardBlock(tab, tool, args, messageUrl, context);
      if (blocked) outcomes.push(blocked.messageRecipientGuard === true && blocked.noDispatch === true ? 'guarded' : blocked.error);
      else {
        const result = await agent.executeTool(tab, tool, args, null, context);
        outcomes.push(result.success === true ? 'dispatched' : result.error);
      }
    }
    const [actions] = await browser.tabs.executeScript(tab, { code: "document.documentElement.dataset.actions || '[]'" });
    return JSON.stringify({ outcomes, actions: JSON.parse(actions) });
  };
  const actualActions = [];
  for (const enabled of [true, false, true]) {
    await checkPreference(enabled);
    const result = JSON.parse((await extensionEval(`(${exerciseSend})(${chatTab},${JSON.stringify(messageUrl)})`)).value);
    assert.deepEqual(result.outcomes, enabled ? ['guarded', 'guarded'] : ['dispatched', 'dispatched']);
    if (!enabled) actualActions.push('Send', 'Enter');
    assert.deepEqual(result.actions, actualActions);
  }
  await extensionEval(`browser.tabs.remove(${chatTab})`);
  await session.send('browsingContext.close', { context: prefs.context });
  console.log('PASS: Firefox Advanced action guards blocked Send and Enter, allowed both when off, and blocked both again when re-enabled.');
  const tabId = (await extensionEval(`browser.tabs.query({}).then(tabs => tabs.find(tab => tab.url === ${JSON.stringify(url)}).id)`)).value;
  await evaluate(`document.body.insertAdjacentHTML('beforeend','<canvas id="point-canvas" style="position:fixed;left:10px;top:200px;width:300px;height:60px"></canvas>'); document.querySelector('#point-canvas').onclick=e=>window.clickedPoint={x:e.clientX,y:e.clientY,trusted:e.isTrusted};`);
  const pointToken = crypto.randomUUID();
  const pointResponse = await extensionEval(`browser.tabs.sendMessage(${tabId}, {target:'content',action:'click',params:{x:22,y:210,coordinate_space:'css',_bidiPrepare:${JSON.stringify(pointToken)}}}).then(value=>JSON.stringify(value))`);
  const pointPrepared = JSON.parse(pointResponse.value);
  assert.deepEqual(pointPrepared.point,{x:22,y:210});
  await session.perform(runId,'click',{token:pointToken,url,point:pointPrepared.point});
  assert.deepEqual(JSON.parse((await evaluate('JSON.stringify(window.clickedPoint)')).value),{x:22,y:210,trusted:true});
  await evaluate(`document.body.insertAdjacentHTML('beforeend', '<input id="checkable" type="checkbox"><input id="blocked-checkable" type="checkbox"><input id="delayed-checkable" type="checkbox">'); document.querySelector('#blocked-checkable').onclick=event=>event.preventDefault(); document.querySelector('#delayed-checkable').addEventListener('click',event=>{event.preventDefault();setTimeout(()=>{const input=document.querySelector('#delayed-checkable');input.checked=true;input.dispatchEvent(new Event('input',{bubbles:true}));input.dispatchEvent(new Event('change',{bubbles:true}));},25);},{once:true});`);
  const checked = await session.perform(runId, 'click', {
    ...await mark('#checkable'),
    checkable: { inputType: 'checkbox', checkedBefore: false, desiredChecked: true, checkboxIdentity: 'checkable' },
  });
  assert.equal(checked.success, true);
  assert.equal(checked.verified, true);
  assert.equal(checked.checkedAfter, true);
  assert.equal(checked._checkableObservationMs, 0, 'already-observed check state should not wait out the old 80ms delay');
  const delayedChecked = await session.perform(runId, 'click', {
    ...await mark('#delayed-checkable'),
    checkable: { inputType: 'checkbox', checkedBefore: false, desiredChecked: true, checkboxIdentity: 'delayed-checkable' },
  });
  assert.equal(delayedChecked.success, true);
  assert.equal(delayedChecked.verified, true);
  assert.ok(delayedChecked._checkableObservationMs >= 10, 'the test should wait for the delayed state event');
  assert.ok(delayedChecked._checkableObservationMs < 80, 'the change event should wake the observer before the timeout');
  const blockedCheck = await session.perform(runId, 'click', {
    ...await mark('#blocked-checkable'),
    checkable: { inputType: 'checkbox', checkedBefore: false, desiredChecked: true, checkboxIdentity: 'blocked-checkable' },
  });
  assert.equal(blockedCheck.success, false);
  assert.equal(blockedCheck.verified, false);
  assert.equal(blockedCheck.noProgress, true);
  await evaluate(`document.body.style.minHeight='3000px'; document.body.insertAdjacentHTML('beforeend', '<button id="below-fold" style="position:absolute;top:2600px">Below fold</button>'); document.querySelector('#below-fold').onclick=e=>window.belowFoldTrusted=e.isTrusted;`);
  const belowFoldToken = crypto.randomUUID();
  const belowFoldPrepared = await extensionEval(`browser.tabs.sendMessage(${tabId}, {target:'content',action:'click',params:{selector:'#below-fold',_bidiPrepare:${JSON.stringify(belowFoldToken)}}}).then(value=>JSON.stringify(value))`);
  assert.equal(JSON.parse(belowFoldPrepared.value).bidiPrepared, true);
  assert.equal((await session.perform(runId, 'click', { token: belowFoldToken, url })).success, true);
  assert.equal((await evaluate('window.belowFoldTrusted')).value, true);
  // Capture the complete document from a scrolled viewport. A noisy canvas
  // makes the PNG exceed the native messaging limit so the chunk path runs.
  await evaluate(`(() => {
    const canvas=document.createElement('canvas'); canvas.id='capture-noise'; canvas.width=1000; canvas.height=450;
    const ctx=canvas.getContext('2d'), pixels=ctx.createImageData(canvas.width,canvas.height);
    let seed=123; for(let i=0;i<pixels.data.length;i+=4){seed=(Math.imul(seed,1664525)+1013904223)>>>0;pixels.data[i]=seed&255;pixels.data[i+1]=(seed>>>8)&255;pixels.data[i+2]=(seed>>>16)&255;pixels.data[i+3]=255;}
    ctx.putImageData(pixels,0,0); document.body.append(canvas);
    document.body.insertAdjacentHTML('beforeend','<input id="capture-private" value="private fixture value" style="position:absolute;top:2750px;left:20px;width:200px"><div id="capture-footer" style="position:absolute;top:2900px;left:20px;width:200px;height:50px;background:rgb(17,119,51)">FULL PAGE FOOTER</div>');
  })()`);
  const fullPage = JSON.parse((await extensionEval(`(async () => {
    const {firefoxBidi} = await import(${JSON.stringify(extensionOrigin + '/src/bidi/client.js')});
    const {Agent} = await import(${JSON.stringify(extensionOrigin + '/src/agent/agent.js')});
    let transferredChunks=0;
    firefoxBidi.apiOverride = { tabs:browser.tabs, storage:browser.storage, runtime:{ connectNative() {
      let receive;
      return { onMessage:{addListener(fn){receive=fn}}, onDisconnect:{addListener(){}}, disconnect(){},
        postMessage(message) { fetch(${JSON.stringify(url + 'native-capture')},{method:'POST',body:JSON.stringify(message)}).then(r=>r.json()).then(messages=>{transferredChunks+=messages.filter(m=>typeof m.chunk==='string').length;messages.forEach(receive)}); }
      };
    }}};
    await browser.storage.local.set({firefoxBidiEnabled:true});
    const agent=new Agent({getActive:()=>null}); agent.screenshotRedaction=true;
    const capture=await agent.captureFullPageScreenshotForUser(${tabId});
    if(!capture.ok) throw new Error(capture.error);
    const image=await createImageBitmap(await (await fetch(capture.dataUrl)).blob());
    const canvas=new OffscreenCanvas(image.width,image.height); const ctx=canvas.getContext('2d');ctx.drawImage(image,0,0);
    const scale=image.width/capture.captureBounds.width;
    const footerPixel=[...ctx.getImageData(Math.round(30*scale),Math.round(2940*scale),1,1).data];
    const redacted=await agent._redactScreenshotDataUrl(${tabId},capture.dataUrl,{coordinateSpace:'page',redactionSnapshot:capture.redactionSnapshot,capturedCssBounds:capture.captureBounds});
    const {saveScreenshot}=await import(${JSON.stringify(extensionOrigin + '/src/ui/screenshot-download.js')});
    const downloadId=await saveScreenshot(capture.dataUrl,'webbrain-bidi-test.png',{saveAs:false});
    let download; for(let attempt=0;attempt<100;attempt++){[download]=await browser.downloads.search({id:downloadId});if(download.state==='complete')break;await new Promise(resolve=>setTimeout(resolve,20));}
    if(download.state!=='complete')throw new Error('Screenshot download did not complete');
    await browser.downloads.removeFile(downloadId); await browser.downloads.erase({id:downloadId});
    const result={...capture,width:image.width,height:image.height,footerPixel,transferredChunks,redacted:redacted!==capture.dataUrl,saved:download.filename.endsWith('webbrain-bidi-test.png')};
    image.close(); firefoxBidi.disconnect(); firefoxBidi.apiOverride=undefined;
    await browser.storage.local.set({firefoxBidiEnabled:false});
    return JSON.stringify(result);
  })()`)).value);
  assert.equal(fullPage.redactionSnapshotReady, true, 'full-page privacy scan should be available');
  assert.equal(fullPage.redactionUnavailable, undefined);
  assert.ok(fullPage.redactionSnapshot.regions.some(region => region.rect.y > 2700), 'privacy scan covers fields below the viewport');
  assert.ok(fullPage.height >= 3000);
  if (process.env.FIREFOX_TEST_DPR) assert.ok(Math.abs(fullPage.width / fullPage.captureBounds.width - Number(process.env.FIREFOX_TEST_DPR)) < 0.01, 'full-page bounds use CSS pixels at high DPI');
  assert.ok(fullPage.transferredChunks > 1, 'large PNG uses chunked native replies');
  assert.deepEqual(fullPage.footerPixel, [17,119,51,255], 'image contains the document footer');
  assert.equal(fullPage.redacted, true, 'model-facing image redacts sensitive regions');
  assert.equal(fullPage.saved, true, 'captured PNG can be saved through Firefox downloads');
  assert.equal(session.runs.has(runId), true, 'standalone capture preserves active automation');
  console.log(`PASS: full-page PNG ${fullPage.width}x${fullPage.height}, ${fullPage.transferredChunks} native chunks, footer pixels, below-fold privacy and local save`);
  await writeFile(join(artifacts, 'webbrain3-firefox-full-page.png'), Buffer.from(fullPage.dataUrl.split(',')[1], 'base64'));
  await evaluate(`document.querySelector('#capture-noise').remove();document.querySelector('#capture-private').remove();document.querySelector('#capture-footer').remove();`);
  await evaluate(`document.activeElement.blur()`);
  assert.equal((await session.perform(runId, 'key', { ...await mark('body'), key: 'Escape' })).success, true);
  const shadowToken = crypto.randomUUID();
  await evaluate(`const host=document.createElement('div'); host.id='shadow-host'; host.style.cssText='position:fixed;left:20px;top:100px'; host.attachShadow({mode:'open'}).innerHTML='<button id="shadow-button">Shadow button</button>'; host.shadowRoot.querySelector('button').setAttribute('data-webbrain-bidi', ${JSON.stringify(shadowToken)}); host.shadowRoot.querySelector('button').onclick=e=>window.shadowTrusted=e.isTrusted; document.body.append(host);`);
  const shadowNode = await session.send('script.evaluate', { target: { context }, expression: "document.querySelector('#shadow-host').shadowRoot.querySelector('#shadow-button')", awaitPromise: true });
  const locate = session.locate;
  session.locate = async () => ({ context, node: { sharedId: shadowNode.result.sharedId } });
  assert.equal((await session.perform(runId, 'click', { token: shadowToken, url })).success, true);
  session.locate = locate;
  assert.equal((await evaluate('window.shadowTrusted')).value, true);
  const obscured = await mark('#point-canvas');
  await evaluate(`document.body.insertAdjacentHTML('beforeend','<div id="point-cover" style="position:fixed;left:20px;top:205px;width:10px;height:10px;background:red;z-index:99999"></div>')`);
  await assert.rejects(session.perform(runId,'click',{...obscured,point:{x:22,y:210}}), error=>error.dispatchState.noDispatch===true && /covered/.test(error.message));
  await evaluate(`document.querySelector('#point-canvas').remove();document.querySelector('#point-cover').remove()`);
  const token = crypto.randomUUID();
  const prepared = await extensionEval(`browser.tabs.sendMessage(${tabId}, {target:'content', action:'type', params:{selector:'#text', text:'Through extension', clear:true, _bidiPrepare:${JSON.stringify(token)}}}).then(value => JSON.stringify(value))`);
  assert.equal(JSON.parse(prepared.value).bidiPrepared, true, 'packaged content script prepares a target');
  assert.equal((await session.perform(runId, 'type', { token, url, text: 'Through extension', clear: true })).verified, true);
  // A newline is literal editing, never an Enter-to-send shortcut.
  await evaluate(`document.body.insertAdjacentHTML('beforeend', '<textarea id="multiline"></textarea><input id="other">'); window.enters=0; document.addEventListener('keydown', e=>{if(e.key==='Enter'){window.enters++;e.preventDefault()}});`);
  const multiline = await session.perform(runId, 'field', { ...await mark('#multiline'), text: 'first\nsecond', clear: true, submit: false });
  assert.equal(multiline.verified, true);
  assert.equal((await evaluate('window.enters')).value, 0);
  await assert.rejects(session.perform(runId, 'field', { ...await mark('#text'), text: 'first\nsecond', clear: true, submit: false }), /multiline/);
  assert.equal((await evaluate('document.querySelector("#text").value')).value, 'Through extension');
  // Focus handlers must not redirect a secret into another input.
  await evaluate(`document.querySelector('#other').focus(); document.querySelector('#text').onfocus=()=>document.querySelector('#other').focus();`);
  await assert.rejects(session.perform(runId, 'field', { ...await mark('#text'), text: 'private payload', clear: true }), /Target|Focus/);
  assert.equal((await evaluate('document.querySelector("#other").value')).value, '');
  await evaluate(`document.querySelector('#text').onfocus=null;`);
  await evaluate(`document.querySelector('#text').oninput=()=>{if(document.querySelector('#text').value==='ready')document.querySelector('#other').focus()};`);
  await assert.rejects(session.perform(runId, 'field', { ...await mark('#text'), text: 'ready', clear: true, submit: true }), /Focus changed/);
  assert.equal((await evaluate('window.enters')).value, 0);
  await evaluate(`document.querySelector('#text').oninput=null; document.body.insertAdjacentHTML('beforeend','<div id="rich" contenteditable="true" style="width:300px;height:80px;border:1px solid"></div>');`);
  assert.equal((await session.perform(runId, 'field', { ...await mark('#rich'), text: 'first\nsecond', clear: true, submit: false })).verified, true);
  assert.equal((await evaluate('window.enters')).value, 0);

  // Invoke the real client in the packaged extension with a transport stub; no
  // native manifest is installed in the user's normal Firefox configuration.
  await session.perform(runId, 'key', { ...await mark('#text'), key: 'Tab', repeat: 2 });
  assert.equal((await evaluate('document.activeElement.id')).value, 'checkable');
  const deferred = await extensionEval(`(async () => {
    const {FirefoxBidiClient} = await import(${JSON.stringify(extensionOrigin + '/src/bidi/client.js')});
    const client = new FirefoxBidiClient(browser);
    client.connect = async () => ({});
    const calls = []; client.request = async (command) => { calls.push(command); return {}; };
    await browser.storage.local.set({firefoxBidiEnabled:true});
    const blank = await browser.tabs.create({url:'about:blank'});
    await client.startRun(blank.id);
    const initial = client.runs.get(blank.id).bound === true;
    await client.perform(blank.id, 'navigate', {url:${JSON.stringify(url)}});
    await new Promise(resolve => setTimeout(resolve, 500));
    await client.bindRun(blank.id, client.runs.get(blank.id));
    const bound = client.runs.get(blank.id).bound;
    client.stopRun(blank.id); await browser.tabs.remove(blank.id);
    await browser.storage.local.set({firefoxBidiEnabled:false});
    return JSON.stringify({initial,bound,calls});
  })()`);
  const deferredResult = JSON.parse(deferred.value);
  assert.equal(deferredResult.initial, false);
  assert.equal(deferredResult.bound, true);
  assert.ok(deferredResult.calls.includes('openRun'));
  const settings = await session.send('browsingContext.create', { type: 'tab' });
  await session.send('browsingContext.navigate', { context: settings.context, url: extensionOrigin + '/src/ui/settings.html', wait: 'complete' });
  await session.send('script.evaluate', { target: { context: settings.context }, expression: "(async () => { document.querySelector('[data-tab=advanced]').click(); await new Promise(r => setTimeout(r, 500)); document.getElementById('firefox-bidi-card').scrollIntoView({behavior:'instant', block:'center'}); await new Promise(r => setTimeout(r, 250)); })()", awaitPromise: true });
  const screenshot = await extensionEval(`browser.tabs.query({}).then(tabs => browser.tabs.captureTab(tabs.find(tab => tab.url.endsWith('/src/ui/settings.html')).id, {format:'png'}))`);
  await writeFile(join(artifacts, 'webbrain3-firefox-bidi-settings.png'), Buffer.from(screenshot.value.split(',')[1], 'base64'));
  await evaluate(`window.addEventListener('beforeunload', event => { event.preventDefault(); event.returnValue = ''; })`);
  assert.equal((await session.perform(runId, 'navigate', { url: url + 'next' })).success, true);
  assert.equal((await evaluate('location.href')).value, url + 'next');
  await session.closeRun(runId);
  // Remember an idle tab's dialog, but handle it only once a run owns that tab.
  await session.send('browsingContext.navigate', {context, url, wait:'complete'});
  const bind = await mark('html');
  const opened = new Promise(resolve => {
    const receive = session.receive.bind(session);
    session.receive = message => { receive(message); if (message.method === 'browsingContext.userPromptOpened') resolve(); };
  });
  await evaluate('setTimeout(()=>alert("Pending notice"),0)'); await opened;
  assert.ok(session.dialogs.has(context));
  const resumed = crypto.randomUUID();
  await session.openRun(resumed, bind.token, bind.url);
  assert.equal(session.dialogs.has(context), false);
  assert.equal((await session.perform(resumed, 'field', { ...await mark('#text'), text: 'resumed', clear: true })).verified, true);
  // Stop after the first real text key command has been sent. At most that
  // single in-flight character may land; the rest must never be queued.
  const originalSend = session.send.bind(session); let stopped = false;
  session.send = (method, params) => {
    const result = originalSend(method, params);
    if (method === 'input.performActions' && !stopped) {
      stopped = true; void session.closeRun(resumed);
    }
    return result;
  };
  await assert.rejects(session.perform(resumed, 'type', { ...await mark('#text'), text: 'a'.repeat(500) }), /stopped/);
  const afterStop = (await evaluate('document.querySelector("#text").value')).value;
  assert.ok(afterStop.length <= 'resumed'.length + 1, afterStop);
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal((await evaluate('document.querySelector("#text").value')).value, afterStop);
  await assert.rejects(session.perform(resumed, 'click', await mark('#click')), /stopped|disconnected/);
  console.log(`PASS: Firefox full-page screenshots, chunked PNG transfer, below-fold privacy, local PNG save, connection, dialogs, uploads, literal newlines, focus guards, interrupted typing, deferred blank-tab binding, and packaged extension integration; checkable state event woke in ${delayedChecked._checkableObservationMs}ms (80ms cap)`);
} finally {
  await session?.close().catch(() => {});
  firefox.kill('SIGTERM');
  await new Promise(resolve => { if (firefox.exitCode != null) resolve(); else { firefox.once('exit', resolve); setTimeout(resolve, 3000); } });
  server.close();
  const ownedProfile = await assertOwnedProfile();
  await rm(ownedProfile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
