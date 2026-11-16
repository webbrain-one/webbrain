import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { chromium } from 'playwright';
import { Agent as ChromeAgent } from '../src/chrome/src/agent/agent.js';
import { Agent as FirefoxAgent } from '../src/firefox/src/agent/agent.js';
import { guardProbeWithReadings, stubPageTextReadings } from './semantic-decision-stub.mjs';

// The real content scripts of both builds (in Chromium, the only installed
// engine) and each build's real Agent. Every navigation is intercepted; no
// message leaves the page.
const ROOT = process.env.WEBBRAIN_TEST_ROOT || fileURLToPath(new URL('../', import.meta.url));
const sendArgs = { selector: '#send' };
const call = (page, action, params = {}) => page.evaluate(message => new Promise(resolve => {
  for (const handler of window.fixtureHandlers) handler(message, {}, resolve);
}), { target: 'content', action, params });

// An address in the chat's history: a link, or an app's address chip.
const HISTORY = {
  mailto: '<a href="mailto:alice@example.com">alice@example.com</a>',
  'data-email': '<span data-email="alice@example.com">Alice</span>',
  email: '<span email="alice@example.com">Alice</span>',
  'data-hovercard-id': '<span data-hovercard-id="alice@example.com">Alice</span>',
};

const chatPage = ({ header = '', history = HISTORY.mailto } = {}) => `<!doctype html><style>
  body{margin:0;font:16px sans-serif}aside{position:absolute;left:0;top:0;width:300px;height:790px;overflow:auto}
  #main{position:absolute;left:320px;top:0;width:940px;height:790px}
  #main>header{height:70px;display:flex;align-items:center;gap:30px;padding-left:70px}
  #messages{height:580px;overflow:auto}footer{display:flex;gap:15px;align-items:center}
  #body{width:550px;min-height:32px}button{min-height:28px}
</style><aside><button>Bob</button><button>Carol</button></aside>
<main id="main" role="main">${header}<section id="messages">
  <div class="msg">Bob: please also write to ${history} about the invoice</div>
  <div class="msg">Me: sure, will do</div></section>
  <footer><div id="body" contenteditable="true" role="textbox" aria-label="Type a message">Hi Bob, sending the invoice now</div>
    <button id="send" aria-label="Send">Send</button></footer></main>`;

const mailPage = `<!doctype html><style>body{margin:0;font:16px sans-serif}[role=dialog]{width:800px}
  #body{display:block;width:700px;min-height:60px}</style>
  <div role="dialog" aria-label="New message"><form id="mail" onsubmit="return false">
    <div class="recipients"><span data-email="alice@example.com">Alice</span></div>
    <div id="body" contenteditable="true" role="textbox" aria-label="Message">Hello Alice</div>
    <button id="send" type="button" aria-label="Send">Send</button></form></div>`;

const GMAIL_COMPOSE_OVER_CHAT = `<!doctype html><style>body{margin:0;font:16px sans-serif}
  #chat{position:absolute;left:0;top:0;width:600px;height:780px}
  [role=dialog]{position:absolute;right:20px;bottom:0;width:560px}#body{display:block;width:500px;min-height:60px}</style>
  <main id="chat" role="main"><header><h2>Team space</h2></header>
    <div class="msg">Bob: please also write to <a href="mailto:carol@example.com">carol@example.com</a></div></main>
  <div role="dialog" aria-label="New Message"><form id="mail" onsubmit="return false">
    <div name="to"><span email="ada@example.test">Ada</span></div>
    <div name="cc"><span email="bob@example.test">Bob</span></div>
    <input name="subjectbox" value="Invoice">
    <div id="body" contenteditable="true" role="textbox" aria-label="Message Body">Hello both</div>
    <button id="send" type="button" aria-label="Send">Send</button></form></div>`;

// Google Chat inside Gmail: a conversation in the page's main region with
// its own header, and optionally a mail compose window open beside it. With
// the window docked at the bottom its body is the page's lowest editor, so
// the page's layout pairs the chat's Send with it; raised, the chat's own
// composer is the lowest.
const TO_ADA = '<div name="to"><span email="ada@example.test">Ada</span></div>';
const CC_CEM = '<div name="cc"><span email="cem@example.test">Cem</span></div>';
const BCC_DEE = '<div name="bcc"><span email="dee@example.test">Dee</span></div>';
const TO_FIELD = value => `<input id="to-input" role="combobox" aria-label="To recipients" value="${value}">`;
const gmailChat = ({ rows = '', raise = 0, chatFile = false, appFile = false, chatLabel = 'Type a message', draft = 'Draft' } = {}) => `<!doctype html><style>body{margin:0;font:16px sans-serif}
  #chat{position:absolute;left:0;top:0;width:640px;height:780px}#chat>header{height:70px}
  #messages{height:580px;overflow:auto}footer{display:flex;gap:15px;align-items:center}
  #body{width:500px;min-height:32px}button{min-height:28px}[role=dialog]{position:absolute;left:660px;bottom:${raise}px;width:560px}</style>
  <div id="app"><main id="chat" role="main"><header><h2>Bob</h2></header>
    <section id="messages"><div class="msg">Bob: please also write to <a href="mailto:carol@example.com">carol@example.com</a></div></section>
    <footer><div id="body" contenteditable="true" role="textbox" aria-label="${chatLabel}">Hi Bob</div>
      ${chatFile ? '<input id="chat-file" type="file">' : ''}<button id="send" type="button" aria-label="Send">Send</button></footer></main>
  ${appFile ? '<input id="app-file" type="file">' : ''}
  ${rows ? `<div role="dialog" aria-label="New Message"><form onsubmit="return false">${rows}
    <div id="mail-body" contenteditable="true" role="textbox" aria-label="Message Body" style="min-height:32px">${draft}</div>
    <button id="mail-send" type="button" aria-label="Send">Send</button></form></div>` : ''}</div>`;
