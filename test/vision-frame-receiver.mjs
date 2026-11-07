// Vision mode: click_at on a control inside an embedded frame (QA case B2, a
// same-origin iframe form; another site's process-isolated frame takes the
// same path through its own target). The page-feedback wrapper prepares the
// operation in the top document at its point; Chrome delivers the trusted
// pointer input into the frame under that point, so each command is fenced
// by that frame's monitor. Before the fix that monitor had never seen the
// operation: the pointer move went through unfenced and the press was refused
// as a browser change (monitor_rejected / intervention_changed) on a static
// page, every time. A genuine change in the frame must still refuse it.
//
// [real DOM, Chromium only: trusted vision input is Chrome CDP] The real
// Agent, page-feedback run, cdpClient input routing and page monitor (in both
// documents) run unchanged; only the extension transport and the debugger
// session are bridged to Playwright, and the click's unrelated preflights
// are stubbed.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { chromium } from 'playwright';

const TAB = 41;
const ORIGIN = 'https://shipping.frame-receiver.test';
// Another site: with site isolation its frame is a separate (OOPIF) target.
const OTHER_SITE = 'https://wallet.frame-receiver-other.test';
const area = { get: async () => ({}), set: async () => {}, remove: async () => {} };
let page, session;
const documents = new Map(); // Playwright frame -> { frameId, documentId }
const hooks = { afterMove: null };
const commands = [];
const children = new Map(); // debugger sessionId -> Playwright CDP session of a process-isolated frame
const frameByTarget = new Map();
let attaches = 0;
const send = async (target, method, params) => {
  if (!target.sessionId && method === 'Target.attachToTarget') {
    const frame = frameByTarget.get(params.targetId);
    if (!frame) throw new Error(`No target ${params.targetId}`);
    const sessionId = `child-${++attaches}`;
    children.set(sessionId, await page.context().newCDPSession(frame));
    return { sessionId };
  }
  if (!target.sessionId && method === 'Target.detachFromTarget') {
    await children.get(params.sessionId)?.detach();
    children.delete(params.sessionId);
    return {};
  }
  return (target.sessionId ? children.get(target.sessionId) : session).send(method, params);
};
const frameFor = frameId => [...documents].find(([, value]) => value.frameId === frameId)?.[0];
const api = {
  storage: { local: area, session: area },
  runtime: { getURL: value => value, getManifest: () => ({ version: 'test' }) },
  tabs: {
    get: async () => ({ id: TAB, url: page.url() }),
    query: async () => [{ id: TAB, url: page.url() }],
    onCreated: { addListener() {}, removeListener() {} },
    sendMessage: async (_id, message, options = {}) => {
      const frame = frameFor(Number.isSafeInteger(options?.frameId) ? options.frameId : 0);
      if (!frame) throw new Error('Could not establish connection. Receiving end does not exist.');
      return frame.evaluate(value => window.qaMessage(value), message);
    },
  },
  webNavigation: { getAllFrames: async () => [...documents].map(([frame, value]) => ({
    frameId: value.frameId, parentFrameId: value.frameId ? 0 : -1, documentId: value.documentId, url: frame.url() })) },
  debugger: { sendCommand: (target, method, params, callback) => {
    if (method.startsWith('Input.')) commands.push({ method, type: params.type });
    send(target, method, params).then(async result => {
      if (method === 'Input.dispatchMouseEvent' && params.type === 'mouseMoved' && hooks.afterMove) {
        const intervene = hooks.afterMove; hooks.afterMove = null;
        await intervene();
      }
      return result;
    }).then(callback, error => {
      api.runtime.lastError = { message: error.message };
      try { callback(); } finally { delete api.runtime.lastError; }
    });
  } },
};
globalThis.chrome = api;
globalThis.browser = api;
const { Agent } = await import('../src/chrome/src/agent/agent.js');
const { cdpClient } = await import('../src/chrome/src/cdp/cdp-client.js');

