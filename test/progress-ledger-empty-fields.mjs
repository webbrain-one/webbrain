import assert from 'node:assert/strict';
import { test } from 'node:test';
import { withFixedChoiceAnswers } from './semantic-decision-stub.mjs';

// A required field of an expected item that the item itself has no value for
// (a profile with no bio) is recorded by listing it in the row's emptyFields,
// and then counts as answered at done. A field that is null or absent and not
// listed was never filled and still blocks success; so does a word for
// missing ("None") that the row does not list. In both builds.
const PAGE_URL = 'https://example.com/profiles/test-account-a';
const TASK = 'List the bios of these 5 example.com profiles, one line each. Don\'t change anything.';
const EXPECTED = { count: 5, item_type: 'profile_bio', ordered: true, required_fields: ['username', 'bio'] };
const BIOS = [null, null, 'Builds command-line tools for the web.', 'Maintains a small static site generator.', null];
const NO_BIO = new Set(BIOS.flatMap((bio, index) => (bio == null ? [index + 1] : [])));

// The rows the F2 run wrote: every profile read, three with no bio.
function profileRows({ emptyFields, noBioValue = null } = {}) {
  return BIOS.map((bio, index) => ({
    id: `expected:${index + 1}`,
    label: `test-account-${'abcde'[index]}`,
    action: 'process_item',
    status: 'processed',
    fields: { username: `test-account-${'abcde'[index]}`, bio: bio ?? noBioValue },
    ...(bio == null && emptyFields ? { emptyFields } : {}),
  }));
}

function makeAgent(Agent) {
  const agent = new Agent({ getActive: () => ({ contextWindow: 128000, supportsVision: false }) });
  agent._persist = () => {};
  return agent;
}

let nextTab = 7400;
function bindExpected(agent, expected = EXPECTED) {
  const tab = nextTab++;
  agent.conversationModes.set(tab, 'act');
  agent.conversations.set(tab, [{ role: 'system', content: 'sys' }, { role: 'user', content: TASK }]);
  agent.progressExpectedItems.set(tab, { ...expected });
  const session = agent._setProgressSession(tab, {
    mode: 'active', allowedActions: ['process_item'], forbiddenActions: [], confidence: 1,
  }, { taskText: TASK, pageScope: PAGE_URL, source: 'planner' });
  assert.ok(session?.sessionId);
  agent._seedExpectedProgressItems(tab, session, expected);
  return tab;
}

function update(agent, tab, items) {
  const result = agent._progressUpdate(tab, { items });
  assert.equal(result.success, true, JSON.stringify(result));
  return result;
}

