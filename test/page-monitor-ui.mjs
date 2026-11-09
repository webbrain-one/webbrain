import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { chromium, firefox } from 'playwright';
import { CDPClient, cdpClient } from '../src/chrome/src/cdp/cdp-client.js';
import { Agent } from '../src/chrome/src/agent/agent.js';
import { installPageFeedback, pageFeedbackMethods } from '../src/chrome/src/agent/page-feedback.js';
import { BidiSession, createNativeActionMarker } from '../firefox-companion/session.mjs';
import { scaled } from './lib/time-budget.mjs';

// How long a test waits for page feedback that must arrive: a MutationObserver
// callback, the monitor's 150 ms debounce and a message round trip, which an
// idle machine delivers well within a second. A loaded one did not, in 1000 ms.
// A wait whose bound is part of the behaviour under test keeps its own value.
const FEEDBACK_WAIT_MS = scaled(5000);

const read = (build, file) => fs.readFileSync(new URL(`../src/${build}/src/${file}`, import.meta.url), 'utf8');
const html = `<!doctype html><style>
body { margin: 0; } button,input { margin: 12px; }
#container { overflow: auto; height: 100px; width: 300px; }
#moving { animation: slide 100ms linear infinite alternate; } @keyframes slide { to { transform: translateX(8px); } }
</style><button id="agent">Agent button</button><button id="human">Human button</button>
<input id="field"><input id="secret" type="password"><select id="select"><option>A</option><option>B</option></select>
<p id="status">Ready</p><div id="container"><div style="height:1000px">Scrollable</div></div>
<div id="moving">Animated</div><div style="height:3000px"></div>
<script>document.getElementById('agent').addEventListener('click', () => { document.getElementById('status').textContent = 'Agent changed this'; });</script>`;

async function fixture(engine, build, { runToken = 'test-run', siteIsolation = false, omitEmptyFrameMonitor = false,
  capturePointerHandlers = false, instrumentWeakRefDeref = false } = {}) {
  const browser = await engine.launch({ headless: true, ...(siteIsolation ? { args: ['--site-per-process'] } : {}) });
  const context = await browser.newContext();
  await context.route('https://monitor.test/**', route => route.fulfill({ contentType: 'text/html', body: html }));
  await context.addInitScript(token => { window.monitorRunToken = token; }, runToken);
  if (instrumentWeakRefDeref) await context.addInitScript(() => {
    const NativeWeakRef = globalThis.WeakRef;
    globalThis.__controlReferenceDerefs = 0;
    globalThis.WeakRef = class CountedWeakRef extends NativeWeakRef {
      deref() { globalThis.__controlReferenceDerefs++; return super.deref(); }
    };
  });
  if (capturePointerHandlers) await context.addInitScript(() => {
    window.monitorPointerHandlers = {};
    const add = EventTarget.prototype.addEventListener;
    EventTarget.prototype.addEventListener = function(type, handler, options) {
      if (this === document && ['pointerdown', 'pointermove', 'pointerup', 'pointercancel'].includes(type)
          && options?.capture && typeof handler === 'function') (monitorPointerHandlers[type] ||= []).push(handler);
      return add.call(this, type, handler, options);
    };
  });
  await context.addInitScript(() => {
    window.monitorEnabled = true;
    window.feedback = [];
    window.pageMonitorStateRequests = [];
    window.messageListeners = [];
    const runtime = { onMessage: {
      addListener: fn => messageListeners.push(fn),
      removeListener: fn => { messageListeners = messageListeners.filter(item => item !== fn); },
    }, async sendMessage(msg) {
      if (msg.action === 'get_page_monitor_state') {
        pageMonitorStateRequests.push(msg.frameName);
        return { active: monitorEnabled, runToken: monitorRunToken, documentToken: msg.documentToken };
      }
      if (msg.action === 'page_feedback') { feedback.push(msg.feedback); return { accepted: true }; }
      return {};
    } };
    window.chrome = { runtime }; window.browser = window.chrome;
    window.deliver = (action, params = {}) => messageListeners.forEach(fn => fn({ target: 'content', action,
      params: { runToken: monitorRunToken, ...params }, active: action === 'page_monitor_state' ? monitorEnabled : undefined,
      runToken: monitorRunToken }, {}, value => { window.lastMonitorResponse = value; }));
  });
  const initialScript = file => omitEmptyFrameMonitor
    ? `if (window === window.top) { ${read(build, file)} }` : read(build, file);
  await context.addInitScript({ content: initialScript('content/page-monitor-shadow.js') });
  await context.addInitScript({ content: initialScript('content/page-monitor.js') });
  const page = await context.newPage();
  await page.goto('https://monitor.test/start');
  await page.waitForTimeout(200);
  await page.evaluate(() => { feedback = []; });
  return { browser, context, page };
}

async function installScrollHelper(page, build) {
  const source = read(build, 'content/content.js');
  const helper = source.match(/^  function _scrollElementIntoClearView\([\s\S]*?^  }/m)?.[0];
  const typingPreparation = source.match(/^  function _withTypingPreparation\([\s\S]*?^  }/m)?.[0];
  assert.ok(helper);
  assert.ok(typingPreparation);
  await page.addScriptTag({ content: `${typingPreparation}\nwindow._scrollElementIntoClearView = ${helper};` });
  await page.evaluate(() => Object.assign(window, {
    _isAlreadyVisibleInFixedSurface: () => false, _getViewportDockedInsets: () => ({ top: 0, bottom: 0 }),
    _isFullyVisibleForInteraction: () => false, _isCoveredByFixedNonModalSurface: () => false,
    showAgentWorkingTarget: () => {}, _fieldMeta: () => ({}),
    _axFallbackStaticAssessment: () => ({ tag: 'button', role: 'button', name: 'Target' }),
    _axModelName: (_el, name) => name,
  }));
}

test('Chrome AX preparation attributes actual scrolling without claiming field input', async () => {
  const { browser, page } = await fixture(chromium, 'chrome');
  try {
    await installScrollHelper(page, 'chrome');
    const source = read('chrome', 'content/content.js');
    const entries = ['ax_resolve_rect', 'ax_resolve_two_rects', 'ax_prepare_field_for_trusted_type'].map(action => {
      const start = source.indexOf(`'${action}': () => {`), end = source.indexOf('\n      },', start);
      assert.ok(start > 0 && end > start); return source.slice(start, end + 8);
    });
    const draftJsEditor = source.match(/^  function isDraftJsEditor\([\s\S]*?^  }/m)?.[0];
    assert.ok(draftJsEditor, 'Use the production editor classification required by trusted preparation');
    await page.addScriptTag({ content: `${draftJsEditor}\nwindow.axHelpers = { ${entries.join(',\n')} };` });
    await page.evaluate(() => {
      for (let i = 1; i <= 3; i++) {
        const box = document.createElement('div'); box.id = `scroll-box-${i}`;
        box.style.cssText = 'overflow:auto;height:100px;width:300px';
        box.innerHTML = `<${i === 3 ? 'input' : 'button'} id="ref_${i}" style="margin-top:900px">Target</${i === 3 ? 'input' : 'button'}>`;
        document.body.append(box);
      }
      window.__wb_ax_lookup = ref => document.getElementById(ref);
    });
    await page.waitForTimeout(200);
    for (const [action, params] of [
      ['ax_resolve_rect', { ref_id: 'ref_1' }],
      ['ax_resolve_two_rects', { fromRefId: 'ref_1', toRefId: 'ref_2' }],
      ['ax_prepare_field_for_trusted_type', { ref_id: 'ref_3' }],
    ]) {
      await page.evaluate(() => {
        monitorEnabled = false; deliver('page_monitor_state'); window.scrollTo(0, 0);
        for (const el of document.querySelectorAll('[id^="scroll-box-"]')) el.scrollTop = 0;
      });
      await page.waitForTimeout(50);
      await page.evaluate(() => { monitorEnabled = true; deliver('page_monitor_state'); });
      await page.waitForTimeout(20);
      const result = await page.evaluate(({ action, params }) => {
        feedback = []; window.msg = { params };
        const finish = __wbPageMonitor.beginContentAction(action, params);
        try { return axHelpers[action](); } finally { finish(); }
      }, { action, params });
      assert.equal(result.success, true, JSON.stringify(result));
      await page.waitForTimeout(80);
      assert.deepEqual(await page.evaluate(() => feedback), [], `${action} must not block the native action after scroll settling`);
      assert.ok(await page.evaluate(() => [...document.querySelectorAll('[id^="scroll-box-"]')].some(el => el.scrollTop > 0)));
      if (action === 'ax_resolve_two_rects') assert.ok(await page.evaluate(() => [1, 2].every(i => document.getElementById(`scroll-box-${i}`).scrollTop > 0)));
      if (action === 'ax_prepare_field_for_trusted_type') {
        await page.keyboard.press('x');
        await page.waitForFunction(() => feedback.some(event => event.kind === 'input' && event.source === 'user'), null, { timeout: FEEDBACK_WAIT_MS });
      }
    }
  } finally { await browser.close(); }
});

test('Chrome controlled-field trusted typing survives its focus-created formatting toolbar', async () => {
  const savedChrome = globalThis.chrome, savedBrowser = globalThis.browser, tab = 919;
  const savedCdpAttach = cdpClient.attach, savedCdpSend = cdpClient.sendCommand;
  let changeToolbarAfterFocus = false, changeComposerAfterFocus = false;
  class FieldHost {
    static STATE_CHANGE_TOOLS = new Set(['set_field']);
    isRunning() { return true; }
    _checkAbort() { return false; }
    _throwIfAborted() {}
    _persist() {}
    async _textMutationValueDigest(...args) { return Agent.prototype._textMutationValueDigest.call(this, ...args); }
    _appOwnedUserMessage(content) { return { role: 'user', content }; }
    async executeTool(tabId, name, args, _update, executionContext) {
      executionContext._contentActionDispatchState.started = true;
      const result = await Agent.prototype._maybeFallbackFieldWithCdpImpl.call(this, tabId, name, args,
        { success: false, verified: false, dispatched: false, noDispatch: true, _expectedValue: args.text,
          error: 'Contenteditable fields require trusted browser typing', trustedTypeRequired: true });
      return result.textUnchanged === true
        ? Agent.prototype._finalizeTextMutationResult.call(this, tabId, name, args, result)
        : result;
    }
  }
  installPageFeedback(FieldHost);
  const host = new FieldHost();
  let browser, page, session;
  const commands = [], preparations = [];
  const api = { runtime: {}, tabs: {
    get: async () => ({ url: 'https://monitor.test/start' }),
    sendMessage: async (_tab, message) => {
      if (!page) return {};
      if (message.action.startsWith('ax_') || message.action === 'field_value_digest') return page.evaluate(async message => {
        window.msg = message;
        let finish = () => {};
        try {
          finish = __wbPageMonitor.beginContentAction(message.action, message.params || {});
          const result = await axHelpers[message.action]();
          if (message.action === 'field_value_digest') {
            result.documentToken = document.documentElement.getAttribute('data-webbrain-page-revision').split(':')[0];
            result.refScopeUrl = location.href;
          }
          return result;
        } catch (error) {
          return { success: false, dispatched: error.dispatched === true, noDispatch: error.dispatched !== true,
            error: `${message.action} failed: ${error.message}` };
        } finally { finish(); }
      }, message).then(result => { if (message.action === 'ax_prepare_field_for_trusted_type') preparations.push(result); return result; });
      return page.evaluate(message => new Promise(resolve => messageListeners.forEach(fn => fn(message, {}, resolve))), message);
    },
  }, debugger: { sendCommand(_source, method, params, callback) {
    commands.push({ method, params });
    void (async () => {
      const result = await session.send(method, params);
      if (changeToolbarAfterFocus && method === 'Input.dispatchMouseEvent' && params.type === 'mouseReleased') {
        changeToolbarAfterFocus = false;
        await page.waitForTimeout(30);
        await page.evaluate(() => document.getElementById('formatting-toolbar').setAttribute('aria-label', 'Text formatting open'));
      }
      if (changeComposerAfterFocus && method === 'Input.dispatchMouseEvent' && params.type === 'mouseReleased') {
        changeComposerAfterFocus = false;
        await page.waitForTimeout(30);
        await page.evaluate(() => document.getElementById('ref_compose_dialog').setAttribute('aria-label', 'Reply to another account'));
      }
      return result;
    })().then(callback, error => {
      api.runtime.lastError = { message: error.message }; callback(); delete api.runtime.lastError;
    });
  } } };
  globalThis.chrome = api; delete globalThis.browser;
  try {
    await host._beginPageFeedbackRun(tab, 'interactive');
    ({ browser, page } = await fixture(chromium, 'chrome', { runToken: host._pageFeedbackRuns.get(tab).token }));
    const documentToken = await page.evaluate(() => document.documentElement.getAttribute('data-webbrain-page-revision').split(':')[0]);
    host.pageMonitorState({ tab: { id: tab }, frameId: 0 }, documentToken);
    await page.exposeFunction('feedbackToHost', feedback => host.observePageFeedback({ tab: { id: tab }, frameId: 0 }, feedback));
    await page.exposeFunction('monitorStateFromHost', token => host.pageMonitorState({ tab: { id: tab }, frameId: 0 }, token));
    await page.addScriptTag({ content: read('chrome', 'content/rich-text-toolbar-heuristic.js') });
    await page.addScriptTag({ content: read('chrome', 'content/accessibility-tree.js') });
    await page.evaluate(() => {
      const original = chrome.runtime.sendMessage;
      chrome.runtime.sendMessage = async message => {
        if (message.action === 'get_page_monitor_state') return await monitorStateFromHost(message.documentToken);
        const response = await original(message);
        return message.action === 'page_feedback' ? await feedbackToHost(message.feedback) : response;
      };
      const editor = document.createElement('div');
      editor.id = 'ref_trusted_editor'; editor.contentEditable = 'true'; editor.setAttribute('role', 'textbox');
      editor.setAttribute('aria-label', 'Post text'); editor.style.cssText = 'width:500px;height:96px;margin:12px';
      editor.innerHTML = '<div><br></div>';
      const dialog = document.createElement('div'); dialog.id = 'ref_compose_dialog'; dialog.setAttribute('role', 'dialog');
      dialog.setAttribute('aria-modal', 'true'); dialog.append(editor); document.body.prepend(dialog);
      editor.addEventListener('focus', () => {
        if (document.getElementById('formatting-toolbar')) return;
        const toolbar = document.createElement('div'); toolbar.id = 'formatting-toolbar';
        toolbar.setAttribute('role', 'toolbar'); toolbar.setAttribute('aria-label', 'Text formatting');
        toolbar.style.cssText = 'position:fixed;left:600px;top:200px';
        toolbar.innerHTML = '<button aria-label="Bold">B</button><button aria-label="Italic">I</button>';
        document.body.append(toolbar);
      });
      window._fieldMeta = el => ({ tag: 'div', contentEditable: true, ariaLabel: el.getAttribute('aria-label') });
      window._editableTextValue = el => el.innerText.replace(/\n$/, '');
      window.readProseMirrorText = () => null;
      window.isDraftJsEditor = () => false;
      window.readDraftJsText = () => null;
      window.readCodeMirrorText = () => null;
      window.readEmptyCaretText = () => null;
      window._stableFieldSelector = el => '#' + el.id;
      window._setFieldValueMatches = (actual, prefix, text, clear) => actual === (clear ? '' : prefix) + text;
    });
    const editorRef = await page.evaluate(() => __wb_ax_ref(document.getElementById('ref_trusted_editor')));
    const source = read('chrome', 'content/content.js');
    const entries = ['ax_prepare_field_for_trusted_type', 'ax_verify_field_value', 'field_value_digest'].map(action => {
      const start = source.indexOf(`'${action}': ${action === 'field_value_digest' ? 'async ' : ''}() => {`), end = source.indexOf('\n      },', start);
      assert.ok(start > 0 && end > start); return source.slice(start, end + 8);
    });
    const typingPreparation = source.match(/^  function _withTypingPreparation\([\s\S]*?^  }/m)?.[0];
    assert.ok(typingPreparation);
    await page.addScriptTag({ content: `${typingPreparation}\nwindow.axHelpers = { ${entries.join(',\n')} };` });
    await page.waitForTimeout(250);
    await page.evaluate(() => { feedback = []; });
    host._pageFeedbackRuns.get(tab).events.clear();
    const client = new CDPClient(); client.sessions.set(tab, { attached: true });
    session = await page.context().newCDPSession(page);
    cdpClient.attach = async () => ({ attached: true });
    cdpClient.sendCommand = (...args) => client.sendCommand(...args);
    await host._capturePageFeedbackModelState(tab, []);
    assert.equal(host._pageFeedbackRuns.get(tab).modelState.actionBinding.focusedTargetAvailable, false);
    const capturedBinding = await page.evaluate(runToken => {
      deliver('page_monitor_capture_model', { runToken, includeTree: true }); return lastMonitorResponse;
    }, host._pageFeedbackRuns.get(tab).token);
    assert.ok(capturedBinding.targetCount > 0, 'The heading-free compose dialog must certify its editor');
    const result = await host.executeTool(tab, 'set_field',
      { ref_id: editorRef, text: 'A verified post', clear: true });
    assert.equal(result.success, true, JSON.stringify({ result, preparations, feedback: await page.evaluate(() => feedback), commands: commands.filter(item => item.method.startsWith('Input.')) }));
    assert.equal(await page.locator('#ref_trusted_editor').innerText(), 'A verified post');
    assert.equal(commands.filter(item => item.method === 'Input.insertText').length, 1);

    // The page's own reaction outside the composer (its formatting toolbar)
    // after WebBrain's own focus click is not a reason to stop typing.
    await page.waitForTimeout(250);
    host._pageFeedbackRuns.get(tab).events.clear();
    await host._capturePageFeedbackModelState(tab, []);
    commands.length = 0; preparations.length = 0; changeToolbarAfterFocus = true;
    const toolbarChanged = await host.executeTool(tab, 'set_field',
      { ref_id: editorRef, text: 'The next verified post', clear: true });
    assert.equal(toolbarChanged.success, true, JSON.stringify({ toolbarChanged, preparations }));
    assert.equal(await page.locator('#formatting-toolbar').getAttribute('aria-label'), 'Text formatting open');
    assert.deepEqual(preparations.map(item => item.success), [true, true]);
    assert.equal(commands.filter(item => item.method === 'Input.insertText').length, 1);
    assert.equal(await page.locator('#ref_trusted_editor').innerText(), 'The next verified post');

    // A change to the composer itself between the focus click and the
    // selection still stops text dispatch.
    await page.waitForTimeout(250);
    host._pageFeedbackRuns.get(tab).events.clear();
    await host._capturePageFeedbackModelState(tab, []);
    commands.length = 0; preparations.length = 0; changeComposerAfterFocus = true;
    const interrupted = await host.executeTool(tab, 'set_field',
      { ref_id: editorRef, text: 'The final verified post', clear: true });
    assert.equal(interrupted.success, false);
    assert.match(interrupted.error, /could not reselect it.*Browser changed during action preparation/);
    assert.equal(preparations.length, 2);
    assert.equal(preparations[0].success, true);
    assert.equal(preparations[1].success, false);
    assert.equal(commands.some(item => item.method === 'Input.insertText'), false,
      'A composer change between trusted focus and selection must stop text dispatch');
    assert.equal(interrupted.dispatched, true, 'The trusted focus click remains a real dispatched interaction');
    assert.equal(interrupted.textUnchanged, true, 'Before/after real SHA-256 readback proves the editor unchanged');
    assert.equal(interrupted.mutationMayHaveOccurred, false);
    assert.equal(interrupted.repeatBlocked, false);
    assert.equal(interrupted.recoveryRequired, 'fresh_tree');
    assert.equal(host._uncertainTextMutations?.get(tab)?.size || 0, 0);
    assert.equal(await page.locator('#ref_trusted_editor').innerText(), 'The next verified post');

    await page.waitForTimeout(250);
    host._pageFeedbackRuns.get(tab).events.clear();
    await host._capturePageFeedbackModelState(tab, []);
    commands.length = 0;
    const retried = await host.executeTool(tab, 'set_field',
      { ref_id: editorRef, text: 'The final verified post', clear: true });
    assert.equal(retried.success, true, JSON.stringify(retried));
    assert.equal(await page.locator('#ref_trusted_editor').innerText(), 'The final verified post');
    assert.equal(commands.filter(item => item.method === 'Input.insertText').length, 1);
  } finally {
    cdpClient.attach = savedCdpAttach; cdpClient.sendCommand = savedCdpSend;
    if (session) await session.detach().catch(() => {});
    if (host._pageFeedbackRuns?.has(tab)) host._finishPageFeedbackRun(tab);
    if (savedChrome === undefined) delete globalThis.chrome; else globalThis.chrome = savedChrome;
    if (savedBrowser === undefined) delete globalThis.browser; else globalThis.browser = savedBrowser;
    if (browser) await browser.close();
  }
});

test('Chrome full-page capture marks temporary scrolling without suppressing a later page scroll', async () => {
  const { browser, page } = await fixture(chromium, 'chrome');
  const tabId = 88001;
  const previousChrome = globalThis.chrome, previousBrowser = globalThis.browser;
  const monitorApi = { tabs: {
    get: async id => ({ id, url: 'https://monitor.test/start' }),
    sendMessage: async (_tab, message) => {
      if (message?.target !== 'content') return { ready: true };
      await page.evaluate(({ action, params }) => deliver(action, params), { action: message.action, params: message.params || {} });
      return page.evaluate(() => window.lastMonitorResponse || { ready: true });
    },
  }, webNavigation: { getAllFrames: async () => [{ frameId: 0 }] } };
  globalThis.chrome = monitorApi;
  globalThis.browser = monitorApi;
  const agent = Object.assign({ _pageFeedbackRuns: new Map(), isRunning: () => true, _checkAbort: () => false,
    _hasPendingPageFeedback(tab) { return (this._pageFeedbackRuns.get(tab)?.events.size || 0) > 0; } }, pageFeedbackMethods);
  let session;
  try {
    await agent._beginPageFeedbackRun(tabId, 'interactive');
    const run = agent._pageFeedbackRuns.get(tabId);
    await page.evaluate(token => { window.monitorRunToken = token; deliver('page_monitor_state'); }, run.token);
    await page.waitForTimeout(30);
    const client = new CDPClient();
    session = await page.context().newCDPSession(page);
    client.sendCommand = (_tab, method, params) => session.send(method, params);
    const captureState = {};
    await page.evaluate(() => {
      feedback = [];
      document.addEventListener('scroll', () => {
        const loaded = document.createElement('button'); loaded.id = 'capture-lazy-content';
        loaded.style.cssText = 'position:fixed;top:0;left:0'; loaded.textContent = 'Loaded'; document.body.append(loaded);
      }, { once: true });
    });
    await client._scrollForFullPageCapture(tabId, 0, 600, captureState);
    await client._finishFullPageCaptureScroll(tabId, captureState);
    await page.waitForTimeout(250);
    const captureFeedback = await page.evaluate(() => feedback);
    assert.ok(await page.locator('#capture-lazy-content').count(), 'The trusted page scroll handler appended lazy content');
    assert.equal(captureFeedback.length, 0,
      'The capture scroll and its synchronous lazy-load mutation must be attributed to the active agent run');

    await page.evaluate(() => { feedback = []; window.scrollTo(0, 900); });
    await page.waitForFunction(() => feedback.some(event => event.kind === 'scroll'));
    assert.ok((await page.evaluate(() => feedback)).some(event => event.kind === 'scroll' && event.source !== 'agent'),
      'A later unmarked page scroll must remain visible to the monitor');
  } finally {
    if (session) await session.detach().catch(() => {});
    if (agent._pageFeedbackRuns.has(tabId)) agent._finishPageFeedbackRun(tabId);
    if (previousChrome === undefined) delete globalThis.chrome; else globalThis.chrome = previousChrome;
    if (previousBrowser === undefined) delete globalThis.browser; else globalThis.browser = previousBrowser;
    await browser.close();
  }
});

test('Chrome: unrelated layout shifts during an agent operation stay observable', async () => {
  const { browser, page } = await fixture(chromium, 'chrome');
  try {
    await page.evaluate(() => {
      const spacer = document.createElement('div'); spacer.id = 'unrelated-layout-shift';
      spacer.style.height = '1px'; document.getElementById('agent').after(spacer);
    });
    await page.waitForTimeout(200);
    await page.evaluate(() => {
      feedback = [];
      deliver('page_monitor_prepare', { operationId: 'active-layout-op', tool: 'click', selector: '#agent' });
      deliver('page_monitor_dispatch', { operationId: 'active-layout-op', kind: 'click', selector: '#agent' });
      document.styleSheets[0].insertRule('#unrelated-layout-shift { height: 120px !important; }', document.styleSheets[0].cssRules.length);
    });
    await page.waitForFunction(() => feedback.some(event => event.kind === 'dom'), null, { timeout: FEEDBACK_WAIT_MS });
    assert.ok(await page.evaluate(() => feedback.some(event => event.kind === 'dom' && event.source !== 'agent')),
      'A shift in a sibling region must not be discarded as an expected agent effect');
  } finally { await browser.close(); }
});

async function installContentEditableFallback(page, build) {
  const source = read(build, 'content/content.js');
  const ownInputScope = source.match(/^  let _messageRecipientOwnedInputScope = null;$/m)?.[0];
  assert.ok(ownInputScope, 'Use the real private production owned-input scope');
  const insertion = source.match(/^  async function _insertContentEditableText\([\s\S]*?^  }/m)?.[0];
  assert.ok(insertion, 'Exercise the real contenteditable fallback with the real monitor');
  const caretReceipts = source.match(/^  const _nativeChatEmptyCaretReceipts = new WeakMap\(\);$/m)?.[0];
  assert.ok(caretReceipts, 'Exercise the private production native-chat caret receipt state');
  const readers = ['readProseMirrorText', 'readCodeMirrorText', 'readEmptyCaretText', 'isDraftJsEditor', 'isModelManagedEditor', 'readDraftJsText', '_nativeChatCaretContext', '_sameNativeChatCaretContext',
    '_singleEditableCaretBreak', '_rememberNativeChatEmptyCaret', '_nativeChatCaretValueIsEmpty', '_editableTextValue'].map(name => {
    const reader = source.match(new RegExp(`^  function ${name}\\([\\s\\S]*?^  }`, 'm'))?.[0];
    assert.ok(reader, `Exercise the production ${name} readback used by native editor insertion`);
    return reader;
  });
  await page.addScriptTag({ content: read(build, 'content/chat-observation.js') });
  const settleDelay = source.match(/^  const SET_FIELD_VERIFY_DELAY_MS = \d+;$/m)?.[0];
  assert.ok(settleDelay, 'Use the same bounded page-handler render delay as production');
  await page.addScriptTag({ content: `${ownInputScope}\n${caretReceipts}\n${settleDelay}\n${readers.join('\n')}\nwindow._fieldMeta = () => ({ contentEditable: true }); window.richTextInsertion = ${insertion};` });
  await page.evaluate(() => {
    const editor = document.createElement('div'); editor.id = 'rich-editor'; editor.contentEditable = 'true';
    document.body.prepend(editor);
    window.typeRichText = async ({ text, clear }) => {
      const finish = __wbPageMonitor.beginContentAction('type', { selector: '#rich-editor' });
      try { editor.focus(); return await richTextInsertion(editor, text, clear); }
      catch (error) { return { success: false, error: error.message, code: error.code, dispatched: error.dispatched }; }
      finally { finish(); }
    };
  });
}