// The QA page: a shipping form in a same-origin iframe (or another site's).
// `script` adds page script to the frame's document.
const topHtml = frameOrigin => `<!doctype html><style>body{margin:0;font:16px sans-serif}
iframe{position:absolute;left:40px;top:80px;width:600px;height:260px;border:1px solid #aaa}</style>
<h1>Shipping details</h1><iframe id="form" src="${frameOrigin}/inner" title="Shipping form"></iframe>`;
const innerHtml = script => `<!doctype html><style>body{margin:0;font:16px sans-serif}
#city{position:absolute;left:30px;top:40px;width:240px;height:32px}
#ticker{position:absolute;left:30px;top:200px}</style>
<form id="f"><label for="city">Delivery city</label><input id="city" name="city" autocomplete="off"></form>
<p id="status" role="status"></p><div id="ticker">0</div>
<script>window.qaPresses = [];
document.addEventListener('mousedown', event => { if (event.isTrusted) qaPresses.push(event.target.id || event.target.tagName); }, true);
${script || ''}</script>`;

async function fixture(browserInstance, script = '', { frameOrigin = ORIGIN } = {}) {
  const context = await browserInstance.newContext({ viewport: { width: 900, height: 600 } });
  await context.route('**/*', route => {
    const url = route.request().url();
    if (url === `${ORIGIN}/checkout`) return route.fulfill({ contentType: 'text/html', body: topHtml(frameOrigin) });
    if (url === `${frameOrigin}/inner`) return route.fulfill({ contentType: 'text/html', body: innerHtml(script) });
    return route.abort();
  });
  page = await context.newPage();
  documents.clear(); frameByTarget.clear();
  const agent = new Agent({ getActive: () => ({ model: 'vision-frame-model' }) });
  agent._runningTabs.add(TAB);
  await page.exposeBinding('qaBackground', ({ frame }, message) => {
    const known = documents.get(frame);
    if (!known) return { active: false };
    const sender = { tab: { id: TAB }, frameId: known.frameId, documentId: known.documentId, url: frame.url() };
    if (message.action === 'get_page_monitor_state') return agent.pageMonitorState(sender, message.documentToken);
    if (message.action === 'page_feedback') return agent.observePageFeedback(sender, message.feedback);
    return {};
  });
  await page.addInitScript(() => {
    window.qaListeners = [];
    window.chrome = window.browser = { runtime: {
      getURL: value => value,
      onMessage: { addListener: listener => qaListeners.push(listener), removeListener() {} },
      sendMessage: message => window.qaBackground(message),
    } };
    window.qaMessage = message => new Promise(resolve => {
      let answered = false;
      const respond = value => { answered = true; resolve(value); };
      for (const listener of qaListeners) { const value = listener(message, {}, respond); if (answered || value === true) return; }
      resolve(undefined);
    });
  });
  await page.addInitScript({ content: await readFile(new URL('../src/chrome/src/content/page-monitor.js', import.meta.url), 'utf8') });
  await page.goto(`${ORIGIN}/checkout`);
  const inner = page.frames().find(frame => frame !== page.mainFrame());
  await inner.waitForSelector('#city');
  documents.set(page.mainFrame(), { frameId: 0, documentId: 'document-top' });
  documents.set(inner, { frameId: 1, documentId: 'document-inner' });
  session = await context.newCDPSession(page);
  const { result: frameElement } = await session.send('Runtime.evaluate', { expression: "document.getElementById('form')" });
  frameByTarget.set((await session.send('DOM.describeNode', { objectId: frameElement.objectId })).node.frameId, inner);
  await agent._beginPageFeedbackRun(TAB, 'act');
  for (const frame of documents.keys()) await frame.waitForFunction(() => window.__wbPageMonitor?.active);
  await page.waitForTimeout(200);
  const run = agent._pageFeedbackRuns.get(TAB);
  assert.equal(run.frames.size, 2, 'both documents run a monitor for this run');
  // What the model observed: this run's documents, nothing pending.
  run.events.clear();
  run.modelState = { token: run.token, url: run.url, steeringRevision: 0, frames: new Map(run.frames) };
  // The click's own transport is under test; its unrelated preflights are not.
  agent._visionClickPreflight = async () => ({});
  agent._visionMutationBindingBlock = async () => null;
  agent._showAgentTarget = () => {};
  agent._redirectTargetBlankClick = async () => null;
  agent._visionPlatformLateTab = async () => {};
  // type_text right after the click may go to the field the click focused.
  agent._visionFocusFollowsClick = async () => true;
  agent._executeToolWithLifecycle = async (tabId, name, args, _onUpdate, context) => {
    const markDispatched = () => { context._contentActionDispatchState.started = true; };
    if (name === 'click') return agent._visionDispatchClick(tabId, args, { vision: context._vision, markDispatched });
    // type_text { clear: true } into the focused field, command for command as
    // the focused CDP path sends it (select all, Delete, insert).
    const key = async (params, commandsToRun = []) => {
      await cdpClient.sendCommand(tabId, 'Input.dispatchKeyEvent', { type: 'keyDown', ...params,
        ...(commandsToRun.length ? { commands: commandsToRun } : {}) });
      markDispatched();
      await cdpClient.sendCommand(tabId, 'Input.dispatchKeyEvent', { type: 'keyUp', ...params });
    };
    await key({ key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 }, ['selectAll']);
    await key({ key: 'Delete', code: 'Delete', windowsVirtualKeyCode: 46 });
    await cdpClient.sendCommand(tabId, 'Input.insertText', { text: args.text });
    return { success: true, dispatched: true, method: 'cdp-insert-focused' };
  };
  commands.length = 0; hooks.afterMove = null;
  // The field's centre in top-level viewport coordinates, as a screenshot shows it.
  const box = await (await inner.$('#city')).boundingBox();
  const point = { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2) };
  return { context, agent, inner, point };
}

