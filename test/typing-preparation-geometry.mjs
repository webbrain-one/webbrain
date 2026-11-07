import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { chromium, firefox } from 'playwright';
import { cdpClient } from '../src/chrome/src/cdp/cdp-client.js';
import { installPageFeedback } from '../src/chrome/src/agent/page-feedback.js';
import { sharedBrowsers } from './lib/shared-browsers.mjs';
import { scaled, suiteTimeout } from './lib/time-budget.mjs';

const browsers = sharedBrowsers([chromium, firefox]);

// The production isolated-world monitor, AX reader and content handlers run
// together. The only substitute is local extension messaging; no website is
// contacted and no guard or target certificate is stubbed.
const runToken = 'owned-typing-run';
const url = 'https://neutral-typing.invalid/editor';
const html = `<!doctype html><style>
body{margin:0;height:1800px}main{margin-top:540px;width:650px}h1{margin:0}
form{padding:20px}#editor{height:60px;width:400px;border:1px solid}
#editor:focus{height:100px}input{width:200px}#counter{position:fixed;right:5px;top:5px}
</style><main><h1>Current record</h1><form aria-label="Current draft">
<h2 id="recipient">Current recipient</h2><div id="editor" class="ProseMirror" contenteditable="true" role="textbox" aria-label="Draft"><p>Original draft</p></div>
<label>Private field<input id="private" value="Original private value"></label>
</form></main><aside id="counter">0</aside>`;

// Each fixture gets its own context in a browser shared by the file; closing
// f.browser closes that context. Launching a new Firefox for each of the 21
// vetoes took most of that suite's time.
async function fixture(engine, build) {
  const browser = await browsers.lease(engine);
  const context = await browser.newContext({ viewport: { width: 900, height: 700 } });
  await context.route('**/*', route => route.request().url().startsWith(url)
    ? route.fulfill({ contentType: 'text/html', body: html }) : route.abort());
  await context.addInitScript(() => {
    const listeners = []; window.qaFeedback = []; window.qaInputCount = 0;
    window.chrome = window.browser = { runtime: { getURL: value => value,
      onMessage: { addListener: f => listeners.push(f), removeListener() {} },
      async sendMessage(message) {
        if (message.action === 'get_page_monitor_state') return { active: true, runToken: 'owned-typing-run', documentToken: message.documentToken };
        if (message.action === 'page_feedback') { qaFeedback.push(message.feedback); return { accepted: true }; }
        return {};
      } } };
    window.qaMessage = (action, params = {}) => new Promise(resolve => {
      let answered = false;
      const respond = value => { answered = true; resolve(value); };
      for (const listener of listeners) {
        const result = listener(action === 'page_monitor_state'
          ? { target: 'content', action, runToken: 'owned-typing-run', ...params }
          : { target: 'content', action, params: { runToken: 'owned-typing-run', ...params } }, {}, respond);
        if (answered || result === true) return;
      }
      resolve(undefined);
    });
  });
  for (const file of ['rich-text-toolbar-heuristic.js', 'accessibility-tree.js', 'page-monitor.js', 'content.js'])
    await context.addInitScript({ content: await readFile(new URL(`../src/${build}/src/content/${file}`, import.meta.url), 'utf8') });
  const page = await context.newPage(); await page.goto(url);
  await page.waitForFunction(() => __wbPageMonitor?.active);
  await page.waitForTimeout(180);
  await page.evaluate(() => editor.addEventListener('input', () => qaInputCount++));
  const capture = await page.evaluate(() => qaMessage('page_monitor_capture_model', { includeTree: true }));
  const ref_id = await page.evaluate(() => __wb_ax_ref(editor));
  assert.ok(capture.snapshotToken); assert.match(capture.page.pageContent, /Draft/);
  const prepared = await page.evaluate(({ ref_id, capture }) => qaMessage('page_monitor_prepare', {
    tool: 'type_ax', ref_id, operationId: 'owned-input', expectedModelSnapshot: capture.snapshotToken, allowPassiveRebase: true,
  }), { ref_id, capture });
  assert.equal(prepared.modelBindingValid, true, JSON.stringify(prepared));
  await page.evaluate(() => qaFeedback.length = 0);
  return { browser, page, capture, ref_id };
}

