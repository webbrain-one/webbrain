// Delivery regressions for Chrome trusted CDP input (C2-C5):
// - press_keys never falls back to synthetic keys after a trusted key may have
//   reached the page, and reports how many key presses were acknowledged;
// - CDP click reports delivered input as dispatched/outcome-unknown and
//   lets a page-feedback fence veto before any press stay undispatched;
// - text input marks dispatch only after the fence passes, so a vetoed
//   insertion cannot create uncertain-text debt;
// - cdpClient.clickElement never falls back to a DOM/JS click after a press.
//
// Two kinds of fixtures, labelled per test:
// [real DOM] the real Agent and cdpClient drive real Chromium through a
//   Playwright CDP session bridged into chrome.debugger.sendCommand; the page
//   counts the events it actually received. Failures are injected only into
//   protocol acknowledgements (after the command reached the page) or before
//   the protocol call.
// [mocked transport] the real Agent with cdpClient.sendCommand replaced; a
//   page_feedback_pending rejection models the dispatch fence, which rejects
//   before any protocol command is sent.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { chromium } from 'playwright';

const area = { get: async () => ({}), set: async () => {}, remove: async () => {} };
const api = {
  storage: { local: area, session: area },
  runtime: { getURL: value => `extension://test/${value}`, getManifest: () => ({ version: 'test' }), lastError: null },
  tabs: { get: async () => ({ id: 17, url: 'https://cdp-delivery.test/start' }), query: async () => [{ id: 17 }] },
  scripting: { executeScript: async () => [{}] },
  debugger: { sendCommand: () => { throw new Error('debugger bridge not installed'); },
    onEvent: { addListener() {}, removeListener() {} }, onDetach: { addListener() {}, removeListener() {} } },
};
globalThis.chrome = api;
globalThis.browser = api;
const { Agent } = await import('../src/chrome/src/agent/agent.js');
const { cdpClient } = await import('../src/chrome/src/cdp/cdp-client.js');
const original = {
  sendCommand: cdpClient.sendCommand,
  attach: cdpClient.attach,
  evaluate: cdpClient.evaluate,
  arm: cdpClient.armFileInputClickGuard,
  consume: cdpClient.consumeFileInputClickGuard,
  resolveSelector: cdpClient.resolveSelector,
  evaluateFunction: cdpClient.evaluateFunction,
  textEntrySignature: cdpClient.textEntrySignature,
  verifyTextEntry: cdpClient.verifyTextEntry,
  selectAllModifier: cdpClient.selectAllModifier,
  captureTextClearReceipt: cdpClient.captureTextClearReceipt,
};
function restoreCdp() {
  Object.assign(cdpClient, {
    sendCommand: original.sendCommand, attach: original.attach, evaluate: original.evaluate,
    armFileInputClickGuard: original.arm, consumeFileInputClickGuard: original.consume,
    resolveSelector: original.resolveSelector, evaluateFunction: original.evaluateFunction,
    textEntrySignature: original.textEntrySignature, verifyTextEntry: original.verifyTextEntry,
    selectAllModifier: original.selectAllModifier, captureTextClearReceipt: original.captureTextClearReceipt,
  });
  cdpClient.sessions.delete(17);
}

const pageFeedbackVeto = () => Object.assign(
  new Error('The browser changed during action preparation. Re-observe the page before acting.'),
  { code: 'page_feedback_pending' },
);

function newAgent() {
  const agent = new Agent({ getActive: () => ({ model: 'delivery-test' }) });
  agent._currentUrl = async () => 'https://cdp-delivery.test/start';
  agent._clickProgressSnapshot = async () => '';
  agent._redirectTargetBlankClick = async () => null;
  agent._showAgentTarget = () => {};
  agent._keyProgressSnapshot = async () => '';
  return agent;
}

