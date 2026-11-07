import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { chromium, firefox } from 'playwright';
import { sharedBrowsers } from './lib/shared-browsers.mjs';
import { suiteTimeout } from './lib/time-budget.mjs';

const browsers = sharedBrowsers([chromium, firefox]);

// An empty native control outside a semantic landmark needs a current private
// read-only adapter proof. AX presence, model flags and an unchanged label do
// not confer that authority. The real AX, observer, monitor and dispatch code
// run together; only the extension transport and owned application are local.
const owner = 'owned-read-preparation:task-one:provider-one';
const html = `<!doctype html><style>
body{margin:0;font:16px sans-serif}.chat{margin-left:320px;width:800px}.topbar{height:70px}
.user-title{display:inline-block;min-width:100px;height:40px}.bubbles-inner{height:450px}
.input-message-input{display:inline-block;width:650px;min-height:32px}button{width:50px;height:36px}
#column-left{position:absolute;left:0;top:0;width:280px}.sidebar-header{height:64px}
.btn-menu{position:absolute;top:70px;left:30px;width:220px;background:white}.btn-menu-item{height:36px}
.tgico{display:inline-block;width:18px;height:18px}#unrelated{position:absolute;left:20px;top:600px}
</style><div id="column-left"><div class="sidebar-slider"><div class="item-main">
<div class="sidebar-header"><div class="sidebar-header__btn-container">
<button id="preparation" class="btn-icon rp btn-menu-toggle sidebar-tools-button is-visible"></button>
<button id="ordinary"></button></div></div></div></div></div>
<div class="chat"><div class="topbar"><div class="chat-info"><div class="user-title">
<span class="peer-title" data-peer-id="123456" data-me-as-notes="1">Owned QA</span></div></div></div>
<div class="bubbles-inner"><div class="bubble is-in" data-mid="1" data-peer-id="123456"><div class="message">Owned fixture</div></div></div>
<div class="input-message-input" contenteditable="true" data-peer-id="123456"></div><button id="send">Send</button></div>
<aside id="unrelated">0</aside>`;

const sourceFiles = ['rich-text-toolbar-heuristic.js', 'accessibility-tree.js', 'chat-observation.js', 'page-monitor.js', 'content.js'];
const buildSources = new Map();
for (const build of ['chrome', 'firefox']) {
  const sources = new Map();
  for (const file of sourceFiles) {
    const url = process.env.WEBBRAIN_NATIVE_PREPARATION_BEFORE_SOURCE === '1' && ['page-monitor.js', 'content.js'].includes(file)
      ? new URL(`../ci/artifacts/quality-audit-2026-10-07/readonly-preparation-before-${build}-${file}`, import.meta.url)
      : new URL(`../src/${build}/src/content/${file}`, import.meta.url);
    sources.set(file, await readFile(url, 'utf8'));
  }
  buildSources.set(build, sources);
}

