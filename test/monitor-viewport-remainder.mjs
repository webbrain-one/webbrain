// A full-size, unzoomed visual viewport cannot pan by itself. Firefox reports
// the sub-pixel remainder of a fractional page scroll as a visual-viewport
// notification (Chromium does not); it is part of that scroll, not a zoom,
// resize or browser-chrome change. Real viewport changes and user scrolling
// still invalidate model-bound decisions, and a scroll that persists still
// changes the exact geometry the decision was certified for.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { chromium, firefox } from 'playwright';
import { sharedBrowsers } from './lib/shared-browsers.mjs';
import { scaled } from './lib/time-budget.mjs';

const browsers = sharedBrowsers([chromium, firefox]);

const RUN = 'viewport-remainder-run';
const body = `<!doctype html><style>
body { margin: 20px; font: 16px sans-serif; } #commit { width: 200px; height: 45px; }
</style><main><h1>Current record settings</h1><button id="commit" type="button">Apply settings</button>
<label>Record title <input id="title" value="Neutral draft"></label></main><div style="height:4000px"></div>
<div id="near" style="position:absolute;left:0;top:12.35px;width:1px;height:1px"></div>
<div id="far" style="position:absolute;left:0;top:1250.35px;width:1px;height:1px"></div>
<script>window.clicks = 0; document.getElementById('commit').addEventListener('click', () => clicks++);</script>`;

async function fixture(browser, build) {
  const context = await browser.newContext({ viewport: { width: 900, height: 700 } });
  await context.route('https://viewport-remainder.test/**', route => route.fulfill({ contentType: 'text/html', body }));
  await context.addInitScript(RUN => {
    window.feedback = []; window.messageListeners = []; window.remainders = [];
    const runtime = {
      onMessage: { addListener: fn => messageListeners.push(fn), removeListener() {} },
      async sendMessage(msg) {
        if (msg.action === 'get_page_monitor_state') return { active: true, runToken: RUN, documentToken: msg.documentToken };
        if (msg.action === 'page_feedback') { feedback.push(msg.feedback); return { accepted: true }; }
        return {};
      },
    };
    window.chrome = { runtime }; window.browser = window.chrome;
    window.deliver = (action, params = {}) => new Promise(resolve => {
      let answered = false;
      const respond = value => { answered = true; resolve(value); };
      for (const listener of messageListeners) {
        const asynchronous = listener({ target: 'content', action, params: { runToken: RUN, ...params } }, {}, respond);
        if (answered || asynchronous === true) return;
      }
      resolve(undefined);
    });
    addEventListener('DOMContentLoaded', () => window.visualViewport?.addEventListener('scroll',
      () => remainders.push(visualViewport.offsetTop)));
  }, RUN);
  await context.addInitScript({ content: fs.readFileSync(new URL(`../src/${build}/src/content/page-monitor.js`, import.meta.url), 'utf8') });
  const tab = await context.newPage();
  await tab.goto('https://viewport-remainder.test/start');
  await tab.waitForFunction(() => window.__wbPageMonitor?.active);
  await tab.mouse.move(5, 690);
  await tab.waitForTimeout(1100); // the pointer move is older than the user-scroll window
  await tab.evaluate(() => { feedback = []; remainders = []; });
  return { context, page: tab };
}

const message = (tab, action, params = {}) => tab.evaluate(({ action, params }) => Promise.race([deliver(action, params),
  new Promise(resolve => setTimeout(() => resolve({ ready: false, code: 'monitor_response_missing' }), 3000))]), { action, params });

async function certify(tab) {
  const snapshot = await message(tab, 'page_monitor_capture_model');
  assert.equal(snapshot.ready, true);
  const base = { runToken: RUN, operationId: 'remainder', tool: 'click', selector: '#commit',
    expectedModelSnapshot: snapshot.snapshotToken, allowPassiveRebase: true };
  assert.equal((await message(tab, 'page_monitor_prepare', base)).modelBindingValid, true);
  return base;
}