const keysHtml = `<!doctype html><main><h1>Notes</h1><label>Note <textarea id="note"></textarea></label>
<button id="post" type="button">Post</button><output id="count">0</output></main>
<script>window.qaKeys = []; window.qaClicks = 0;
note.addEventListener('keydown', event => qaKeys.push({ key: event.key, trusted: event.isTrusted }));
post.addEventListener('click', event => { qaClicks++; count.textContent = String(qaClicks); });
note.focus();</script>`;

// [real DOM] Bridge chrome.debugger.sendCommand to a real Chromium CDP session.
async function realChromium(body, { contentScripts = true } = {}) {
  const browserInstance = await chromium.launch({ headless: true });
  const context = await browserInstance.newContext({ viewport: { width: 900, height: 600 } });
  await context.route('https://cdp-delivery.test/**', route => route.fulfill({ contentType: 'text/html', body }));
  await context.addInitScript(() => {
    window.qaListeners = [];
    const runtime = {
      onMessage: { addListener: fn => qaListeners.push(fn), removeListener() {} },
      getURL: value => value,
      async sendMessage(message) { return message.action === 'get_page_monitor_state' ? { active: false } : {}; },
    };
    window.chrome = { runtime }; window.browser = window.chrome;
    window.qaMessage = message => new Promise(resolve => {
      let answered = false, pending = false;
      const respond = value => { if (!answered) { answered = true; resolve(value); } };
      for (const listener of [...qaListeners]) if (listener(message, {}, respond) === true) pending = true;
      if (!answered && !pending) resolve(undefined);
    });
  });
  if (contentScripts) {
    for (const file of ['file-upload-policy.js', 'rich-text-toolbar-heuristic.js', 'accessibility-tree.js', 'page-monitor.js', 'content.js']) {
      await context.addInitScript({ content: fs.readFileSync(new URL(`../src/chrome/src/content/${file}`, import.meta.url), 'utf8') });
    }
  }
  const page = await context.newPage();
  await page.goto('https://cdp-delivery.test/start');
  const session = await context.newCDPSession(page);
  const protocol = [];
  const hooks = { before: null, after: null };
  api.debugger.sendCommand = (_target, method, params, callback) => {
    protocol.push({ method, type: params?.type, key: params?.key });
    Promise.resolve()
      .then(() => hooks.before?.(method, params))
      .then(() => session.send(method, params))
      .then(async result => { await hooks.after?.(method, params); return result; })
      .then(callback, error => {
        api.runtime.lastError = { message: error.message };
        try { callback(); } finally { api.runtime.lastError = null; }
      });
  };
  cdpClient.attach = async tabId => { cdpClient.sessions.set(tabId, { tabId, attached: true }); return cdpClient.sessions.get(tabId); };
  await cdpClient.attach(17);
  // The file-chooser guard is unrelated CDP interception; keep it inert.
  cdpClient.armFileInputClickGuard = async () => {};
  cdpClient.consumeFileInputClickGuard = async () => ({ blocked: false });
  api.tabs.sendMessage = async (_tabId, message) => page.evaluate(m => window.qaMessage(m), message);
  return {
    page, protocol, hooks,
    async close() { restoreCdp(); await browserInstance.close(); },
  };
}

test('[real DOM] press_keys: a lost keyDown acknowledgement after the first key is never replayed synthetically', async () => {
  const fixture = await realChromium(keysHtml);
  try {
    let keyDowns = 0;
    fixture.hooks.after = method => {
      // The second keyDown reaches the page; only its acknowledgement is lost.
      if (method === 'Input.dispatchKeyEvent' && fixture.protocol.at(-1)?.type === 'keyDown' && ++keyDowns === 2) {
        throw new Error('Detached while handling command.');
      }
    };
    const agent = newAgent();
    let contentKeys = 0;
    const send = api.tabs.sendMessage;
    api.tabs.sendMessage = async (tabId, message) => {
      if (message.action === 'press_keys') contentKeys++;
      return send(tabId, message);
    };
    const result = await agent.executeTool(17, 'press_keys', { key: 'ArrowDown', repeat: 3 });
    const keys = await fixture.page.evaluate(() => window.qaKeys);
    assert.equal(contentKeys, 0, 'no synthetic content-script fallback after trusted delivery');
    assert.equal(keys.length, 2, 'the page received exactly the two trusted keyDowns that were sent');
    assert.ok(keys.every(key => key.trusted === true));
    assert.equal(result.success, false);
    assert.equal(result.dispatched, true);
    assert.equal(result.outcomeUnknown, true);
    assert.equal(result.retryable, false);
    assert.equal(result.deliveredKeys, 1, 'one complete key press was acknowledged');
  } finally { await fixture.close(); }
});

