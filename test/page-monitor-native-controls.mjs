import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { chromium, firefox } from 'playwright';
import { sharedBrowsers } from './lib/shared-browsers.mjs';
import { suiteTimeout } from './lib/time-budget.mjs';

const browsers = sharedBrowsers([chromium, firefox]);

// These authored controls already appear in the production AX reader and can
// be clicked by content.js. Their private action context must have the same
// observation and dispatch fences as native/ARIA buttons on a changing page.
const html = `<!doctype html><style>
body{margin:20px;font:16px sans-serif}main{width:600px}
summary,button,[tabindex],[onclick],[role=button]{min-height:40px;width:240px}
#clock{position:absolute;left:750px;top:500px}#human{position:absolute;left:750px;top:550px}
</style><main id="owner"><h1 id="heading">Owned record options</h1>
<details id="disclosure"><summary id="summary">More options</summary><p>Current choices</p></details>
<div id="tabbed" tabindex="0">Choose tabbed options</div>
<div id="inline" onclick="window.qaClicks.inline++">Choose inline options</div>
<div id="aria" role="button">Choose ARIA options</div>
<button id="native" type="button">Choose native options</button>
<div id="passive" tabindex="-1">Passive wrapper</div>
<div id="plain">Plain wrapper</div></main>
<aside id="clock">0</aside><button id="human" type="button">Human control</button>`;
const sources = new Map();
for (const build of ['chrome', 'firefox']) {
  const files = new Map();
  for (const name of ['rich-text-toolbar-heuristic.js', 'file-upload-policy.js', 'accessibility-tree.js', 'page-monitor.js', 'content.js']) {
    files.set(name, await readFile(new URL(`../src/${build}/src/content/${name}`, import.meta.url), 'utf8'));
  }
  sources.set(build, files);
}

async function fixture(browser, build) {
  const context = await browser.newContext({ viewport: { width: 1100, height: 750 } });
  await context.route('https://native-controls.test/**', route => route.fulfill({ contentType: 'text/html', body: html }));
  await context.addInitScript(() => {
    window.qaListeners = []; window.qaFeedback = []; window.qaRunToken = 'native-controls-run';
    window.qaClicks = { summary: 0, tabbed: 0, inline: 0, aria: 0, native: 0 };
    window.chrome = window.browser = { runtime: {
      onMessage: { addListener: fn => qaListeners.push(fn), removeListener() {} }, getURL: value => value,
      async sendMessage(message) {
        if (message.action === 'get_page_monitor_state') return { active: true, runToken: qaRunToken, documentToken: message.documentToken };
        if (message.action === 'page_feedback') { qaFeedback.push(message.feedback); return { accepted: true }; }
        return {};
      },
    } };
    window.qaMessage = (action, params = {}) => new Promise(resolve => {
      let answered = false;
      const respond = value => { answered = true; resolve(value); };
      for (const listener of qaListeners) {
        const message = action === 'page_monitor_state'
          ? { target: 'content', action, runToken: 'native-controls-run', ...params }
          : { target: 'content', action, params: { runToken: 'native-controls-run', ...params } };
        const asynchronous = listener(message, {}, respond);
        if (answered || asynchronous === true) break;
      }
    });
  });
  for (const content of sources.get(build).values()) await context.addInitScript({ content });
  const page = await context.newPage();
  await page.goto('https://native-controls.test/records/current');
  await page.waitForFunction(() => window.__wbPageMonitor?.active);
  await page.waitForTimeout(180);
  await page.evaluate(() => {
    qaFeedback = [];
    for (const id of ['summary', 'tabbed', 'aria', 'native']) {
      document.getElementById(id).addEventListener('click', () => qaClicks[id]++);
    }
  });
  return { context, page };
}

async function capture(page, id) {
  return page.evaluate(async id => {
    const snapshot = await qaMessage('page_monitor_capture_model', { includeTree: true });
    const ref_id = __wb_ax_ref(document.getElementById(id));
    return { snapshot, ref_id, observed: snapshot.page?.pageContent.includes(`[${ref_id}]`) };
  }, id);
}

const validate = (page, captured) => page.evaluate(({ snapshot, ref_id }) => qaMessage('page_monitor_validate_model', {
  tool: 'click_ax', ref_id, snapshotToken: snapshot.snapshotToken,
}), captured);

async function dispatch(page, captured) {
  return page.evaluate(async ({ snapshot, ref_id }) => {
    const prepared = await qaMessage('page_monitor_prepare', { tool: 'click_ax', ref_id,
      operationId: 'native-controls-click', expectedModelSnapshot: snapshot.snapshotToken, allowPassiveRebase: true });
    // The Agent requires a positive original model certificate before the
    // content handler receives a bound click. Do not skip that production gate.
    const fence = prepared.ready === true && prepared.modelBindingValid === true
      ? await qaMessage('page_monitor_dispatch', { operationId: 'native-controls-click', kind: 'click', fenceOnly: true })
      : { ready: false };
    const action = fence.ready === true ? await qaMessage('click_ax', { ref_id }) : null;
    return { prepared, fence, action, clicks: { ...qaClicks }, open: disclosure.open };
  }, captured);
}

