import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { chromium, firefox } from 'playwright';
import { sharedBrowsers } from './lib/shared-browsers.mjs';
import { scaled } from './lib/time-budget.mjs';

const browsers = sharedBrowsers([chromium, firefox]);

const owner = 'owned-cold-read:task-one:provider-one';
const html = `<!doctype html><style>body{margin:0;font:18px sans-serif}.chat{margin-left:300px;width:700px}.topbar{height:70px}.user-title{display:inline-block;min-width:100px;height:40px}.bubbles-scrollable{height:350px;overflow-y:auto}.input-message-input{width:600px;min-height:36px}button{width:50px;height:36px}#column-left{position:absolute;left:0;top:0;width:280px}.sidebar-header{height:64px}</style>
<div id="column-left"><div class="sidebar-header"><div class="sidebar-header__btn-container"><button id="tools" class="btn-icon rp btn-menu-toggle sidebar-tools-button is-visible"></button><button id="ordinary"></button></div></div></div>
<div class="chat"><div class="topbar"><div class="chat-info"><div class="user-title"><span class="peer-title" data-peer-id="123456" data-me-as-notes="1">Saved Messages</span></div></div></div>
<div class="bubbles scrolled-down"><div class="bubbles-scrollable"><div class="bubbles-inner"><div class="bubble is-in" data-mid="1" data-peer-id="123456"><div class="message">Owned fixture</div></div></div></div></div>
<div class="input-message-input" contenteditable="true" data-peer-id="123456"></div><button id="send">Send</button></div><aside id="counter">0</aside>`;