// A Gmail Chat space whose history scrolls (or, `short`, is too short to
// scroll yet), with a thread's reply box inside it: a heading in that history
// names a person, not the space.
const gmailChatThread = (header, { short = false } = {}) => `<!doctype html><style>body{margin:0;font:16px sans-serif}
  #chat{position:absolute;left:0;top:0;width:900px;height:780px}#chat>header{height:60px}
  #messages{height:600px;overflow:auto}.t{display:block;width:500px;min-height:32px}footer{display:flex;gap:10px}</style>
  <main id="chat" role="main"><header>${header}</header>
    <section id="messages"><div role="heading" aria-level="3">Ada</div><div>Ada: can you send me the numbers?</div>
      <div style="height:150px"></div>
      <div class="thread"><div class="t" contenteditable="true" role="textbox" aria-label="Type a message">The Q3 numbers</div>
        <button id="send" type="button" aria-label="Send">Send</button></div>
      ${short ? '' : '<div style="height:600px"></div>'}</section>
    <footer><div class="t" contenteditable="true" role="textbox" aria-label="Type a message"></div>
      <button id="main-send" type="button" aria-label="Send">Send</button></footer></main>`;
// A Gmail Chat whose main region holds `top` above a short history, which
// may itself hold a heading naming someone else; `footer` adds to the
// composer's own area.
const gmailChatTop = (top, { history = '<div>Bob: see you</div>', footer = '' } = {}) => `<!doctype html>
  <style>body{margin:0;font:16px sans-serif}#chat{position:absolute;left:0;top:0;width:900px;height:780px}
  #messages{height:520px;overflow:auto}#body{display:block;width:500px;min-height:32px}footer{display:flex;gap:10px}</style>
  <main id="chat" role="main">${top}<section id="messages">${history}</section>
    <footer>${footer}<div id="body" contenteditable="true" role="textbox" aria-label="Type a message">The Q3 numbers</div>
      <button id="send" type="button" aria-label="Send">Send</button></footer></main>`;
const gmailCompose = rows => `<!doctype html><style>body{margin:0;font:16px sans-serif}[role=dialog]{width:800px}
  #body{display:block;width:700px;min-height:60px}</style>
  <main role="main"><h2>Inbox</h2></main>
  <div role="dialog" aria-label="New Message"><form onsubmit="return false">${rows}<input name="subjectbox" value="Invoice">
    <div id="body" contenteditable="true" role="textbox" aria-label="Message Body">Hello all</div>
    <button id="send" type="button" aria-label="Send">Send</button></form></div>`;