test('[real DOM] press_keys: normal trusted repeats are delivered once each', async () => {
  const fixture = await realChromium(keysHtml);
  try {
    const agent = newAgent();
    const result = await agent.executeTool(17, 'press_keys', { key: 'ArrowDown', repeat: 2 });
    const keys = await fixture.page.evaluate(() => window.qaKeys);
    assert.equal(keys.length, 2);
    assert.ok(keys.every(key => key.trusted === true && key.key === 'ArrowDown'));
    assert.equal(result.method, 'cdp-key');
    assert.equal(result.dispatched, true);
  } finally { await fixture.close(); }
});

test('[mocked transport] press_keys: target preparation failing before the second key never replays the first one', async () => {
  const agent = newAgent();
  const sent = [];
  cdpClient.attach = async () => {};
  cdpClient.sendCommand = async (_tab, method, params) => {
    if (method === 'Input.dispatchKeyEvent' && params.type === 'keyDown' && sent.filter(type => type === 'keyDown').length === 1) {
      throw new Error('Cannot find context with specified id');
    }
    if (method === 'Input.dispatchKeyEvent') sent.push(params.type);
    return {};
  };
  let contentKeys = 0;
  api.tabs.sendMessage = async (_tab, message) => {
    if (message.action === 'press_keys') { contentKeys++; return { success: true, dispatched: true, method: 'keyboardevent' }; }
    return { success: true };
  };
  try {
    const state = { started: false };
    const result = await agent._executeToolImpl(17, 'press_keys', { key: 'Enter', repeat: 2 }, null,
      { _contentActionAbortSignal: new AbortController().signal, _contentActionDispatchState: state });
    assert.deepEqual(sent, ['keyDown', 'keyUp']);
    assert.equal(contentKeys, 0);
    assert.equal(state.started, true);
    assert.equal(result.dispatched, true);
    assert.equal(result.outcomeUnknown, true);
    assert.equal(result.deliveredKeys, 1);
    assert.notEqual(result.noDispatch, true);
  } finally { restoreCdp(); }
});

test('[mocked transport] press_keys: a fence veto before any key stays undispatched and is not replayed synthetically', async () => {
  const agent = newAgent();
  cdpClient.attach = async () => {};
  cdpClient.sendCommand = async (_tab, method) => {
    if (method === 'Input.dispatchKeyEvent') throw pageFeedbackVeto();
    return {};
  };
  let contentKeys = 0;
  api.tabs.sendMessage = async (_tab, message) => {
    if (message.action === 'press_keys') { contentKeys++; return { success: true, dispatched: true, method: 'keyboardevent' }; }
    return { success: true };
  };
  try {
    const result = await agent.executeTool(17, 'press_keys', { key: 'Enter' });
    assert.equal(contentKeys, 0, 'a vetoed trusted key must not become a synthetic key');
    assert.equal(result.success, false);
    assert.equal(result.noDispatch, true);
    assert.equal(result.dispatched, false);
    assert.equal(result.pageFeedbackPending, true);
  } finally { restoreCdp(); }
});

