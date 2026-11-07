import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { chromium, firefox } from 'playwright';
import { sharedBrowsers } from './lib/shared-browsers.mjs';
import { suiteTimeout } from './lib/time-budget.mjs';

const browsers = sharedBrowsers([chromium, firefox]);

const monitorSources = new Map(['chrome', 'firefox'].map(build => [build, fs.readFileSync(
  process.env.WEBBRAIN_HIDDEN_DECORATION_BEFORE_SOURCE === '1'
    ? new URL(`../ci/artifacts/quality-audit-2026-10-07/monitor-hidden-decoration-before-${build}.js`, import.meta.url)
    : process.env.WEBBRAIN_DECORATIVE_HIT_BEFORE_SOURCE === '1'
    ? new URL(`../ci/artifacts/quality-audit-2026-10-07/monitor-navigation-before-${build}.js`, import.meta.url)
    : new URL(`../src/${build}/src/content/page-monitor.js`, import.meta.url), 'utf8')]));

const body = `<!doctype html><style>
body{margin:0;width:1000px;height:700px;font:16px sans-serif}
#owner{position:absolute;left:20px;top:20px;width:300px;height:120px}
#action{position:absolute;left:0;top:0;width:180px;height:40px}
#action svg{position:absolute;left:70px;top:5px;width:40px;height:30px}
#counter{position:absolute;left:650px;top:550px;width:100px;height:30px}
</style><nav id="owner" role="region" aria-label="Current account controls" data-account-id="qa-own-account">
<button id="action" aria-label="Account controls">Account<svg aria-hidden="true" width="40" height="30"><rect width="40" height="30" fill="black"></rect></svg></button>
</nav><aside id="counter">0</aside>`;

async function fixture(browser, build, html = body) {
  const context = await browser.newContext({ viewport: { width: 1000, height: 700 } });
  await context.route('https://decorative-hit.test/**', route => route.fulfill({ contentType: 'text/html', body: html }));
  await context.addInitScript(() => {
    window.messageListeners = []; window.feedback = []; window.nativeClicks = 0;
    const runtime = { onMessage: { addListener: fn => messageListeners.push(fn), removeListener: () => {} },
      async sendMessage(message) {
        if (message.action === 'get_page_monitor_state') return { active: true, runToken: 'decorative-hit', documentToken: message.documentToken };
        if (message.action === 'page_feedback') { feedback.push(message.feedback); return { accepted: true }; }
        return {};
      } };
    window.chrome = { runtime }; window.browser = window.chrome;
    window.deliver = (action, params = {}) => new Promise(resolve => {
      let answered = false;
      const respond = value => { answered = true; resolve(value); };
      for (const listener of messageListeners) {
        const asynchronous = listener({ target: 'content', action, params: { runToken: 'decorative-hit', ...params } }, {}, respond);
        if (answered || asynchronous === true) break;
      }
    });
  });
  for (const name of ['accessibility-tree.js', 'page-monitor.js', 'content.js']) {
    await context.addInitScript({ content: name === 'page-monitor.js' ? monitorSources.get(build)
      : fs.readFileSync(new URL(`../src/${build}/src/content/${name}`, import.meta.url), 'utf8') });
  }
  const page = await context.newPage();
  await page.goto('https://decorative-hit.test/owned');
  await page.waitForFunction(() => window.__wbPageMonitor?.active);
  await page.waitForTimeout(180);
  await page.evaluate(() => {
    feedback = [];
    document.getElementById('action').addEventListener('click', () => nativeClicks++);
  });
  return { context, page };
}

