// Strict secret mode keeps a credential the agent filled into a sensitive
// field out of the scratchpad and progress ledger, which are pinned into
// every later model request and saved with the conversation. Before, strict
// handling was only an instruction to the model, and an account-creation run
// copied the user's password into both. Without strict mode nothing changes:
// a flow may deliberately keep, say, a generated password in its notes.
// The known values live in memory only; a restarted worker rebuilds them from
// the restored conversation's own fill calls.
import assert from 'node:assert/strict';
import { test } from 'node:test';

const SECRET = 'Hunter 2@xyz!';
const storage = new Map();
// The field an earlier click focused, which Firefox's selectorless type_text
// types into through the content script's `type` action.
let focusedField = null;
const area = {
  get: async key => (typeof key === 'string' ? { [key]: storage.get(key) } : {}),
  set: async values => { for (const [key, value] of Object.entries(values || {})) storage.set(key, value); },
  remove: async key => { storage.delete(key); },
};
globalThis.chrome = globalThis.browser = {
  storage: { local: area, session: area },
  runtime: { getURL: value => `extension://test/${value}`, sendMessage: async () => ({}) },
  tabs: {
    get: async id => ({ id, url: 'https://accounts.example.test/signup' }),
    // The content script's reply to a fill: the field it filled, whose
    // metadata says whether it is a credential field.
    sendMessage: async (_tab, message) => {
      if (message?.action === 'type') {
        return { success: true, verified: true, value: String(message.params?.text || '').slice(0, 100), fieldMeta: focusedField };
      }
      if (message?.action !== 'set_field') return { success: true };
      const fieldMeta = {
        ref_password: { tag: 'input', type: 'password', name: 'password' },
        ref_code: { tag: 'input', type: 'text', name: 'code', autocomplete: 'one-time-code' },
      }[message.params?.ref_id] || { tag: 'input', type: 'text', name: 'username' };
      return { success: true, verified: true, actual: message.params?.text, fieldMeta };
    },
  },
  scripting: { executeScript: async () => [{ result: null }] },
  webNavigation: { getAllFrames: async () => [{ frameId: 0 }] },
};