function mockTextClick({ failPressWith = null, failAfterRelease = null } = {}) {
  const events = [];
  cdpClient.attach = async () => {};
  cdpClient.armFileInputClickGuard = async () => {};
  cdpClient.consumeFileInputClickGuard = async () => ({ blocked: false });
  cdpClient.evaluate = async (_tab, expression) => {
    if (/const needle =/.test(expression)) {
      return { result: { value: { found: true, mode: 'exact', x: 5, y: 5, width: 10, height: 10, tag: 'DIV', text: 'Post',
        isSubmitControl: false, isEditableControl: false } } };
    }
    if (failAfterRelease && events.includes('mouseReleased')) throw failAfterRelease();
    return { result: { value: null } };
  };
  cdpClient.sendCommand = async (_tab, method, params) => {
    if (method === 'Input.dispatchMouseEvent') {
      if (params.type === 'mousePressed' && failPressWith) throw failPressWith();
      events.push(params.type);
    }
    return {};
  };
  return events;
}

test('[mocked transport] CDP click: a navigation-destroyed post-click read keeps the delivered click dispatched', async () => {
  const agent = newAgent();
  agent._annotateClickProgress = async (_t, _n, _a, response) => response;
  const events = mockTextClick({ failAfterRelease: () => new Error('Execution context was destroyed.') });
  try {
    const state = { started: false };
    const result = await agent._executeToolImpl(17, 'click', { text: 'Post' }, null,
      { _contentActionAbortSignal: new AbortController().signal, _contentActionDispatchState: state });
    assert.deepEqual(events, ['mouseMoved', 'mousePressed', 'mouseReleased']);
    assert.equal(state.started, true);
    assert.equal(result.success, false);
    assert.equal(result.dispatched, true);
    assert.equal(result.outcomeUnknown, true);
    assert.equal(result.retryable, false);
    assert.notEqual(result.noDispatch, true);
  } finally { restoreCdp(); }
});

test('[mocked transport] CDP click: a fence veto before the press is reported undispatched', async () => {
  const agent = newAgent();
  agent._annotateClickProgress = async (_t, _n, _a, response) => response;
  const events = mockTextClick({ failPressWith: pageFeedbackVeto });
  try {
    const result = await agent.executeTool(17, 'click', { text: 'Post' });
    assert.deepEqual(events, ['mouseMoved']);
    assert.equal(result.success, false);
    assert.equal(result.dispatched, false);
    assert.equal(result.noDispatch, true);
    assert.equal(result.pageFeedbackPending, true);
  } finally { restoreCdp(); }
});

test('[mocked transport] CDP click by text: a normal click delivers one press/release and succeeds', async () => {
  const agent = newAgent();
  agent._annotateClickProgress = async (_t, _n, _a, response) => response;
  const events = mockTextClick();
  try {
    const state = { started: false };
    const result = await agent._executeToolImpl(17, 'click', { text: 'Post' }, null,
      { _contentActionAbortSignal: new AbortController().signal, _contentActionDispatchState: state });
    assert.deepEqual(events, ['mouseMoved', 'mousePressed', 'mouseReleased']);
    assert.equal(result.success, true);
    assert.equal(result.method, 'cdp-by-text');
    assert.equal(state.started, true);
  } finally { restoreCdp(); }
});

// The agent cursor glides onto the target before the click (_leadAgentCursor).
// The page may move meanwhile, so the click must use where the target is
// after the glide, never the geometry read before it.
function leadingCursor(agent, order) {
  agent.isAgentIndicatorShown = () => true;
  agent._showAgentTarget = (_tab, _target, _source, phase) => {
    if (phase !== 'approach') return null;
    order.push('approach');
    return Promise.resolve({ ok: true, arriveInMs: 40 });
  };
}