const focusHandlerVetoes = [
  ['editor value from focus handler', "editor.textContent='Changed draft'", 'semantic_binding_changed'],
  ['private form value from focus handler', "document.querySelector('#private').value='Changed private value'", 'semantic_binding_changed'],
  ['recipient from focus handler', "recipient.textContent='Changed recipient'", 'semantic_binding_changed'],
  ['form destination from focus handler', "editor.closest('form').action='/another-destination'", 'semantic_binding_changed'],
  ['replacement editor from focus handler', "editor.replaceWith(editor.cloneNode(true))", 'focus_changed'],
  ['different focus from focus handler', "document.querySelector('#private').focus()", 'focus_changed'],
];
const laterVetoes = ['later human click', 'later private value', 'later recipient', 'later page geometry', 'later page focus',
  'later minor viewport notification', 'later viewport motion', 'later zoom', 'later DPR', 'later viewport dimensions',
  'changed URL', 'Stop', 'different run', 'different document', 'stale native revision'];

for (const [build, engine] of [['chrome', chromium], ['firefox', firefox]]) {
  test(`${build}: owned typing focus and scroll preserve exact semantic certificate`, { timeout: scaled(60000) }, async () => {
    const f = await fixture(engine, build);
    try {
      const result = await f.page.evaluate(async ({ ref_id, capture }) => {
        const first = await qaMessage('type_ax', { ref_id, text: 'Replacement draft', clear: true, _bidiPrepare: '00000000-0000-4000-8000-000000000000' });
        // Firefox reports the owned fractional visual-viewport remainder in a
        // later native notification. Exercise the actual delayed browser path.
        await new Promise(resolve => setTimeout(resolve, 80));
        const fence = await qaMessage('page_monitor_dispatch', { operationId: 'owned-input', tool: 'type_ax', kind: 'input', ref_id, fenceOnly: true });
        return { first, fence, feedback: qaFeedback, inputs: qaInputCount, value: editor.textContent };
      }, { ref_id: f.ref_id, capture: f.capture });
      assert.equal(result.fence.ready, true, JSON.stringify(result));
      assert.equal(result.first.noDispatch, true, JSON.stringify(result.first));
      assert.equal(result.inputs, 0);
      assert.equal(result.value, 'Original draft');
      assert.equal(result.feedback.some(event => ['user','unknown'].includes(event.source)), false, JSON.stringify(result.feedback));
    } finally { await f.browser.close(); }
  });

  test(`${build}: preparation preserves semantic, focus, human and run vetoes`,
    { timeout: suiteTimeout(focusHandlerVetoes.length + laterVetoes.length) }, async t => {
    for (const [name, mutate, expected] of focusHandlerVetoes) await t.test(name, async () => {
      const f = await fixture(engine, build);
      try {
        await f.page.evaluate(mutate => editor.addEventListener('focus', () => Function(mutate)(), { once: true }), mutate);
        const result = await f.page.evaluate(ref_id => qaMessage('type_ax', { ref_id, text: 'Replacement draft', clear: true,
          _bidiPrepare: '00000000-0000-4000-8000-000000000000' }), f.ref_id);
        assert.equal(result.success, false, JSON.stringify(result)); assert.equal(result.noDispatch, true);
        assert.equal(result.preparationVeto?.predicate, expected, JSON.stringify(result));
        assert.equal(await f.page.evaluate(() => qaInputCount), 0);
        assert.equal(JSON.stringify(result.preparationVeto).includes('private value'), false);
      } finally { await f.browser.close(); }
    });
    for (const name of laterVetoes) await t.test(name, async () => {
      const f = await fixture(engine, build);
      try {
        await f.page.evaluate(ref_id => qaMessage('type_ax', { ref_id, text: 'Replacement draft', clear: true,
          _bidiPrepare: '00000000-0000-4000-8000-000000000000' }), f.ref_id);
        if (name.startsWith('later ') && /viewport|zoom|DPR/.test(name)) await f.page.waitForTimeout(80);
        if (name === 'later human click') await f.page.locator('#private').click();
        else if (name === 'later viewport dimensions') await f.page.setViewportSize({ width: 900, height: 650 });
        else await f.page.evaluate(name => {
          if (name === 'later private value') document.querySelector('#private').value = 'Changed private value';
          if (name === 'later recipient') recipient.textContent = 'Changed recipient';
          if (name === 'later page geometry') editor.style.height = '140px';
          if (name === 'later page focus') document.querySelector('#private').focus();
          if (name === 'later minor viewport notification') {
            Object.defineProperty(visualViewport, 'offsetTop', { configurable: true, get: () => 0.25 });
            visualViewport.dispatchEvent(new Event('scroll'));
          }
          if (name === 'later zoom') {
            Object.defineProperty(visualViewport, 'scale', { configurable: true, get: () => 1.25 });
            visualViewport.dispatchEvent(new Event('resize'));
          }
          if (name === 'later DPR') {
            Object.defineProperty(window, 'devicePixelRatio', { configurable: true, get: () => 2 });
            visualViewport.dispatchEvent(new Event('resize'));
          }
          if (name === 'changed URL') history.pushState({}, '', '/changed-editor');
          if (name === 'Stop') return qaMessage('page_monitor_state', { active: false });
        }, name);
        const result = await f.page.evaluate(async ({ ref_id, name }) => {
          const params = {
          operationId: 'owned-input', tool: 'type_ax', kind: 'input', ref_id, fenceOnly: true,
          ...(name === 'different run' ? { runToken: 'new-run' } : {}),
          ...(name === 'different document' ? { documentToken: 'new-document' } : {}),
          };
          if (name === 'later viewport motion') {
            // Gecko re-applies the agent's own pending scrollIntoView on its
            // next reflow, which would undo the page's motion (the exact
            // footprint is then intact again). Let that reflow happen first.
            document.body.style.paddingBottom = '1px'; void document.body.offsetHeight;
            document.body.style.paddingBottom = ''; void document.body.offsetHeight;
            const previous = scrollY;
            scrollBy({ top: 2, behavior: 'instant' });
            // Gecko can apply even an instant scroll on its next refresh. Fence
            // in the first frame that shows the actual later movement.
            return new Promise((resolve, reject) => {
              const deadline = performance.now() + 5000;
              const check = () => {
                if (Math.abs(scrollY - previous) >= 1) qaMessage('page_monitor_dispatch', params).then(resolve, reject);
                else if (performance.now() > deadline) reject(new Error(`the page did not move from ${previous}`));
                else requestAnimationFrame(check);
              };
              requestAnimationFrame(check);
            });
          }
          if (name === 'stale native revision') {
            // Isolate the revision contract from an earlier scroll/layout
            // observation: a fresh decision owns the current exact editor.
            const fresh = await qaMessage('page_monitor_capture_model', { includeTree: true });
            await qaMessage('page_monitor_prepare', { operationId: 'owned-input', tool: 'type_ax', ref_id,
              expectedModelSnapshot: fresh.snapshotToken, allowPassiveRebase: true });
            const fence = await qaMessage('page_monitor_dispatch', params);
            if (!fence.guard) throw new Error(JSON.stringify({ fence, feedback: qaFeedback }));
            return qaMessage('page_monitor_validate', { ...fence.guard, revision: fence.guard.revision - 1 });
          }
          return qaMessage('page_monitor_dispatch', params);
        }, { ref_id: f.ref_id, name });
        assert.equal(result.ready, false, JSON.stringify(result));
        if (name === 'later viewport motion') assert.equal(result.preparationVeto?.predicate, 'geometry_changed', JSON.stringify(result));
        assert.equal(await f.page.evaluate(() => qaInputCount), 0);
      } finally { await f.browser.close(); }
    });
  });
}