// What vision-runtime.js sends for a click_at at a CSS point, and for a
// type_text that follows it.
const clickAt = (agent, point) => agent.executeTool(TAB, 'click', { x: point.x, y: point.y, coordinate_space: 'css' }, null,
  { _vision: { tool: 'click_at', internalName: 'click', cssPoint: point } });
const typeAfter = (agent, point, text) => agent.executeTool(TAB, 'type_text', { text, clear: true }, null,
  { _vision: { tool: 'type_text', internalName: 'type_text', focusFollowUp: point } });
const sent = type => commands.filter(command => command.method === 'Input.dispatchMouseEvent' && command.type === type).length;

test('Chrome: a vision click inside an embedded frame is fenced by that frame, like a top-document click', { timeout: 180000 }, async t => {
  const cdpAttach = cdpClient.attach;
  const guards = { arm: cdpClient.armFileInputClickGuard, consume: cdpClient.consumeFileInputClickGuard };
  cdpClient.attach = async tabId => { cdpClient.sessions.set(tabId, {}); return cdpClient.sessions.get(tabId); };
  cdpClient.armFileInputClickGuard = async () => {};
  cdpClient.consumeFileInputClickGuard = async () => ({ blocked: false });
  const browserInstance = await chromium.launch({ headless: true, args: ['--site-per-process'] });
  try {
    await t.test('on a static page the field is pressed once and takes focus', async () => {
      const { context, agent, inner, point } = await fixture(browserInstance);
      try {
        const result = await clickAt(agent, point);
        assert.equal(result.success, true, JSON.stringify(result));
        assert.equal(result.dispatched, true);
        assert.equal(result.method, 'cdp-vision-pointer');
        assert.equal(result.preparationVeto, undefined, JSON.stringify(result));
        assert.deepEqual(await inner.evaluate(() => qaPresses), ['city']);
        assert.equal(await inner.evaluate(() => document.activeElement?.id), 'city');
      } finally { await context.close(); }
    });

    await t.test('typing that follows the click replaces the value of the frame field it focused', async () => {
      const { context, agent, inner, point } = await fixture(browserInstance, "city.value = 'Springfield';");
      try {
        assert.equal((await clickAt(agent, point)).success, true);
        const typed = await typeAfter(agent, point, 'Ankara');
        assert.equal(typed.success, true, JSON.stringify(typed));
        assert.equal(await inner.locator('#city').inputValue(), 'Ankara');
      } finally { await context.close(); }
    });

    await t.test('automatic churn elsewhere in the frame does not void it', async () => {
      const { context, agent, inner, point } = await fixture(browserInstance,
        'let ticks = 0; setInterval(() => { ticker.textContent = String(++ticks); }, 15);');
      try {
        const result = await clickAt(agent, point);
        assert.equal(result.success, true, JSON.stringify(result));
        assert.deepEqual(await inner.evaluate(() => qaPresses), ['city']);
      } finally { await context.close(); }
    });

    // The page's own change after the pointer arrived, not an effect of the
    // agent's input (which the monitor attributes to the agent).
    for (const [label, change] of [
      ['moves the field away from the point', () => { document.getElementById('city').style.top = '120px'; }],
      ['replaces the field under the point', () => { const city = document.getElementById('city'); city.replaceWith(city.cloneNode()); }],
    ]) await t.test(`the frame's page script that ${label} refuses the press`, async () => {
      const { context, agent, inner, point } = await fixture(browserInstance);
      try {
        hooks.afterMove = async () => { await inner.evaluate(change); await page.waitForTimeout(50); };
        const result = await clickAt(agent, point);
        assert.equal(result.success, false, JSON.stringify(result));
        assert.equal(result.dispatched, false, JSON.stringify(result));
        assert.equal(sent('mousePressed'), 0, JSON.stringify(commands));
        assert.deepEqual(await inner.evaluate(() => qaPresses), []);
      } finally { await context.close(); }
    });

    await t.test("a person's click in the frame after the pointer arrived refuses the press", async () => {
      const { context, agent, inner, point } = await fixture(browserInstance);
      try {
        hooks.afterMove = async () => {
          await inner.click('#ticker', { force: true });
          await page.waitForTimeout(100);
        };
        const result = await clickAt(agent, point);
        assert.equal(result.success, false, JSON.stringify(result));
        assert.equal(result.dispatched, false, JSON.stringify(result));
        assert.equal(sent('mousePressed'), 0, JSON.stringify(commands));
        assert.deepEqual(await inner.evaluate(() => qaPresses), ['ticker'], 'only the person pressed');
      } finally { await context.close(); }
    });

    // Another site's frame is process-isolated: cdpClient enters its own
    // target to mark the receiver, and the same preparation applies there.
    await t.test("another site's process-isolated frame: the field is pressed, and a replaced field refuses it", async () => {
      for (const replace of [false, true]) {
        const { context, agent, inner, point } = await fixture(browserInstance, '', { frameOrigin: OTHER_SITE });
        try {
          if (replace) hooks.afterMove = async () => {
            await inner.evaluate(() => { const city = document.getElementById('city'); city.replaceWith(city.cloneNode()); });
            await page.waitForTimeout(50);
          };
          const entered = attaches;
          const result = await clickAt(agent, point);
          assert.equal(result.success, !replace, JSON.stringify(result));
          assert.deepEqual(await inner.evaluate(() => qaPresses), replace ? [] : ['city']);
          assert.ok(attaches > entered, "the input was routed through the frame's own target");
          assert.equal(children.size, 0, 'and that target was left again');
        } finally { await context.close(); }
      }
    });
  } finally {
    cdpClient.attach = cdpAttach;
    cdpClient.armFileInputClickGuard = guards.arm;
    cdpClient.consumeFileInputClickGuard = guards.consume;
    cdpClient.sessions.delete(TAB);
    await browserInstance.close();
  }
});