// Native contact drawers decorate a hidden icon on hover/focus, while the
// actual control and its accessible name remain unchanged. The model must
// still bind the exact rendered HEADER and BUTTON in a fresh observation.
const hiddenDecorationBody = `<!doctype html><style>
body{margin:0;width:1000px;height:700px;font:16px sans-serif}
#owner{position:absolute;left:20px;top:20px;width:300px;height:100px}
#action{position:absolute;left:0;top:0;width:180px;height:40px}
#icon{position:absolute;left:70px;top:5px;width:40px;height:30px}
#counter{position:absolute;left:650px;top:550px}
</style><section><header id="owner"><button id="action" type="button" aria-label="Close">
<span id="icon" data-icon="x" aria-hidden="true">×</span></button></header></section>
<aside id="counter">0</aside>`;

const hiddenDecorationChanges = [
  ['rendered icon identity', () => {
    const icon = document.getElementById('icon'); icon.removeAttribute('aria-hidden');
    icon.setAttribute('aria-label', 'Other account');
  }],
  ['hidden nested button role', () => document.getElementById('icon').setAttribute('role', 'button')],
  ['hidden nested link', () => {
    const icon = document.getElementById('icon'); icon.setAttribute('role', 'link'); icon.setAttribute('href', '/other-action');
  }],
  ['hidden tab stop', () => document.getElementById('icon').setAttribute('tabindex', '0')],
  ['hidden native event handler', () => { document.getElementById('icon').onmouseover = () => { window.otherAction = true; }; }],
  ['hidden action marker', () => document.getElementById('icon').setAttribute('data-action', 'other-action')],
  ['hidden recipient identity', () => document.getElementById('icon').setAttribute('data-recipient', 'other-owned-qa')],
  ['native action identity', () => document.getElementById('action').setAttribute('aria-label', 'Other action')],
  ['native header account identity', () => document.getElementById('owner').setAttribute('data-account-id', 'other-owned-account')],
];

async function capture(page) {
  return page.evaluate(async () => {
    const snapshot = await deliver('page_monitor_capture_model', { includeTree: true });
    const tree = typeof snapshot.page === 'string' ? JSON.parse(snapshot.page) : snapshot.page;
    const ref_id = __wb_ax_ref(document.getElementById('action'));
    return { snapshot, ref_id, observed: tree.pageContent.includes(`[${ref_id}]`),
      hitTag: document.elementFromPoint(110, 40)?.tagName };
  });
}

async function validate(page, captured) {
  return page.evaluate(({ snapshot, ref_id }) => deliver('page_monitor_validate_model', {
    snapshotToken: snapshot.snapshotToken, tool: 'click_ax', ref_id,
  }), captured);
}

async function dispatch(page, captured) {
  return page.evaluate(async ({ snapshot, ref_id }) => {
    const prepared = await deliver('page_monitor_prepare', { operationId: 'decorative-click',
      tool: 'click_ax', ref_id, expectedModelSnapshot: snapshot.snapshotToken, allowPassiveRebase: true });
    const fence = await deliver('page_monitor_dispatch', { operationId: 'decorative-click', kind: 'click', fenceOnly: true });
    if (!fence.ready) return { prepared, fence, clicks: nativeClicks };
    const result = await deliver('click_ax', { ref_id });
    return { prepared, fence, result, clicks: nativeClicks };
  }, captured);
}