test('[mocked transport] CDP click by text: a target that moves while the cursor glides is clicked where it lands', async () => {
  const agent = newAgent();
  agent._annotateClickProgress = async (_t, _n, _a, response) => response;
  const order = [];
  leadingCursor(agent, order);
  const presses = [];
  let resolutions = 0;
  cdpClient.attach = async () => {};
  cdpClient.armFileInputClickGuard = async () => {};
  cdpClient.consumeFileInputClickGuard = async () => ({ blocked: false });
  cdpClient.evaluate = async (_tab, expression) => {
    // The click's own text resolution (not the auto-select probe before it).
    if (/const needle =/.test(expression) && /wbmn_/.test(expression)) {
      order.push('resolve');
      // Content loads above the button while the cursor glides: it moves down.
      const y = resolutions++ === 0 ? 5 : 105;
      return { result: { value: { found: true, mode: 'exact', x: 205, y, width: 10, height: 10, tag: 'BUTTON', text: 'Post',
        isSubmitControl: false, isEditableControl: false } } };
    }
    return { result: { value: null } };
  };
  cdpClient.sendCommand = async (_tab, method, params) => {
    if (method === 'Input.dispatchMouseEvent' && params.type === 'mousePressed') presses.push([params.x, params.y]);
    return {};
  };
  try {
    const result = await agent._executeToolImpl(17, 'click', { text: 'Post' }, null,
      { _contentActionAbortSignal: new AbortController().signal, _contentActionDispatchState: { started: false } });
    assert.equal(result.success, true);
    assert.deepEqual(order, ['resolve', 'approach', 'resolve'], 'the text is resolved again after the glide');
    assert.deepEqual(presses, [[205, 105]], 'the press goes where the button is after the glide');
  } finally { restoreCdp(); }
});

test('[mocked transport] CDP click by coordinates: the point is checked only after the cursor glides there', async () => {
  const agent = newAgent();
  agent._annotateClickProgress = async (_t, _n, _a, response) => response;
  const order = [];
  leadingCursor(agent, order);
  cdpClient.attach = async () => {};
  cdpClient.armFileInputClickGuard = async () => {};
  cdpClient.consumeFileInputClickGuard = async () => ({ blocked: false });
  cdpClient.evaluate = async (_tab, expression) => {
    if (/elementFromPoint/.test(expression)) order.push('check point');
    return { result: { value: null } };
  };
  cdpClient.sendCommand = async (_tab, method, params) => {
    if (method === 'Input.dispatchMouseEvent' && params.type === 'mousePressed') order.push('press');
    return {};
  };
  try {
    await agent._executeToolImpl(17, 'click', { x: 120, y: 80, coordinate_space: 'css' }, null,
      { _contentActionAbortSignal: new AbortController().signal, _contentActionDispatchState: { started: false } });
    assert.equal(order[0], 'approach', order.join(' > '));
    assert.ok(order.includes('check point') && order.includes('press'), order.join(' > '));
    assert.ok(order.indexOf('check point') > order.indexOf('approach'), order.join(' > '));
  } finally { restoreCdp(); }
});

const buttonHtml = `<!doctype html><main><h1>Compose</h1>
<button id="post" type="button" style="position:absolute;left:100px;top:100px;width:120px;height:40px">Post</button></main>
<script>window.qaClicks = []; post.addEventListener('click', event => qaClicks.push(event.isTrusted));</script>`;

test('[real DOM] clickElement: a lost release acknowledgement never adds a DOM/JS fallback click', async () => {
  const fixture = await realChromium(buttonHtml, { contentScripts: false });
  try {
    fixture.hooks.after = (method, params) => {
      if (method === 'Input.dispatchMouseEvent' && params.type === 'mouseReleased' && params.clickCount === 1) {
        throw new Error('Internal error');
      }
    };
    let authorizations = 0, dispatchMarks = 0;
    const result = await cdpClient.clickElement(17, '#post', {
      beforeDispatch: async () => { authorizations++; return { success: true }; },
      onDispatch: () => { dispatchMarks++; },
    });
    const clicks = await fixture.page.evaluate(() => window.qaClicks);
    assert.deepEqual(clicks, [true], 'exactly one trusted activation; no DOM/JS fallback click');
    assert.equal(authorizations, 1);
    assert.equal(dispatchMarks, 1);
    assert.equal(result.success, false);
    assert.equal(result.dispatched, true);
    assert.equal(result.outcomeUnknown, true);
    assert.equal(result.retryable, false);
    assert.deepEqual(fixture.protocol.filter(entry => entry.method === 'Input.dispatchMouseEvent')
      .map(entry => entry.type).slice(0, 3), ['mouseMoved', 'mousePressed', 'mouseReleased']);
  } finally { await fixture.close(); }
});

