import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { chromium, firefox } from 'playwright';
import { Agent as ChromeAgent } from '../src/chrome/src/agent/agent.js';
import { Agent as FirefoxAgent } from '../src/firefox/src/agent/agent.js';
import { stubPageTextReadings } from './semantic-decision-stub.mjs';

// The native composer has a generic placeholder, not a recipient-valued label.
// Only the exact native contact-name carrier is a read-only repair control.
// All page data, contacts, phone numbers and network belong to this fixture.
const html = `<!doctype html><style>body{margin:0;font:16px sans-serif}aside{position:absolute;width:260px}#main{position:absolute;left:280px;width:950px;height:780px}header{height:70px}[role=button],button{padding:8px}[data-testid=conversation-panel-messages]{height:600px}[contenteditable]{min-height:32px;width:600px}[data-testid=chat-info-drawer]{position:fixed;right:0;top:0;width:260px;background:white}</style>
<aside data-testid="chat-list"><div role="row"><div aria-selected="true"><span data-testid="cell-frame-title">Owned Contact</span></div></div></aside>
<div id="main" data-testid="conversation-panel-wrapper"><header data-testid="conversation-header"><div id="outer"><div id="carrier" role="button" tabindex="0" data-testid="conversation-info-header"><div><div><div><div><div><div data-testid="conversation-info-header-chat-title-name"><span data-testid="conversation-info-header-chat-title">Owned Contact</span></div></div></div></div></div></div></div><div id="avatar" role="button">Avatar</div></div><div><button id="call" type="button">Call</button><button id="search" type="button">Search</button><button id="menu" type="button">Menu</button></div></header>
<div data-testid="conversation-panel-messages"><div role="row"><div data-id="owned-incoming" data-testid="conv-msg-owned-incoming"><div data-testid="msg-container"><div data-pre-plain-text="[12:00, 08/10/2026] Owned Contact: "><span data-testid="selectable-text">Owned question</span></div><span data-icon="tail-in">◁</span></div></div></div></div>
<footer><div id="composer" contenteditable="true" role="textbox" data-testid="conversation-compose-box-input" aria-placeholder="Type a message"></div><button id="send" type="button" aria-label="Send">Send</button></footer></div>`;