test('Firefox late registration covers blank/srcdoc frames and preserves an existing monitor', async () => {
  const { browser, page } = await fixture(firefox, 'firefox', { omitEmptyFrameMonitor: true });
  try {
    const manifest = JSON.parse(fs.readFileSync(new URL('../src/firefox/manifest.json', import.meta.url), 'utf8'));
    const late = manifest.content_scripts.find(entry => entry.run_at !== 'document_start'
      && entry.js.includes('src/content/page-monitor.js') && entry.all_frames && entry.match_about_blank);
    const lateShadow = manifest.content_scripts.find(entry => entry.run_at !== 'document_start' && entry.world === 'MAIN'
      && entry.js.includes('src/content/page-monitor-shadow.js') && entry.all_frames && entry.match_about_blank);
    assert.ok(late && lateShadow, 'Empty Firefox frames need a later monitor and shadow-hook registration');
    const recovery = late.js.map(file => read('firefox', file.replace(/^src\//, ''))).join('\n');
    await page.evaluate(() => { window.earlyMonitor = __wbPageMonitor; window.earlyFence = document.documentElement.getAttribute('data-webbrain-page-revision'); });
    await page.addScriptTag({ content: recovery });
    assert.equal(await page.evaluate(() => __wbPageMonitor === earlyMonitor && document.documentElement.getAttribute('data-webbrain-page-revision') === earlyFence), true,
      'The supplemental pass must not replace a live monitor or its dispatch expectations');
    await page.evaluate(() => {
      const blank = document.createElement('iframe'); blank.id = 'blank-frame'; document.body.prepend(blank);
      const srcdoc = document.createElement('iframe'); srcdoc.id = 'srcdoc-frame';
      srcdoc.srcdoc = '<input id="inside"><p id="inside-status">Ready</p>'; document.body.prepend(srcdoc);
    });
    for (const [id, url] of [['blank-frame', 'about:blank'], ['srcdoc-frame', 'about:srcdoc']]) {
      const handle = await page.locator(`#${id}`).elementHandle(), frame = await handle.contentFrame();
      await frame.waitForFunction(url => location.href === url && window.chrome?.runtime && document.body, url);
      assert.equal(await frame.evaluate(() => !!window.__wbPageMonitor), false, 'Model the Firefox document_start omission');
      if (url === 'about:blank') await frame.evaluate(() => { document.body.innerHTML = '<input id="inside"><p id="inside-status">Ready</p>'; });
      await frame.addScriptTag({ content: read('firefox', 'content/page-monitor-shadow.js') });
      await frame.addScriptTag({ content: recovery });
      await frame.waitForFunction(() => __wbPageMonitor && document.documentElement.hasAttribute('data-webbrain-page-revision'));
      await frame.locator('#inside').fill('Private input');
      await frame.waitForFunction(() => feedback.some(event => event.kind === 'input' && event.source === 'user'));
      assert.ok(!(JSON.stringify(await frame.evaluate(() => feedback))).includes('Private input'));
      await frame.evaluate(() => { document.getElementById('inside-status').textContent = 'Page changed'; });
      await frame.waitForFunction(() => feedback.some(event => event.kind === 'dom'));
      await frame.evaluate(() => {
        const host = document.createElement('div'); host.id = 'late-frame-host'; document.body.append(host);
      });
      await frame.waitForTimeout(200);
      await frame.evaluate(() => {
        feedback = []; document.getElementById('late-frame-host').attachShadow({ mode: 'open' }).innerHTML = '<button id="late-frame-target">New target</button>';
      });
      await frame.waitForFunction(() => feedback.some(event => event.kind === 'dom' && event.target === 'div#late-frame-host'), null, { timeout: FEEDBACK_WAIT_MS });
      await frame.evaluate(() => { feedback = []; document.getElementById('late-frame-host').shadowRoot.querySelector('button').textContent = 'Updated target'; });
      await frame.waitForFunction(() => feedback.some(event => event.kind === 'dom' && event.target === 'button#late-frame-target'), null, { timeout: FEEDBACK_WAIT_MS });
    }
  } finally { await browser.close(); }
});

test('Chrome selector scrolling claims input only at the actual page mutation', { timeout: scaled(30000) }, async () => {
  const savedChrome = globalThis.chrome, savedBrowser = globalThis.browser, tab = 912;
  const host = Object.assign({ isRunning: () => true, _checkAbort: () => false }, pageFeedbackMethods);
  let browser, page, session, pauseMethod = '', entered, resume;
  const registrations = [];
  const api = { runtime: {}, tabs: {
    get: async () => ({ url: 'https://monitor.test/start' }),
    sendMessage: async (_tab, msg) => {
      if (!page) return {};
      if (msg.action === 'page_monitor_dispatch') registrations.push(msg.params);
      return page.evaluate(msg => new Promise(resolve => messageListeners.forEach(fn => fn(msg, {}, resolve))), msg);
    },
  }, debugger: { sendCommand(_source, method, params, callback) {
    void (async () => {
      if (method === pauseMethod) {
        pauseMethod = ''; entered(); await new Promise(resolve => { resume = resolve; });
      }
      return await session.send(method, params);
    })().then(callback, error => { api.runtime.lastError = { message: error.message }; callback(); delete api.runtime.lastError; });
  } } };
  globalThis.chrome = api; delete globalThis.browser;
  try {
    await host._beginPageFeedbackRun(tab, 'interactive');
    ({ browser, page } = await fixture(chromium, 'chrome', { runToken: host._pageFeedbackRuns.get(tab).token }));
    const documentToken = await page.evaluate(() => document.documentElement.getAttribute('data-webbrain-page-revision').split(':')[0]);
    host.pageMonitorState({ tab: { id: tab }, frameId: 0 }, documentToken);
    await page.exposeFunction('feedbackToHost', feedback => host.observePageFeedback({ tab: { id: tab }, frameId: 0 }, feedback));
    await page.exposeFunction('monitorStateFromHost', token => host.pageMonitorState({ tab: { id: tab }, frameId: 0 }, token));
    await page.evaluate(() => {
      const original = chrome.runtime.sendMessage;
      chrome.runtime.sendMessage = async message => {
        if (message.action === 'get_page_monitor_state') return await monitorStateFromHost(message.documentToken);
        const response = await original(message);
        return message.action === 'page_feedback' ? await feedbackToHost(message.feedback) : response;
      };
    });
    session = await page.context().newCDPSession(page);
    const client = new CDPClient(); client.sessions.set(tab, { attached: true });
    const reset = async () => {
      host._finishPageFeedbackRun(tab);
      await page.waitForTimeout(20);
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.waitForTimeout(100);
      await host._beginPageFeedbackRun(tab, 'interactive');
      registrations.length = 0;
      await page.evaluate(() => { feedback = []; });
    };
    for (const scenario of [
      { method: 'Runtime.enable', selector: '#agent', options: { scroll: false, retries: 0 }, readOnly: true },
      { method: 'DOM.getDocument', selector: '#missing', options: { retries: 1, delayMs: 0 } },
      { method: 'Runtime.evaluate', selector: '#agent', options: { retries: 0 } },
    ]) {
      await reset(); pauseMethod = scenario.method;
      const paused = new Promise(resolve => { entered = resolve; });
      const resolving = client.resolveSelector(tab, scenario.selector, scenario.options)
        .then(value => ({ value }), error => ({ code: error.code }));
      await paused;
      await page.evaluate(() => window.scrollTo(0, 600));
      await page.waitForFunction(() => feedback.some(event => event.kind === 'scroll'), null, { timeout: FEEDBACK_WAIT_MS });
      assert.ok(registrations.every(mark => mark.fenceOnly === true), 'A resolver cannot claim scroll while a DOM search is pending');
      resume(); resume = null;
      const result = await resolving;
      if (scenario.readOnly) {
        assert.equal(result.value.found, true); assert.equal(registrations.length, 0);
      } else assert.equal(result.code, 'page_feedback_pending', `${scenario.method} must preserve the external intervention`);
      assert.equal(await page.evaluate(() => scrollY), 600, 'A stale resolver must not scroll back to its target');
    }
    await reset();
    await page.evaluate(() => {
      for (const mode of ['open', 'closed']) {
        const el = document.createElement('div');
        el.attachShadow({ mode }).innerHTML = `<button id="deep-${mode}">Deep target</button>`;
        document.body.append(el);
      }
    });
    await page.waitForTimeout(200);
    for (const mode of ['open', 'closed']) {
      await reset();
      const result = await client.resolveSelector(tab, `#deep-${mode}`, { retries: 0 });
      assert.equal(result.found, true); assert.equal(result.inViewport, true);
      await page.waitForTimeout(200);
      assert.ok(await page.evaluate(() => scrollY > 1000), `${mode} target must actually scroll into view`);
      assert.deepEqual(await page.evaluate(() => feedback), [], `${mode} agent scroll must not trigger a feedback loop`);
    }
  } finally {
    resume?.(); host._finishPageFeedbackRun(tab);
    await browser?.close(); globalThis.chrome = savedChrome; globalThis.browser = savedBrowser;
  }
});

for (const siteIsolation of [false, true]) {
  test(`Chrome CDP input reaches the receiving iframe monitor (site isolation: ${siteIsolation})`, { timeout: scaled(30000) }, async () => {
    const savedChrome = globalThis.chrome, savedBrowser = globalThis.browser;
    const frames = new Map(), sessions = new Map(), registrations = [];
    const tab = siteIsolation ? 910 : 909;
    let browser, context, rootSession;
    const host = Object.assign({ isRunning: () => true, _checkAbort: () => false }, pageFeedbackMethods);
    const api = { runtime: {}, tabs: {
      get: async () => ({ url: 'https://monitor.test/start' }),
      sendMessage: async (_tab, message, options = {}) => {
        const frame = frames.get(options.frameId || 0);
        if (!frame) return {};
        if (message.action === 'page_monitor_dispatch') registrations.push(options.frameId || 0);
        return frame.evaluate(msg => new Promise(resolve => {
          for (const listener of messageListeners) listener(msg, {}, resolve);
        }), message);
      },
    }, debugger: { sendCommand(source, method, params, callback) {
      void (async () => {
        if (method === 'Target.attachToTarget') {
          for (const frame of frames.values()) {
            if (!frame.parentFrame()) continue;
            const session = await context.newCDPSession(frame);
            const tree = await session.send('Page.getFrameTree');
            if (tree.frameTree.frame.id === params.targetId) {
              const sessionId = `test-child-${sessions.size}`;
              sessions.set(sessionId, session); return { sessionId };
            }
            await session.detach();
          }
          throw new Error('Missing child target');
        }
        if (method === 'Target.detachFromTarget') {
          await sessions.get(params.sessionId).detach(); sessions.delete(params.sessionId); return {};
        }
        return (sessions.get(source.sessionId) || rootSession).send(method, params);
      })().then(callback, error => {
        api.runtime.lastError = { message: error.message }; callback(); delete api.runtime.lastError;
      });
    } } };
    globalThis.chrome = api; delete globalThis.browser;
    try {
      await host._beginPageFeedbackRun(tab, 'interactive');
      const fixtureResult = await fixture(chromium, 'chrome', { siteIsolation, runToken: host._pageFeedbackRuns.get(tab).token });
      ({ browser, context } = fixtureResult);
      const page = fixtureResult.page;
      await context.route('https://child.monitor.test/**', route => route.fulfill({ contentType: 'text/html', body: html }));
      const navigation = page.waitForEvent('framenavigated', { predicate: frame => frame.url().includes('child.monitor.test') });
      await page.evaluate(() => {
        const frame = document.createElement('iframe'); frame.src = 'https://child.monitor.test/frame';
        frame.style.cssText = 'position:absolute;left:400px;top:20px;width:450px;height:450px';
        document.body.appendChild(frame);
      });
      const child = await navigation;
      await child.waitForFunction(() => window.__wbPageMonitor && document.documentElement.hasAttribute('data-webbrain-page-revision'));
      await page.waitForTimeout(200);
      frames.set(0, page.mainFrame()); frames.set(2, child);
      for (const [frameId, frame] of frames) {
        const documentToken = await frame.evaluate(() => document.documentElement.getAttribute('data-webbrain-page-revision').split(':')[0]);
        host.pageMonitorState({ tab: { id: tab }, frameId }, documentToken);
        await frame.evaluate(() => { feedback = []; });
      }
      rootSession = await context.newCDPSession(page);
      const client = new CDPClient(); client.sessions.set(tab, { attached: true });
      await child.evaluate(() => document.getElementById('agent').addEventListener('pointerover', () => {
        document.getElementById('status').textContent = 'Hover changed this';
      }, { once: true }));
      const hover = await child.locator('#agent').boundingBox();
      await client.dispatchMouseEvent(tab, 'mouseMoved', hover.x + hover.width / 2, hover.y + hover.height / 2);
      await child.waitForFunction(() => document.getElementById('status').textContent === 'Hover changed this');
      await child.waitForTimeout(200);
      assert.deepEqual(await child.evaluate(() => feedback), [], 'CDP pointer-entry handlers must remain agent-attributed');
      const rect = await child.locator('#field').boundingBox();
      await client.dispatchMouseEvent(tab, 'mousePressed', rect.x + 8, rect.y + 8);
      await client.dispatchMouseEvent(tab, 'mouseReleased', rect.x + 8, rect.y + 8);
      await client.sendCommand(tab, 'Input.insertText', { text: 'agent' });
      assert.equal(await child.locator('#field').inputValue(), 'agent');
      assert.deepEqual(registrations, [2, 2, 2, 2]);
      const container = await child.locator('#container').boundingBox();
      await client.sendCommand(tab, 'Input.dispatchMouseEvent', { type: 'mouseWheel', x: container.x + 20, y: container.y + 20,
        deltaX: 0, deltaY: 100 });
      await child.waitForFunction(() => document.getElementById('container').scrollTop > 0);
      assert.equal(registrations.at(-1), 2);
      for (const frame of frames.values()) assert.equal((await frame.evaluate(() => feedback)).some(event => event.source !== 'agent'), false);
      await page.keyboard.insertText('human');
      const userEvents = (await child.evaluate(() => feedback)).filter(event => event.source === 'user');
      assert.ok(userEvents.length);
      for (const event of userEvents) host.observePageFeedback({ tab: { id: tab }, frameId: 2 }, event);
      await assert.rejects(client.sendCommand(tab, 'Input.insertText', { text: 'stale' }), { code: 'page_feedback_pending' });
      assert.equal(await child.locator('#field').inputValue(), 'agenthuman');
    } finally {
      host._finishPageFeedbackRun(tab);
      if (browser) await browser.close();
      globalThis.chrome = savedChrome; globalThis.browser = savedBrowser;
    }
  });
}

test('Firefox native preparation keeps same-target user edits and sends no stale keys', async () => {
  const { FirefoxBidiClient } = await import('../src/firefox/src/bidi/client.js');
  const { pageFeedbackMethods: methods } = await import('../src/firefox/src/agent/page-feedback.js');
  const { browser, page } = await fixture(firefox, 'firefox');
  const savedChrome = globalThis.chrome, savedBrowser = globalThis.browser;
  const tab = 960, runId = crypto.randomUUID(), token = crypto.randomUUID(), session = new BidiSession();
  const host = { ...methods, isRunning: () => true, _checkAbort: () => false };
  let releasePreparation, startPreparation, inputs = 0;
  const entered = new Promise(resolve => { startPreparation = resolve; });
  const release = new Promise(resolve => { releasePreparation = resolve; });
  const api = { tabs: { get: async () => ({ url: page.url() }), sendMessage: async (_tab, message) => page.evaluate(message => {
    deliver(message.action, message.params || {}); return lastMonitorResponse;
  }, message) } };
  globalThis.chrome = api; globalThis.browser = api;
  const client = new FirefoxBidiClient(api);
  session.runs.set(runId, { context: 'tab' });
  session.locate = async () => { startPreparation(); await release; return { context: 'tab', node: { sharedId: 'field' } }; };
  session.call = async (_match, declaration, args = []) => ({ result: { value: await page.evaluate(({ declaration, args }) =>
    (0, eval)(`(${declaration})`)(document.getElementById('field'), ...args.map(arg => arg.value)), { declaration, args }) } });
  session.send = async method => { if (method === 'input.performActions') inputs++; return {}; };
  client.runs.set(tab, { runId, bound: true });
  client.request = async (_command, args) => session.perform(args.runId, args.action, args.payload);
  try {
    await host._beginPageFeedbackRun(tab, 'interactive');
    const runToken = host._pageFeedbackRuns.get(tab).token;
    await page.evaluate(runToken => { monitorRunToken = runToken; monitorEnabled = false; deliver('page_monitor_state'); monitorEnabled = true; deliver('page_monitor_state'); }, runToken);
    await page.waitForTimeout(200);
    const documentToken = await page.evaluate(() => document.documentElement.getAttribute('data-webbrain-page-revision').split(':')[0]);
    const from = { tab: { id: tab }, frameId: 0 };
    host.pageMonitorState(from, documentToken);
    await page.evaluate(token => document.getElementById('field').setAttribute('data-webbrain-bidi', token), token);
    await page.locator('#field').focus();
    const action = client.perform(tab, 'type', { token, selector: '#field', text: 'agent', clear: false });
    await entered;
    await page.keyboard.insertText('human');
    for (const event of await page.evaluate(() => feedback)) host.observePageFeedback(from, event);
    releasePreparation();
    await assert.rejects(action, error => error.code === 'page_feedback_pending' && error.dispatchState.noDispatch === true);
    assert.equal(inputs, 0);
    assert.equal(host._hasPendingPageFeedback(tab), true);
    assert.equal(await page.locator('#field').inputValue(), 'human');
  } finally {
    releasePreparation(); await session.close(); host._finishPageFeedbackRun(tab); await browser.close();
    globalThis.chrome = savedChrome; globalThis.browser = savedBrowser;
  }
});

test('Firefox repeated native Tab marks the deeply focused control across shadow boundaries', async () => {
  const { page, browser } = await fixture(firefox, 'firefox');
  const savedChrome = globalThis.chrome, savedBrowser = globalThis.browser;
  const { pageFeedbackMethods: methods } = await import('../src/firefox/src/agent/page-feedback.js');
  const tab = 961, runId = crypto.randomUUID(), token = crypto.randomUUID(), operationId = 'shadow-tab-operation', session = new BidiSession();
  const host = { ...methods, isRunning: () => true, _checkAbort: () => false };
  const api = { tabs: {
    get: async () => ({ url: page.url() }),
    sendMessage: async (_tab, message) => page.evaluate(message => {
      deliver(message.action, message.params || {}); return lastMonitorResponse;
    }, message),
  }, webNavigation: { getAllFrames: async () => [{ frameId: 0 }] } };
  globalThis.chrome = api; globalThis.browser = api;
  session.runs.set(runId, { context: 'tab' });
  session.locate = async () => ({ context: 'tab', node: { sharedId: 'shadow-field' } });
  session.call = async (_match, declaration, args = []) => ({ result: { value: await page.evaluate(({ declaration, args }) => {
    const el = document.getElementById('tab-shadow-host').shadowRoot.getElementById('shadow-field');
    return (0, eval)(`(${declaration})`)(el, ...args.map(arg => arg.value));
  }, { declaration, args }) } });
  session.send = async method => { if (method === 'input.performActions') await page.keyboard.press('Tab'); return {}; };
  try {
    await page.evaluate(() => {
      const shadowHost = document.createElement('div'); shadowHost.id = 'tab-shadow-host';
      shadowHost.style.cssText = 'position:fixed;left:10px;top:120px';
      shadowHost.attachShadow({ mode: 'open' }).innerHTML = '<input id="shadow-field">';
      const first = document.createElement('input'); first.id = 'outside-shadow-first';
      first.style.cssText = 'position:fixed;left:10px;top:160px';
      const second = document.createElement('input'); second.id = 'outside-shadow-second';
      second.style.cssText = 'position:fixed;left:10px;top:200px';
      document.body.append(shadowHost, first, second);
    });
    await page.waitForTimeout(180);
    await host._beginPageFeedbackRun(tab, 'interactive');
    const runToken = host._pageFeedbackRuns.get(tab).token;
    await page.evaluate(token => {
      monitorEnabled = false; deliver('page_monitor_state');
      monitorRunToken = token; monitorEnabled = true; deliver('page_monitor_state');
    }, runToken);
    await page.waitForTimeout(100);
    const documentToken = await page.evaluate(() => document.documentElement.getAttribute('data-webbrain-page-revision').split(':')[0]);
    host.pageMonitorState({ tab: { id: tab }, frameId: 0 }, documentToken);
    await page.evaluate(operationId => {
      feedback = [];
      const element = document.getElementById('tab-shadow-host').shadowRoot.getElementById('shadow-field');
      const params = { operationId, tool: 'press_keys', element };
      deliver('page_monitor_prepare', params);
      deliver('page_monitor_dispatch', { ...params, kind: 'input', fenceOnly: true });
    }, operationId);
    const guard = await page.evaluate(() => lastMonitorResponse.guard);
    assert.ok(guard?.nativeSecret, 'the prepared action should carry the monitor capability');
    await page.evaluate(token => document.getElementById('tab-shadow-host').shadowRoot.getElementById('shadow-field')
      .setAttribute('data-webbrain-bidi', token), token);
    await page.locator('#tab-shadow-host').evaluate(hostElement => hostElement.shadowRoot.getElementById('shadow-field').focus());

    const result = await session.perform(runId, 'key', { token, key: 'Tab', repeat: 2, pageFeedbackGuard: guard },
      async (_id, received, kind, rebindFocus) => (await api.tabs.sendMessage(tab, { target: 'content', action: 'page_monitor_validate',
        params: { ...received, kind, rebindFocus } }, { frameId: 0 }))?.ready === true);
    assert.equal(result.success, true);
    assert.equal(await page.evaluate(() => document.activeElement.id), 'outside-shadow-second',
      'both native Tab presses should follow the focus across the shadow boundary');
    assert.equal((await page.evaluate(() => feedback)).some(event => event.source !== 'agent'), false,
      'rebound native input must not be reported as a user intervention');
    assert.equal(await page.evaluate(() => [...document.querySelectorAll('[data-webbrain-native-action]'),
      ...document.getElementById('tab-shadow-host').shadowRoot.querySelectorAll('[data-webbrain-native-action]')].length), 0,
      'consumed native markers must be removed');
  } finally {
    await session.close();
    if (host._pageFeedbackRuns.has(tab)) host._finishPageFeedbackRun(tab);
    if (savedChrome === undefined) delete globalThis.chrome; else globalThis.chrome = savedChrome;
    if (savedBrowser === undefined) delete globalThis.browser; else globalThis.browser = savedBrowser;
    await browser.close();
  }
});

for (const [build, engine] of [['chrome', chromium], ['firefox', firefox]]) {
  test(`${build}: synthetic local form input stays attributed to its dispatch`, async () => {
    const source = read(build, 'content/content.js');
    const typeStart = source.indexOf('async function _typeTextInner(');
    const findTextStart = source.indexOf('\n  function findText(', typeStart);
    assert.ok(typeStart >= 0 && findTextStart > typeStart);
    assert.equal((source.slice(typeStart, findTextStart).match(/withLocalPageDispatch\(\(\) => \{/g) || []).length, 2,
      `${build}: both native form and select setters must include their synthetic events in the local dispatch`);
    const helper = source.match(/^  function withLocalPageDispatch\(callback\) \{[\s\S]*?^  \}/m)?.[0];
    assert.ok(helper, `${build}: local input events must use the production monitor boundary`);

    const { browser, page } = await fixture(engine, build);
    try {
      await page.addScriptTag({ content: `window.withLocalPageDispatch = ${helper};` });
      for (const [selector, tag, value] of [['#field', 'input', 'agent-synthetic-value'], ['#select', 'select', 'B']]) {
        await page.evaluate(() => { feedback = []; });
        await page.evaluate(({ selector, tag, value }) => {
          const field = document.querySelector(selector);
          const finish = __wbPageMonitor.beginContentAction('type', { selector });
          try {
            withLocalPageDispatch(() => {
              const prototype = tag === 'select' ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
              Object.getOwnPropertyDescriptor(prototype, 'value').set.call(field, value);
              field.dispatchEvent(new Event('input', { bubbles: true }));
              field.dispatchEvent(new Event('change', { bubbles: true }));
            });
          } finally { finish(); }
        }, { selector, tag, value });
        await page.waitForTimeout(220);
        const events = await page.evaluate(() => feedback);
        assert.equal(events.some(event => event.source !== 'agent'), false, `${build}: synthetic ${tag} events must not become page feedback`);
        assert.equal(JSON.stringify(events).includes(value), false, `${build}: page feedback must not include form values`);
      }
    } finally { await browser.close(); }
  });

  test(`${build}: local synthetic clicks attribute checkbox changes and navigation`, async () => {
    const source = read(build, 'content/content.js');
    const clickStart = source.indexOf('function clickElement(params, actionDeadlineExpired = () => false)');
    const typeStart = source.indexOf('function typeText(params, actionDeadlineExpired = () => false)', clickStart);
    const clickAxStart = source.indexOf("'click_ax':");
    const checkedStart = source.indexOf("'set_checked':", clickAxStart);
    const typeAxStart = source.indexOf("'type_ax':", checkedStart);
    assert.ok(clickStart >= 0 && typeStart > clickStart && clickAxStart >= 0 && checkedStart > clickAxStart && typeAxStart > checkedStart);
    for (const body of [source.slice(clickStart, typeStart), source.slice(clickAxStart, checkedStart), source.slice(checkedStart, typeAxStart)]) {
      assert.match(body, /withLocalPageDispatch\(\(\) => \{[\s\S]*?el\.click\(\)/,
        `${build}: every synthetic click path must keep the monitor's local dispatch scope active`);
    }
    const helper = source.match(/^  function withLocalPageDispatch\(callback\) \{[\s\S]*?^  \}/m)?.[0];
    assert.ok(helper, `${build}: synthetic clicks must use the production local dispatch boundary`);

    const { browser, page } = await fixture(engine, build);
    try {
      await page.evaluate(() => {
        document.body.insertAdjacentHTML('beforeend', '<input id="local-click-checkbox" type="checkbox"><input id="local-checked-checkbox" type="checkbox"><a id="local-click-link" href="#local-click-destination">Continue</a>');
      });
      await page.waitForTimeout(160);
      await page.addScriptTag({ content: `window.withLocalPageDispatch = ${helper};` });
      const events = await page.evaluate(() => {
        feedback = [];
        const actions = [
          ['click', document.getElementById('local-click-link')],
          ['click_ax', document.getElementById('local-click-checkbox')],
          ['set_checked', document.getElementById('local-checked-checkbox')],
        ];
        for (const [action, target] of actions) {
          const finish = __wbPageMonitor.beginContentAction(action, { selector: '#' + target.id });
          try { withLocalPageDispatch(() => target.click()); }
          finally { finish(); }
        }
        return new Promise(resolve => setTimeout(() => resolve(feedback), 150));
      });
      assert.ok(events.some(event => event.source === 'agent' && event.operation === 'click'
        && event.navigationUrl === 'https://monitor.test/start#local-click-destination'),
      `${build}: a synthetic link click must arm its agent navigation`);
      assert.equal(events.some(event => event.source !== 'agent'), false,
        `${build}: synthetic checkbox changes must not be reported as page/user feedback`);
      assert.equal(await page.locator('#local-click-checkbox').isChecked(), true);
      assert.equal(await page.locator('#local-checked-checkbox').isChecked(), true);
    } finally { await browser.close(); }
  });

  test(`${build}: click-driven programmatic focus checks the monitor fence before focusin`, () => {
    const source = read(build, 'content/content.js');
    const clickStart = source.indexOf('function clickElement(params, actionDeadlineExpired = () => false)');
    const typeStart = source.indexOf('function typeText(params, actionDeadlineExpired = () => false)', clickStart);
    assert.ok(clickStart >= 0 && typeStart > clickStart, `${build}: click/type content action boundaries should be present`);
    const clickBody = source.slice(clickStart, typeStart);
    for (const [target, expected] of [['inp', 2], ['target', 1], ['sel', 1], ['el', 1], ['nearbySel', 1]]) {
      const focusCount = [...clickBody.matchAll(new RegExp(`\\b${target}\\.focus\\(\\)`, 'g'))].length;
      const marker = target === 'target'
        ? /beforeLocalDispatch\(\{ kind: 'focus', target \}\);\s*target\.focus\(\)/g
        : new RegExp(`beforeLocalDispatch\\(\\{ kind: 'focus', target: ${target} \\}\\);\\s*${target}\\.focus\\(\\)`, 'g');
      const guardedCount = [...clickBody.matchAll(marker)].length;
      assert.equal(focusCount, expected, `${build}: clickElement should account for ${expected} ${target}.focus() calls`);
      assert.equal(guardedCount, focusCount,
        `${build}: each ${target}.focus() must pass through the prepared dispatch boundary first`);
    }
  });

  test(`${build}: accessibility click actions attribute preparatory focus before focusin`, async () => {
    const source = read(build, 'content/content.js');
    const clickAxStart = source.indexOf("'click_ax':");
    const checkedStart = source.indexOf("'set_checked':", clickAxStart);
    const typeAxStart = source.indexOf("'type_ax':", checkedStart);
    assert.ok(clickAxStart >= 0 && checkedStart > clickAxStart && typeAxStart > checkedStart);
    for (const body of [source.slice(clickAxStart, checkedStart), source.slice(checkedStart, typeAxStart)]) {
      assert.match(body, /beforeLocalDispatch\(\{ preparation: true, kind: 'focus', target: el \}\);\s*try \{ el\.focus\(\{ preventScroll: true \}\); \} catch \{\}/,
        `${build}: click_ax and set_checked must fence focus before invoking it`);
    }

    const { browser, page } = await fixture(engine, build);
    try {
      await page.evaluate(() => {
        const checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.id = 'prepared-checkbox';
        document.body.append(checkbox);
      });
      await page.waitForTimeout(160);
      const results = await page.evaluate(() => {
        feedback = [];
        const actions = [
          ['click_ax', document.getElementById('human')],
          ['set_checked', document.getElementById('prepared-checkbox')],
        ];
        return actions.map(([action, target]) => {
          const finish = __wbPageMonitor.beginContentAction(action, { selector: '#' + target.id });
          let code = null;
          try {
            __wbPageMonitor.beforeLocalDispatch({ preparation: true, kind: 'focus', target });
            target.focus({ preventScroll: true });
            __wbPageMonitor.beforeLocalDispatch();
          } catch (error) { code = error.code || error.message; }
          finally { finish(); }
          return { action, code };
        });
      });
      assert.deepEqual(results, [{ action: 'click_ax', code: null }, { action: 'set_checked', code: null }]);
      assert.deepEqual(await page.evaluate(() => feedback), [], 'Programmatic focus preparation must not create page feedback');
    } finally { await browser.close(); }
  });

  test(`${build}: content-script recovery preserves a live page monitor`, async () => {
    const { browser, page } = await fixture(engine, build);
    try {
      await page.waitForFunction(() => window.__wbPageMonitor?.active === true);
      await page.evaluate(() => { window.monitorBeforeRecovery = window.__wbPageMonitor; feedback = []; });
      await page.addScriptTag({ content: read(build, 'content/page-monitor.js') });
      await page.waitForTimeout(200);
      assert.deepEqual(await page.evaluate(() => ({
        same: window.__wbPageMonitor === window.monitorBeforeRecovery,
        active: window.__wbPageMonitor?.active,
      })), { same: true, active: true });
      await page.evaluate(() => { feedback = []; document.getElementById('status').textContent = 'Monitor survived recovery'; });
      await page.waitForFunction(() => feedback.some(event => event.kind === 'dom'), null, { timeout: FEEDBACK_WAIT_MS });
    } finally { await browser.close(); }
  });

  test(`${build}: CSSOM layout shifts fence prepared coordinate clicks`, async () => {
    const { browser, page } = await fixture(engine, build);
    try {
      await page.evaluate(() => {
        feedback = [];
        const rect = document.getElementById('agent').getBoundingClientRect();
        const x = rect.left + rect.width / 2, y = rect.top + rect.height / 2;
        window.layoutClickPoint = { x, y };
        deliver('page_monitor_prepare', { operationId: 'layout-click', tool: 'click', x, y });
        deliver('page_monitor_dispatch', { operationId: 'layout-click', kind: 'click', x, y, fenceOnly: true });
        const sheet = document.styleSheets[0];
        sheet.insertRule('#agent { margin-top: 100px; }', sheet.cssRules.length);
      });
      await page.waitForTimeout(200);
      if (build === 'chrome') await page.waitForFunction(() => feedback.some(event => event.kind === 'dom'), null, { timeout: FEEDBACK_WAIT_MS });
      const response = await page.evaluate(() => new Promise(resolve => {
        deliver('page_monitor_dispatch', { operationId: 'layout-click', kind: 'click', ...layoutClickPoint });
        setTimeout(() => resolve(lastMonitorResponse), 0);
      }));
      assert.equal(response.pageFeedbackPending, true, 'A CSSOM-only layout shift must invalidate the old click point');
      await page.waitForFunction(() => feedback.some(event => event.kind === 'dom' && event.source === 'page'), null, { timeout: FEEDBACK_WAIT_MS });
      const localResult = await page.evaluate(() => {
        feedback = [];
        const rect = document.getElementById('human').getBoundingClientRect();
        const finish = __wbPageMonitor.beginContentAction('click', { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 });
        document.styleSheets[0].insertRule('#human { transform: translateY(80px) !important; }', document.styleSheets[0].cssRules.length);
        let code, dispatched;
        try { __wbPageMonitor.beforeLocalDispatch(); }
        catch (error) { code = error.code; dispatched = error.dispatched; }
        finally { finish(); }
        return { code, dispatched };
      });
      assert.deepEqual(localResult, { code: 'page_feedback_pending', dispatched: false },
        'The local content-action path must reject a moved coordinate before dispatch');
      await page.waitForFunction(() => feedback.some(event => event.kind === 'dom' && event.source === 'page'), null, { timeout: FEEDBACK_WAIT_MS });
    } finally { await browser.close(); }
  });

  test(`${build}: CSSOM visibility changes fence prepared target clicks`, async () => {
    const { browser, page } = await fixture(engine, build);
    try {
      await page.evaluate(() => {
        feedback = [];
        deliver('page_monitor_prepare', { operationId: 'cssom-hidden-target', tool: 'click', selector: '#agent' });
        deliver('page_monitor_dispatch', { operationId: 'cssom-hidden-target', kind: 'click', selector: '#agent', fenceOnly: true });
        document.styleSheets[0].insertRule('#agent { opacity: 0 !important; }', document.styleSheets[0].cssRules.length);
      });
      await page.waitForFunction(() => feedback.some(event => event.kind === 'dom' && event.source === 'page'), null, { timeout: FEEDBACK_WAIT_MS });
      const blocked = await page.evaluate(() => {
        try {
          __wbPageMonitor.activatePreparedDispatch({ operationId: 'cssom-hidden-target', kind: 'click',
            element: document.getElementById('agent') });
          return null;
        } catch (error) { return error.code; }
      });
      assert.equal(blocked, 'page_feedback_pending', 'A CSSOM-only visibility change must invalidate the prepared target');
    } finally { await browser.close(); }
  });

  test(`${build}: data-selected changes report the custom listbox value and fence prepared actions`, async () => {
    const { browser, page } = await fixture(engine, build);
    try {
      await page.evaluate(() => {
        const listbox = document.createElement('div');
        listbox.id = 'custom-listbox'; listbox.setAttribute('role', 'listbox');
        listbox.innerHTML = '<div id="option-first" role="option" data-selected="true">First</div>'
          + '<div id="option-second" role="option">Second</div>';
        document.body.append(listbox);
      });
      await page.waitForFunction(() => feedback.some(event => event.kind === 'dom'), null, { timeout: FEEDBACK_WAIT_MS });
      await page.waitForTimeout(180);
      await page.evaluate(() => {
        feedback = [];
        deliver('page_monitor_prepare', { operationId: 'listbox-selected', tool: 'click', selector: '#custom-listbox' });
        deliver('page_monitor_dispatch', { operationId: 'listbox-selected', kind: 'click', selector: '#custom-listbox', fenceOnly: true });
        document.getElementById('option-first').removeAttribute('data-selected');
        document.getElementById('option-second').setAttribute('data-selected', 'true');
      });
      await page.waitForFunction(() => feedback.some(event => event.kind === 'dom' && event.source === 'page'), null, { timeout: FEEDBACK_WAIT_MS });
      const observation = await page.evaluate(() => feedback.find(event => event.kind === 'dom'));
      assert.equal(observation.target, 'div#custom-listbox [listbox]', 'Feedback should identify the model-visible listbox value');
      const blocked = await page.evaluate(() => {
        try { __wbPageMonitor.activatePreparedDispatch({ operationId: 'listbox-selected', kind: 'click' }); return null; }
        catch (error) { return error.code; }
      });
      assert.equal(blocked, 'page_feedback_pending', 'Changing the selected option must stale a prepared action');
    } finally { await browser.close(); }
  });

  test(`${build}: selected native option label edits invalidate the owning select`, async () => {
    const { browser, page } = await fixture(engine, build);
    try {
      await page.evaluate(() => {
        const select = document.createElement('select'); select.id = 'native-option-label-select';
        select.innerHTML = '<option value="stable-choice" selected>Initial choice</option><option value="other">Other choice</option>';
        document.body.append(select);
      });
      await page.waitForTimeout(300);
      const guard = await page.evaluate(() => {
        feedback = [];
        deliver('page_monitor_prepare', { operationId: 'native-option-label', tool: 'click', selector: '#native-option-label-select' });
        deliver('page_monitor_dispatch', { operationId: 'native-option-label', kind: 'click', selector: '#native-option-label-select', fenceOnly: true });
        document.querySelector('#native-option-label-select option:checked').textContent = 'Updated choice';
        return lastMonitorResponse.guard;
      });
      await page.waitForFunction(() => feedback.some(event => event.kind === 'dom'
        && event.target === 'select#native-option-label-select'), null, { timeout: FEEDBACK_WAIT_MS });
      assert.equal(await page.locator('#native-option-label-select').evaluate(select => select.value), 'stable-choice',
        'The native value remains stable while the model-visible selected label changes');
      assert.equal(JSON.stringify(await page.evaluate(() => feedback)).includes('Updated choice'), false,
        'Selected option labels must not be copied into feedback');
      const accepted = await page.evaluate(value => window.dispatchEvent(new CustomEvent('webbrain-agent-dom-dispatch', {
        detail: JSON.stringify({ ...value, dispatchPhase: 'click' }), cancelable: true,
      })), guard);
      assert.equal(accepted, false, 'Editing the selected option label must stale the prepared select action');
    } finally { await browser.close(); }
  });

  test(`${build}: fenced iframe clicks reject transport-gap input and attribute the dispatched click`, async () => {
    const { browser, page } = await fixture(engine, build);
    try {
      await page.evaluate(() => {
        feedback = [];
        deliver('page_monitor_prepare', { operationId: 'iframe-click-stale', tool: 'click', selector: '#human' });
        deliver('page_monitor_dispatch', { operationId: 'iframe-click-stale', kind: 'click', selector: '#human', fenceOnly: true });
      });
      await page.locator('#human').click();
      await page.waitForFunction(() => feedback.some(event => event.kind === 'click' && event.source === 'user'), null, { timeout: FEEDBACK_WAIT_MS });
      const blocked = await page.evaluate(() => {
        try {
          __wbPageMonitor.activatePreparedDispatch({ operationId: 'iframe-click-stale', kind: 'click',
            element: document.getElementById('human'), navigationCandidate: true });
          return null;
        } catch (error) { return { code: error.code, dispatched: error.dispatched }; }
      });
      assert.deepEqual(blocked, { code: 'page_feedback_pending', dispatched: false },
        'The remote script must not claim a physical click received during the transport gap');

      await page.waitForTimeout(200);
      const accepted = await page.evaluate(() => {
        feedback = [];
        deliver('page_monitor_prepare', { operationId: 'iframe-click-live', tool: 'click', selector: '#agent' });
        deliver('page_monitor_dispatch', { operationId: 'iframe-click-live', kind: 'click', selector: '#agent', fenceOnly: true });
        try {
          __wbPageMonitor.activatePreparedDispatch({ operationId: 'iframe-click-live', kind: 'click',
            element: document.getElementById('agent'), navigationCandidate: true });
          __wbPageMonitor.withPreparedDispatch('iframe-click-live', () => document.getElementById('agent').click());
          return true;
        } catch { return false; }
      });
      assert.equal(accepted, true, 'An unchanged prepared target can activate immediately before the click');
      await page.waitForTimeout(200);
      assert.ok((await page.evaluate(() => feedback)).every(event => event.source === 'agent'
        && event.kind === 'activity' && event.operation === 'click'),
      'The activated script click may correlate navigation but must not be reported as a user/page change');
      assert.equal(await page.locator('#status').textContent(), 'Agent changed this');
    } finally { await browser.close(); }
  });

  if (build === 'chrome') test('Chrome iframe fallback validates a stale target before scrolling it', async () => {
    const { browser, page } = await fixture(chromium, 'chrome');
    try {
      const source = read('chrome', 'agent/agent.js');
      const marker = 'func: (sel, matchIndex, monitorGuard) => {';
      const start = source.indexOf(marker);
      const endMarker = '\n          },\n          args: [selector, requestedMatchIndex, dispatchGuard],';
      const end = source.indexOf(endMarker, start);
      assert.ok(start >= 0 && end > start, 'Find the content-script-unavailable iframe click fallback');
      const declaration = source.slice(start + 'func: '.length, end + '\n          }'.length);
      await page.evaluate(code => { window.__iframeFallback = eval(`(${code})`); }, declaration);
      await page.evaluate(() => {
        const old = document.createElement('button'); old.id = 'stale-iframe-target'; old.textContent = 'Old target';
        document.body.append(old);
      });
      // Observe setup feedback instead of racing the monitor's 150ms debounce.
      await page.waitForFunction(() => feedback.some(event => event.kind === 'dom' && event.source === 'page'),
        null, { timeout: FEEDBACK_WAIT_MS });
      const preparation = await page.evaluate(async () => {
        feedback = [];
        const request = (action, params) => new Promise(resolve => messageListeners.forEach(fn => fn({
          target: 'content', action, params: { runToken: monitorRunToken, ...params },
        }, {}, resolve)));
        const prepare = await request('page_monitor_prepare', { operationId: 'stale-iframe-click',
          tool: 'click', selector: '#stale-iframe-target' });
        const dispatch = await request('page_monitor_dispatch', { operationId: 'stale-iframe-click', kind: 'click',
          selector: '#stale-iframe-target', fenceOnly: true });
        return { prepare, dispatch };
      });
      assert.equal(preparation.prepare.ready, true);
      assert.equal(preparation.dispatch.ready, true, JSON.stringify(preparation.dispatch));
      const guard = preparation.dispatch.guard;
      assert.equal(guard.operationId, 'stale-iframe-click');
      const outcome = await page.evaluate(monitorGuard => {
        document.getElementById('stale-iframe-target').remove();
        const replacement = document.createElement('button');
        replacement.id = 'stale-iframe-target'; replacement.textContent = 'Replacement';
        window.scrollAttempts = 0;
        replacement.scrollIntoView = () => { window.scrollAttempts++; };
        document.body.append(replacement);
        const result = window.__iframeFallback('#stale-iframe-target', 0, monitorGuard);
        return { scrollAttempts: window.scrollAttempts, result };
      }, guard);
      assert.equal(outcome.scrollAttempts, 0, 'A replacement must be rejected before it can trigger page scrolling');
      assert.equal(outcome.result.dispatched, false);
      assert.match(outcome.result.error, /changed during action preparation/i);
    } finally { await browser.close(); }
  });

  test(`${build}: large ancestor style changes stop descendant sampling at its cap`, async () => {
    const { browser, page } = await fixture(engine, build);
    try {
      await page.evaluate(() => {
        monitorEnabled = false; deliver('page_monitor_state');
        const large = document.createElement('section');
        large.innerHTML = '<span></span>'.repeat(250);
        document.body.append(large);
        monitorEnabled = true; deliver('page_monitor_state');
      });
      await page.waitForTimeout(100);
      await page.evaluate(() => {
        const original = Element.prototype.querySelectorAll;
        let count = 0;
        Element.prototype.querySelectorAll = function (selector) {
          if (this === document.body && selector === '*') count++;
          return original.call(this, selector);
        };
        window.wholeSubtreeQueryCount = () => count;
        feedback = [];
        document.body.classList.add('large-page-state-change');
      });
      await page.waitForFunction(() => feedback.some(event => event.kind === 'dom' && event.source === 'page'), null, { timeout: FEEDBACK_WAIT_MS });
      assert.equal(await page.evaluate(() => wholeSubtreeQueryCount()), 0,
        'A common-ancestor mutation must not materialize its complete descendant list before applying the cap');
    } finally { await browser.close(); }
  });

  test(`${build}: direct shadow-root text changes reach the host feedback target`, async () => {
    const { browser, page } = await fixture(engine, build);
    try {
      await page.evaluate(() => {
        const host = document.createElement('div'); host.id = 'shadow-text-host';
        host.attachShadow({ mode: 'open' }).append(document.createTextNode('Initial result'));
        document.body.append(host);
      });
      await page.waitForTimeout(150);
      await page.evaluate(() => {
        feedback = [];
        deliver('page_monitor_prepare', { operationId: 'shadow-text', tool: 'execute_js' });
        deliver('page_monitor_dispatch', { operationId: 'shadow-text', kind: 'dom', fenceOnly: true });
        document.getElementById('shadow-text-host').shadowRoot.firstChild.data = 'Updated result without an element wrapper';
      });
      await page.waitForFunction(() => feedback.some(event => event.kind === 'dom'
        && event.source === 'page' && event.target === 'div#shadow-text-host'), null, { timeout: FEEDBACK_WAIT_MS });
      const blocked = await page.evaluate(() => new Promise(resolve => {
        deliver('page_monitor_dispatch', { operationId: 'shadow-text', kind: 'dom' });
        setTimeout(() => resolve(lastMonitorResponse), 0);
      }));
      assert.equal(blocked.pageFeedbackPending, true, 'The text-node mutation must invalidate the prepared revision');
      assert.equal(JSON.stringify(await page.evaluate(() => feedback)).includes('Updated result'), false,
        'Feedback identifies the host without copying page text');
    } finally { await browser.close(); }
  });

  test(`${build}: native option selection mutations invalidate prepared state`, async () => {
    const { browser, page } = await fixture(engine, build);
    try {
      await page.evaluate(() => {
        const select = document.createElement('select'); select.id = 'state-select';
        select.innerHTML = '<option>First</option><option id="second-option">Second</option>';
        document.body.append(select);
      });
      await page.waitForTimeout(150);
      await page.evaluate(() => {
        feedback = [];
        deliver('page_monitor_prepare', { operationId: 'select-state', tool: 'click', selector: '#agent' });
        deliver('page_monitor_dispatch', { operationId: 'select-state', kind: 'click', selector: '#agent', fenceOnly: true });
        document.getElementById('second-option').setAttribute('selected', '');
      });
      await page.waitForFunction(() => feedback.some(event => event.kind === 'dom'
        && event.source === 'page' && event.target === 'select#state-select'), null, { timeout: FEEDBACK_WAIT_MS });
      const blocked = await page.evaluate(() => new Promise(resolve => {
        deliver('page_monitor_dispatch', { operationId: 'select-state', kind: 'click', selector: '#agent' });
        setTimeout(() => resolve(lastMonitorResponse), 0);
      }));
      assert.equal(blocked.pageFeedbackPending, true, 'Changing defaultSelected must not leave the observed select state current');
    } finally { await browser.close(); }
  });

  test(`${build}: opacity-only visibility changes invalidate prepared actions`, async () => {
    const { browser, page } = await fixture(engine, build);
    try {
      await page.evaluate(() => {
        feedback = [];
        deliver('page_monitor_prepare', { operationId: 'opacity-click', tool: 'click', selector: '#agent' });
        deliver('page_monitor_dispatch', { operationId: 'opacity-click', kind: 'click', selector: '#agent', fenceOnly: true });
        document.body.style.opacity = '0';
      });
      await page.waitForFunction(() => feedback.some(event => event.kind === 'dom' && event.source === 'page'), null, { timeout: FEEDBACK_WAIT_MS });
      const response = await page.evaluate(() => new Promise(resolve => {
        deliver('page_monitor_dispatch', { operationId: 'opacity-click', kind: 'click', selector: '#agent' });
        setTimeout(() => resolve(lastMonitorResponse), 0);
      }));
      assert.equal(response.pageFeedbackPending, true, 'An ancestor opacity change must hide its descendants from prepared state');
    } finally { await browser.close(); }
  });

  test(`${build}: base URL changes invalidate prepared relative navigation`, async () => {
    const { browser, page } = await fixture(engine, build);
    try {
      await page.evaluate(() => {
        const base = document.createElement('base'); base.id = 'page-base'; base.href = '/before/';
        const link = document.createElement('a'); link.id = 'relative-link'; link.href = 'next'; link.textContent = 'Continue';
        document.head.append(base); document.body.append(link);
      });
      await page.waitForFunction(() => feedback.some(event => event.kind === 'dom'));
      await page.waitForTimeout(180);
      const guard = await page.evaluate(() => {
        feedback = [];
        deliver('page_monitor_prepare', { operationId: 'relative-navigation', tool: 'click', selector: '#relative-link' });
        deliver('page_monitor_dispatch', { operationId: 'relative-navigation', kind: 'click', selector: '#relative-link', fenceOnly: true });
        return lastMonitorResponse.guard;
      });
      await page.locator('#page-base').evaluate(el => el.setAttribute('href', '/after/'));
      await page.waitForFunction(() => feedback.some(event => event.kind === 'dom' && event.target === 'html'), null, { timeout: FEEDBACK_WAIT_MS });
      const accepted = await page.evaluate(value => window.dispatchEvent(new CustomEvent('webbrain-agent-dom-dispatch', {
        detail: JSON.stringify({ ...value, dispatchPhase: 'click' }), cancelable: true,
      })), guard);
      assert.equal(accepted, false, 'Changing the base URL must stale relative link destinations');
    } finally { await browser.close(); }
  });

  test(`${build}: visibility signatures are rechecked after animations and transitions settle`, async () => {
    const { browser, page } = await fixture(engine, build);
    try {
      await page.evaluate(() => {
        const style = document.createElement('style');
        style.textContent = `@keyframes hide-target { to { opacity: 0; } }
          #animated-target { opacity: 1; }
          #animated-target.hide { animation: hide-target 120ms linear forwards; }
          #transition-target { opacity: 1; transition: opacity 120ms linear; }
          #transition-target.hide { opacity: 0; }
          #mixed-transition { opacity: 1; transition: opacity 400ms linear; }
          #mixed-container.hide #mixed-hidden { visibility: hidden; }
          #mixed-container.hide #mixed-transition { opacity: 0; }`;
        const animated = document.createElement('button'); animated.id = 'animated-target'; animated.textContent = 'Animated target';
        const transitioned = document.createElement('button'); transitioned.id = 'transition-target'; transitioned.textContent = 'Transition target';
        const mixed = document.createElement('div'); mixed.id = 'mixed-container';
        mixed.innerHTML = '<button id="mixed-hidden">Hidden sibling</button><button id="mixed-transition">Animated sibling</button>';
        const shadowHost = document.createElement('div'); shadowHost.id = 'shadow-host';
        const shadow = shadowHost.attachShadow({ mode: 'open' });
        shadow.innerHTML = `<style>@keyframes shadow-hide { to { opacity: 0; } } #shadow-target.hide { animation: shadow-hide 120ms linear forwards; }</style>
          <button id="shadow-target">Shadow target</button>`;
        document.head.append(style); document.body.append(animated, transitioned, mixed, shadowHost);
      });
      await page.waitForFunction(() => feedback.some(event => event.kind === 'dom'));
      await page.waitForTimeout(180);
      for (const id of ['animated-target', 'transition-target']) {
        const guard = await page.evaluate(targetId => {
          feedback = [];
          deliver('page_monitor_prepare', { operationId: targetId, tool: 'click', selector: `#${targetId}` });
          deliver('page_monitor_dispatch', { operationId: targetId, kind: 'click', selector: `#${targetId}`, fenceOnly: true });
          return lastMonitorResponse.guard;
        }, id);
        await page.locator(`#${id}`).evaluate(el => el.classList.add('hide'));
        await page.waitForFunction(targetId => feedback.some(event => event.kind === 'dom' && event.target === `button#${targetId}`), id,
          { timeout: FEEDBACK_WAIT_MS });
        const accepted = await page.evaluate(value => window.dispatchEvent(new CustomEvent('webbrain-agent-dom-dispatch', {
          detail: JSON.stringify({ ...value, dispatchPhase: 'click' }), cancelable: true,
        })), guard);
        assert.equal(accepted, false, `${id} must invalidate the prepared click after its final hidden state`);
      }
      await page.evaluate(() => {
        feedback = [];
        document.getElementById('shadow-host').shadowRoot.getElementById('shadow-target').classList.add('hide');
      });
      await page.waitForFunction(() => feedback.some(event => event.kind === 'dom' && event.target === 'button#shadow-target'), null,
        { timeout: FEEDBACK_WAIT_MS });

      const mixedGuard = await page.evaluate(() => {
        feedback = [];
        deliver('page_monitor_prepare', { operationId: 'mixed-animation', tool: 'click', selector: '#mixed-hidden' });
        deliver('page_monitor_dispatch', { operationId: 'mixed-animation', kind: 'click', selector: '#mixed-hidden', fenceOnly: true });
        return lastMonitorResponse.guard;
      });
      await page.locator('#mixed-container').evaluate(el => el.classList.add('hide'));
      await page.waitForFunction(revision => Number(document.documentElement.getAttribute('data-webbrain-page-revision').split(':').at(-1)) > revision,
        mixedGuard.revision, { timeout: 500 });
      const mixedAccepted = await page.evaluate(value => window.dispatchEvent(new CustomEvent('webbrain-agent-dom-dispatch', {
        detail: JSON.stringify({ ...value, dispatchPhase: 'click' }), cancelable: true,
      })), mixedGuard);
      assert.equal(mixedAccepted, false, 'A transition on one descendant must not defer checks for hidden siblings');
      await page.waitForFunction(revision => Number(document.documentElement.getAttribute('data-webbrain-page-revision').split(':').at(-1)) > revision + 1,
        mixedGuard.revision, { timeout: FEEDBACK_WAIT_MS });
    } finally { await browser.close(); }
  });

  test(`${build}: page focus theft fences a selectorless input while the identified agent target stays quiet`, async () => {
    const { browser, page } = await fixture(engine, build);
    try {
      await page.evaluate(() => {
        document.getElementById('field').focus();
        monitorEnabled = false; deliver('page_monitor_state'); monitorEnabled = true; deliver('page_monitor_state');
      });
      await page.waitForTimeout(200);
      await page.evaluate(() => {
        feedback = [];
        deliver('page_monitor_prepare', { operationId: 'selectorless-type', tool: 'type_text' });
        deliver('page_monitor_dispatch', { operationId: 'selectorless-type', kind: 'input', fenceOnly: true });
        document.getElementById('secret').focus();
      });
      await page.waitForFunction(() => feedback.some(event => event.kind === 'activity'
        && event.source === 'page' && event.target === 'input#secret'), null, { timeout: FEEDBACK_WAIT_MS });
      const observed = await page.evaluate(() => feedback);
      assert.equal(JSON.stringify(observed).includes('password-never-recorded'), false);
      const blocked = await page.evaluate(() => new Promise(resolve => {
        deliver('page_monitor_dispatch', { operationId: 'selectorless-type', kind: 'input' });
        setTimeout(() => resolve(lastMonitorResponse), 0);
      }));
      assert.equal(blocked.pageFeedbackPending, true);

      await page.evaluate(() => {
        monitorEnabled = false; deliver('page_monitor_state'); document.getElementById('field').focus();
        monitorEnabled = true; deliver('page_monitor_state');
      });
      await page.waitForTimeout(100);
      const accepted = await page.evaluate(() => {
        feedback = []; deliver('page_monitor_prepare', { operationId: 'agent-focus', tool: 'type_text', selector: '#field' });
        deliver('page_monitor_dispatch', { operationId: 'agent-focus', kind: 'input', fenceOnly: true });
        document.getElementById('field').blur(); document.getElementById('field').focus();
        return lastMonitorResponse;
      });
      assert.equal(accepted.ready, true);
      await page.waitForTimeout(200);
      assert.deepEqual(await page.evaluate(() => feedback), [], 'The active operation may focus its exact prepared target without looping');
    } finally { await browser.close(); }
  });

  test(`${build}: mutation batches over the inspection cap invalidate pending actions`, async () => {
    const { browser, page } = await fixture(engine, build);
    try {
      await page.evaluate(() => {
        const hidden = document.createElement('div'); hidden.style.display = 'none';
        hidden.innerHTML = '<span></span>'.repeat(320); document.body.prepend(hidden);
      });
      await page.waitForTimeout(200);
      const result = await page.evaluate(async () => {
        feedback = [];
        const finish = __wbPageMonitor.beginContentAction('click', { selector: '#agent', _bidiPrepare: true });
        for (const [index, node] of [...document.querySelectorAll('body > div[style*="display: none"] span')].entries())
          node.setAttribute('aria-label', `hidden ${index}`);
        document.getElementById('status').textContent = 'Visible tail mutation';
        await Promise.resolve();
        let code; try { __wbPageMonitor.beforeLocalDispatch(); } catch (error) { code = error.code; } finally { finish(); }
        return { code, events: feedback };
      });
      assert.equal(result.code, 'page_feedback_pending');
      await page.waitForFunction(() => feedback.some(event => event.kind === 'dom' && event.source === 'unknown'), null, { timeout: FEEDBACK_WAIT_MS });
      assert.equal(JSON.stringify(result.events).includes('Visible tail mutation'), false);
      assert.equal(JSON.stringify(await page.evaluate(() => feedback)).includes('Visible tail mutation'), false);

      await page.evaluate(() => {
        feedback = [];
        deliver('page_monitor_prepare', { operationId: 'agent-large-write', tool: 'execute_js' });
        deliver('page_monitor_dispatch', { operationId: 'agent-large-write', kind: 'dom' });
        document.dispatchEvent(new CustomEvent('webbrain-agent-dom-dispatch', { detail: JSON.stringify(lastMonitorResponse.guard) }));
        for (const [index, node] of [...document.querySelectorAll('body > div[style*="display: none"] span')].entries())
          node.setAttribute('aria-label', `agent hidden ${index}`);
        document.getElementById('status').textContent = 'Agent visible tail mutation';
      });
      await page.waitForTimeout(200);
      assert.equal((await page.evaluate(() => feedback)).some(event => event.kind === 'dom' && event.source !== 'agent'), false,
        'Overflow in a marked agent write keeps the event attributable instead of creating page feedback');
    } finally { await browser.close(); }
  });

  test(`${build}: a pointer gesture ending on owned UI releases the background idle gate`, async () => {
    const savedChrome = globalThis.chrome, savedBrowser = globalThis.browser, tab = 945;
    const host = Object.assign({ isRunning: () => true, _checkAbort: () => false, _runAbortSignal: () => null,
      _throwIfAborted: () => {}, _pageFeedbackIdleMs: 20 }, pageFeedbackMethods);
    globalThis.chrome = { runtime: {}, tabs: { get: async () => ({ url: 'https://monitor.test/start' }), sendMessage: async () => ({ ready: true }) } };
    delete globalThis.browser;
    let browser;
    try {
      await host._beginPageFeedbackRun(tab, 'interactive');
      const state = await fixture(engine, build, { runToken: host._pageFeedbackRuns.get(tab).token });
      browser = state.browser; const { page } = state;
      const documentToken = await page.evaluate(() => document.documentElement.getAttribute('data-webbrain-page-revision').split(':')[0]);
      const sender = { tab: { id: tab }, frameId: 0 }; host.pageMonitorState(sender, documentToken);
      await page.exposeFunction('feedbackToHost', feedback => host.observePageFeedback(sender, feedback));
      await page.evaluate(() => {
        const original = chrome.runtime.sendMessage;
        chrome.runtime.sendMessage = async message => {
          const response = await original(message);
          return message.action === 'page_feedback' ? await feedbackToHost(message.feedback) : response;
        };
        const ui = document.createElement('div'); ui.id = 'owned-capture';
        ui.style.cssText = 'position:fixed;top:440px;left:20px;width:200px;height:80px;background:red';
        __wbPageMonitor.registerDecoration(ui); document.body.append(ui);
        document.getElementById('human').addEventListener('pointerdown', event => ui.setPointerCapture(event.pointerId));
        feedback = [];
      });
      const button = await page.locator('#human').boundingBox();
      await page.mouse.move(button.x + button.width / 2, button.y + button.height / 2); await page.mouse.down();
      await page.waitForFunction(() => feedback.some(event => event.interacting === true));
      assert.ok(host._pageFeedbackRuns.get(tab).gestures.has(0));
      await page.mouse.move(100, 480); await page.mouse.up();
      await page.waitForFunction(() => feedback.some(event => event.kind === 'activity' && event.interacting === false), null, { timeout: FEEDBACK_WAIT_MS });
      assert.equal(host._pageFeedbackRuns.get(tab).gestures.size, 0);
      assert.ok(!JSON.stringify(await page.evaluate(() => feedback)).includes('owned-capture'), 'Owned UI must remain absent from event targets');
      await host._waitForPageFeedbackIdle(tab);
    } finally { host._finishPageFeedbackRun(tab); await browser?.close(); globalThis.chrome = savedChrome; globalThis.browser = savedBrowser; }
  });

  test(`${build}: popover transitions fence actions in light/shadow DOM without agent feedback loops`, async () => {
    const { browser, page } = await fixture(engine, build);
    try {
      await page.evaluate(() => {
        const popup = document.createElement('div'); popup.id = 'light-popup'; popup.popover = 'auto'; popup.innerHTML = '<button>Popup target</button>';
        document.body.prepend(popup);
        const host = document.createElement('div'); host.id = 'popup-host'; document.body.prepend(host);
        host.attachShadow({ mode: 'open' }).innerHTML = '<div id="shadow-popup" popover><button>Shadow target</button></div>';
        window.popups = [popup, host.shadowRoot.querySelector('[popover]')];
        const filler = document.createElement('div'); filler.style.display = 'none'; filler.innerHTML = '<span>Outside signature budget</span>'.repeat(650);
        document.body.prepend(filler);
        monitorEnabled = false; deliver('page_monitor_state'); monitorEnabled = true; deliver('page_monitor_state');
      });
      await page.waitForTimeout(200);
      for (const index of [0, 1]) {
        await page.evaluate(index => {
          monitorEnabled = false; deliver('page_monitor_state'); popups[index].showPopover();
          monitorEnabled = true; deliver('page_monitor_state');
        }, index);
        await page.waitForTimeout(200);
        const initialClose = await page.evaluate(async index => {
          feedback = []; const finish = __wbPageMonitor.beginContentAction('click', { selector: '#agent', _bidiPrepare: true });
          popups[index].hidePopover(); await Promise.resolve();
          try { __wbPageMonitor.beforeLocalDispatch(); return null; } catch (error) { return error.code; } finally { finish(); }
        }, index);
        assert.equal(initialClose, 'page_feedback_pending', 'Closing an initially open unseeded popover must invalidate actions');
        await page.waitForFunction(() => feedback.some(event => event.kind === 'dom'), null, { timeout: FEEDBACK_WAIT_MS });
        for (const open of [true, false]) {
          const code = await page.evaluate(async ({ index, open }) => {
            feedback = []; const finish = __wbPageMonitor.beginContentAction('click', { selector: '#agent', _bidiPrepare: true });
            popups[index][open ? 'showPopover' : 'hidePopover'](); await Promise.resolve();
            try { __wbPageMonitor.beforeLocalDispatch(); return null; } catch (error) { return error.code; } finally { finish(); }
          }, { index, open });
          assert.equal(code, 'page_feedback_pending');
          await page.waitForFunction(() => feedback.some(event => event.kind === 'dom'), null, { timeout: FEEDBACK_WAIT_MS });
        }
        await page.evaluate(index => {
          feedback = []; const finish = __wbPageMonitor.beginContentAction('execute_js');
          try { __wbPageMonitor.beforeLocalDispatch(); popups[index].showPopover(); } finally { finish(); }
        }, index);
        await page.waitForTimeout(220);
        assert.deepEqual(await page.evaluate(() => feedback), [], 'An agent-opened popover must not feed back during the later toggle task');
        await page.evaluate(index => { popups[index].querySelector('button').focus(); feedback = []; }, index);
        await page.keyboard.press('Escape');
        await page.waitForFunction(index => !popups[index].matches(':popover-open') && feedback.some(event => event.kind === 'dom'), index, { timeout: FEEDBACK_WAIT_MS });
        assert.ok((await page.evaluate(() => feedback)).some(event => event.source === 'user' && event.kind === 'activity'));
        await page.waitForTimeout(200);
        const cancelled = await page.evaluate(async index => {
          feedback = []; popups[index].addEventListener('beforetoggle', event => event.preventDefault(), { once: true });
          const finish = __wbPageMonitor.beginContentAction('click', { selector: '#agent', _bidiPrepare: true });
          popups[index].showPopover(); await Promise.resolve();
          try { __wbPageMonitor.beforeLocalDispatch({ preparation: true }); return true; } catch { return false; } finally { finish(); }
        }, index);
        assert.equal(cancelled, true, 'A canceled opening must not invalidate the unchanged page');
        await page.waitForTimeout(220); assert.deepEqual(await page.evaluate(() => feedback), []);
      }
      await page.evaluate(() => { monitorEnabled = false; deliver('page_monitor_state'); feedback = []; popups[0].showPopover(); });
      await page.waitForTimeout(200); assert.deepEqual(await page.evaluate(() => feedback), []);
    } finally { await browser.close(); }
  });

  test(`${build}: related data/blob frames receive monitor and MAIN shadow hook`, async () => {
    const { browser, page } = await fixture(engine, build, { omitEmptyFrameMonitor: true });
    try {
      const manifest = JSON.parse(fs.readFileSync(new URL(`../src/${build}/manifest.json`, import.meta.url), 'utf8'));
      const entries = manifest.content_scripts.filter(entry => entry.run_at === 'document_start'
        && entry.js.some(file => /\/page-monitor(?:-shadow)?\.js$/.test(file)));
      assert.equal(entries.length, 2);
      for (const entry of entries) assert.ok(entry.all_frames && entry.match_origin_as_fallback,
        'Related opaque-origin documents need origin fallback for both execution worlds');
      await page.evaluate(() => {
        const markup = '<input id="inside"><p id="inside-status">Ready</p><div id="late-host"></div>';
        for (const [id, src] of [['data-frame', `data:text/html,${encodeURIComponent(markup)}`],
          ['blob-frame', URL.createObjectURL(new Blob([markup], { type: 'text/html' }))]]) {
          const frame = document.createElement('iframe'); frame.id = id; frame.src = src; document.body.prepend(frame);
        }
      });
      for (const [id, scheme] of [['data-frame', 'data:'], ['blob-frame', 'blob:']]) {
        const frame = await (await page.locator(`#${id}`).elementHandle()).contentFrame();
        await frame.waitForFunction(scheme => location.href.startsWith(scheme) && window.chrome?.runtime && document.getElementById('inside'), scheme);
        assert.equal(await frame.evaluate(() => !!window.__wbPageMonitor), false);
        // Model the manifest's related-origin registration, not Playwright's unconditional init-script injection.
        for (const entry of entries) for (const file of entry.js.filter(file => /\/page-monitor(?:-shadow)?\.js$/.test(file)))
          await frame.addScriptTag({ content: read(build, file.replace(/^src\//, '')) });
        await frame.waitForFunction(() => document.documentElement.hasAttribute('data-webbrain-page-revision'));
        const preparation = await frame.evaluate(() => {
          const finish = __wbPageMonitor.beginContentAction('type', { selector: '#inside', _bidiPrepare: true });
          try { __wbPageMonitor.beforeLocalDispatch(); return true; } finally { finish(); }
        });
        assert.equal(preparation, true, 'Document and local action tokens must work in related origins');
        await frame.waitForTimeout(220);
        await frame.locator('#inside').fill('Private frame input');
        await frame.waitForFunction(() => feedback.some(event => event.kind === 'input' && event.source === 'user'));
        assert.ok(!JSON.stringify(await frame.evaluate(() => feedback)).includes('Private frame input'));
        await frame.evaluate(() => { feedback = []; document.getElementById('inside-status').textContent = 'Updated'; });
        await frame.waitForFunction(() => feedback.some(event => event.kind === 'dom'));
        await frame.evaluate(() => { feedback = []; document.getElementById('late-host').attachShadow({ mode: 'open' }).innerHTML = '<button>Target</button>'; });
        await frame.waitForFunction(() => feedback.some(event => event.kind === 'dom' && event.target === 'div#late-host'));
        await frame.evaluate(() => { feedback = []; document.getElementById('late-host').shadowRoot.querySelector('button').textContent = 'Changed'; });
        await frame.waitForFunction(() => feedback.some(event => event.kind === 'dom' && event.target === 'button'));
      }
    } finally { await browser.close(); }
  });

  test(`${build}: Tab focus movement invalidates preparation without recording keys`, async () => {
    const { browser, page } = await fixture(engine, build);
    try {
      for (const key of ['Tab', 'Shift+Tab']) {
        await page.locator('#human').focus();
        const before = await page.evaluate(() => {
          monitorEnabled = false; deliver('page_monitor_state'); monitorEnabled = true; deliver('page_monitor_state');
          return document.activeElement.id;
        });
        await page.waitForTimeout(40);
        await page.evaluate(() => {
          feedback = []; window.finishPreparation = __wbPageMonitor.beginContentAction('type', { _bidiPrepare: true });
        });
        await page.keyboard.press(key);
        assert.notEqual(await page.evaluate(() => document.activeElement.id), before);
        const code = await page.evaluate(() => {
          try { __wbPageMonitor.beforeLocalDispatch(); return null; }
          catch (error) { return error.code; }
          finally { finishPreparation(); }
        });
        assert.equal(code, 'page_feedback_pending');
        const events = await page.evaluate(() => feedback);
        assert.ok(events.some(event => event.kind === 'activity' && event.source === 'user'));
        assert.ok(!JSON.stringify(events).includes('Tab'));
      }
      await page.locator('#human').focus();
      await page.evaluate(() => {
        monitorEnabled = false; deliver('page_monitor_state'); monitorEnabled = true; deliver('page_monitor_state');
      });
      await page.waitForTimeout(40);
      await page.evaluate(() => {
        feedback = []; deliver('page_monitor_prepare', { operationId: 'agent-tab', tool: 'press_keys', selector: '#human' });
        deliver('page_monitor_dispatch', { operationId: 'agent-tab', kind: 'input', selector: '#human', fenceOnly: true });
      });
      const tabGuard = await page.evaluate(() => lastMonitorResponse.guard);
      await page.evaluate(marker => document.getElementById('human').setAttribute('data-webbrain-native-action', marker),
        createNativeActionMarker(tabGuard, 'input', 1));
      await page.keyboard.press('Tab');
      await page.waitForTimeout(80);
      assert.equal((await page.evaluate(() => feedback)).some(event => event.source !== 'agent'), false,
        'An attributed native Tab must not steer its own run');
      const rebound = await page.evaluate(guard => {
        deliver('page_monitor_validate', { ...guard, kind: 'input', rebindFocus: true });
        return lastMonitorResponse.ready;
      }, tabGuard);
      assert.equal(rebound, true, 'A validated follow-up Tab should bind to the newly focused control');
      await page.evaluate(marker => document.activeElement.setAttribute('data-webbrain-native-action', marker),
        createNativeActionMarker(tabGuard, 'input', 2));
      await page.keyboard.press('Tab');
      await page.waitForTimeout(80);
      assert.equal((await page.evaluate(() => feedback)).some(event => event.source !== 'agent'), false,
        'The second Tab must remain attributed after native focus moves');
    } finally { await browser.close(); }
  });

  test(`${build}: monitor captures user input without values, suppresses agent input and keeps concurrent user input`, async () => {
    const { browser, page } = await fixture(engine, build);
    try {
      await page.locator('#field').fill('private-field-value');
      await page.locator('#secret').fill('password-never-recorded');
      await page.locator('#select').selectOption('B');
      const input = await page.evaluate(() => feedback);
      assert.ok(input.some(event => event.kind === 'input' && event.source === 'user'));
      assert.equal(JSON.stringify(input).includes('private-field-value'), false);
      assert.equal(JSON.stringify(input).includes('password-never-recorded'), false);
      await page.waitForTimeout(1100);

      await page.evaluate(() => {
        feedback = [];
        deliver('page_monitor_prepare', { operationId: 'agent-click', tool: 'click', selector: '#agent' });
        deliver('page_monitor_dispatch', { operationId: 'agent-click', kind: 'click', selector: '#agent' });
      });
      assert.equal((await page.evaluate(() => feedback)).some(event => event.operation === 'click'), false,
        'A prepared click must not claim navigation before any page input occurs');
      await page.locator('#agent').click();
      await page.waitForTimeout(200);
      const own = await page.evaluate(() => feedback);
      assert.ok(own.some(event => event.source === 'agent' && event.operation === 'click'),
        'The actual matching click must supply navigation correlation');
      assert.equal(own.some(event => event.source !== 'agent'), false, JSON.stringify(own));
      await page.locator('#agent').click();
      assert.ok((await page.evaluate(() => feedback)).some(event => event.kind === 'click' && event.source === 'user'
        && event.target === 'button#agent'), 'A later human click on the same target must survive attribution');
      await page.locator('#human').click();
      assert.ok((await page.evaluate(() => feedback)).some(event => event.source === 'user' && event.target === 'button#human'));
      await page.waitForTimeout(1100);

      await page.evaluate(() => {
        feedback = [];
        deliver('page_monitor_prepare', { operationId: 'agent-type', tool: 'type_text', selector: '#field' });
        deliver('page_monitor_dispatch', { operationId: 'agent-type', kind: 'input', selector: '#field' });
      });
      await page.locator('#field').focus();
      await page.keyboard.insertText('agent-text');
      const ownTyping = await page.evaluate(() => feedback);
      assert.equal(ownTyping.some(event => event.source !== 'agent'), false, JSON.stringify(ownTyping));
      await page.locator('#human').click();
      assert.ok((await page.evaluate(() => feedback)).some(event => event.source === 'user'));
      await page.waitForTimeout(1100);
      await page.evaluate(() => {
        feedback = [];
        deliver('page_monitor_prepare', { operationId: 'click-with-external-dom', tool: 'click', selector: '#agent' });
        deliver('page_monitor_dispatch', { operationId: 'click-with-external-dom', kind: 'click', selector: '#agent' });
        document.getElementById('agent').textContent = 'External DOM change on the same target';
      });
      await page.waitForFunction(() => feedback.some(event => event.kind === 'dom'));
      assert.ok((await page.evaluate(() => feedback)).some(event => event.kind === 'dom' && event.source !== 'agent'),
        'A dispatched click must not silence unrelated DOM writes on its target');
    } finally { await browser.close(); }
  });

  test(`${build}: property-only form changes invalidate the prepared page without exposing values`, async () => {
    const { browser, page } = await fixture(engine, build);
    try {
      await page.evaluate(() => {
        const dense = document.createElement('div');
        dense.innerHTML = `${'<span></span>'.repeat(650)}<input id="late-control">`;
        document.body.append(dense);
      });
      await page.waitForFunction(() => feedback.some(event => event.kind === 'dom'), null, { timeout: FEEDBACK_WAIT_MS });
      await page.evaluate(() => { feedback = []; document.getElementById('late-control').value = 'late-private-value'; });
      await page.waitForFunction(() => feedback.some(event => event.kind === 'dom'), null, { timeout: FEEDBACK_WAIT_MS });
      assert.equal(JSON.stringify(await page.evaluate(() => feedback)).includes('late-private-value'), false,
        'Controls beyond the layout-sampling budget still receive bounded state monitoring');

      await page.evaluate(() => {
        feedback = [];
        document.getElementById('field').value = 'private-property-only-value';
        document.getElementById('select').selectedIndex = 1;
        const check = document.createElement('input'); check.type = 'checkbox'; check.id = 'property-check';
        document.body.append(check); check.checked = true;
      });
      await page.waitForFunction(() => feedback.some(event => event.kind === 'dom'), null, { timeout: FEEDBACK_WAIT_MS });
      const observed = await page.evaluate(() => feedback);
      assert.equal(JSON.stringify(observed).includes('private-property-only-value'), false);
      assert.ok(observed.some(event => event.kind === 'dom' && event.source === 'page'));

      const result = await page.evaluate(() => {
        feedback = [];
        deliver('page_monitor_prepare', { operationId: 'property-preflight', tool: 'click', selector: '#agent' });
        document.getElementById('field').value = 'changed-during-preparation';
        try { __wbPageMonitor.activatePreparedDispatch({ operationId: 'property-preflight', kind: 'click' }); return null; }
        catch (error) { return error.code; }
      });
      assert.equal(result, 'page_feedback_pending', 'The final dispatch check must sample property-only changes');
      assert.equal(JSON.stringify(await page.evaluate(() => feedback)).includes('changed-during-preparation'), false);
    } finally { await browser.close(); }
  });

  test(`${build}: dispatch preflight samples its form target beyond the round-robin batch`, async () => {
    const { browser, page } = await fixture(engine, build);
    try {
      const result = await page.evaluate(async () => {
        const controls = document.createElement('div');
        controls.innerHTML = `${'<input>'.repeat(450)}<input id="prepared-tail-control">`;
        document.body.append(controls);
        await Promise.resolve();
        feedback = [];
        deliver('page_monitor_prepare', { operationId: 'late-form-target', tool: 'click', selector: '#prepared-tail-control' });
        document.getElementById('prepared-tail-control').value = 'private-late-value';
        try { __wbPageMonitor.activatePreparedDispatch({ operationId: 'late-form-target', kind: 'click' }); return null; }
        catch (error) { return error.code; }
      });
      assert.equal(result, 'page_feedback_pending', 'The target control must be checked even when it falls outside the current batch');
      assert.equal(JSON.stringify(await page.evaluate(() => feedback)).includes('private-late-value'), false);
    } finally { await browser.close(); }
  });

  test(`${build}: ARIA value changes invalidate prepared controls`, async () => {
    const { browser, page } = await fixture(engine, build);
    try {
      await page.evaluate(() => {
        const slider = document.createElement('div');
        slider.id = 'custom-slider'; slider.setAttribute('role', 'slider');
        slider.setAttribute('aria-valuenow', '10'); slider.setAttribute('aria-valuetext', 'Ten');
        document.body.append(slider);
      });
      await page.waitForTimeout(100);
      await page.evaluate(() => {
        feedback = [];
        const slider = document.getElementById('custom-slider');
        slider.setAttribute('aria-valuenow', '20'); slider.setAttribute('aria-valuetext', 'Twenty');
      });
      await page.waitForFunction(() => feedback.some(event => event.kind === 'dom' && event.source === 'page'), null, { timeout: FEEDBACK_WAIT_MS });
      assert.equal(JSON.stringify(await page.evaluate(() => feedback)).includes('Twenty'), false,
        'ARIA value text is observed internally but is not copied into feedback');
    } finally { await browser.close(); }
  });

  test(`${build}: native select input does not emit a delayed duplicate option change`, async () => {
    const { browser, page } = await fixture(engine, build);
    try {
      await page.evaluate(() => { feedback = []; });
      await page.locator('#select').selectOption('B');
      await page.waitForFunction(() => feedback.some(event => event.kind === 'input'), null, { timeout: FEEDBACK_WAIT_MS });
      await page.waitForTimeout(350);
      const observed = await page.evaluate(() => feedback);
      assert.equal(observed.some(event => event.kind === 'dom' && event.target === 'option'), false,
        'Sampling the option property after its user input must not replan the run a second time');
    } finally { await browser.close(); }
  });

  test(`${build}: native markers reject replay, tampering and copied targets`, async () => {
    const { browser, page } = await fixture(engine, build);
    try {
      const guard = await page.evaluate(() => {
        deliver('page_monitor_prepare', { operationId: 'native-target', tool: 'type_text', selector: '#field' });
        deliver('page_monitor_dispatch', { operationId: 'native-target', kind: 'input', selector: '#field', fenceOnly: true });
        feedback = []; return lastMonitorResponse.guard;
      });
      const copiedMarker = createNativeActionMarker(guard, 'input', 1);
      await page.evaluate(marker => document.getElementById('secret').setAttribute('data-webbrain-native-action', marker), copiedMarker);
      await page.locator('#secret').fill('target-must-stay-bound');
      let events = await page.evaluate(() => feedback);
      assert.ok(events.some(event => event.kind === 'input' && event.source === 'user' && event.target === 'input#secret'),
        'A valid capability copied to another control cannot retarget the isolated operation');
      assert.equal(JSON.stringify(events).includes('target-must-stay-bound'), false);

      const marker = JSON.parse(createNativeActionMarker(guard, 'input', 1));
      marker.sequence = 999;
      await page.evaluate(value => {
        feedback = [];
        const field = document.getElementById('field');
        field.setAttribute('data-webbrain-native-action', JSON.stringify(value));
        field.dispatchEvent(new Event('input', { bubbles: true }));
      }, marker);
      events = await page.evaluate(() => feedback);
      assert.ok(events.some(event => event.kind === 'input' && event.source === 'page'),
        'A modified sequence and script-generated event cannot be attributed to the agent');
      assert.equal(events.some(event => event.source === 'agent'), false);
    } finally { await browser.close(); }
  });

  test(`${build}: a multi-pointer gesture stays active until the last pointer is released`, async () => {
    const { browser, page } = await fixture(engine, build, { capturePointerHandlers: true });
    try {
      const states = await page.evaluate(() => {
        feedback = [];
        const target = document.getElementById('human');
        const emit = (type, pointerId, buttons) => {
          const event = { type, pointerId, buttons, isTrusted: true, target, composedPath: () => [target] };
          for (const listener of monitorPointerHandlers[type] || []) listener.call(document, event);
        };
        emit('pointerdown', 11, 1);
        emit('pointerdown', 12, 1);
        emit('pointerup', 11, 0);
        const afterFirstRelease = feedback.at(-1)?.interacting;
        emit('pointerup', 12, 0);
        return { afterFirstRelease, afterLastRelease: feedback.at(-1)?.interacting };
      });
      assert.deepEqual(states, { afterFirstRelease: true, afterLastRelease: false });
    } finally { await browser.close(); }
  });

  test(`${build}: DOM, window/container scrolling, cleanup and restored monitoring work`, async () => {
    const { browser, page } = await fixture(engine, build);
    try {
      await page.evaluate(() => { document.getElementById('status').textContent = 'Asynchronous page update'; });
      await page.waitForFunction(() => feedback.some(event => event.kind === 'dom' && event.source === 'page'));
      await page.evaluate(() => {
        feedback = []; const field = document.getElementById('field');
        field.value = 'page-written-private-value'; field.dispatchEvent(new Event('input', { bubbles: true }));
      });
      const automaticInput = await page.evaluate(() => feedback);
      assert.ok(automaticInput.some(event => event.kind === 'input' && event.source === 'page'));
      assert.equal(JSON.stringify(automaticInput).includes('page-written-private-value'), false);
      await page.evaluate(() => { feedback = []; window.scrollTo(0, 400); });
      await page.waitForFunction(() => feedback.some(event => event.kind === 'scroll' && event.viewport.y === 400));
      await page.evaluate(() => { feedback = []; document.getElementById('container').scrollTop = 120; });
      await page.waitForFunction(() => feedback.some(event => event.kind === 'scroll' && event.target === 'div#container'));
      await page.waitForTimeout(120); // Finish the preceding container scroll's coalesced position.
      await page.evaluate(() => {
        feedback = []; deliver('page_monitor_prepare', { operationId: 'agent-scroll', tool: 'scroll' });
        deliver('page_monitor_dispatch', { operationId: 'agent-scroll', kind: 'scroll' });
        window.scrollTo(0, 600);
      });
      await page.waitForTimeout(200);
      assert.equal((await page.evaluate(() => feedback)).length, 0, 'Programmatic agent scroll must not steer itself');

      await page.evaluate(() => { monitorEnabled = false; deliver('page_monitor_state'); feedback = [];
        document.getElementById('status').textContent = 'Stopped'; window.scrollTo(0, 0); });
      await page.waitForTimeout(200);
      await page.locator('#human').click();
      assert.equal((await page.evaluate(() => feedback)).length, 0);
      await page.evaluate(() => { monitorEnabled = true; deliver('page_monitor_state'); });
      await page.waitForTimeout(20);
      await page.evaluate(() => { document.getElementById('status').textContent = 'Restarted observer'; });
      await page.waitForFunction(() => feedback.some(event => event.kind === 'dom'));
      await page.goto('https://monitor.test/replacement');
      await page.waitForTimeout(200);
      await page.evaluate(() => { feedback = []; });
      await page.locator('#human').click();
      assert.ok((await page.evaluate(() => feedback)).some(event => event.kind === 'click'));
    } finally { await browser.close(); }
  });

  test(`${build}: frames, open shadow DOM and dispatch preparation retain external changes`, async () => {
    const { browser, page } = await fixture(engine, build);
    try {
      const childNavigation = page.waitForEvent('framenavigated', {
        predicate: frame => frame.url() === 'https://monitor.test/frame', timeout: scaled(10000),
      });
      await page.evaluate(() => {
        const host = document.createElement('div'); host.id = 'shadow-host';
        host.attachShadow({ mode: 'open' }).innerHTML = '<button id="shadow-button">Before</button>';
        document.body.prepend(host);
        const frame = document.createElement('iframe'); frame.name = 'NestedSource'; frame.src = 'https://monitor.test/frame';
        document.body.prepend(frame);
      });
      const child = await childNavigation;
      await child.waitForFunction(() => window.__wbPageMonitor?.active
        && pageMonitorStateRequests.at(-1) === 'NestedSource' && document.getElementById('human'));
      assert.equal(await child.evaluate(() => pageMonitorStateRequests.at(-1)), 'NestedSource',
        'The monitor registers the frame name with background for later named-target resolution');
      await page.locator('#human').click();
      await child.locator('#human').click();
      const tokens = await Promise.all([page.evaluate(() => feedback[0]?.documentToken), child.evaluate(() => feedback[0]?.documentToken)]);
      assert.ok(tokens[0] && tokens[1] && tokens[0] !== tokens[1]);
      await child.evaluate(() => {
        for (const [id, target] of [['top-link', '_top'], ['parent-link', '_parent']]) {
          const link = document.createElement('a'); link.id = id; link.href = 'https://monitor.test/destination';
          link.setAttribute('target', target); link.textContent = id; link.addEventListener('click', event => event.preventDefault()); document.body.append(link);
        }
      });
      await page.waitForTimeout(200);
      for (const [target, id] of [['_top', 'top-link'], ['_parent', 'parent-link']]) {
        await child.evaluate(({ target, id }) => {
          deliver('page_monitor_prepare', { operationId: `link-${target}`, tool: 'click', selector: `#${id}` });
          deliver('page_monitor_dispatch', { operationId: `link-${target}`, kind: 'click', selector: `#${id}` });
          feedback = [];
        }, { target, id });
        await child.locator(`#${id}`).click();
        assert.ok((await child.evaluate(() => feedback)).some(event => event.source === 'agent'
          && event.navigationTarget === target && event.navigationUrl === 'https://monitor.test/destination'),
        `${target} navigation must carry its safe destination and original browsing-context target`);
      }
      await child.evaluate(() => {
        const link = document.createElement('a'); link.id = 'named-link'; link.href = 'https://monitor.test/destination';
        link.target = 'SiblingTarget'; link.textContent = 'named-link';
        link.addEventListener('click', event => event.preventDefault()); document.body.append(link);
      });
      await page.waitForTimeout(200);
      await child.evaluate(() => {
        deliver('page_monitor_prepare', { operationId: 'link-named', tool: 'click', selector: '#named-link' });
        deliver('page_monitor_dispatch', { operationId: 'link-named', kind: 'click', selector: '#named-link' });
        feedback = [];
      });
      await child.locator('#named-link').click();
      const namedFeedback = await child.evaluate(() => feedback);
      assert.ok(namedFeedback.some(event => event.source === 'agent'
        && event.navigationTargetName === 'SiblingTarget' && event.navigationUrl === 'https://monitor.test/destination'),
      `Named navigation targets must preserve their exact browsing-context name and safe destination: ${JSON.stringify(namedFeedback)}`);
      await page.waitForTimeout(200);
      await page.evaluate(() => {
        feedback = [];
        document.getElementById('shadow-host').shadowRoot.querySelector('button').textContent = 'After';
      });
      await page.waitForFunction(() => feedback.some(event => event.kind === 'dom' && event.target === 'button#shadow-button'));

      await page.evaluate(() => { feedback = []; });
      await page.locator('#human').click();
      await page.waitForTimeout(20); // Separate timer work from the click's synchronous handlers.
      await page.evaluate(() => { document.getElementById('status').textContent = 'Unrelated timer update'; });
      await page.waitForFunction(() => feedback.some(event => event.kind === 'dom' && event.target === 'p#status'));
      const unrelated = await page.evaluate(() => feedback.find(event => event.kind === 'dom' && event.target === 'p#status'));
      assert.equal(unrelated.source, 'page');

      await page.evaluate(() => {
        feedback = []; monitorEnabled = false; deliver('page_monitor_state');
        monitorEnabled = true; deliver('page_monitor_state');
      });
      await page.waitForTimeout(20);
      await page.evaluate(() => { feedback = []; document.getElementById('shadow-host').shadowRoot.querySelector('button').textContent = 'Existing shadow'; });
      await page.waitForFunction(() => feedback.some(event => event.target === 'button#shadow-button'));
      await page.waitForTimeout(160);
      const result = await page.evaluate(async () => {
        const finish = __wbPageMonitor.beginContentAction('click', { selector: '#agent', _bidiPrepare: true });
        document.getElementById('status').textContent = 'Changed during preparation';
        await Promise.resolve(); // Deliver MutationObserver before the final dispatch gate.
        try { __wbPageMonitor.beforeLocalDispatch(); return 'unexpected-dispatch'; }
        catch (error) { return { code: error.code, dispatched: error.dispatched }; }
        finally { finish(); }
      });
      assert.deepEqual(result, { code: 'page_feedback_pending', dispatched: false });
      const earlyDispatch = await page.evaluate(async () => {
        // A DOM callback has detected a change, but its 150ms coalesced feedback
        // has not reached background yet. The native dispatch gate must catch it.
        document.getElementById('status').textContent = 'Before coalesced feedback';
        await Promise.resolve();
        deliver('page_monitor_prepare', { operationId: 'coalesced-race', tool: 'click', selector: '#agent' });
        deliver('page_monitor_dispatch', { operationId: 'coalesced-race', kind: 'click', selector: '#agent' });
        await new Promise(resolve => setTimeout(resolve, 0));
        return lastMonitorResponse;
      });
      assert.equal(earlyDispatch.pageFeedbackPending, true);
    } finally { await browser.close(); }
  });

  test(`${build}: preparation scrolling preserves same-target input and rejects intervening DOM changes`, async () => {
    const { browser, page } = await fixture(engine, build);
    try {
      await installScrollHelper(page, build);
      await page.evaluate(() => {
        const box = document.createElement('div'); box.id = 'prep-scroll-box'; box.style.cssText = 'overflow:auto;height:100px;width:300px';
        box.innerHTML = '<input id="prepared-field" style="margin-top:900px">'; document.body.append(box);
        window.__wb_ax_lookup = ref => document.getElementById(ref);
      });
      await page.waitForTimeout(200);
      await page.evaluate(() => {
        feedback = [];
        const finish = __wbPageMonitor.beginContentAction('type_ax', { ref_id: 'prepared-field', _bidiPrepare: { action: 'type' } });
        try { _scrollElementIntoClearView(document.getElementById('prepared-field')); } finally { finish(); }
      });
      await page.waitForTimeout(80);
      assert.ok(await page.evaluate(() => document.getElementById('prep-scroll-box').scrollTop > 0));
      assert.deepEqual(await page.evaluate(() => feedback), []);
      await page.evaluate(() => document.getElementById('prepared-field').focus({ preventScroll: true }));
      await page.keyboard.press('x');
      await page.waitForFunction(() => feedback.some(event => event.kind === 'input' && event.source === 'user'), null, { timeout: FEEDBACK_WAIT_MS });
      await page.evaluate(() => {
        monitorEnabled = false; deliver('page_monitor_state'); document.activeElement?.blur();
      });
      await page.waitForTimeout(100);
      await page.evaluate(() => { document.getElementById('prep-scroll-box').scrollTop = 0; window.scrollTo(0, 0); });
      await page.waitForTimeout(50);
      await page.evaluate(() => { monitorEnabled = true; deliver('page_monitor_state'); });
      await page.waitForTimeout(20);
      assert.equal(await page.evaluate(() => document.getElementById('prep-scroll-box').scrollTop), 0,
        'Keep the target offscreen before testing a rejected preparation, without browser caret scrolling');
      const result = await page.evaluate(async () => {
        const finish = __wbPageMonitor.beginContentAction('type_ax', { ref_id: 'prepared-field', _bidiPrepare: { action: 'type' } });
        document.getElementById('status').textContent = 'Intervening page change'; await Promise.resolve();
        try { _scrollElementIntoClearView(document.getElementById('prepared-field')); return { dispatched: true }; }
        catch (error) { return { code: error.code, dispatched: error.dispatched }; }
        finally { finish(); }
      });
      assert.deepEqual(result, { code: 'page_feedback_pending', dispatched: false });
      assert.equal(await page.evaluate(() => document.getElementById('prep-scroll-box').scrollTop), 0, 'A rejected helper must not scroll through its fallback');
    } finally { await browser.close(); }
  });

  test(`${build}: existing dialogs, details and inert surfaces invalidate prepared actions`, async () => {
    const { browser, page } = await fixture(engine, build);
    try {
      await page.evaluate(() => {
        const surfaces = document.createElement('div');
        surfaces.innerHTML = '<dialog id="modal"><button>Modal target</button></dialog><details id="details" style="height:100px"><summary>Summary</summary><button>Existing details target</button></details><div id="inert-surface"><button>Existing inert target</button></div>';
        document.body.prepend(surfaces);
      });
      await page.waitForTimeout(200);
      for (const state of ['modal-open', 'modal-close', 'details-open', 'details-close', 'inert-on', 'inert-off']) {
        const response = await page.evaluate(async state => {
          feedback = []; deliver('page_monitor_prepare', { operationId: state, tool: 'click', selector: '#agent' });
          if (state === 'modal-open') document.getElementById('modal').showModal();
          if (state === 'modal-close') document.getElementById('modal').close();
          if (state.startsWith('details')) document.getElementById('details').open = state.endsWith('open');
          if (state.startsWith('inert')) document.getElementById('inert-surface').inert = state.endsWith('on');
          await Promise.resolve();
          deliver('page_monitor_dispatch', { operationId: state, kind: 'click', selector: '#agent' });
          await new Promise(resolve => setTimeout(resolve, 0));
          return lastMonitorResponse;
        }, state);
        assert.equal(response.pageFeedbackPending, true, `${state} must invalidate the prepared click`);
        assert.ok((await page.evaluate(() => feedback)).some(event => event.kind === 'dom'), `${state} must refresh page context`);
      }
    } finally { await browser.close(); }
  });

  test(`${build}: viewport resize fences prepared coordinates and stops with the run`, async () => {
    const { browser, page } = await fixture(engine, build);
    try {
      await page.evaluate(() => { document.getElementById('agent').style.cssText = 'position:absolute;left:50vw;top:0'; });
      await page.waitForTimeout(200);
      const before = await page.locator('#agent').boundingBox();
      await page.evaluate(() => { feedback = []; deliver('page_monitor_prepare', { operationId: 'resize-click', tool: 'click', selector: '#agent' }); });
      await page.setViewportSize({ width: 900, height: 600 });
      await page.waitForFunction(() => feedback.some(event => event.kind === 'resize'), null, { timeout: FEEDBACK_WAIT_MS });
      const after = await page.locator('#agent').boundingBox();
      assert.notEqual(before.x, after.x);
      const response = await page.evaluate(async () => {
        deliver('page_monitor_dispatch', { operationId: 'resize-click', kind: 'click', x: 650, y: 20 });
        await new Promise(resolve => setTimeout(resolve, 0)); return lastMonitorResponse;
      });
      assert.equal(response.pageFeedbackPending, true);
      const observation = await page.evaluate(() => feedback.find(event => event.kind === 'resize'));
      assert.equal(observation.source, 'unknown'); assert.equal(observation.viewport.width, 900);
      const frameNavigation = page.waitForEvent('framenavigated', { predicate: frame => frame.url() === 'https://monitor.test/frame' });
      await page.evaluate(() => {
        const frame = document.createElement('iframe'); frame.src = 'https://monitor.test/frame';
        frame.style.cssText = 'width:400px;height:250px'; document.body.prepend(frame);
      });
      const child = await frameNavigation;
      await child.waitForFunction(() => window.__wbPageMonitor && document.documentElement.hasAttribute('data-webbrain-page-revision'));
      await child.evaluate(() => { feedback = []; });
      await page.evaluate(() => { document.querySelector('iframe').style.width = '450px'; });
      await child.waitForFunction(() => feedback.some(event => event.kind === 'resize'), null, { timeout: FEEDBACK_WAIT_MS });
      assert.equal(await child.evaluate(() => feedback.find(event => event.kind === 'resize').source), 'page', 'Embedded frame dimensions are page layout changes');
      await page.evaluate(() => { monitorEnabled = false; deliver('page_monitor_state'); feedback = []; });
      await page.setViewportSize({ width: 1000, height: 700 });
      await page.waitForTimeout(200);
      assert.deepEqual(await page.evaluate(() => feedback), [], 'Stop removes viewport listeners');
    } finally { await browser.close(); }
  });

  test(`${build}: agent resize attribution waits for a matching viewport and preserves concurrent input`, async () => {
    const { browser, page } = await fixture(engine, build);
    try {
      const agentResize = { operationId: 'agent-resize', runToken: 'test-run' };
      await page.evaluate(marker => {
        feedback = [];
        deliver('page_monitor_resize_begin', marker);
        deliver('page_monitor_prepare', { operationId: 'resize-click', tool: 'click', selector: '#agent' });
      }, agentResize);
      assert.equal(await page.evaluate(() => lastMonitorResponse.ready), true);
      await page.setViewportSize({ width: 1000, height: 700 });
      await page.waitForTimeout(50);
      assert.deepEqual(await page.evaluate(() => feedback), [], 'Resize feedback stays buffered until its result is verified');
      await page.evaluate(marker => deliver('page_monitor_resize_finish', {
        ...marker, expectedViewport: { width: 1000, height: 700 },
      }), agentResize);
      await page.waitForFunction(() => feedback.some(event => event.kind === 'resize'), null, { timeout: FEEDBACK_WAIT_MS });
      const attributed = await page.evaluate(() => feedback.find(event => event.kind === 'resize'));
      assert.equal(attributed.source, 'agent');
      assert.equal(attributed.viewport.width, 1000);
      const rejected = await page.evaluate(async () => {
        deliver('page_monitor_dispatch', { operationId: 'resize-click', kind: 'click', selector: '#agent' });
        await new Promise(resolve => setTimeout(resolve, 0)); return lastMonitorResponse;
      });
      assert.equal(rejected.pageFeedbackPending, true, 'The agent resize still invalidates prepared coordinates');

      const overlap = { operationId: 'agent-resize-overlap', runToken: 'test-run' };
      await page.evaluate(marker => { feedback = []; deliver('page_monitor_resize_begin', marker); }, overlap);
      await page.setViewportSize({ width: 1100, height: 750 });
      await page.waitForTimeout(50);
      await page.locator('#human').click();
      await page.evaluate(marker => deliver('page_monitor_resize_finish', {
        ...marker, expectedViewport: { width: 1100, height: 750 },
      }), overlap);
      await page.waitForFunction(() => feedback.some(event => event.kind === 'resize')
        && feedback.some(event => event.kind === 'click' && event.source === 'user'), null, { timeout: FEEDBACK_WAIT_MS });
      const overlappingResize = await page.evaluate(() => feedback.find(event => event.kind === 'resize'));
      assert.equal(overlappingResize.source, 'unknown', 'Concurrent trusted input prevents agent attribution');
    } finally { await browser.close(); }
  });

  test(`${build}: contenteditable fallback attributes its cancellable gate and native edits`, async () => {
    const { browser, page } = await fixture(engine, build);
    try {
      await installContentEditableFallback(page, build);
      for (const behavior of ['append', 'replace', 'cancel', 'editor-handles']) {
        await page.evaluate(behavior => {
          const editor = document.getElementById('rich-editor');
          editor.innerHTML = '<p>Original <strong>format</strong></p>';
          window.originalStrong = editor.querySelector('strong'); window.gates = [];
          editor.onbeforeinput = event => {
            gates.push(event.inputType);
            if (behavior === 'cancel') event.preventDefault();
            if (behavior === 'editor-handles') { event.preventDefault(); editor.append(' handled'); }
          };
        }, behavior);
        await page.waitForTimeout(400);
        await page.evaluate(() => { feedback = []; });
        const result = await page.evaluate(params => typeRichText(params), {
          text: behavior === 'replace' ? 'New\ntext' : ' added', clear: behavior === 'replace',
        });
        if (behavior === 'cancel') {
          assert.equal(result.cancelled, true, JSON.stringify(result)); assert.equal(result.noDispatch, true);
          assert.equal(await page.locator('#rich-editor').innerHTML(), '<p>Original <strong>format</strong></p>');
        } else if (behavior === 'editor-handles') {
          assert.equal(result.success, false); assert.equal(result.mutationMayHaveOccurred, true, JSON.stringify(result));
          assert.equal(await page.locator('#rich-editor').textContent(), 'Original format handled');
        } else {
          assert.equal(result.success, true, JSON.stringify(result)); assert.equal(result.verified, true);
          if (behavior === 'append') assert.equal(await page.evaluate(() => document.getElementById('rich-editor').contains(originalStrong)), true);
          else assert.equal(result.value, 'New\ntext');
        }
        await page.waitForTimeout(400);
        assert.deepEqual(await page.evaluate(() => feedback), [], `Own beforeinput, input and DOM effects must not trigger replanning (${behavior})`);
      }
      await page.evaluate(() => {
        const editor = document.getElementById('rich-editor'); editor.onbeforeinput = null; editor.textContent = 'Ready';
      });
      await page.waitForTimeout(200);
      await page.evaluate(() => { feedback = []; });
      assert.equal((await page.evaluate(() => typeRichText({ text: ' agent' }))).success, true);
      await page.keyboard.press('x');
      await page.waitForFunction(() => feedback.some(event => event.kind === 'input' && event.source === 'user'), null, { timeout: FEEDBACK_WAIT_MS });
      assert.equal(await page.locator('#rich-editor').textContent(), 'Ready agentx', 'A later same-target human edit remains observable');
    } finally { await browser.close(); }
  });

  test(`${build}: contenteditable fallback stops after user intervention during a page-handled edit`, async () => {
    const { browser, page } = await fixture(engine, build);
    try {
      await installContentEditableFallback(page, build);
      await page.evaluate(() => {
        const editor = document.getElementById('rich-editor');
        editor.innerHTML = '<p>Original</p>';
        editor.onbeforeinput = event => {
          event.preventDefault(); editor.append(' page-handled');
        };
      });
      await page.waitForTimeout(200);
      await page.evaluate(() => {
        feedback = []; const schedule = window.setTimeout;
        window.setTimeout = (callback, delay, ...args) => {
          if (delay === SET_FIELD_VERIFY_DELAY_MS) {
            window.editPaused = true;
            window.resumeEdit = () => { window.setTimeout = schedule; schedule(callback, 0, ...args); };
            return 0;
          }
          return schedule(callback, delay, ...args);
        };
        window.editResult = typeRichText({ text: 'Never inserted', clear: true });
      });
      await page.waitForFunction(() => window.editPaused, null, { timeout: FEEDBACK_WAIT_MS });
      await page.locator('#field').fill('Human intervention');
      await page.waitForFunction(() => feedback.some(event => event.source === 'user'));
      const result = await page.evaluate(async () => { resumeEdit(); return await editResult; });
      assert.equal(result.success, false, JSON.stringify(result));
      assert.equal(result.dispatched, true, 'The page-handled edit retains its dispatched outcome');
      assert.equal(result.mutationMayHaveOccurred, true);
      assert.equal(await page.locator('#rich-editor').textContent(), 'Original page-handled');
      assert.equal(await page.locator('#field').inputValue(), 'Human intervention');
    } finally { await browser.close(); }
  });

  test(`${build}: animation and extension decoration do not produce page feedback`, async () => {
    const { browser, page } = await fixture(engine, build);
    try {
      await page.evaluate(() => {
        feedback = [];
        const decoration = document.createElement('div'); decoration.dataset.webbrainUi = 'indicator';
        __wbPageMonitor.registerDecoration(decoration);
        decoration.textContent = 'Agent decoration'; document.body.appendChild(decoration);
        const root = decoration.attachShadow({ mode: 'open' }); root.innerHTML = '<span>Shadow decoration</span>';
        window.animationUpdates = setInterval(() => {
          document.getElementById('moving').style.transform = `translateX(${Math.random() * 10}px)`;
          decoration.textContent = String(Math.random());
          root.querySelector('span').textContent = String(Math.random());
        }, 10);
      });
      await page.waitForTimeout(400);
      const observed = await page.evaluate(() => { clearInterval(animationUpdates); return feedback; });
      assert.equal(observed.length, 0, JSON.stringify(observed));
    } finally { await browser.close(); }
  });

  test(`${build}: page-owned marker attributes and ID prefixes cannot silence monitoring`, async () => {
    const { browser, page } = await fixture(engine, build);
    try {
      for (const [name, value] of [['id', 'webbrain-layout'], ['id', 'wb-agent-layout'], ['data-webbrain-ui', 'page'],
        ['data-webbrain-dev-highlight', 'page'], ['data-webbrain-attention', 'page']]) {
        await page.evaluate(({ name, value }) => {
          document.body.setAttribute(name, value); feedback = [];
        }, { name, value });
        await page.locator('#human').click();
        assert.ok((await page.evaluate(() => feedback)).some(event => event.kind === 'click' && event.source === 'user'),
          `${name} is page data, not proof of extension ownership`);
        await page.evaluate(() => { feedback = []; document.getElementById('status').textContent += ' changed'; });
        await page.waitForFunction(() => feedback.some(event => event.kind === 'dom'), null, { timeout: FEEDBACK_WAIT_MS });
        await page.evaluate(name => document.body.removeAttribute(name), name);
      }
    } finally { await browser.close(); }
  });

  test(`${build}: actual extension indicator nodes remain excluded after monitor replacement`, async () => {
    const { browser, page } = await fixture(engine, build);
    try {
      await page.addScriptTag({ content: read(build, 'content/agent-visual-indicator.js') });
      await page.evaluate(() => {
        feedback = [];
        messageListeners.forEach(listener => listener({ type: 'WB_SHOW_AGENT_INDICATORS' }, {}, () => {}));
      });
      await page.waitForTimeout(400);
      assert.equal((await page.evaluate(() => feedback)).length, 0);
      await page.addScriptTag({ content: read(build, 'content/page-monitor.js') });
      await page.waitForTimeout(200);
      await page.evaluate(() => {
        feedback = [];
        document.getElementById('webbrain-agent-stop-container').style.left = '40%';
      });
      await page.locator('#webbrain-agent-stop-button').click();
      await page.waitForTimeout(200);
      assert.equal((await page.evaluate(() => feedback)).length, 0);
      await page.locator('#human').click();
      assert.ok((await page.evaluate(() => feedback)).some(event => event.source === 'user'));
    } finally { await browser.close(); }
  });

  test(`${build}: random activity effect stays steady within a run and fixed settings override it`, async () => {
    const { browser, page } = await fixture(engine, build);
    try {
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.evaluate(() => {
        window.storageListeners = [];
        chrome.storage = {
          local: { get: async defaults => defaults },
          onChanged: { addListener: fn => storageListeners.push(fn) },
        };
        window.indicatorMessage = (type, randomStyle) => messageListeners.forEach(fn => fn({ type, randomStyle }, {}, () => {}));
        window.chooseStyle = newValue => storageListeners.forEach(fn => fn({ agentIndicatorStyle: { newValue } }, 'local'));
      });
      await page.addScriptTag({ content: read(build, 'content/agent-visual-indicator.js') });
      // No saved preference: use this run's random choice supplied by the background.
      await page.evaluate(() => indicatorMessage('WB_SHOW_AGENT_INDICATORS', 'scan'));
      await page.waitForSelector('#webbrain-agent-effect', { state: 'attached' });
      await page.evaluate(() => { window.firstEffect = document.getElementById('webbrain-agent-effect'); });
      await page.evaluate(() => {
        indicatorMessage('WB_HIDE_FOR_TOOL_USE');
        indicatorMessage('WB_SHOW_AFTER_TOOL_USE');
        indicatorMessage('WB_AGENT_INDICATOR_HEARTBEAT');
        indicatorMessage('WB_SHOW_AGENT_INDICATORS', 'scan');
      });
      assert.equal(await page.evaluate(() => firstEffect === document.getElementById('webbrain-agent-effect')), true);
      // An immediate next run may begin while the old effect is still fading.
      await page.evaluate(() => {
        indicatorMessage('WB_HIDE_AGENT_INDICATORS');
        indicatorMessage('WB_SHOW_AGENT_INDICATORS', 'classic');
      });
      assert.equal(await page.locator('#webbrain-agent-glow-border').count(), 1);
      assert.equal(await page.locator('#webbrain-agent-effect').count(), 0);
      await page.evaluate(() => chooseStyle('scan'));
      await page.waitForTimeout(550);
      assert.equal(await page.locator('#webbrain-agent-glow-border').count(), 0);
      assert.equal(await page.locator('#webbrain-agent-effect').count(), 1);
      await page.evaluate(() => {
        indicatorMessage('WB_HIDE_AGENT_INDICATORS');
        indicatorMessage('WB_SHOW_AGENT_INDICATORS', 'classic');
      });
      assert.equal(await page.locator('#webbrain-agent-effect').count(), 1, 'fixed scan overrides the random classic choice');
      assert.equal(await page.locator('#webbrain-agent-glow-border').count(), 0);
      await page.evaluate(() => chooseStyle('random'));
      await page.waitForTimeout(550);
      assert.equal(await page.locator('#webbrain-agent-glow-border').count(), 1, 'switching back to random restores the run choice');
      assert.equal(await page.locator('#webbrain-agent-effect').count(), 0);
      assert.deepEqual(errors, []);
      assert.equal((await page.evaluate(() => feedback)).length, 0, 'random effects stay outside page feedback');
    } finally { await browser.close(); }
  });

  test(`${build}: agent cursor, target ring and every activity effect stay out of page feedback`, async () => {
    const { browser, page } = await fixture(engine, build);
    try {
      // The settings select writes `agentIndicatorStyle`; the indicator applies it live.
      await page.evaluate(() => {
        window.storageListeners = [];
        chrome.storage = {
          local: { get: async defaults => ({ ...defaults, agentIndicatorStyle: 'scan' }) },
          onChanged: { addListener: fn => storageListeners.push(fn) },
        };
      });
      await page.addScriptTag({ content: read(build, 'content/agent-visual-indicator.js') });
      await page.evaluate(() => {
        feedback = [];
        messageListeners.forEach(listener => listener({ type: 'WB_SHOW_AGENT_INDICATORS' }, {}, () => {}));
      });
      await page.waitForTimeout(300);
      // Glide, press and ripple, then the resting breath (opacity only, via Web Animations).
      await page.evaluate(() => window.__webbrainAgentIndicator.showTarget(document.getElementById('agent'), 'click_ax'));
      await page.waitForTimeout(500);
      await page.evaluate(() => window.__webbrainAgentIndicator.showTarget(document.getElementById('field'), 'type_text'));
      await page.waitForTimeout(2200);
      const resting = await page.evaluate(() => {
        const cursor = document.getElementById('webbrain-agent-target-cursor');
        const effect = document.getElementById('webbrain-agent-effect');
        return {
          cursorPointerEvents: getComputedStyle(cursor).pointerEvents,
          cursorShown: getComputedStyle(cursor).opacity === '1',
          breathing: cursor.firstElementChild.getAnimations().some(animation => animation.effect.getComputedTiming().iterations === Infinity),
          effectPointerEvents: getComputedStyle(effect).pointerEvents,
          effectDisplay: getComputedStyle(effect).display,
        };
      });
      assert.deepEqual(resting, {
        cursorPointerEvents: 'none', cursorShown: true, breathing: true, effectPointerEvents: 'none', effectDisplay: 'block',
      });
      for (const style of ['aurora', 'gears', 'classic', 'circuit']) {
        await page.evaluate(style => storageListeners.forEach(fn => fn({ agentIndicatorStyle: { newValue: style } }, 'local')), style);
        await page.evaluate(() => window.__webbrainAgentIndicator.showTarget(document.getElementById('select'), 'click_coordinates'));
        await page.waitForTimeout(650);
      }
      assert.equal(await page.evaluate(() => document.querySelectorAll('#webbrain-agent-effect').length), 1, 'the previous effect is removed after a switch');
      assert.equal((await page.evaluate(() => feedback)).length, 0, JSON.stringify(await page.evaluate(() => feedback)));
      // Screenshot capture hides every part, and nothing intercepts real input.
      // The captures of one screen update each ask: a repeat changes nothing,
      // and the one show after the last capture brings every part back.
      const parts = () => page.evaluate(() => ['webbrain-agent-effect', 'webbrain-agent-target-cursor', 'webbrain-agent-stop-container']
        .map(id => getComputedStyle(document.getElementById(id)).display));
      const shown = await parts();
      const hideReplies = await page.evaluate(() => [1, 2].map(() => {
        const replies = [];
        messageListeners.forEach(listener => listener({ type: 'WB_HIDE_FOR_TOOL_USE' }, {}, reply => replies.push(reply)));
        return replies.find(reply => reply && 'changed' in reply) || null;
      }));
      assert.deepEqual(hideReplies, [{ ok: true, changed: true }, { ok: true, changed: false }]);
      assert.deepEqual(await parts(), ['none', 'none', 'none']);
      await page.evaluate(() => messageListeners.forEach(listener => listener({ type: 'WB_SHOW_AFTER_TOOL_USE' }, {}, () => {})));
      assert.deepEqual(await parts(), shown);
      assert.ok(shown.every(display => display !== 'none'), shown.join());
      await page.locator('#human').click();
      assert.ok((await page.evaluate(() => feedback)).some(event => event.kind === 'click' && event.source === 'user'));
      // Reduced motion: the canvas keeps one still frame, and the glow and the ring stop pulsing.
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await page.waitForTimeout(100);
      const frame = () => page.evaluate(() => document.getElementById('webbrain-agent-effect').toDataURL());
      const still = await frame();
      await page.waitForTimeout(400);
      assert.equal(await frame(), still, 'the circuit holds still under reduced motion');
      await page.evaluate(() => storageListeners.forEach(fn => fn({ agentIndicatorStyle: { newValue: 'classic' } }, 'local')));
      await page.evaluate(() => window.__webbrainAgentIndicator.showTarget(document.getElementById('select'), 'click_coordinates'));
      assert.deepEqual(await page.evaluate(() => ['webbrain-agent-glow-border', 'webbrain-agent-target-outline']
        .map(id => getComputedStyle(document.getElementById(id)).animationName)), ['none', 'none']);
    } finally { await browser.close(); }
  });

  test(`${build}: the agent cursor reaches its target before the click, presses with it, then blinks`, async () => {
    const { browser, page } = await fixture(engine, build);
    try {
      await page.addScriptTag({ content: read(build, 'content/agent-visual-indicator.js') });
      await page.evaluate(() => {
        messageListeners.forEach(listener => listener({ type: 'WB_SHOW_AGENT_INDICATORS' }, {}, () => {}));
        window.cursorMessage = message => {
          let answer = null;
          messageListeners.forEach(listener => listener(message, {}, reply => { if (reply && 'ok' in reply) answer = reply; }));
          return answer;
        };
        window.cursorParts = () => {
          const cursor = document.getElementById('webbrain-agent-target-cursor');
          const r = cursor.getBoundingClientRect();
          return { cursor, ripple: cursor.previousElementSibling, body: cursor.firstElementChild, x: r.left, y: r.top };
        };
      });
      const approach = rect => page.evaluate(rect => cursorMessage({ type: 'WB_SHOW_AGENT_TARGET', phase: 'approach', source: 'click_text', rect }), rect);
      const verdict = ok => page.evaluate(ok => cursorMessage({ type: 'WB_SHOW_AGENT_TARGET', phase: 'done', ok }), ok);
      const position = () => page.evaluate(() => { const { x, y } = cursorParts(); return { x, y }; });
      const pressing = () => page.evaluate(() => {
        const { ripple, body } = cursorParts();
        return {
          ripples: ripple.getAnimations().map(animation => animation.currentTime),
          press: body.getAnimations().some(animation => animation.effect.getComputedTiming().duration === 320),
        };
      });
      const breathing = () => page.evaluate(() => cursorParts().body.getAnimations()
        .some(animation => animation.effect.getComputedTiming().iterations === Infinity));

      // The first target: the cursor fades in where it is.
      assert.equal((await approach({ x: 40, y: 40, w: 40, h: 20 })).arriveInMs, 250);
      await verdict(true);
      await page.waitForTimeout(1200);
      const start = await position();

      // A far target: a gradual glide whose length the agent waits out.
      const target = { x: 700, y: 500, w: 40, h: 20 };
      const { arriveInMs } = await approach(target);
      assert.ok(arriveInMs >= 360 && arriveInMs <= 760, String(arriveInMs));
      await page.waitForTimeout(Math.round(arriveInMs / 4));
      const midway = await position();
      assert.ok(midway.x > start.x + 5 && midway.y > start.y + 5, `the cursor is on its way: ${JSON.stringify({ start, midway })}`);

      // A screenshot hides the cursor mid-glide; the glide keeps going.
      const glideThroughCapture = await page.evaluate(() => {
        cursorMessage({ type: 'WB_HIDE_FOR_TOOL_USE' });
        const { cursor } = cursorParts();
        const hidden = getComputedStyle(cursor).display;
        const running = cursor.getAnimations().filter(animation => animation.playState === 'running').length;
        cursorMessage({ type: 'WB_SHOW_AFTER_TOOL_USE' });
        return { hidden, running };
      });
      assert.deepEqual(glideThroughCapture, { hidden: 'none', running: 1 });
      assert.equal((await pressing()).press, false, 'no press before the click');

      // The click follows the landing: the trusted press presses the cursor,
      // and the success verdict does not press it again.
      await page.waitForTimeout(arriveInMs);
      const landed = await position();
      assert.ok(landed.x > midway.x && landed.y > midway.y, JSON.stringify({ midway, landed }));
      await page.mouse.click(720, 510);
      await page.waitForTimeout(60);
      const pressed = await pressing();
      assert.equal(pressed.press, true, 'the cursor presses with the click');
      assert.equal(pressed.ripples.length, 1);
      await page.waitForTimeout(60);
      await verdict(true);
      const afterVerdict = await pressing();
      assert.equal(afterVerdict.ripples.length, 1);
      assert.ok(afterVerdict.ripples[0] > pressed.ripples[0], 'the verdict does not restart the press');

      // Between actions the cursor stays on the spot and blinks.
      await page.waitForTimeout(1100);
      assert.equal(await breathing(), true);
      assert.deepEqual(await position(), landed);

      // A failed click: the cursor gets there but does not press.
      const failed = await approach({ x: 200, y: 300, w: 40, h: 20 });
      assert.equal(await breathing(), false, 'an approach ends the blink');
      await page.waitForTimeout(failed.arriveInMs + 60);
      await verdict(false);
      await page.waitForTimeout(60);
      assert.deepEqual(await pressing(), { ripples: [], press: false });

      // Nothing to wait for: an unknown ref, reduced motion.
      assert.equal((await page.evaluate(() => cursorMessage({ type: 'WB_SHOW_AGENT_TARGET', phase: 'approach', ref_id: 'ref_404' }))).arriveInMs, 0);
      await page.emulateMedia({ reducedMotion: 'reduce' });
      assert.equal((await approach(target)).arriveInMs, 0);
      assert.equal((await page.evaluate(() => feedback)).filter(event => event.source !== 'user').length, 0);
    } finally { await browser.close(); }
  });

  test(`${build}: companion native markers renew per key without hiding a later human edit`, async () => {
    const { browser, page } = await fixture(engine, build);
    try {
      const guard = await page.evaluate(() => {
        deliver('page_monitor_prepare', { operationId: 'native-typing', tool: 'type_text', selector: '#field' });
        deliver('page_monitor_dispatch', { operationId: 'native-typing', kind: 'input', selector: '#field', navigationCandidate: false, fenceOnly: true });
        feedback = []; return lastMonitorResponse.guard;
      });
      await page.locator('#field').focus();
      let replayedMarker;
      for (let i = 0; i < 3; i++) {
        replayedMarker = createNativeActionMarker(guard, 'input', i + 1);
        await page.evaluate(marker => document.getElementById('field').setAttribute('data-webbrain-native-action', marker), replayedMarker);
        await page.keyboard.insertText('a');
      }
      assert.equal((await page.evaluate(() => feedback)).some(event => event.source !== 'agent'), false,
        JSON.stringify(await page.evaluate(() => feedback)));
      await page.evaluate(marker => document.getElementById('field').setAttribute('data-webbrain-native-action', marker), replayedMarker);
      await page.keyboard.insertText('human-private');
      assert.ok((await page.evaluate(() => feedback)).some(event => event.source === 'user'));
      assert.equal(JSON.stringify(await page.evaluate(() => feedback)).includes('human-private'), false);
      assert.notEqual(await page.evaluate(() => document.documentElement.getAttribute('data-webbrain-page-revision')),
        `${guard.documentToken}:${guard.revision}`);
    } finally { await browser.close(); }
  });

  test(`${build}: native dispatch validation ignores a page-restored revision attribute`, async () => {
    const { browser, page } = await fixture(engine, build);
    try {
      const guard = await page.evaluate(() => {
        deliver('page_monitor_prepare', { operationId: 'private-revision', tool: 'type_text', selector: '#field' });
        deliver('page_monitor_dispatch', { operationId: 'private-revision', kind: 'input', selector: '#field', fenceOnly: true });
        feedback = []; return lastMonitorResponse.guard;
      });
      await page.evaluate(() => { document.getElementById('status').textContent = 'Page changed after native preparation'; });
      await page.waitForFunction(() => feedback.some(event => event.kind === 'dom'), null, { timeout: FEEDBACK_WAIT_MS });
      const ready = await page.evaluate(guard => {
        // The page can rewrite its visible marker, but cannot rewind the monitor's
        // private revision used by the extension-side native dispatch check.
        document.documentElement.setAttribute('data-webbrain-page-revision', `${guard.documentToken}:${guard.revision}`);
        deliver('page_monitor_validate', { ...guard, kind: 'input' });
        return lastMonitorResponse.ready;
      }, guard);
      assert.equal(ready, false);
    } finally { await browser.close(); }
  });

  test(`${build}: link destination mutations are observed`, async () => {
    const { browser, page } = await fixture(engine, build);
    try {
      await page.evaluate(() => { const link = document.createElement('a'); link.id = 'destination'; link.href = '/before'; link.textContent = 'Destination'; document.body.append(link); });
      await page.waitForTimeout(120);
      await page.evaluate(() => { feedback = []; document.getElementById('destination').href = '/after'; });
      await page.waitForFunction(() => feedback.some(event => event.kind === 'dom'), null, { timeout: FEEDBACK_WAIT_MS });
      assert.ok((await page.evaluate(() => feedback)).some(event => event.kind === 'dom' && event.target === 'a#destination'));
      await page.evaluate(() => { feedback = []; document.getElementById('destination').setAttribute('target', '_blank'); });
      await page.waitForFunction(() => feedback.some(event => event.kind === 'dom'), null, { timeout: FEEDBACK_WAIT_MS });
      assert.ok((await page.evaluate(() => feedback)).some(event => event.kind === 'dom' && event.target === 'a#destination'));
    } finally { await browser.close(); }
  });

  test(`${build}: programmatic contenteditable text updates produce page feedback`, async () => {
    const { browser, page } = await fixture(engine, build);
    try {
      await page.evaluate(() => {
        const editor = document.createElement('div');
        editor.id = 'programmatic-editor'; editor.contentEditable = 'true'; editor.setAttribute('role', 'textbox');
        editor.textContent = 'Initial text'; document.body.append(editor);
      });
      await page.waitForTimeout(180);
      await page.evaluate(() => {
        feedback = [];
        document.getElementById('programmatic-editor').firstChild.data = 'Page updated this editor';
      });
      await page.waitForFunction(() => feedback.some(event => event.kind === 'dom'), null, { timeout: FEEDBACK_WAIT_MS });
      const observations = await page.evaluate(() => feedback);
      assert.ok(observations.some(event => event.source === 'page' && event.target.startsWith('div#programmatic-editor')));
      assert.equal(JSON.stringify(observations).includes('Page updated this editor'), false,
        'Editable content must invalidate state without being included in feedback');

      const guard = await page.evaluate(() => {
        feedback = [];
        deliver('page_monitor_prepare', { operationId: 'editable-replacement', tool: 'click', selector: '#agent' });
        deliver('page_monitor_dispatch', { operationId: 'editable-replacement', kind: 'click', selector: '#agent', fenceOnly: true });
        return lastMonitorResponse.guard;
      });
      await page.evaluate(() => { document.getElementById('programmatic-editor').textContent = 'Page replaced the editor value'; });
      await page.waitForFunction(() => feedback.some(event => event.kind === 'dom'), null, { timeout: FEEDBACK_WAIT_MS });
      const replacementObservations = await page.evaluate(() => feedback);
      assert.ok(replacementObservations.some(event => event.source === 'page'
        && event.target.startsWith('div#programmatic-editor')),
      'Replacing an editable text node must advance the page revision');
      assert.equal(JSON.stringify(replacementObservations).includes('Page replaced the editor value'), false,
        'Replaced editable text must remain private');
      const ready = await page.evaluate(async () => {
        deliver('page_monitor_dispatch', { operationId: 'editable-replacement', kind: 'click', selector: '#agent' });
        await new Promise(resolve => setTimeout(resolve, 0));
        return lastMonitorResponse;
      });
      assert.equal(ready.pageFeedbackPending, true, 'A prepared action must not survive editable text replacement');
      assert.ok(replacementObservations.some(observation => observation.revision > guard.revision));
    } finally { await browser.close(); }
  });

  test(`${build}: hidden aria-labelledby text changes invalidate visible targets`, async () => {
    const { browser, page } = await fixture(engine, build);
    try {
      await page.evaluate(() => {
        const label = document.createElement('span'); label.id = 'hidden-accessible-label'; label.textContent = 'Initial label';
        label.style.display = 'none';
        const button = document.createElement('button'); button.id = 'labelled-button'; button.setAttribute('aria-labelledby', label.id);
        document.body.append(label, button);
      });
      await page.waitForTimeout(180);
      const guard = await page.evaluate(() => {
        feedback = [];
        deliver('page_monitor_prepare', { operationId: 'hidden-label', tool: 'click', selector: '#labelled-button' });
        deliver('page_monitor_dispatch', { operationId: 'hidden-label', kind: 'click', selector: '#labelled-button', fenceOnly: true });
        return lastMonitorResponse.guard;
      });
      await page.evaluate(() => { document.getElementById('hidden-accessible-label').textContent = 'Updated label'; });
      await page.waitForFunction(() => feedback.some(event => event.kind === 'dom'), null, { timeout: FEEDBACK_WAIT_MS });
      const observations = await page.evaluate(() => feedback);
      assert.ok(observations.some(event => event.source === 'page'));
      assert.equal(JSON.stringify(observations).includes('Updated label'), false, 'Hidden accessible-name text must not be sent');
      const accepted = await page.evaluate(value => {
        const event = new CustomEvent('webbrain-agent-dom-dispatch', {
          detail: JSON.stringify({ ...value, dispatchPhase: 'click' }), bubbles: true, composed: true, cancelable: true,
        });
        return document.getElementById('labelled-button').dispatchEvent(event);
      }, guard);
      assert.equal(accepted, false, 'Changing a hidden accessible label must invalidate the prepared click');
    } finally { await browser.close(); }
  });

  test(`${build}: hidden aria-labelledby ID changes invalidate visible targets`, async () => {
    const { browser, page } = await fixture(engine, build);
    try {
      await page.evaluate(() => {
        const label = document.createElement('span'); label.id = 'hidden-id-label'; label.textContent = 'Accessible name';
        label.style.display = 'none';
        const button = document.createElement('button'); button.id = 'id-labelled-button'; button.setAttribute('aria-labelledby', label.id);
        document.body.append(label, button);
      });
      await page.waitForTimeout(180);
      await page.evaluate(() => {
        feedback = [];
        deliver('page_monitor_prepare', { operationId: 'hidden-label-id', tool: 'click', selector: '#id-labelled-button' });
        deliver('page_monitor_dispatch', { operationId: 'hidden-label-id', kind: 'click', selector: '#id-labelled-button', fenceOnly: true });
        document.getElementById('hidden-id-label').id = 'renamed-hidden-id-label';
      });
      await page.waitForFunction(() => feedback.some(event => event.kind === 'dom' && event.source === 'page'), null, { timeout: FEEDBACK_WAIT_MS });
      const blocked = await page.evaluate(() => {
        try { __wbPageMonitor.activatePreparedDispatch({ operationId: 'hidden-label-id', kind: 'click' }); return null; }
        catch (error) { return error.code; }
      });
      assert.equal(blocked, 'page_feedback_pending', 'Changing a hidden referenced ID must stale the prepared action');
      assert.equal(JSON.stringify(await page.evaluate(() => feedback)).includes('Accessible name'), false,
        'The hidden label text must stay out of feedback');
    } finally { await browser.close(); }
  });

  test(`${build}: boxless text changes invalidate visible descendant-name controls`, async () => {
    const { browser, page } = await fixture(engine, build);
    try {
      await page.evaluate(() => {
        const button = document.createElement('button'); button.id = 'boxless-name-button';
        const label = document.createElement('span'); label.style.display = 'contents'; label.textContent = 'Initial action';
        button.append(label); document.body.append(button);
      });
      await page.waitForTimeout(300);
      const guard = await page.evaluate(() => {
        feedback = [];
        deliver('page_monitor_prepare', { operationId: 'boxless-name', tool: 'click', selector: '#boxless-name-button' });
        deliver('page_monitor_dispatch', { operationId: 'boxless-name', kind: 'click', selector: '#boxless-name-button' });
        return lastMonitorResponse.guard;
      });
      await page.locator('#boxless-name-button span').evaluate(label => { label.textContent = 'Updated action'; });
      await page.waitForFunction(() => feedback.some(event => event.kind === 'dom'), null, { timeout: FEEDBACK_WAIT_MS });
      assert.equal(JSON.stringify(await page.evaluate(() => feedback)).includes('Updated action'), false,
        'The changed accessible name must not be copied into feedback');
      const accepted = await page.evaluate(value => window.dispatchEvent(new CustomEvent('webbrain-agent-dom-dispatch', {
        detail: JSON.stringify({ ...value, dispatchPhase: 'click' }), cancelable: true,
      })), guard);
      assert.equal(accepted, false, 'Changing text in a boxless name descendant must invalidate the prepared action');
    } finally { await browser.close(); }
  });

  test(`${build}: Enter and Space keyboard activations stay attributed to the agent`, async () => {
    const { browser, page } = await fixture(engine, build);
    try {
      await page.evaluate(() => {
        const link = document.createElement('a'); link.id = 'keyboard-link'; link.href = '/keyboard-destination';
        link.textContent = 'Open page'; link.addEventListener('click', event => event.preventDefault());
        const button = document.createElement('button'); button.id = 'keyboard-button'; button.type = 'button';
        button.textContent = 'Run action'; button.addEventListener('click', event => event.preventDefault());
        document.body.append(link, button);
      });
      await page.waitForTimeout(300);
      const linkDispatch = await page.evaluate(() => {
        feedback = [];
        deliver('page_monitor_prepare', { operationId: 'keyboard-link', tool: 'press_keys', selector: '#keyboard-link' });
        deliver('page_monitor_dispatch', { operationId: 'keyboard-link', kind: 'input', selector: '#keyboard-link' });
        return lastMonitorResponse;
      });
      assert.equal(linkDispatch.ready, true, JSON.stringify(linkDispatch));
      await page.locator('#keyboard-link').press('Enter');
      await page.waitForFunction(() => feedback.some(event => event.source === 'agent' && event.operation === 'click'), null, { timeout: FEEDBACK_WAIT_MS });
      const linkEvents = await page.evaluate(() => feedback);
      assert.equal(linkEvents.some(event => event.source === 'agent' && event.operation === 'click'
        && event.navigationUrl === 'https://monitor.test/keyboard-destination'), true, JSON.stringify(linkEvents));
      assert.equal(linkEvents.some(event => event.kind === 'click' && event.source === 'user'), false, JSON.stringify(linkEvents));

      await page.evaluate(() => {
        feedback = [];
        deliver('page_monitor_prepare', { operationId: 'keyboard-button', tool: 'press_keys', selector: '#keyboard-button' });
        deliver('page_monitor_dispatch', { operationId: 'keyboard-button', kind: 'input', selector: '#keyboard-button' });
      });
      await page.locator('#keyboard-button').press('Space');
      await page.waitForFunction(() => feedback.some(event => event.source === 'agent' && event.operation === 'click'), null, { timeout: FEEDBACK_WAIT_MS });
      const buttonEvents = await page.evaluate(() => feedback);
      assert.equal(buttonEvents.some(event => event.source === 'agent' && event.operation === 'click'), true, JSON.stringify(buttonEvents));
      assert.equal(buttonEvents.some(event => event.kind === 'click' && event.source === 'user'), false, JSON.stringify(buttonEvents));

      await page.evaluate(() => { feedback = []; });
      await page.locator('#keyboard-button').click();
      await page.waitForFunction(() => feedback.some(event => event.kind === 'click' && event.source === 'user'), null, { timeout: FEEDBACK_WAIT_MS });
      assert.equal((await page.evaluate(() => feedback)).some(event => event.kind === 'click' && event.source === 'user'), true,
        'A later pointer click must remain user activity after keyboard attribution');
    } finally { await browser.close(); }
  });

  test(`${build}: non-editable site shortcut keys invalidate actions without exposing keys`, async () => {
    const { browser, page } = await fixture(engine, build);
    try {
      await page.evaluate(() => {
        const surface = document.createElement('div'); surface.id = 'shortcut-surface'; surface.tabIndex = 0;
        document.body.prepend(surface);
      });
      await page.waitForTimeout(250);
      await page.locator('#shortcut-surface').focus();
      await page.waitForTimeout(150);
      const dispatch = await page.evaluate(() => {
        feedback = [];
        deliver('page_monitor_prepare', { operationId: 'site-shortcut', tool: 'click', selector: '#agent' });
        deliver('page_monitor_dispatch', { operationId: 'site-shortcut', kind: 'click', selector: '#agent', fenceOnly: true });
        return lastMonitorResponse;
      });
      assert.equal(dispatch.ready, true, JSON.stringify(dispatch));
      await page.locator('#shortcut-surface').press('Shift');
      assert.deepEqual(await page.evaluate(() => feedback), [], 'Modifier-only presses do not produce shortcut activity');
      await page.locator('#shortcut-surface').press('j');
      await page.waitForFunction(() => feedback.some(event => event.kind === 'activity' && event.source === 'user'), null, { timeout: FEEDBACK_WAIT_MS });
      const events = await page.evaluate(() => feedback);
      assert.equal(events.some(event => event.kind === 'activity' && event.source === 'user'), true, JSON.stringify(events));
      assert.equal(events.some(event => Object.hasOwn(event, 'key') || Object.hasOwn(event, 'value')), false,
        'Keyboard contents must never be included in page feedback');
      const blocked = await page.evaluate(() => {
        try { __wbPageMonitor.activatePreparedDispatch({ operationId: 'site-shortcut', kind: 'click' }); return null; }
        catch (error) { return error.code; }
      });
      assert.equal(blocked, 'page_feedback_pending', 'A site shortcut must invalidate the prepared action');
    } finally { await browser.close(); }
  });

  test(`${build}: aria-modal changes invalidate prepared page context`, async () => {
    const { browser, page } = await fixture(engine, build);
    try {
      await page.evaluate(() => {
        const modal = document.createElement('div'); modal.id = 'modal-container'; modal.setAttribute('role', 'dialog');
        modal.textContent = 'Dialog'; document.body.append(modal);
      });
      await page.waitForTimeout(180);
      await page.evaluate(() => {
        feedback = [];
        deliver('page_monitor_prepare', { operationId: 'aria-modal', tool: 'click', selector: '#agent' });
        deliver('page_monitor_dispatch', { operationId: 'aria-modal', kind: 'click', selector: '#agent', fenceOnly: true });
        document.getElementById('modal-container').setAttribute('aria-modal', 'true');
      });
      await page.waitForFunction(() => feedback.some(event => event.kind === 'dom' && event.source === 'page'
        && event.target === 'div#modal-container [dialog]'), null, { timeout: FEEDBACK_WAIT_MS });
      const blocked = await page.evaluate(() => {
        try { __wbPageMonitor.activatePreparedDispatch({ operationId: 'aria-modal', kind: 'click' }); return null; }
        catch (error) { return error.code; }
      });
      assert.equal(blocked, 'page_feedback_pending', 'Changing modal semantics must stale a prepared action');
    } finally { await browser.close(); }
  });

  test(`${build}: guarded synthetic file input events are attributed once`, async () => {
    const { browser, page } = await fixture(engine, build);
    try {
      await page.evaluate(() => {
        const input = document.createElement('input'); input.id = 'synthetic-upload'; input.type = 'file'; document.body.append(input);
      });
      await page.waitForTimeout(200);
      const guard = await page.evaluate(() => {
        feedback = [];
        deliver('page_monitor_prepare', { operationId: 'synthetic-upload', tool: 'upload_file', selector: '#synthetic-upload' });
        deliver('page_monitor_dispatch', { operationId: 'synthetic-upload', kind: 'input', selector: '#synthetic-upload',
          eventTypes: ['input', 'change'], fenceOnly: true });
        return lastMonitorResponse.guard;
      });
      const accepted = await page.locator('#synthetic-upload').evaluate((input, value) => {
        const event = new CustomEvent('webbrain-agent-dom-dispatch', {
          detail: JSON.stringify({ ...value, dispatchPhase: 'input' }), bubbles: true, composed: true, cancelable: true,
        });
        if (!input.dispatchEvent(event)) return false;
        const transfer = new DataTransfer(); transfer.items.add(new File(['fixture'], 'fixture.txt', { type: 'text/plain' }));
        input.files = transfer.files;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      }, guard);
      assert.equal(accepted, true);
      await page.waitForTimeout(200);
      assert.deepEqual(await page.evaluate(() => feedback), [], 'The guarded synthetic upload must not interrupt its own run');

      const staleGuard = await page.evaluate(() => {
        feedback = [];
        deliver('page_monitor_prepare', { operationId: 'stale-synthetic-upload', tool: 'upload_file', selector: '#synthetic-upload' });
        deliver('page_monitor_dispatch', { operationId: 'stale-synthetic-upload', kind: 'input', selector: '#synthetic-upload',
          eventTypes: ['input', 'change'], fenceOnly: true });
        const value = lastMonitorResponse.guard;
        document.getElementById('status').textContent = 'Page changed before upload dispatch';
        return value;
      });
      await page.waitForFunction(() => feedback.some(event => event.kind === 'dom'), null, { timeout: FEEDBACK_WAIT_MS });
      const staleAccepted = await page.locator('#synthetic-upload').evaluate((input, value) => {
        let inputEvents = 0;
        input.addEventListener('input', () => inputEvents++, { once: true });
        const event = new CustomEvent('webbrain-agent-dom-dispatch', {
          detail: JSON.stringify({ ...value, dispatchPhase: 'input' }), bubbles: true, composed: true, cancelable: true,
        });
        const okay = input.dispatchEvent(event);
        if (okay) input.dispatchEvent(new Event('input', { bubbles: true }));
        return { okay, inputEvents };
      }, staleGuard);
      assert.deepEqual(staleAccepted, { okay: false, inputEvents: 0 }, 'Stale upload guards must stop the synthetic input sequence');
    } finally { await browser.close(); }
  });

  test(`${build}: accessibility field metadata mutations invalidate prepared input`, async () => {
    const { browser, page } = await fixture(engine, build);
    try {
      await page.evaluate(() => {
        const input = document.createElement('input'); input.id = 'metadata-field';
        input.name = 'original-name'; input.placeholder = 'Original placeholder'; input.setAttribute('aria-required', 'false');
        input.setAttribute('aria-readonly', 'false'); document.body.append(input);
      });
      await page.waitForTimeout(180);
      const changes = [
        ['name', 'updated-name'], ['placeholder', 'Updated placeholder'],
        ['aria-required', 'true'], ['aria-readonly', 'true'], ['aria-labelledby', 'updated-accessible-name'],
      ];
      for (const [attribute, value] of changes) {
        const guard = await page.evaluate(attribute => {
          feedback = [];
          const operationId = 'metadata-' + attribute;
          deliver('page_monitor_prepare', { operationId, tool: 'type_text', selector: '#metadata-field' });
          deliver('page_monitor_dispatch', { operationId, kind: 'input', selector: '#metadata-field', fenceOnly: true });
          return lastMonitorResponse.guard;
        }, attribute);
        await page.locator('#metadata-field').evaluate((element, [name, next]) => element.setAttribute(name, next), [attribute, value]);
        await page.waitForFunction(() => feedback.some(event => event.kind === 'dom' && event.target === 'input#metadata-field'), null, { timeout: FEEDBACK_WAIT_MS });
        const ready = await page.evaluate(value => {
          deliver('page_monitor_validate', { ...value, kind: 'input' });
          return lastMonitorResponse.ready;
        }, guard);
        assert.equal(ready, false, `${attribute} changes must invalidate an existing input guard`);
        const serialized = await page.evaluate(() => JSON.stringify(feedback));
        assert.equal(serialized.includes(value), false, 'Field metadata values must not be included in feedback');
        await page.waitForTimeout(180);
      }
    } finally { await browser.close(); }
  });

  test(`${build}: button type changes invalidate a prepared click`, async () => {
    const { browser, page } = await fixture(engine, build);
    try {
      await page.evaluate(() => {
        const form = document.createElement('form');
        form.innerHTML = '<button id="guarded-submit" type="button">Save</button>';
        form.addEventListener('submit', event => { event.preventDefault(); window.formWasSubmitted = true; });
        document.body.append(form);
      });
      await page.waitForTimeout(150);
      const guard = await page.evaluate(() => {
        feedback = [];
        deliver('page_monitor_prepare', { operationId: 'button-type', tool: 'click', selector: '#guarded-submit' });
        deliver('page_monitor_dispatch', { operationId: 'button-type', kind: 'click', selector: '#guarded-submit' });
        return lastMonitorResponse.guard;
      });
      await page.locator('#guarded-submit').evaluate(element => element.setAttribute('type', 'submit'));
      await page.waitForFunction(() => feedback.some(event => event.kind === 'dom' && event.target === 'button#guarded-submit'));
      const accepted = await page.evaluate(value => window.dispatchEvent(new CustomEvent('webbrain-agent-dom-dispatch', {
        detail: JSON.stringify({ ...value, dispatchPhase: 'focus' }), cancelable: true,
      })), guard);
      assert.equal(accepted, false, 'A type mutation must make the prepared focus/click guard stale');
      assert.equal(await page.evaluate(() => window.formWasSubmitted === true), false);
    } finally { await browser.close(); }
  });

  test(`${build}: form method changes invalidate a prepared submit click`, async () => {
    const { browser, page } = await fixture(engine, build);
    try {
      await page.evaluate(() => {
        const form = document.createElement('form');
        form.id = 'guarded-form'; form.method = 'get';
        form.innerHTML = '<button id="guarded-submit" type="submit" formmethod="get">Save</button>';
        form.addEventListener('submit', event => event.preventDefault());
        document.body.append(form);
      });
      await page.waitForTimeout(120);

      const prepare = operationId => page.evaluate(id => {
        feedback = [];
        deliver('page_monitor_prepare', { operationId: id, tool: 'click', selector: '#guarded-submit' });
        deliver('page_monitor_dispatch', { operationId: id, kind: 'click', selector: '#guarded-submit' });
        return lastMonitorResponse.guard;
      }, operationId);
      const assertStale = guard => page.evaluate(value => window.dispatchEvent(new CustomEvent('webbrain-agent-dom-dispatch', {
        detail: JSON.stringify({ ...value, dispatchPhase: 'focus' }), cancelable: true,
      })), guard);

      const formGuard = await prepare('form-method');
      await page.locator('#guarded-form').evaluate(form => form.setAttribute('method', 'post'));
      await page.waitForFunction(() => feedback.some(event => event.kind === 'dom' && event.target === 'form#guarded-form'));
      assert.equal(await assertStale(formGuard), false, 'Changing form method must invalidate the prepared submit click');

      const buttonGuard = await prepare('button-formmethod');
      await page.locator('#guarded-submit').evaluate(button => button.setAttribute('formmethod', 'post'));
      await page.waitForFunction(() => feedback.some(event => event.kind === 'dom' && event.target === 'button#guarded-submit'));
      assert.equal(await assertStale(buttonGuard), false, 'Changing formmethod must invalidate the prepared submit click');
    } finally { await browser.close(); }
  });

  test(`${build}: validation bypass changes invalidate a prepared submit click`, async () => {
    const { browser, page } = await fixture(engine, build);
    try {
      await page.evaluate(() => {
        const form = document.createElement('form'); form.id = 'validation-form';
        form.innerHTML = '<input required><button id="validation-submit" type="submit">Continue</button>';
        form.addEventListener('submit', event => event.preventDefault());
        document.body.append(form);
      });
      await page.waitForTimeout(150);
      for (const [attribute, target] of [['novalidate', '#validation-form'], ['formnovalidate', '#validation-submit']]) {
        const operationId = `validation-${attribute}`;
        await page.evaluate(id => {
          feedback = [];
          deliver('page_monitor_prepare', { operationId: id, tool: 'click', selector: '#validation-submit' });
          deliver('page_monitor_dispatch', { operationId: id, kind: 'click', selector: '#validation-submit', fenceOnly: true });
        }, operationId);
        await page.locator(target).evaluate((element, name) => element.setAttribute(name, ''), attribute);
        await page.waitForFunction(() => feedback.some(event => event.kind === 'dom' && event.source === 'page'), null, { timeout: FEEDBACK_WAIT_MS });
        const blocked = await page.evaluate(id => {
          try { __wbPageMonitor.activatePreparedDispatch({ operationId: id, kind: 'click' }); return null; }
          catch (error) { return error.code; }
        }, operationId);
        assert.equal(blocked, 'page_feedback_pending', `${attribute} must stale the prepared submit click`);
        await page.waitForTimeout(180);
      }
    } finally { await browser.close(); }
  });

  test(`${build}: GET submitter activity omits serialized form values from its navigation marker`, async () => {
    const { browser, page } = await fixture(engine, build);
    try {
      await page.evaluate(() => {
        const form = document.createElement('form'); form.id = 'get-submit-form';
        form.method = 'get'; form.action = '/search?fixed=private-action-value#result';
        form.addEventListener('submit', event => event.preventDefault());
        const input = document.createElement('input'); input.name = 'query'; input.value = 'private-form-value';
        const button = document.createElement('button'); button.id = 'get-submit'; button.type = 'submit'; button.textContent = 'Search';
        form.append(input, button); document.body.append(form);
      });
      await page.waitForTimeout(250);
      await page.evaluate(() => {
        feedback = [];
        deliver('page_monitor_prepare', { operationId: 'get-form-submit', tool: 'click', selector: '#get-submit' });
        deliver('page_monitor_dispatch', { operationId: 'get-form-submit', kind: 'click', selector: '#get-submit' });
      });
      await page.locator('#get-submit').click();
      await page.waitForTimeout(150);
      const events = await page.evaluate(() => feedback);
      const marker = events.find(event => event.navigationFormGet === true);
      assert.ok(marker, JSON.stringify(events));
      assert.equal(marker.navigationUrl, 'https://monitor.test/search');
      assert.equal(JSON.stringify(events).includes('private-form-value'), false);
      assert.equal(JSON.stringify(events).includes('private-action-value'), false);
    } finally { await browser.close(); }
  });

  test(`${build}: Enter-triggered form submissions carry agent navigation context`, async () => {
    const { browser, page } = await fixture(engine, build);
    try {
      await page.evaluate(() => {
        const form = document.createElement('form'); form.id = 'enter-submit-form';
        form.method = 'get'; form.action = '/enter-search?fixed=private-action-value#result'; form.target = '_parent';
        form.innerHTML = '<input id="enter-submit-input" name="query" value="private-form-value">'
          + '<button id="enter-submit-button" type="submit">Search</button>';
        form.addEventListener('submit', event => event.preventDefault());
        document.body.append(form);
      });
      await page.waitForTimeout(180);
      await page.evaluate(() => {
        feedback = [];
        deliver('page_monitor_prepare', { operationId: 'enter-submit', tool: 'press_keys', selector: '#enter-submit-input' });
        deliver('page_monitor_dispatch', { operationId: 'enter-submit', kind: 'input', selector: '#enter-submit-input' });
      });
      await page.locator('#enter-submit-input').press('Enter');
      await page.waitForFunction(() => feedback.some(event => event.source === 'agent' && event.operation === 'submit'), null, { timeout: FEEDBACK_WAIT_MS });
      const marker = await page.evaluate(() => feedback.find(event => event.source === 'agent' && event.operation === 'submit'));
      assert.equal(marker.navigationUrl, 'https://monitor.test/enter-search');
      assert.equal(marker.navigationFormGet, true);
      assert.equal(marker.navigationTarget, '_parent');
      const events = await page.evaluate(() => feedback);
      assert.equal(JSON.stringify(events).includes('private-form-value'), false);
      assert.equal(JSON.stringify(events).includes('private-action-value'), false);
      assert.equal(events.some(event => event.kind === 'click' && event.source === 'user'), false,
        `The browser-generated default submit click stays attributed to the agent Enter action: ${JSON.stringify(events)}`);
    } finally { await browser.close(); }
  });

  test(`${build}: stylesheet text changes invalidate prepared actions without exposing CSS`, async () => {
    const { browser, page } = await fixture(engine, build);
    try {
      await page.evaluate(() => {
        const style = document.createElement('style'); style.id = 'page-stylesheet';
        style.textContent = '#stylesheet-target { visibility: visible; }';
        const target = document.createElement('button'); target.id = 'stylesheet-target'; target.textContent = 'Checkout';
        document.head.append(style); document.body.append(target);
      });
      await page.waitForFunction(() => feedback.some(event => event.kind === 'dom'));
      await page.waitForTimeout(180);
      const guard = await page.evaluate(() => {
        feedback = [];
        deliver('page_monitor_prepare', { operationId: 'stylesheet-change', tool: 'click', selector: '#stylesheet-target' });
        deliver('page_monitor_dispatch', { operationId: 'stylesheet-change', kind: 'click', selector: '#stylesheet-target' });
        return lastMonitorResponse.guard;
      });
      await page.locator('#page-stylesheet').evaluate(style => { style.textContent = '#stylesheet-target { visibility: hidden; opacity: 0; }'; });
      await page.waitForFunction(() => feedback.some(event => event.kind === 'dom' && event.target === 'html'));
      const accepted = await page.evaluate(value => window.dispatchEvent(new CustomEvent('webbrain-agent-dom-dispatch', {
        detail: JSON.stringify({ ...value, dispatchPhase: 'focus' }), cancelable: true,
      })), guard);
      assert.equal(accepted, false, 'A stylesheet change must stale a prepared action even without layout movement');
      assert.equal(JSON.stringify(await page.evaluate(() => feedback)).includes('visibility: hidden'), false,
        'Stylesheet contents must not be copied into feedback');
    } finally { await browser.close(); }
  });

  test(`${build}: submitter form association changes invalidate a prepared click`, async () => {
    const { browser, page } = await fixture(engine, build);
    try {
      await page.evaluate(() => {
        const first = document.createElement('form'); first.id = 'first-submit-form';
        const second = document.createElement('form'); second.id = 'second-submit-form';
        const button = document.createElement('button');
        button.id = 'associated-submit'; button.type = 'submit'; button.setAttribute('form', first.id); button.textContent = 'Save';
        document.body.append(first, second, button);
      });
      await page.waitForTimeout(120);

      const guard = await page.evaluate(() => {
        feedback = [];
        deliver('page_monitor_prepare', { operationId: 'submit-form-association', tool: 'click', selector: '#associated-submit' });
        deliver('page_monitor_dispatch', { operationId: 'submit-form-association', kind: 'click', selector: '#associated-submit' });
        return lastMonitorResponse.guard;
      });
      await page.locator('#associated-submit').evaluate(button => button.setAttribute('form', 'second-submit-form'));
      await page.waitForFunction(() => feedback.some(event => event.kind === 'dom' && event.target === 'button#associated-submit'));
      const accepted = await page.evaluate(value => window.dispatchEvent(new CustomEvent('webbrain-agent-dom-dispatch', {
        detail: JSON.stringify({ ...value, dispatchPhase: 'focus' }), cancelable: true,
      })), guard);
      assert.equal(accepted, false, 'Reassociating a submitter must invalidate the prepared click guard');
    } finally { await browser.close(); }
  });

  test(`${build}: hidden native label changes invalidate visible control clicks`, async () => {
    const { browser, page } = await fixture(engine, build);
    try {
      await page.evaluate(() => {
        const form = document.createElement('form');
        form.innerHTML = '<label id="hidden-native-label" for="native-field" style="display:none">Before</label>'
          + '<input id="native-field"><input id="other-field">';
        document.body.append(form);
      });
      await page.waitForFunction(() => feedback.some(event => event.kind === 'dom'));
      await page.waitForTimeout(180);

      const prepare = operationId => page.evaluate(id => {
        feedback = [];
        deliver('page_monitor_prepare', { operationId: id, tool: 'click', selector: '#native-field' });
        deliver('page_monitor_dispatch', { operationId: id, kind: 'click', selector: '#native-field' });
        return lastMonitorResponse.guard;
      }, operationId);
      const assertStale = guard => page.evaluate(value => window.dispatchEvent(new CustomEvent('webbrain-agent-dom-dispatch', {
        detail: JSON.stringify({ ...value, dispatchPhase: 'focus' }), cancelable: true,
      })), guard);

      const textGuard = await prepare('native-label-text');
      await page.locator('#hidden-native-label').evaluate(label => { label.firstChild.data = 'Updated hidden name'; });
      await page.waitForFunction(() => feedback.some(event => event.kind === 'dom' && event.target === 'label#hidden-native-label'));
      assert.equal(await assertStale(textGuard), false, 'Changing hidden native label text must stale its visible control guard');

      const associationGuard = await prepare('native-label-for');
      await page.locator('#hidden-native-label').evaluate(label => label.setAttribute('for', 'other-field'));
      await page.waitForFunction(() => feedback.some(event => event.kind === 'dom' && event.target === 'label#hidden-native-label'));
      assert.equal(await assertStale(associationGuard), false, 'Reassigning a hidden native label must stale its previous control guard');
      assert.equal(JSON.stringify(await page.evaluate(() => feedback)).includes('Updated hidden name'), false,
        'Hidden label text must not be copied into feedback');
    } finally { await browser.close(); }
  });

  test(`${build}: controls after a large select remain in rotating form-state coverage`, async () => {
    const { browser, page } = await fixture(engine, build);
    try {
      await page.evaluate(() => {
        const form = document.createElement('form');
        const select = document.createElement('select');
        select.id = 'large-select';
        select.innerHTML = Array.from({ length: 610 }, (_, index) => `<option value="${index}">Option ${index}</option>`).join('');
        const input = document.createElement('input');
        input.id = 'late-form-control';
        input.value = 'before';
        form.append(select, input);
        document.body.append(form);
      });
      await page.waitForFunction(() => feedback.some(event => event.kind === 'dom'));
      await page.waitForTimeout(180);
      await page.evaluate(() => {
        feedback = [];
        document.getElementById('late-form-control').value = 'sensitive-after';
      });
      await page.waitForFunction(() => feedback.some(event => event.kind === 'dom' && event.target === 'input#late-form-control'), null, { timeout: FEEDBACK_WAIT_MS });
      const serialized = JSON.stringify(await page.evaluate(() => feedback));
      assert.equal(serialized.includes('sensitive-after'), false, 'Detected property values must stay private');
    } finally { await browser.close(); }
  });

  test(`${build}: control polling dereferences only one bounded registry batch`, async () => {
    const { browser, page } = await fixture(engine, build, { instrumentWeakRefDeref: true });
    try {
      await page.evaluate(() => {
        const controls = document.createElement('div');
        for (let index = 0; index < 900; index++) {
          const input = document.createElement('input'); input.id = `bounded-control-${index}`; controls.append(input);
        }
        document.body.append(controls);
      });
      await page.waitForFunction(() => feedback.some(event => event.kind === 'dom'));
      const derefs = await page.evaluate(() => {
        __controlReferenceDerefs = 0;
        deliver('page_monitor_prepare', { operationId: 'bounded-control-sample', tool: 'click', selector: '#agent' });
        deliver('page_monitor_dispatch', { operationId: 'bounded-control-sample', kind: 'click', selector: '#agent', fenceOnly: true });
        return __controlReferenceDerefs;
      });
      assert.ok(derefs > 0 && derefs <= 200, `One sample should dereference at most 200 controls, got ${derefs}`);
    } finally { await browser.close(); }
  });

  for (const action of ['click', 'type']) {
    test(`${build}: ${action} preparation preserves same-target human input`, async () => {
      const { browser, page } = await fixture(engine, build);
      try {
        const selector = action === 'click' ? '#agent' : '#field';
        await page.evaluate(({ action, selector }) => {
          feedback = [];
          deliver('page_monitor_prepare', { operationId: 'preparing', tool: action, selector });
          deliver('page_monitor_dispatch', { operationId: 'preparing', kind: action === 'click' ? 'click' : 'input', selector, fenceOnly: true });
          window.finishPreparation = __wbPageMonitor.beginContentAction(action, { selector, _bidiPrepare: action === 'type' });
        }, { action, selector });
        if (action === 'click') await page.locator(selector).click();
        else { await page.locator(selector).focus(); await page.keyboard.insertText('human'); }
        assert.ok((await page.evaluate(() => feedback)).some(event => event.source === 'user'),
          'Preparation must not consume physical input as an agent action');
        const code = await page.evaluate(() => {
          try { __wbPageMonitor.beforeLocalDispatch(); return null; }
          catch (error) { return error.code; }
          finally { finishPreparation(); }
        });
        assert.equal(code, 'page_feedback_pending');
      } finally { await browser.close(); }
    });
  }

  test(`${build}: ancestor class and style changes track plain content visibility`, async () => {
    const { browser, page } = await fixture(engine, build);
    try {
      await page.evaluate(() => {
        const style = document.createElement('style'); style.textContent = '#plain-result {display:var(--result-display,block)} .closed #plain-result {display:none}'; document.head.append(style);
        const container = document.createElement('div'); container.id = 'style-container'; container.className = 'closed';
        container.style.cssText = 'width:200px;height:80px'; container.innerHTML = '<div id="plain-result">Visible result content</div>';
        document.body.prepend(container);
      });
      for (const attribute of ['class', 'style']) {
        await page.evaluate(attribute => {
          const container = document.getElementById('style-container');
          container.className = 'closed'; container.style.setProperty('--result-display', attribute === 'style' ? 'none' : 'block');
          if (attribute === 'style') container.className = '';
          monitorEnabled = false; deliver('page_monitor_state'); monitorEnabled = true; deliver('page_monitor_state');
        }, attribute);
        await page.waitForTimeout(200);
        for (const show of [true, false]) {
          const unchangedGeometry = await page.evaluate(({ attribute, show }) => {
            feedback = [];
            const container = document.getElementById('style-container'), before = container.getBoundingClientRect();
            if (attribute === 'class') container.className = show ? '' : 'closed';
            else container.style.setProperty('--result-display', show ? 'block' : 'none');
            const after = container.getBoundingClientRect();
            return before.width === after.width && before.height === after.height;
          }, { attribute, show });
          assert.equal(unchangedGeometry, true);
          await page.waitForFunction(() => feedback.some(event => event.kind === 'dom'), null, { timeout: FEEDBACK_WAIT_MS });
          assert.equal(await page.locator('#plain-result').isVisible(), show);
          assert.ok((await page.evaluate(() => feedback)).some(event => event.kind === 'dom'));
        }
      }
    } finally { await browser.close(); }
  });

  test(`${build}: inherited host styles track visible changes inside open shadow roots`, async () => {
    const { browser, page } = await fixture(engine, build);
    try {
      await page.evaluate(() => {
        const host = document.createElement('div'); host.id = 'shadow-inherited-style-host';
        host.className = 'closed'; host.style.cssText = 'width:200px;height:80px';
        host.attachShadow({ mode: 'open' }).innerHTML = '<style>:host { --result-display:none } :host(.open) { --result-display:block } #shadow-inherited-result { display:var(--result-display) }</style><div id="shadow-inherited-result">Shadow result</div>';
        document.body.prepend(host);
      });
      await page.waitForTimeout(200);
      await page.evaluate(() => { feedback = []; });
      for (const shown of [true, false]) {
        await page.evaluate(shown => {
          feedback = [];
          document.getElementById('shadow-inherited-style-host').classList.toggle('open', shown);
        }, shown);
        await page.waitForFunction(() => feedback.some(event => event.kind === 'dom'), null, { timeout: FEEDBACK_WAIT_MS });
        assert.equal(await page.locator('#shadow-inherited-style-host').evaluate(host =>
          getComputedStyle(host.shadowRoot.getElementById('shadow-inherited-result')).display !== 'none'), shown);
        assert.ok(await page.evaluate(() => feedback.some(event => event.kind === 'dom'
          && event.target === 'div#shadow-inherited-result')),
        `A shadow descendant whose inherited visibility changed must be the feedback target: ${JSON.stringify(await page.evaluate(() => feedback))}`);
      }
    } finally { await browser.close(); }
  });

  test(`${build}: large ancestor visibility changes invalidate actions beyond the sampling budget`, async () => {
    const { browser, page } = await fixture(engine, build);
    try {
      await page.evaluate(() => {
        const style = document.createElement('style');
        style.textContent = '#late-result {display:var(--late-display,block)} .closed #late-result {display:none}'; document.head.append(style);
        const region = document.createElement('div'); region.id = 'large-region'; region.className = 'closed';
        region.style.cssText = 'width:200px;height:80px';
        region.innerHTML = '<span style="display:none">Earlier unchanged node</span>'.repeat(650) + '<div id="late-result">Late visible result</div>';
        document.body.prepend(region);
      });
      for (const attribute of ['class', 'style']) {
        await page.evaluate(attribute => {
          const region = document.getElementById('large-region'); region.className = attribute === 'class' ? 'closed' : '';
          region.style.setProperty('--late-display', attribute === 'style' ? 'none' : 'block');
          monitorEnabled = false; deliver('page_monitor_state'); monitorEnabled = true; deliver('page_monitor_state');
        }, attribute);
        await page.waitForTimeout(200);
        for (const shown of [true, false]) {
          const result = await page.evaluate(async ({ attribute, shown }) => {
            const region = document.getElementById('large-region'), before = region.getBoundingClientRect();
            feedback = []; const finish = __wbPageMonitor.beginContentAction('click', { selector: '#agent', _bidiPrepare: true });
            if (attribute === 'class') region.className = shown ? '' : 'closed';
            else region.style.setProperty('--late-display', shown ? 'block' : 'none');
            await Promise.resolve();
            let code; try { __wbPageMonitor.beforeLocalDispatch(); } catch (error) { code = error.code; } finally { finish(); }
            const after = region.getBoundingClientRect();
            return { code, sameGeometry: before.width === after.width && before.height === after.height };
          }, { attribute, shown });
          assert.deepEqual(result, { code: 'page_feedback_pending', sameGeometry: true });
          await page.waitForFunction(() => feedback.some(event => event.kind === 'dom'), null, { timeout: FEEDBACK_WAIT_MS });
          assert.equal(await page.locator('#late-result').isVisible(), shown);
          await page.evaluate(attribute => {
            feedback = []; const region = document.getElementById('large-region');
            region.setAttribute(attribute, region.getAttribute(attribute));
          }, attribute);
          await page.waitForTimeout(200);
          assert.deepEqual(await page.evaluate(() => feedback), [], 'Repeated identical attributes must not trigger the conservative fallback');
        }
      }
      await page.evaluate(() => {
        feedback = []; const finish = __wbPageMonitor.beginContentAction('execute_js');
        try { __wbPageMonitor.beforeLocalDispatch(); document.getElementById('large-region').className = 'agent-theme'; }
        finally { finish(); }
      });
      await page.waitForTimeout(200);
      assert.deepEqual(await page.evaluate(() => feedback), [], 'A synchronous attributed ancestor write must not steer itself');
    } finally { await browser.close(); }
  });

  test(`${build}: same-shape subtree replacements invalidate prepared actions`, async () => {
    const { browser, page } = await fixture(engine, build);
    try {
      await page.evaluate(() => {
        const region = document.createElement('div'); region.id = 'rerender';
        region.style.cssText = 'width:200px;height:50px';
        region.innerHTML = '<div><button id="replace-target" style="width:100px;height:30px">Old</button></div>';
        document.body.prepend(region);
      });
      for (const label of ['New', 'New']) {
        await page.evaluate(() => { monitorEnabled = false; deliver('page_monitor_state'); monitorEnabled = true; deliver('page_monitor_state'); });
        await page.waitForTimeout(200);
        const result = await page.evaluate(async label => {
          feedback = [];
          const region = document.getElementById('rerender'), oldTarget = document.getElementById('replace-target');
          const before = region.getBoundingClientRect();
          const fence = document.documentElement.getAttribute('data-webbrain-page-revision');
          const finish = __wbPageMonitor.beginContentAction('click', { selector: '#replace-target', _bidiPrepare: true });
          region.innerHTML = `<div><button id="replace-target" style="width:100px;height:30px">${label}</button></div>`;
          await Promise.resolve();
          let code;
          try { __wbPageMonitor.beforeLocalDispatch(); } catch (error) { code = error.code; }
          finally { finish(); }
          const after = region.getBoundingClientRect();
          return { code, disconnected: !oldTarget.isConnected, sameSize: before.width === after.width && before.height === after.height,
            revised: fence !== document.documentElement.getAttribute('data-webbrain-page-revision') };
        }, label);
        assert.deepEqual(result, { code: 'page_feedback_pending', disconnected: true, sameSize: true, revised: true });
        await page.waitForFunction(() => feedback.some(event => event.kind === 'dom'));
      }
    } finally { await browser.close(); }
  });

  test(`${build}: long text edits beyond the initial prefix invalidate prepared actions`, async () => {
    const { browser, page } = await fixture(engine, build);
    try {
      await page.evaluate(() => {
        const output = document.createElement('p'); output.id = 'long-output';
        output.style.cssText = 'width:800px;height:160px;font:12px/14px monospace;word-break:break-all';
        output.textContent = 'A'.repeat(260) + ' middle OLD ' + 'B'.repeat(260) + ' suffix OLD';
        document.body.prepend(output);
        monitorEnabled = false; deliver('page_monitor_state'); monitorEnabled = true; deliver('page_monitor_state');
      });
      await page.waitForTimeout(200);
      for (const edit of ['middle', 'suffix', 'append']) {
        const result = await page.evaluate(async edit => {
          feedback = []; const output = document.getElementById('long-output'), before = output.getBoundingClientRect();
          const prefix = output.textContent.slice(0, 200);
          const finish = __wbPageMonitor.beginContentAction('click', { selector: '#agent', _bidiPrepare: true });
          if (edit === 'middle') output.firstChild.data = output.firstChild.data.replace('middle OLD', 'middle NEW');
          else if (edit === 'suffix') output.textContent = output.textContent.replace('suffix OLD', 'suffix NEW');
          else output.firstChild.appendData(' additional output');
          await Promise.resolve();
          let code; try { __wbPageMonitor.beforeLocalDispatch(); } catch (error) { code = error.code; } finally { finish(); }
          const after = output.getBoundingClientRect();
          return { code, sameGeometry: before.width === after.width && before.height === after.height,
            samePrefix: prefix === output.textContent.slice(0, 200) };
        }, edit);
        assert.deepEqual(result, { code: 'page_feedback_pending', sameGeometry: true, samePrefix: true });
        await page.waitForFunction(() => feedback.some(event => event.kind === 'dom'), null, { timeout: FEEDBACK_WAIT_MS });
      }
      await page.evaluate(() => { feedback = []; const output = document.getElementById('long-output'); output.textContent = output.textContent; });
      await page.waitForTimeout(200);
      assert.deepEqual(await page.evaluate(() => feedback), [], 'Replacing an identical text node must remain coalesced');
      await page.evaluate(() => {
        feedback = []; document.getElementById('long-output').firstChild.splitText(270);
      });
      await page.waitForTimeout(200);
      assert.deepEqual(await page.evaluate(() => feedback), [], 'Splitting unchanged text must retain the same content signature');
      await page.evaluate(() => {
        feedback = []; const output = document.getElementById('long-output'); output.normalize(); output.append(document.createTextNode(''));
      });
      await page.waitForTimeout(200);
      assert.deepEqual(await page.evaluate(() => feedback), [], 'Normalizing or adding empty text must not produce feedback');
    } finally { await browser.close(); }
  });

  test(`${build}: aria-pressed-only toggle changes invalidate preparation and preserve agent attribution`, async () => {
    const { browser, page } = await fixture(engine, build);
    try {
      await page.evaluate(() => {
        const toggle = document.getElementById('human'); toggle.setAttribute('aria-pressed', 'false');
        monitorEnabled = false; deliver('page_monitor_state'); monitorEnabled = true; deliver('page_monitor_state');
      });
      await page.waitForTimeout(200);
      for (const state of ['true', 'mixed', 'false']) {
        const code = await page.evaluate(async state => {
          feedback = []; const finish = __wbPageMonitor.beginContentAction('click', { selector: '#human', _bidiPrepare: true });
          document.getElementById('human').setAttribute('aria-pressed', state);
          await Promise.resolve();
          try { __wbPageMonitor.beforeLocalDispatch(); return null; }
          catch (error) { return error.code; }
          finally { finish(); }
        }, state);
        assert.equal(code, 'page_feedback_pending');
        await page.waitForFunction(() => feedback.some(event => event.kind === 'dom' && event.target === 'button#human'), null, { timeout: FEEDBACK_WAIT_MS });
      }
      await page.evaluate(() => {
        feedback = []; const finish = __wbPageMonitor.beginContentAction('execute_js');
        try { __wbPageMonitor.beforeLocalDispatch(); document.getElementById('human').setAttribute('aria-pressed', 'true'); }
        finally { finish(); }
      });
      await page.waitForTimeout(200);
      assert.deepEqual(await page.evaluate(() => feedback), [], 'A marked synchronous toggle must not feed back into its own run');
    } finally { await browser.close(); }
  });

  test(`${build}: observed agent writes refresh pending target samples and preserve later page edits`, async () => {
    const { browser, page } = await fixture(engine, build);
    try {
      await page.evaluate(() => {
        const toggle = document.getElementById('human');
        toggle.setAttribute('aria-pressed', 'false');
        monitorEnabled = false; deliver('page_monitor_state'); monitorEnabled = true; deliver('page_monitor_state');
      });
      await page.waitForTimeout(200);
      await page.evaluate(() => {
        feedback = [];
        // A parked preparation remains live beyond the next periodic sample,
        // so attribution cannot depend on the 200 ms local-action expiry.
        deliver('page_monitor_prepare', { operationId: 'parked-toggle', tool: 'click', selector: '#human', allowPassiveRebase: true });
        const finish = __wbPageMonitor.beginContentAction('execute_js');
        try { __wbPageMonitor.beforeLocalDispatch(); document.getElementById('human').setAttribute('aria-pressed', 'true'); }
        finally { finish(); }
      });
      await page.waitForTimeout(600);
      assert.deepEqual(await page.evaluate(() => feedback), [], 'The periodic sampler must not report an already observed agent write.');
      const stale = await page.evaluate(() => {
        try {
          __wbPageMonitor.activatePreparedDispatch({ operationId: 'parked-toggle', kind: 'click', element: document.getElementById('human') });
          return null;
        } catch (error) { return error.code; }
      });
      assert.equal(stale, 'page_feedback_pending', 'Refreshing the sampling baseline must preserve the immutable target binding.');
      await page.evaluate(() => { document.getElementById('human').setAttribute('aria-pressed', 'false'); });
      await page.waitForFunction(() => feedback.some(event => event.kind === 'dom' && event.target === 'button#human'));
      assert.equal(await page.evaluate(() => feedback.find(event => event.kind === 'dom').source), 'page');
    } finally { await browser.close(); }
  });

  test(`${build}: upgrading an existing host observes its newly attached shadow root`, async () => {
    const { browser, page } = await fixture(engine, build);
    try {
      await page.evaluate(() => {
        const host = document.createElement('wb-late-shadow'); host.id = 'late-shadow';
        host.style.cssText = 'display:block;width:200px;height:50px'; document.body.prepend(host);
        monitorEnabled = false; deliver('page_monitor_state'); monitorEnabled = true; deliver('page_monitor_state');
      });
      await page.waitForTimeout(200);
      const result = await page.evaluate(async () => {
        feedback = [];
        const finish = __wbPageMonitor.beginContentAction('click', { selector: '#agent', _bidiPrepare: true });
        customElements.define('wb-late-shadow', class extends HTMLElement {
          constructor() { super(); this.attachShadow({ mode: 'open' }).innerHTML = '<button id="late-target">Before</button>'; }
        });
        await Promise.resolve();
        try { __wbPageMonitor.beforeLocalDispatch(); return null; }
        catch (error) { return error.code; }
        finally { finish(); }
      });
      assert.equal(result, 'page_feedback_pending');
      await page.waitForFunction(() => feedback.some(event => event.kind === 'dom'));
      await page.evaluate(() => { feedback = []; document.getElementById('late-shadow').shadowRoot.querySelector('button').textContent = 'After'; });
      await page.waitForFunction(() => feedback.some(event => event.kind === 'dom' && event.target === 'button#late-target'));
      await page.evaluate(() => { feedback = []; document.getElementById('late-shadow').shadowRoot.innerHTML = '<button id="late-target">After</button>'; });
      await page.waitForFunction(() => feedback.some(event => event.kind === 'dom'));
      await page.evaluate(() => { monitorEnabled = false; deliver('page_monitor_state'); feedback = []; document.getElementById('late-shadow').shadowRoot.querySelector('button').textContent = 'Stopped'; });
      await page.waitForTimeout(200);
      assert.equal((await page.evaluate(() => feedback)).length, 0);
    } finally { await browser.close(); }
  });

  test(`${build}: marked synchronous DOM writes suppress their own effects and retain later edits`, async () => {
    const { browser, page } = await fixture(engine, build);
    try {
      const gates = await page.evaluate(() => {
        feedback = [];
        window.pageSawAgentGate = false;
        window.addEventListener('webbrain-agent-dom-dispatch', () => { window.pageSawAgentGate = true; }, true);
        deliver('page_monitor_prepare', { operationId: 'dom-write', tool: 'execute_js' });
        deliver('page_monitor_dispatch', { operationId: 'dom-write', kind: 'dom' });
        const detail = JSON.stringify(lastMonitorResponse.guard);
        const accepted = window.dispatchEvent(new CustomEvent('webbrain-agent-dom-dispatch', { detail, cancelable: true }));
        const replayed = window.dispatchEvent(new CustomEvent('webbrain-agent-dom-dispatch', { detail, cancelable: true }));
        document.getElementById('status').textContent = 'Own DOM write';
        return { accepted, replayed, pageSawGate: window.pageSawAgentGate };
      });
      assert.deepEqual(gates, { accepted: true, replayed: false, pageSawGate: false },
        'The one-use gate authorizes the agent write without exposing its revision token to page listeners');
      await page.waitForTimeout(200);
      assert.equal((await page.evaluate(() => feedback)).length, 0);
      await page.evaluate(() => { document.getElementById('status').textContent = 'External DOM edit'; });
      await page.waitForFunction(() => feedback.some(event => event.kind === 'dom'));
    } finally { await browser.close(); }
  });

  test(`${build}: stale execute_js dispatch gates are cancelled before page code runs`, async () => {
    const { browser, page } = await fixture(engine, build);
    try {
      const guard = await page.evaluate(() => {
        deliver('page_monitor_prepare', { operationId: 'stale-js', tool: 'execute_js' });
        deliver('page_monitor_dispatch', { operationId: 'stale-js', kind: 'dom' });
        return lastMonitorResponse.guard;
      });
      await page.locator('#human').click();
      const result = await page.evaluate(guard => {
        const gate = new CustomEvent('webbrain-agent-dom-dispatch', { detail: JSON.stringify(guard), cancelable: true });
        return { accepted: window.dispatchEvent(gate), prevented: gate.defaultPrevented };
      }, guard);
      assert.deepEqual(result, { accepted: false, prevented: true },
        'The page-side bridge must cancel a guarded DOM write after user input invalidates its revision');
    } finally { await browser.close(); }
  });

  test(`${build}: guarded DOM-click fallback gates focus and click once each`, async () => {
    const { browser, page } = await fixture(engine, build);
    try {
      const guard = await page.evaluate(() => {
        feedback = [];
        deliver('page_monitor_prepare', { operationId: 'dom-click-phases', tool: 'click', selector: '#agent' });
        deliver('page_monitor_dispatch', { operationId: 'dom-click-phases', kind: 'click', selector: '#agent' });
        return lastMonitorResponse.guard;
      });
      const phases = await page.evaluate(value => {
        const dispatch = phase => window.dispatchEvent(new CustomEvent('webbrain-agent-dom-dispatch', {
          detail: JSON.stringify({ ...value, dispatchPhase: phase }), cancelable: true,
        }));
        const focus = dispatch('focus');
        document.getElementById('agent').focus();
        const click = dispatch('click');
        if (click) document.getElementById('agent').click();
        const replay = dispatch('click');
        return { focus, click, replay };
      }, guard);
      assert.deepEqual(phases, { focus: true, click: true, replay: false });
      assert.equal(await page.locator('#status').textContent(), 'Agent changed this');
      await page.waitForTimeout(150);
      assert.equal((await page.evaluate(() => feedback)).some(event => event.source !== 'agent'), false);
    } finally { await browser.close(); }
  });

  test(`${build}: explicit agent focus is attributed before focusin`, async () => {
    const { browser, page } = await fixture(engine, build);
    try {
      const events = await page.evaluate(() => {
        feedback = [];
        const target = document.getElementById('field');
        const finish = __wbPageMonitor.beginContentAction('click', { selector: '#agent', _bidiPrepare: true });
        try {
          __wbPageMonitor.beforeLocalDispatch({ kind: 'focus', target });
          target.focus();
          return feedback;
        } finally { finish(); }
      });
      assert.deepEqual(events, [], 'A focus event emitted immediately after its exact dispatch marker is agent activity');
    } finally { await browser.close(); }
  });

  test(`${build}: native clear chords renew per phase and still detect later human keys`, async () => {
    const { browser, page } = await fixture(engine, build);
    try {
      await page.locator('#field').fill('old');
      await page.waitForTimeout(200);
      const guard = await page.evaluate(() => {
        deliver('page_monitor_prepare', { operationId: 'clear-chord', tool: 'set_field', selector: '#field' });
        deliver('page_monitor_dispatch', { operationId: 'clear-chord', kind: 'input', selector: '#field', fenceOnly: true });
        feedback = []; return lastMonitorResponse.guard;
      });
      const mark = sequence => page.evaluate(marker => document.getElementById('field')
        .setAttribute('data-webbrain-native-action', marker), createNativeActionMarker(guard, 'input', sequence));
      const selectModifier = await page.evaluate(() => /Mac|iPhone|iPad|iPod/i.test(navigator.platform) ? 'Meta' : 'Control');
      await mark(1); await page.keyboard.down(selectModifier);
      await mark(2); await page.keyboard.press('a'); await page.keyboard.up(selectModifier);
      await mark(3); await page.keyboard.press('Delete');
      await mark(4); await page.keyboard.insertText('new');
      assert.equal(await page.locator('#field').inputValue(), 'new');
      assert.equal((await page.evaluate(() => feedback)).some(event => event.source !== 'agent'), false);
      await page.keyboard.type('human');
      assert.ok((await page.evaluate(() => feedback)).some(event => event.source === 'user'));
      assert.notEqual(await page.evaluate(() => document.documentElement.getAttribute('data-webbrain-page-revision')),
        `${guard.documentToken}:${guard.revision}`);
    } finally { await browser.close(); }
  });

  test(`${build}: native hover markers attribute hover-triggered page changes to the agent`, async () => {
    const { browser, page } = await fixture(engine, build);
    try {
      const guard = await page.evaluate(() => {
        feedback = [];
        document.getElementById('agent').addEventListener('pointerover', () => {
          document.getElementById('status').textContent = 'Pointer hover changed';
        });
        document.getElementById('agent').addEventListener('mouseover', () => {
          document.getElementById('status').textContent = 'Mouse hover changed';
        });
        deliver('page_monitor_prepare', { operationId: 'native-hover', tool: 'hover', selector: '#agent' });
        deliver('page_monitor_dispatch', { operationId: 'native-hover', kind: 'click', navigationCandidate: false, fenceOnly: true });
        return lastMonitorResponse.guard;
      });
      const marker = createNativeActionMarker(guard, 'click', 1);
      await page.locator('#agent').evaluate((element, value) => element.setAttribute('data-webbrain-native-action', value), marker);
      await page.locator('#agent').hover();
      assert.match(await page.locator('#status').textContent(), /hover changed/i);
      await page.waitForTimeout(200);
      assert.equal((await page.evaluate(() => feedback)).some(event => event.source !== 'agent'), false,
        'The first trusted hover event must activate and attribute its prepared native operation');
      await page.locator('#human').click();
      await page.waitForTimeout(200);
      assert.ok((await page.evaluate(() => feedback)).some(event => event.source === 'user'),
        'A subsequent user click remains visible to the monitor');
    } finally { await browser.close(); }
  });

  test(`${build}: native uploads target an unfocused file input without hiding user input`, async () => {
    const { browser, page } = await fixture(engine, build);
    const session = new BidiSession(), runId = crypto.randomUUID(), token = crypto.randomUUID();
    session.runs.set(runId, { context: 'tab' });
    session.locate = async () => ({ context: 'tab', node: { sharedId: 'upload' } });
    session.call = async (_match, declaration, args = []) => ({ result: { value: await page.evaluate(({ declaration, args }) =>
      (0, eval)(`(${declaration})`)(document.getElementById('upload'), ...args.map(arg => arg.value)), { declaration, args }) } });
    session.send = async (method, params) => {
      if (method === 'input.setFiles') await page.locator('#upload').setInputFiles(params.files);
      return {};
    };
    try {
      await page.evaluate(token => {
        const input = document.createElement('input'); input.id = 'upload'; input.type = 'file';
        input.setAttribute('data-webbrain-bidi', token); document.body.append(input);
      }, token);
      await page.waitForTimeout(200);
      await page.locator('#field').focus();
      const guard = await page.evaluate(() => {
        deliver('page_monitor_prepare', { operationId: 'upload', tool: 'upload_file', selector: '#upload' });
        deliver('page_monitor_dispatch', { operationId: 'upload', kind: 'input', selector: '#upload', navigationCandidate: false, fenceOnly: true });
        feedback = []; return lastMonitorResponse.guard;
      });
      assert.equal((await session.perform(runId, 'upload', { token, base64: 'eA==', filename: 'test.txt', pageFeedbackGuard: guard },
        async (_runId, currentGuard, kind) => page.evaluate(({ currentGuard, kind }) => {
          deliver('page_monitor_validate', { ...currentGuard, kind }); return lastMonitorResponse.ready;
        }, { currentGuard, kind }))).success, true);
      await page.waitForTimeout(200);
      assert.equal((await page.evaluate(() => feedback)).some(event => event.source !== 'agent'), false);
      assert.equal(await page.evaluate(() => document.activeElement.id), 'field');
      await page.keyboard.insertText('human');
      assert.ok((await page.evaluate(() => feedback)).some(event => event.kind === 'input' && event.source === 'user'));
    } finally { await session.close(); await browser.close(); }
  });

  test(`${build}: upload fences reject user changes and replacement inputs before file assignment`, async () => {
    const { browser, page } = await fixture(engine, build);
    try {
      await page.evaluate(() => {
        const input = document.createElement('input'); input.id = 'guarded-upload'; input.type = 'file';
        document.body.append(input);
      });
      await page.waitForTimeout(200);
      const prepare = operationId => page.evaluate(id => {
        deliver('page_monitor_prepare', { operationId: id, tool: 'upload_file', selector: '#guarded-upload' });
        deliver('page_monitor_dispatch', { operationId: id, kind: 'input', selector: '#guarded-upload', fenceOnly: true });
        return lastMonitorResponse.guard;
      }, operationId);
      const assignIfCurrent = operationId => page.evaluate(id => {
        const input = document.getElementById('guarded-upload');
        const transfer = new DataTransfer(); transfer.items.add(new File(['x'], 'test.txt'));
        try {
          __wbPageMonitor.activatePreparedDispatch({ operationId: id, kind: 'input', element: input });
        } catch (error) {
          return { code: error.code, files: input.files.length };
        }
        __wbPageMonitor.withPreparedDispatch(id, () => { input.files = transfer.files; });
        return { code: null, files: input.files.length };
      }, operationId);

      const userGuard = await prepare('upload-after-user-change');
      assert.ok(userGuard?.operationId);
      await page.locator('#human').click();
      const afterUserChange = await assignIfCurrent('upload-after-user-change');
      assert.equal(afterUserChange.code, 'page_feedback_pending');
      assert.equal(afterUserChange.files, 0, 'user activity must block FileList assignment');

      const replacementGuard = await prepare('upload-after-target-replacement');
      assert.ok(replacementGuard?.operationId);
      await page.evaluate(() => {
        const oldInput = document.getElementById('guarded-upload');
        const replacement = document.createElement('input'); replacement.id = oldInput.id; replacement.type = 'file';
        oldInput.replaceWith(replacement);
      });
      await page.waitForTimeout(120);
      const afterReplacement = await assignIfCurrent('upload-after-target-replacement');
      assert.equal(afterReplacement.code, 'page_feedback_pending');
      assert.equal(afterReplacement.files, 0, 'a selector replacement must not receive a prepared upload');
    } finally { await browser.close(); }
  });

  test(`${build}: navigation notes are plain text, deduplicated and survive history restoration`, async () => {
    const browser = await engine.launch({ headless: true });
    try {
      const page = await browser.newPage();
      await page.setContent('<div id="assistant"></div>');
      await page.addScriptTag({ content: read(build, 'ui/page-feedback-ui.js').replace('export function', 'function') });
      await page.evaluate(() => {
        const translate = (_key, args) => `Page changed (${args.before} → ${args.after}). Continuing.`;
        const data = { id: 'notice-1', navigation: true, before: 'https://u:password@example.com/a?secret=yes',
          after: 'https://example.com/<img>?private=value#token' };
        renderPageFeedbackNote(document.getElementById('assistant'), data, translate);
        renderPageFeedbackNote(document.getElementById('assistant'), data, translate);
        document.body.innerHTML = document.body.innerHTML;
        renderPageFeedbackNote(document.getElementById('assistant'), data, translate);
      });
      assert.equal(await page.locator('.page-feedback-note').count(), 1);
      assert.equal(await page.locator('img').count(), 0);
      const text = await page.locator('.page-feedback-note').textContent();
      assert.equal(/password|private=value|secret=yes|#token/.test(text), false);
      assert.match(text, /Continuing/);
    } finally { await browser.close(); }
  });
}
