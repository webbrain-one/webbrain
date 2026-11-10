import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { chromium, firefox } from 'playwright';

// Real native Close updates its decorative icon and asynchronously loads media.
// Every identity, phone, page, request and UI handler is owned by this fixture.
// Use production reader + AX + content dispatch, including its guarded Close hook.
const html = `<!doctype html><style>body{margin:0;font:16px sans-serif}aside{position:absolute;width:260px}#main{position:absolute;left:280px;width:950px;height:780px}header{height:70px}[role=button],button{padding:8px}[data-testid=conversation-panel-messages]{height:600px}[contenteditable]{min-height:32px;width:600px}[data-testid=chat-info-drawer]{position:fixed;right:0;top:0;width:300px;background:white}</style>
<aside data-testid="chat-list"><div role="row"><div aria-selected="true"><span data-testid="cell-frame-title">Owned Contact</span></div></div></aside>
<div id="main" data-testid="conversation-panel-wrapper"><header data-testid="conversation-header"><div id="carrier" role="button" tabindex="0" data-testid="conversation-info-header"><span data-testid="conversation-info-header-chat-title-name">Owned Contact</span></div></header><div data-testid="conversation-panel-messages"><div role="row"><div data-id="owned-incoming" data-testid="conv-msg-owned-incoming"><div data-testid="msg-container"><div data-pre-plain-text="[12:00, 08/10/2026] Owned Contact: "><span data-testid="selectable-text">Owned question</span></div><span data-icon="tail-in">◁</span></div></div></div></div><footer><div id="composer" contenteditable="true" role="textbox" data-testid="conversation-compose-box-input" aria-placeholder="Type a message"></div><button id="send" type="button" aria-label="Send">Send</button></footer></div>`;