for (const [build, engine] of [['chrome', chromium], ['firefox', firefox]]) {
  // 19 subtests, each in its own context.
  test(`${build}: observed native and authored controls retain exact context under passive churn`, { timeout: suiteTimeout(19) }, async t => {
    const browser = await browsers.lease(engine);
    try {
      const withFixture = async work => {
        const { context, page } = await fixture(browser, build);
        try { await work(page); } finally { await context.close(); }
      };
      for (const id of ['summary', 'tabbed', 'inline', 'aria', 'native']) {
        await t.test(`${id}: one original click survives unrelated counter updates`, () => withFixture(async page => {
          const captured = await capture(page, id);
          assert.equal(captured.observed, true, 'The exact ref is in the formatter-owned model observation.');
          assert.equal((await validate(page, captured)).ready, true);
          await page.evaluate(() => { clock.textContent = '1'; });
          await page.waitForTimeout(180);
          assert.equal((await validate(page, captured)).ready, true);
          const result = await dispatch(page, captured);
          assert.equal(result.prepared.modelBindingValid, true, JSON.stringify(result));
          assert.equal(result.fence.ready, true, JSON.stringify(result));
          assert.equal(result.action?.success, true, JSON.stringify(result));
          assert.deepEqual(result.clicks, Object.fromEntries(Object.keys(result.clicks).map(key => [key, key === id ? 1 : 0])));
          if (id === 'summary') {
            assert.equal(result.open, true, 'The native disclosure opens exactly once.');
            assert.equal((await validate(page, captured)).ready, false, 'The changed open state retires the old action.');
          }
        }));
      }

      await t.test('plain wrappers, negative tab stops and the details container do not acquire action authority', () => withFixture(async page => {
        for (const id of ['plain', 'passive', 'disclosure']) {
          const captured = await capture(page, id);
          assert.equal((await validate(page, captured)).ready, false, id);
          const result = await dispatch(page, captured);
          assert.equal(result.action, null, id);
          assert.equal(Object.values(result.clicks).reduce((sum, count) => sum + count, 0), 0, id);
        }
      }));

      const mutations = [
        ['summary open', 'summary', () => { disclosure.open = true; }],
        ['authored handler', 'inline', () => { inline.setAttribute('onclick', 'window.qaUnexpectedAction=true'); }],
        ['handler function identity', 'inline', () => { inline.onclick = () => { window.qaUnexpectedAction = true; }; }],
        ['tab stop', 'tabbed', () => { tabbed.setAttribute('tabindex', '-1'); }],
        ['control name', 'summary', () => { summary.textContent = 'Other options'; }],
        ['owner identity', 'summary', () => { heading.textContent = 'Another record options'; }],
        ['same-name clone', 'inline', () => { inline.replaceWith(inline.cloneNode(true)); }],
        ['inert owner', 'tabbed', () => { owner.inert = true; }],
        ['foreign overlay', 'summary', () => {
          const rect = summary.getBoundingClientRect(), overlay = document.createElement('div');
          Object.assign(overlay.style, { position: 'fixed', left: `${rect.left}px`, top: `${rect.top}px`,
            width: `${rect.width}px`, height: `${rect.height}px`, zIndex: '999', background: 'white' });
          document.body.append(overlay);
        }],
      ];
      for (const [label, id, mutate] of mutations) {
        await t.test(`${label}: stale observation cannot dispatch`, () => withFixture(async page => {
          const captured = await capture(page, id);
          assert.equal((await validate(page, captured)).ready, true);
          await page.evaluate(mutate);
          assert.equal((await validate(page, captured)).ready, false);
          const result = await dispatch(page, captured);
          assert.equal(result.action, null, JSON.stringify(result));
          assert.equal(Object.values(result.clicks).reduce((sum, count) => sum + count, 0), 0);
        }));
      }
      for (const change of ['trusted user', 'task/run', 'document', 'Stop']) {
        await t.test(`${change}: old task authority cannot dispatch`, () => withFixture(async page => {
          const captured = await capture(page, 'summary');
          assert.equal((await validate(page, captured)).ready, true);
          if (change === 'trusted user') await page.locator('#human').click();
          else if (change === 'document') await page.reload();
          else if (change === 'Stop') await page.evaluate(() => qaMessage('page_monitor_state', { active: false }));
          else await page.evaluate(async () => { qaRunToken = 'another-task-run'; await qaMessage('page_monitor_state', { active: true }); });
          assert.equal((await validate(page, captured)).ready, false);
          const result = await dispatch(page, captured);
          assert.equal(result.action, null, JSON.stringify(result));
          assert.equal(Object.values(result.clicks).reduce((sum, count) => sum + count, 0), 0);
        }));
      }
    } finally { await browser.close(); }
  });
}
