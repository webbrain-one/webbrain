import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { chromium, firefox } from 'playwright';
import { guardProbeWithReadings } from './semantic-decision-stub.mjs';

// From a trace: asked to send a downloaded video to a contact on WhatsApp,
// the agent could not get past the open chat. Every message action in a chat
// whose contact the run had not confirmed, and even a click on another chat's
// row, came back "re-read and retry", so the model clicked Attach and the
// chat row again until it gave up. The recipient probe now names the control
// that confirms the contact, lets a chat-list row open another chat, and in a
// request that names its recipient lets the contact check follow that
// selection until the check is armed. A request for the open chat itself
// keeps its check on that chat. The shapes follow native-whatsapp-contact.mjs;
// all contacts, phones and requests belong to this fixture.
const phones = { 'Fixture Mom': '+90 555 000 00 01', 'Fixture Dad': '+90 555 000 00 02' };
const row = (name, selected) => `<div role="row"><div role="gridcell"><div aria-selected="${selected}">`
  + `<span data-testid="cell-frame-title">${name}</span><span>5:04 PM</span></div></div>`
  + '<button type="button" aria-label="Chat menu">v</button></div>';
const html = `<!doctype html><style>body{margin:0;font:16px sans-serif}aside{position:absolute;width:280px;left:0;top:0}#main{position:absolute;left:300px;top:0;width:920px;height:790px}header{height:70px;display:flex;gap:12px}button,[role=button]{padding:8px;cursor:pointer}[role=row]{display:flex;gap:6px;padding:6px}[role=gridcell]{width:200px}[data-testid=conversation-panel-messages]{height:600px;overflow:auto}footer{display:flex;gap:20px}[contenteditable]{min-height:36px;width:600px;border:1px solid}[data-testid=chat-info-drawer]{position:fixed;right:0;top:0;width:260px;min-height:790px;background:white;z-index:3}</style>
<aside data-testid="chat-list">${row('Fixture Mom', true)}${row('Fixture Dad', false)}</aside>
<div id="main" data-testid="conversation-panel-wrapper"><header data-testid="conversation-header"><div role="button" tabindex="0" data-testid="conversation-info-header"><span data-testid="conversation-info-header-chat-title"><span data-testid="conversation-info-header-chat-title-name">Fixture Mom</span></span></div><button type="button" aria-label="Voice call">Call</button></header>
<div data-testid="conversation-panel-messages"></div><footer><button type="button" aria-label="Attach">Attach</button><div data-testid="conversation-compose-box-input" contenteditable="true" role="textbox" aria-label="Type a message"></div><button type="button" aria-label="Send">Send</button></footer></div>`;

const DAD_ROW = '[data-testid="chat-list"] [role="row"]:nth-child(2) [role="gridcell"]';
const DAD_MENU = '[data-testid="chat-list"] [role="row"]:nth-child(2) button';
const HEADER = '[data-testid="conversation-info-header"]';
const CLOSE = '[data-testid="chat-info-drawer"] header button';
const SEND = 'footer [aria-label="Send"]';
const ATTACH = 'footer [aria-label="Attach"]';
const phoneId = phone => 'whatsapp:phone:' + createHash('sha256').update(phone.replace(/[ ()-]/g, '')).digest('hex').slice(0, 32);