test('[real DOM] clickElement: a normal selector click is one trusted activation', async () => {
  const fixture = await realChromium(buttonHtml, { contentScripts: false });
  try {
    let dispatchMarks = 0;
    const result = await cdpClient.clickElement(17, '#post', { onDispatch: () => { dispatchMarks++; } });
    assert.equal(result.success, true);
    assert.deepEqual(await fixture.page.evaluate(() => window.qaClicks), [true]);
    assert.equal(dispatchMarks, 1);
  } finally { await fixture.close(); }
});

test('[real DOM] clickElement: a press that never reached the protocol may use the single JS fallback', async () => {
  const fixture = await realChromium(buttonHtml, { contentScripts: false });
  try {
    // The real transport refuses the press at its last pre-protocol check, so
    // the command never reaches chrome.debugger.sendCommand.
    const sendCommand = cdpClient.sendCommand;
    cdpClient.sendCommand = function (tabId, method, params, sessionId, options) {
      if (method === 'Input.dispatchMouseEvent' && params.type === 'mousePressed') {
        return sendCommand.call(this, tabId, method, params, sessionId,
          { ...options, beforeSend: () => { throw new Error(`Not attached to tab ${tabId}`); } });
      }
      return sendCommand.call(this, tabId, method, params, sessionId, options);
    };
    let dispatchMarks = 0;
    const result = await cdpClient.clickElement(17, '#post', { onDispatch: () => { dispatchMarks++; } });
    assert.equal(result.success, true);
    assert.equal(result.method, 'js-click');
    assert.deepEqual(await fixture.page.evaluate(() => window.qaClicks), [false], 'one synthetic activation only');
    assert.equal(dispatchMarks, 1);
  } finally { await fixture.close(); }
});

test('[mocked transport] CDP click by selector: a fence veto before the press is undispatched and keeps no started state', async () => {
  const agent = newAgent();
  agent._annotateClickProgress = async (_t, _n, _a, response) => response;
  cdpClient.attach = async () => {};
  cdpClient.evaluate = async () => ({ result: { value: null } });
  cdpClient.armFileInputClickGuard = async () => {};
  cdpClient.consumeFileInputClickGuard = async () => ({ blocked: false });
  cdpClient.resolveSelector = async () => ({ inViewport: true, hitOk: true, x: 10, y: 10, width: 20, height: 20, tag: 'BUTTON', text: 'Send' });
  const events = [];
  cdpClient.sendCommand = async (_tab, method, params) => {
    if (method === 'Input.dispatchMouseEvent') {
      if (params.type === 'mousePressed') throw pageFeedbackVeto();
      events.push(params.type);
    }
    return {};
  };
  let fallbackClicks = 0;
  cdpClient.evaluateFunction = async () => { fallbackClicks++; return { result: { value: { success: true, dispatched: true } } }; };
  try {
    const result = await agent.executeTool(17, 'click', { selector: '#send' });
    assert.deepEqual(events, ['mouseMoved']);
    assert.equal(fallbackClicks, 0);
    assert.equal(result.noDispatch, true);
    assert.equal(result.dispatched, false);
    assert.equal(result.pageFeedbackPending, true);
  } finally { restoreCdp(); }
});

function focusedTypingMocks({ insertText }) {
  const commands = [];
  cdpClient.attach = async () => {};
  cdpClient.evaluate = async () => ({ result: { value: { focused: true, editable: true, tag: 'TEXTAREA', name: 'msg',
    rect: { x: 0, y: 0, w: 1, h: 1 } } } });
  cdpClient.textEntrySignature = async () => 'signature';
  cdpClient.verifyTextEntry = async () => true;
  cdpClient.sendCommand = async (_tab, method, params) => {
    commands.push(method);
    if (method === 'Input.insertText') return insertText(params);
    return {};
  };
  return commands;
}