for (const [build, engine] of [['chrome', chromium], ['firefox', firefox]]) {
  const sources = await Promise.all(['rich-text-toolbar-heuristic.js','accessibility-tree.js','chat-observation.js','page-monitor.js','content.js']
    .map(file => readFile(new URL(`../src/${build}/src/content/${file}`, import.meta.url), 'utf8')));
  test(`${build}: cold private owner is initialized only by a current pre-inference capture`, { timeout: scaled(60000) }, async t => {
    const browser = await browsers.lease(engine);
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    try {
      await context.route('https://web.telegram.org/**', route => route.fulfill({ contentType: 'text/html', body: html }));
      await context.addInitScript(() => {
        window.qaListeners = []; window.qaClicks = { tools: 0, ordinary: 0, send: 0 };
        window.chrome = window.browser = { runtime: { getURL: value => value,
          onMessage: { addListener: fn => qaListeners.push(fn), removeListener() {} },
          async sendMessage(message) { return message.action === 'get_page_monitor_state'
            ? { active: true, runToken: 'cold-current-run', documentToken: message.documentToken } : { accepted: true }; },
        } };
        window.qaMessage = (action, params = {}) => new Promise(resolve => {
          for (const listener of qaListeners) {
            let answered = false;
            const result = listener(action === 'page_monitor_state'
              ? { target: 'content', action, runToken: 'cold-current-run', ...params }
              : { target: 'content', action, params: { runToken: 'cold-current-run', ...params } }, {}, value => { answered = true; resolve(value); });
            if (answered || result === true) break;
          }
        });
      });
      for (const source of sources) await context.addInitScript({ content: source });
      const page = await context.newPage();
      const reset = async () => {
        await page.goto('about:blank'); await page.goto('https://web.telegram.org/k/#@owned_qa');
        await page.waitForFunction(() => __wbPageMonitor?.active);
        await page.evaluate(() => {
          tools.addEventListener('click', () => { qaClicks.tools++; tools.classList.add('menu-open'); });
          ordinary.addEventListener('click', () => qaClicks.ordinary++); send.addEventListener('click', () => qaClicks.send++);
        });
      };
      const capture = (params = {}) => page.evaluate(params => qaMessage('page_monitor_capture_model', { includeTree: true, ...params }), params);
      const validate = snapshot => page.evaluate(snapshot => qaMessage('page_monitor_validate_model', {
        snapshotToken: snapshot.snapshotToken, tool: 'click_ax', ref_id: __wb_ax_ref(tools),
      }), snapshot);
      const bind = () => page.evaluate(owner => qaMessage('probe_message_recipient_guard', {
        tool: 'click_ax', args: { ref_id: __wb_ax_ref(tools) }, adapterName: 'telegram', bindDispatch: true, _nativeChatOwner: owner,
      }), owner);

      await t.test('cold capture certifies the exact empty native control before any observation or recipient probe', async () => {
        await reset();
        assert.equal(await page.evaluate(owner => __wb_get_readonly_identity_preparation(owner), owner), null);
        const snapshot = await capture({ nativeChatOwner: owner });
        assert.equal(snapshot.ready, true); assert.equal((await validate(snapshot)).ready, true);
        assert.equal(JSON.stringify(snapshot).includes(owner), false);
        assert.equal(JSON.stringify(snapshot).includes('wbip_'), false);
        await page.evaluate(() => counter.textContent = '1');
        assert.equal((await validate(snapshot)).ready, true, 'Passive feedback does not defeat the current exact readonly certificate.');
        const proof = await bind(); assert.equal(proof.nativeTelegramRepair, true); assert.ok(proof.nativeTelegramReadRepairBinding?.token);
        const result = await page.evaluate(async ({ snapshot, proof, owner }) => {
          const ref_id = __wb_ax_ref(tools);
          await qaMessage('page_monitor_prepare', { operationId: 'cold-tools', tool: 'click_ax', ref_id,
            expectedModelSnapshot: snapshot.snapshotToken, allowPassiveRebase: true });
          const fence = await qaMessage('page_monitor_dispatch', { operationId: 'cold-tools', kind: 'click', fenceOnly: true });
          if (!fence.ready) return { fence };
          return qaMessage('click_ax', { ref_id, _nativeChatOwner: owner, _nativeTelegramReadRepairRequired: true,
            nativeTelegramReadRepairBinding: proof.nativeTelegramReadRepairBinding });
        }, { snapshot, proof, owner });
        assert.equal(result.success, true, JSON.stringify(result)); assert.equal(result._nativeTelegramReadRepair, true);
        assert.deepEqual(await page.evaluate(() => qaClicks), { tools: 1, ordinary: 0, send: 0 });
      });
      await t.test('forged, wrong-run and inactive capture metadata cannot initialize a cold owner', async () => {
        await reset();
        assert.equal(await page.evaluate(owner => __wb_get_readonly_identity_preparation(owner, tools, {
          owner, runToken: 'cold-current-run', documentToken: 'forged', userAt: 0, interventionRevision: 0,
        }), owner), null);
        assert.equal((await capture({ nativeChatOwner: owner, runToken: 'old-run' })).ready, false);
        assert.equal(await page.evaluate(owner => __wb_get_readonly_identity_preparation(owner), owner), null);
        await page.evaluate(() => qaMessage('page_monitor_state', { active: false }));
        assert.equal((await capture({ nativeChatOwner: owner })).ready, false);
        assert.equal(await page.evaluate(owner => __wb_get_readonly_identity_preparation(owner), owner), null);
        assert.deepEqual(await page.evaluate(() => qaClicks), { tools: 0, ordinary: 0, send: 0 });
      });
      await t.test('the original capture authority expires before any later caller can adopt an owner', async () => {
        await reset();
        await page.evaluate(() => {
          const getter = __wb_get_readonly_identity_preparation;
          window.__wb_get_readonly_identity_preparation = (...args) => {
            if (args[2]) window.qaCapturedAuthority = args[2];
            return getter(...args);
          };
        });
        const snapshot = await capture({ nativeChatOwner: owner });
        assert.equal((await validate(snapshot)).ready, true);
        assert.deepEqual(await page.evaluate(owner => ({
          stillCurrent: __wbPageMonitor.currentIdentityPreparationCapture(qaCapturedAuthority, owner),
          adopted: !!__wb_get_readonly_identity_preparation(owner + ':forged', tools, qaCapturedAuthority),
          currentOwnerUnchanged: !!__wb_get_readonly_identity_preparation(owner, tools),
        }), owner), { stillCurrent: false, adopted: false, currentOwnerUnchanged: true });
      });
      await t.test('owner replacement invalidates both the old pre-inference certificate and one-use token', async () => {
        await reset(); const old = await capture({ nativeChatOwner: owner }), proof = await bind();
        assert.equal((await validate(old)).ready, true);
        const next = await capture({ nativeChatOwner: 'owned-cold-read:task-two:provider-two' });
        assert.equal((await validate(next)).ready, true); assert.equal((await validate(old)).ready, false);
        const rejected = await page.evaluate(({ owner, proof }) => qaMessage('click_ax', {
          ref_id: __wb_ax_ref(tools), _nativeChatOwner: owner, _nativeTelegramReadRepairRequired: true,
          nativeTelegramReadRepairBinding: proof.nativeTelegramReadRepairBinding,
        }), { owner, proof });
        assert.equal(rejected.noDispatch, true); assert.equal(rejected.dispatched, false);
        assert.deepEqual(await page.evaluate(() => qaClicks), { tools: 0, ordinary: 0, send: 0 });
      });
      for (const mutation of ['trusted-user','owner','peer','draft','stop']) await t.test(`${mutation} still revokes the cold certificate`, async () => {
        await reset(); const snapshot = await capture({ nativeChatOwner: owner });
        assert.equal((await validate(snapshot)).ready, true);
        if (mutation === 'trusted-user') await page.locator('#ordinary').click();
        else await page.evaluate(async ({ mutation, owner }) => {
          if (mutation === 'owner') await qaMessage('observe_chat', { _nativeChatOwner: owner + ':new-provider' });
          if (mutation === 'peer') document.querySelector('.peer-title').dataset.peerId = '987654';
          if (mutation === 'draft') document.querySelector('.input-message-input').textContent = 'User draft';
          if (mutation === 'stop') await qaMessage('page_monitor_state', { active: false });
        }, { mutation, owner });
        assert.equal((await validate(snapshot)).ready, false); assert.equal(await page.evaluate(() => qaClicks.tools + qaClicks.send), 0);
      });
    } finally { await context.close(); await browser.close(); }
  });
}