async function fixture(build, Agent, { url, html, recipients }) {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.route('**/*', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html>' }));
  await page.goto(url);
  await page.setContent(html);
  await page.evaluate(() => {
    window.fixtureHandlers = [];
    const runtime = { onMessage: { addListener(fn) { window.fixtureHandlers.push(fn); } }, getURL: p => p };
    window.chrome = { runtime }; window.browser = { runtime };
    window.sent = 0;
    document.querySelector('#send').addEventListener('click', () => window.sent++);
  });
  for (const file of ['file-upload-policy.js', 'rich-text-toolbar-heuristic.js', 'accessibility-tree.js', 'content.js']) {
    await page.addScriptTag({ content: await readFile(path.join(ROOT, 'src', build, 'src/content', file), 'utf8') });
  }
  const agent = new Agent({ getActive: () => ({ supportsVision: false }) });
  agent._currentUrl = async () => page.url();
  stubPageTextReadings(agent);
  agent._messageRecipientContentProbe = (_, params) => call(page, 'probe_message_recipient_guard', params);
  agent._planExecutionGuards.set(71, { messaging: { target_kind: 'named', recipients },
    requiresStateChange: true, requiresSubmission: true });
  const bind = async () => {
    const context = {};
    const blocked = await agent._messageRecipientGuardBlock(71, 'click', sendArgs, page.url(), context);
    return { blocked, context };
  };
  const probe = params => guardProbeWithReadings(next => call(page, 'probe_message_recipient_guard', next), {
    tool: 'click', args: sendArgs, bindDispatch: true, ...params,
  });
  return { browser, page, agent, bind, probe };
}

const CHAT_URL = 'https://example.test/chat/rooms/one';

for (const [build, Agent] of [['chrome', ChromeAgent], ['firefox', FirefoxAgent]]) {
  for (const [kind, history] of Object.entries(HISTORY)) {
    for (const target of ['alice@example.com', 'anne@example.com']) {
      test(`${build}: an address in a headerless chat's history (${kind}) is not the recipient of a send to ${target}`, async () => {
        const f = await fixture(build, Agent, { url: CHAT_URL, html: chatPage({ history }), recipients: [target] });
        try {
          const observed = await f.probe({ adapterName: 'generic-messaging', expectedRecipients: [target] });
          assert.deepEqual(observed.strongRecipientCandidates, [], JSON.stringify(observed));
          assert.deepEqual(observed.observedRecipientCandidates, []);
          assert.equal(observed.messageRecipientDispatchBinding, undefined);
          const { blocked, context } = await f.bind();
          assert.equal(blocked?.success, false, JSON.stringify(blocked));
          assert.equal(blocked.noDispatch, true);
          assert.equal(blocked.reasonCode, 'recipient_identity_unavailable', JSON.stringify(blocked));
          assert.equal(blocked.recipientConfirmation, undefined, 'no card offers a send to an address from the history');
          assert.equal(context.messageRecipientDispatchBinding, undefined);
          assert.equal(await f.page.evaluate(() => window.sent), 0);
        } finally { await f.browser.close(); }
      });
    }
  }

  test(`${build}: a chat header still decides the recipient when the history holds an address`, async () => {
    const f = await fixture(build, Agent, { url: CHAT_URL, recipients: ['alice@example.com'],
      html: chatPage({ header: '<header><h2>Bob</h2></header>' }) });
    try {
      const { blocked, context } = await f.bind();
      assert.equal(blocked?.reasonCode, 'active_recipient_unverified', JSON.stringify(blocked));
      assert.deepEqual(blocked.recipientConfirmation?.recipients, [{ identity: 'Bob', role: 'to' }], JSON.stringify(blocked));
      assert.equal(context.messageRecipientDispatchBinding, undefined);
      assert.equal(await f.page.evaluate(() => window.sent), 0);
    } finally { await f.browser.close(); }
    const named = await fixture(build, Agent, { url: CHAT_URL, recipients: ['Bob'],
      html: chatPage({ header: '<header><h2>Bob</h2></header>' }) });
    try {
      const { blocked, context } = await named.bind();
      assert.equal(blocked, null, JSON.stringify(blocked));
      assert.ok(context.messageRecipientDispatchBinding?.token);
      const result = await call(named.page, 'click', { ...sendArgs, ...context });
      assert.equal(result.success, true, JSON.stringify(result));
      assert.equal(await named.page.evaluate(() => window.sent), 1);
    } finally { await named.browser.close(); }
  });

  test(`${build}: a mail compose still binds its address chips as the recipient set`, async () => {
    const f = await fixture(build, Agent, { url: 'https://mail.example.test/compose', html: mailPage,
      recipients: ['alice@example.com'] });
    try {
      const observed = await f.probe({ adapterName: 'generic-messaging', supportsRecipientSets: true,
        expectedRecipients: [{ identity: 'alice@example.com', role: 'to' }] });
      assert.deepEqual(observed.strongRecipientCandidates, [{ identity: 'alice@example.com', role: 'to' }], JSON.stringify(observed));
      const { blocked, context } = await f.bind();
      assert.equal(blocked, null, JSON.stringify(blocked));
      assert.ok(context.messageRecipientDispatchBinding?.token);
      const result = await call(f.page, 'click', { ...sendArgs, ...context });
      assert.equal(result.success, true, JSON.stringify(result));
      assert.equal(await f.page.evaluate(() => window.sent), 1);
    } finally { await f.browser.close(); }
  });
}

// Help-desk and CRM conversation views often show the contact only as an
// address in the conversation's own header: that header still identifies
// the recipient, while the same markup in the history never does.
const HEADER_CHIP = {
  mailto: '<header><a href="mailto:casey@example.com">casey@example.com</a></header>',
  'data-email': '<header><span data-email="casey@example.com">Casey Customer</span></header>',
};
const HELPDESK_URL = 'https://desk.example.test/conversations/42';

for (const [build, Agent] of [['chrome', ChromeAgent], ['firefox', FirefoxAgent]]) {
  for (const [kind, header] of Object.entries(HEADER_CHIP)) {
    test(`${build}: an address in a conversation's own header (${kind}) is its recipient, not one in the history`, async () => {
      const bound = await fixture(build, Agent, { url: HELPDESK_URL, html: chatPage({ header }), recipients: ['casey@example.com'] });
      try {
        const observed = await bound.probe({ adapterName: 'generic-messaging', expectedRecipients: ['casey@example.com'] });
        assert.deepEqual(observed.strongRecipientCandidates, [{ identity: 'casey@example.com', role: 'to' }], JSON.stringify(observed));
        const { blocked, context } = await bound.bind();
        assert.equal(blocked, null, JSON.stringify(blocked));
        assert.ok(context.messageRecipientDispatchBinding?.token);
        const result = await call(bound.page, 'click', { ...sendArgs, ...context });
        assert.equal(result.success, true, JSON.stringify(result));
        assert.equal(await bound.page.evaluate(() => window.sent), 1);
      } finally { await bound.browser.close(); }

      const other = await fixture(build, Agent, { url: HELPDESK_URL, html: chatPage({ header }), recipients: ['alice@example.com'] });
      try {
        const { blocked, context } = await other.bind();
        assert.equal(blocked?.reasonCode, 'active_recipient_unverified', JSON.stringify(blocked));
        assert.deepEqual(blocked.recipientConfirmation?.recipients, [{ identity: 'casey@example.com', role: 'to' }],
          'the card names the header address, never the one from the history');
        assert.equal(context.messageRecipientDispatchBinding, undefined);
        assert.equal(await other.page.evaluate(() => window.sent), 0);
      } finally { await other.browser.close(); }
    });
  }

  test(`${build}: a message's own header in the history is not the conversation header`, async () => {
    const f = await fixture(build, Agent, { url: HELPDESK_URL, recipients: ['alice@example.com'], html: chatPage({
      history: '<header><a href="mailto:alice@example.com">alice@example.com</a></header>' }) });
    try {
      const { blocked, context } = await f.bind();
      assert.equal(blocked?.reasonCode, 'recipient_identity_unavailable', JSON.stringify(blocked));
      assert.equal(blocked.recipientConfirmation, undefined);
      assert.equal(context.messageRecipientDispatchBinding, undefined);
    } finally { await f.browser.close(); }
  });

  // recipient-guard-refusal: the page names no recipient, but the user can
  // see who the conversation is with. The tool batch (recipientCard) asks
  // them on WebBrain's hard card; "Go ahead" binds this one send to the
  // composer and the draft they saw, in the page itself.
  test(`${build}: a send whose recipient the page does not name goes out once after the user's answer, bound to the draft`, async () => {
    const draft = 'Hi Bob, sending the invoice now';
    const start = async () => {
      const f = await fixture(build, Agent, { url: CHAT_URL, html: chatPage(), recipients: ['alice@example.com'] });
      Object.assign(f.agent._planExecutionGuards.get(71), { enabled: true, taskKey: 'recipient-task' });
      f.agent._taskTokens.set(71, 'task-71');
      f.check = async (context = {}) => ({ context,
        blocked: await f.agent._messageRecipientGuardBlock(71, 'click', sendArgs, f.page.url(), context, { recipientCard: true }) });
      f.answer = (value, before = async () => {}) => (type, data) => {
        if (type === 'clarify') before().then(() => f.agent.submitClarifyResponse(71, data.clarifyId, value, 'option'));
      };
      return f;
    };
    const f = await start();
    try {
      const { blocked, context } = await f.check();
      assert.equal(blocked?.reasonCode, 'recipient_identity_unavailable', JSON.stringify(blocked));
      const { stepKey, ...ask } = blocked.unverifiedStepConfirmation;
      assert.deepEqual(ask, { guardId: 'recipient-guard-refusal', hard: true, action: 'send', reason: 'recipient_unreadable',
        host: 'example.test', contentLabel: 'composer', text: draft });
      assert.ok(stepKey);
      assert.equal(context.messageRecipientDispatchBinding, undefined, 'nothing is bound before the user answers');
      // Go ahead.
      f.agent._beginUnverifiedStepScope(71);
      const approved = {};
      assert.equal(await f.agent._resolveUnverifiedStepConfirmation(71, blocked, f.answer('once'), async () => (await f.check(approved)).blocked, []), null);
      assert.ok(approved.messageRecipientDispatchBinding?.token, 'the page bound a send without a recipient');
      assert.equal(approved.messageRecipientBody, draft);
      const sent = await call(f.page, 'click', { ...sendArgs, ...approved });
      assert.equal(sent.success, true, JSON.stringify(sent));
      assert.equal(await f.page.evaluate(() => window.sent), 1);
      // The binding was for that one send.
      const replay = await call(f.page, 'click', { ...sendArgs, ...approved });
      assert.equal(replay.success, false, JSON.stringify(replay));
      assert.equal(await f.page.evaluate(() => window.sent), 1);
      f.agent._settleUnverifiedStepScope(71);
      const next = await f.check();
      assert.ok(next.blocked?.unverifiedStepConfirmation, 'the next send asks again');
      assert.equal(next.context.messageRecipientDispatchBinding, undefined);
    } finally { await f.browser.close(); }

    // A recipient that appears before the click is sent stops it.
    const named = await start();
    try {
      named.agent._beginUnverifiedStepScope(71);
      const approved = {};
      assert.equal(await named.agent._resolveUnverifiedStepConfirmation(71, (await named.check()).blocked, named.answer('once'),
        async () => (await named.check(approved)).blocked, []), null);
      await named.page.evaluate(() => document.querySelector('#main').insertAdjacentHTML('afterbegin',
        '<header><a href="mailto:casey@example.com">Casey</a></header>'));
      const stopped = await call(named.page, 'click', { ...sendArgs, ...approved });
      assert.equal(stopped.success, false, JSON.stringify(stopped));
      assert.equal(stopped.reasonCode, 'active_recipient_changed_before_dispatch');
      assert.equal(await named.page.evaluate(() => window.sent), 0);
    } finally { await named.browser.close(); }

    // A draft edited while the card waits was not what the user approved.
    const edited = await start();
    try {
      const approved = {};
      const result = await edited.agent._resolveUnverifiedStepConfirmation(71, (await edited.check()).blocked,
        edited.answer('once', () => edited.page.evaluate(() => { document.querySelector('#body').textContent = 'Hi Bob, here is my card number'; })),
        async () => (await edited.check(approved)).blocked, []);
      assert.match(result.error, /changed while the user was being asked/);
      assert.equal(approved.messageRecipientGuardRequired, undefined);
      assert.equal(await edited.page.evaluate(() => window.sent), 0);
    } finally { await edited.browser.close(); }

    // Don't: the refusal stands, and nothing is bound.
    const declined = await start();
    try {
      const result = await declined.agent._resolveUnverifiedStepConfirmation(71, (await declined.check()).blocked, declined.answer('deny'),
        async () => (await declined.check()).blocked, []);
      assert.equal(result.unverifiedStepDeclined, true);
      assert.equal(result.reasonCode, 'recipient_identity_unavailable');
      assert.match(result.error, /The user chose not to go ahead with sending this message/);
      const unbound = await call(declined.page, 'click', { ...sendArgs, messageRecipientGuardRequired: true });
      assert.equal(unbound.success, false, JSON.stringify(unbound));
      assert.equal(await declined.page.evaluate(() => window.sent), 0);
    } finally { await declined.browser.close(); }
  });

  test(`${build}: two addresses in a conversation header identify no one`, async () => {
    const f = await fixture(build, Agent, { url: HELPDESK_URL, recipients: ['casey@example.com'], html: chatPage({
      header: '<header><a href="mailto:casey@example.com">Casey</a><span data-email="dana@example.com">Dana</span></header>' }) });
    try {
      const { blocked, context } = await f.bind();
      assert.equal(blocked?.reasonCode, 'recipient_identity_unavailable', JSON.stringify(blocked));
      assert.equal(context.messageRecipientDispatchBinding, undefined);
    } finally { await f.browser.close(); }
  });

  // A pinned message or a topic shown in the header is text about someone,
  // not the conversation's recipient.
  for (const [kind, header] of Object.entries({
    paragraph: '<header><p>Invoices go to <a href="mailto:casey@example.com">casey@example.com</a></p></header>',
    note: '<header><div role="note">Pinned: <span data-email="casey@example.com">Casey</span></div></header>',
  })) {
    test(`${build}: an address in a header's pinned text (${kind}) is not the recipient`, async () => {
      const f = await fixture(build, Agent, { url: HELPDESK_URL, recipients: ['casey@example.com'], html: chatPage({ header }) });
      try {
        const observed = await f.probe({ adapterName: 'generic-messaging', expectedRecipients: ['casey@example.com'] });
        assert.deepEqual(observed.strongRecipientCandidates, [], JSON.stringify(observed));
        const { blocked, context } = await f.bind();
        assert.equal(blocked?.reasonCode, 'recipient_identity_unavailable', JSON.stringify(blocked));
        assert.equal(context.messageRecipientDispatchBinding, undefined);
        assert.equal(await f.page.evaluate(() => window.sent), 0);
      } finally { await f.browser.close(); }
    });
  }

  // Google Chat inside Gmail is a chat: an address in its history is not a
  // recipient set member as it would be in a mail compose.
  for (const url of ['https://mail.google.com/chat/u/0/#chat/dm/abc', 'https://mail.google.com/mail/u/0/#chat/space/AAAA']) {
    test(`${build}: Google Chat in Gmail (${new URL(url).pathname}${new URL(url).hash.slice(0, 11)}) never binds an address from its history`, async () => {
      const f = await fixture(build, Agent, { url, html: chatPage(), recipients: ['alice@example.com'] });
      try {
        const { blocked, context } = await f.bind();
        assert.equal(blocked?.success, false, JSON.stringify(blocked));
        assert.equal(blocked.reasonCode, 'recipient_identity_unavailable', JSON.stringify(blocked));
        assert.equal(blocked.recipientConfirmation, undefined);
        assert.equal(context.messageRecipientDispatchBinding, undefined);
        assert.equal(await f.page.evaluate(() => window.sent), 0);
      } finally { await f.browser.close(); }
    });
  }

  // Gmail keeps a mail compose window open over its Chat views. Its own To
  // and Cc rows make it a mail compose on any route; the chat's history
  // beside it adds no one.
  test(`${build}: a Gmail compose open over a Chat view sends to its To and Cc rows`, async () => {
    const recipients = [{ identity: 'ada@example.test', role: 'to' }, { identity: 'bob@example.test', role: 'cc' }];
    const f = await fixture(build, Agent, { url: 'https://mail.google.com/mail/u/0/#chat/space/AAAA', recipients, html: GMAIL_COMPOSE_OVER_CHAT });
    try {
      const observed = await f.probe({ adapterName: 'gmail', expectedRecipients: recipients });
      assert.equal(observed.recipientSets, true, JSON.stringify(observed));
      assert.deepEqual(observed.strongRecipientCandidates, recipients, JSON.stringify(observed));
      const { blocked, context } = await f.bind();
      assert.equal(blocked, null, JSON.stringify(blocked));
      assert.ok(context.messageRecipientDispatchBinding?.token);
      const result = await call(f.page, 'click', { ...sendArgs, ...context });
      assert.equal(result.success, true, JSON.stringify(result));
      assert.equal(await f.page.evaluate(() => window.sent), 1);
    } finally { await f.browser.close(); }
  });

  // Nothing on a Gmail Chat page tells the Chat's name by structure from
  // what its messages, threads and pinned items show, so a Chat send is held,
  // whoever it names, and no card offers anyone in its place.
  const HELD_CHATS = [
    ['a header heading', gmailChat()],
    ['a plain header and a heading in a short history', gmailChatTop('<header><div>Bob</div></header>',
      { history: '<div role="heading" aria-level="3">Ada</div><div>Ada: can you send me the numbers?</div>' })],
    ['a plain header and a pinned heading', gmailChatTop('<header><div>Bob</div></header>'
      + '<div class="pinned"><div role="heading" aria-level="3">Ada</div></div>')],
    ['a heading before the header', gmailChatTop('<div><h3>Ada</h3></div><header><h2>Bob</h2></header>')],
  ];
  for (const [kind, html] of HELD_CHATS) {
    test(`${build}: a Gmail Chat send is held, never bound to a name on the page (${kind})`, async () => {
      for (const recipients of [['Bob'], ['Ada']]) {
        const f = await fixture(build, Agent, { url: 'https://mail.google.com/mail/u/0/#chat/dm/abc', recipients, html });
        try {
          const { blocked, context } = await f.bind();
          assert.equal(blocked?.reasonCode, 'recipient_identity_unavailable', `${recipients}: ${JSON.stringify(blocked)}`);
          assert.equal(blocked.recipientConfirmation, undefined, JSON.stringify(blocked));
          assert.equal(context.messageRecipientDispatchBinding, undefined);
          assert.equal(await f.page.evaluate(() => window.sent), 0);
        } finally { await f.browser.close(); }
      }
    });
  }

  // A Chat send never takes the recipients of a compose window open beside
  // it: not when the layout pairs its Send with the window's body, not when
  // its own composer is the lowest editor, and not when the URL carries the
  // compose= Gmail keeps while any compose window is open.
  for (const [kind, rows, recipients] of [
    ['To', TO_ADA, ['ada@example.test']],
    ['To and Cc', TO_ADA + CC_CEM, [{ identity: 'ada@example.test', role: 'to' }, { identity: 'cem@example.test', role: 'cc' }]],
    ['typed To', TO_FIELD('ada@example.test'), ['ada@example.test']],
  ]) {
    test(`${build}: a Gmail Chat send never goes to the ${kind} of a compose window open beside it`, async () => {
      for (const url of ['https://mail.google.com/mail/u/0/#chat/space/AAAA', 'https://mail.google.com/mail/u/0/#chat/space/AAAA?compose=new']) {
        for (const raise of [0, 150]) {
          const variant = `${url.slice(url.indexOf('#'))}, compose window ${raise ? 'raised' : 'docked'}`;
          const f = await fixture(build, Agent, { url, recipients, html: gmailChat({ rows, raise }) });
          try {
            const { blocked, context } = await f.bind();
            assert.equal(blocked?.success, false, `${variant}: ${JSON.stringify(blocked)}`);
            assert.equal(blocked.recipientConfirmation, undefined, `${variant}: ${JSON.stringify(blocked)}`);
            assert.equal(context.messageRecipientDispatchBinding, undefined, variant);
            assert.equal(await f.page.evaluate(() => window.sent), 0, variant);
          } finally { await f.browser.close(); }
        }
      }
    });
  }

  // Each Send sends its own message, whichever editor is the page's lowest:
  // the compose window's Send goes to its own To row, and the Chat's Send is
  // held, never sent to the window's recipients.
  for (const raise of [0, 150]) {
    test(`${build}: beside an open compose window (${raise ? 'raised' : 'docked'}) each Send binds to its own message`, async () => {
      const url = 'https://mail.google.com/mail/u/0/#chat/dm/abc?compose=new';
      const mailSend = { selector: '#mail-send' };
      const f = await fixture(build, Agent, { url, recipients: ['ada@example.test'], html: gmailChat({ rows: TO_ADA, raise }) });
      try {
        await f.page.evaluate(() => {
          window.mailSent = 0;
          document.querySelector('#mail-send').addEventListener('click', () => window.mailSent++);
        });
        const chat = await f.bind();
        assert.equal(chat.blocked?.success, false, JSON.stringify(chat.blocked));
        assert.equal(chat.blocked.recipientConfirmation, undefined, JSON.stringify(chat.blocked));
        assert.equal(chat.context.messageRecipientDispatchBinding, undefined);
        const mailContext = {};
        const mailBlocked = await f.agent._messageRecipientGuardBlock(71, 'click', mailSend, url, mailContext);
        assert.equal(mailBlocked, null, JSON.stringify(mailBlocked));
        const result = await call(f.page, 'click', { ...mailSend, ...mailContext });
        assert.equal(result.success, true, JSON.stringify(result));
        assert.equal(await f.page.evaluate(() => [window.sent, window.mailSent]).then(String), '0,1');
      } finally { await f.browser.close(); }
    });
  }

  // A model's reading of a label never makes a Chat composer something
  // other than a message's editor, even when the label names a person, so
  // the window's To is never the Chat's.
  for (const raise of [0, 150]) {
    test(`${build}: a Gmail Chat composer labelled with a contact's name stays a message's editor (${raise ? 'raised' : 'docked'} compose window)`, async () => {
      const f = await fixture(build, Agent, { url: 'https://mail.google.com/mail/u/0/#chat/dm/abc', recipients: ['ada@example.test'],
        html: gmailChat({ rows: TO_ADA, raise, chatLabel: 'Reply to Bob' }) });
      try {
        const { blocked, context } = await f.bind();
        assert.equal(blocked?.success, false, JSON.stringify(blocked));
        assert.equal(blocked.recipientConfirmation, undefined, JSON.stringify(blocked));
        assert.equal(context.messageRecipientDispatchBinding, undefined);
        assert.equal(await f.page.evaluate(() => window.sent), 0);
      } finally { await f.browser.close(); }
    });
  }

  // A thread's reply box inside the history, scrolling or too short to
  // scroll yet, sends to no one the history names.
  for (const [kind, header] of [['in a plain block', '<div>Team space</div>'], ['as a heading', '<h2>Team space</h2>']]) {
    for (const short of [false, true]) {
      test(`${build}: a Gmail Chat thread reply never takes its recipient from the history (space name ${kind}${short ? ', short history' : ''})`, async () => {
        for (const recipients of [['Ada'], ['Team space']]) {
          const f = await fixture(build, Agent, { url: 'https://mail.google.com/mail/u/0/#chat/space/AAA', recipients,
            html: gmailChatThread(header, { short }) });
          try {
            const { blocked, context } = await f.bind();
            assert.equal(blocked?.success, false, `${recipients}: ${JSON.stringify(blocked)}`);
            assert.equal(blocked.recipientConfirmation, undefined, JSON.stringify(blocked));
            assert.equal(context.messageRecipientDispatchBinding, undefined);
            assert.equal(await f.page.evaluate(() => window.sent), 0);
          } finally { await f.browser.close(); }
        }
      });
    }
  }

  // A chip beside a Chat's composer under a label naming someone ("Replying
  // to Ada") is no To row: the Chat is not a mail compose to Ada.
  test(`${build}: a labelled chip beside a Gmail Chat composer does not make it a mail compose`, async () => {
    const f = await fixture(build, Agent, { url: 'https://mail.google.com/mail/u/0/#chat/dm/abc', recipients: ['ada@example.test'],
      html: gmailChatTop('<header><h2>Bob</h2></header>',
        { footer: '<div aria-label="Replying to Ada"><span data-hovercard-id="ada@example.test">Ada</span></div>' }) });
    try {
      const { blocked, context } = await f.bind();
      assert.equal(blocked?.success, false, JSON.stringify(blocked));
      assert.equal(blocked.recipientConfirmation, undefined, JSON.stringify(blocked));
      assert.equal(context.messageRecipientDispatchBinding, undefined);
      assert.equal(await f.page.evaluate(() => window.sent), 0);
    } finally { await f.browser.close(); }
  });

  // In a Chat's history, a chip beside a control labelled with a person
  // ("Reply to Ada") is in no To row: only an input's label marks one.
  test(`${build}: a chip beside a labelled control in a Gmail Chat's history is no recipient`, async () => {
    const html = `<!doctype html><style>body{margin:0;font:16px sans-serif}
      [role=dialog]{position:absolute;right:20px;bottom:0;width:420px}#body{display:block;width:360px;min-height:32px}
      footer{display:flex;gap:10px}</style>
      <main role="main"><h2>Inbox</h2></main>
      <div role="dialog" aria-label="Bob"><header><h2>Bob</h2></header>
        <div class="msg"><span data-hovercard-id="ada@example.test">Ada</span>: see the numbers
          <button type="button" aria-label="Reply to Ada">Reply</button></div>
        <footer><div id="body" contenteditable="true" role="textbox" aria-label="Type a message">The Q3 numbers</div>
          <button id="send" type="button" aria-label="Send">Send</button></footer></div>`;
    const f = await fixture(build, Agent, { url: 'https://mail.google.com/mail/u/0/#inbox', recipients: ['ada@example.test'], html });
    try {
      const { blocked, context } = await f.bind();
      assert.equal(blocked?.success, false, JSON.stringify(blocked));
      assert.equal(blocked.recipientConfirmation, undefined, JSON.stringify(blocked));
      assert.equal(context.messageRecipientDispatchBinding, undefined);
      assert.equal(await f.page.evaluate(() => window.sent), 0);
    } finally { await f.browser.close(); }
  });

  // Only a single-line input's label can read as a To row: an editor
  // labelled with a person ("Note to Ada") never makes a Chat's window a
  // mail compose window whose To is that person.
  test(`${build}: an editor labelled with a person never marks a Gmail Chat window as a mail compose`, async () => {
    const html = `<!doctype html><style>body{margin:0;font:16px sans-serif}
      [role=dialog]{position:absolute;right:20px;bottom:0;width:420px}#body{display:block;width:360px;min-height:32px}
      .note{display:block;width:360px;min-height:24px}footer{display:flex;gap:10px}</style>
      <main role="main"><h2>Inbox</h2></main>
      <div role="dialog" aria-label="Bob"><header><h2>Bob</h2></header>
        <div aria-label="Replying to Ada"><span data-hovercard-id="ada@example.test">Ada</span></div>
        <div class="note" contenteditable="true" role="textbox" aria-label="Note to Ada"></div>
        <div class="msg">Bob: see you tomorrow</div>
        <footer><div id="body" contenteditable="true" role="textbox" aria-label="Type a message">The Q3 numbers</div>
          <button id="send" type="button" aria-label="Send">Send</button></footer></div>`;
    const f = await fixture(build, Agent, { url: 'https://mail.google.com/mail/u/0/#inbox', recipients: ['ada@example.test'], html });
    try {
      const { blocked, context } = await f.bind();
      assert.equal(blocked?.success, false, JSON.stringify(blocked));
      for (const item of blocked.recipientConfirmation?.recipients || []) assert.notEqual(item.identity, 'ada@example.test');
      assert.equal(context.messageRecipientDispatchBinding, undefined);
      assert.equal(await f.page.evaluate(() => window.sent), 0);
    } finally { await f.browser.close(); }
  });

  // A click into an editor only focuses it, and a page control far from
  // any message is no message's Send.
  test(`${build}: clicks into a Gmail editor or on a page control are not sends`, async () => {
    const url = 'https://mail.google.com/mail/u/0/#chat/dm/abc';
    for (const [raise, selector] of [[150, '#mail-body'], [0, '#body']]) {
      const f = await fixture(build, Agent, { url, recipients: ['ada@example.test'], html: gmailChat({ rows: TO_ADA, raise, draft: '' }) });
      try {
        assert.equal(await f.agent._messageRecipientGuardBlock(71, 'click', { selector }, url, {}), null, `${selector}, raise ${raise}`);
      } finally { await f.browser.close(); }
    }
    const html = `<!doctype html><style>body{margin:0;font:16px sans-serif}main{position:absolute;left:0;top:0;width:1200px;height:780px}
      .toolbar{position:absolute;left:900px;top:10px}.reply{position:absolute;left:0;top:80px}#body{display:block;width:560px;min-height:40px}</style>
      <main role="main"><div class="toolbar"><button id="archive" type="button" aria-label="Archive">Archive</button></div>
        <h2>Invoice</h2><div class="reply"><div class="rows">${TO_ADA}</div>
          <div id="body" g_editable="true" contenteditable="true" role="textbox" aria-label="Message Body">Thanks Ada</div>
          <div><button id="send" type="button" aria-label="Send">Send</button></div></div></main>`;
    const inbox = 'https://mail.google.com/mail/u/0/#inbox/FMfc123';
    const f = await fixture(build, Agent, { url: inbox, recipients: ['ada@example.test'], html });
    try {
      assert.equal(await f.agent._messageRecipientGuardBlock(71, 'click', { selector: '#archive' }, inbox, {}), null);
    } finally { await f.browser.close(); }
  });

  // An attachment goes with the message its file input belongs to: neither
  // the Chat's input nor one no message owns goes to a compose window's
  // recipients beside it, and nothing names the Chat's person.
  test(`${build}: a file attached in a Gmail Chat never goes to a compose window's recipients`, async () => {
    const recipients = [{ identity: 'ada@example.test', role: 'to' }, { identity: 'cem@example.test', role: 'cc' }];
    const f = await fixture(build, Agent, { url: 'https://mail.google.com/mail/u/0/#chat/dm/abc', recipients,
      html: gmailChat({ rows: TO_ADA + CC_CEM, chatFile: true, appFile: true }) });
    try {
      const upload = selector => f.probe({ adapterName: 'gmail', tool: 'upload_file', args: { selector },
        uploadSourceKey: 'download:1', expectedRecipients: recipients });
      const chatUpload = await upload('#chat-file');
      assert.equal(chatUpload.recipientSets, undefined, JSON.stringify(chatUpload));
      assert.deepEqual(chatUpload.strongRecipientCandidates || [], [], JSON.stringify(chatUpload));
      assert.equal(chatUpload.messageRecipientDispatchBinding, undefined);
      const appUpload = await upload('#app-file');
      assert.equal(appUpload.recipientSets, undefined, JSON.stringify(appUpload));
      assert.deepEqual(appUpload.strongRecipientCandidates || [], [], JSON.stringify(appUpload));
      assert.equal(appUpload.messageRecipientDispatchBinding, undefined);
    } finally { await f.browser.close(); }
  });

  // An inline reply in a thread has no dialog or form of its own: its
  // recipients are the chips of the reply around its body, a form in that
  // reply included, and never those of a compose window open in the same
  // app beside the thread.
  for (const [kind, rows, recipients] of [
    ['its own To row', TO_ADA, ['ada@example.test']],
    ['no To row of its own', '<span email="ada@example.test">Ada</span>', ['cem@example.test']],
  ]) {
    test(`${build}: a Gmail inline reply with ${kind} beside an open compose window`, async () => {
      const html = `<!doctype html><style>body{margin:0;font:16px sans-serif}main{position:absolute;left:0;top:0;width:640px;height:780px}
        .reply{position:absolute;left:0;top:600px}#body{display:block;width:560px;min-height:40px}
        [role=dialog]{position:absolute;left:660px;top:20px;width:560px}</style>
        <div id="app"><main role="main"><h2>Invoice</h2><div class="message">Ada: here is the invoice</div>
          <div class="reply"><div class="rows">${rows}</div><form><input type="hidden" name="draft" value="r1"></form>
            <div id="body" g_editable="true" contenteditable="true" role="textbox" aria-label="Message Body">Thanks Ada</div>
            <div class="toolbar"><button id="send" type="button" aria-label="Send">Send</button></div></div></main>
        <div role="dialog" aria-label="New Message"><form onsubmit="return false">${CC_CEM}<input name="subjectbox" value="Other">
          <div contenteditable="true" role="textbox" aria-label="Message Body">Draft</div></form></div></div>`;
      const f = await fixture(build, Agent, { url: 'https://mail.google.com/mail/u/0/#inbox/FMfc123', recipients, html });
      try {
        const { blocked, context } = await f.bind();
        if (kind === 'its own To row') {
          assert.equal(blocked, null, JSON.stringify(blocked));
          const result = await call(f.page, 'click', { ...sendArgs, ...context });
          assert.equal(result.success, true, JSON.stringify(result));
          assert.equal(await f.page.evaluate(() => window.sent), 1);
        } else {
          // A chip that names no row is no recipient, and the window's Cc
          // row is not this reply's.
          assert.equal(blocked?.success, false, JSON.stringify(blocked));
          for (const item of blocked.recipientConfirmation?.recipients || []) assert.notEqual(item.identity, 'cem@example.test');
          assert.equal(context.messageRecipientDispatchBinding, undefined);
          assert.equal(await f.page.evaluate(() => window.sent), 0);
        }
      } finally { await f.browser.close(); }
    });
  }

  // Gmail's To field is a combobox named by its label: focused, typed into
  // and not yet a chip, it is still the reply's own row, and a hidden
  // dialog inside the reply does not end it.
  for (const [kind, rows, focus, extra] of [
    ['a chip and the focused To field', TO_ADA + TO_FIELD(''), '#to-input', ''],
    ['a typed To address, the body focused', TO_FIELD('ada@example.test'), '#body', ''],
    ['a typed To address, the To field focused', TO_FIELD('ada@example.test'), '#to-input', ''],
    ['a hidden dialog inside it', TO_ADA, '#body', '<div role="dialog" aria-label="Insert link" style="display:none"></div>'],
  ]) {
    test(`${build}: a Gmail inline reply with ${kind} binds to its own To`, async () => {
      const html = `<!doctype html><style>body{margin:0;font:16px sans-serif}main{position:absolute;left:0;top:0;width:900px;height:780px}
        .reply{position:absolute;left:0;top:560px}#body{display:block;width:560px;min-height:40px}</style>
        <main role="main"><h2>Invoice</h2><div class="message">Ada: here is the invoice</div>
          <div class="reply">${extra}<div class="rows">${rows}</div>
            <div id="body" g_editable="true" contenteditable="true" role="textbox" aria-label="Message Body">Thanks Ada</div>
            <div class="toolbar"><button id="send" type="button" aria-label="Send">Send</button></div></div></main>`;
      const f = await fixture(build, Agent, { url: 'https://mail.google.com/mail/u/0/#inbox/FMfc123', recipients: ['ada@example.test'], html });
      try {
        await f.page.locator(focus).focus();
        const { blocked, context } = await f.bind();
        assert.equal(blocked, null, JSON.stringify(blocked));
        const result = await call(f.page, 'click', { ...sendArgs, ...context });
        assert.equal(result.success, true, JSON.stringify(result));
        assert.equal(await f.page.evaluate(() => window.sent), 1);
      } finally { await f.browser.close(); }
    });
  }

  // Two replies open in one thread: each Send goes with its own reply.
  test(`${build}: two Gmail inline replies each bind their own To`, async () => {
    const html = `<!doctype html><style>body{margin:0;font:16px sans-serif}main{position:absolute;left:0;top:0;width:1200px;height:780px}
      .r1{position:absolute;left:0;top:300px}.r2{position:absolute;left:0;top:560px}.b{display:block;width:560px;min-height:40px}</style>
      <main role="main"><h2>Thread</h2>
        <div class="r1"><div class="rows">${TO_ADA}</div><div class="b" g_editable="true" contenteditable="true" role="textbox" aria-label="Message Body">To Ada</div>
          <div><button id="send" type="button" aria-label="Send">Send</button></div></div>
        <div class="r2"><div class="rows">${CC_CEM.replace('name="cc"', 'name="to"')}</div><div class="b" g_editable="true" contenteditable="true" role="textbox" aria-label="Message Body">To Cem</div>
          <div><button id="send2" type="button" aria-label="Send">Send</button></div></div></main>`;
    const url = 'https://mail.google.com/mail/u/0/#inbox/FMfc123';
    const f = await fixture(build, Agent, { url, recipients: ['ada@example.test'], html });
    try {
      const second = await f.agent._messageRecipientGuardBlock(71, 'click', { selector: '#send2' }, url, {});
      assert.deepEqual(second?.recipientConfirmation?.recipients, [{ identity: 'cem@example.test', role: 'to' }], JSON.stringify(second));
      const { blocked, context } = await f.bind();
      assert.equal(blocked, null, JSON.stringify(blocked));
      const result = await call(f.page, 'click', { ...sendArgs, ...context });
      assert.equal(result.success, true, JSON.stringify(result));
      assert.equal(await f.page.evaluate(() => window.sent), 1);
    } finally { await f.browser.close(); }
  });

  test(`${build}: a Gmail popup compose with a typed To address binds with the To field focused`, async () => {
    const html = `<!doctype html><style>body{margin:0;font:16px sans-serif}[role=dialog]{position:absolute;right:20px;bottom:0;width:560px}
      #body{display:block;width:500px;min-height:60px}</style><main role="main"><h2>Inbox</h2></main>
      <div role="dialog" aria-label="New Message">${TO_FIELD('ada@example.test')}<input name="subjectbox" value="Hi">
        <div id="body" g_editable="true" contenteditable="true" role="textbox" aria-label="Message Body">Hello</div>
        <button id="send" type="button" aria-label="Send">Send</button></div>`;
    const f = await fixture(build, Agent, { url: 'https://mail.google.com/mail/u/0/#inbox?compose=new', recipients: ['ada@example.test'], html });
    try {
      await f.page.locator('#to-input').focus();
      const { blocked, context } = await f.bind();
      assert.equal(blocked, null, JSON.stringify(blocked));
      const result = await call(f.page, 'click', { ...sendArgs, ...context });
      assert.equal(result.success, true, JSON.stringify(result));
      assert.equal(await f.page.evaluate(() => window.sent), 1);
    } finally { await f.browser.close(); }
  });

  test(`${build}: an ordinary Gmail compose still binds and sends to its own To, Cc and Bcc`, async () => {
    const recipients = [{ identity: 'ada@example.test', role: 'to' }, { identity: 'cem@example.test', role: 'cc' },
      { identity: 'dee@example.test', role: 'bcc' }];
    const f = await fixture(build, Agent, { url: 'https://mail.google.com/mail/u/0/#inbox?compose=new', recipients, html: gmailCompose(TO_ADA + CC_CEM + BCC_DEE) });
    try {
      const observed = await f.probe({ adapterName: 'gmail', expectedRecipients: recipients });
      assert.equal(observed.recipientSets, true, JSON.stringify(observed));
      assert.deepEqual(observed.strongRecipientCandidates, recipients, JSON.stringify(observed));
      const { blocked, context } = await f.bind();
      assert.equal(blocked, null, JSON.stringify(blocked));
      const result = await call(f.page, 'click', { ...sendArgs, ...context });
      assert.equal(result.success, true, JSON.stringify(result));
      assert.equal(await f.page.evaluate(() => window.sent), 1);
    } finally { await f.browser.close(); }
  });
}

test('Gmail keeps recipient sets for mail and drops them for its chat routes', async () => {
  for (const build of ['chrome', 'firefox']) {
    const { getMessageRecipientGuardPolicy } = await import(`../src/${build}/src/agent/adapters.js`);
    const mail = { adapterName: 'gmail', verifyActiveRecipient: true, deferActiveConversationUntilComposer: true };
    for (const url of ['https://mail.google.com/mail/u/0/#inbox', 'https://mail.google.com/mail/u/0/?compose=new',
      'https://mail.google.com/mail/u/0/#chats']) {
      assert.deepEqual(getMessageRecipientGuardPolicy(url), { ...mail, supportsRecipientSets: true }, `${build}: ${url}`);
    }
    // Gmail keeps compose= in the URL while any compose window is open, so
    // it says nothing about which composer sends: a compose window decides
    // that from its own To/Cc/Bcc rows.
    for (const url of ['https://mail.google.com/chat/u/0/#chat/dm/abc', 'https://mail.google.com/chat/u/0/',
      'https://mail.google.com/mail/u/0/#chat/space/AAAA', 'https://mail.google.com/mail/u/0/#chat/home',
      'https://mail.google.com/mail/u/0/#chat/home?compose=new', 'https://mail.google.com/chat/u/0/?compose=abc#chat/dm/xyz']) {
      assert.deepEqual(getMessageRecipientGuardPolicy(url), mail, `${build}: ${url}`);
    }
  }
});