test('[mocked transport] type_text: a fence veto before Input.insertText is undispatched and records no text debt', async () => {
  const agent = newAgent();
  focusedTypingMocks({ insertText: () => { throw pageFeedbackVeto(); } });
  try {
    const result = await agent.executeTool(17, 'type_text', { text: 'hello' });
    assert.equal(result.success, false);
    assert.equal(result.dispatched, false);
    assert.equal(result.noDispatch, true);
    assert.equal(result.pageFeedbackPending, true);
    assert.equal(agent._uncertainTextMutations.get(17)?.size || 0, 0, 'no uncertain-text debt for text that never reached the page');
    // Positive progress: the same write is allowed after a fresh decision.
    focusedTypingMocks({ insertText: () => ({}) });
    const retried = await agent.executeTool(17, 'type_text', { text: 'hello' });
    assert.equal(retried.success, true);
    assert.equal(retried.verified, true);
  } finally { restoreCdp(); }
});

test('[mocked transport] type_text: a lost Input.insertText acknowledgement stays uncertain and blocks a blind repeat', async () => {
  const agent = newAgent();
  agent.strictGuards = true; // Strict checks: the guard's refusal itself is under test.
  focusedTypingMocks({ insertText: () => { throw new Error('Owned text response lost'); } });
  try {
    const result = await agent.executeTool(17, 'type_text', { text: 'hello' });
    assert.equal(result.success, false);
    assert.equal(result.dispatched, true);
    assert.notEqual(result.noDispatch, true);
    assert.equal(agent._uncertainTextMutations.get(17)?.size, 1, 'possibly delivered text is recorded as uncertain');
  } finally { restoreCdp(); }
});

test('[mocked transport] type_text clear: a fence veto before the select-all key leaves dispatch unstarted', async () => {
  const agent = newAgent();
  const commands = focusedTypingMocks({ insertText: () => ({}) });
  cdpClient.selectAllModifier = async () => 2;
  cdpClient.captureTextClearReceipt = async () => null;
  const sendCommand = cdpClient.sendCommand;
  cdpClient.sendCommand = async (tab, method, params, ...rest) => {
    if (method === 'Input.dispatchKeyEvent' && params.type === 'keyDown') throw pageFeedbackVeto();
    return sendCommand(tab, method, params, ...rest);
  };
  try {
    const result = await agent.executeTool(17, 'type_text', { text: 'hello', clear: true });
    assert.equal(commands.includes('Input.insertText'), false);
    assert.equal(result.noDispatch, true);
    assert.equal(result.dispatched, false);
    assert.equal(agent._uncertainTextMutations.get(17)?.size || 0, 0);
  } finally { restoreCdp(); }
});

test('[real DOM] cdpClient.typeText: an insertion refused before the protocol call is not marked dispatched', async () => {
  const fixture = await realChromium(`<!doctype html><textarea id="note"></textarea>`, { contentScripts: false });
  try {
    const sendCommand = cdpClient.sendCommand;
    cdpClient.sendCommand = function (tabId, method, params, ...rest) {
      // The transport refuses the insertion before chrome.debugger is called.
      if (method === 'Input.insertText') this.sessions.delete(tabId);
      return sendCommand.call(this, tabId, method, params, ...rest);
    };
    let dispatchMarks = 0;
    const result = await cdpClient.typeText(17, '#note', 'hello', false, null, { beforeDispatch: () => { dispatchMarks++; } });
    assert.equal(dispatchMarks, 0, 'no text reached the page, so the caller records no dispatch');
    assert.equal(result.success, false);
    assert.equal(result.noDispatch, true);
    assert.notEqual(result.mutationMayHaveOccurred, true);
    assert.equal(await fixture.page.locator('#note').inputValue(), '');
  } finally { await fixture.close(); }
});