for (const [build, engine, Agent] of [['chrome', chromium, ChromeAgent], ['firefox', firefox, FirefoxAgent]]) {
  test(`${build}: native WhatsApp contact verification and phone sends`, async t => {
    const browser = await engine.launch({ headless: true });
    try {
      const sources = await Promise.all(['rich-text-toolbar-heuristic.js','accessibility-tree.js','whatsapp-phone.js','chat-observation.js','content.js']
        .map(file => readFile(file === 'chat-observation.js' && process.env.WEBBRAIN_NATIVE_BOOTSTRAP_READER
          ? process.env.WEBBRAIN_NATIVE_BOOTSTRAP_READER
          : new URL(`../src/${build}/src/content/${file}`, import.meta.url), 'utf8')));
      const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
      await page.route('**/*', route => route.fulfill({ contentType: 'text/html', body: html }));
      const call = (action, params = {}) => page.evaluate(message => new Promise(resolve => {
        for (const listener of qaHandlers) listener(message, {}, resolve);
      }), { target: 'content', action, params });
      async function prepare(kind = '', recipient = 'Owned Contact') {
        await page.goto(kind === 'new-phone' ? 'https://web.whatsapp.com/send?phone=905550000001' : 'https://web.whatsapp.com/');
        await page.evaluate(kind => {
          window.qaHandlers = []; window.qaOpened = 0; window.qaSent = 0;
          const runtime = { getURL: value => value, onMessage: { addListener: listener => qaHandlers.push(listener) } };
          window.chrome = window.browser = { runtime };
          document.querySelector('#carrier').onclick = () => {
            qaOpened++;
            const drawer = document.createElement('div'); drawer.dataset.testid = 'chat-info-drawer';
            drawer.innerHTML = '<header><button type="button" aria-label="Close">Close</button></header><div data-testid="contact-info-header">Contact info</div><span data-testid="contact-info-subtitle selectable-text">Owned Contact</span><span data-testid="selectable-text">+90 555 000 00 01</span>';
            drawer.querySelector('[data-testid="contact-info-subtitle selectable-text"]').textContent =
              document.querySelector('[data-testid="conversation-info-header-chat-title"]').textContent;
            if (kind === 'new-phone') {
              drawer.querySelector('[data-testid="contact-info-subtitle selectable-text"]').remove();
              const number = drawer.querySelector('[data-testid="selectable-text"]');
              number.dataset.testid = 'phone-number'; number.textContent = '905550000001';
            }
            drawer.querySelector('button').onclick = () => drawer.remove(); document.body.append(drawer);
          };
          document.querySelector('#send').onclick = () => qaSent++;
          if (kind === 'named-label') document.querySelector('#composer').setAttribute('aria-label','Type a message to Owned Contact');
          if (kind === 'wrong-row') document.querySelector('[data-testid="cell-frame-title"]').textContent = 'Another contact';
          if (kind === 'no-row') document.querySelector('[aria-selected]').removeAttribute('aria-selected');
          if (kind === 'new-phone') {
            document.querySelector('[data-testid="conversation-panel-messages"]').innerHTML =
              '<div role="row" data-id="notice"><span data-testid="notification-e2e">Security notice</span></div>';
            document.querySelector('aside').replaceChildren();
            document.querySelector('[data-testid="conversation-info-header-chat-title"]').textContent = '+90 555 000 00 01';
          }
          if (kind === 'duplicate-composer') document.querySelector('footer').append(document.querySelector('#composer').cloneNode(true));
          if (kind === 'outside-main') document.body.append(document.querySelector('#composer'));
          if (kind === 'focused-search' || kind === 'focused-editor') {
            const other = document.createElement(kind === 'focused-search' ? 'input' : 'textarea');
            other.id = 'other-editor'; document.querySelector('aside').append(other); other.focus();
          }
          if (kind === 'outer-sibling-control') { const button = document.createElement('button'); button.textContent = 'Delete'; document.querySelector('#outer').append(button); }
          if (kind === 'outer-form') { const form = document.createElement('form'), carrier = document.querySelector('#carrier'); document.querySelector('#outer').replaceWith(form); form.append(carrier); form.id = 'outer'; form.setAttribute('role','button'); }
        }, kind);
        for (const source of sources) await page.addScriptTag({ content: source });
        const provider = { model: 'owned-model', config: { model: 'owned-model' }, supportsVision: false };
        const agent = new Agent({ getActive: () => provider });
        const tabId = 91;
        agent.conversations.set(tabId, [{ role: 'system', content: 'Owned fixture system context.' },
          { role: 'user', content: 'Send one WhatsApp message to ' + recipient, webbrainResumeTaskId: 'owned-resume-task' }]);
        agent._beginCompletionInvariant(tabId);
        agent._planExecutionGuards.set(tabId, { messaging: { target_kind: 'named', recipients: [recipient] }, requiresSubmission: true, requiresStateChange: true });
        agent._currentUrl = async () => page.url();
        agent._sendDevContentAction = (_, action, params) => call(action, params);
        if (build === 'firefox') globalThis.browser = { tabs: { sendMessage: (_, message) => call(message.action, message.params) } };
        assert.ok(agent._nativeChatOwnerScope(tabId), 'The real Agent must issue a current private native owner.');
        const observe = async () => call('observe_chat', await agent._chatObservationParams(tabId));
        const readRef = async selector => {
          await call('get_accessibility_tree', { filter: 'all' });
          return page.locator(selector).evaluate(node => __wb_ax_ref(node));
        };
        const guarded = async selector => {
          const ref_id = await readRef(selector), context = {};
          const block = await agent._messageRecipientGuardBlock(tabId, 'click_ax', { ref_id }, page.url(), context);
          return { block, context, ref_id };
        };
        return { agent, tabId, observe, guarded, readRef };
      }
      async function confirmPhone(f) {
        stubPageTextReadings(f.agent);
        for (const selector of ['#carrier', '[data-testid="chat-info-drawer"] header button']) {
          const step = await f.guarded(selector);
          assert.equal(step.block, null, JSON.stringify(step.block));
          const clicked = await call('click_ax', { ref_id: step.ref_id, _nativeChatOwner: step.context.nativeWhatsappReadRepairOwner });
          assert.equal(clicked.success, true, JSON.stringify(clicked));
          if (selector === '#carrier') await page.waitForFunction(owner => __wb_native_chat_read_target(owner)?.phase === 'close_contact',
            f.agent._nativeChatOwnerScope(f.tabId), { timeout: 2000 });
        }
        return f;
      }
      for (const [kind, recipient, tool] of [
        ['saved-phone', '+905550000001', 'click_ax'],
        ['new-phone', '00 90 (555) 000-00-01', 'click_ax'],
        ['new-phone', '+905550000001', 'press_keys'],
      ]) {
        await t.test(kind + ' sends once by number with ' + tool + ' and verifies delivery', async () => {
          const f = await confirmPhone(await prepare(kind, recipient));
          const before = await f.agent._readChatObservation(f.tabId);
          assert.equal(before.success, true, JSON.stringify(before));
          const body = 'Merhaba, numara ile ilk mesaj.';
          await page.locator('#composer').fill(body);
          await page.evaluate(tool => {
            const transcript = document.querySelector('[data-testid="conversation-panel-messages"]');
            const appendMessage = () => {
              const row = document.createElement('div'); row.setAttribute('role', 'row');
              row.innerHTML = '<div data-id="owned-out" data-testid="conv-msg-owned-out"><div data-testid="msg-container"><span data-testid="selectable-text"></span><span data-icon="tail-out">↗</span><span data-testid="msg-meta"><span aria-label="Delivered">✓✓</span></span></div></div>';
              row.querySelector('[data-testid="selectable-text"]').textContent = composer.textContent;
              if (tool === 'press_keys') {
                row.querySelector('[aria-label]').outerHTML = '<span aria-label="Pending" data-icon="msg-time">◷</span>';
              }
              transcript.append(row); composer.replaceChildren();
              if (!document.querySelector('aside [role=row]')) {
                document.querySelector('aside').innerHTML = '<div role="row"><div aria-selected="true"><span data-testid="cell-frame-title">+90 555 000 00 01</span></div></div>';
              }
            };
            send.onclick = event => { event.stopPropagation(); qaSent++; appendMessage(); };
            composer.onkeydown = event => {
              if (event.key !== 'Enter') return;
              event.preventDefault(); qaSent++; setTimeout(appendMessage, 0);
            };
          }, tool);
          const args = tool === 'press_keys' ? { key: 'Enter' } : { ref_id: await f.readRef('#send') };
          const context = {};
          const block = await f.agent._messageRecipientGuardBlock(f.tabId, tool, args, page.url(), context);
          assert.equal(block, null, JSON.stringify(block));
          const baseline = context.messageRecipientNativeChatBaseline;
          f.agent._persistNow = async () => true;
          const prepareSend = () => f.agent._prepareGenericChatDispatch(f.tabId, tool, args, context);
          const blocked = await prepareSend();
          assert.equal(blocked, null, JSON.stringify(blocked));
          const pending = f.agent.chatSessions.get(f.tabId);
          assert.equal(pending.pendingOutbound?.text, body);
          assert.equal((await prepareSend())?.reason, 'send_pending');
          const sent = await call(tool, { ...args, ...context, _nativeChatOwner: f.agent._nativeChatOwnerScope(f.tabId) });
          assert.equal(sent.success, true, JSON.stringify(sent));
          assert.equal(await page.evaluate(() => qaSent), 1);
          if (tool === 'press_keys') {
            const status = page.locator('[data-icon="msg-time"]');
            await status.waitFor();
            assert.equal((await f.agent._readChatObservation(f.tabId)).nativeChatDeliveryProof, undefined);
            await status.evaluate(node => { node.dataset.icon = 'msg-dblcheck'; node.setAttribute('aria-label', 'Delivered'); });
          }
          const after = await f.agent._readChatObservation(f.tabId);
          assert.equal(after.conversationId, before.conversationId, JSON.stringify(after));
          const { advanceChatSession } = await import('../src/' + build + '/src/agent/chat-workflow.js');
          const reconciled = advanceChatSession(pending, after);
          assert.equal(reconciled.pendingDeliveryVerified, true);
          assert.equal(reconciled.session.pendingOutbound, null);
          assert.equal(f.agent._nativeWhatsappDeliveryProof(after, { ...baseline, body })?.messageId,
            before.conversationId + ':owned-out', JSON.stringify(after));
          if (kind === 'new-phone') {
            assert.deepEqual(baseline.messageIds, []);
            const unrelated = { ...after, nativeChatDeliveryProof: { ...after.nativeChatDeliveryProof, emptyTranscriptId: undefined } };
            assert.ok(advanceChatSession(pending, unrelated).session.pendingOutbound);
            assert.equal(f.agent._nativeWhatsappDeliveryProof(unrelated, { ...baseline, body }), null);
            await page.evaluate(() => {
              const row = document.querySelector('[data-id="owned-out"]').parentElement;
              row.replaceWith(row.cloneNode(true));
            });
            assert.equal((await f.agent._readChatObservation(f.tabId)).nativeChatDeliveryProof, undefined, 'a remounted bubble is not the witnessed first send');
          }
        });
      }
      await t.test('empty chat mutations read layout once per batch and unrelated updates do not scan the chat list', async () => {
        const f = await confirmPhone(await prepare('new-phone', '+905550000001'));
        await page.locator('#composer').fill('A first message');
        const { context, ref_id, block } = await f.guarded('#send');
        assert.equal(block, null);
        f.agent._persistNow = async () => true;
        assert.equal(await f.agent._prepareGenericChatDispatch(f.tabId, 'click_ax', { ref_id }, context), null);
        const measurements = await page.evaluate(async () => {
          const transcript = document.querySelector('[data-testid="conversation-panel-messages"]');
          const counts = { scrollHeight: 0, clientHeight: 0 };
          for (const key of Object.keys(counts)) {
            const getter = Object.getOwnPropertyDescriptor(Element.prototype, key).get;
            Object.defineProperty(transcript, key, { get() { counts[key]++; return getter.call(this); } });
          }
          const notice = transcript.querySelector('[data-testid="notification-e2e"]');
          for (let i = 0; i < 20; i++) notice.textContent = 'Notice ' + i;
          await new Promise(resolve => setTimeout(resolve, 0));
          return counts;
        });
        assert.deepEqual(measurements, { scrollHeight: 1, clientHeight: 1 });
        const sent = await call('click_ax', { ref_id, ...context, _nativeChatOwner: f.agent._nativeChatOwnerScope(f.tabId) });
        assert.equal(sent.success, true);
        const scans = await page.evaluate(async () => {
          const list = document.querySelector('[data-testid="chat-list"]');
          const queryAll = document.querySelectorAll.bind(document);
          let scans = 0;
          document.querySelectorAll = selector => {
            if (selector.includes('[data-testid="chat-list"]')) scans++;
            return queryAll(selector);
          };
          for (let i = 0; i < 4; i++) {
            list.append(document.createElement('div'));
            await new Promise(resolve => setTimeout(resolve, 0));
          }
          return scans;
        });
        assert.equal(scans, 0, 'a chat with no selected row should not rescan the list on every render');
      });
      await t.test('the default blocks an unseen recipient; disabling enforcement dispatches Send and Enter', async () => {
        const f = await prepare('new-phone', '+19995550001');
        f.agent.leanMode = 'on';
        f.agent.strictGuards = true;
        f.agent._beginLeanRun(f.tabId, 'act');
        await page.locator('#composer').fill('Test message');
        await page.evaluate(() => {
          composer.onkeydown = event => { if (event.key === 'Enter') { event.preventDefault(); qaSent++; } };
        });
        const sender = await f.readRef('#send');
        const tools = [['click_ax', { ref_id: sender }], ['press_keys', { key: 'Enter' }]];
        const bind = (tool, args, context) => f.agent._messageRecipientGuardBlock(f.tabId, tool, args, page.url(), context);
        for (const [tool, args] of tools) {
          assert.equal((await bind(tool, { ...args, enforceActionGuards: false }, {}))?.noDispatch, true);
        }
        f.agent.enforceActionGuards = false;
        assert.equal((await bind('click_ax', { ref_id: sender }, {}))?.noDispatch, true, 'a setting change does not release an in-flight action');
        for (const lean of ['off', 'on']) {
          f.agent.leanMode = lean;
          f.agent._beginLeanRun(f.tabId, 'act');
          for (const [tool, args] of tools) {
            await page.locator('#composer').focus();
            const context = {};
            assert.equal(await bind(tool, args, context), null);
            assert.equal(await f.agent._prepareGenericChatDispatch(f.tabId, tool, args, context), null);
            const sent = await call(tool, { ...args, ...context });
            assert.equal(sent.success, true, JSON.stringify(sent));
          }
        }
        assert.deepEqual(await page.evaluate(() => [qaSent, qaOpened]), [4, 0]);
        f.agent.enforceActionGuards = true;
        f.agent._beginLeanRun(f.tabId, 'act');
        assert.equal((await bind('press_keys', { key: 'Enter' }, {}))?.noDispatch, true);
      });
      await t.test('chat_send off uses the visible composer without a contact check or a pending-send veto', async () => {
        const f = await prepare('new-phone', '+19995550001');
        f.agent.enforceActionGuards = false;
        f.agent._beginLeanRun(f.tabId, 'act');
        stubPageTextReadings(f.agent);
        const before = await f.agent._observeChatWorkflow(f.tabId);
        assert.equal(before.success, true, JSON.stringify(before));
        const ref = before.composer.ref;
        assert.ok(ref);
        const body = 'An explicitly retried message';
        await page.evaluate(() => {
          composer.onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); qaSent++; composer.replaceChildren(); } };
        });
        // The extension's trusted text transport types into the returned
        // live editor. Observe the actual Enter on both browser engines.
        f.agent.executeTool = async (_tab, tool, args) => {
          assert.equal(tool, 'set_field'); assert.equal(args.ref_id, ref); assert.equal(args.submit, true);
          await page.locator('#composer').fill(args.text);
          await page.locator('#composer').press('Enter');
          return { success: true, submissionDispatched: true };
        };
        f.agent.chatSessions.set(f.tabId, { threadKey: 'another-thread', pendingOutbound: { text: body } });
        for (let i = 0; i < 2; i++) {
          const result = await f.agent._sendChatWorkflow(f.tabId, { text: body, composer_ref: ref, thread_key: before.threadKey });
          assert.equal(result.submissionDispatched, true, JSON.stringify(result));
          assert.equal(result.deliveryVerified, false);
        }
        f.agent.executeTool = async () => ({ success: true, verified: true, submitted: false, submissionDispatched: false });
        const unsent = await f.agent._sendChatWorkflow(f.tabId, { text: body, composer_ref: ref });
        assert.equal(unsent.success, false);
        assert.equal(unsent.reason, 'chat_submit_not_dispatched');
        assert.equal(unsent.deliveryVerified, false);
        assert.deepEqual(await page.evaluate(() => [qaSent, qaOpened]), [2, 0]);
      });
      await t.test('a local number asks for a country code even if the display name has the same digits', async () => {
        const f = await prepare('', '5551234567');
        assert.equal(f.agent._whatsappPhonePeer(f.agent._planExecutionGuards.get(f.tabId).messaging), '');
        const opening = await f.guarded('#carrier');
        assert.equal(opening.block, null);
        await page.locator('#composer').fill('Test');
        const attempt = await f.guarded('#send');
        assert.equal(attempt.block?.reasonCode, 'whatsapp_country_code_required', JSON.stringify(attempt.block));
        assert.equal(await page.evaluate(() => qaSent), 0);
      });
      await t.test('native proof survives a missing tab URL and an unavailable reader stays inconclusive', async t => {
        const f = await confirmPhone(await prepare('saved-phone', '+905550000001'));
        await page.locator('#composer').fill('Hello');
        f.agent._currentUrl = async () => { throw new Error('tab lookup unavailable'); };
        const api = build === 'chrome' ? 'chrome' : 'browser';
        const old = globalThis[api];
        t.after(() => { if (old) globalThis[api] = old; else delete globalThis[api]; });
        let mainFrameReads = 0;
        globalThis[api] = { ...old, tabs: { ...old?.tabs, sendMessage: (_tab, msg, options) => {
          if (msg.action === 'get_page_info') {
            assert.equal(options.frameId, 0);
            mainFrameReads++;
          }
          return call(msg.action, msg.params);
        } } };
        const args = { ref_id: await f.readRef('#send') };
        assert.equal(await f.agent._messageRecipientGuardBlock(f.tabId, 'click_ax', args, '', {}), null);
        assert.equal(mainFrameReads, 1);
        await page.evaluate(() => { delete window.__wb_get_native_whatsapp_message_baseline; });
        const attempt = await f.guarded('#send');
        assert.equal(attempt.block?.reasonCode, 'native_chat_baseline_unavailable', JSON.stringify(attempt.block));
      });
      await t.test('a native peer and its display alias match in either order and a second recipient is rejected', async () => {
        const f = await confirmPhone(await prepare('saved-phone', '+905550000001'));
        await page.locator('#composer').fill('Hello');
        const probe = f.agent._messageRecipientGuardProbe.bind(f.agent);
        const original = structuredClone(f.agent._planExecutionGuards.get(f.tabId).messaging);
        for (const [label, first, allowed, openChat] of [
          ['Owned Contact', true, true], ['Owned Contact', false, true], ['Other recipient', true, false],
          ['Owned Contact', true, true, true],
        ]) {
          f.agent._planExecutionGuards.get(f.tabId).messaging = openChat
            ? { target_kind: 'active_conversation', recipients: [] } : structuredClone(original);
          f.agent._messageRecipientGuardProbe = async (...args) => {
            const result = await probe(...args);
            const candidate = { identity: label, role: 'to' };
            const observed = result.strongRecipientCandidates;
            result.strongRecipientCandidates = first ? [candidate, ...observed] : [...observed, candidate];
            return result;
          };
          const { block } = await f.guarded('#send');
          if (allowed) assert.equal(block, null, JSON.stringify(block));
          else assert.equal(block?.noDispatch, true, JSON.stringify(block));
        }
      });
      await t.test('a phone-shaped display name cannot authorize a different drawer phone', async () => {
        const recipient = '+90 555 000 00 02';
        const f = await prepare('', recipient);
        await page.evaluate(name => {
          document.querySelector('[data-testid="conversation-info-header-chat-title"]').textContent = name;
          document.querySelector('[data-testid="cell-frame-title"]').textContent = name;
          composer.textContent = 'Private message';
        }, recipient);
        await confirmPhone(f);
        const attempt = await f.guarded('#send');
        assert.equal(attempt.block?.noDispatch, true);
        assert.equal(attempt.context.messageRecipientDispatchBinding, undefined);
        assert.equal(await page.evaluate(() => qaSent), 0);
      });
      for (const change of ['wrong selection', 'two selections', 'loading history', 'history appeared and disappeared']) {
        await t.test('new phone refuses the bound send after ' + change, async () => {
          const f = await confirmPhone(await prepare('new-phone', '+905550000001'));
          await page.locator('#composer').fill('Private first message');
          const action = await f.guarded('#send');
          assert.equal(action.block, null);
          await page.evaluate(change => {
            const transcript = document.querySelector('[data-testid="conversation-panel-messages"]');
            if (change === 'loading history') transcript.setAttribute('aria-busy', 'true');
            else if (change === 'history appeared and disappeared') {
              const old = document.createElement('div'); old.dataset.testid = 'msg-container';
              transcript.append(old); old.remove();
            } else {
              const row = document.createElement('div'); row.setAttribute('role', 'row');
              row.innerHTML = '<div aria-selected="true"><span data-testid="cell-frame-title"></span></div>';
              row.firstChild.firstChild.textContent = change === 'wrong selection' ? 'Another person' : '+90 555 000 00 01';
              document.querySelector('aside').append(row);
              if (change === 'two selections') document.querySelector('aside').append(row.cloneNode(true));
            }
          }, change);
          const result = await call('click_ax', { ref_id: action.ref_id, ...action.context, _nativeChatOwner: f.agent._nativeChatOwnerScope(f.tabId) });
          assert.equal(result.success, false, JSON.stringify(result));
          assert.equal(await page.evaluate(() => qaSent), 0);
        });
      }
      for (const [kind, target] of [['', '#carrier'], ['named-label', '#carrier']]) await t.test(`bootstrap ${kind || 'generic-placeholder'} ${target}`, async () => {
        const f = await prepare(kind);
        const first = await f.observe();
        assert.equal(first.success, false, 'Read-only observation must not open the drawer.');
        const opened = await f.guarded(target);
        assert.equal(opened.block, null, JSON.stringify(opened.block));
        assert.equal(first.nativeWhatsappRepair?.phase, 'open_contact', JSON.stringify(first));
        assert.equal(await page.evaluate(ref => __wb_ax_lookup(ref) === carrier, first.nativeWhatsappRepair.ref_id), true, 'The repair hint is the exact private native carrier, never the whole header.');
        assert.equal(opened.context.nativeWhatsappReadRepairOwner, f.agent._nativeChatOwnerScope(f.tabId));
        const click = await call('click_ax', { ref_id: opened.ref_id, _nativeChatOwner: opened.context.nativeWhatsappReadRepairOwner });
        assert.equal(click.success, true, JSON.stringify(click)); assert.equal(click._nativeWhatsappReadRepair, true);
        await page.waitForTimeout(30);
        const closed = await f.guarded('[data-testid="chat-info-drawer"] header button');
        assert.equal(closed.block, null, JSON.stringify(closed.block));
        assert.equal((await call('click_ax', { ref_id: closed.ref_id, _nativeChatOwner: closed.context.nativeWhatsappReadRepairOwner })).success, true);
        const observation = await f.observe(); assert.equal(observation.success, true, JSON.stringify(observation));
        assert.equal(observation.conversationId, 'whatsapp:phone:' + createHash('sha256').update('+905550000001').digest('hex').slice(0,32));
        assert.equal(JSON.stringify(observation).includes('905550000001'), false);
        assert.deepEqual(await page.evaluate(() => ({ opened: qaOpened, sent: qaSent, draft: composer.textContent })), { opened: 1, sent: 0, draft: '' });
      });
      for (const kind of ['wrong-row','no-row','duplicate-composer','outside-main','outer-sibling-control','outer-form']) await t.test(`refuse ${kind}`, async () => {
        const f = await prepare(kind); const first = await f.observe();
        if (['wrong-row','no-row','duplicate-composer','outside-main'].includes(kind)) assert.equal(first.nativeWhatsappRepair, undefined);
        const attempt = await f.guarded('#outer');
        assert.equal(attempt.block?.noDispatch, true, JSON.stringify(attempt.block));
        assert.deepEqual(await page.evaluate(() => ({ opened: qaOpened, sent: qaSent })), { opened: 0, sent: 0 });
      });
      for (const kind of ['focused-search','focused-editor']) await t.test(`focused ${kind} is not native repair observation`, async () => {
        const f = await prepare(kind); const first = await f.observe();
        assert.equal(first.success, false); assert.equal(first.nativeWhatsappRepair, undefined);
        assert.equal(await page.evaluate(() => document.activeElement.id), 'other-editor', 'Read-only repair must not focus another editor.');
        assert.equal(await page.evaluate(() => qaOpened + qaSent), 0);
      });
      await t.test('old hint cannot dispatch after Stop or a different document', async () => {
        let f = await prepare(); const initial = await f.observe();
        const args = { ref_id: initial.nativeWhatsappRepair.ref_id };
        await call('get_accessibility_tree', args);
        f.agent.abortFlags.set(f.tabId, true);
        let block = await f.agent._messageRecipientGuardBlock(f.tabId, 'click_ax', args, page.url(), {});
        assert.equal(block?.noDispatch, true); assert.equal(await page.evaluate(() => qaOpened), 0);
        f = await prepare(); await f.observe();
        block = await f.agent._messageRecipientGuardBlock(f.tabId, 'click_ax', args, page.url(), {});
        assert.equal(block?.noDispatch, true, 'A route/document-scoped old AX pointer cannot alias the new carrier.');
        assert.equal(await page.evaluate(() => qaOpened), 0);
      });
      await t.test('read repair never exempts a send, call or other header control', async () => {
        const f = await prepare(); await f.observe();
        for (const selector of ['#send','#call','#search','#menu','#avatar','#outer','[data-testid="conversation-header"]']) {
          const attempt = await f.guarded(selector); assert.equal(attempt.block?.noDispatch, true, JSON.stringify(attempt.block));
        }
        assert.equal(await page.evaluate(() => qaSent), 0);
      });
      for (const drift of ['header-clone','carrier-clone','selected-roundtrip','owner-change']) await t.test(`repair snapshot invalidated by ${drift}`, async () => {
        const f = await prepare('named-label'); await f.observe();
        const pins = await page.evaluate(() => { window.qaRepair = __wb_native_whatsapp_repair_snapshot(carrier); return !!qaRepair; });
        assert.equal(pins, true);
        const valid = await page.evaluate(drift => {
          if (drift === 'owner-change') __wb_update_native_chat_owner('another-private-owner');
          else if (drift === 'selected-roundtrip') { const selected = document.querySelector('[aria-selected]'); selected.setAttribute('aria-selected','false'); selected.setAttribute('aria-selected','true'); }
          else { const node = document.querySelector(drift === 'header-clone' ? '[data-testid="conversation-header"]' : '#carrier'); const clone = node.cloneNode(false); while (node.firstChild) clone.append(node.firstChild); node.replaceWith(clone); }
          return __wb_native_whatsapp_repair_matches(qaRepair);
        }, drift);
        assert.equal(valid, false, 'An identical native title cannot inherit prior header/node/task authority.');
      });
    } finally { await browser.close(); }
  });
}
