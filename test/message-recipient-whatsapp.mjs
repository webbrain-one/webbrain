import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { chromium, firefox } from 'playwright';
import { Agent as ChromeAgent } from '../src/chrome/src/agent/agent.js';
import { Agent as FirefoxAgent } from '../src/firefox/src/agent/agent.js';
import { guardProbeWithReadings, stubPageTextReadings } from './semantic-decision-stub.mjs';

// These local pages exercise the real content observer and one-use dispatch
// validator. Every navigation is intercepted; no external message is sent.
const sendArgs = { selector: '#send' };
const phone = '+90 555 000 00 01';
const call = (page, action, params = {}) => page.evaluate(message => new Promise(resolve => {
  for (const handler of window.fixtureHandlers) handler(message, {}, resolve);
}), { target: 'content', action, params });

async function fixture(kind, engine, Agent, options = {}) {
  const browser = await engine.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.route('**/*', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html>' }));
  await page.goto(options.url || 'https://web.whatsapp.com/');
  await page.setContent(`<!doctype html><style>
    body{margin:0;font:16px sans-serif}aside{position:absolute;left:0;top:0;width:300px;height:790px;overflow:auto}
    #main{position:absolute;left:320px;top:0;width:940px;height:790px}
    #main>header{height:70px;display:flex;align-items:center;gap:30px;padding-left:70px}
    #contact{width:278px;height:20px}#messages{height:580px;overflow:auto}
    footer{display:flex;gap:15px;align-items:center}#body{width:550px;min-height:32px}
    button{min-height:28px}#alien-header{position:absolute;left:330px;top:80px}
  </style><aside><header><h1>WhatsApp</h1></header><button>Anne</button><h2>Sidebar recipient</h2></aside>
  <main id="main"><header><img alt="" width="40" height="40">
    <div id="contact" role="button" tabindex="0"><span title="Anne">Anne</span></div>
    <button id="call" aria-label="Voice call">Call</button><button aria-label="Search">Search</button>
  </header><section id="messages"><div>Anne</div><button>Other person</button></section>
  <footer><button id="attach">Attach</button>
    <div id="body" contenteditable="true" role="textbox" aria-label="Type a message to ${phone}">Selam</div>
    <input id="file" type="file" accept="image/*" hidden><button id="send" aria-label="Send">Send</button>
  </footer></main>`);
  await page.evaluate(() => {
    window.fixtureHandlers = [];
    const runtime = { onMessage: { addListener(fn) { window.fixtureHandlers.push(fn); } }, getURL: p => p };
    window.chrome = { runtime }; window.browser = { runtime };
    window.sent = 0;
    document.querySelector('#send').addEventListener('click', () => window.sent++);
  });
  for (const file of ['whatsapp-phone.js', 'file-upload-policy.js', 'rich-text-toolbar-heuristic.js', 'accessibility-tree.js', 'content.js']) {
    await page.addScriptTag({ content: await readFile(path.resolve('src', kind, 'src/content', file), 'utf8') });
  }
  const agent = new Agent({ getActive: () => ({ supportsVision: false }) });
  agent._currentUrl = async () => page.url();
  // Control names (Call, Search, Send) are read by the fixtures' model oracle.
  stubPageTextReadings(agent);
  agent._messageRecipientContentProbe = (_, params) => call(page, 'probe_message_recipient_guard', params);
  agent._planExecutionGuards.set(71, { messaging: { target_kind: 'named', recipients: ['anne'] },
    requiresStateChange: true, requiresSubmission: true });
  const probe = (tool = 'click', args = sendArgs) => guardProbeWithReadings(params => call(page, 'probe_message_recipient_guard', params), {
    adapterName: 'generic-messaging', tool, args, bindDispatch: true, expectedRecipients: ['anne'],
  });
  const bind = async (tool = 'click', args = sendArgs) => {
    const context = {};
    const blocked = await agent._messageRecipientGuardBlock(71, tool, args, page.url(), context);
    return { blocked, context };
  };
  return { browser, page, agent, probe, bind };
}

for (const [kind, engine, Agent] of [['chrome', chromium, ChromeAgent], ['firefox', firefox, FirefoxAgent]]) {
  test(`${kind}: a numeric target follows the scoped WhatsApp composer destination on every send`, async () => {
    const f = await fixture(kind, engine, Agent);
    try {
      const plan = f.agent._planExecutionGuards.get(71);
      plan.messaging = { target_kind: 'named', recipients: ['+905550000001'] };
      for (const label of ['+90 555 000 00 01 numarasına mesaj yaz', '+90 555 000 00 01 にメッセージを送信', 'Message to 0090 (555) 000-00-01']) {
        await f.page.locator('#body').evaluate((node, value) => node.setAttribute('aria-label', value), label);
        assert.equal((await f.bind()).blocked, null, label);
      }
      const first = await f.bind();
      assert.equal(first.blocked, null, JSON.stringify(first.blocked));
      assert.equal((await call(f.page, 'click', { ...sendArgs, ...first.context })).success, true);
      for (const label of ['Type a message to +90 555 000 00 02', 'Recipients +905550000002 and +905550000001']) {
        // The saved name stays the same when the destination changes.
        await f.page.locator('#body').evaluate((node, value) => node.setAttribute('aria-label', value), label);
        const moved = await f.bind();
        assert.equal(moved.blocked?.noDispatch, true, label);
        assert.equal(moved.context.messageRecipientDispatchBinding, undefined);
      }
      await f.page.locator('#body').evaluate(node => node.setAttribute('aria-label', 'Message to +90 555 000 00 01'));
      await f.page.locator('#contact span').evaluate(node => { node.textContent = '905550000002'; node.title = node.textContent; });
      assert.equal((await f.bind()).blocked?.noDispatch, true, 'a conflicting numeric header rejects the send even without its plus sign');
      const pinnedPeer = 'whatsapp:phone:' + f.agent._sha256TextSync('+905550000001').slice(0, 32);
      plan.messaging = { target_kind: 'named', recipients: [pinnedPeer] };
      await f.page.locator('#contact span').evaluate((node, peer) => { node.textContent = peer; node.title = peer; }, pinnedPeer);
      assert.equal((await f.bind()).blocked?.noDispatch, true, 'typing a native id into a display name cannot impersonate Contact info');
      assert.equal(await f.page.evaluate(() => window.sent), 1);
    } finally { await f.browser.close(); }
  });

  test(`${kind}: WhatsApp contact button permits the named chat without a clarification`, async () => {
    const f = await fixture(kind, engine, Agent);
    try {
      const observed = await f.probe();
      assert.equal(observed.success, true);
      assert.equal(observed.conclusive, true);
      assert.ok(observed.strongRecipientCandidates.some(recipient => recipient.identity === 'Anne'), JSON.stringify(observed));
      assert.equal(observed.strongRecipientCandidates.length, 1, 'sidebar, app title and toolbar must not become recipients');
      assert.ok(observed.observedRecipientCandidates[0].aliases.includes('+905550000001'), 'the authored destination must stay tied to the observed contact');
      const { blocked, context } = await f.bind();
      assert.equal(blocked, null, JSON.stringify(blocked));
      assert.equal(context.messageRecipientGuardRequired, true);
      assert.ok(context.messageRecipientDispatchBinding?.token);
      const result = await call(f.page, 'click', { ...sendArgs, ...context });
      assert.equal(result.success, true, JSON.stringify(result));
      assert.equal(await f.page.evaluate(() => window.sent), 1);
      assert.equal(f.agent._planExecutionGuards.get(71).pendingRecipientAuthorization, undefined);
    } finally { await f.browser.close(); }
  });

  test(`${kind}: one real recipient approval persists for repeated sends`, async () => {
    const f = await fixture(kind, engine, Agent);
    try {
      f.agent._planExecutionGuards.get(71).messaging = { target_kind: 'named', recipients: ['Different recipient'] };
      const first = await f.bind();
      assert.equal(first.blocked?.reasonCode, 'active_recipient_unverified', JSON.stringify(first.blocked));
      // WebBrain's own card, answered once with its fixed Send choice.
      const cards = [];
      const approval = await f.agent._resolveMessageRecipientConfirmation(71, first.blocked, (status, details) => {
        if (status !== 'clarify') return;
        cards.push(details);
        f.agent._settleClarification(f.agent._pendingClarifications.get(71).get(details.clarifyId), { answer: 'once', source: 'option' });
      }, () => f.bind().then(next => next.blocked), { allowPrompt: true });
      assert.equal(approval, null, JSON.stringify(approval));
      assert.equal(cards.length, 1);
      assert.deepEqual(cards[0].recipientConfirmation.recipients, [{ identity: 'Anne', role: 'to' }]);
      for (let attempt = 0; attempt < 2; attempt++) {
        const next = await f.bind();
        assert.equal(next.blocked, null, JSON.stringify(next.blocked));
        const result = await call(f.page, 'click', { ...sendArgs, ...next.context });
        assert.equal(result.success, true, JSON.stringify(result));
      }
      assert.equal(await f.page.evaluate(() => window.sent), 2);
      assert.equal(cards.length, 1, 'The same person is not asked about again in this task');
    } finally { await f.browser.close(); }
  });

  test(`${kind}: the scoped header button pattern also works on a generic chat site`, async () => {
    const f = await fixture(kind, engine, Agent, { url: 'https://example.test/chat/rooms/one' });
    try {
      const { blocked, context } = await f.bind();
      assert.equal(blocked, null, JSON.stringify(blocked));
      const result = await call(f.page, 'click', { ...sendArgs, ...context });
      assert.equal(result.success, true, JSON.stringify(result));
      assert.equal(await f.page.evaluate(() => window.sent), 1);
    } finally { await f.browser.close(); }
  });

  for (const drift of ['recipient', 'same-name phone', 'contact replacement', 'composer replacement', 'body']) {
    test(`${kind}: ${drift} change blocks the previously bound send`, async () => {
      const f = await fixture(kind, engine, Agent);
      try {
        const { blocked, context } = await f.bind();
        assert.equal(blocked, null, JSON.stringify(blocked));
        await f.page.evaluate(drift => {
          if (drift === 'recipient') document.querySelector('#contact span').textContent = 'Different recipient';
          if (drift === 'same-name phone') document.querySelector('#body').setAttribute('aria-label', 'Type a message to +90 555 000 00 02');
          if (drift === 'contact replacement') {
            const old = document.querySelector('#contact'); old.replaceWith(old.cloneNode(true));
          }
          if (drift === 'composer replacement') {
            const old = document.querySelector('#body'); old.replaceWith(old.cloneNode(true));
          }
          if (drift === 'body') document.querySelector('#body').textContent = 'Different message';
        }, drift);
        const result = await call(f.page, 'click', { ...sendArgs, ...context });
        assert.equal(result.success, false, JSON.stringify(result));
        assert.equal(result.messageRecipientGuard, true, JSON.stringify(result));
        assert.equal(result.dispatched, false);
        assert.equal(await f.page.evaluate(() => window.sent), 0);
      } finally { await f.browser.close(); }
    });
  }

  test(`${kind}: unrelated message updates preserve the current recipient proof`, async () => {
    const f = await fixture(kind, engine, Agent);
    try {
      const { blocked, context } = await f.bind();
      assert.equal(blocked, null, JSON.stringify(blocked));
      await f.page.evaluate(() => {
        document.querySelector('#messages').append('new unrelated incoming message');
        document.querySelector('aside button').textContent = 'Sidebar updated';
      });
      const result = await call(f.page, 'click', { ...sendArgs, ...context });
      assert.equal(result.success, true, JSON.stringify(result));
      assert.equal(await f.page.evaluate(() => window.sent), 1);
    } finally { await f.browser.close(); }
  });

  for (const missing of ['contact missing', 'contact hidden', 'ambiguous contacts', 'message impersonation', 'nested toolbar', 'foreign owner']) {
    test(`${kind}: ${missing} cannot authorize a send or stage another approval`, async () => {
      const f = await fixture(kind, engine, Agent);
      try {
        await f.page.evaluate(missing => {
          const contact = document.querySelector('#contact');
          if (missing === 'contact hidden') contact.hidden = true;
          if (missing === 'contact missing' || missing === 'message impersonation') contact.remove();
          if (missing === 'ambiguous contacts') {
            const second = contact.cloneNode(true); second.id = 'another-contact';
            second.querySelector('span').textContent = 'Other recipient'; contact.after(second);
          }
          if (missing === 'message impersonation') {
            document.querySelector('#main > header').remove();
            document.querySelector('#messages').innerHTML = '<header><div role="button">Anne</div></header>';
          }
          if (missing === 'nested toolbar') {
            const toolbar = document.createElement('div'); toolbar.setAttribute('role', 'toolbar');
            contact.replaceWith(toolbar); toolbar.append(contact);
          }
          if (missing === 'foreign owner') {
            const owner = document.createElement('section'); owner.id = 'alien-header';
            contact.closest('header').replaceWith(owner); owner.append(contact);
          }
        }, missing);
        const { blocked } = await f.bind();
        assert.equal(blocked?.success, false, JSON.stringify(blocked));
        assert.equal(blocked?.noDispatch, true);
        assert.equal(blocked?.reasonCode, 'recipient_identity_unavailable', JSON.stringify(blocked));
        assert.equal(blocked?.recipientAuthorizationRequired, false);
        assert.equal(blocked.recipientConfirmation, undefined, 'A page without a verifiable recipient offers no card');
        assert.doesNotMatch(blocked.error, /clarify\(|Ask the user to authorize/);
        // The recipient refusal above ran in the default mode. Strict checks
        // only for the clarify refusal below: by default that quality check
        // advises and the question would wait for an answer.
        f.agent.strictGuards = true;
        const updates = [];
        const repeatedApproval = await f.agent._executeToolImpl(71, 'clarify', {
          purpose: 'message_recipient', question: 'Send to Anne instead?', options: ['Anne', 'Cancel'],
        }, status => updates.push(status));
        assert.equal(repeatedApproval.success, false);
        assert.equal(repeatedApproval.reasonCode, 'recipient_identity_unavailable');
        assert.deepEqual(updates, [], 'technical failures must not present an unusable approval question');
        assert.equal(f.agent._pendingClarifications.has(71), false);
        if (missing === 'contact missing') {
          // Any other question is just a question: whatever is picked, it
          // cannot supply the missing page identity or approve the send.
          f.agent.clarifyTimeoutSec = -1;
          f.agent._recordClarificationAuthorization = async () => true;
          for (const [question, options, answer] of [['Send to Anne instead?', ['Anne', 'Cancel'], 'Anne'],
            ['Which image size do you prefer?', ['Original', 'Small'], 'Original'],
            ['Send to Anne?', ['Send all remaining messages without asking again', 'Cancel'], 'Send all remaining messages without asking again']]) {
            const asked = await f.agent._executeToolImpl(71, 'clarify', { question, options }, (status, details) => {
              if (status !== 'clarify') return;
              updates.push(status);
              f.agent._settleClarification(f.agent._pendingClarifications.get(71).get(details.clarifyId), { answer, source: 'option' });
            });
            assert.equal(asked.success, true, question);
            assert.equal(asked.recipientBinding, undefined, question);
            assert.equal((await f.bind()).blocked?.reasonCode, 'recipient_identity_unavailable', question);
          }
          assert.equal(f.agent._planExecutionGuards.get(71).messageRecipientApprovedAll, undefined);
          assert.equal(typeof f.agent._bindClarifiedMessageRecipient, 'undefined', 'No answer wording is read for consent');
        }
        assert.equal(await f.page.evaluate(() => window.sent), 0);
      } finally { await f.browser.close(); }
    });
  }

  test(`${kind}: a fresh observed contact clears the technical blocker`, async () => {
    const f = await fixture(kind, engine, Agent);
    try {
      await f.page.evaluate(() => { document.querySelector('#contact').hidden = true; });
      assert.equal((await f.bind()).blocked?.reasonCode, 'recipient_identity_unavailable');
      await f.page.evaluate(() => { document.querySelector('#contact').hidden = false; });
      const { blocked, context } = await f.bind();
      assert.equal(blocked, null, JSON.stringify(blocked));
      assert.equal(f.agent._planExecutionGuards.get(71).messageRecipientTechnicalBlock, undefined);
      const result = await call(f.page, 'click', { ...sendArgs, ...context });
      assert.equal(result.success, true, JSON.stringify(result));
      assert.equal(await f.page.evaluate(() => window.sent), 1);
    } finally { await f.browser.close(); }
  });

  test(`${kind}: missing delivery evidence preserves consent and never asks to approve again`, async () => {
    const f = await fixture(kind, engine, Agent);
    try {
      const guard = f.agent._planExecutionGuards.get(71);
      guard.approvedRecipients = ['anne'];
      const realProbe = f.agent._messageRecipientContentProbe;
      for (const [field, value, reasonCode] of [
        ['messageBody', '', 'message_body_unverified'],
        ['messageBodyBaselineCount', null, 'message_body_baseline_unavailable'],
        ['messageBodyBaselineCount', '', 'message_body_baseline_unavailable'],
        ['messageRecipientDispatchBinding', undefined, 'recipient_dispatch_binding_unavailable'],
      ]) {
        f.agent._messageRecipientContentProbe = async (...args) => ({ ...await realProbe(...args), [field]: value });
        // The recipient refusal runs in the default mode; Strict checks only
        // for the clarify refusal after it (a quality check that advises by
        // default, when the question would wait for an answer).
        f.agent.strictGuards = false;
        const { blocked } = await f.bind();
        assert.equal(blocked?.reasonCode, reasonCode, JSON.stringify(blocked));
        assert.equal(blocked.recipientAuthorizationRequired, false);
        assert.deepEqual(guard.approvedRecipients, ['anne']);
        assert.equal(blocked.recipientConfirmation, undefined, 'Missing delivery evidence is not put to the user again');
        f.agent.strictGuards = true;
        const updates = [];
        const confirmation = await f.agent._executeToolImpl(71, 'clarify', {
          purpose: 'message_recipient', question: 'Send to Anne?', options: ['Anne', 'Cancel'],
        }, status => updates.push(status));
        assert.equal(confirmation.success, false);
        assert.equal(confirmation.reasonCode, reasonCode);
        assert.deepEqual(updates, []);
      }
      f.agent._messageRecipientContentProbe = realProbe;
      f.agent.strictGuards = false;
      assert.equal((await f.bind()).blocked, null);
      assert.equal(guard.messageRecipientTechnicalBlock, undefined);
      assert.deepEqual(guard.approvedRecipients, ['anne']);
      assert.equal(await f.page.evaluate(() => window.sent), 0);
    } finally { await f.browser.close(); }
  });

  test(`${kind}: protected screenshot attachment binds the WhatsApp contact`, async () => {
    const f = await fixture(kind, engine, Agent);
    try {
      const { blocked, context } = await f.bind('upload_file', { selector: '#file', downloadId: 2027 });
      assert.equal(blocked, null, JSON.stringify(blocked));
      const result = await call(f.page, 'attach_message_recipient_bound_upload', {
        selector: '#file', ...context, uploadSourceKey: context.messageRecipientUploadSourceKey,
        filename: 'fixture.png', mimeType: 'image/png', base64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS3kAAAAASUVORK5CYII=',
      });
      assert.equal(result.success, true, JSON.stringify(result));
      assert.equal(result.verified, false);
      assert.equal(result.remoteStateVerified, false);
      assert.equal(await f.page.evaluate(() => document.querySelector('#file').files.length), 1);
      assert.equal(await f.page.evaluate(() => window.sent), 0);
    } finally { await f.browser.close(); }
  });
}
