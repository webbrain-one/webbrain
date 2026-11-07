import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { chromium, firefox } from 'playwright';
import { guardProbeWithReadings } from './semantic-decision-stub.mjs';

// Actual native shapes are grounded in the sanitized current WhatsApp capture.
// All contacts, phone numbers, text and browser requests belong to this fixture.
const html = `<!doctype html><style>body{margin:0;font:16px sans-serif}aside{position:absolute;width:280px;left:0;top:0}#main{position:absolute;left:300px;top:0;width:920px;height:790px}header{height:70px}button,[role=button]{padding:8px;cursor:pointer}[data-testid=conversation-panel-messages]{height:600px;overflow:auto}[role=row]{padding:6px}footer{display:flex;gap:20px}[contenteditable]{min-height:36px;width:600px;border:1px solid}svg{width:16px;height:16px}[data-testid=chat-info-drawer]{position:fixed;right:0;top:0;width:260px;min-height:790px;background:white;z-index:3}</style>
<aside data-testid="chat-list"><div role="row"><div aria-selected="true"><span data-testid="cell-frame-title">Fixture Mom</span></div></div></aside>
<div id="main" data-testid="conversation-panel-wrapper"><header data-testid="conversation-header"><div role="button" tabindex="0" data-testid="conversation-info-header"><span data-testid="conversation-info-header-chat-title"><span data-testid="conversation-info-header-chat-title-name">Fixture Mom</span></span></div></header>
<div data-testid="conversation-panel-messages"></div><footer><div data-testid="conversation-compose-box-input" contenteditable="true" role="textbox" aria-label="Type a message to Fixture Mom"></div><button type="button" aria-label="Send">Send</button></footer></div>`;

