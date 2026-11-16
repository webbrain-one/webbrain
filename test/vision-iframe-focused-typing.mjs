// type_text without a selector types into the element that has keyboard
// focus. Focus inside an embedded frame reads in the top document as the
// IFRAME element, while Chrome delivers Input.insertText and key events to
// the field focused in the frame's own document. Before the fix, Chrome's
// unbound focused path checked, signed, cleared and read back the top
// document only, so after a click into a framed field (QA case B2, vision
// mode) every type_text was refused: "No editable element is currently
// focused". cdpClient now follows focus into same-process and
// process-isolated frames (an isolated world of the frame, through the
// frame's own target when it is process-isolated) for the focus check, the
// text signature, the clear receipt and the readback.
//
// [real DOM, Chromium only: this path is Chrome CDP] The real Agent and
// cdpClient run unchanged against Playwright's Chromium; only the extension
// transport and the debugger session are bridged (Target.attachToTarget
// becomes a Playwright session of that frame). No content script runs, so
// this is the path a call takes when the typing-target preflight could not
// bind the framed field.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chromium } from 'playwright';

const TAB = 52;
const TOP = 'https://shop.example.test';
// The same site on another origin: same renderer process, cross-origin.
const SAME_SITE = 'https://forms.example.test';
// Another site: with site isolation its frame is a separate (OOPIF) target.
const OTHER_SITE = 'https://pay.example-other.test';
const area = { get: async () => ({}), set: async () => {}, remove: async () => {} };
let page, session;
const methods = [];
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
const api = {
  storage: { local: area, session: area },
  runtime: { getURL: value => value, getManifest: () => ({ version: 'test' }) },
  tabs: {
    get: async () => ({ id: TAB, url: page.url() }),
    query: async () => [{ id: TAB, url: page.url() }],
    onCreated: { addListener() {}, removeListener() {} },
    // No content script answers: the unbound CDP path is under test.
    sendMessage: async () => undefined,
  },
  webNavigation: { getAllFrames: async () => [{ frameId: 0, parentFrameId: -1, url: page.url() }] },
  debugger: { sendCommand: (target, method, params, callback) => {
    methods.push(method);
    send(target, method, params).then(callback, error => {
      api.runtime.lastError = { message: error.message };
      try { callback(); } finally { delete api.runtime.lastError; }
    });
  } },
};
globalThis.chrome = api;
globalThis.browser = api;
const { Agent } = await import('../src/chrome/src/agent/agent.js');
const { cdpClient } = await import('../src/chrome/src/cdp/cdp-client.js');

const topHtml = frameOrigin => `<!doctype html><style>body{margin:0;font:16px sans-serif}
iframe{position:absolute;left:40px;top:80px;width:600px;height:300px;border:1px solid #aaa}
#note{position:absolute;left:40px;top:400px;width:240px;height:32px}</style>
<h1>Checkout</h1><input id="note" aria-label="Order note"><iframe id="form" src="${frameOrigin}/inner" title="Shipping form"></iframe>`;
const innerHtml = `<!doctype html><style>body{margin:0;font:16px sans-serif}
input,select,[contenteditable]{position:absolute;left:30px;width:240px;height:32px}
#city{top:20px}#pin{top:70px}#country{top:120px}#notes{top:170px;border:1px solid #888}</style>
<input id="city" name="city" autocomplete="off" value="Springfield">
<input id="pin" name="pin" type="password" autocomplete="current-password">
<select id="country"><option>Turkey</option><option>Greece</option></select>
<div id="notes" contenteditable="true">Leave at the door</div>`;
// An embedded rich-text editor: the frame's whole body is the editable area.
const editorHtml = '<!doctype html><body contenteditable="true" style="margin:0;height:280px;font:16px sans-serif"><p>Dear team,</p></body>';