for (const build of ['chrome', 'firefox']) {
  const { Agent } = await import(`../src/${build}/src/agent/agent.js`);
  const ledger = await import(`../src/${build}/src/agent/progress-ledger.js`);
  const tools = await import(`../src/${build}/src/agent/tools.js`);

  test(`${build}: the ledger keeps a row's checked-empty field names`, () => {
    const row = ledger.normalizeLedgerItem({
      id: 'expected:1', status: 'processed', fields: { username: 'test-account-a', bio: null },
      emptyFields: ['bio', ' bio ', '', 7, 'expectedOrdinal', 'completionRequirement'],
    });
    assert.deepEqual(row.emptyFields, ['bio'], 'Names are trimmed and deduplicated; app-owned fields cannot be listed');
    assert.equal(ledger.ledgerFieldCheckedEmpty(row, 'bio'), true);
    assert.equal(ledger.ledgerFieldCheckedEmpty(row, 'username'), false);
    assert.equal(ledger.ledgerFieldCheckedEmpty({ fields: { bio: null } }, 'bio'), false, 'A null value alone is not a check');
    assert.match(ledger.formatLedgerRow(row), /\[checked empty: bio\]/);

    let rows = ledger.upsertLedgerItems([], [{ id: 'a', status: 'processed', fields: { bio: null }, emptyFields: ['bio'] }]).rows;
    assert.deepEqual(rows[0].emptyFields, ['bio']);
    rows = ledger.upsertLedgerItems(rows, [{ id: 'a', status: 'processed', fields: { username: 'test-account-a' } }]).rows;
    assert.deepEqual(rows[0].emptyFields, ['bio'], 'An update without a list keeps the row\'s list');
    rows = ledger.upsertLedgerItems(rows, [{ id: 'a', status: 'processed', emptyFields: ['email'] }]).rows;
    assert.deepEqual(rows[0].emptyFields, ['email'], 'A list replaces the row\'s list');
    rows = ledger.upsertLedgerItems(rows, [{ id: 'a', status: 'processed', emptyFields: [] }]).rows;
    assert.equal('emptyFields' in rows[0], false, 'An empty list clears it');
    rows = ledger.upsertLedgerItems([], [{ id: 'b', status: 'processed', emptyFields: [] }]).rows;
    assert.equal('emptyFields' in rows[0], false, 'A new row keeps no empty list');
    assert.equal(ledger.ledgerFieldCheckedEmpty({ emptyFields: ['Bio'] }, 'bio'), true, 'Names match ignoring case');

    // A restored ledger that folds a duplicate row into its canonical row
    // keeps what either of them listed.
    const restored = ledger.reconcilePersistedLedgerRows([
      { id: 'expected:1', label: 'test-account-a', target: 'test-account-a', status: 'pending', action: 'process_item',
        sessionId: 's1', fields: { expectedOrdinal: 1, classifierTarget: true }, emptyFields: ['email'] },
      { id: 'test-account-a', label: 'test-account-a', status: 'processed', action: 'process_item',
        sessionId: 's1', fields: { username: 'test-account-a', bio: null }, emptyFields: ['bio'] },
    ]);
    assert.equal(restored.rows.length, 1);
    assert.deepEqual(restored.rows[0].emptyFields, ['email', 'bio']);
  });

  test(`${build}: a value written later for a field listed empty takes it off the list`, () => {
    let rows = ledger.upsertLedgerItems([], [{ id: 'a', status: 'processed', fields: { bio: 'None' }, emptyFields: ['Bio', 'email'] }]).rows;
    rows = ledger.upsertLedgerItems(rows, [{ id: 'a', status: 'processed', fields: { bio: 'None', email: null } }]).rows;
    assert.deepEqual(rows[0].emptyFields, ['Bio', 'email'], 'The same value again, or null, keeps the names');
    rows = ledger.upsertLedgerItems(rows, [{ id: 'a', status: 'processed', fields: { bio: 'Writes about static sites.' } }]).rows;
    assert.deepEqual(rows[0].emptyFields, ['email'], 'A bio found later is no longer listed as checked empty');
    assert.match(ledger.formatLedgerRow(rows[0]), /\[checked empty: email\]/);
    rows = ledger.upsertLedgerItems(rows, [{ id: 'a', status: 'processed', fields: { email: 'a@example.com' } }]).rows;
    assert.equal('emptyFields' in rows[0], false, 'The last listed name taken off clears the list');
    assert.doesNotMatch(ledger.formatLedgerRow(rows[0]), /checked empty/);
    rows = ledger.upsertLedgerItems(rows, [{ id: 'a', status: 'processed', fields: { bio: 'Writes about static sites.' }, emptyFields: ['bio'] }]).rows;
    assert.deepEqual(rows[0].emptyFields, ['bio'], 'A list given with the value is taken as given');
  });

  test(`${build}: progress_update tells the model how to record a field the item has no value for`, () => {
    for (const tier of ['full', 'mid', 'compact']) {
      const tool = tools.getToolsForMode('act', { tier }).find(entry => entry.function.name === 'progress_update');
      assert.ok(tool, `${tier}: progress_update is offered`);
      const property = tool.function.parameters.properties.items.items.properties.emptyFields;
      assert.equal(property?.type, 'array', `${tier}: emptyFields is in the schema`);
      assert.equal(property.items.type, 'string');
      assert.match(property.description, /no value/);
      assert.match(property.description, /could not find, read or reach/);
    }
  });

  test(`${build}: a null required field that is not listed empty still blocks success, and the refusal says how to list it`, () => {
    const agent = makeAgent(Agent);
    const tab = bindExpected(agent);
    update(agent, tab, profileRows());
    const block = agent._expectedItemsDoneBlock(tab);
    assert.equal(block?.blocked, true);
    assert.deepEqual(block.unresolved.map(row => row.fields.expectedOrdinal), [...NO_BIO]);
    assert.match(block.error, /^Expected 5 complete profile_bio rows\. 3 row\(s\) are not processed or are missing required fields: username, bio\./);
    assert.match(block.error, /emptyFields/);
    assert.match(block.error, /could not find or read stays missing/);
  });

  test(`${build}: fields listed as checked and empty count as answered`, () => {
    const agent = makeAgent(Agent);
    const tab = bindExpected(agent);
    update(agent, tab, profileRows());
    update(agent, tab, profileRows({ emptyFields: ['bio'] }));
    assert.equal(agent._expectedItemsDoneBlock(tab), null);
    assert.equal(agent._progressDoneBlock(tab, 'success'), null);
    assert.equal(agent._shouldBlockDoneForProgress(tab), false);

    // A name written in another case lists the same required field.
    const other = makeAgent(Agent);
    const otherTab = bindExpected(other);
    update(other, otherTab, profileRows({ emptyFields: ['Bio'] }));
    assert.equal(other._expectedItemsDoneBlock(otherTab), null);
  });

  test(`${build}: a field that was never filled still counts as missing`, () => {
    const agent = makeAgent(Agent);
    const tab = bindExpected(agent);
    const rows = profileRows({ emptyFields: ['bio'] });
    // Listed empty, but its username was never written.
    delete rows[0].fields.username;
    // Never filled at all: no fields and nothing listed.
    rows[1] = { id: 'expected:2', label: 'test-account-b', action: 'process_item', status: 'processed' };
    update(agent, tab, rows);
    const block = agent._expectedItemsDoneBlock(tab);
    assert.equal(block?.blocked, true);
    assert.deepEqual(block.unresolved.map(row => row.fields.expectedOrdinal), [1, 2]);

    // A row listed empty but not processed is not complete either.
    const other = makeAgent(Agent);
    const otherTab = bindExpected(other);
    const pending = profileRows({ emptyFields: ['bio'] });
    pending[4].status = 'pending';
    update(other, otherTab, pending);
    assert.deepEqual(other._expectedItemsDoneBlock(otherTab)?.unresolved.map(row => row.fields.expectedOrdinal), [5]);
  });

  test(`${build}: a word for missing stays missing unless the row lists the field as empty`, async () => {
    for (const listed of [false, true]) {
      const agent = makeAgent(Agent);
      const tab = bindExpected(agent);
      const asked = [];
      // The decision model reads "None" as only saying the bio is missing.
      agent._semanticDecisions = async (_tab, kind, { items }) => {
        asked.push(...items.map(item => `${kind}:${item.field}=${item.value}`));
        return items.map(item => ({ choice: item.value === 'None' ? 'missing' : 'value' }));
      };
      update(agent, tab, profileRows({ noBioValue: 'None', ...(listed ? { emptyFields: ['bio'] } : {}) }));
      await agent._prepareMissingValueReadings(tab);
      if (listed) {
        assert.equal(asked.includes('missing_value:bio=None'), false, 'A field listed empty needs no reading');
        assert.ok(asked.includes('missing_value:username=test-account-a'), 'Other required values are still read');
        assert.equal(agent._expectedItemsDoneBlock(tab), null);
      } else {
        assert.ok(asked.includes('missing_value:bio=None'));
        assert.equal(agent._expectedItemsDoneBlock(tab)?.unresolved.length, 3);
      }
    }
  });

  test(`${build}: items with no value for the first required field are not duplicates of each other`, () => {
    const expected = { count: 3, item_type: 'profile_email', ordered: true, required_fields: ['email'] };
    const rows = emails => emails.map((email, index) => ({
      id: `expected:${index + 1}`, label: `test-account-${'abc'[index]}`, action: 'process_item', status: 'processed',
      fields: { email }, ...(email == null ? { emptyFields: ['email'] } : {}),
    }));
    const agent = makeAgent(Agent);
    const tab = bindExpected(agent, expected);
    update(agent, tab, rows([null, 'a@example.com', null]));
    assert.equal(agent._expectedItemsDoneBlock(tab), null);

    const repeated = makeAgent(Agent);
    const repeatedTab = bindExpected(repeated, expected);
    update(repeated, repeatedTab, rows([null, 'a@example.com', 'a@example.com']));
    assert.match(repeated._expectedItemsDoneBlock(repeatedTab)?.error || '', /non-duplicated email values/,
      'Two items with the same value are still duplicates');

    // Rows that list the field as empty but hold the same value are the same
    // item recorded twice, and are still caught.
    const listed = makeAgent(Agent);
    const listedTab = bindExpected(listed, expected);
    update(listed, listedTab, rows([null, 'a@example.com', 'a@example.com'])
      .map(row => ({ ...row, emptyFields: ['email'] })));
    assert.match(listed._expectedItemsDoneBlock(listedTab)?.error || '', /non-duplicated email values/,
      'Listing the field does not hide a repeated value');
  });
}