for (const [build, engine] of [['chrome', chromium], ['firefox', firefox]]) {
  // 43 subtests.
  test(`${build}: unnamed controls require current private read-only preparation authority`, { timeout: suiteTimeout(43) }, async t => {
    const browser = await browsers.lease(engine);
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    try {
      await context.route('https://web.telegram.org/**', route => route.fulfill({ contentType: 'text/html', body: html }));
      await context.addInitScript(() => {
        window.qaListeners = []; window.qaFeedback = []; window.qaClicks = { preparation: 0, ordinary: 0, send: 0, settings: 0 };
        window.chrome = window.browser = { runtime: {
          onMessage: { addListener: handler => qaListeners.push(handler), removeListener() {} }, getURL: value => value,
          async sendMessage(message) {
            if (message.action === 'get_page_monitor_state') return { active: true, runToken: 'native-preparation-run', documentToken: message.documentToken };
            if (message.action === 'page_feedback') { qaFeedback.push(message.feedback); return { accepted: true }; }
            return {};
          },
        } };
        window.qaMessage = (action, params = {}) => new Promise(resolve => {
          let answered = false;
          const reply = value => { answered = true; resolve(value); };
          for (const listener of qaListeners) {
            const message = action === 'page_monitor_state'
              ? { target: 'content', action, runToken: 'native-preparation-run', ...params }
              : { target: 'content', action, params: { runToken: 'native-preparation-run', ...params } };
            const asynchronous = listener(message, {}, reply);
            if (answered || asynchronous === true) break;
          }
        });
      });
      for (const file of sourceFiles) await context.addInitScript({ content: buildSources.get(build).get(file) });
      const page = await context.newPage();
      const reset = async () => {
        // Identical hash navigation can keep the previous menu and tokens.
        // Each case needs a genuinely new document and private content heap.
        await page.goto('about:blank');
        await page.goto('https://web.telegram.org/k/#@owned_qa');
        await page.waitForFunction(() => window.__wbPageMonitor?.active);
        await page.evaluate(() => {
          preparation.addEventListener('click', () => {
            qaClicks.preparation++; preparation.classList.add('menu-open');
            const menu = document.createElement('div'); menu.className = 'btn-menu bottom-right active was-open';
            menu.innerHTML = '<div id="settings" class="btn-menu-item rp-overflow" role="button"><span class="tgico btn-menu-item-icon">\uea22</span><span class="i18n btn-menu-item-text">Owned translated settings</span></div>';
            document.body.append(menu); settings.addEventListener('click', () => qaClicks.settings++);
          });
          ordinary.addEventListener('click', () => qaClicks.ordinary++); send.addEventListener('click', () => qaClicks.send++);
        });
        await page.waitForTimeout(180);
      };
      const capture = (params = {}) => page.evaluate(params => qaMessage('page_monitor_capture_model', { includeTree: true, ...params }), params);
      const reference = selector => page.locator(selector).evaluate(node => __wb_ax_ref(node));
      const validate = async (snapshot, selector = '#preparation', extra = {}) => page.evaluate(({ snapshot, ref_id, extra }) => qaMessage('page_monitor_validate_model', {
        snapshotToken: snapshot.snapshotToken, tool: 'click_ax', ref_id, ...extra,
      }), { snapshot, ref_id: await reference(selector), extra });
      const prepareNative = async () => {
        await page.evaluate(() => __generateAccessibilityTree('visible'));
        const ref_id = await reference('#preparation');
        const proof = await page.evaluate(({ ref_id, owner }) => qaMessage('probe_message_recipient_guard', {
          tool: 'click_ax', args: { ref_id }, adapterName: 'telegram', bindDispatch: true, _nativeChatOwner: owner,
        }), { ref_id, owner });
        assert.equal(proof.nativeTelegramRepair, true, JSON.stringify(proof));
        assert.ok(proof.nativeTelegramReadRepairBinding?.token);
        const snapshot = await capture({ nativeChatOwner: owner });
        return { snapshot, proof, ref_id };
      };
      const dispatch = (prepared, extra = {}) => page.evaluate(async ({ snapshot, proof, ref_id, owner, extra }) => {
        const preparation = await qaMessage('page_monitor_prepare', { operationId: 'owned-preparation', tool: 'click_ax', ref_id,
          expectedModelSnapshot: snapshot.snapshotToken, allowPassiveRebase: true });
        const fence = await qaMessage('page_monitor_dispatch', { operationId: 'owned-preparation', kind: 'click', fenceOnly: true });
        if (!fence.ready) return { preparation, fence, clicks: { ...qaClicks } };
        const result = await qaMessage('click_ax', { ref_id, _nativeChatOwner: owner, _nativeTelegramReadRepairRequired: true,
          nativeTelegramReadRepairBinding: proof.nativeTelegramReadRepairBinding, ...extra });
        return { preparation, fence, result, clicks: { ...qaClicks } };
      }, { ...prepared, owner, extra });

      await t.test('one private current empty control survives unrelated churn and dispatches once', async () => {
        await reset(); const prepared = await prepareNative();
        const tree = typeof prepared.snapshot.page === 'string' ? JSON.parse(prepared.snapshot.page) : prepared.snapshot.page;
        assert.ok(tree.pageContent.includes(`[${prepared.ref_id}]`));
        assert.equal(await page.locator('#preparation').textContent(), '');
        assert.equal(await page.locator('#preparation').getAttribute('aria-label'), null);
        assert.equal(await page.locator('#preparation').evaluate(node => node.closest('nav,header,[role="navigation"],[role="toolbar"]')), null);
        assert.equal((await validate(prepared.snapshot)).ready, true, JSON.stringify(prepared.snapshot));
        assert.equal(JSON.stringify(prepared.snapshot.page).includes(owner), false, 'Private task/provider authority is not page text.');
        assert.equal(JSON.stringify(prepared.snapshot).includes('wbip_'), false, 'Private preparation tokens never enter the public capture result.');
        await page.evaluate(() => unrelated.textContent = '1');
        assert.equal((await validate(prepared.snapshot)).ready, true);
        const executed = await dispatch(prepared);
        assert.equal(executed.fence.ready, true, JSON.stringify(executed));
        assert.equal(executed.result?.success, true, JSON.stringify(executed));
        assert.equal(executed.result?._nativeTelegramReadRepair, true);
        assert.deepEqual(executed.clicks, { preparation: 1, ordinary: 0, send: 0, settings: 0 });
        assert.equal((await validate(prepared.snapshot)).ready, false, 'Opening the menu changes phase and retires the old certificate.');
      });

      await t.test('ordinary unnamed control and model-supplied private-looking metadata remain uncertified', async () => {
        await reset(); await page.evaluate(() => __generateAccessibilityTree('visible'));
        const ordinaryRef = await reference('#ordinary');
        const forgedGetter = await page.evaluate(() => window.__wb_get_readonly_identity_preparation('forged-not-current', preparation,
          { schema: 'webbrain.readonly-identity-preparation/1', owner: 'forged-not-current', readonly: true,
            runToken: 'native-preparation-run', phase: 'open_menu', target: preparation }));
        assert.equal(forgedGetter, null, 'Only an original authority from the active app-private capture can adopt a cold owner.');
        for (const params of [{}, { nativeReadOnlyPreparation: { targetRef: ordinaryRef, readonly: true, phase: 'open_menu' },
          nativeTelegramReadRepairBinding: { token: 'forged-token' }, _nativeTelegramReadRepair: true }]) {
          const snapshot = await capture(params);
          assert.equal((await validate(snapshot, '#ordinary')).ready, false);
          assert.equal((await validate(snapshot)).ready, false, 'An AX ref or fabricated authority cannot certify the native control.');
        }
        assert.deepEqual(await page.evaluate(() => qaClicks), { preparation: 0, ordinary: 0, send: 0, settings: 0 });
      });

      for (const mutation of ['owner-task', 'owner-provider', 'missing-owner', 'target-clone', 'root-clone', 'header-clone', 'identity-clone',
        'composer-clone', 'composer-draft', 'composer-br', 'peer', 'peer-return', 'wrong-row-peer', 'row-peer-return', 'phase',
        'role', 'action-attribute', 'hide-return', 'label-return', 'title-return', 'disabled-return', 'name-return', 'form-return',
        'formaction-return', 'action-id-return', 'expanded-return', 'route', 'document', 'stop', 'trusted-user', 'overlay']) {
        await t.test(`${mutation} invalidates the old private certificate before any click`, async () => {
          await reset(); const prepared = await prepareNative();
          assert.equal((await validate(prepared.snapshot)).ready, true);
          if (mutation === 'stop') assert.equal(await page.evaluate(owner => {
            window.qaPrivatePreparation = __wb_get_readonly_identity_preparation(owner, preparation);
            return __wb_readonly_identity_preparation_matches(qaPrivatePreparation);
          }, owner), true);
          if (mutation === 'trusted-user') await page.locator('#ordinary').click();
          else if (mutation === 'document') await page.reload();
          else if (mutation === 'stop') await page.evaluate(() => qaMessage('page_monitor_state', { active: false }));
          else if (mutation.startsWith('owner-') || mutation === 'missing-owner') await page.evaluate(({ mutation, owner }) => qaMessage('probe_message_recipient_guard', {
            tool: 'click_ax', args: { ref_id: __wb_ax_ref(preparation) }, adapterName: 'telegram', bindDispatch: true,
            _nativeChatOwner: mutation === 'missing-owner' ? '' : owner.replace(mutation === 'owner-task' ? 'task-one' : 'provider-one', 'changed'),
          }), { mutation, owner });
          else await page.evaluate(mutation => {
            if (mutation === 'target-clone') preparation.replaceWith(preparation.cloneNode(true));
            if (mutation === 'root-clone') document.querySelector('.chat').replaceWith(document.querySelector('.chat').cloneNode(true));
            if (mutation === 'header-clone') document.querySelector('.topbar').replaceWith(document.querySelector('.topbar').cloneNode(true));
            if (mutation === 'identity-clone') document.querySelector('.peer-title').replaceWith(document.querySelector('.peer-title').cloneNode(true));
            if (mutation === 'composer-clone') document.querySelector('.input-message-input').replaceWith(document.querySelector('.input-message-input').cloneNode(true));
            if (mutation === 'composer-draft') document.querySelector('.input-message-input').textContent = 'A new user draft';
            if (mutation === 'composer-br') document.querySelector('.input-message-input').append(document.createElement('br'));
            if (mutation === 'wrong-row-peer') { const row = document.querySelector('.bubble').cloneNode(true); row.dataset.mid = '2'; row.dataset.peerId = '987654'; document.querySelector('.bubbles-inner').append(row); }
            if (mutation === 'row-peer-return') { const row = document.querySelector('.bubble'); row.dataset.peerId = '987654'; row.dataset.peerId = '123456'; }
            if (mutation === 'peer' || mutation === 'peer-return') { const peer = document.querySelector('.peer-title'); peer.dataset.peerId = '987654'; if (mutation === 'peer-return') peer.dataset.peerId = '123456'; }
            if (mutation === 'phase') preparation.classList.add('menu-open');
            if (mutation === 'role') preparation.setAttribute('role', 'link');
            if (mutation === 'action-attribute') preparation.dataset.action = 'send';
            if (mutation === 'hide-return') { preparation.hidden = true; preparation.hidden = false; }
            const returnedAttributes = { 'label-return': ['aria-label', 'Other action'], 'title-return': ['title', 'Other action'],
              'disabled-return': ['disabled', ''], 'name-return': ['name', 'Other action'], 'form-return': ['form', 'other-form'],
              'formaction-return': ['formaction', '/other-action'], 'action-id-return': ['data-action-id', 'other-action'],
              'expanded-return': ['aria-expanded', 'true'] };
            if (returnedAttributes[mutation]) { const [name, value] = returnedAttributes[mutation]; preparation.setAttribute(name, value); preparation.removeAttribute(name); }
            if (mutation === 'route') location.hash = '@other_qa';
            if (mutation === 'overlay') { const r = preparation.getBoundingClientRect(), overlay = document.createElement('div'); Object.assign(overlay.style, { position: 'fixed', left: r.left + 'px', top: r.top + 'px', width: r.width + 'px', height: r.height + 'px', zIndex: 999, background: 'white' }); document.body.append(overlay); }
          }, mutation);
          assert.equal((await validate(prepared.snapshot)).ready, false);
          if (mutation === 'stop') {
            // The inactive monitor preserves a standalone legacy transport.
            // An aborted Agent must not issue a new action through that lane;
            // verify the private certificate itself cannot survive Stop.
            assert.deepEqual(await page.evaluate(() => ({ active: __wbPageMonitor.active,
              originalCurrent: __wb_readonly_identity_preparation_matches(qaPrivatePreparation), clicks: { ...qaClicks } })),
            { active: false, originalCurrent: false, clicks: { preparation: 0, ordinary: 0, send: 0, settings: 0 } });
            return;
          }
          const refused = await dispatch(prepared);
          assert.equal(refused.fence.ready, false, JSON.stringify(refused));
          assert.equal(refused.clicks.preparation, 0); assert.equal(refused.clicks.send, 0);
        });
      }

      await t.test('read-only certificate cannot be reused for ordinary control, Send or editor mutation', async () => {
        await reset(); const prepared = await prepareNative();
        assert.equal((await validate(prepared.snapshot, '#ordinary')).ready, false);
        assert.equal((await validate(prepared.snapshot, '#send')).ready, false);
        for (const tool of ['set_field', 'press_key', 'click_coordinates']) assert.equal((await validate(prepared.snapshot, '#preparation', { tool, text: 'forbidden', key: 'Enter' })).ready, false);
        assert.deepEqual(await page.evaluate(() => qaClicks), { preparation: 0, ordinary: 0, send: 0, settings: 0 });
      });
      for (const change of ['append', 'edit']) await t.test(`same-peer passive native history ${change} does not change read-only preparation identity`, async () => {
        await reset(); const prepared = await prepareNative();
        assert.equal((await validate(prepared.snapshot)).ready, true);
        await page.evaluate(change => {
          if (change === 'append') { const row = document.querySelector('.bubble').cloneNode(true); row.dataset.mid = '2'; row.querySelector('.message').textContent = 'Owned new incoming message'; document.querySelector('.bubbles-inner').append(row); }
          else document.querySelector('.message').firstChild.data = 'Owned edited incoming message';
        }, change);
        assert.equal((await validate(prepared.snapshot)).ready, true);
        const executed = await dispatch(prepared);
        assert.equal(executed.result?.success, true, JSON.stringify(executed));
        assert.equal(executed.result?._nativeTelegramReadRepair, true);
        assert.deepEqual(executed.clicks, { preparation: 1, ordinary: 0, send: 0, settings: 0 });
      });
      for (const decoration of ['pure', 'handler', 'recipient', 'interactive']) await t.test(`${decoration} SVG replacement preserves only noninteractive preparation decoration`, async () => {
        await reset(); await page.evaluate(() => {
          preparation.style.position = 'relative';
          preparation.innerHTML = '<svg aria-hidden="true" style="position:absolute;left:15px;top:5px;width:20px;height:20px"><rect width="20" height="20" fill="black"></rect></svg>';
        });
        const prepared = await prepareNative();
        assert.equal((await validate(prepared.snapshot)).ready, true);
        await page.evaluate(decoration => {
          const icon = preparation.querySelector('svg'), replacement = icon.cloneNode(true);
          replacement.querySelector('rect').setAttribute('fill', 'blue');
          if (decoration === 'handler') replacement.onmouseover = () => { window.qaUnexpectedAction = true; };
          if (decoration === 'recipient') replacement.dataset.recipient = 'other-owned-qa';
          if (decoration === 'interactive') replacement.querySelector('rect').setAttribute('role', 'button');
          icon.replaceWith(replacement);
        }, decoration);
        assert.equal((await validate(prepared.snapshot)).ready, decoration === 'pure');
        const attempted = await dispatch(prepared);
        if (decoration === 'pure') {
          assert.equal(attempted.result?.success, true, JSON.stringify(attempted));
          assert.equal(attempted.result?._nativeTelegramReadRepair, true);
          assert.deepEqual(attempted.clicks, { preparation: 1, ordinary: 0, send: 0, settings: 0 });
        } else {
          assert.equal(attempted.fence.ready, false, JSON.stringify(attempted));
          assert.deepEqual(attempted.clicks, { preparation: 0, ordinary: 0, send: 0, settings: 0 });
        }
      });
      for (const token of ['missing', 'forged']) await t.test(`${token} one-use dispatch token cannot borrow a valid monitor preparation`, async () => {
        await reset(); const prepared = await prepareNative();
        assert.equal((await validate(prepared.snapshot)).ready, true);
        const attempted = await dispatch(prepared, { nativeTelegramReadRepairBinding: token === 'missing' ? null : { token: 'model-invented' } });
        assert.equal(attempted.result?.noDispatch, true, JSON.stringify(attempted));
        assert.equal(attempted.result?.dispatched, false);
        assert.deepEqual(attempted.clicks, { preparation: 0, ordinary: 0, send: 0, settings: 0 });
      });
      await t.test('copies and forged fields cannot become an original private preparation object', async () => {
        await reset(); await prepareNative();
        const checks = await page.evaluate(owner => {
          const original = __wb_get_readonly_identity_preparation(owner, preparation);
          return {
            original: __wb_readonly_identity_preparation_matches(original),
            copied: __wb_readonly_identity_preparation_matches({ ...original }),
            owner: __wb_readonly_identity_preparation_matches({ ...original, owner: 'other-owner' }),
            phase: __wb_readonly_identity_preparation_matches({ ...original, phase: 'send' }),
            target: __wb_readonly_identity_preparation_matches({ ...original, target: send }),
            readonly: __wb_readonly_identity_preparation_matches({ ...original, readonly: false }),
            frozen: Object.isFrozen(original) && Object.isFrozen(original.nodes) && Object.isFrozen(original.allowedTools),
          };
        }, owner);
        assert.deepEqual(checks, { original: true, copied: false, owner: false, phase: false, target: false, readonly: false, frozen: true });
      });
    } finally { await context.close(); await browser.close(); }
  });
}