for (const [build, engine] of [['chrome', chromium], ['firefox', firefox]]) {
  async function fixture(run) {
    const browser = await engine.launch({ headless: true });
    try {
      const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
      await page.route('**/*', route => route.fulfill({ contentType: 'text/html', body: html }));
      await page.goto('https://web.whatsapp.com/');
      await page.evaluate(phones => {
        window.fixtureHandlers = [];
        const api = { runtime: { getURL: p => p, onMessage: { addListener: fn => fixtureHandlers.push(fn) } } };
        window.chrome = window.browser = api;
        // Selecting a chat moves the list's selection and renames the open
        // chat's header, as WhatsApp does; the composer stays mounted.
        window.fixtureSelect = name => {
          for (const node of document.querySelectorAll('[data-testid="chat-list"] [role="row"]')) {
            const title = node.querySelector('[data-testid="cell-frame-title"]').textContent;
            node.querySelector('[aria-selected]').setAttribute('aria-selected', String(title === name));
          }
          document.querySelector('[data-testid="conversation-info-header-chat-title-name"]').textContent = name;
        };
        for (const cell of document.querySelectorAll('[role="gridcell"]')) {
          cell.addEventListener('click', () => fixtureSelect(cell.querySelector('[data-testid="cell-frame-title"]').textContent));
        }
        window.fixtureMenuOpened = 0;
        for (const menu of document.querySelectorAll('[aria-label="Chat menu"]')) menu.onclick = () => { fixtureMenuOpened++; };
        document.querySelector('[data-testid="conversation-info-header"]').onclick = () => {
          const name = document.querySelector('[data-testid="conversation-info-header-chat-title-name"]').textContent;
          const drawer = document.createElement('div'); drawer.setAttribute('data-testid', 'chat-info-drawer');
          drawer.innerHTML = '<header><button type="button" aria-label="Close">Close</button></header>'
            + '<div data-testid="contact-info-header">Contact info</div><span data-testid="contact-info-subtitle selectable-text"></span>'
            + '<div><span data-testid="selectable-text"><span></span></span></div>';
          drawer.querySelector('[data-testid="contact-info-subtitle selectable-text"]').textContent = name;
          drawer.querySelector('[data-testid="selectable-text"] span').textContent = phones[name];
          drawer.querySelector('button').onclick = () => drawer.remove();
          document.body.append(drawer);
        };
        const message = document.createElement('div'); message.setAttribute('role', 'row');
        message.innerHTML = '<div data-id="opaque-initial-Z" data-testid="conv-msg-opaque-initial-Z"><div data-testid="msg-container">'
          + '<div data-pre-plain-text="[12:00, 08/10/2026] Fixture Mom: "><span data-testid="selectable-text">Incoming question one</span></div>'
          + '<span data-icon="tail-in">◁</span><span data-testid="msg-meta"></span></div></div>';
        document.querySelector('[data-testid="conversation-panel-messages"]').append(message);
      }, phones);
      for (const file of ['rich-text-toolbar-heuristic.js', 'accessibility-tree.js', 'whatsapp-phone.js', 'chat-observation.js', 'content.js']) {
        await page.addScriptTag({ content: await readFile(new URL(`../src/${build}/src/content/${file}`, import.meta.url), 'utf8') });
      }
      const owner = JSON.stringify(['owned-run-1', 'tk_aaaaaaaa', 1, 'owned-provider-1', 'owned-model', 'a'.repeat(64),
        'resume-task-owned-1', 'b'.repeat(64)]);
      const call = (action, params = {}) => page.evaluate(message => new Promise(resolve => {
        for (const handler of fixtureHandlers) handler(message, {}, resolve);
      }), { target: 'content', action, params });
      const observe = () => guardProbeWithReadings(params => call('observe_chat', params),
        { _nativeChatOwner: owner, _nativeChatPendingRestore: null, adapterName: 'generic-messaging' });
      const refOf = async selector => {
        await call('get_accessibility_tree', { filter: 'all' });
        return page.locator(selector).evaluate(node => __wb_ax_ref(node));
      };
      // The recipient probe as the agent runs it right before a click: a
      // request that names its recipient says so (namedRecipientSelection).
      // Without readings no model reads the page's texts, as when the
      // reading model is unavailable.
      const probe = async (selector, { named = false, readings = true } = {}) => {
        const params = {
          tool: 'click_ax', args: { ref_id: await refOf(selector) }, adapterName: 'generic-messaging', bindDispatch: true,
          _nativeChatOwner: owner,
          ...(named ? { expectedRecipients: [{ identity: 'Fixture Dad', role: 'to' }], namedRecipientSelection: true } : {}),
        };
        return readings ? guardProbeWithReadings(next => call('probe_message_recipient_guard', next), params)
          : call('probe_message_recipient_guard', params);
      };
      const click = async selector => call('click_ax', { ref_id: await refOf(selector), _nativeChatOwner: owner,
        _nativeChatPendingRestore: null });
      const confirmContact = async () => {
        assert.equal((await click(HEADER)).success, true);
        await page.locator('[data-testid="chat-info-drawer"]').waitFor(); await page.waitForTimeout(30);
        assert.equal((await click(CLOSE)).success, true);
        return observe();
      };
      await run({ page, observe, probe, click, refOf, confirmContact });
    } finally { await browser.close(); }
  }

  test(`${build}: a blocked message action names the contact-name control, then the panel's Close button`, async () => {
    await fixture(async ({ page, observe, probe, click, refOf }) => {
      await observe();
      const send = await probe(SEND);
      assert.equal(send.reasonCode, 'native_whatsapp_contact_binding_required', JSON.stringify(send));
      assert.deepEqual(send.nativeWhatsappRepairTarget, { phase: 'open_contact', ref_id: await refOf(HEADER) });
      assert.equal((await click(HEADER)).success, true);
      await page.locator('[data-testid="chat-info-drawer"]').waitFor(); await page.waitForTimeout(30);
      const attach = await probe(ATTACH);
      assert.equal(attach.reasonCode, 'native_whatsapp_contact_binding_required', JSON.stringify(attach));
      assert.deepEqual(attach.nativeWhatsappRepairTarget, { phase: 'close_contact', ref_id: await refOf(CLOSE) });
      assert.equal((await click(CLOSE)).success, true);
      const bound = await observe();
      assert.equal(bound.success, true, JSON.stringify(bound));
      assert.equal(bound.conversationId, phoneId(phones['Fixture Mom']));
      assert.notEqual((await probe(SEND)).reasonCode, 'native_whatsapp_contact_binding_required');
    });
  });

  test(`${build}: another chat's row opens it while the open chat is unconfirmed; the row's own menu stays guarded`, async () => {
    await fixture(async ({ page, observe, probe }) => {
      await observe();
      const row = await probe(DAD_ROW);
      assert.equal(row.conversationSelection, true, JSON.stringify(row));
      assert.equal(row.messageSend, false);
      assert.equal(row.conclusive, true);
      const menu = await probe(DAD_MENU);
      assert.notEqual(menu.conversationSelection, true, JSON.stringify(menu));
      assert.equal(menu.reasonCode, 'native_whatsapp_contact_binding_required', JSON.stringify(menu));
      assert.equal(await page.evaluate(() => fixtureMenuOpened), 0, 'a probe never clicks');
    });
  });

  test(`${build}: a request that names its recipient opens their chat and confirms that contact`, async () => {
    await fixture(async ({ page, observe, probe, click, refOf, confirmContact }) => {
      assert.equal((await observe()).reason, 'native_whatsapp_contact_binding_required');
      assert.equal((await probe(DAD_ROW, { named: true })).conversationSelection, true);
      assert.equal((await click(DAD_ROW)).success, true);
      assert.equal(await page.locator('[data-testid="conversation-info-header-chat-title-name"]').textContent(), 'Fixture Dad');
      const opened = await observe();
      assert.equal(opened.reason, 'native_whatsapp_contact_binding_required', JSON.stringify(opened));
      assert.notEqual(opened.retryable, false, 'the opened chat was refused its contact check');
      const send = await probe(SEND, { named: true });
      assert.deepEqual(send.nativeWhatsappRepairTarget, { phase: 'open_contact', ref_id: await refOf(HEADER) });
      const bound = await confirmContact();
      assert.equal(bound.success, true, JSON.stringify(bound));
      assert.equal(bound.conversationIdentity, 'Fixture Dad');
      assert.equal(bound.conversationId, phoneId(phones['Fixture Dad']));
    });
  });

  // From the same trace: with no chat open (WhatsApp had just loaded), the
  // row exemption above did not apply, since it lived with the open chat's
  // composer. Every row then waited on a model to read its caption and, with
  // that model unavailable, stayed blocked. A row opens its chat with no chat
  // open too, with no reading, and that chat gets the run's contact check.
  test(`${build}: with no chat open, a chat-list row opens its chat, whose contact is then confirmed`, async () => {
    await fixture(async ({ page, observe, probe, click, confirmContact }) => {
      await page.evaluate(() => {
        const main = document.querySelector('#main');
        document.querySelector('[data-testid="chat-list"] [aria-selected="true"]').setAttribute('aria-selected', 'false');
        main.remove();
        // Opening a chat mounts the conversation panel before the row's own
        // handler selects and names it.
        document.addEventListener('click', event => {
          if (event.target.closest?.('[role="gridcell"]') && !main.isConnected) document.body.append(main);
        }, true);
      });
      const row = await probe(DAD_ROW, { named: true, readings: false });
      assert.equal(row.conversationSelection, true, JSON.stringify(row));
      assert.equal(row.messageSend, false);
      assert.equal(row.conclusive, true);
      // The row's own menu is not a chat selection and still waits on its reading.
      const menu = await probe(DAD_MENU, { named: true, readings: false });
      assert.notEqual(menu.conversationSelection, true, JSON.stringify(menu));
      assert.notEqual(menu.conclusive, true, JSON.stringify(menu));
      assert.equal(await page.evaluate(() => fixtureMenuOpened), 0, 'a probe never clicks');
      assert.equal((await click(DAD_ROW)).success, true);
      assert.equal(await page.locator('[data-testid="conversation-info-header-chat-title-name"]').textContent(), 'Fixture Dad');
      const opened = await observe();
      assert.equal(opened.reason, 'native_whatsapp_contact_binding_required', JSON.stringify(opened));
      assert.notEqual(opened.retryable, false, 'the opened chat was refused its contact check');
      const bound = await confirmContact();
      assert.equal(bound.success, true, JSON.stringify(bound));
      assert.equal(bound.conversationIdentity, 'Fixture Dad');
      assert.equal(bound.conversationId, phoneId(phones['Fixture Dad']));
    });
  });

  test(`${build}: a request for the open chat keeps its contact check on that chat`, async () => {
    await fixture(async ({ observe, probe, click }) => {
      await observe();
      assert.equal((await probe(DAD_ROW)).conversationSelection, true);
      assert.equal((await click(DAD_ROW)).success, true);
      const after = await observe();
      assert.equal(after.reason, 'native_whatsapp_contact_check_spent', JSON.stringify(after));
      assert.equal(after.retryable, false);
    });
  });

  test(`${build}: once a check is armed, opening another chat spends it even in a named request`, async () => {
    await fixture(async ({ page, observe, probe, click }) => {
      await observe();
      assert.equal((await probe(DAD_ROW, { named: true })).conversationSelection, true);
      // The check is armed on the open chat, then the panel is closed by hand
      // (not by the guarded Close), so nothing was confirmed.
      assert.equal((await click(HEADER)).success, true);
      await page.locator('[data-testid="chat-info-drawer"]').waitFor();
      await page.locator('[aria-label="Close"]').click();
      assert.equal((await probe(DAD_ROW, { named: true })).conversationSelection, true);
      assert.equal((await click(DAD_ROW)).success, true);
      const after = await observe();
      assert.equal(after.reason, 'native_whatsapp_contact_check_spent', JSON.stringify(after));
    });
  });
}