// A whole act run of the F2 shape: every profile read, the first ledger
// update leaves the three missing bios null, success is refused once with the
// note on emptyFields, the model lists them, and the run ends a success with
// no caveat.
function makeIntegrationAgent(Agent, next) {
  const answered = withFixedChoiceAnswers(next, { missing_value: 'value' });
  const provider = {
    name: 'empty field regression', model: 'test', promptTier: 'full', contextWindow: 128000,
    supportsTools: true, supportsVision: false,
    chat: (messages, options) => answered(messages, options),
  };
  const agent = new Agent({ getActive: () => provider, getProvider: () => provider, getVisionProvider: async () => null });
  for (const name of ['_hydrate', '_persistSubmittedTurn', '_endTraceRun', '_manageContext', '_maybeEmitAskModeHandoff',
    '_maybeReinjectAdapter']) agent[name] = async () => {};
  agent._persist = () => {};
  agent._persistNow = async () => ({ ok: true });
  agent._startTraceRun = async () => null;
  agent._beginReadCompleteness = async () => null;
  agent._checkCostAllowance = async () => null;
  agent._recordCostUsage = async () => null;
  agent._currentUrl = async () => PAGE_URL;
  agent._getTabUrlTitle = async () => ({ tabUrl: PAGE_URL, tabTitle: 'Profile' });
  agent._enrichUserMessageWithCurrentPage = async (_tab, _messages, content) => ({ role: 'user', content });
  agent._plannerMode = () => 'off';
  agent._runPlannerIntentGate = async () => ({
    proceed: true, requestKind: 'execute', requiresStateChange: false, requiresSubmission: false,
    expectedItems: EXPECTED, progressLedgerPolicy: 'enabled', progressAction: 'process_item',
  });
  agent._ensureProgressSessionForCurrentTask = async (tab, opts = {}) => {
    agent.progressExpectedItems.set(tab, { ...EXPECTED });
    const session = agent._setProgressSession(tab, {
      mode: 'active', allowedActions: ['process_item'], forbiddenActions: [], confidence: 1,
    }, { taskText: opts.taskText || TASK, pageScope: PAGE_URL, source: 'planner' });
    agent._seedExpectedProgressItems(tab, session, EXPECTED);
    return session;
  };
  agent._skipPermissionGate = true;
  agent._ensureGateSetting = async () => true;
  for (const name of ['_chromeProtectedPageFailure', '_captchaMutationPreflight', '_workflowPreSubmitDispatchBlock',
    '_messageRecipientGuardBlock', '_detectLikelySubmitAction', '_socialPublicationPreSubmitBlock']) agent[name] = async () => null;
  agent._adoptLiveSocialPublishWorkflow = async () => false;
  agent._isFormValidationCandidate = () => false;
  agent._preflightRichTextToolbarTarget = async () => ({ block: null });
  agent._auditRichTextToolbarTarget = async () => {};
  agent._shouldAutoScreenshot = () => false;
  agent._pageFeedbackIdleMs = 0;
  agent._completionDoneBlock = () => null;
  agent.maxSteps = Infinity;
  return agent;
}