const changes = [
  ['foreign overlay', () => {
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:absolute;left:20px;top:20px;width:180px;height:40px;z-index:100';
    document.body.append(overlay);
  }],
  ['interactive SVG descendant', () => {
    const svg = document.querySelector('#action svg'); const replacement = svg.cloneNode(true);
    replacement.querySelector('rect').setAttribute('role', 'button'); svg.replaceWith(replacement);
  }],
  ['SVG descendant tab stop', () => {
    const svg = document.querySelector('#action svg'); const replacement = svg.cloneNode(true);
    replacement.querySelector('rect').setAttribute('tabindex', '0'); svg.replaceWith(replacement);
  }],
  ['nested native control', () => {
    const svg = document.querySelector('#action svg'); const replacement = document.createElement('button');
    replacement.style.cssText = 'position:absolute;left:70px;top:5px;width:40px;height:30px';
    replacement.setAttribute('aria-hidden', 'true'); svg.replaceWith(replacement);
  }],
  ['SVG native link', () => {
    const svg = document.querySelector('#action svg'); const replacement = svg.cloneNode(true);
    const link = document.createElementNS('http://www.w3.org/2000/svg', 'a');
    link.setAttribute('href', '/other-action'); link.append(replacement.querySelector('rect'));
    replacement.append(link); svg.replaceWith(replacement);
  }],
  ['authored SVG onclick', () => {
    const svg = document.querySelector('#action svg'); const replacement = svg.cloneNode(true);
    replacement.querySelector('rect').setAttribute('onclick', 'window.otherAction=true'); svg.replaceWith(replacement);
  }],
  ['property SVG onclick', () => {
    const svg = document.querySelector('#action svg'); const replacement = svg.cloneNode(true);
    replacement.querySelector('rect').onclick = () => { window.otherAction = true; }; svg.replaceWith(replacement);
  }],
  ['property SVG onmouseover', () => {
    const svg = document.querySelector('#action svg'); const replacement = svg.cloneNode(true);
    replacement.querySelector('rect').onmouseover = () => { window.otherAction = true; }; svg.replaceWith(replacement);
  }],
  ['SVG wrapper native handler', () => {
    const svg = document.querySelector('#action svg'); const replacement = svg.cloneNode(true);
    const wrapper = document.createElement('span'); wrapper.onmouseover = () => { window.otherAction = true; };
    svg.replaceWith(wrapper); wrapper.append(replacement);
  }],
  ['SVG wrapper recipient identity', () => {
    const svg = document.querySelector('#action svg'); const replacement = svg.cloneNode(true);
    const wrapper = document.createElement('span'); wrapper.setAttribute('data-recipient', 'other-owned-qa');
    svg.replaceWith(wrapper); wrapper.append(replacement);
  }],
  ['SVG data action', () => {
    const svg = document.querySelector('#action svg'); const replacement = svg.cloneNode(true);
    replacement.querySelector('rect').setAttribute('data-action', 'other-action'); svg.replaceWith(replacement);
  }],
  ['SVG recipient identity', () => {
    const svg = document.querySelector('#action svg'); const replacement = svg.cloneNode(true);
    replacement.querySelector('rect').setAttribute('data-recipient', 'other-owned-qa'); svg.replaceWith(replacement);
  }],
  ['SVG accessible identity', () => {
    const svg = document.querySelector('#action svg'); const replacement = svg.cloneNode(true);
    replacement.setAttribute('aria-label', 'Other action'); svg.replaceWith(replacement);
  }],
  ['SVG ceases to be decorative', () => {
    const svg = document.querySelector('#action svg'); const replacement = svg.cloneNode(true);
    replacement.removeAttribute('aria-hidden'); svg.replaceWith(replacement);
  }],
  ['account owner identity', () => { document.getElementById('owner').setAttribute('data-account-id', 'other-owned-account'); }],
  ['action label', () => { document.getElementById('action').setAttribute('aria-label', 'Different account action'); }],
  ['action node', () => { const action = document.getElementById('action'); action.replaceWith(action.cloneNode(true)); }],
  ['scope node', () => { const owner = document.getElementById('owner'); owner.replaceWith(owner.cloneNode(true)); }],
];