test('[real DOM] cdpClient.typeText: normal typing marks dispatch once text is sent', async () => {
  const fixture = await realChromium(`<!doctype html><textarea id="note"></textarea>`, { contentScripts: false });
  try {
    let dispatchMarks = 0;
    const result = await cdpClient.typeText(17, '#note', 'hello', false, null, { beforeDispatch: () => { dispatchMarks++; } });
    assert.equal(result.success, true, JSON.stringify(result));
    assert.ok(dispatchMarks >= 1);
    assert.equal(await fixture.page.locator('#note').inputValue(), 'hello');
  } finally { await fixture.close(); }
});

test('[mocked transport] trusted field fallback: a vetoed insertion leaves no uncertain text debt', async () => {
  const agent = newAgent();
  const args = { ref_id: 'ref_7', text: 'New value', clear: true };
  agent._lastAxScopes.set(17, { documentToken: 'doc-field', pageUrl: 'https://cdp-delivery.test/start' });
  const commands = [];
  api.tabs.sendMessage = async (_tab, message) => {
    if (message.action === 'field_value_digest') return { success: true, documentToken: 'doc-field', refScopeUrl: 'https://cdp-delivery.test/start', valueLength: 3, valueSha256: 'old' };
    if (message.action === 'ax_prepare_field_for_trusted_type') return { success: true, contentEditable: false };
    if (message.action === 'ax_verify_field_value') return { success: true, verified: true };
    return { success: true };
  };
  cdpClient.attach = async () => {};
  cdpClient.sendCommand = async (_tab, method) => {
    commands.push(method);
    if (method === 'Input.insertText') throw pageFeedbackVeto();
    return {};
  };
  try {
    const result = await agent._maybeFallbackFieldWithCdpImpl(17, 'set_field', args,
      { success: false, verified: false, noDispatch: true, dispatched: false, _expectedValue: args.text, error: 'Trusted editor typing required' },
      {}, new AbortController().signal);
    assert.equal(result.success, false);
    assert.notEqual(result.dispatched, true, JSON.stringify(result));
    assert.equal(result.noDispatch, true);
    const finalized = await agent._finalizeTextMutationResult(17, 'set_field', args, result);
    assert.equal(finalized.noDispatch, true);
    assert.equal(agent._uncertainTextMutations.get(17)?.size || 0, 0, 'a vetoed insertion is not uncertain text');
  } finally { restoreCdp(); api.tabs.sendMessage = async () => ({}); }
});

test('[mocked transport] trusted field fallback: a lost insertion acknowledgement stays uncertain', async () => {
  const agent = newAgent();
  const args = { ref_id: 'ref_7', text: 'New value', clear: true };
  agent._lastAxScopes.set(17, { documentToken: 'doc-field', pageUrl: 'https://cdp-delivery.test/start' });
  api.tabs.sendMessage = async (_tab, message) => {
    if (message.action === 'field_value_digest') return { success: true, documentToken: 'doc-field', refScopeUrl: 'https://cdp-delivery.test/start', valueLength: 3, valueSha256: 'old' };
    if (message.action === 'ax_prepare_field_for_trusted_type') return { success: true, contentEditable: false };
    return { success: true };
  };
  cdpClient.attach = async () => {};
  cdpClient.sendCommand = async (_tab, method) => {
    if (method === 'Input.insertText') throw new Error('Owned text response lost');
    return {};
  };
  try {
    const result = await agent._maybeFallbackFieldWithCdpImpl(17, 'set_field', args,
      { success: false, verified: false, noDispatch: true, dispatched: false, _expectedValue: args.text, error: 'Trusted editor typing required' },
      {}, new AbortController().signal);
    assert.equal(result.dispatched, true);
    assert.notEqual(result.textUnchanged, true);
  } finally { restoreCdp(); api.tabs.sendMessage = async () => ({}); }
});