test('Chrome: full type_ax native fallback keeps replacement atomic through owned preparation', { timeout: scaled(60000) }, async t => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const saved = { chrome: globalThis.chrome, browser: globalThis.browser, attach: cdpClient.attach };
  const storage = { get: async () => ({}), set: async () => {}, remove: async () => {} };
  let page, session, agent, childSession;
  const commands = [];
  globalThis.chrome = globalThis.browser = { storage: { local: storage, session: storage },
    runtime: { getURL: p => pathToFileURL(path.join(root, 'src/chrome', p)).href },
    tabs: { get: async () => ({ id: 19, url: page.url() }), query: async () => [{ id: 19, url: page.url() }],
      sendMessage: (_id, message) => page.evaluate(message => qaMessage(message), message) },
    webNavigation: { getAllFrames: async () => [{ frameId: 0, documentId: 'owned-type-document', url: page.url() }] },
    debugger: { sendCommand: (target, method, params, callback) => {
      commands.push({ method, params });
      (target.sessionId ? childSession : session).send(method, params).then(callback, error => { chrome.runtime.lastError = { message: error.message }; callback(); delete chrome.runtime.lastError; });
    } } };
  const { Agent } = await import('../src/chrome/src/agent/agent.js');
  const browser = await chromium.launch({ headless: true, args: ['--site-per-process'] });
  cdpClient.attach = async () => cdpClient.sessions.set(19, {});
  try {
    const context = await browser.newContext({ viewport: { width: 900, height: 700 } });
    const nestedHtml = '<style>body{margin:0;height:1800px}#nested{margin-top:500px;width:300px;height:100px}</style><div id="nested" contenteditable="true"><p>Owned nested draft</p></div>';
    await context.route('**/*', route => route.request().url().startsWith(url)
      ? route.fulfill({ contentType: 'text/html', body: html }) : route.request().url().startsWith('https://neutral-frame.invalid/')
        ? route.fulfill({ contentType: 'text/html', body: nestedHtml }) : route.abort());
    page = await context.newPage(); agent = new Agent({ getActive: () => ({ model: 'neutral' }) }); agent._runningTabs.add(19);
    await page.exposeFunction('qaBackground', message => {
      const sender = { tab: { id: 19 }, frameId: 0, documentId: 'owned-type-document', url: page.url() };
      if (message.action === 'get_page_monitor_state') return agent.pageMonitorState(sender, message.documentToken);
      if (message.action === 'page_feedback') return agent.observePageFeedback(sender, message.feedback);
      return {};
    });
    await page.addInitScript(() => {
      const listeners = [];
      window.chrome = window.browser = { runtime: { getURL: p => p, sendMessage: message => qaBackground(message),
        onMessage: { addListener: f => listeners.push(f), removeListener() {} } } };
      window.qaMessage = message => new Promise(resolve => {
        let answered = false; const respond = value => { answered = true; resolve(value); };
        for (const f of listeners) { const result = f(message, {}, respond); if (answered || result === true) return; }
        resolve(undefined);
      });
    });
    for (const file of ['rich-text-toolbar-heuristic.js', 'file-upload-policy.js', 'accessibility-tree.js', 'page-monitor.js', 'content.js'])
      await page.addInitScript({ content: await readFile(new URL(`../src/chrome/src/content/${file}`, import.meta.url), 'utf8') });
    await page.goto(url); session = await context.newCDPSession(page);
    await agent._beginPageFeedbackRun(19, 'typing'); await page.waitForFunction(() => __wbPageMonitor?.active); await page.waitForTimeout(180);
    const run = agent._pageFeedbackRuns.get(19); run.events.clear();
    const scope = await chrome.tabs.sendMessage(19, { target: 'content', action: 'get_accessibility_tree', params: { filter: 'visible', maxChars: 12000 } });
    const capture = await chrome.tabs.sendMessage(19, { target: 'content', action: 'page_monitor_capture_model', params: { runToken: run.token, includeTree: true } });
    const ref_id = await page.evaluate(() => __wb_ax_ref(editor));
    agent._lastAxScopes.set(19, { documentToken: scope.documentToken, pageUrl: scope.refScopeUrl });
    const state = { token: run.token, url: run.url, steeringRevision: 0, frames: new Map(run.frames),
      actionBinding: { snapshotToken: capture.snapshotToken, runToken: run.token, documentToken: capture.documentToken } };
    run.modelState = state;
    run.dispatchCall = { name: 'type_ax', args: { ref_id, text: 'Replacement draft', clear: true }, expectedModelSnapshot: capture.snapshotToken,
      modelState: state, dispatchState: { started: false }, allowPassiveRebase: true };
    await chrome.tabs.sendMessage(19, { target: 'content', action: 'page_monitor_prepare', params: { runToken: run.token,
      tool: 'type_ax', ref_id, operationId: 'full-owned-input', expectedModelSnapshot: capture.snapshotToken, allowPassiveRebase: true } });
    commands.length = 0;
    const result = await agent.executeTool(19, 'type_ax', { ref_id, text: 'Replacement draft', clear: true });
    assert.equal(result.success, true, JSON.stringify({ result, viewport: await page.evaluate(() => ({ x: scrollX, y: scrollY, w: innerWidth, h: innerHeight, rect: { y: editor.getBoundingClientRect().y } })), commands: commands.map(command => ({ method: command.method, type: command.params.type, x: command.params.x, y: command.params.y })) })); assert.equal(result.verified, true, JSON.stringify(result));
    assert.equal(await page.locator('#editor').textContent(), 'Replacement draft');
    assert.equal(commands.filter(command => command.method === 'Input.insertText').length, 1);
    assert.equal(commands.some(command => command.method === 'Input.dispatchKeyEvent' && command.params.key === 'Delete'), false);
    await t.test('private typing ownership preserves inline activators and ordinary clicks', async () => {
      await page.evaluate(() => {
        editor.style.position = 'relative';
        editor.insertAdjacentHTML('beforeend', '<button id="inlineButton" type="button" style="position:absolute;left:80px;top:30px;width:90px;height:30px">Owned action</button><span id="inlineRole" role="button" style="position:absolute;left:200px;top:30px;width:90px;height:30px">Owned custom action</span>');
      });
      for (const tool of ['click_ax', 'type_ax']) {
        run.dispatchCall.name = tool;
        for (const selector of ['#inlineButton', '#inlineRole']) {
          const point = await page.locator(selector).evaluate(node => { const rect = node.getBoundingClientRect(); return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }; });
          const target = await cdpClient._pageAgentInputTarget(19, 'Input.dispatchMouseEvent', point);
          assert.equal(await page.locator(selector).evaluate((node, marker) => node.getAttribute('data-webbrain-native-target') === marker, target.nativeTarget), true);
        }
      }
      run.dispatchCall.name = 'type_ax';
      await page.evaluate(() => { inlineButton.remove(); inlineRole.remove(); });
    });
    for (const kind of ['document', 'horizontal', 'fixed', 'sticky']) await t.test(`production CDP receiving-node lookup: ${kind}`, async () => {
      const point = await page.evaluate(kind => {
        document.body.style.width = '1800px';
        document.querySelector('main').style.marginLeft = '950px';
        editor.closest('form').style.height = '1600px';
        editor.style.position = kind === 'fixed' ? 'fixed' : kind === 'sticky' ? 'sticky' : 'static';
        if (kind === 'fixed') { editor.style.left = '70px'; editor.style.top = '150px'; }
        if (kind === 'sticky') editor.style.top = '100px';
        scrollTo(kind === 'horizontal' ? 950 : 600, kind === 'sticky' ? 900 : 400);
        const rect = editor.getBoundingClientRect();
        return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, scrollX, scrollY };
      }, kind);
      commands.length = 0;
      const target = await cdpClient._pageAgentInputTarget(19, 'Input.dispatchMouseEvent', point);
      assert.equal(await page.evaluate(marker => document.querySelector(`[data-webbrain-native-target="${marker}"]`) === editor, target.nativeTarget), true);
      const hit = commands.find(command => command.method === 'DOM.getNodeForLocation');
      assert.deepEqual({ x: hit.params.x, y: hit.params.y }, { x: Math.round(point.x + point.scrollX), y: Math.round(point.y + point.scrollY) });
      assert.equal(commands.some(command => command.method.startsWith('Input.')), false, 'Target discovery sends no native input.');
    });
    for (const mode of ['same-origin', 'cross-origin OOPIF']) await t.test(`scrolled parent and ${mode} child keep the receiving document and viewport quad`, async () => {
      await page.evaluate(({ mode, nestedHtml }) => {
        document.querySelector('#receivingFrame')?.remove();
        const frame = document.createElement('iframe'); frame.id = 'receivingFrame';
        frame.style.cssText = 'position:fixed;top:150px;left:50px;width:420px;height:300px';
        if (mode === 'same-origin') frame.srcdoc = nestedHtml;
        else frame.src = 'https://neutral-frame.invalid/editor';
        document.body.append(frame);
      }, { mode, nestedHtml });
      const child = await (await page.locator('#receivingFrame').elementHandle()).contentFrame();
      await child.waitForSelector('#nested');
      await child.evaluate(token => {
        __wbPageMonitor?.dispose();
        window.chrome = window.browser = { runtime: { onMessage: { addListener() {}, removeListener() {} },
          async sendMessage(message) { return message.action === 'get_page_monitor_state'
            ? { active: true, runToken: token, documentToken: message.documentToken } : { accepted: true }; } } };
      }, run.token);
      await child.addScriptTag({ content: await readFile(new URL('../src/chrome/src/content/page-monitor.js', import.meta.url), 'utf8') });
      await child.waitForFunction(() => __wbPageMonitor.active);
      childSession = mode === 'cross-origin OOPIF' ? await context.newCDPSession(child) : null;
      await child.evaluate(() => scrollTo(0, 450));
      const childPoint = await child.locator('#nested').evaluate(node => {
        const rect = node.getBoundingClientRect(); return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
      });
      const parentBox = await page.locator('#receivingFrame').evaluate(node => {
        const rect = node.getBoundingClientRect(); return { left: rect.left, top: rect.top, scrollY };
      });
      const parentObject = await session.send('Runtime.evaluate', { expression: 'receivingFrame' });
      const quad = (await session.send('DOM.getContentQuads', { objectId: parentObject.result.objectId })).quads[0];
      assert.equal(quad[1], parentBox.top, 'Quad coordinates are relative to the viewport despite parent scrolling.');
      assert.notEqual(parentBox.scrollY, 0);
      const target = await cdpClient._pageAgentInputTarget(19, 'Input.dispatchMouseEvent', {
        x: parentBox.left + childPoint.x + 2, y: parentBox.top + childPoint.y + 2,
      });
      assert.equal(await child.evaluate(marker => document.querySelector(`[data-webbrain-native-target="${marker}"]`) === nested, target.nativeTarget), true);
      const nestedToken = await child.evaluate(() => document.documentElement.getAttribute('data-webbrain-page-revision').split(':')[0]);
      assert.equal(target.documentToken, nestedToken);
      assert.notEqual(target.documentToken, capture.documentToken);
      await childSession?.detach(); childSession = null;
    });
    // Substitute only the native-event producer so a valid original action
    // deliberately receives input on a different node. Every certificate,
    // private owner, hit test, monitor and CDP dispatch remains production code.
    let receiverSelector;
    class ReceiverProbe extends Agent {
      async executeTool(tabId) {
        const point = await page.locator(receiverSelector).evaluate(node => {
          const rect = node.getBoundingClientRect(); return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
        });
        await cdpClient.dispatchMouseEvent(tabId, 'mousePressed', point.x, point.y);
        await cdpClient.dispatchMouseEvent(tabId, 'mouseReleased', point.x, point.y);
        return { success: true, dispatched: true };
      }
    }
    installPageFeedback(ReceiverProbe);
    for (const kind of ['unrelated button', 'unrelated role button', 'shadow inline button', 'passive label', 'passive SVG'])
      await t.test(`actual native receiver certificate: ${kind}`, async () => {
        agent._finishPageFeedbackRun(19);
        await page.goto(url);
        const positive = kind.startsWith('passive');
        receiverSelector = await page.evaluate(kind => {
          window.qaReceiverClicks = 0;
          const button = document.createElement('button'); button.type = 'button';
          button.id = 'receiverOwner'; button.style.cssText = 'position:fixed;top:15px;left:620px;width:220px;height:70px';
          button.innerHTML = '<span id="receiverLabel">Current action</span><svg width="25" height="25"><rect id="receiverSVG" width="25" height="25" fill="black"></rect></svg>';
          button.addEventListener('click', () => qaReceiverClicks++);
          if (kind === 'shadow inline button') {
            editor.style.position = 'relative';
            const host = document.createElement('span'); host.style.cssText = 'position:absolute;left:20px;top:5px';
            const shadow = host.attachShadow({ mode: 'open' });
            button.id = 'shadowReceiver'; button.style.cssText = 'width:100px;height:25px';
            shadow.append(button); editor.append(host);
            return '#shadowReceiver';
          }
          if (kind === 'unrelated role button') {
            const roleButton = document.createElement('span'); roleButton.id = 'roleReceiver'; roleButton.role = 'button';
            roleButton.textContent = 'Other record action'; roleButton.style.cssText = button.style.cssText;
            roleButton.addEventListener('click', () => qaReceiverClicks++); document.body.append(roleButton);
            return '#roleReceiver';
          }
          document.body.append(button);
          return kind === 'passive label' ? '#receiverLabel' : kind === 'passive SVG' ? '#receiverSVG' : '#receiverOwner';
        }, kind);
        agent = new ReceiverProbe({ getActive: () => ({ model: 'neutral' }) }); agent._runningTabs.add(19);
        await agent._beginPageFeedbackRun(19, 'receiver-certificate');
        await page.waitForFunction(() => __wbPageMonitor.active); await page.waitForTimeout(180);
        const probeRun = agent._pageFeedbackRuns.get(19); probeRun.events.clear();
        const probeScope = await chrome.tabs.sendMessage(19, { target: 'content', action: 'get_accessibility_tree', params: { filter: 'visible', maxChars: 12000 } });
        const probeCapture = await chrome.tabs.sendMessage(19, { target: 'content', action: 'page_monitor_capture_model', params: { runToken: probeRun.token, includeTree: true } });
        const ref = await page.evaluate(positive => __wb_ax_ref(positive ? receiverOwner : editor), positive);
        agent._lastAxScopes.set(19, { documentToken: probeScope.documentToken, pageUrl: probeScope.refScopeUrl });
        probeRun.modelState = { token: probeRun.token, url: probeRun.url, steeringRevision: 0, frames: new Map(probeRun.frames),
          actionBinding: { snapshotToken: probeCapture.snapshotToken, runToken: probeRun.token, documentToken: probeCapture.documentToken } };
        commands.length = 0;
        const receipt = await agent.executeTool(19, positive ? 'click_ax' : 'type_ax', { ref_id: ref, ...(positive ? {} : { text: 'Replacement draft', clear: true }) });
        const input = commands.filter(command => command.method.startsWith('Input.'));
        assert.equal(await page.evaluate(() => qaReceiverClicks), positive ? 1 : 0, JSON.stringify(receipt));
        if (positive) {
          assert.equal(receipt.success, true, JSON.stringify(receipt));
          assert.deepEqual(input.map(command => command.params.type), ['mousePressed', 'mouseReleased']);
        } else {
          assert.equal(receipt.noDispatch, true, JSON.stringify(receipt));
          assert.equal(receipt.preparationVeto?.predicate, 'target_changed', JSON.stringify(receipt));
          assert.equal(input.length, 0, 'A different native control must not receive any input from the certified editor.');
          assert.equal(await page.locator('#editor').textContent(), 'Original draft');
        }
      });
  } finally { agent?._finishPageFeedbackRun(19); cdpClient.attach = saved.attach; cdpClient.sessions.delete(19); globalThis.chrome = saved.chrome; globalThis.browser = saved.browser; await browser.close(); }
});