const owner = JSON.stringify(['owned-drawer-run','tk_aaaaaaaa',1,'owned-provider','owned-model','a'.repeat(64),'owned-task','b'.repeat(64)]);
for (const [build, engine] of [['chrome', chromium], ['firefox', firefox]]) test(`${build}: canonical drawer identity survives only unrelated native visual updates`, async t => {
  const browser = await engine.launch({ headless: true });
  try {
    const sources = await Promise.all(['rich-text-toolbar-heuristic.js','accessibility-tree.js','whatsapp-phone.js','chat-observation.js','content.js']
      .map(file => readFile(file === 'chat-observation.js' && process.env.WEBBRAIN_WA_DRAWER_READER
        ? process.env.WEBBRAIN_WA_DRAWER_READER : new URL(`../src/${build}/src/content/${file}`, import.meta.url), 'utf8')));
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await page.route('**/*', route => route.fulfill({ contentType: 'text/html', body: html }));
    const call = (action, params = {}) => page.evaluate(message => new Promise(resolve => {
      for (const listener of qaHandlers) listener(message, {}, resolve);
    }), { target: 'content', action, params });
    const observe = currentOwner => call('observe_chat', { _nativeChatOwner: currentOwner || owner });
    // `closeLabel` is the drawer's close control's name in the page's language;
    // `headerLayout` lays out the drawer's header: its close control alone, or
    // with a title and an Edit control (`close-title-edit` is WhatsApp's own
    // drawer for a saved contact).
    async function open({ closeLabel = 'Close', headerLayout = 'close' } = {}) {
      await page.goto('https://web.whatsapp.com/');
      await page.evaluate(({ closeLabel, headerLayout }) => {
        window.qaHandlers = []; window.qaOpened = 0; window.qaClosed = 0; window.qaEdited = 0; window.qaSent = 0; window.qaCloseMode = '';
        const runtime = { getURL: x => x, onMessage: { addListener: fn => qaHandlers.push(fn) } };
        window.chrome = window.browser = { runtime };
        carrier.onclick = () => {
          qaOpened++;
          const drawer = document.createElement('div'); drawer.dataset.testid = 'chat-info-drawer';
          const close = '<button type="button" id="drawer-close" aria-label="' + closeLabel + '"><span id="close-icon" aria-label="idle">×</span></button>';
          const edit = '<button type="button" id="drawer-edit" aria-label="Düzenle">✎</button>';
          const header = {
            'close': close,
            'close-title-edit': close + '<h1>Kişi bilgisi</h1>' + edit,
            'close-roleheading-edit': close + '<div role="heading" aria-level="1">Kişi bilgisi</div>' + edit,
            'two-buttons': close + edit,
            'edit-close-title': edit + close + '<h1>Kişi bilgisi</h1>',
          }[headerLayout];
          drawer.innerHTML = '<header>' + header + '</header><div data-testid="contact-info-header">Contact info</div><span id="subtitle" data-testid="contact-info-subtitle selectable-text">Owned Contact</span><div><span id="phone" data-testid="selectable-text">+90 555 000 00 01</span></div><section id="media"><span data-testid="loading-spinner">Loading</span></section>';
          const editButton = drawer.querySelector('#drawer-edit');
          if (editButton) editButton.onclick = () => { qaEdited++; };
          drawer.querySelector('#drawer-close').onclick = event => {
            qaClosed++;
            const icon = drawer.querySelector('#close-icon');
            if (qaCloseMode === 'visual-close' || qaCloseMode === 'delayed-visual') {
              icon.setAttribute('aria-label','pressed'); icon.setAttribute('aria-label','idle');
              event.currentTarget.classList.toggle('focused');
            }
            if (qaCloseMode === 'close-replaced') event.currentTarget.replaceWith(event.currentTarget.cloneNode(true));
            if (qaCloseMode === 'close-relabeled') event.currentTarget.setAttribute('aria-label','Other action');
            if (qaCloseMode === 'hidden-mounted') { drawer.hidden = true; return; }
            if (qaCloseMode === 'teardown') { drawer.replaceChildren(); setTimeout(() => drawer.remove(),15); return; }
            drawer.remove();
            if (qaCloseMode === 'delayed-visual') setTimeout(() => icon.setAttribute('aria-label','after detach'),15);
          };
          document.body.append(drawer);
          window.qaDrawer = drawer;
        };
        send.onclick = () => qaSent++;
      }, { closeLabel, headerLayout });
      for (const source of sources) await page.addScriptTag({ content: source });
      const first = await observe(); assert.equal(first.success, false);
      assert.equal(first.nativeWhatsappRepair?.phase, 'open_contact', JSON.stringify(first));
      await call('get_accessibility_tree', { ref_id: first.nativeWhatsappRepair.ref_id });
      const opened = await call('click_ax', { ref_id: first.nativeWhatsappRepair.ref_id, _nativeChatOwner: owner });
      assert.equal(opened.success, true, JSON.stringify(opened));
      await page.waitForTimeout(25);
      await page.evaluate(() => {
        window.qaIdentityNodes = { subtitle: document.querySelector('#subtitle'), phone: document.querySelector('#phone') };
        window.qaNativeNodes = ['#main','[data-testid="conversation-header"]','#carrier','#composer','[data-testid="conversation-panel-messages"]','[aria-selected]','[data-testid="cell-frame-title"]'].map(selector => document.querySelector(selector));
      });
    }
    async function guardedClose(mode = '') {
      await page.evaluate(mode => { qaCloseMode = mode; }, mode);
      const current = await observe();
      if (!current.nativeWhatsappRepair?.ref_id) return { available: false, result: null };
      assert.equal(current.nativeWhatsappRepair.phase, 'close_contact');
      await call('get_accessibility_tree', { ref_id: current.nativeWhatsappRepair.ref_id });
      const result = await call('click_ax', { ref_id: current.nativeWhatsappRepair.ref_id, _nativeChatOwner: owner });
      await page.waitForTimeout(35);
      return { available: true, result };
    }
    for (const visual of ['none','media-loader','close-hover','visual-close','delayed-visual']) await t.test(`accept ${visual}`, async () => {
      await open();
      await page.evaluate(visual => {
        if (visual === 'media-loader') { const media = document.querySelector('#media'); media.replaceChildren(document.createElement('img')); media.firstElementChild.setAttribute('aria-label','Owned decorative avatar'); }
        if (visual === 'close-hover') { const icon = document.querySelector('#close-icon'); icon.setAttribute('aria-label','hover'); icon.setAttribute('aria-label','idle'); icon.parentElement.classList.add('hover'); }
      }, visual);
      const closed = await guardedClose(visual);
      assert.equal(closed.available, true, 'Visual updates cannot discard the unchanged phone/name certificate.');
      assert.equal(closed.result.success, true, JSON.stringify(closed.result));
      assert.equal(closed.result._nativeWhatsappReadRepair, true);
      const observation = await observe(); assert.equal(observation.success, true, JSON.stringify(observation));
      assert.match(observation.conversationId, /^whatsapp:phone:[a-f0-9]{32}$/);
      assert.equal(JSON.stringify(observation).includes('905550000001'), false);
      assert.deepEqual(await page.evaluate(() => ({ opened: qaOpened, closed: qaClosed, sent: qaSent,
        nativeSame: qaNativeNodes.every(node => node.isConnected), phoneSame: qaIdentityNodes.phone === qaDrawer.querySelector('#phone'),
        subtitleSame: qaIdentityNodes.subtitle === qaDrawer.querySelector('#subtitle') })),
        { opened: 1, closed: 1, sent: 0, nativeSame: true, phoneSame: true, subtitleSame: true });
    });
    // The drawer's close control is the named button that leads its header,
    // whatever language names it: the header's one button, or the one button
    // before the header's title. Any other header offers none.
    await t.test('accept a close control named in another language', async () => {
      await open({ closeLabel: 'Kapat' });
      const closed = await guardedClose();
      assert.equal(closed.available, true, 'A close control named in Turkish closes the drawer through the guarded path.');
      assert.equal(closed.result.success, true, JSON.stringify(closed.result));
      const observation = await observe(); assert.equal(observation.success, true, JSON.stringify(observation));
      assert.match(observation.conversationId, /^whatsapp:phone:[a-f0-9]{32}$/);
      assert.equal(await page.evaluate(() => qaSent), 0);
    });
    // From a trace: WhatsApp's drawer for a saved contact has Close, its title
    // and Edit in the header. With only a one-button header accepted, its Close
    // was blocked twelve times and the contact could never be confirmed.
    for (const headerLayout of ['close-title-edit', 'close-roleheading-edit']) await t.test(`accept ${headerLayout}: the close control before the title`, async () => {
      await open({ closeLabel: 'Kapat', headerLayout });
      const closed = await guardedClose();
      assert.equal(closed.available, true, 'The button before the title is the close control.');
      assert.equal(closed.result.success, true, JSON.stringify(closed.result));
      assert.equal(closed.result._nativeWhatsappReadRepair, true);
      const observation = await observe(); assert.equal(observation.success, true, JSON.stringify(observation));
      assert.match(observation.conversationId, /^whatsapp:phone:[a-f0-9]{32}$/);
      assert.deepEqual(await page.evaluate(() => ({ closed: qaClosed, edited: qaEdited, sent: qaSent })), { closed: 1, edited: 0, sent: 0 });
    });
    for (const headerLayout of ['two-buttons', 'edit-close-title']) await t.test(`reject ${headerLayout}: no single control leads the header`, async () => {
      await open({ headerLayout });
      const closed = await guardedClose();
      assert.equal(closed.available, false, 'Neither header control is taken for the close control.');
      assert.equal((await observe()).success, false);
      assert.deepEqual(await page.evaluate(() => ({ edited: qaEdited, sent: qaSent })), { edited: 0, sent: 0 });
    });
    const invalid = ['phone-text','phone-return','phone-clone','subtitle-text','subtitle-return','subtitle-clone','different-phone','transient-phone','transient-subtitle','identity-clear-return','selected-return','header-clone','other-drawer-return'];
    for (const mutation of invalid) await t.test(`reject ${mutation}`, async () => {
      await open();
      await page.evaluate(mutation => {
        const phone = document.querySelector('#phone'), subtitle = document.querySelector('#subtitle');
        if (mutation === 'phone-text' || mutation === 'phone-return') { const prior = phone.textContent; phone.firstChild.data = '+90 555 000 00 02'; if (mutation === 'phone-return') phone.firstChild.data = prior; }
        if (mutation === 'subtitle-text' || mutation === 'subtitle-return') { const prior = subtitle.textContent; subtitle.firstChild.data = 'Another Contact'; if (mutation === 'subtitle-return') subtitle.firstChild.data = prior; }
        if (mutation === 'phone-clone') phone.replaceWith(phone.cloneNode(true));
        if (mutation === 'subtitle-clone') subtitle.replaceWith(subtitle.cloneNode(true));
        if (mutation === 'different-phone' || mutation === 'transient-phone') { const extra = phone.cloneNode(true); extra.removeAttribute('id'); extra.textContent = '+90 555 000 00 02'; qaDrawer.append(extra); if (mutation === 'transient-phone') extra.remove(); }
        if (mutation === 'transient-subtitle') { const extra = subtitle.cloneNode(true); qaDrawer.append(extra); extra.remove(); }
        if (mutation === 'identity-clear-return') { const parent = phone.parentElement; phone.remove(); parent.append(phone); }
        if (mutation === 'selected-return') { const selected = document.querySelector('[aria-selected]'); selected.setAttribute('aria-selected','false'); selected.setAttribute('aria-selected','true'); }
        if (mutation === 'header-clone') { const header = document.querySelector('[data-testid="conversation-header"]'); header.replaceWith(header.cloneNode(true)); }
        if (mutation === 'other-drawer-return') { const extra = qaDrawer.cloneNode(true); document.body.append(extra); extra.remove(); }
      }, mutation);
      await guardedClose();
      assert.equal((await observe()).success, false, 'Material identity history cannot inherit the old phone hash.');
      assert.equal(await page.evaluate(() => qaSent), 0);
    });
    for (const mode of ['close-replaced','close-relabeled','hidden-mounted','teardown']) await t.test(`reject ${mode} after predispatch`, async () => {
      await open(); await guardedClose(mode);
      assert.equal((await observe()).success, false, 'Final closure needs the original identity and Close provenance.');
      assert.equal(await page.evaluate(() => qaSent), 0);
    });
    for (const boundary of ['page-removal','ordinary-click','stop','owner','document']) await t.test(`reject ${boundary}`, async () => {
      await open();
      if (boundary === 'page-removal') await page.evaluate(() => qaDrawer.remove());
      if (boundary === 'ordinary-click') await page.locator('[data-testid="chat-info-drawer"] header button').click();
      if (boundary === 'stop') await page.evaluate(() => {
        for (const listener of qaHandlers) listener({ target:'content',action:'page_monitor_stop' },{},()=>{});
        qaDrawer.remove();
      });
      if (boundary === 'owner') { await page.evaluate(() => __wb_update_native_chat_owner('different-private-owner')); await page.evaluate(() => qaDrawer.remove()); }
      if (boundary === 'document') { await page.goto('https://web.whatsapp.com/'); for (const source of sources) await page.addScriptTag({ content: source }); await page.evaluate(() => { window.qaHandlers = []; }); }
      if (boundary !== 'document') assert.equal((await observe()).success, false, 'A page/user dismissal or invalid owner does not create a guarded Close receipt.');
      else assert.equal(await page.evaluate(() => !!__wb_get_native_chat_context(document.querySelector('#composer'))), false);
    });
  } finally { await browser.close(); }
});