// Page-script scrolls, each followed by its frames and native notifications.
// Aligning an element at a fractional offset leaves a sub-pixel remainder in
// Firefox; scrolling to the top removes it again. Gecko re-applies a pending
// scrollIntoView on its next reflow, so each step settles one reflow first.
const pageScrolls = (tab, steps) => tab.evaluate(async steps => {
  const settle = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 60))));
  const reflow = () => { document.body.style.paddingBottom = '1px'; void document.body.offsetHeight;
    document.body.style.paddingBottom = ''; void document.body.offsetHeight; };
  for (const step of steps) {
    if (step === 'top') scrollTo({ top: 0, behavior: 'instant' });
    else document.getElementById(step).scrollIntoView({ block: 'start', behavior: 'instant' });
    reflow(); await settle();
  }
  await new Promise(resolve => setTimeout(resolve, 200)); // the coalesced final scroll report
  return scrollY;
}, steps);

for (const [build, engine] of [['chrome', chromium], ['firefox', firefox]]) {
  test(`${build}: a page's fractional scroll is reported as a scroll, never as a viewport change`, { timeout: scaled(60000) }, async () => {
    const browser = await browsers.lease(engine);
    try {
      const { page } = await fixture(browser, build);
      assert.equal(await pageScrolls(page, ['far', 'near', 'top']), 0);
      const { events, remainders } = await page.evaluate(() => ({ events: feedback, remainders }));
      // Firefox must actually have reported the sub-pixel remainder, so this
      // exercises the notification rather than passing vacuously.
      if (build === 'firefox') assert.ok(remainders.some(offset => offset !== 0), JSON.stringify(remainders));
      assert.equal(events.some(event => event.kind === 'resize'), false, JSON.stringify(events));
      assert.ok(events.some(event => event.kind === 'scroll' && event.source === 'unknown'), JSON.stringify(events));
      assert.equal(events.some(event => event.source === 'user'), false, JSON.stringify(events));
    } finally { await browser.close(); }
  });

  test(`${build}: a certified decision survives a page scroll that returns to the same position`, { timeout: scaled(60000) }, async () => {
    const browser = await browsers.lease(engine);
    try {
      const { page } = await fixture(browser, build);
      const base = await certify(page);
      assert.equal(await pageScrolls(page, ['near', 'top']), 0);
      const fence = await message(page, 'page_monitor_dispatch', { ...base, kind: 'click', fenceOnly: true });
      const state = await page.evaluate(() => ({ events: feedback, remainders, clicks }));
      if (build === 'firefox') assert.ok(state.remainders.some(offset => offset !== 0), JSON.stringify(state.remainders));
      assert.equal(fence.ready, true, JSON.stringify({ fence, state }));
      assert.equal(state.clicks, 0);
    } finally { await browser.close(); }
  });

  test(`${build}: persisting scroll, zoom, resize and user scroll still refuse the decision`, { timeout: scaled(120000) }, async t => {
    const browser = await browsers.lease(engine);
    try {
      for (const [name, change, predicate] of [
        ['page scroll that persists', async page => assert.ok(await pageScrolls(page, ['near']) > 0), /geometry_changed/],
        ['visual viewport zoom', page => page.evaluate(() => {
          Object.defineProperty(visualViewport, 'scale', { configurable: true, get: () => 1.25 });
          visualViewport.dispatchEvent(new Event('resize'));
        }), /intervention_changed/],
        ['viewport size', async page => {
          await page.setViewportSize({ width: 900, height: 650 });
          await page.waitForFunction(() => feedback.some(event => event.kind === 'resize'));
        }, /intervention_changed/],
        ['user wheel scroll', async page => {
          await page.mouse.move(450, 400); await page.mouse.wheel(0, 40);
          await page.waitForFunction(() => scrollY > 0); await page.waitForTimeout(200);
        }, /intervention_changed/],
      ]) await t.test(name, async () => {
        const { context, page } = await fixture(browser, build);
        try {
          const base = await certify(page);
          await change(page);
          const fence = await message(page, 'page_monitor_dispatch', { ...base, kind: 'click', fenceOnly: true });
          assert.equal(fence.ready, false, JSON.stringify(fence));
          assert.match(fence.preparationVeto?.predicate || '', predicate, JSON.stringify(fence));
          assert.equal(await page.evaluate(() => clicks), 0);
        } finally { await context.close(); }
      });
    } finally { await browser.close(); }
  });
}
