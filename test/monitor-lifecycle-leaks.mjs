// Run-scoped monitor lifecycle: an orphaned monitor stops when the background
// no longer owns its run, removed shadow roots stay collectable during a run,
// disposal removes the BFCache listener, and a content action cannot restore
// another run's local operation.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { chromium, firefox } from 'playwright';
import { sharedBrowsers } from './lib/shared-browsers.mjs';
import { scaled } from './lib/time-budget.mjs';

const browsers = sharedBrowsers([chromium, firefox]);

const html = `<!doctype html><main><h1>Feed</h1><p id="clock">0</p><input id="field"><button id="send" type="button">Send</button></main>`;

async function fixture(browser, build) {
  const context = await browser.newContext();
  await context.route('https://lifecycle.test/**', route => route.fulfill({ contentType: 'text/html', body: html }));
  await context.addInitScript(() => {
    window.feedback = []; window.messageListeners = []; window.replyMode = 'accept'; window.runToken = 'run-1';
    window.pageshowListeners = new Set();
    // Observe the monitor's own BFCache registration without changing it.
    const add = EventTarget.prototype.addEventListener, remove = EventTarget.prototype.removeEventListener;
    EventTarget.prototype.addEventListener = function (type, handler, options) {
      if (this === window && type === 'pageshow') pageshowListeners.add(handler);
      return add.call(this, type, handler, options);
    };
    EventTarget.prototype.removeEventListener = function (type, handler, options) {
      if (this === window && type === 'pageshow') pageshowListeners.delete(handler);
      return remove.call(this, type, handler, options);
    };
    const replies = { accept: { accepted: true }, stale: { accepted: false, reason: 'stale-observation' },
      duplicate: { accepted: false, reason: 'duplicate-observation' }, invalid: { accepted: false, reason: 'invalid-observation' } };
    const runtime = {
      onMessage: { addListener: fn => messageListeners.push(fn), removeListener: fn => { messageListeners = messageListeners.filter(item => item !== fn); } },
      async sendMessage(msg) {
        if (msg.action === 'get_page_monitor_state') return replyMode === 'stale' ? { active: false } : { active: true, runToken, documentToken: msg.documentToken };
        if (msg.action === 'page_feedback') { feedback.push(msg.feedback); return replies[replyMode]; }
        return {};
      },
    };
    window.chrome = { runtime }; window.browser = window.chrome;
    window.deliver = (action, params = {}, extra = {}) => new Promise(resolve => {
      let answered = false;
      const respond = value => { answered = true; resolve(value); };
      for (const listener of messageListeners) {
        const asynchronous = listener({ target: 'content', action, params: { runToken, ...params }, ...extra }, {}, respond);
        if (answered || asynchronous === true) return;
      }
      resolve(undefined);
    });
  });
  await context.addInitScript({ content: fs.readFileSync(new URL(`../src/${build}/src/content/page-monitor-shadow.js`, import.meta.url), 'utf8') });
  await context.addInitScript({ content: fs.readFileSync(new URL(`../src/${build}/src/content/page-monitor.js`, import.meta.url), 'utf8') });
  const page = await context.newPage();
  await page.goto('https://lifecycle.test/start');
  await page.waitForFunction(() => window.__wbPageMonitor?.active);
  await page.waitForTimeout(200);
  await page.evaluate(() => { feedback = []; });
  return { context, page };
}

const tick = page => page.evaluate(() => { const clock = document.getElementById('clock'); clock.textContent = String(Number(clock.textContent) + 1); });