for (const [build, engine] of [['chrome', chromium], ['firefox', firefox]]) {
  // 13 subtests.
  test(`${build}: hidden decorative icon labels preserve fresh native control coverage`, { timeout: suiteTimeout(13) }, async t => {
    const browser = await browsers.lease(engine);
    try {
      for (const mode of ['initial hidden label', 'hover and focus hidden label update']) {
        await t.test(`${mode} permits one freshly bound native Close`, async () => {
          const { context, page } = await fixture(browser, build, hiddenDecorationBody);
          try {
            if (mode === 'initial hidden label') {
              await page.evaluate(() => document.getElementById('icon').setAttribute('aria-label', 'Close contact info'));
            } else {
              const before = await capture(page);
              assert.equal((await validate(page, before)).ready, true);
              await page.evaluate(() => {
                const button = document.getElementById('action'), icon = document.getElementById('icon');
                button.addEventListener('pointerenter', () => icon.setAttribute('aria-label', 'Close contact info'));
                button.addEventListener('focus', () => icon.setAttribute('aria-label', 'Close contact info'));
              });
              await page.locator('#action').hover(); await page.locator('#action').focus();
              assert.equal(await page.locator('#icon').getAttribute('aria-label'), 'Close contact info');
            }
            const captured = await capture(page);
            assert.equal(captured.observed, true);
            assert.equal((await validate(page, captured)).ready, true,
              'A hidden icon label must not require an impossible visible identity observation');
            const executed = await dispatch(page, captured);
            assert.equal(executed.fence.ready, true, JSON.stringify(executed));
            assert.equal(executed.result?.success, true, JSON.stringify(executed));
            assert.equal(executed.clicks, 1);
          } finally { await context.close(); }
        });
      }
      for (const [name, mutate] of hiddenDecorationChanges) await t.test(`${name} invalidates the previous native control binding`, async () => {
        const { context, page } = await fixture(browser, build, hiddenDecorationBody);
        try {
          const captured = await capture(page);
          assert.equal((await validate(page, captured)).ready, true);
          await page.evaluate(mutate);
          assert.equal((await validate(page, captured)).ready, false,
            'Decorative label handling must preserve exact action, recipient and interaction semantics');
          const attempted = await dispatch(page, captured);
          assert.equal(attempted.prepared.modelBindingValid, false, JSON.stringify(attempted));
          assert.equal(attempted.fence.ready, false, JSON.stringify(attempted));
          assert.equal(attempted.clicks, 0);
        } finally { await context.close(); }
      });
      for (const attribute of ['aria-labelledby', 'aria-describedby']) await t.test(`hidden ${attribute} identity is not decorative`, async () => {
        const { context, page } = await fixture(browser, build, hiddenDecorationBody);
        try {
          await page.evaluate(attribute => {
            const icon = document.getElementById('icon');
            icon.textContent = 'Owned account action'; icon.setAttribute('aria-label', 'Owned account action');
            document.getElementById('action').setAttribute(attribute, 'icon');
          }, attribute);
          const captured = await capture(page);
          assert.equal((await validate(page, captured)).ready, false,
            'An actual control name/purpose reference must retain complete identity requirements');
          const attempted = await dispatch(page, captured);
          assert.equal(attempted.fence.ready, false, JSON.stringify(attempted));
          assert.equal(attempted.clicks, 0);
        } finally { await context.close(); }
      });
    } finally { await browser.close(); }
  });

  // 22 subtests.
  test(`${build}: decorative SVG hits retain the same observed action and reject meaningful changes`, { timeout: suiteTimeout(22) }, async t => {
    const browser = await browsers.lease(engine);
    try {
      await t.test('React-style aria-hidden SVG replacement retains the exact action through guarded dispatch', async () => {
        const { context, page } = await fixture(browser, build);
        try {
          const captured = await capture(page);
          assert.equal(captured.observed, true); assert.equal(captured.hitTag, 'rect');
          assert.equal((await validate(page, captured)).ready, true);
          const retained = await page.evaluate(() => {
            const original = document.getElementById('action'), originalText = original.textContent;
            const oldHit = document.elementFromPoint(110, 40);
            const svg = original.querySelector('svg'); svg.replaceWith(svg.cloneNode(true));
            document.getElementById('counter').textContent = '1';
            return { sameAction: original === document.getElementById('action'), sameText: original.textContent === originalText,
              changedHit: oldHit !== document.elementFromPoint(110, 40) };
          });
          assert.deepEqual(retained, { sameAction: true, sameText: true, changedHit: true });
          assert.equal((await validate(page, captured)).ready, true,
            'Replacing a noninteractive aria-hidden SVG must retain the bound native action');
          const executed = await dispatch(page, captured);
          assert.equal(executed.fence.ready, true, JSON.stringify(executed));
          assert.equal(executed.result?.success, true, JSON.stringify(executed));
          assert.equal(executed.clicks, 1);
        } finally { await context.close(); }
      });

      await t.test('an originally meaningful SVG cannot gain decorative retention after capture', async () => {
        const { context, page } = await fixture(browser, build);
        try {
          await page.evaluate(() => document.querySelector('#action svg').removeAttribute('aria-hidden'));
          const captured = await capture(page);
          assert.equal((await validate(page, captured)).ready, true);
          await page.evaluate(() => {
            const svg = document.querySelector('#action svg'); const replacement = svg.cloneNode(true);
            replacement.setAttribute('aria-hidden', 'true'); svg.replaceWith(replacement);
          });
          assert.equal((await validate(page, captured)).ready, false);
          const attempted = await dispatch(page, captured);
          assert.equal(attempted.prepared.modelBindingValid, false, JSON.stringify(attempted));
          assert.equal(attempted.fence.ready, false, JSON.stringify(attempted));
          assert.equal(attempted.clicks, 0);
        } finally { await context.close(); }
      });

      await t.test('repeated decorative replacement and an unrelated counter retain one guarded click', async () => {
        const { context, page } = await fixture(browser, build);
        try {
          const captured = await capture(page);
          assert.equal((await validate(page, captured)).ready, true);
          await page.evaluate(() => {
            window.decorativeReplacements = 0;
            window.decorativeTimer = setInterval(() => {
              const svg = document.querySelector('#action svg'); svg.replaceWith(svg.cloneNode(true));
              document.getElementById('counter').textContent = String(++decorativeReplacements);
            }, 20);
          });
          await page.waitForFunction(() => decorativeReplacements >= 5);
          assert.equal((await validate(page, captured)).ready, true);
          const executed = await dispatch(page, captured);
          assert.equal(executed.fence.ready, true, JSON.stringify(executed));
          assert.equal(executed.result?.success, true, JSON.stringify(executed));
          assert.equal(executed.clicks, 1);
          await page.evaluate(() => clearInterval(decorativeTimer));
        } finally { await context.close(); }
      });

      // A ref decision binds the node, not its coordinates: a pure move whose
      // hit is the same normalized node keeps the decision (rebased before
      // preparation). Replaced or non-decorative hits below still block.
      await t.test('action geometry alone keeps the old model action for the same node', async () => {
        const { context, page } = await fixture(browser, build);
        try {
          const captured = await capture(page);
          await page.evaluate(() => { document.getElementById('action').style.left = '40px'; });
          assert.equal((await validate(page, captured)).ready, true);
          const executed = await dispatch(page, captured);
          assert.equal(executed.fence.ready, true, JSON.stringify(executed));
          assert.equal(executed.result?.success, true, JSON.stringify(executed));
          assert.equal(executed.clicks, 1);
        } finally { await context.close(); }
      });

      for (const [name, mutate] of changes) await t.test(`${name} blocks the old model action`, async () => {
        const { context, page } = await fixture(browser, build);
        try {
          const captured = await capture(page);
          assert.equal((await validate(page, captured)).ready, true);
          await page.evaluate(mutate);
          assert.equal((await validate(page, captured)).ready, false, `${name} must not inherit the old action proof`);
          const attempted = await dispatch(page, captured);
          assert.equal(attempted.prepared.modelBindingValid, false, JSON.stringify(attempted));
          assert.equal(attempted.fence.ready, false, JSON.stringify(attempted));
          assert.equal(attempted.clicks, 0);
        } finally { await context.close(); }
      });
    } finally { await browser.close(); }
  });
}