for (const build of ['chrome', 'firefox']) {
  const { Agent } = await import(`../src/${build}/src/agent/agent.js`);
  const { filledCredentialValuesFromHistory, isCredentialKeyName, redactCredentialValues } =
    await import(`../src/${build}/src/agent/credential-fields.js`);

  const fresh = (tab, { strict = true } = {}) => {
    storage.clear();
    const agent = new Agent({});
    agent._persist = () => {};
    agent.strictSecretMode = strict;
    agent.conversations.set(tab, [{ role: 'system', content: 'Owned system.' },
      { role: 'user', content: 'Create an account for alice on the owned fixture site.' }]);
    return agent;
  };
  const scratchpadOf = (agent, tab) => {
    const messages = agent.conversations.get(tab);
    const index = agent._findScratchpadIndex(messages);
    return index >= 0 ? agent._extractScratchpadBody(messages[index].content) : '';
  };
  const ledgerMessageOf = (agent, tab) => {
    const messages = agent.conversations.get(tab);
    const index = agent._findProgressLedgerIndex(messages);
    return index >= 0 ? messages[index].content : '';
  };
  const writeNotes = async (agent, tab) => {
    const note = await agent.executeTool(tab, 'scratchpad_write', { text: `Signed up alice with password ${SECRET}` });
    // An explicit session makes the ledger active, so its rows are pinned.
    const row = await agent.executeTool(tab, 'progress_update', { sessionId: 'owned-signup', items: [{
      id: 'alice', label: `alice / ${SECRET}`, action: 'process_item', status: 'processed', reason: `password ${SECRET} accepted`,
      url: `https://accounts.example.test/welcome?pw=${encodeURIComponent(SECRET)}`,
      fields: { password: SECRET, email: 'alice@example.test', note: `uses ${SECRET}` },
    }] });
    return { note, row };
  };

  test(`${build}: strict mode keeps a filled credential out of the scratchpad and progress ledger`, async () => {
    const agent = fresh(31);
    const fill = await agent.executeTool(31, 'set_field', { ref_id: 'ref_password', text: SECRET });
    assert.equal(fill.sensitiveField, true);
    const { note, row } = await writeNotes(agent, 31);
    assert.equal(note.success, true);
    assert.equal(note.credentialRedacted, true);
    assert.equal(row.success, true);
    assert.equal(row.credentialRedacted, true);
    assert.equal(scratchpadOf(agent, 31), 'Signed up alice with password [redacted credential]');
    const [stored] = agent.progressLedgers.get(31);
    assert.equal(stored.id, 'alice', 'The row id is its identity and stays as written');
    assert.equal(stored.label, 'alice / [redacted credential]');
    assert.equal(stored.reason, 'password [redacted credential] accepted');
    assert.equal(stored.url, 'https://accounts.example.test/welcome?pw=[redacted credential]');
    assert.deepEqual(stored.fields, { password: '[redacted credential]', email: 'alice@example.test', note: 'uses [redacted credential]' });
    // Nothing pinned into later requests or saved with the conversation
    // holds the value: the scratchpad, the ledger message and the rows.
    const pinned = agent.conversations.get(31).filter(message => agent._isPinnedAgentStateMessage(message));
    assert.equal(pinned.length, 2);
    assert.match(ledgerMessageOf(agent, 31), /alice \/ \[redacted credential\]/);
    for (const text of [JSON.stringify(pinned), ledgerMessageOf(agent, 31), JSON.stringify(agent.progressLedgers.get(31)),
      JSON.stringify(row)]) {
      assert.equal(text.includes(SECRET), false);
      assert.equal(text.includes(encodeURIComponent(SECRET)), false);
    }
  });

  test(`${build}: without strict mode the notes keep what the model wrote`, async () => {
    const agent = fresh(32, { strict: false });
    await agent.executeTool(32, 'set_field', { ref_id: 'ref_password', text: SECRET });
    const { note, row } = await writeNotes(agent, 32);
    assert.equal(note.credentialRedacted, undefined);
    assert.equal(row.credentialRedacted, undefined);
    assert.equal(scratchpadOf(agent, 32), `Signed up alice with password ${SECRET}`);
    assert.deepEqual(agent.progressLedgers.get(32)[0].fields, { password: SECRET, email: 'alice@example.test', note: `uses ${SECRET}` });
  });

  test(`${build}: strict mode redacts values filed under credential field names, and only those`, async () => {
    const agent = fresh(33);
    // Never filled into a page, so not a known value: only its key marks it.
    const row = await agent.executeTool(33, 'progress_update', { items: [{ id: 'bob', status: 'processed',
      fields: { password: 'typed-only-in-chat', otp: 482913, api_key: null, recovery_code: 'null', mfa_enabled: true,
        email: 'bob@example.test', username: 'bob' } }] });
    assert.equal(row.credentialRedacted, true);
    assert.deepEqual(agent.progressLedgers.get(33)[0].fields, { password: '[redacted credential]', otp: '[redacted credential]',
      api_key: null, recovery_code: null, mfa_enabled: true, email: 'bob@example.test', username: 'bob' });
    // A one-time code filled as text and filed back as a number under a
    // plain name is still the known value.
    await agent.executeTool(33, 'set_field', { ref_id: 'ref_code', text: '771204' });
    const code = await agent.executeTool(33, 'progress_update', { items: [{ id: 'dave', status: 'processed', fields: { code: 771204, step: 2 } }] });
    assert.equal(code.credentialRedacted, true);
    assert.deepEqual(agent.progressLedgers.get(33).find(item => item.id === 'dave').fields, { code: '[redacted credential]', step: 2 });
    // An ordinary fill is no credential, and app-owned rows keep their fields.
    await agent.executeTool(33, 'set_field', { ref_id: 'ref_username', text: 'alice-in-chains' });
    const plain = await agent.executeTool(33, 'scratchpad_write', { text: 'Username alice-in-chains is free.' });
    assert.equal(plain.credentialRedacted, undefined);
    assert.equal(scratchpadOf(agent, 33), 'Username alice-in-chains is free.');
    const auto = agent._progressUpdate(33, { items: [{ id: 'carol', status: 'acted', fields: { chatRunToken: 'run-token-1234' } }] },
      { source: 'auto' });
    assert.equal(auto.success, true);
    assert.equal(auto.credentialRedacted, undefined);
    assert.equal(agent.progressLedgers.get(33).find(item => item.id === 'carol').fields.chatRunToken, 'run-token-1234');
  });

  test(`${build}: a privately delivered Cloud result keeps its notes, and a cleared conversation forgets the values`, async () => {
    const agent = fresh(34);
    await agent.executeTool(34, 'set_field', { ref_id: 'ref_password', text: SECRET });
    agent.cloudRunContexts.set(34, { privateFinalResult: true });
    const kept = await agent.executeTool(34, 'scratchpad_write', { text: `Generated ${SECRET} for the owner` });
    assert.equal(kept.credentialRedacted, undefined);
    assert.equal(scratchpadOf(agent, 34), `Generated ${SECRET} for the owner`);
    agent.cloudRunContexts.delete(34);
    assert.equal(agent._redactKnownCredentials(34, SECRET), '[redacted credential]');
    await agent.clearConversation(34);
    assert.equal(agent._knownCredentialValues?.has(34) ?? false, false);
    assert.equal(agent._redactKnownCredentials(34, SECRET), SECRET);
  });

  test(`${build}: a forked conversation keeps redacting the credentials its copied history holds`, async () => {
    const agent = fresh(35);
    await agent.executeTool(35, 'set_field', { ref_id: 'ref_password', text: SECRET });
    // A value left on the fork's tab by an earlier conversation does not carry over.
    agent._rememberFilledCredential(36, 'set_field', { text: 'stale-value-from-before' }, { sensitiveField: true });
    await agent.forkConversation(35, 36);
    assert.deepEqual(agent._knownCredentialValues.get(36), [SECRET]);
    const forked = await agent.executeTool(36, 'scratchpad_write', { text: `Fork notes ${SECRET}` });
    assert.equal(forked.credentialRedacted, true);
    assert.equal(scratchpadOf(agent, 36).endsWith('Fork notes [redacted credential]'), true);
  });

  // What the run loop keeps of one tool call: the assistant turn that made it
  // and its result, as the provider protocol pairs them, with any note the
  // loop appends after a result it does not wrap as page content.
  const recordCall = (agent, tab, id, name, args, result, note = '') => {
    agent.conversations.get(tab).push(
      { role: 'assistant', content: null, tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] },
      { role: 'tool', tool_call_id: id, content: agent._wrapUntrusted(name, agent._limitToolResult(result)) + note });
  };
  const CAPTCHA_NOTE = '\n[TRUSTED CAPTCHA GATE: A supported verification challenge is active. Call solve_captcha once now. Do not '
    + 'dismiss or close the dialog, click Continue/Submit, or use another page-changing tool until solve_captcha returns.]';
  const NUDGE_NOTE = '\n[LOOP WARNING: You typed into the same field twice. Read the page before typing again.]';
  // The typing routes that end before the content-action annotation: their
  // results as each path reports the field it typed into.
  const typingResults = {
    // Chrome's trusted typing into the element focused by an earlier click.
    focused: text => ({ success: true, verified: true, method: 'cdp-insert-focused', text: text.slice(0, 100),
      focusedField: { tag: 'INPUT', type: 'password', name: 'pw', contentEditable: false } }),
    // The same through a dispatch binding, with the field's full metadata.
    bound: text => ({ success: true, verified: true, method: 'cdp-insert-focused', text: text.slice(0, 100),
      focusedField: { tag: 'INPUT', type: 'text', name: 'otp', contentEditable: false },
      fieldMeta: { tag: 'input', type: 'text', name: 'otp', autocomplete: 'one-time-code' } }),
    // A field in a frame, typed through the frame's content script.
    iframe: text => ({ success: true, verified: true, value: text.slice(0, 100), frameId: 3,
      fieldMeta: { tag: 'input', type: 'password', id: 'card-pin', labelText: 'Card PIN' } }),
    // Chrome's selector typing reports no field metadata: nothing shows a
    // credential field.
    selector: () => ({ success: true, verified: true, method: 'cdp-insert-text', tag: 'INPUT', rect: { x: 1, y: 1, w: 9, h: 9 } }),
    plain: text => ({ success: true, verified: true, value: text.slice(0, 100), fieldMeta: { tag: 'input', type: 'text', name: 'nickname' } }),
  };
  // A worker restart: a new agent hydrates the conversation the first one saved.
  const restart = async (first, tab, { strict = true } = {}) => {
    assert.equal((await first._persistNow(tab)).ok, true);
    const restarted = new Agent({});
    restarted._persist = () => {};
    restarted.strictSecretMode = strict;
    await restarted._hydrate(tab);
    return restarted;
  };

  test(`${build}: type_text and iframe_type fills into credential fields are remembered like set_field`, async () => {
    const agent = fresh(41);
    const results = new Map();
    const execute = agent._executeToolImpl.bind(agent);
    agent._executeToolImpl = async (tab, name, args, ...rest) => (['type_text', 'iframe_type'].includes(name)
      ? results.get(args.text) : execute(tab, name, args, ...rest));
    const fills = [
      ['type_text', 'Focused-pass 77', typingResults.focused],
      ['type_text', '480213', typingResults.bound],
      ['iframe_type', 'Pin-4471x', typingResults.iframe],
      ['type_text', 'selector-typed-secret', typingResults.selector],
      ['iframe_type', 'plain nickname', typingResults.plain],
    ];
    for (const [name, text, result] of fills) {
      results.set(text, result(text));
      await agent.executeTool(41, name, { text, ...(name === 'iframe_type' ? { selector: '#f', urlFilter: 'pay.example.test' } : {}) });
    }
    assert.deepEqual(agent._knownCredentialValues.get(41), ['Focused-pass 77', '480213', 'Pin-4471x']);
    const note = await agent.executeTool(41, 'scratchpad_write',
      { text: 'Typed Focused-pass 77, code 480213, PIN Pin-4471x, selector-typed-secret, plain nickname' });
    assert.equal(note.credentialRedacted, true);
    assert.equal(scratchpadOf(agent, 41), 'Typed [redacted credential], code [redacted credential], PIN [redacted credential], '
      + 'selector-typed-secret, plain nickname');
    if (build === 'firefox') {
      // Firefox's type_text goes through the content script, which reports
      // the field it typed into.
      const live = fresh(42);
      focusedField = { tag: 'input', type: 'password', id: 'new-password', autocomplete: 'new-password' };
      assert.equal((await live.executeTool(42, 'type_text', { text: 'Content-typed 55' })).success, true);
      focusedField = { tag: 'input', type: 'text', id: 'nickname' };
      assert.equal((await live.executeTool(42, 'type_text', { text: 'not-a-secret' })).success, true);
      assert.deepEqual(live._knownCredentialValues.get(42), ['Content-typed 55']);
    }
  });

  test(`${build}: a restarted worker rebuilds the filled credentials, also from results the run loop added notes to`, async () => {
    const first = fresh(43);
    first._persist = () => {};
    const fill = await first.executeTool(43, 'set_field', { ref_id: 'ref_password', text: SECRET });
    recordCall(first, 43, 'call_password', 'set_field', { ref_id: 'ref_password', text: SECRET }, fill);
    const plain = await first.executeTool(43, 'set_field', { ref_id: 'ref_username', text: 'alice-in-chains' });
    recordCall(first, 43, 'call_username', 'set_field', { ref_id: 'ref_username', text: 'alice-in-chains' }, plain);
    // A captcha-gated login and a retyped password: the loop appended its own
    // notes after these results.
    const gated = await first.executeTool(43, 'set_field', { ref_id: 'ref_password', text: 'Gated-pass 31' });
    recordCall(first, 43, 'call_gated', 'set_field', { ref_id: 'ref_password', text: 'Gated-pass 31' }, gated, CAPTCHA_NOTE);
    recordCall(first, 43, 'call_focused', 'type_text', { text: 'Focused-pass 77' }, typingResults.focused('Focused-pass 77'),
      NUDGE_NOTE);
    assert.equal(first.conversations.get(43).at(-1).content.endsWith(NUDGE_NOTE), true);
    const restarted = await restart(first, 43);
    const saved = JSON.stringify(storage.get(first._convKey(43)));
    // Nothing new about the values is stored: only the conversation itself.
    assert.equal(saved.includes('knownCredential'), false);
    assert.deepEqual(restarted._knownCredentialValues.get(43), [SECRET, 'Gated-pass 31', 'Focused-pass 77']);
    const note = await restarted.executeTool(43, 'scratchpad_write',
      { text: `Password ${SECRET}, then Gated-pass 31 and Focused-pass 77` });
    assert.equal(note.credentialRedacted, true);
    assert.equal(scratchpadOf(restarted, 43), 'Password [redacted credential], then [redacted credential] and [redacted credential]');
    const row = await restarted.executeTool(43, 'progress_update', { items: [{ id: 'alice', status: 'processed',
      reason: `signed in with ${SECRET}`, fields: { username: 'alice-in-chains' } }] });
    assert.equal(row.credentialRedacted, true);
    assert.equal(restarted.progressLedgers.get(43)[0].reason, 'signed in with [redacted credential]');
    assert.equal(restarted.progressLedgers.get(43)[0].fields.username, 'alice-in-chains');
    // A fork of the restored conversation keeps them too.
    await restarted.forkConversation(43, 44);
    assert.deepEqual(restarted._knownCredentialValues.get(44), [SECRET, 'Gated-pass 31', 'Focused-pass 77']);
    // A restored conversation whose fills were never sensitive knows nothing.
    const other = fresh(45);
    recordCall(other, 45, 'call_plain', 'set_field', { ref_id: 'ref_username', text: 'alice-in-chains' },
      await other.executeTool(45, 'set_field', { ref_id: 'ref_username', text: 'alice-in-chains' }));
    const otherRestarted = await restart(other, 45);
    assert.equal(otherRestarted._knownCredentialValues?.get(45), undefined);
  });

  test(`${build}: a restored conversation is scrubbed on the next write, once its run says whether it may keep notes`, async () => {
    // A Cloud run with a privately delivered result generated a password and
    // noted it, as it may.
    const first = fresh(50);
    first._persist = () => {};
    first.cloudRunContexts.set(50, { privateFinalResult: true });
    const fill = await first.executeTool(50, 'set_field', { ref_id: 'ref_password', text: SECRET });
    recordCall(first, 50, 'call_password', 'set_field', { ref_id: 'ref_password', text: SECRET }, fill);
    await first.executeTool(50, 'scratchpad_write', { text: `Generated ${SECRET} for the owner` });
    // An explicit session with an action makes the ledger active, so its rows are pinned.
    await first.executeTool(50, 'progress_update', { sessionId: 'owned-cloud', items: [{ id: 'owner', action: 'process_item',
      status: 'processed', label: `owner ${SECRET}` }] });
    assert.equal(ledgerMessageOf(first, 50).includes(SECRET), true);
    for (const exempt of [true, false]) {
      // The worker restarts; hydration comes before the run sets its context.
      const restarted = await restart(first, 50);
      assert.deepEqual(restarted._knownCredentialValues.get(50), [SECRET]);
      assert.equal(scratchpadOf(restarted, 50), `Generated ${SECRET} for the owner`, 'Hydration only rebuilds the values');
      assert.equal(restarted.progressLedgers.get(50)[0].label, `owner ${SECRET}`);
      if (exempt) restarted.cloudRunContexts.set(50, { privateFinalResult: true });
      await restarted.executeTool(50, 'scratchpad_write', { text: 'Account ready.' });
      const expected = exempt ? SECRET : '[redacted credential]';
      assert.equal(scratchpadOf(restarted, 50), `Generated ${expected} for the owner\nAccount ready.`);
      assert.equal(restarted.progressLedgers.get(50)[0].label, `owner ${expected}`);
      assert.equal(ledgerMessageOf(restarted, 50).includes(SECRET), exempt);
    }
  });

  test(`${build}: only a fill call's own result says its field was sensitive`, () => {
    const call = (id, name, args) => ({ role: 'assistant', content: null,
      tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] });
    const result = (id, value, note = '') => ({ role: 'tool', tool_call_id: id, content: JSON.stringify(value) + note });
    const sensitive = { success: true, sensitiveField: true, fieldMeta: { type: 'password' } };
    // Page text in a result may hold braces and quotes.
    const tricky = { ...sensitive, fieldMeta: { type: 'password', labelText: 'Pass "word" } { [x]' } };
    const values = filledCredentialValuesFromHistory([
      { role: 'system', content: 'Owned system.' },
      call('a', 'set_field', { ref_id: 'ref_1', text: '  padded-secret  ' }), result('a', sensitive),
      // A page read that quotes a sensitive-looking result is no fill.
      call('b', 'read_page', { text: 'read-page-arg' }), result('b', sensitive),
      // A result that does not follow its call's turn pairs with nothing.
      call('c', 'set_field', { ref_id: 'ref_2', text: 'orphaned-secret' }), { role: 'user', content: 'Continue' }, result('c', sensitive),
      // Unparseable arguments or results, and values too short to redact.
      { role: 'assistant', content: null, tool_calls: [{ id: 'd', type: 'function', function: { name: 'set_field', arguments: '{broken' } }] },
      result('d', sensitive),
      call('e', 'type_ax', { ref_id: 'ref_3', text: 'type-ax-secret' }),
      { role: 'tool', tool_call_id: 'e', content: '{"success":true,"sensitiveField":tr\n[...result truncated]' },
      call('f', 'set_field', { ref_id: 'ref_4', text: '123' }), result('f', sensitive),
      call('g', 'type_text', { text: 'typed-into-otp' }), result('g', { success: true, fieldMeta: { autocomplete: 'one-time-code' } }),
      // Notes the run loop appended after the result.
      call('h', 'set_field', { ref_id: 'ref_5', text: 'gated-secret' }), result('h', tricky, CAPTCHA_NOTE),
      call('i', 'type_ax', { ref_id: 'ref_6', text: 'nudged-secret' }), result('i', sensitive, `${NUDGE_NOTE}${CAPTCHA_NOTE}`),
      call('j', 'set_field', { ref_id: 'ref_7', text: 'plain-value-1' }), result('j', { success: true }, CAPTCHA_NOTE),
    ]);
    assert.deepEqual(values, ['padded-secret', 'typed-into-otp', 'gated-secret', 'nudged-secret']);
  });

  test(`${build}: a value that becomes known is scrubbed from what the model wrote before the fill`, async () => {
    const agent = fresh(46);
    // An approved plan the app pinned, holding no credential, stays the app's as written.
    const plan = 'Approved plan: create the account for alice.';
    assert.equal(agent._scratchpadWrite(46, { text: plan }, plan).success, true);
    // The model writes down a password it generated before typing it.
    await agent.executeTool(46, 'scratchpad_write', { text: `Generated password ${SECRET} for alice` });
    // The app's own line keeps what it says, whatever matches in it.
    agent._autoScratchpadNote(46, `[auto] Text attachment(s) available in the current user turn: ${SECRET}.txt (12 chars).`);
    await agent.executeTool(46, 'progress_update', { sessionId: 'owned-signup', items: [{ id: 'alice', status: 'pending',
      label: `alice ${SECRET}`, url: `https://accounts.example.test/u/alice?ref=${encodeURIComponent(SECRET)}`,
      fields: { generated: SECRET, email: 'alice@example.test' } }] });
    agent._progressUpdate(46, { sessionId: 'owned-signup', items: [{ id: 'carol', status: 'acted', label: `carol ${SECRET}`,
      fields: { chatRunToken: 'run-token-1234' } }] }, { source: 'auto' });
    assert.equal(scratchpadOf(agent, 46).includes(SECRET), true, 'Not yet known, so kept');
    await agent.executeTool(46, 'set_field', { ref_id: 'ref_password', text: SECRET });
    const messages = agent.conversations.get(46);
    const pad = messages[agent._findScratchpadIndex(messages)];
    assert.equal(scratchpadOf(agent, 46), `${plan}\nGenerated password [redacted credential] for alice\n`
      + `[auto] Text attachment(s) available in the current user turn: ${SECRET}.txt (12 chars).`);
    assert.deepEqual(agent._scratchpadApprovedPlanRanges(pad), [{ start: 0, end: plan.length, text: plan }]);
    const rows = agent.progressLedgers.get(46);
    const alice = rows.find(row => row.id === 'alice');
    assert.equal(alice.label, 'alice [redacted credential]');
    assert.deepEqual(alice.fields, { generated: '[redacted credential]', email: 'alice@example.test' });
    // A row's url, href and target may be the runtime's and identify the row.
    assert.equal(alice.url, `https://accounts.example.test/u/alice?ref=${encodeURIComponent(SECRET)}`);
    const carol = rows.find(row => row.id === 'carol');
    assert.equal(carol.label, `carol ${SECRET}`, 'App-owned rows keep their text');
    assert.equal(carol.fields.chatRunToken, 'run-token-1234', 'App-owned rows keep their fields');
    // Without strict mode the notes stay as written.
    const loose = fresh(47, { strict: false });
    await loose.executeTool(47, 'scratchpad_write', { text: `Generated password ${SECRET}` });
    await loose.executeTool(47, 'set_field', { ref_id: 'ref_password', text: SECRET });
    assert.equal(scratchpadOf(loose, 47), `Generated password ${SECRET}`);
  });

  test(`${build}: a short or numeric value is struck only as a whole token, and a short PIN not at all`, async () => {
    const agent = fresh(51);
    // The reviewer's case: a 4-digit PIN that also occurs in a download's
    // pinned id and a file name the model noted.
    agent._pinDownloadId(51, 12024);
    await agent.executeTool(51, 'scratchpad_write', { text: 'Saved report-2024-10.pdf for the card.' });
    const before = scratchpadOf(agent, 51);
    await agent.executeTool(51, 'set_field', { ref_id: 'ref_code', text: '2024' });
    assert.deepEqual(agent._knownCredentialValues.get(51), ['2024']);
    assert.equal(scratchpadOf(agent, 51), before);
    assert.match(before, /\[auto\] Downloaded file \(downloadId 12024\)/);
    const kept = await agent.executeTool(51, 'scratchpad_write', { text: 'PIN 2024 entered; see report-2024-10.pdf.' });
    assert.equal(kept.credentialRedacted, undefined);
    // A 6-digit code is struck where it stands alone, not inside a longer number or word.
    await agent.executeTool(51, 'set_field', { ref_id: 'ref_code', text: '771204' });
    const code = await agent.executeTool(51, 'scratchpad_write', { text: 'Code 771204. Ticket 1771204 and v771204b stay.' });
    assert.equal(code.credentialRedacted, true);
    assert.equal(scratchpadOf(agent, 51).endsWith('Code [redacted credential]. Ticket 1771204 and v771204b stay.'), true);
    // A short value of letters and digits likewise; a long one anywhere.
    assert.equal(redactCredentialValues('pw x7Kq9, x7Kq9z, (x7Kq9)', ['x7Kq9']), 'pw [redacted credential], x7Kq9z, ([redacted credential])');
    assert.equal(redactCredentialValues('tokenHunter2Pass!end', ['Hunter2Pass!']), 'token[redacted credential]end');
    assert.equal(redactCredentialValues('[auto] downloaded report-2024-10.pdf downloadId=12024', ['2024']),
      '[auto] downloaded report-2024-10.pdf downloadId=12024');
  });

  test(`${build}: ledger field names say a credential precisely`, async () => {
    const credential = ['password', 'new_password', 'confirm_password', 'password_confirmation', 'password2', 'passwd', 'pwd',
      'passphrase', 'passcode', 'apiKey', 'API_KEY', 'api_key', 'apikey', 'x-api-key', 'secretKey', 'private_key', 'privateKey',
      'secret', 'client_secret', 'otp', 'otp_code', 'sms_code', 'access_code', 'verification_code', 'confirmation_code',
      'recovery_code', 'oneTimeCode', '2fa_code', 'mfa_code', 'cvc', 'cvv', 'cvv2', 'pin', 'PIN', 'pin_code', 'card_pin',
      'new_pin', 'access_token', 'accessToken', 'authToken', 'csrf_token', 'session_token', 'refresh_token', 'id_token',
      'seed_phrase', 'credentials'];
    const other = ['tokens', 'token', 'token_count', 'max_tokens', 'tokenId', 'next_page_token', 'page_token', 'chatRunToken',
      'footprint', 'screenshotPath', 'rootPath', 'slotPosition', 'lotPrice', 'secretary', 'secret_santa', 'password_hint',
      'mfa', 'mfa_enabled', 'enable_2fa', 'pincode', 'map_pin', 'zip_pin', 'pin_location', 'pinned', 'pinterest', 'spinner',
      'zip_code', 'country_code', 'promo_code', 'apiKeyId', 'bearer', 'seed', 'code', 'key', 'email', ''];
    for (const name of credential) assert.equal(isCredentialKeyName(name), true, `${name} should name a credential`);
    for (const name of other) assert.equal(isCredentialKeyName(name), false, `${name} should not name a credential`);
    const agent = fresh(48);
    const fields = { tokens: 1200, token_count: 5, next_page_token: 'CAEQAA', footprint: 'small', screenshotPath: '/tmp/shot.png',
      map_pin: 'Pier 39', pincode: '560001', password: 'typed-in-chat', password_confirmation: 'typed-in-chat',
      apiKey: 'sk-owned-fixture', otp: 482913, sms_code: '5521', pin: '4321', cvv: '123', secret: 'shh-fixture' };
    const row = await agent.executeTool(48, 'progress_update', { items: [{ id: 'run', status: 'processed', fields }] });
    assert.equal(row.credentialRedacted, true);
    assert.deepEqual(agent.progressLedgers.get(48)[0].fields, { tokens: 1200, token_count: 5, next_page_token: 'CAEQAA',
      footprint: 'small', screenshotPath: '/tmp/shot.png', map_pin: 'Pier 39', pincode: '560001',
      password: '[redacted credential]', password_confirmation: '[redacted credential]', apiKey: '[redacted credential]',
      otp: '[redacted credential]', sms_code: '[redacted credential]', pin: '[redacted credential]',
      cvv: '[redacted credential]', secret: '[redacted credential]' });
  });

  test(`${build}: overlapping known values leave no tail, and a row id stays as written`, async () => {
    assert.equal(redactCredentialValues('abcd1234wxyz', ['abcd1234', '1234wxyz']), '[redacted credential]');
    assert.equal(redactCredentialValues('pw abcd1234wxyz, then 1234wxyz and abcd1234!', ['abcd1234', '1234wxyz']),
      'pw [redacted credential], then [redacted credential] and [redacted credential]!');
    assert.equal(redactCredentialValues('ends abcdefgh-ij', ['abcdefgh-ij', 'efgh-ij']), 'ends [redacted credential]');
    const agent = fresh(49);
    await agent.executeTool(49, 'set_field', { ref_id: 'ref_password', text: 'abcd1234' });
    await agent.executeTool(49, 'set_field', { ref_id: 'ref_code', text: '1234wxyz' });
    await agent.executeTool(49, 'scratchpad_write', { text: 'Joined: abcd1234wxyz.' });
    assert.equal(scratchpadOf(agent, 49), 'Joined: [redacted credential].');
    // A row id is the row's identity and is kept as written, even when it
    // holds a known value (a documented limit of the redaction).
    await agent.executeTool(49, 'progress_update', { items: [{ id: 'abcd1234', label: 'abcd1234', status: 'processed' }] });
    assert.equal(agent.progressLedgers.get(49)[0].id, 'abcd1234');
    assert.equal(agent.progressLedgers.get(49)[0].label, '[redacted credential]');
  });
}