for (const [build, engine] of [['chrome', chromium], ['firefox', firefox]]) {
  test(`${build}: an orphaned monitor stops on a stale-observation reply`, { timeout: scaled(60000) }, async t => {
    const browser = await browsers.lease(engine);
    try {
      await t.test('the run is gone: stop observing and stop waking the background', async () => {
        const { context, page } = await fixture(browser, build);
        try {
          await page.evaluate(() => { replyMode = 'stale'; });
          await tick(page);
          await page.waitForFunction(() => feedback.length > 0);
          await page.waitForTimeout(100);
          assert.equal(await page.evaluate(() => __wbPageMonitor.active), false);
          assert.equal(await page.evaluate(() => document.documentElement.hasAttribute('data-webbrain-page-revision')), false);
          const sent = await page.evaluate(() => feedback.length);
          for (let i = 0; i < 3; i++) { await tick(page); await page.waitForTimeout(200); }
          assert.equal(await page.evaluate(() => feedback.length), sent, 'No further page_feedback messages after the run is gone');
          // A later run reactivates the same document through the normal handshake.
          await page.evaluate(() => { replyMode = 'accept'; runToken = 'run-2'; });
          await page.evaluate(() => deliver('page_monitor_state', {}, { active: true }));
          await page.waitForFunction(() => __wbPageMonitor.active);
          await tick(page);
          await page.waitForFunction(count => feedback.length > count, sent);
        } finally { await context.close(); }
      });

      for (const mode of ['duplicate', 'invalid']) await t.test(`a ${mode}-observation reply keeps monitoring`, async () => {
        const { context, page } = await fixture(browser, build);
        try {
          await page.evaluate(mode => { replyMode = mode; }, mode);
          await tick(page);
          await page.waitForFunction(() => feedback.length > 0);
          await page.waitForTimeout(100);
          assert.equal(await page.evaluate(() => __wbPageMonitor.active), true);
        } finally { await context.close(); }
      });
    } finally { await browser.close(); }
  });

  test(`${build}: run-scoped listeners and local operations do not outlive their owner`, { timeout: scaled(90000) }, async t => {
    const browser = await browsers.lease(engine);
    try {
      await t.test('disposal removes the BFCache pageshow listener', async () => {
        const { context, page } = await fixture(browser, build);
        try {
          assert.equal(await page.evaluate(() => pageshowListeners.size), 1);
          await page.evaluate(() => __wbPageMonitor.dispose());
          assert.equal(await page.evaluate(() => pageshowListeners.size), 0, 'A disposed monitor must not stay reachable from window');
        } finally { await context.close(); }
      });

      await t.test('a content action finishing after stop/start keeps the new run\'s operation', async () => {
        const { context, page } = await fixture(browser, build);
        try {
          const observed = await page.evaluate(async () => {
            const finishOld = __wbPageMonitor.beginContentAction('type_ax', { selector: '#field' });
            await deliver('page_monitor_state', { runToken: 'run-1' }, { active: false, runToken: 'run-1' });
            runToken = 'run-2';
            await deliver('page_monitor_state', {}, { active: true });
            const finishNew = __wbPageMonitor.beginContentAction('type_ax', { selector: '#field' });
            finishOld(); // The old run's action completes late.
            feedback = [];
            const field = document.getElementById('field');
            __wbPageMonitor.withLocalDispatch(() => { field.value = 'agent'; field.dispatchEvent(new Event('input', { bubbles: true })); });
            finishNew();
            await new Promise(resolve => setTimeout(resolve, 50));
            return feedback.map(event => `${event.kind}/${event.source}`);
          });
          assert.equal(observed.includes('input/page'), false, `The new run's synthetic input stays owned: ${observed}`);
        } finally { await context.close(); }
      });

      if (build === 'chrome') await t.test('removed shadow roots stay collectable while the run is active', async () => {
        const { context, page } = await fixture(browser, build);
        try {
          await page.evaluate(async () => {
            for (let i = 0; i < 300; i++) {
              const host = document.createElement('div'); document.body.append(host);
              host.attachShadow({ mode: 'open' }).innerHTML = '<span>card</span>';
              if (i % 50 === 49) await new Promise(resolve => setTimeout(resolve, 0));
              host.remove();
            }
            await new Promise(resolve => setTimeout(resolve, 300));
          });
          assert.equal(await page.evaluate(() => __wbPageMonitor.active), true);
          const session = await context.newCDPSession(page);
          await session.send('HeapProfiler.enable');
          await session.send('HeapProfiler.collectGarbage');
          const prototype = await session.send('Runtime.evaluate', { expression: 'ShadowRoot.prototype' });
          const objects = await session.send('Runtime.queryObjects', { prototypeObjectId: prototype.result.objectId });
          const count = await session.send('Runtime.callFunctionOn', { objectId: objects.objects.objectId,
            functionDeclaration: 'function () { return this.length; }', returnByValue: true });
          assert.ok(count.result.value < 30, `Removed shadow roots retained: ${count.result.value}`);
        } finally { await context.close(); }
      });

      await t.test('shadow-root listeners still observe and are removed on stop', async () => {
        const { context, page } = await fixture(browser, build);
        try {
          const result = await page.evaluate(async () => {
            const host = document.createElement('div'); document.body.append(host);
            const root = host.attachShadow({ mode: 'open' });
            root.innerHTML = '<div popover id="tip">Tip</div>';
            await new Promise(resolve => setTimeout(resolve, 50));
            feedback = [];
            root.getElementById('tip').showPopover();
            await new Promise(resolve => setTimeout(resolve, 250));
            const observed = feedback.length > 0;
            await deliver('page_monitor_state', { runToken: 'run-1' }, { active: false, runToken: 'run-1' });
            feedback = [];
            root.getElementById('tip').hidePopover();
            await new Promise(resolve => setTimeout(resolve, 250));
            return { observed, afterStop: feedback.length };
          });
          assert.deepEqual(result, { observed: true, afterStop: 0 });
        } finally { await context.close(); }
      });
    } finally { await browser.close(); }
  });
}