const call = (id, name, args) => ({ toolCalls: [{ id, function: { name, arguments: JSON.stringify(args) } }] });
const SUMMARY = BIOS.map((bio, index) => `${index + 1}. test-account-${'abcde'[index]}: ${bio ?? 'no bio'}`).join('\n');
const profileApiUrl = index => `https://example.com/api/users/test-account-${'abcde'[index]}`;

for (const build of ['chrome', 'firefox']) {
  const { Agent } = await import(`../src/${build}/src/agent/agent.js`);

  // The first name is progress-success-claim-checks' mustNotBlock test.
  for (const [listedFirst, name] of [
    [true, 'a read-only profile list with no-bio profiles ends a success when the first update lists them'],
    [false, 'a read-only profile list with no-bio profiles ends a success after one refusal'],
  ]) test(`${build}: ${name}`, async () => {
    const tab = nextTab++, toolResults = [];
    let requests = 0;
    // The profiles are read from the site's API, as the F2 run did.
    const reads = BIOS.map((_bio, index) => () => call(`read-${index + 1}`, 'fetch_url', { url: profileApiUrl(index) }));
    const script = [...reads, ...(listedFirst
      ? [
        () => call('record', 'progress_update', { items: profileRows({ emptyFields: ['bio'] }) }),
        () => call('finish', 'done', { summary: SUMMARY, outcome: 'success' }),
      ]
      : [
        () => call('record', 'progress_update', { items: profileRows() }),
        () => call('finish', 'done', { summary: SUMMARY, outcome: 'success' }),
        () => call('record-empty', 'progress_update', { items: profileRows({ emptyFields: ['bio'] }) }),
        () => call('finish-again', 'done', { summary: SUMMARY, outcome: 'success' }),
      ])];
    const next = async () => {
      const step = script[requests++];
      assert.ok(step, 'The run asked for more steps than the script has');
      return step();
    };
    const agent = makeIntegrationAgent(Agent, next);
    agent.executeTool = async (_tab, name, args) => {
      if (name === 'done') return { done: true, success: true, summary: args.summary, outcome: args.outcome };
      if (name === 'progress_update') return agent._progressUpdate(_tab, args);
      assert.equal(name, 'fetch_url');
      const index = BIOS.findIndex((_bio, i) => profileApiUrl(i) === args.url);
      assert.ok(index >= 0, `unexpected read ${args.url}`);
      const json = JSON.stringify({ login: `test-account-${'abcde'[index]}`, bio: BIOS[index] });
      return { success: true, status: 200, contentType: 'application/json', url: args.url, json,
        offset: 0, maxChars: json.length, originalLength: json.length, nextOffset: null, hasMore: false, truncated: false };
    };
    const onUpdate = (type, data) => {
      if (type === 'tool_result') toolResults.push(data);
    };
    const result = await agent.processMessage(tab, TASK, onUpdate, 'act', [], { detachedRequestId: `empty-${build}-${listedFirst}` });
    const doneResults = JSON.stringify(toolResults.filter(entry => entry.name === 'done'));
    // The F2 run ended partial, with the caveat added to a correct answer.
    assert.doesNotMatch(result, /could not verify everything/i, 'Success is not downgraded with a caveat');
    assert.equal(result.split('\n\nProgress ledger:')[0], SUMMARY);
    assert.match(result, /5 row\(s\), 5 processed/);
    const outcomes = toolResults.filter(entry => entry.name === 'done' && entry.result?.done).map(entry => entry.result.outcome);
    assert.deepEqual(outcomes, ['success'], doneResults);
    assert.equal(requests, script.length, doneResults);
    const refusals = toolResults.filter(entry => entry.name === 'done' && entry.result?.progressLedgerBlock);
    assert.equal(refusals.length, listedFirst ? 0 : 1);
    if (!listedFirst) assert.match(refusals[0].result.error, /emptyFields/);
  });
}