async function fixture(browserInstance, frameOrigin = TOP, frameHtml = innerHtml, ready = '#city') {
  const context = await browserInstance.newContext({ viewport: { width: 900, height: 600 } });
  await context.route('**/*', route => {
    const url = route.request().url();
    if (url === `${TOP}/checkout`) return route.fulfill({ contentType: 'text/html', body: topHtml(frameOrigin) });
    if (url === `${frameOrigin}/inner`) return route.fulfill({ contentType: 'text/html', body: frameHtml });
    return route.abort();
  });
  page = await context.newPage();
  await page.goto(`${TOP}/checkout`);
  const inner = page.frames().find(frame => frame !== page.mainFrame());
  await inner.waitForSelector(ready);
  session = await context.newCDPSession(page);
  frameByTarget.clear();
  const { result: frameElement } = await session.send('Runtime.evaluate', { expression: "document.getElementById('form')" });
  frameByTarget.set((await session.send('DOM.describeNode', { objectId: frameElement.objectId })).node.frameId, inner);
  const agent = new Agent({ getActive: () => ({ model: 'frame-typing-model' }) });
  agent._showAgentTarget = () => {};
  methods.length = 0;
  return { context, agent, inner };
}

// A trusted click on the element's centre, as click_at sends it.
async function clickInto(frame, selector) {
  const box = await (await frame.$(selector)).boundingBox();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  methods.length = 0;
}
const typeText = (agent, args) => agent.executeTool(TAB, 'type_text', args, null, {});
const inputSent = () => methods.filter(method => method.startsWith('Input.'));

