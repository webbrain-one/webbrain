// Content half of the page-feedback event contract: only genuine user input
// and top-level viewport changes are interventions. Automatic observations
// advance the revision (strict fences) while a model certificate's private
// footprint decides whether its action changed. Real page-monitor.js in
// Chromium and Firefox; extension messaging is mocked.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { chromium, firefox } from 'playwright';
import { createNativeActionMarker } from '../firefox-companion/session.mjs';

const RUN = 'contract-run';
const html = `<!doctype html><style>
body { margin: 20px; font: 16px sans-serif; } button, input { margin: 6px; }
.row span { display: inline-block; width: 6px; }
</style><main><h1>Messages</h1>
<section id="composer" role="region"><h2 id="recipient">Alice</h2>
<form id="form" action="/send" method="post"><label for="field">Message</label>
<input id="field" autocomplete="off"><input id="to" type="hidden" name="to" value="alice">
<button id="send" type="submit">Send</button><ul id="suggest"></ul></form></section>
<button id="toggle" type="button" role="switch" aria-checked="false">Notifications</button>
<input id="hidden-switch" type="checkbox" hidden>
<p id="status">Ready</p></main>
<aside id="side"><span id="counter">0</span><input id="search" aria-label="Search"><div id="rows"></div></aside>
<button id="human" type="button">Human control</button><div style="height:1200px"></div>
<script>
window.submissions = 0;
document.getElementById('form').addEventListener('submit', event => { event.preventDefault(); submissions++; });
document.getElementById('toggle').addEventListener('click', () => {
  // A switch backed by a hidden native control re-dispatches a synthetic change.
  const box = document.getElementById('hidden-switch');
  box.checked = !box.checked;
  document.getElementById('toggle').setAttribute('aria-checked', String(box.checked));
  box.dispatchEvent(new Event('change', { bubbles: true }));
});
document.getElementById('rows').innerHTML = Array.from({ length: 45 }, (_, i) =>
  '<div class="row">' + '<span>x</span>'.repeat(8) + '</div>').join('');
</script>`;

async function fixture(browser, build, { feedbackDelay = 0 } = {}) {
  const context = await browser.newContext({ viewport: { width: 1000, height: 700 } });
  await context.route('https://contract.test/**', route => route.fulfill({ contentType: 'text/html', body: html }));
  await context.addInitScript(({ RUN, feedbackDelay }) => {
    window.feedback = []; window.delivered = []; window.messageListeners = [];
    const runtime = {
      onMessage: { addListener: fn => messageListeners.push(fn), removeListener: fn => { messageListeners = messageListeners.filter(item => item !== fn); } },
      async sendMessage(msg) {
        if (msg.action === 'get_page_monitor_state') return { active: true, runToken: RUN, documentToken: msg.documentToken };
        if (msg.action === 'page_feedback') {
          feedback.push(msg.feedback);
          if (feedbackDelay) await new Promise(resolve => setTimeout(resolve, feedbackDelay));
          delivered.push(msg.feedback);
          return { accepted: true };
        }
        return {};
      },
    };
    window.chrome = { runtime }; window.browser = window.chrome;
    window.__wb_ax_lookup = ref => document.getElementById(ref.replace(/^ref_/, ''));
    window.deliver = (action, params = {}) => new Promise(resolve => {
      let answered = false;
      const respond = value => { answered = true; resolve(value); };
      for (const listener of messageListeners) {
        const asynchronous = listener({ target: 'content', action, params: { runToken: RUN, ...params } }, {}, respond);
        if (answered || asynchronous === true) return;
      }
      resolve(undefined);
    });
  }, { RUN, feedbackDelay });
  await context.addInitScript({ content: fs.readFileSync(new URL(`../src/${build}/src/content/page-monitor.js`, import.meta.url), 'utf8') });
  const page = await context.newPage();
  await page.goto('https://contract.test/start');
  await page.waitForFunction(() => window.__wbPageMonitor?.active);
  await page.evaluate(() => document.getElementById('field').focus());
  await page.waitForTimeout(250);
  await page.evaluate(() => { feedback = []; delivered = []; });
  return { context, page };
}