for (const [build, engine] of [['chrome', chromium], ['firefox', firefox]]) {
  async function fixture(run) {
    const browser = await engine.launch({ headless: true });
    try {
      const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
      await page.route('**/*', route => route.fulfill({ contentType: 'text/html', body: html }));
      await page.goto('https://web.whatsapp.com/');
      await page.evaluate(() => {
        window.fixtureHandlers = []; window.fixtureOpenCount = 0; window.fixturePhone = '+90 555 000 00 01';
        const api = { runtime: { getURL: p => p, onMessage: { addListener: fn => fixtureHandlers.push(fn) } } };
        window.chrome = window.browser = api;
        window.fixtureAdd = (id, text, { sender = 'Fixture Mom', tail = 'in', status = '', before = false } = {}) => {
          const row = document.createElement('div'); row.setAttribute('role','row');
          const bubble = document.createElement('div'); bubble.setAttribute('data-id', id); bubble.setAttribute('data-testid', 'conv-msg-' + id);
          const container = document.createElement('div'); container.setAttribute('data-testid','msg-container');
          const plain = document.createElement('div'); if (sender) plain.setAttribute('data-pre-plain-text', '[12:00, 08/10/2026] ' + sender + ': ');
          const body = document.createElement('span'); body.setAttribute('data-testid','selectable-text'); body.textContent = text; plain.append(body); container.append(plain);
          if (tail) { const marker = document.createElement('span'); marker.setAttribute('data-icon','tail-' + tail); marker.textContent = '◁'; container.append(marker); }
          const meta = document.createElement('span'); meta.setAttribute('data-testid','msg-meta');
          if (status) { const indicator = document.createElement('span'); indicator.setAttribute('aria-label', status); indicator.textContent = '✓'; meta.append(indicator); }
          container.append(meta); bubble.append(container); row.append(bubble);
          const transcript = document.querySelector('[data-testid="conversation-panel-messages"]');
          if (before) transcript.prepend(row); else transcript.append(row); transcript.scrollTop = transcript.scrollHeight; return row;
        };
        window.fixtureDrawer = () => {
          fixtureOpenCount++;
          const drawer = document.createElement('div'); drawer.setAttribute('data-testid','chat-info-drawer');
          drawer.innerHTML = '<header><button type="button" aria-label="Close">Close</button></header><div data-testid="contact-info-header">Contact info</div><span data-testid="contact-info-subtitle selectable-text">Fixture Mom</span><div><span data-testid="selectable-text"><span>' + fixturePhone + '</span></span></div><div>Fixture Mom</div><div>Fixture Mom</div>';
          drawer.querySelector('button').onclick = () => drawer.remove(); document.body.append(drawer);
        };
        document.querySelector('[data-testid="conversation-info-header"]').onclick = fixtureDrawer;
        fixtureAdd('opaque-initial-Z', 'Incoming question one');
      });
      for (const file of ['rich-text-toolbar-heuristic.js','accessibility-tree.js','chat-observation.js','content.js']) {
        await page.addScriptTag({ content: await readFile(new URL(`../src/${build}/src/content/${file}`, import.meta.url), 'utf8') });
      }
      const call = (action, params = {}) => page.evaluate(message => new Promise(resolve => {
        for (const handler of fixtureHandlers) handler(message, {}, resolve);
      }), { target: 'content', action, params });
      const authority = { taskKey: 'tk_aaaaaaaa', taskSha256: 'a'.repeat(64), resumeTaskId: 'resume-task-owned-1', providerSha256: 'b'.repeat(64) };
      const ownerFor = (run = 'owned-run-1', provider = 'owned-provider-1', generation = 1, fields = {}) => {
        const current = { ...authority, ...fields };
        return JSON.stringify([run,current.taskKey,generation,provider,'owned-model',current.taskSha256,current.resumeTaskId,current.providerSha256]);
      };
      let owner = ownerFor(), restore = null;
      // Observes the way the agent does: texts the observation consulted
      // unread (a sent message's status) are read, and it observes again.
      const observe = () => guardProbeWithReadings(params => call('observe_chat', params),
        { _nativeChatOwner: owner, _nativeChatPendingRestore: restore, adapterName: 'generic-messaging' });
      const read = () => call('get_accessibility_tree', { filter: 'all' });
      const click = async selector => {
        await read();
        const ref = await page.locator(selector).evaluate(node => __wb_ax_ref(node));
        return call('click_ax', { ref_id: ref, _nativeChatOwner: owner, _nativeChatPendingRestore: restore });
      };
      const bind = async () => {
        await observe();
        const opened = await click('[data-testid="conversation-info-header"]'); assert.equal(opened.success, true, JSON.stringify(opened));
        await page.locator('[data-testid="chat-info-drawer"]').waitFor(); await page.waitForTimeout(30);
        const closed = await click('[data-testid="chat-info-drawer"] header button[aria-label="Close"]'); assert.equal(closed.success, true, JSON.stringify(closed));
        return observe();
      };
      await run({ page, call, observe, bind, click, ownerFor, authority,
        setOwner: value => { owner = value; }, setRestore: value => { restore = value; } });
    } finally { await browser.close(); }
  }

  test(`${build}: native contact requires a fresh guarded drawer and exposes only a canonical hashed peer`, async () => {
    await fixture(async ({ page, observe, bind }) => {
      assert.equal((await observe()).success, false); assert.equal(await page.evaluate(() => fixtureOpenCount), 0, 'Read-only observation must not open UI.');
      await page.locator('[data-testid="conversation-info-header"]').click(); await page.locator('[aria-label="Close"]').click();
      assert.equal((await observe()).success, false, 'An ordinary user/page click is not the guarded application action.');
      const observation = await bind();
      assert.equal(observation.success, true, JSON.stringify(observation));
      const expected = 'whatsapp:phone:' + createHash('sha256').update('+905550000001').digest('hex').slice(0,32);
      assert.equal(observation.conversationId, expected); assert.equal(observation.conversationIdentity, 'Fixture Mom');
      assert.equal(JSON.stringify(observation).includes('905550000001'), false); assert.equal(await page.evaluate(() => fixtureOpenCount), 2);
    });
  });

  // From review: a run's contact check belongs to the first chat it looked
  // at, so once the chat selection changed the agent was sent after a header
  // click that could not help, with "re-read and retry". It is told plainly
  // instead, and the next run can check a contact again.
  test(`${build}: once the chat selection changed, a run says it can no longer check a contact`, async () => {
    await fixture(async ({ page, call, observe, ownerFor, setOwner }) => {
      const before = await observe();
      assert.equal(before.reason, 'native_whatsapp_contact_binding_required', JSON.stringify(before));
      assert.ok(before.nativeWhatsappRepair, 'the open chat offers its contact check');
      const probe = owner => call('probe_message_recipient_guard', { tool: 'observe_active_conversation', args: {},
        adapterName: 'generic-messaging', _nativeChatOwner: owner });
      const offered = await probe(ownerFor());
      assert.equal(offered.nativeWhatsappRepairAvailable, true, JSON.stringify(offered));
      assert.equal(offered.nativeWhatsappRepairSpent, undefined);
      // From review: the chat hidden for a moment, as behind a modal, is not
      // a spent check; the same chat is offered its check again afterwards.
      await page.evaluate(() => document.querySelector('#main').setAttribute('aria-hidden', 'true'));
      const hidden = await observe();
      assert.notEqual(hidden.reason, 'native_whatsapp_contact_check_spent', JSON.stringify(hidden));
      assert.notEqual(hidden.retryable, false, JSON.stringify(hidden));
      assert.equal((await probe(ownerFor())).nativeWhatsappRepairSpent, undefined);
      await page.evaluate(() => document.querySelector('#main').removeAttribute('aria-hidden'));
      const shown = await observe();
      assert.equal(shown.reason, 'native_whatsapp_contact_binding_required', JSON.stringify(shown));
      assert.ok(shown.nativeWhatsappRepair, 'the chat shown again is not offered its contact check');
      await page.evaluate(() => {
        const selected = document.querySelector('[aria-selected]');
        selected.setAttribute('aria-selected', 'false'); selected.setAttribute('aria-selected', 'true');
      });
      const after = await observe();
      assert.equal(after.reason, 'native_whatsapp_contact_check_spent', JSON.stringify(after));
      assert.equal(after.retryable, false);
      assert.match(after.error, /can no longer confirm a WhatsApp contact[\s\S]*needs a new request/);
      const spent = await probe(ownerFor());
      assert.equal(spent.nativeWhatsappRepairSpent, true, JSON.stringify(spent));
      assert.equal(spent.reasonCode, 'native_whatsapp_contact_check_spent');
      assert.equal(spent.conclusive, false);
      // The next run checks a contact again.
      setOwner(ownerFor('owned-run-2'));
      const next = await observe();
      assert.equal(next.reason, 'native_whatsapp_contact_binding_required', JSON.stringify(next));
      assert.ok(next.nativeWhatsappRepair, 'a new run cannot check a contact');
    });
  });

  test(`${build}: native grouped incoming messages need a continuous explicit sender anchor`, async () => {
    await fixture(async ({ page, bind, observe }) => {
      await bind();
      await page.evaluate(() => {
        fixtureAdd('opaque-A-second','Grouped incoming two',{tail:''});
        fixtureAdd('opaque-wrong','Wrong sender',{tail:'',sender:'Other fixture'});
        fixtureAdd('opaque-orphan','Unanchored sender',{tail:''});
        fixtureAdd('opaque-no-preplain','Missing sender',{tail:'in',sender:''});
        fixtureAdd('opaque-new-anchor','New incoming group',{tail:'in'});
        fixtureAdd('opaque-new-grouped','Grouped incoming three',{tail:''});
      });
      const messages = (await observe()).messages;
      assert.deepEqual(messages.map(row => row.text), ['Incoming question one','Grouped incoming two','New incoming group','Grouped incoming three']);
      assert.ok(messages.every(row => row.direction === 'incoming'));
      await page.evaluate(() => fixtureAdd('opaque-own-same-name','Own same-name body',{tail:'out',sender:'Fixture Mom',status:'Delivered'}));
      assert.equal((await observe()).messages.some(row => row.text === 'Grouped incoming two'), false, 'A known identical own sender makes a no-tail inference ambiguous.');
    });
  });

  for (const drift of ['selection-roundtrip','same-name-row-replacement','header-replacement','composer-replacement','transcript-replacement','source-owner','stop']) {
    test(`${build}: ${drift} revokes native contact authority`, async () => {
      await fixture(async ({ page, call, bind, observe, setOwner }) => {
        assert.equal((await bind()).success, true);
        if (drift === 'source-owner') setOwner('owned-run-2-task-1-source-2');
        else if (drift === 'stop') await page.evaluate(() => {
          for (const handler of fixtureHandlers) handler({ target: 'content', action: 'page_monitor_stop' }, {}, () => {});
        });
        else await page.evaluate(drift => {
          const selected = document.querySelector('[aria-selected]');
          if (drift === 'selection-roundtrip') { selected.setAttribute('aria-selected','false'); selected.setAttribute('aria-selected','true'); }
          else {
            const selector = { 'same-name-row-replacement':'[data-testid="chat-list"] [role="row"]', 'header-replacement':'[data-testid="conversation-header"]',
              'composer-replacement':'[data-testid="conversation-compose-box-input"]','transcript-replacement':'[data-testid="conversation-panel-messages"]' }[drift];
            const node = document.querySelector(selector); node.replaceWith(node.cloneNode(true));
          }
        }, drift);
        assert.equal((await observe()).success, false, 'Old names and nodes cannot certify the current peer after drift.');
      });
    });
  }

  test(`${build}: opaque delivery needs a new row after a still-mounted live tail`, async () => {
    await fixture(async ({ page, bind, observe }) => {
      await bind();
      assert.equal(await page.evaluate(() => __wb_prepare_native_chat_send(document.querySelector('[contenteditable]'),'Owned reply')), true);
      await page.evaluate(() => fixtureAdd('old-remounted-opaque','Owned reply',{tail:'out',sender:'Own QA',status:'Delivered',before:true}));
      assert.equal((await observe()).messages.some(row => row.direction === 'outgoing'), false);
      await page.evaluate(() => fixtureAdd('new-opaque-A','Owned reply',{tail:'out',sender:'Own QA',status:'Pending'}));
      assert.equal((await observe()).messages.some(row => row.direction === 'outgoing'), false);
      await page.evaluate(() => document.querySelector('[data-id="new-opaque-A"] [aria-label]').setAttribute('aria-label','Delivered'));
      assert.equal((await observe()).messages.filter(row => row.direction === 'outgoing').length, 1);
      await page.evaluate(() => document.querySelector('[data-id="opaque-initial-Z"]').closest('[role="row"]').remove());
      assert.equal((await observe()).messages.some(row => row.direction === 'outgoing'), false, 'An unmounted baseline cannot acknowledge an uncertain send.');
    });
  });

  for (const loss of ['none','new-task-same-text','provider-config','same-run-provider','stop','document-epoch','tail-remount','baseline-reorder','forged-body']) {
    test(`${build}: worker-only floor recovery ${loss}`, async () => {
      await fixture(async ({ page, bind, observe, ownerFor, authority, setOwner, setRestore }) => {
        const original = await bind(), body = 'Owned worker reply';
        assert.equal(await page.evaluate(body => __wb_prepare_native_chat_send(document.querySelector('[contenteditable]'),body), body), true);
        await page.evaluate(body => fixtureAdd('opaque-worker-reply',body,{tail:'out',sender:'Own QA',status:'Delivered'}), body);
        const envelope = { ...original.nativeChatMessageBaseline, ...authority, body,
          originRunToken: 'owned-run-1', originActionSequence: 1 };
        if (loss === 'tail-remount') await page.evaluate(() => {
          const node = document.querySelector('[data-id="opaque-initial-Z"]'); node.replaceWith(node.cloneNode(true));
        });
        if (loss === 'baseline-reorder') await page.evaluate(() => {
          // Add a second baseline in a new genuine private floor, then reorder
          // both original node objects; unchanged ids are insufficient.
          fixtureAdd('opaque-second-before','Second prior incoming');
        });
        if (loss === 'baseline-reorder') {
          const current = await observe();
          assert.equal(await page.evaluate(body => __wb_prepare_native_chat_send(document.querySelector('[contenteditable]'),body), body), true);
          Object.assign(envelope, current.nativeChatMessageBaseline);
          await page.evaluate(() => {
            const transcript = document.querySelector('[data-testid="conversation-panel-messages"]');
            transcript.prepend(transcript.lastElementChild);
            fixtureAdd('opaque-worker-reply-2','Owned worker reply',{tail:'out',sender:'Own QA',status:'Delivered'});
          });
        }
        if (loss === 'document-epoch') envelope.documentEpoch = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
        if (loss === 'forged-body') envelope.body = 'Other body';
        await page.evaluate(action => {
          for (const handler of fixtureHandlers) handler({ target:'content',action },{},()=>{});
        }, loss === 'stop' ? 'page_monitor_stop' : 'page_monitor_start');
        setRestore(envelope);
        setOwner(ownerFor(loss === 'same-run-provider' ? 'owned-run-1' : 'owned-run-2','owned-provider-2',1,
          loss === 'new-task-same-text' ? { resumeTaskId:'resume-task-owned-2' }
            : loss === 'provider-config' ? { providerSha256:'c'.repeat(64) } : {}));
        assert.equal((await observe()).success, false, 'Every restarted owner still needs a fresh native drawer.');
        const rebound = await bind(); assert.equal(rebound.success, true, JSON.stringify(rebound));
        assert.equal(!!rebound.nativeChatDeliveryProof, loss === 'none', 'Only original same-task/provider/document/node continuity certifies delivery.');
        if (loss === 'none') assert.equal(rebound.nativeChatDeliveryProof.messageId.endsWith(':opaque-worker-reply'), true);
      });
    });
  }

  for (const invalid of ['wrong-subtitle','duplicate-phones','preexisting-drawer','same-name-switch-during-drawer']) {
    test(`${build}: ${invalid} never establishes a phone certificate`, async () => {
      await fixture(async ({ page, bind, observe, click }) => {
        await observe();
        if (invalid === 'preexisting-drawer') await page.evaluate(() => fixtureDrawer());
        else await click('[data-testid="conversation-info-header"]');
        await page.evaluate(invalid => {
          const drawer = document.querySelector('[data-testid="chat-info-drawer"]');
          if (invalid === 'wrong-subtitle') drawer.querySelector('[data-testid="contact-info-subtitle selectable-text"]').textContent = 'Other fixture';
          if (invalid === 'duplicate-phones') { const phone = document.createElement('span'); phone.setAttribute('data-testid','selectable-text'); phone.textContent = '+90 555 000 00 02'; drawer.append(phone); }
          if (invalid === 'same-name-switch-during-drawer') { const node = document.querySelector('[data-testid="chat-list"] [role="row"]'); node.replaceWith(node.cloneNode(true)); }
        }, invalid);
        await page.waitForTimeout(30); await page.locator('[aria-label="Close"]').click();
        assert.equal((await observe()).success, false);
      });
    });
  }
  // From a trace: the contact's name held an emoji. WhatsApp draws a
  // name's emoji as an <img> inside the name, and the drawer check wanted a
  // name with no child elements, so it never captured the drawer and blocked
  // its Close button, the very step the guard names. Emoji images in a name
  // are still its plain text; any other markup there is not.
  const EMOJI = '<img class="emoji" alt="🧚‍♂️" data-plain-text="🧚‍♂️" draggable="false" src="data:image/gif;base64,R0lGODlhAQABAAAAACw=">';
  for (const [shape, subtitle, accepted] of [
    ['an emoji image', `Fixture ${EMOJI} Mom`, true],
    ['another element', 'Fixture <b>Mom</b>', false],
    ['an image whose text is not emoji', 'Fixture <img class="emoji" alt="Dad"> Mom', false],
  ]) {
    test(`${build}: a contact drawer name holding ${shape} ${accepted ? 'confirms' : 'never confirms'} the contact`, async () => {
      await fixture(async ({ page, call, observe, click, ownerFor }) => {
        await page.evaluate(({ name, subtitle }) => {
          for (const selector of ['[data-testid="cell-frame-title"]', '[data-testid="conversation-info-header-chat-title-name"]']) {
            document.querySelector(selector).innerHTML = name;
          }
          document.querySelector('[data-testid="conversation-info-header"]').onclick = () => {
            fixtureDrawer();
            document.querySelector('[data-testid="chat-info-drawer"] [data-testid="contact-info-subtitle selectable-text"]').innerHTML = subtitle;
          };
        }, { name: `Fixture ${EMOJI} Mom`, subtitle });
        const CLOSE = '[data-testid="chat-info-drawer"] header button[aria-label="Close"]';
        assert.equal((await observe()).success, false);
        assert.equal((await click('[data-testid="conversation-info-header"]')).success, true);
        await page.locator('[data-testid="chat-info-drawer"]').waitFor(); await page.waitForTimeout(30);
        // The agent's recipient probe right before the Close click.
        await call('get_accessibility_tree', { filter: 'all' });
        const closeRef = await page.locator(CLOSE).evaluate(node => __wb_ax_ref(node));
        const probe = await guardProbeWithReadings(params => call('probe_message_recipient_guard', params), {
          tool: 'click_ax', args: { ref_id: closeRef }, adapterName: 'generic-messaging', bindDispatch: true, _nativeChatOwner: ownerFor() });
        if (accepted) assert.equal(probe.nativeWhatsappRepair, true, JSON.stringify(probe));
        else assert.equal(probe.reasonCode, 'native_whatsapp_contact_binding_required', JSON.stringify(probe));
        await click(CLOSE);
        const after = await observe();
        assert.equal(after.success, accepted, JSON.stringify(after));
        if (accepted) {
          assert.equal(after.conversationId, 'whatsapp:phone:' + createHash('sha256').update('+905550000001').digest('hex').slice(0,32));
          assert.equal(after.conversationIdentity, 'Fixture Mom');
        }
      });
    });
  }
  for (const order of ['observer-first','monitor-first']) {
    test(`${build}: production monitor ${order} rejects stale Stop but revokes pending floor before Continue`, async () => {
      await fixture(async ({ page, bind, observe, setOwner, setRestore, ownerFor, authority }) => {
        const initial = await bind(), body = 'Owned stopped reply';
        assert.equal(await page.evaluate(body => __wb_prepare_native_chat_send(document.querySelector('[contenteditable]'), body), body), true);
        const envelope = { ...initial.nativeChatMessageBaseline, ...authority, body,
          originRunToken:'owned-run-1', originActionSequence:1 };
        await page.evaluate(body => fixtureAdd('opaque-after-stop', body, { tail:'out', sender:'Own QA', status:'Delivered' }), body);
        await page.evaluate(() => {
          window.fixtureMonitorRun = 'owned-monitor-current';
          chrome.runtime.sendMessage = async message => message.action === 'get_page_monitor_state'
            ? { active:true, documentToken:message.documentToken, runToken:fixtureMonitorRun } : { ready:true };
        });
        await page.addScriptTag({ content:await readFile(new URL(`../src/${build}/src/content/page-monitor.js`, import.meta.url), 'utf8') });
        await page.waitForFunction(() => __wbPageMonitor.active === true);
        if (order === 'monitor-first') await page.evaluate(() => fixtureHandlers.unshift(fixtureHandlers.pop()));
        await page.evaluate(() => {
          for (const handler of fixtureHandlers) handler({ target:'content', action:'page_monitor_state', active:false,
            runToken:'old-monitor-run' }, {}, () => {});
        });
        assert.ok((await observe()).nativeChatDeliveryProof, 'An ignored old-run stop cannot erase the current proof.');
        await page.evaluate(() => {
          for (const handler of fixtureHandlers) handler({ target:'content', action:'page_monitor_state', active:false,
            runToken:fixtureMonitorRun }, {}, () => {});
        });
        assert.equal(await page.evaluate(() => __wbPageMonitor.active), false);
        assert.equal((await observe()).success, false, 'The accepted production Stop revokes identity even with the same owner.');
        setRestore(envelope); setOwner(ownerFor('owned-run-2','owned-provider-2'));
        await page.evaluate(() => {
          fixtureMonitorRun = 'owned-monitor-continued';
          for (const handler of fixtureHandlers) handler({ target:'content', action:'page_monitor_state', active:true }, {}, () => {});
        });
        await page.waitForFunction(() => __wbPageMonitor.active === true);
        assert.equal((await observe()).success, false);
        // This fixture has no background dispatch owner. Finish the monitor
        // before exercising the real guarded AX drawer path again; Stop's
        // revoked private floor must stay revoked after a fresh identity bind.
        await page.evaluate(() => __wbPageMonitor.dispose());
        const rebound = await bind();
        assert.equal(rebound.success, true);
        assert.equal(rebound.nativeChatDeliveryProof, undefined, 'A matching task/restore envelope cannot resurrect a stopped floor.');
      });
    });
  }
}