test('Chrome: type_text without a selector follows keyboard focus into an embedded frame', { timeout: 180000 }, async t => {
  const cdpAttach = cdpClient.attach;
  cdpClient.attach = async tabId => { cdpClient.sessions.set(tabId, {}); return cdpClient.sessions.get(tabId); };
  const browserInstance = await chromium.launch({ headless: true, args: ['--site-per-process'] });
  try {
    for (const [label, origin] of [['a same-origin frame', TOP], ['a cross-origin frame of the same site', SAME_SITE]]) {
      await t.test(`${label}: clear:true replaces the field's value and reads it back`, async () => {
        const { context, agent, inner } = await fixture(browserInstance, origin);
        try {
          await clickInto(inner, '#city');
          assert.equal(await page.evaluate(() => document.activeElement.tagName), 'IFRAME');
          const result = await typeText(agent, { text: 'Ankara', clear: true });
          assert.equal(result.success, true, JSON.stringify(result));
          assert.equal(result.verified, true, JSON.stringify(result));
          assert.equal(result.method, 'cdp-insert-focused');
          assert.deepEqual(result.focusedField, { tag: 'INPUT', type: 'text', name: 'city', contentEditable: false });
          assert.equal(await inner.locator('#city').inputValue(), 'Ankara');
          assert.equal(await page.locator('#note').inputValue(), '', 'the top document was not typed into');
        } finally { await context.close(); }
      });

      await t.test(`${label}: text appended to the field is read back exactly`, async () => {
        const { context, agent, inner } = await fixture(browserInstance, origin);
        try {
          await clickInto(inner, '#city');
          await inner.evaluate(() => { const city = document.getElementById('city'); city.setSelectionRange(city.value.length, city.value.length); });
          const result = await typeText(agent, { text: ' Heights' });
          assert.equal(result.success, true, JSON.stringify(result));
          assert.equal(result.verified, true, JSON.stringify(result));
          assert.equal(await inner.locator('#city').inputValue(), 'Springfield Heights');
        } finally { await context.close(); }
      });
    }

    await t.test("a contenteditable in a frame is cleared under the frame's own clear receipt", async () => {
      const { context, agent, inner } = await fixture(browserInstance);
      try {
        await clickInto(inner, '#notes');
        const result = await typeText(agent, { text: 'Ring the bell', clear: true });
        assert.equal(result.success, true, JSON.stringify(result));
        assert.equal(result.focusedField?.contentEditable, true, JSON.stringify(result));
        assert.equal(await inner.locator('#notes').textContent(), 'Ring the bell');
      } finally { await context.close(); }
    });

    await t.test("an editor frame's editable body takes the text", async () => {
      const { context, agent, inner } = await fixture(browserInstance, TOP, editorHtml, 'p');
      try {
        await clickInto(inner, 'p');
        await inner.evaluate(() => { const range = document.createRange(); range.selectNodeContents(document.querySelector('p'));
          range.collapse(false); getSelection().removeAllRanges(); getSelection().addRange(range); });
        const result = await typeText(agent, { text: ' Thanks.' });
        assert.equal(result.success, true, JSON.stringify(result));
        assert.equal(result.focusedField?.tag, 'BODY', JSON.stringify(result));
        assert.equal(result.focusedField?.contentEditable, true, JSON.stringify(result));
        assert.equal(await inner.evaluate(() => document.body.textContent), 'Dear team, Thanks.');
      } finally { await context.close(); }
    });

    await t.test("another site's process-isolated frame: typed and read back through that frame's own target", async () => {
      const { context, agent, inner } = await fixture(browserInstance, OTHER_SITE);
      try {
        await clickInto(inner, '#city');
        const entered = attaches;
        const result = await typeText(agent, { text: 'Ankara', clear: true });
        assert.equal(result.success, true, JSON.stringify(result));
        assert.equal(result.verified, true, JSON.stringify(result));
        assert.equal(await inner.locator('#city').inputValue(), 'Ankara');
        assert.ok(attaches > entered, "the frame's document was read through its own target");
        assert.equal(children.size, 0, 'and every session attached for it was detached again');
      } finally { await context.close(); }
    });

    // This path has no content script in the frame: credential-not-provided
    // could not see a framed password field, and a dropdown is set by the
    // content action, which would reach the top document.
    for (const [label, selector, focus] of [
      ['a password field', '#pin', frame => clickInto(frame, '#pin')],
      ['a dropdown', '#country', async frame => { await frame.locator('#country').focus(); methods.length = 0; }],
    ]) await t.test(`${label} in a frame is not typed into from this path`, async () => {
      const { context, agent, inner } = await fixture(browserInstance);
      try {
        await focus(inner);
        assert.equal(await inner.evaluate(sel => document.activeElement === document.querySelector(sel), selector), true);
        const before = await inner.evaluate(sel => document.querySelector(sel).value, selector);
        const result = await typeText(agent, { text: 'Greece' });
        assert.equal(result.success, false, JSON.stringify(result));
        assert.equal(result.dispatched, false, JSON.stringify(result));
        assert.match(result.error, /inside an embedded frame/);
        assert.equal(result.retryable, false, 'the same call would be refused again');
        assert.equal(result.focusedElement?.value, '', 'no field value is returned');
        assert.deepEqual(inputSent(), [], 'no key or text was sent');
        assert.equal(await inner.evaluate(sel => document.querySelector(sel).value, selector), before);
      } finally { await context.close(); }
    });

    await t.test('focus on the frame document itself is still no editable element', async () => {
      const { context, agent, inner } = await fixture(browserInstance);
      try {
        const box = await (await inner.$('body')).boundingBox();
        await page.mouse.click(box.x + 500, box.y + 280);
        methods.length = 0;
        assert.equal(await page.evaluate(() => document.activeElement.tagName), 'IFRAME');
        const result = await typeText(agent, { text: 'Ankara' });
        assert.equal(result.success, false, JSON.stringify(result));
        assert.match(result.error, /No editable element is currently focused/);
        assert.equal(result.focusedElement?.inFrame, true, JSON.stringify(result));
        assert.deepEqual(inputSent(), []);
      } finally { await context.close(); }
    });

    await t.test('focus in the top document is read there, without entering a frame', async () => {
      const { context, agent } = await fixture(browserInstance);
      try {
        await clickInto(page.mainFrame(), '#note');
        const result = await typeText(agent, { text: 'Fragile', clear: true });
        assert.equal(result.success, true, JSON.stringify(result));
        assert.equal(result.verified, true, JSON.stringify(result));
        assert.equal(await page.locator('#note').inputValue(), 'Fragile');
        assert.equal(methods.includes('Page.createIsolatedWorld'), false, JSON.stringify(methods));
      } finally { await context.close(); }
    });
  } finally {
    cdpClient.attach = cdpAttach;
    cdpClient.sessions.delete(TAB);
    await browserInstance.close();
  }
});