const message = (page, action, params = {}) => page.evaluate(({ action, params }) => Promise.race([deliver(action, params),
  new Promise(resolve => setTimeout(() => resolve({ ready: false, code: 'monitor_response_missing' }), 3000))]), { action, params });
const settle = page => page.waitForTimeout(260); // Debounced DOM feedback (150 ms) has been delivered.
const sources = async page => (await page.evaluate(() => feedback)).map(event => `${event.kind}/${event.source}`);

async function capture(page) {
  const snapshot = await message(page, 'page_monitor_capture_model');
  assert.equal(snapshot.ready, true, JSON.stringify(snapshot));
  return snapshot;
}

for (const [build, engine] of [['chrome', chromium], ['firefox', firefox]]) {
  test(`${build}: automatic page activity during certified multi-key input is judged by the footprint`, { timeout: 120000 }, async t => {
    const browser = await engine.launch({ headless: true });
    try {
      // r13: a typeahead renders after key 1 while the operation is dispatched.
      const typeKeys = async (page, between) => {
        const snapshot = await capture(page);
        const prepared = await message(page, 'page_monitor_prepare', { operationId: 'keys', tool: 'press_keys',
          allowPassiveRebase: true, expectedModelSnapshot: snapshot.snapshotToken });
        assert.equal(prepared.modelBindingValid, true);
        const typed = [];
        for (const key of ['I', 's', 't']) {
          const down = await message(page, 'page_monitor_dispatch', { operationId: 'keys', kind: 'input',
            eventTypes: ['keydown', 'keypress', 'beforeinput', 'input'] });
          if (!down.ready) return { typed: typed.join(''), veto: down.preparationVeto?.predicate || 'vetoed' };
          await page.keyboard.down(key);
          await message(page, 'page_monitor_dispatch', { operationId: 'keys', kind: 'input', release: true, eventTypes: ['keyup'] });
          await page.keyboard.up(key);
          typed.push(key);
          if (typed.length === 1) await between(page);
        }
        await message(page, 'page_monitor_finish', { operationId: 'keys' });
        return { typed: typed.join(''), veto: '' };
      };

      await t.test('an unrelated typeahead render does not veto the next key and stays observable', async () => {
        const { context, page } = await fixture(browser, build);
        try {
          const result = await typeKeys(page, page => page.evaluate(() => {
            document.getElementById('suggest').innerHTML = '<li>Istanbul</li><li>Izmir</li>';
          }));
          assert.deepEqual(result, { typed: 'Ist', veto: '' });
          assert.equal(await page.inputValue('#field'), 'Ist');
          await settle(page);
          assert.ok((await sources(page)).includes('dom/unknown'), 'The uncertain render is still reported to the agent');
        } finally { await context.close(); }
      });

      for (const [name, between] of [
        ['a changed recipient', page => page.evaluate(() => { document.getElementById('recipient').textContent = 'Bob'; })],
        ['a changed hidden destination value', page => page.evaluate(() => { document.getElementById('to').value = 'bob'; })],
        ['a genuine user keypress in the same field', page => page.keyboard.press('X')],
        ['a genuine user click on another control', page => page.click('#human')],
      ]) await t.test(`${name} still vetoes the next key`, async () => {
        const { context, page } = await fixture(browser, build);
        try {
          const result = await typeKeys(page, between);
          assert.equal(result.typed, 'I');
          assert.ok(result.veto);
        } finally { await context.close(); }
      });

      await t.test('per-key native validation survives a counter render after every key (r14)', async () => {
        const { context, page } = await fixture(browser, build);
        try {
          const snapshot = await capture(page);
          const prepared = await message(page, 'page_monitor_prepare', { operationId: 'native', tool: 'type_ax', ref_id: 'ref_field',
            allowPassiveRebase: true, expectedModelSnapshot: snapshot.snapshotToken });
          assert.equal(prepared.modelBindingValid, true);
          const fence = await message(page, 'page_monitor_dispatch', { operationId: 'native', tool: 'type_ax', ref_id: 'ref_field', kind: 'input', fenceOnly: true });
          let guard = fence.guard, sequence = 0, typed = '';
          for (const key of 'Hey') {
            const validation = await message(page, 'page_monitor_validate', { ...guard, kind: 'input', rebindFocus: false });
            if (!validation.ready) break;
            guard = { ...guard, revision: validation.revision };
            const marker = createNativeActionMarker(guard, 'input', ++sequence);
            await page.evaluate(marker => document.getElementById('field').setAttribute('data-webbrain-native-action', marker), marker);
            await page.keyboard.press(key);
            typed += key;
            // The page renders its character counter in a later task.
            await page.evaluate(() => { document.getElementById('counter').textContent = String(document.getElementById('field').value.length); });
          }
          await message(page, 'page_monitor_finish', { operationId: 'native' });
          assert.equal(typed, 'Hey');
          assert.equal(await page.inputValue('#field'), 'Hey');
          assert.equal((await page.evaluate(() => feedback)).some(event => event.source === 'user'), false,
            'Signed native keys remain attributed to the agent');
        } finally { await context.close(); }
      });

      await t.test('coordinate operations keep the strict revision fence', async () => {
        const { context, page } = await fixture(browser, build);
        try {
          const box = await page.locator('#human').boundingBox();
          await message(page, 'page_monitor_prepare', { operationId: 'coordinates', tool: 'click', allowPassiveRebase: true,
            x: box.x + box.width / 2, y: box.y + box.height / 2 });
          await page.evaluate(() => { document.getElementById('counter').textContent = '7'; });
          const result = await message(page, 'page_monitor_dispatch', { operationId: 'coordinates', kind: 'click' });
          assert.equal(result.ready, false);
          assert.equal(result.pageFeedbackPending, true);
        } finally { await context.close(); }
      });
    } finally { await browser.close(); }
  });

  test(`${build}: automatic observations do not invalidate a model snapshot by themselves`, { timeout: 120000 }, async t => {
    const browser = await engine.launch({ headless: true });
    try {
      const automatic = [
        ['page focus elsewhere', page => page.evaluate(() => document.getElementById('search').focus()), 'activity/page'],
        ['an untrusted page input event', page => page.evaluate(() => {
          document.getElementById('search').dispatchEvent(new Event('input', { bubbles: true }));
        }), 'input/page'],
        ['a page-script scroll', page => page.evaluate(() => window.scrollTo(0, 30)), 'scroll/unknown'],
        ['a measurement-capped page render', page => page.evaluate(() => {
          for (const row of document.querySelectorAll('.row')) row.classList.add('selected-theme');
        }), 'dom/unknown'],
        ['unknown DOM attribution during another operation', page => page.evaluate(() => {
          __wbPageMonitor.dispatch({ operationId: 'other-operation', kind: 'dom', runToken: 'contract-run' });
          document.getElementById('counter').textContent = '9';
        }), 'dom/unknown'],
      ];
      for (const [name, mutate, observed] of automatic) await t.test(`${name} leaves the certified decision to its footprint`, async () => {
        const { context, page } = await fixture(browser, build);
        try {
          const snapshot = await capture(page);
          await mutate(page);
          await settle(page);
          assert.ok((await sources(page)).includes(observed), `${observed} remains observable: ${await sources(page)}`);
          const validated = await message(page, 'page_monitor_validate_model', { snapshotToken: snapshot.snapshotToken, tool: 'click_ax', ref_id: 'ref_send' });
          assert.equal(validated.ready, true, JSON.stringify(validated));
          const prepared = await message(page, 'page_monitor_prepare', { operationId: 'model', tool: 'click_ax', ref_id: 'ref_send',
            allowPassiveRebase: true, expectedModelSnapshot: snapshot.snapshotToken });
          assert.equal(prepared.modelBindingValid, true);
          const dispatched = await message(page, 'page_monitor_dispatch', { operationId: 'model', kind: 'click' });
          assert.equal(dispatched.ready, true);
          await page.evaluate(() => __wbPageMonitor.withPreparedDispatch('model', () => document.getElementById('send').click()));
          assert.equal(await page.evaluate(() => submissions), 1);
        } finally { await context.close(); }
      });

      for (const [name, mutate] of [
        ['a genuine user click elsewhere', page => page.click('#human')],
        ['a top-level viewport resize', page => page.setViewportSize({ width: 990, height: 690 })],
        ['a changed recipient', page => page.evaluate(() => { document.getElementById('recipient').textContent = 'Bob'; })],
      ]) await t.test(`${name} still invalidates the snapshot`, async () => {
        const { context, page } = await fixture(browser, build);
        try {
          const snapshot = await capture(page);
          await mutate(page);
          await settle(page);
          const validated = await message(page, 'page_monitor_validate_model', { snapshotToken: snapshot.snapshotToken, tool: 'click_ax', ref_id: 'ref_send' });
          assert.equal(validated.ready, false);
          const prepared = await message(page, 'page_monitor_prepare', { operationId: 'model', tool: 'click_ax', ref_id: 'ref_send',
            allowPassiveRebase: true, expectedModelSnapshot: snapshot.snapshotToken });
          assert.equal(prepared.modelBindingValid, false);
          assert.equal(await page.evaluate(() => submissions), 0);
        } finally { await context.close(); }
      });

      await t.test('page focus still invalidates a focus-bound decision', async () => {
        const { context, page } = await fixture(browser, build);
        try {
          const snapshot = await capture(page);
          await page.evaluate(() => document.getElementById('search').focus());
          await settle(page);
          const validated = await message(page, 'page_monitor_validate_model', { snapshotToken: snapshot.snapshotToken, tool: 'press_keys' });
          assert.equal(validated.ready, false);
          assert.equal(validated.reason, 'focus_changed');
        } finally { await context.close(); }
      });

      await t.test('a page focus after the agent click is reported without becoming an intervention (X3)', async () => {
        const { context, page } = await fixture(browser, build);
        try {
          const snapshot = await capture(page);
          const box = await page.locator('#toggle').boundingBox();
          const x = box.x + box.width / 2, y = box.y + box.height / 2;
          await message(page, 'page_monitor_prepare', { operationId: 'click', tool: 'click', selector: '#toggle' });
          await message(page, 'page_monitor_dispatch', { operationId: 'click', kind: 'click', selector: '#toggle', x, y,
            eventTypes: ['pointerover', 'pointerenter', 'mouseover', 'mouseenter', 'pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click', 'input', 'change'] });
          await page.evaluate(() => document.getElementById('toggle').addEventListener('click',
            () => setTimeout(() => document.getElementById('search').focus(), 30), { once: true }));
          await page.mouse.click(x, y);
          await message(page, 'page_monitor_finish', { operationId: 'click' });
          await page.waitForFunction(() => feedback.some(event => event.kind === 'activity' && event.source === 'page'));
          await settle(page);
          const validated = await message(page, 'page_monitor_validate_model', { snapshotToken: snapshot.snapshotToken, tool: 'click_ax', ref_id: 'ref_send' });
          assert.equal(validated.ready, true, JSON.stringify(validated));
          assert.equal((await page.evaluate(() => feedback)).some(event => event.source === 'user'), false);
        } finally { await context.close(); }
      });
    } finally { await browser.close(); }
  });

  test(`${build}: untrusted events inside the agent's own turn belong to that turn (X7)`, { timeout: 60000 }, async t => {
    const browser = await engine.launch({ headless: true });
    try {
      await t.test('a page handler re-dispatching change for a hidden control is not page input', async () => {
        const { context, page } = await fixture(browser, build);
        try {
          const box = await page.locator('#toggle').boundingBox();
          const x = box.x + box.width / 2, y = box.y + box.height / 2;
          await message(page, 'page_monitor_prepare', { operationId: 'toggle', tool: 'click', selector: '#toggle' });
          await message(page, 'page_monitor_dispatch', { operationId: 'toggle', kind: 'click', selector: '#toggle', x, y,
            eventTypes: ['pointerover', 'pointerenter', 'mouseover', 'mouseenter', 'pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click', 'input', 'change'] });
          await page.mouse.click(x, y);
          await message(page, 'page_monitor_finish', { operationId: 'toggle' });
          await settle(page);
          assert.equal(await page.evaluate(() => document.getElementById('hidden-switch').checked), true);
          const events = await sources(page);
          assert.equal(events.includes('input/page'), false, `The synthetic change is part of the agent click: ${events}`);
          assert.equal(events.some(event => event.endsWith('/user')), false);
        } finally { await context.close(); }
      });

      await t.test('the same synthetic event outside the agent turn remains observable page input', async () => {
        const { context, page } = await fixture(browser, build);
        try {
          await page.evaluate(() => document.getElementById('hidden-switch').dispatchEvent(new Event('change', { bubbles: true })));
          await settle(page);
          assert.ok((await sources(page)).includes('input/page'));
        } finally { await context.close(); }
      });
    } finally { await browser.close(); }
  });

  test(`${build}: a vision point's trusted click and hover through the companion belong to the agent`, { timeout: 60000 }, async t => {
    const browser = await engine.launch({ headless: true });
    // As the run prepares a vision point (page-feedback.js) and the companion
    // validates and marks before trusted input (firefox-companion/session.mjs),
    // with the element content.js _visionBidiPrepare marks: the one
    // document.elementFromPoint gives for the point.
    const trusted = async (page, { x, y, kind = 'click', mark = null }) => {
      const prepared = await message(page, 'page_monitor_prepare', { operationId: 'vision', tool: 'click', allowPassiveRebase: true, visionPoint: true, x, y });
      assert.equal(prepared.ready, true);
      const fence = await message(page, 'page_monitor_dispatch', { operationId: 'vision', kind: 'click', frameId: 0, navigationCandidate: kind === 'click', fenceOnly: true });
      assert.equal(fence.ready, true, JSON.stringify(fence));
      const validation = await message(page, 'page_monitor_validate', { ...fence.guard, kind: 'click', rebindFocus: false });
      assert.equal(validation.ready, true, JSON.stringify(validation));
      const marker = createNativeActionMarker({ ...fence.guard, revision: validation.revision }, 'click', 1);
      await page.evaluate(({ x, y, marker, mark }) => {
        const el = mark ? eval(mark) : document.elementFromPoint(x, y);
        el.setAttribute('data-webbrain-native-action', marker);
      }, { x, y, marker, mark });
      if (kind === 'click') await page.mouse.click(x, y);
      else await page.mouse.move(x, y, { steps: 2 });
      await message(page, 'page_monitor_finish', { operationId: 'vision' });
      await settle(page);
      return sources(page);
    };
    const shadowHost = page => page.evaluate(() => {
      const host = document.createElement('div');
      host.id = 'shadow-host';
      host.style.cssText = 'position:absolute;left:600px;top:300px;width:200px;height:60px';
      document.body.append(host);
      const root = host.attachShadow({ mode: 'open' });
      root.innerHTML = '<button id="inner" style="width:200px;height:60px">Inner</button>';
      window.innerClicks = 0;
      root.getElementById('inner').addEventListener('click', () => { window.innerClicks++; });
    }).then(() => settle(page)).then(() => page.evaluate(() => { feedback = []; delivered = []; }));
    try {
      await t.test('a trusted click on the marked element is no user input', async () => {
        const { context, page } = await fixture(browser, build);
        try {
          const box = await page.locator('#toggle').boundingBox();
          const events = await trusted(page, { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2) });
          assert.equal(await page.evaluate(() => document.getElementById('hidden-switch').checked), true, 'the click landed');
          assert.equal(events.some(event => event.endsWith('/user')), false, `the trusted click is the agent's: ${events}`);
        } finally { await context.close(); }
      });
      await t.test('a trusted hover on the marked element is no user input', async () => {
        const { context, page } = await fixture(browser, build);
        try {
          const box = await page.locator('#send').boundingBox();
          const events = await trusted(page, { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2), kind: 'hover' });
          assert.equal(events.some(event => event.endsWith('/user')), false, `the trusted hover is the agent's: ${events}`);
        } finally { await context.close(); }
      });
      // Why content.js leaves a point inside an open shadow root synthetic: the
      // monitor binds the host there, and neither a mark on the host nor one on
      // the element inside covers the trusted events, which come from inside.
      for (const [name, mark] of [['the host', null], ['the element inside', "document.getElementById('shadow-host').shadowRoot.getElementById('inner')"]]) {
        await t.test(`inside an open shadow root a mark on ${name} does not cover a trusted click`, async () => {
          const { context, page } = await fixture(browser, build);
          try {
            await shadowHost(page);
            const events = await trusted(page, { x: 700, y: 330, mark });
            assert.equal(await page.evaluate(() => window.innerClicks), 1);
            assert.ok(events.some(event => event.endsWith('/user')), `the click is not shown as the agent's: ${events}`);
          } finally { await context.close(); }
        });
      }
    } finally { await browser.close(); }
  });

  test(`${build}: finishing an operation delivers its own pending reactions first`, { timeout: 60000 }, async t => {
    const browser = await engine.launch({ headless: true });
    try {
      await t.test('a debounced reaction is flushed and delivered before finish replies (D2)', async () => {
        const { context, page } = await fixture(browser, build, { feedbackDelay: 40 });
        try {
          await message(page, 'page_monitor_prepare', { operationId: 'typing', tool: 'type_text', selector: '#field' });
          // Playwright's Firefox insertText commits a composition: trusted
          // compositionstart and compositionend come with its beforeinput and
          // input. They are this typing's own events, so they are declared too.
          // (Chrome's Input.insertText fires no composition events.)
          const eventTypes = ['beforeinput', 'input', 'change', ...(build === 'firefox' ? ['compositionstart', 'compositionend'] : [])];
          await message(page, 'page_monitor_dispatch', { operationId: 'typing', kind: 'input', selector: '#field', eventTypes });
          await page.keyboard.insertText('hello');
          const atFinish = await page.evaluate(async () => {
            // The page renders its reaction in a later task, inside the operation
            // window; the tool finishes before the 150 ms debounce elapses.
            document.getElementById('status').textContent = 'chars 5';
            await new Promise(resolve => setTimeout(resolve, 0));
            const response = await deliver('page_monitor_finish', { operationId: 'typing' });
            const label = event => `${event.kind}/${event.source}`;
            return { response, sent: feedback.map(label), delivered: delivered.map(label) };
          });
          assert.equal(atFinish.response?.ready, true);
          assert.equal(atFinish.sent.some(event => event.endsWith('/user')), false, `The typing is the agent's, not the user's: ${atFinish.sent}`);
          assert.ok(atFinish.delivered.includes('dom/unknown'), `The reaction reached the background before finish replied: ${atFinish.delivered}`);
        } finally { await context.close(); }
      });

      await t.test('coalesced feedback keeps its strongest attribution', async () => {
        const { context, page } = await fixture(browser, build);
        try {
          await page.evaluate(async () => {
            const finish = __wbPageMonitor.beginContentAction('click', { selector: '#human' });
            __wbPageMonitor.beforeLocalDispatch();
            await new Promise(resolve => setTimeout(resolve, 0));
            document.getElementById('counter').textContent = 'during the operation';
            await new Promise(resolve => setTimeout(resolve, 0));
            finish();
            document.getElementById('status').textContent = 'after the operation';
          });
          await settle(page);
          const dom = (await page.evaluate(() => feedback)).filter(event => event.kind === 'dom').map(event => event.source);
          assert.ok(dom.includes('unknown'), `A later passive batch must not relabel the uncertain change: ${dom}`);
        } finally { await context.close(); }
      });
    } finally { await browser.close(); }
  });
}
