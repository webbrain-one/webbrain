// "Ask instead of block" (guard-policy.js onCannotDecide 'ask'): when one of
// WebBrain's quality checks cannot verify a consequential step (a GitHub
// commit of an editor whose readback was inexact, a commit-capable action it
// cannot classify, an X/Bluesky draft it could not confirm, an unidentified
// control after a correction), it shows the user what the page holds now and
// asks "go ahead?" on its own card instead of refusing. A quality card follows
// the clarify timeout ('finish' goes ahead, 'safe' does not); a hard check's
// card never answers itself. Strict checks keep the refusal, without a card.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test, { after, before } from 'node:test';
import { chromium } from 'playwright';
import { makeSchedulerHarness } from './lib/scheduler-harness.mjs';

const EDIT_URL = 'https://github.com/Example/Repo/edit/main/docs/post.md';
const area = { get: async () => ({}), set: async () => {}, remove: async () => {} };
const api = {
  storage: { local: area, session: area },
  runtime: { getURL: value => `extension://test/${value}`, sendMessage: async () => ({}) },
  tabs: {
    get: async id => ({ id, url: EDIT_URL, title: 'Edit post.md' }),
    query: async () => [],
    sendMessage: async () => ({ ready: true }),
  },
  webNavigation: { getAllFrames: async () => [{ frameId: 0, parentFrameId: -1, documentId: 'document-1', url: EDIT_URL }] },
  scripting: { executeScript: async () => [{ result: null }] },
};
globalThis.chrome = api;
globalThis.browser = api;

const read = rel => fs.readFile(new URL(`../${rel}`, import.meta.url), 'utf8');
const builds = await Promise.all(['chrome', 'firefox'].map(async build => ({
  build,
  Agent: (await import(`../src/${build}/src/agent/agent.js`)).Agent,
  step: await import(`../src/${build}/src/agent/unverified-step.js`),
  adapters: await import(`../src/${build}/src/agent/adapters.js`),
  Scheduler: await import(`../src/${build}/src/agent/scheduler.js`),
})));

let nextTab = 9600;
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const call = (id, name, args) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
const COMMIT_REQUEST = { guardId: 'github-commit-evidence-binding', hard: false, action: 'commit', host: 'github.com',
  reason: 'editor_unverified', content: '# Release notes\n\nEverything new.', contentLabel: 'editor' };
const POST_BODY = '# Release notes\n\nEverything new in 35.0.\n';
const EDITOR_META = { tag: 'div', contentEditable: true, codeMirror: true, ariaLabelledByText: 'Editing file contents' };
const MESSAGE_META = { tag: 'input', contentEditable: false, id: 'commit-message-input', labelText: 'Commit message' };

// Tool results may carry appended notes or an untrusted-data envelope.
function parse(message) {
  const text = typeof message?.content === 'string' ? message.content : '';
  for (let start = text.indexOf('{'); start >= 0; start = text.indexOf('{', start + 1)) {
    let depth = 0, quoted = false, escaped = false;
    for (let cursor = start; cursor < text.length; cursor++) {
      const char = text[cursor];
      if (quoted) { if (escaped) escaped = false; else if (char === '\\') escaped = true; else if (char === '"') quoted = false; }
      else if (char === '"') quoted = true;
      else if (char === '{') depth++;
      else if (char === '}' && --depth === 0) {
        try { return JSON.parse(text.slice(start, cursor + 1)); } catch { break; }
      }
    }
  }
  return null;
}
const resultFor = (messages, id) => parse(messages.find(message => message.role === 'tool' && message.tool_call_id === id));

test('both builds share the unverified-step card module', async () => {
  assert.equal(await read('src/chrome/src/agent/unverified-step.js'), await read('src/firefox/src/agent/unverified-step.js'));
  const { clipUnverifiedStepContent, normalizeUnverifiedStepConfirmation, UNVERIFIED_STEP_CONTENT_LIMIT } = builds[0].step;
  const long = 'a'.repeat(UNVERIFIED_STEP_CONTENT_LIMIT - 1) + '😀' + 'tail';
  const clipped = clipUnverifiedStepContent(long);
  assert.equal(clipped, `${'a'.repeat(UNVERIFIED_STEP_CONTENT_LIMIT - 1)}…`, 'cut before a split emoji, with an ellipsis');
  assert.equal(clipUnverifiedStepContent(clipped), clipped, 'clipping twice changes nothing');
  assert.equal(clipUnverifiedStepContent('a\r\nb'), 'a\nb');
  assert.deepEqual(normalizeUnverifiedStepConfirmation({ guardId: 'x', action: 'purchase', reason: '<b>', host: 'h',
    content: 'c', contentLabel: 'nope', hard: 'yes', extra: 1 }),
  { guardId: 'x', hard: false, action: 'submit', host: 'h', reason: 'step_unverified', content: 'c', contentLabel: 'page' });
  // The hard-class asks for dead ends keep their vocabulary too.
  for (const step of [
    { guardId: 'deletion-guard-refusal', hard: true, action: 'delete', host: 'mail.example', reason: 'delete_unbound', content: '', contentLabel: 'page' },
    { guardId: 'recipient-guard-refusal', hard: true, action: 'send', host: 'example.test', reason: 'recipient_unreadable', content: 'Hi', contentLabel: 'composer' },
    { guardId: 'steer-prior-submission-unreconciled', hard: true, action: 'submit', host: 'cms.example',
      reason: 'prior_submission_unreconciled', content: 'POST https://cms.example/api', contentLabel: 'request' },
  ]) assert.deepEqual(normalizeUnverifiedStepConfirmation(step), step);
  // The sign-in password card (credential-not-provided) keeps its vocabulary,
  // so a scheduled run's card is restored as it was shown.
  const typing = { guardId: 'credential-not-provided', hard: true, action: 'type', host: 'localhost',
    reason: 'credential_not_provided', content: 'a••••', contentLabel: 'masked' };
  assert.deepEqual(normalizeUnverifiedStepConfirmation(typing), typing);
  assert.deepEqual(normalizeUnverifiedStepConfirmation({ ...typing, content: '', contentLabel: 'hidden' }),
    { ...typing, content: '', contentLabel: 'hidden' });
});

for (const { build, Agent, adapters, Scheduler } of builds) {
  // ── the card ─────────────────────────────────────────────────────────────
  test(`${build}: the card shows the step and the page text, and returns the user's fixed answer`, async () => {
    const agent = new Agent({});
    agent.clarifyTimeoutSec = 30;
    const tab = nextTab++;
    for (const answer of ['once', 'deny', 'Commit it anyway']) {
      const updates = [];
      const receipt = {};
      const choice = await agent._promptUnverifiedStepConfirmation(tab, COMMIT_REQUEST, (type, data) => {
        updates.push({ type, data });
        if (type === 'clarify') agent.submitClarifyResponse(tab, data.clarifyId, answer, 'option');
      }, receipt);
      const card = updates.find(update => update.type === 'clarify').data;
      assert.equal(card.promptKind, 'unverifiedStepConfirmation');
      assert.match(card.clarifyId, /^unverified_/);
      assert.deepEqual(card.options, ['once', 'deny']);
      assert.deepEqual(card.unverifiedStepConfirmation, { guardId: 'github-commit-evidence-binding', hard: false,
        action: 'commit', host: 'github.com', reason: 'editor_unverified', content: COMMIT_REQUEST.content, contentLabel: 'editor' });
      assert.equal(card.question, 'Commit this on github.com?');
      assert.equal(card.timeoutSec, 30);
      assert.equal(card.timeoutAnswer, 'once', 'the default timeout policy finishes the task');
      assert.ok(card.deadlineTs > Date.now() + 25_000);
      assert.equal(choice, answer === 'once' ? 'once' : 'deny', 'only the fixed value goes ahead');
      assert.equal(receipt.source, 'user');
      assert.equal(agent._pendingClarifications.has(tab), false);
    }
  });

  test(`${build}: an unanswered quality card follows the timeout policy and is never the user's answer`, async () => {
    for (const [policy, expected] of [['finish', 'once'], ['safe', 'deny']]) {
      const agent = new Agent({});
      agent.clarifyTimeoutPolicy = policy;
      agent.clarifyTimeoutSec = 1;
      const tab = nextTab++;
      agent.conversations.set(tab, [{ role: 'user', content: 'Publish the post' }]);
      const updates = [];
      const receipt = {};
      const choice = await agent._promptUnverifiedStepConfirmation(tab, COMMIT_REQUEST, (type, data) => updates.push({ type, data }), receipt);
      assert.equal(choice, expected, `${policy}: the timeout's answer`);
      assert.equal(receipt.source, 'timeout');
      assert.equal(updates.find(update => update.type === 'clarify').data.timeoutAnswer, expected, `${policy}: the card counts down to it`);
      assert.deepEqual(updates.find(update => update.type === 'clarify_auto').data,
        { clarifyId: updates[0].data.clarifyId, answer: expected, source: 'timeout', timeoutSec: 1 });
      assert.equal(agent._clarificationAuthorizationGuards.has(tab), false, `${policy}: no task authority was recorded`);
      assert.deepEqual(agent.conversations.get(tab), [{ role: 'user', content: 'Publish the post' }], `${policy}: nothing joined the task`);
    }
    // The side panel's backup timer cannot pick another answer.
    const agent = new Agent({});
    agent.clarifyTimeoutPolicy = 'safe';
    agent.clarifyTimeoutSec = 30;
    const tab = nextTab++;
    const backup = await agent._promptUnverifiedStepConfirmation(tab, COMMIT_REQUEST, (type, data) => {
      if (type === 'clarify') agent.submitClarifyResponse(tab, data.clarifyId, 'once', 'timeout');
    });
    assert.equal(backup, 'deny');
    // Instant answers at once; Off waits for the user and shows no countdown.
    const instant = new Agent({});
    instant.clarifyTimeoutSec = 0;
    const instantReceipt = {};
    assert.equal(await instant._promptUnverifiedStepConfirmation(nextTab++, COMMIT_REQUEST, () => {}, instantReceipt), 'once');
    assert.equal(instantReceipt.source, 'auto');
    const off = new Agent({});
    off.clarifyTimeoutSec = 1201;
    const offTab = nextTab++;
    let offCard = null;
    const waiting = off._promptUnverifiedStepConfirmation(offTab, COMMIT_REQUEST, (type, data) => { if (type === 'clarify') offCard = data; });
    await wait(30);
    assert.equal(offCard.timeoutSec, 0);
    assert.equal(offCard.timeoutAnswer, undefined);
    assert.equal(offCard.deadlineTs, undefined);
    off.submitClarifyResponse(offTab, offCard.clarifyId, 'once', 'option');
    assert.equal(await waiting, 'once');
  });

  test(`${build}: a hard check's card never approves on its own`, async () => {
    const agent = new Agent({});
    agent.clarifyTimeoutSec = 0;
    agent.clarifyTimeoutPolicy = 'finish';
    const tab = nextTab++;
    let card = null;
    const pending = agent._promptUnverifiedStepConfirmation(tab, { ...COMMIT_REQUEST, hard: true, action: 'click',
      reason: 'repeat_unverified', content: '' }, (type, data) => { if (type === 'clarify') card = data; });
    await wait(50);
    assert.equal(card.unverifiedStepConfirmation.hard, true);
    assert.equal(card.timeoutAnswer, undefined, 'no countdown');
    assert.equal(card.deadlineTs, undefined);
    assert.ok(agent._pendingClarifications.get(tab)?.has(card.clarifyId), 'Instant does not answer a hard card');
    agent.submitClarifyResponse(tab, card.clarifyId, 'once', 'timeout');
    assert.equal(await pending, 'deny', 'a timeout posted by the panel is not an approval');
    // Stop cancels the card.
    let stopped = null;
    const cancelled = agent._promptUnverifiedStepConfirmation(tab, { ...COMMIT_REQUEST, hard: true }, (type, data) => { if (type === 'clarify') stopped = data; });
    await wait(10);
    assert.ok(stopped);
    agent._cancelClarifications(tab, 'aborted by user');
    assert.equal(await cancelled, null);
  });

  test(`${build}: an unattended scheduled run follows the timeout policy for quality and denies a hard card`, async () => {
    for (const [policy, hard, expected] of [['finish', false, 'once'], ['safe', false, 'deny'], ['finish', true, 'deny']]) {
      const agent = new Agent({});
      agent.clarifyTimeoutPolicy = policy;
      agent.clarifyTimeoutSec = 1201;
      const tab = nextTab++;
      agent.scheduledRunPolicies.set(tab, { requireConsequentialConfirmation: false });
      const updates = [];
      const receipt = {};
      assert.equal(await agent._promptUnverifiedStepConfirmation(tab, { ...COMMIT_REQUEST, hard }, (type, data) => updates.push({ type, data }), receipt), expected);
      assert.equal(receipt.source, 'unattended');
      assert.deepEqual(updates, [], 'nobody can answer, so no card is shown');
    }
  });

  // ── github-commit-evidence-binding ─────────────────────────────────────
  // The owner's case: the blog post went into GitHub's CodeMirror editor as a
  // full replacement, the readback (rendered text) could not verify it, and
  // path, branch and commit message bind.
  async function githubFixture({ strict = false, body = POST_BODY, live = body, message = 'Publish the post',
    requestMessage = true } = {}) {
    const provider = { name: 'ask card test', model: 'test', promptTier: 'full', contextWindow: 128000,
      supportsTools: true, supportsVision: false, chat: async () => ({ content: '' }) };
    const agent = new Agent({ getActive: () => provider, getProvider: () => provider, getVisionProvider: async () => null });
    const tab = nextTab++;
    agent.clarifyTimeoutSec = 30;
    agent._persist = () => {};
    agent._persistNow = async () => ({ ok: true });
    agent._taskTokens.set(tab, `task-${tab}`);
    const siteWorkflow = adapters.resolveAdapterWorkflowJob(EDIT_URL, 'edit-file-and-commit');
    assert.equal(siteWorkflow?.job?.id, 'edit-file-and-commit');
    const guard = { enabled: true, taskKey: `key-${tab}`, siteWorkflow,
      workflowMetadataRequirements: [{ field: 'path', value: 'docs/post.md' }, { field: 'branch', value: 'main' },
        ...(requestMessage ? [{ field: 'commit_message', value: message }] : [])],
      workflowMetadataRequirementsResolved: true, workflowMetadataRequirementsIncomplete: false };
    agent._planExecutionGuards.set(tab, guard);
    agent._lastAxScopes.set(tab, { documentToken: 'doc', pageUrl: EDIT_URL });
    agent._currentUrl = async () => EDIT_URL;
    agent._readControlEffect = async () => null;
    agent._socialPublicationPreSubmitBlock = async () => null;
    agent._captureMastodonPublicationAttempt = async () => {};
    const page = { editor: live, message, digests: [] };
    agent._textMutationValueDigest = async (_tab, target, expected = null, { preview = 0 } = {}) => {
      page.digests.push({ target, preview });
      const isMessage = target?.refId === 'ref_message';
      const value = isMessage ? page.message : page.editor;
      return { valueLength: value.length, valueSha256: await agent._sha256Text(value),
        verified: typeof expected === 'string' && expected === value, fieldMeta: isMessage ? MESSAGE_META : EDITOR_META,
        ...(preview ? { valuePreview: value.slice(0, preview) } : {}) };
    };
    // The commit message reads back exactly: a verified proof.
    const messageTarget = agent._textMutationTarget(tab, 'set_field', { ref_id: 'ref_message' });
    agent._verifiedTextReplacements.set(tab, new Map([[messageTarget.key,
      await agent._verifiedTextReplacementRecord(tab, messageTarget, message, MESSAGE_META)]]));
    // The editor write went out but read back inexactly: PR B records it
    // (default mode) instead of arming text-write debt.
    const written = await agent._finalizeTextMutationResult(tab, 'type_ax', { ref_id: 'ref_editor', text: body, clear: true }, {
      success: false, dispatched: true, verified: false, fieldMeta: EDITOR_META, readbackExact: false,
      unverified: { reason: 'readback_mismatch', reader: 'rendered' },
      error: 'The field value still did not exactly match after trusted typing.' });
    assert.equal(written.unverifiedWrite, true, 'the write is an unverified success');
    assert.ok(agent._unverifiedTextWriteRecord(tab, { pageUrl: EDIT_URL }), 'the unverified write is recorded');
    agent.strictGuards = strict;
    return { agent, tab, guard, page, provider };
  }
  const commitDetected = () => ({ isSubmit: true, validationSubmitEvidence: 'strong', host: 'github.com', url: EDIT_URL,
    fields: [{ label: 'Commit message', id: 'commit-message-input' }] });

  test(`${build}: a commit whose editor text could not be read back exactly asks with the editor's text`, async () => {
    const { agent, tab } = await githubFixture();
    const block = await agent._workflowPreSubmitDispatchBlock(tab, 'click_ax', { ref_id: 'ref_7' }, commitDetected());
    assert.equal(block.noDispatch, true, 'without a card channel the refusal stands');
    assert.match(block.error, /Commit submission is blocked/);
    assert.deepEqual({ ...block.unverifiedStepConfirmation, stepKey: !!block.unverifiedStepConfirmation.stepKey }, {
      guardId: 'github-commit-evidence-binding', hard: false, action: 'commit', reason: 'editor_unverified', host: 'github.com',
      contentLabel: 'editor', target: { locatorType: 'ax', refId: 'ref_editor', ambiguous: false }, expectKind: 'github-editor',
      requireContent: true, stepKey: true });
    // Strict checks: the guard's refusal itself is under test.
    const strict = await githubFixture({ strict: true });
    const refused = await strict.agent._workflowPreSubmitDispatchBlock(strict.tab, 'click_ax', { ref_id: 'ref_7' }, commitDetected());
    assert.equal(refused.noDispatch, true);
    assert.equal(refused.unverifiedStepConfirmation, undefined, 'Strict checks refuse without a card');
  });

  test(`${build}: a missing write, unresolved metadata or an unproven commit message still refuse without a card`, async () => {
    const noWrite = await githubFixture();
    noWrite.agent._unverifiedTextWrites.delete(noWrite.tab);
    const missing = await noWrite.agent._workflowPreSubmitDispatchBlock(noWrite.tab, 'click_ax', { ref_id: 'ref_7' }, commitDetected());
    assert.equal(missing.noDispatch, true);
    assert.equal(missing.unverifiedStepConfirmation, undefined, 'no write');
    const metadata = await githubFixture();
    metadata.guard.workflowMetadataRequirementsIncomplete = true;
    const unresolved = await metadata.agent._workflowPreSubmitDispatchBlock(metadata.tab, 'click_ax', { ref_id: 'ref_7' }, commitDetected());
    assert.equal(unresolved.unverifiedStepConfirmation, undefined, 'unresolved metadata');
    const message = await githubFixture();
    message.agent._verifiedTextReplacements.delete(message.tab);
    const unproven = await message.agent._workflowPreSubmitDispatchBlock(message.tab, 'click_ax', { ref_id: 'ref_7' }, commitDetected());
    assert.equal(unproven.unverifiedStepConfirmation, undefined, 'the commit message is not proven');
    const appended = await githubFixture();
    const record = [...appended.agent._unverifiedTextWrites.get(appended.tab).values()][0];
    record.replacesValue = false;
    const append = await appended.agent._workflowPreSubmitDispatchBlock(appended.tab, 'click_ax', { ref_id: 'ref_7' }, commitDetected());
    assert.equal(append.unverifiedStepConfirmation, undefined, 'an append says nothing about the whole file');
  });

  // The batch harness reaches the real pre-dispatch checks and the real
  // card; only the page dispatch itself is recorded.
  function pipeline(agent, provider, answer) {
    agent._skipPermissionGate = true;
    agent._ensureGateSetting = async () => true;
    for (const name of ['_chromeProtectedPageFailure', '_captchaMutationPreflight', '_messageRecipientGuardBlock']) agent[name] = async () => null;
    agent._detectLikelySubmitAction = async () => commitDetected();
    agent._captureFormValidationState = async () => [];
    agent._waitForFormValidationFailure = async () => null;
    agent._readCompletionResult = async () => null;
    agent._adoptLiveSocialPublishWorkflow = async () => false;
    agent._auditRichTextToolbarTarget = async () => {};
    agent._shouldAutoScreenshot = () => false;
    agent._refreshPageFeedbackForCall = async () => false;
    const dispatched = [];
    const cards = [];
    agent._executeToolWithLifecycleInner = async (_tab, name, args) => {
      dispatched.push({ name, args });
      return { success: true, dispatched: true, verified: true };
    };
    const run = async (tab, calls) => {
      const messages = [];
      const onUpdate = (type, data) => {
        if (type !== 'clarify') return;
        cards.push(data);
        if (typeof answer === 'string') agent.submitClarifyResponse(tab, data.clarifyId, answer, 'option');
      };
      const outcome = await agent._executeToolBatch(tab, calls, messages, onUpdate, provider, null, new Set(['click_ax', 'execute_js', 'done']), 1, {});
      return { messages, outcome };
    };
    return { dispatched, cards, run };
  }

  test(`${build}: 'once' lets the commit go ahead, marks the attempt unverified, and the raw-blob check stays the authority`, async () => {
    const { agent, tab, provider } = await githubFixture({ live: POST_BODY.replace('\n\n', '\n\n\n') });
    const { dispatched, cards, run } = pipeline(agent, provider, 'once');
    const { messages } = await run(tab, [call('commit', 'click_ax', { ref_id: 'ref_7' })]);
    assert.equal(cards.length, 1, 'one card');
    assert.equal(cards[0].unverifiedStepConfirmation.content, POST_BODY.replace('\n\n', '\n\n\n'), 'the card shows the editor as it reads now');
    assert.equal(cards[0].unverifiedStepConfirmation.reason, 'editor_unverified');
    assert.deepEqual(dispatched.map(item => item.name), ['click_ax'], 'the commit was dispatched');
    const result = resultFor(messages, 'commit');
    assert.equal(result.success, true);
    const note = result.guardAdvisories.find(item => item.guard === 'github-commit-evidence-binding')?.note || '';
    assert.match(note, /the user approved it on WebBrain's card/);
    assert.doesNotMatch(note, /Release notes/, 'the page text never reaches the model');
    const submit = agent._completionSubmitStates.get(tab);
    assert.equal(submit.publishesUnverifiedContent, true);
    const commit = submit.workflowBinding.githubFileCommit;
    assert.equal(commit.editorReadbackVerified, false);
    assert.equal(commit.publishesUnverifiedContent, true);
    assert.equal(commit.unverifiedApprovalSource, 'user');
    assert.equal(commit.expectedSha256, await agent._sha256Text(POST_BODY), 'the requested text is what the commit must contain');
    assert.equal(commit.expectedLength, POST_BODY.length);
    // After the commit, the committed raw file decides.
    const sha = '0123456789abcdef0123456789abcdef01234567';
    const commitUrl = `https://github.com/Example/Repo/commit/${sha}`;
    const originalFetch = globalThis.fetch;
    let served = POST_BODY;
    globalThis.fetch = async url => url === `https://github.com/example/repo/raw/${sha}/docs/post.md`
      ? { ok: true, status: 200, headers: { get: () => String(served.length) }, text: async () => served }
      : { ok: false, status: 404, headers: { get: () => '0' }, text: async () => '' };
    try {
      const evidence = { verifiedFinalSubmit: true, submit: { workflowBinding: submit.workflowBinding } };
      const pageState = { workflowPageText: 'Publish the post', workflowResourceUrls: [commitUrl] };
      assert.equal((await agent._githubCommittedFileVerification(tab, pageState, commitUrl, evidence)).verified, true);
      served = POST_BODY.replace('\n\n', '\n\n\n');
      assert.equal((await agent._githubCommittedFileVerification(tab, pageState, commitUrl, evidence)).verified, false,
        'a committed file that differs from the request is still caught');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test(`${build}: 'deny' refuses the commit, and the same text is not asked about again`, async () => {
    const { agent, tab, provider } = await githubFixture();
    const { dispatched, cards, run } = pipeline(agent, provider, 'deny');
    const first = await run(tab, [call('commit-1', 'click_ax', { ref_id: 'ref_7' })]);
    const refused = resultFor(first.messages, 'commit-1');
    assert.equal(dispatched.length, 0);
    assert.equal(refused.noDispatch, true);
    assert.equal(refused.unverifiedStepDeclined, true);
    assert.match(refused.error, /The user chose not to go ahead with the editor text WebBrain could not verify/);
    assert.equal(refused.unverifiedStepConfirmation, undefined);
    const second = await run(tab, [call('commit-2', 'click_ax', { ref_id: 'ref_7' })]);
    assert.equal(cards.length, 1, 'the declined text is not asked about again');
    assert.match(resultFor(second.messages, 'commit-2').error, /already chose not to go ahead/);
    assert.equal(dispatched.length, 0);
  });

  // A trusted Continue (the app's Continue after the step limit) starts a new
  // run of the same task: a new plan guard, built from what the last run
  // carried. The planner resolves the commit's metadata in each run; the
  // fixture's requirements stand in for it.
  function planGuard(agent, tab, { trustedContinuation = false } = {}) {
    const previous = agent._planExecutionGuards.get(tab);
    const guard = agent._startPlanExecutionGuard(tab, 'act', { requestKind: 'execute', siteWorkflow: previous.siteWorkflow,
      requiresStateChange: true, requiresSubmission: true }, trustedContinuation ? { trustedContinuation: true } : {});
    Object.assign(guard, { workflowMetadataRequirements: previous.workflowMetadataRequirements.map(item => ({ ...item })),
      workflowMetadataRequirementsResolved: true, workflowMetadataRequirementsIncomplete: false });
    return guard;
  }
  const continueTask = (agent, tab) => {
    agent._storeContinuationExecutionEvidence(tab);
    return planGuard(agent, tab, { trustedContinuation: true });
  };

  test(`${build}: a denied commit stays denied after Continue of the same task, even when a timeout would go ahead`, async () => {
    const { agent, tab, provider, page } = await githubFixture();
    const first = planGuard(agent, tab);
    const denied = pipeline(agent, provider, 'deny');
    await denied.run(tab, [call('commit-1', 'click_ax', { ref_id: 'ref_7' })]);
    assert.equal(denied.cards.length, 1);
    assert.equal(denied.dispatched.length, 0);
    const continued = continueTask(agent, tab);
    assert.notEqual(continued, first, 'the continued run has its own plan guard');
    assert.deepEqual(continued.unverifiedStepDecisions.map(entry => [entry.choice, entry.source]), [['deny', 'user']]);
    // Nobody answers now, and the timeout setting would let a card go ahead.
    agent.clarifyTimeoutPolicy = 'finish';
    agent.clarifyTimeoutSec = 1;
    const unanswered = pipeline(agent, provider, null);
    const { messages } = await unanswered.run(tab, [call('commit-2', 'click_ax', { ref_id: 'ref_7' })]);
    assert.equal(unanswered.cards.length, 0, 'the declined text is not asked about again');
    assert.equal(unanswered.dispatched.length, 0, 'the commit never goes ahead');
    const refused = resultFor(messages, 'commit-2');
    assert.equal(refused.unverifiedStepDeclined, true);
    assert.match(refused.error, /The user already chose not to go ahead/);
    // Different editor text is a different step to ask about.
    page.editor = `${POST_BODY}Late edit.\n`;
    const changed = pipeline(agent, provider, 'once');
    await changed.run(tab, [call('commit-3', 'click_ax', { ref_id: 'ref_7' })]);
    assert.equal(changed.cards.length, 1, 'changed content is asked about again');
    assert.equal(changed.cards[0].unverifiedStepConfirmation.content, page.editor);
    assert.equal(changed.dispatched.length, 1);
  });

  test(`${build}: a denial is not carried into a run that is not a Continue, and a timeout's answer is not carried at all`, async () => {
    // An ordinary new run (not the app's Continue) builds its guard afresh.
    const fresh = await githubFixture();
    planGuard(fresh.agent, fresh.tab);
    await pipeline(fresh.agent, fresh.provider, 'deny').run(fresh.tab, [call('commit-1', 'click_ax', { ref_id: 'ref_7' })]);
    fresh.agent._storeContinuationExecutionEvidence(fresh.tab);
    const next = planGuard(fresh.agent, fresh.tab);
    assert.deepEqual(next.unverifiedStepDecisions, []);
    const asked = pipeline(fresh.agent, fresh.provider, 'once');
    await asked.run(fresh.tab, [call('commit-2', 'click_ax', { ref_id: 'ref_7' })]);
    assert.equal(asked.cards.length, 1, 'a new run asks the user again');
    assert.equal(asked.dispatched.length, 1);
    // An unanswered card under "Play it safe" is WebBrain's answer, not the
    // user's: the continued run asks the user instead of refusing for them.
    const timed = await githubFixture();
    planGuard(timed.agent, timed.tab);
    timed.agent.clarifyTimeoutPolicy = 'safe';
    timed.agent.clarifyTimeoutSec = 1;
    const unanswered = pipeline(timed.agent, timed.provider, null);
    await unanswered.run(timed.tab, [call('commit-1', 'click_ax', { ref_id: 'ref_7' })]);
    assert.equal(unanswered.dispatched.length, 0);
    assert.equal(timed.agent._planExecutionGuards.get(timed.tab).unverifiedStepDecisions[0].source, 'timeout');
    const continued = continueTask(timed.agent, timed.tab);
    assert.deepEqual(continued.unverifiedStepDecisions, []);
    const answered = pipeline(timed.agent, timed.provider, 'once');
    await answered.run(timed.tab, [call('commit-2', 'click_ax', { ref_id: 'ref_7' })]);
    assert.equal(answered.cards.length, 1, 'the user is asked again after Continue');
    assert.equal(answered.dispatched.length, 1);
  });

  test(`${build}: a one-use answer carried by Continue stays one-use`, async () => {
    const { agent, tab } = await githubFixture();
    planGuard(agent, tab);
    const remember = (stepKey, choice) => agent._rememberUnverifiedStepDecision(tab,
      { guardId: 'github-commit-split-write-required', stepKey }, { sha256: '', length: null }, choice, 'user');
    remember('step-used', 'once');
    assert.ok(agent._unverifiedStepApproval(tab, 'github-commit-split-write-required', 'step-used', { consume: true }));
    remember('step-unused', 'once');
    continueTask(agent, tab);
    assert.equal(agent._unverifiedStepApproval(tab, 'github-commit-split-write-required', 'step-used', { consume: true }), null,
      'an approval used before Continue is not usable again');
    assert.ok(agent._unverifiedStepApproval(tab, 'github-commit-split-write-required', 'step-unused', { consume: true }),
      'an approval not yet used covers its one action');
    assert.equal(agent._unverifiedStepApproval(tab, 'github-commit-split-write-required', 'step-unused', { consume: true }), null);
  });

  test(`${build}: an unanswered commit card goes ahead under 'finish' and not under 'safe'`, async () => {
    for (const [policy, goesAhead] of [['finish', true], ['safe', false]]) {
      const { agent, tab, provider } = await githubFixture();
      agent.clarifyTimeoutPolicy = policy;
      agent.clarifyTimeoutSec = 1;
      const { dispatched, cards, run } = pipeline(agent, provider, null);
      const { messages } = await run(tab, [call('commit', 'click_ax', { ref_id: 'ref_7' })]);
      assert.equal(cards[0].timeoutAnswer, goesAhead ? 'once' : 'deny');
      assert.equal(dispatched.length, goesAhead ? 1 : 0, `${policy}: dispatch`);
      const result = resultFor(messages, 'commit');
      if (goesAhead) {
        assert.match(result.guardAdvisories.find(item => item.guard === 'github-commit-evidence-binding').note,
          /nobody answered WebBrain's question in time/);
        assert.equal(agent._completionSubmitStates.get(tab).workflowBinding.githubFileCommit.unverifiedApprovalSource, 'timeout');
      } else {
        assert.match(result.error, /Nobody answered WebBrain's question in time/);
      }
    }
  });

  test(`${build}: an answer covers the editor text the user saw; a changed editor is asked about again`, async () => {
    const { agent, tab, provider, page } = await githubFixture();
    const { dispatched, cards, run } = pipeline(agent, provider, 'once');
    await run(tab, [call('commit-1', 'click_ax', { ref_id: 'ref_7' })]);
    assert.equal(dispatched.length, 1);
    // The editor changes after the answer: the next commit asks again.
    page.editor = `${POST_BODY}Late edit.\n`;
    await run(tab, [call('commit-2', 'click_ax', { ref_id: 'ref_7' })]);
    assert.equal(cards.length, 2);
    assert.equal(cards[1].unverifiedStepConfirmation.content, page.editor);
    assert.equal(dispatched.length, 2);
  });

  test(`${build}: an editor that changes while a later card waits is checked again right before the commit`, async () => {
    for (const changes of [true, false]) {
      const { agent, tab, provider, page } = await githubFixture();
      const { dispatched, cards, run } = pipeline(agent, provider, 'once');
      // The submit confirmation and the permission card come after the
      // unverified-step card; the editor changes while the first one waits.
      agent._skipPermissionGate = false;
      const waits = [];
      agent._promptSubmitConfirmation = async () => {
        waits.push('submit');
        if (changes) page.editor = `${POST_BODY}Late edit.\n`;
        return 'once';
      };
      agent._promptPermission = async () => { waits.push('permission'); return 'once'; };
      const { messages } = await run(tab, [call('commit', 'click_ax', { ref_id: 'ref_7' })]);
      assert.equal(cards.length, 1, `${changes}: one unverified-step card`);
      assert.equal(waits[0], 'submit', `${changes}: the submit confirmation came after the card`);
      const result = resultFor(messages, 'commit');
      if (changes) {
        assert.deepEqual(dispatched, [], 'the answer covered the text the user saw, not the changed editor');
        assert.equal(result.noDispatch, true);
        assert.match(result.error, /Commit submission is blocked/);
        assert.equal(result.unverifiedStepConfirmation, undefined, 'no card can wait at dispatch time');
      } else {
        assert.deepEqual(dispatched.map(item => item.name), ['click_ax'], 'an unchanged editor still commits');
        assert.equal(result.success, true);
      }
    }
  });

  test(`${build}: one answer covers one commit call; committing the same text again asks again`, async () => {
    const { agent, tab, provider } = await githubFixture();
    const { dispatched, cards, run } = pipeline(agent, provider, 'once');
    await run(tab, [call('commit-1', 'click_ax', { ref_id: 'ref_7' })]);
    assert.equal(cards.length, 1);
    assert.equal(dispatched.length, 1);
    assert.equal(agent._completionSubmitStates.get(tab).workflowBinding.githubFileCommit.unverifiedApprovalSource, 'user',
      'the commit that went out carries the answer on its receipt');
    // The editor reads the same as on the card, but the answer was spent with
    // the commit call: a second commit is asked about again.
    await run(tab, [call('commit-2', 'click_ax', { ref_id: 'ref_7' })]);
    assert.equal(cards.length, 2, 'a repeated commit is asked about again');
    assert.equal(cards[1].unverifiedStepConfirmation.content, POST_BODY);
    assert.equal(dispatched.length, 2);
  });

  // ── github-commit-split-write-required ─────────────────────────────────
  test(`${build}: an action that may or may not commit asks when a commit is otherwise allowed`, async () => {
    // With a requested commit message there is no card: the message is
    // proven only before the commit, and this action could rewrite it.
    {
      const { agent, tab } = await githubFixture();
      const editorTarget = agent._textMutationTarget(tab, 'set_field', { ref_id: 'ref_editor' });
      agent._unverifiedTextWrites.delete(tab);
      agent._verifiedTextReplacements.get(tab).set(editorTarget.key, await agent._verifiedTextReplacementRecord(tab, editorTarget, POST_BODY, EDITOR_META));
      const block = await agent._workflowPreSubmitDispatchBlock(tab, 'execute_js', { code: 'void 0' }, null);
      assert.equal(block.splitWriteRequired, true);
      assert.equal(block.unverifiedStepConfirmation, undefined, 'a requested message keeps the split');
    }
    for (const strict of [false, true]) {
      const { agent, tab } = await githubFixture({ strict, requestMessage: false });
      // A verified editor proof: the commit binding holds.
      const editorTarget = agent._textMutationTarget(tab, 'set_field', { ref_id: 'ref_editor' });
      agent._unverifiedTextWrites.delete(tab);
      agent._verifiedTextReplacements.get(tab).set(editorTarget.key, await agent._verifiedTextReplacementRecord(tab, editorTarget, POST_BODY, EDITOR_META));
      const block = await agent._workflowPreSubmitDispatchBlock(tab, 'execute_js', { code: 'void 0' }, null);
      assert.equal(block.splitWriteRequired, true);
      if (strict) {
        // Strict checks: the guard's refusal itself is under test.
        assert.equal(block.unverifiedStepConfirmation, undefined);
        continue;
      }
      assert.equal(block.unverifiedStepConfirmation.guardId, 'github-commit-split-write-required');
      assert.equal(block.unverifiedStepConfirmation.reason, 'submit_unclear');
      assert.deepEqual(block.unverifiedStepConfirmation.target, { locatorType: 'ax', refId: 'ref_editor', ambiguous: false });
      const advisories = [];
      const cards = [];
      const rerun = () => agent._workflowPreSubmitDispatchBlock(tab, 'execute_js', { code: 'void 0' }, null);
      const resolved = await agent._resolveUnverifiedStepConfirmation(tab, block, (type, data) => {
        if (type === 'clarify') { cards.push(data); agent.submitClarifyResponse(tab, data.clarifyId, 'once', 'option'); }
      }, rerun, advisories);
      assert.equal(resolved, null, 'the user let this action run');
      assert.equal(cards[0].unverifiedStepConfirmation.content, POST_BODY, 'the card shows the editor');
      assert.deepEqual(advisories.map(item => item.guard), ['github-commit-split-write-required']);
      const again = await rerun();
      assert.ok(again.unverifiedStepConfirmation, 'one answer covers one action');
    }
  });

  test(`${build}: a split-write answer covers only the editor text the user saw`, async () => {
    const { agent, tab, page } = await githubFixture({ requestMessage: false });
    // A verified editor proof: the commit binding holds for POST_BODY.
    const editorTarget = agent._textMutationTarget(tab, 'set_field', { ref_id: 'ref_editor' });
    agent._unverifiedTextWrites.delete(tab);
    agent._verifiedTextReplacements.get(tab).set(editorTarget.key, await agent._verifiedTextReplacementRecord(tab, editorTarget, POST_BODY, EDITOR_META));
    const rerun = () => agent._workflowPreSubmitDispatchBlock(tab, 'execute_js', { code: 'void 0' }, null);
    const block = await rerun();
    assert.equal(block.unverifiedStepConfirmation.requireContent, true, 'the card needs the editor text it covers');
    // The card shows text that differs from what the action would commit
    // (the editor changed after the check), and the editor changes back while
    // the card is open: the binding holds again, but the user approved other
    // text.
    const shown = `${POST_BODY}A line the user saw on the card.\n`;
    page.editor = shown;
    const cards = [];
    const advisories = [];
    const changed = await agent._resolveUnverifiedStepConfirmation(tab, block, (type, data) => {
      if (type !== 'clarify') return;
      cards.push(data);
      page.editor = POST_BODY;
      agent.submitClarifyResponse(tab, data.clarifyId, 'once', 'option');
    }, rerun, advisories);
    assert.equal(cards.length, 1);
    assert.equal(cards[0].unverifiedStepConfirmation.content, shown);
    assert.ok(changed, 'the action is not performed on text the user did not see');
    assert.equal(changed.noDispatch, true);
    assert.match(changed.error, /changed while the user was being asked/);
    assert.deepEqual(advisories, []);
    // The next attempt asks again with what the editor holds now, and that
    // answer covers one action.
    const next = await rerun();
    assert.ok(next.unverifiedStepConfirmation, 'asked again');
    const resolved = await agent._resolveUnverifiedStepConfirmation(tab, next, (type, data) => {
      if (type !== 'clarify') return;
      cards.push(data);
      agent.submitClarifyResponse(tab, data.clarifyId, 'once', 'option');
    }, rerun, advisories);
    assert.equal(cards.length, 2);
    assert.equal(cards[1].unverifiedStepConfirmation.content, POST_BODY, 'the card shows the editor as it reads now');
    assert.equal(resolved, null, 'unchanged text goes ahead once');
    assert.ok((await rerun()).unverifiedStepConfirmation, 'one answer covers one action');
    // An editor that cannot be read cannot be approved.
    const unreadable = await githubFixture({ requestMessage: false });
    const target = unreadable.agent._textMutationTarget(unreadable.tab, 'set_field', { ref_id: 'ref_editor' });
    unreadable.agent._unverifiedTextWrites.delete(unreadable.tab);
    unreadable.agent._verifiedTextReplacements.get(unreadable.tab).set(target.key,
      await unreadable.agent._verifiedTextReplacementRecord(unreadable.tab, target, POST_BODY, EDITOR_META));
    const unreadableBlock = await unreadable.agent._workflowPreSubmitDispatchBlock(unreadable.tab, 'execute_js', { code: 'void 0' }, null);
    unreadable.agent._rememberUnverifiedStepDecision(unreadable.tab, unreadableBlock.unverifiedStepConfirmation,
      { sha256: '', length: null }, 'once', 'user');
    assert.equal(await unreadable.agent._consumeContentBoundApproval(unreadable.tab,
      { ...unreadableBlock.unverifiedStepConfirmation, target: null }), false, 'no reading, no approval');
  });

  test(`${build}: inside one call, a split-write answer holds for every re-run of the call's checks`, async () => {
    const { agent, tab } = await githubFixture({ requestMessage: false });
    const editorTarget = agent._textMutationTarget(tab, 'set_field', { ref_id: 'ref_editor' });
    agent._unverifiedTextWrites.delete(tab);
    agent._verifiedTextReplacements.get(tab).set(editorTarget.key, await agent._verifiedTextReplacementRecord(tab, editorTarget, POST_BODY, EDITOR_META));
    const rerun = () => agent._workflowPreSubmitDispatchBlock(tab, 'execute_js', { code: 'void 0' }, null);
    const cards = [];
    agent._beginUnverifiedStepScope(tab);
    const resolved = await agent._resolveUnverifiedStepConfirmation(tab, await rerun(), (type, data) => {
      if (type === 'clarify') { cards.push(data); agent.submitClarifyResponse(tab, data.clarifyId, 'once', 'option'); }
    }, rerun, []);
    assert.equal(resolved, null);
    assert.equal(await rerun(), null, 'the same call checks again on the same answer');
    assert.equal(await rerun(), null);
    agent._settleUnverifiedStepScope(tab);
    assert.equal(cards.length, 1);
    assert.ok((await rerun()).unverifiedStepConfirmation, 'the next call asks again');
  });

  // ── social-publication-draft-quality ───────────────────────────────────
  // The user asked to publish; the X composer's draft could not be confirmed
  // against the contract. The card shows the composer's text; the
  // independent publication audit (a hard check) still runs after 'once'.
  function socialFixture(request = 'Post Hello on X') {
    const ref = text => ({ source: 'request', start: text, end: text });
    const contract = { version: 1, status: 'ready', prohibited: [], reason: 'User requested publication.', requirements: 'p1',
      actions: [{ id: 'p1', platform: 'twitter', account: null, posts: [{ body: { kind: 'exact', source: ref('Hello') },
        media: { kind: 'count', type: 'any', format: null, min: 0, max: 0 }, context: { kind: 'post', target: null } }] }] };
    const provider = { model: 'user-selected-provider-model', chat: async () => ({ content: '{}' }) };
    const agent = new Agent({ getActive: () => provider });
    const tab = nextTab++;
    agent.useSiteAdapters = true;
    agent.clarifyTimeoutSec = 30;
    agent._persist = () => {};
    agent._currentUrl = async () => 'https://x.com/compose/post';
    agent.conversations.set(tab, [{ role: 'system', content: 'system' }, { role: 'user', content: request }]);
    const guard = agent._startPlanExecutionGuard(tab, 'act', { requestKind: 'execute', requiresStateChange: true, requiresSubmission: true });
    const audits = [];
    agent._chatWithCostAllowance = async (_provider, messages, _options, _cost, meta) => {
      if (meta.generationName === 'social_publication_authorization') {
        const input = JSON.parse(messages[1].content);
        audits.push(input.snapshot);
        return { content: JSON.stringify({ key: input.key, actionId: input.action.id, authorized: true, reason: 'Matches the request.' }) };
      }
      return { content: JSON.stringify(contract) };
    };
    const detected = { isSubmit: true, publicationControl: true, publicationResourceUrls: [], publicationResourceUrlsComplete: true,
      frameDocumentIdentity: 'https://x.com/compose/post|document-1', publicationAccountIdentity: 'twitter:alice',
      publicationAccountIdentityComplete: true,
      publicationSnapshot: { complete: true, account: 'twitter:alice',
        posts: [{ complete: true, bodyText: 'Helo', attachments: [], context: { kind: 'post', target: null } }] } };
    agent._detectLikelySubmitAction = async () => structuredClone(detected);
    return { agent, tab, guard, provider, detected, audits };
  }

  test(`${build}: an X draft that does not read back as requested asks with the composer's text; the audit still runs`, async () => {
    const f = socialFixture();
    const check = () => f.agent._workflowPreSubmitDispatchBlock(f.tab, 'click_ax', { ref_id: 'ref_post' }, f.detected, f.provider);
    const block = await check();
    assert.equal(block.noDispatch, true);
    assert.deepEqual(block.publicationValidation.issues.map(issue => issue.reason), ['body_mismatch']);
    assert.equal(block.unverifiedStepConfirmation.guardId, 'social-publication-draft-quality');
    assert.equal(block.unverifiedStepConfirmation.action, 'publish');
    assert.equal(block.unverifiedStepConfirmation.reason, 'draft_unverified');
    assert.equal(block.unverifiedStepConfirmation.host, 'x.com');
    assert.equal(block.unverifiedStepConfirmation.text, 'Helo');
    assert.equal(f.audits.length, 0, 'nothing reaches the audit before the answer');
    const cards = [];
    const advisories = [];
    const resolved = await f.agent._resolveUnverifiedStepConfirmation(f.tab, block, (type, data) => {
      if (type === 'clarify') { cards.push(data); f.agent.submitClarifyResponse(f.tab, data.clarifyId, 'once', 'option'); }
    }, check, advisories);
    assert.equal(resolved, null);
    assert.equal(cards[0].unverifiedStepConfirmation.content, 'Helo');
    assert.equal(cards[0].unverifiedStepConfirmation.contentLabel, 'composer');
    assert.equal(f.audits.length, 1, 'the hard publication audit ran on the observed draft');
    assert.equal(f.audits[0].posts[0].bodyText, 'Helo');
    assert.equal(f.guard.socialPublication.dispatch.publishesUnverifiedContent, true);
    assert.deepEqual(advisories.map(item => item.guard), ['social-publication-draft-quality']);
    // The pipeline's own late check passes on the same answer.
    assert.equal(f.agent._withoutUnverifiedStepAsk(await f.agent._socialPublicationPreSubmitBlock(f.tab, 'click_ax',
      { ref_id: 'ref_post' }, f.detected, f.provider)), null);
    // A different draft is a different question.
    f.detected.publicationSnapshot.posts[0].bodyText = 'Hell';
    assert.equal((await check()).unverifiedStepConfirmation.text, 'Hell');
  });

  test(`${build}: a draft answer covers one publish call; publishing the same draft again asks again`, async () => {
    const f = socialFixture();
    const check = () => f.agent._workflowPreSubmitDispatchBlock(f.tab, 'click_ax', { ref_id: 'ref_post' }, f.detected, f.provider);
    const late = async () => f.agent._withoutUnverifiedStepAsk(await f.agent._socialPublicationPreSubmitBlock(f.tab, 'click_ax',
      { ref_id: 'ref_post' }, f.detected, f.provider));
    const cards = [];
    const answer = (type, data) => {
      if (type === 'clarify') { cards.push(data); f.agent.submitClarifyResponse(f.tab, data.clarifyId, 'once', 'option'); }
    };
    // The publish call: its checks and the pipeline's late check see the answer.
    f.agent._beginUnverifiedStepScope(f.tab);
    assert.equal(await f.agent._resolveUnverifiedStepConfirmation(f.tab, await check(), answer, check, []), null);
    assert.equal(await check(), null, 'the call\'s checks run again on the same answer');
    assert.equal(await late(), null);
    f.agent._settleUnverifiedStepScope(f.tab);
    assert.equal(cards.length, 1);
    assert.equal(f.audits.length, 1);
    assert.ok(f.guard.socialPublication.dispatch, 'the audited dispatch keeps its key');
    // The next publish call with the unchanged draft does not reuse the
    // answer, so it cannot skip the card and the audit.
    f.agent._beginUnverifiedStepScope(f.tab);
    const again = await check();
    f.agent._settleUnverifiedStepScope(f.tab);
    assert.equal(again?.noDispatch, true, 'a repeated publish is not let through');
    assert.equal(again.unverifiedStepConfirmation?.guardId, 'social-publication-draft-quality', 'it is asked about again');
  });

  test(`${build}: missing accounts refuse while reply changes and Strict checks offer an explicit override`, async () => {
    const account = socialFixture();
    delete account.detected.publicationSnapshot.account;
    const noAccount = await account.agent._workflowPreSubmitDispatchBlock(account.tab, 'click_ax', { ref_id: 'ref_post' }, account.detected, account.provider);
    assert.ok(noAccount.publicationValidation.issues.some(issue => issue.reason === 'account_unobserved'));
    assert.equal(noAccount.unverifiedStepConfirmation, undefined, 'the sending account is not a readback question');
    const context = socialFixture();
    context.detected.publicationSnapshot.posts[0].context = { kind: 'reply', target: 'https://x.com/bob/status/1' };
    const wrongContext = await context.agent._workflowPreSubmitDispatchBlock(context.tab, 'click_ax', { ref_id: 'ref_post' }, context.detected, context.provider);
    assert.ok(wrongContext.publicationValidation.issues.some(issue => issue.reason === 'context_mismatch'));
    assert.equal(wrongContext.unverifiedStepConfirmation.guardId, 'social-publication-authorization-guard');
    assert.equal(wrongContext.unverifiedStepConfirmation.hard, true, 'only the user may approve a changed reply target');
    // Strict checks: the guard's refusal itself is under test.
    const strict = socialFixture();
    strict.agent.strictGuards = true;
    const refused = await strict.agent._workflowPreSubmitDispatchBlock(strict.tab, 'click_ax', { ref_id: 'ref_post' }, strict.detected, strict.provider);
    assert.deepEqual(refused.publicationValidation.issues.map(issue => issue.reason), ['body_mismatch']);
    assert.equal(refused.unverifiedStepConfirmation.guardId, 'social-publication-authorization-guard');
    assert.equal(refused.unverifiedStepConfirmation.hard, true, 'Strict checks still allow the user to decide');
    // A body the composer did not expose asks the user to check the page.
    const unobserved = socialFixture();
    delete unobserved.detected.publicationSnapshot.posts[0].bodyText;
    const ask = await unobserved.agent._workflowPreSubmitDispatchBlock(unobserved.tab, 'click_ax', { ref_id: 'ref_post' }, unobserved.detected, unobserved.provider);
    assert.equal(ask.unverifiedStepConfirmation.reason, 'draft_unobserved');
    assert.equal(ask.unverifiedStepConfirmation.text, '');
  });

  test(`${build}: changed media needs an explicit override and an incomplete composer still refuses`, async () => {
    // Media is not a quality/readback choice: a hard card names the observed
    // attachments and only the user may override the mismatch. An incomplete
    // composer still cannot define the action the user would approve.
    const image = [{ type: 'image', src: 'https://pbs.twimg.com/media/unrequested.jpg' }];
    const check = f => f.agent._workflowPreSubmitDispatchBlock(f.tab, 'click_ax', { ref_id: 'ref_post' }, f.detected, f.provider);
    const media = socialFixture();
    media.detected.publicationSnapshot.posts[0].bodyText = 'Hello';
    media.detected.publicationSnapshot.posts[0].attachments = image;
    const wrongMedia = await check(media);
    assert.equal(wrongMedia.noDispatch, true);
    assert.deepEqual(wrongMedia.publicationValidation.issues.map(issue => issue.reason), ['media_mismatch']);
    assert.equal(wrongMedia.unverifiedStepConfirmation.guardId, 'social-publication-authorization-guard');
    assert.equal(wrongMedia.unverifiedStepConfirmation.hard, true);
    assert.match(wrongMedia.unverifiedStepConfirmation.text, /Attachment: image/);
    const both = socialFixture();
    both.detected.publicationSnapshot.posts[0].attachments = image;
    const textAndMedia = await check(both);
    assert.deepEqual(textAndMedia.publicationValidation.issues.map(issue => issue.reason), ['body_mismatch', 'media_mismatch']);
    assert.equal(textAndMedia.unverifiedStepConfirmation.guardId, 'social-publication-authorization-guard');
    assert.equal(textAndMedia.unverifiedStepConfirmation.hard, true, 'media cannot inherit a quality timeout');
    const partial = socialFixture();
    partial.detected.publicationSnapshot.complete = false;
    partial.detected.publicationSnapshot.posts[0].bodyText = 'Hello';
    const incomplete = await check(partial);
    assert.deepEqual(incomplete.publicationValidation.issues.map(issue => issue.reason), ['composer_incomplete']);
    assert.equal(incomplete.unverifiedStepConfirmation, undefined, 'a readable body does not vouch for the unread part');
    for (const f of [media, both, partial]) assert.equal(f.audits.length, 0, 'nothing reached the publication audit');
  });

  // ── a second guard after an approval ───────────────────────────────────
  test(`${build}: a second guard's card after an approval is asked in turn, and the first answer stands`, async () => {
    const setupTab = () => {
      const agent = new Agent({});
      const tab = nextTab++;
      agent._persist = () => {};
      agent.clarifyTimeoutSec = 30;
      agent.conversations.set(tab, [{ role: 'system', content: 'system' }, { role: 'user', content: 'Post Hello on X' }]);
      agent._startPlanExecutionGuard(tab, 'act', { requestKind: 'execute', requiresStateChange: true, requiresSubmission: true });
      return { agent, tab };
    };
    const refusal = { success: false, dispatched: false, noDispatch: true, error: 'refused' };
    const draftAsk = { guardId: 'social-publication-draft-quality', hard: false, action: 'publish', reason: 'draft_unverified',
      host: 'x.com', contentLabel: 'composer', text: 'Helo', stepKey: 'draft-step' };
    const targetAsk = { guardId: 'steer-prior-submission-target-unresolved', hard: false, action: 'click',
      reason: 'target_unresolved', host: 'x.com', contentLabel: 'page', stepKey: 'steer-step' };
    const answerOnce = (agent, tab, cards) => (type, data) => {
      if (type !== 'clarify') return;
      cards.push(data.unverifiedStepConfirmation.guardId);
      agent.submitClarifyResponse(tab, data.clarifyId, 'once', 'option');
    };
    // Another guard asks about the same action after the first answer.
    const { agent, tab } = setupTab();
    let reruns = 0;
    const cards = [];
    const advisories = [];
    const resolved = await agent._resolveUnverifiedStepConfirmation(tab, { ...refusal, unverifiedStepConfirmation: draftAsk },
      answerOnce(agent, tab, cards), async () => (++reruns === 1 ? { ...refusal, unverifiedStepConfirmation: targetAsk } : null), advisories);
    assert.equal(resolved, null, `${build}: both answers let the action go ahead`);
    assert.deepEqual(cards, [draftAsk.guardId, targetAsk.guardId], `${build}: each guard asked its own card`);
    assert.deepEqual(advisories.map(item => item.guard), [draftAsk.guardId, targetAsk.guardId]);
    assert.notEqual(agent._unverifiedStepDecisions(tab).find(entry => entry.guardId === draftAsk.guardId)?.stale, true,
      `${build}: the first answer is not stale`);
    // The same guard asking again for another step still means the page changed.
    const same = setupTab();
    const sameCards = [];
    const changed = await same.agent._resolveUnverifiedStepConfirmation(same.tab, { ...refusal, unverifiedStepConfirmation: draftAsk },
      answerOnce(same.agent, same.tab, sameCards), async () => ({ ...refusal, unverifiedStepConfirmation: { ...draftAsk, stepKey: 'other-step' } }), []);
    assert.deepEqual(sameCards, [draftAsk.guardId], `${build}: the changed step is not asked in the same breath`);
    assert.match(changed.error, /What the page shows changed/);
    assert.equal(changed.unverifiedStepConfirmation, undefined);
    assert.equal(same.agent._unverifiedStepDecisions(same.tab).find(entry => entry.guardId === draftAsk.guardId)?.stale, true);
  });

  test(`${build}: an answer its guard spends at check time holds while a second guard's card is asked`, async () => {
    const agent = new Agent({});
    agent._persist = () => {};
    agent.clarifyTimeoutSec = 30;
    const tab = nextTab++;
    agent._taskTokens.set(tab, `task-${tab}`);
    agent._lastAxScopes.set(tab, { documentToken: 'doc', pageUrl: 'https://forms.example/apply' });
    agent._planExecutionGuards.set(tab, { enabled: true, taskKey: 'steered', steeringPriorSubmission: { actionSequence: 3 } });
    const refusal = { success: false, dispatched: false, noDispatch: true, error: 'refused' };
    const second = { guardId: 'social-publication-draft-quality', hard: false, action: 'publish', reason: 'draft_unverified',
      host: 'forms.example', contentLabel: 'composer', text: 'Helo', stepKey: 'second-step' };
    // The call's checks: the real unidentified-control guard (it spends its
    // answer as it checks), then another guard about the same click.
    const checks = async () => agent._steeringPriorSubmissionBlock(tab, 'click_ax', { ref_id: 'ref_9' }, null)
      || (agent._unverifiedStepApproval(tab, second.guardId, second.stepKey) ? null : { ...refusal, unverifiedStepConfirmation: second });
    const cards = [];
    const answer = (type, data) => {
      if (type !== 'clarify') return;
      cards.push(data.unverifiedStepConfirmation.guardId);
      agent.submitClarifyResponse(tab, data.clarifyId, 'once', 'option');
    };
    agent._beginUnverifiedStepScope(tab);
    const advisories = [];
    const resolved = await agent._resolveUnverifiedStepConfirmation(tab, await checks(), answer, checks, advisories);
    agent._settleUnverifiedStepScope(tab);
    assert.equal(resolved, null);
    assert.deepEqual(cards, ['steer-prior-submission-target-unresolved', second.guardId], 'each guard asks once');
    assert.deepEqual(advisories.map(item => item.guard), cards);
    // Both answers were spent with that call: the next one asks again.
    agent._beginUnverifiedStepScope(tab);
    const next = await checks();
    agent._settleUnverifiedStepScope(tab);
    assert.equal(next.unverifiedStepConfirmation.guardId, 'steer-prior-submission-target-unresolved');
  });

  // ── steer-prior-submission-target-unresolved ───────────────────────────
  test(`${build}: after a correction, an unidentified control asks instead of refusing`, async () => {
    for (const strict of [false, true]) {
      const agent = new Agent({});
      agent.strictGuards = strict;
      const tab = nextTab++;
      agent._taskTokens.set(tab, `task-${tab}`);
      agent._lastAxScopes.set(tab, { documentToken: 'doc', pageUrl: 'https://forms.example/apply' });
      agent._planExecutionGuards.set(tab, { enabled: true, taskKey: 'steered', steeringPriorSubmission: { actionSequence: 3 } });
      const block = agent._steeringPriorSubmissionBlock(tab, 'click_ax', { ref_id: 'ref_9' }, null);
      assert.equal(block.actionGuard.reason, 'target_unresolved');
      if (strict) {
        assert.equal(block.unverifiedStepConfirmation, undefined, 'Strict checks refuse without a card');
        continue;
      }
      assert.deepEqual({ ...block.unverifiedStepConfirmation, stepKey: !!block.unverifiedStepConfirmation.stepKey },
        { guardId: 'steer-prior-submission-target-unresolved', hard: false, action: 'click', reason: 'target_unresolved',
          host: 'forms.example', contentLabel: 'page', stepKey: true });
      const cards = [];
      const resolved = await agent._resolveUnverifiedStepConfirmation(tab, block, (type, data) => {
        if (type === 'clarify') { cards.push(data); agent.submitClarifyResponse(tab, data.clarifyId, 'once', 'option'); }
      }, async () => agent._steeringPriorSubmissionBlock(tab, 'click_ax', { ref_id: 'ref_9' }, null), []);
      assert.equal(resolved, null);
      assert.equal(cards[0].unverifiedStepConfirmation.content, '', 'nothing to show: the card asks to check the page');
      assert.ok(agent._steeringPriorSubmissionBlock(tab, 'click_ax', { ref_id: 'ref_9' }, null).unverifiedStepConfirmation,
        'the next such action asks again');
      // An identified earlier-effect lock is a hard class and never asks.
      const reconciled = agent._steeringPriorSubmissionBlock(tab, 'click_ax', { ref_id: 'ref_9' }, { isSubmit: true, url: 'https://forms.example/apply' });
      assert.equal(reconciled.actionGuard.reason, 'prior_effect_unreconciled');
      assert.equal(reconciled.unverifiedStepConfirmation, undefined);
    }
  });

  // ── scheduler persistence ──────────────────────────────────────────────
  test(`${build}: a scheduled run keeps the card so a reopened panel restores it`, async () => {
    let finish;
    const step = { guardId: 'social-publication-draft-quality', hard: false, action: 'publish', host: 'x.com',
      reason: 'draft_unverified', content: 'Hello <b>world</b>', contentLabel: 'composer' };
    const h = makeSchedulerHarness(Scheduler, {
      processMessage: async (_tab, _message, onUpdate) => {
        onUpdate('clarify', { promptKind: 'unverifiedStepConfirmation', clarifyId: 'unverified_1', question: 'Publish this on x.com?',
          options: ['once', 'deny'], unverifiedStepConfirmation: { ...step, content: 'x'.repeat(2000) },
          timeoutSec: 60, deadlineTs: Date.UTC(2026, 0, 1, 12, 1, 0), timeoutAnswer: 'once' });
        await new Promise(resolve => { finish = resolve; });
        return 'done';
      },
    });
    const created = await h.manager.createResumeJob({ tabId: 77, conversationId: 'conv-1',
      args: { after_seconds: 60, reason: 'wait', resume_instruction: 'publish' } });
    const running = h.manager.handleAlarm(h.alarmName(created.jobId));
    await wait(0);
    const pending = h.jobs()[0].pendingClarify;
    assert.equal(h.jobs()[0].status, 'needs_user_input');
    assert.equal(pending.promptKind, 'unverifiedStepConfirmation');
    assert.equal(pending.timeoutAnswer, 'once');
    assert.equal(pending.timeoutSec, 60);
    assert.deepEqual(pending.options, ['once', 'deny']);
    assert.deepEqual(pending.unverifiedStepConfirmation, { ...step, content: `${'x'.repeat(1500)}…` }, 'bounded page text');
    finish();
    await running;
  });
}

// ── clickax-task-click-lock (hard class, Chrome only) ────────────────────
// A trusted click on this exact document|ref may already have taken effect
// and was never verified. The card replaces the task-long dead end with the
// user's decision; it never answers itself, in either mode.
test('chrome: a click that may repeat an unverified earlier click asks on a hard card, with or without Strict checks', async () => {
  const { Agent } = builds.find(item => item.build === 'chrome');
  for (const strict of [false, true]) {
    const provider = { name: 'lock test', model: 'test', promptTier: 'full', contextWindow: 128000,
      supportsTools: true, supportsVision: false, chat: async () => ({ content: '' }) };
    const agent = new Agent({ getActive: () => provider, getProvider: () => provider, getVisionProvider: async () => null });
    agent.strictGuards = strict;
    agent.clarifyTimeoutSec = 0;
    agent._persist = () => {};
    agent._persistNow = async () => ({ ok: true });
    const tab = nextTab++;
    agent._taskTokens.set(tab, `task-${tab}`);
    agent._planExecutionGuards.set(tab, { enabled: false, taskKey: `key-${tab}` });
    agent._lastAxScopes.set(tab, { documentToken: 'doc-1', pageUrl: 'https://shop.example/cart' });
    agent._currentUrl = async () => 'https://shop.example/cart';
    for (const ref of ['ref_buy', 'ref_pay']) {
      agent._rememberTaskClickLock(tab, `doc-1|${ref}`);
      agent._rememberTaskClickLock(tab, `native-button-pending:doc-1|${ref}`);
    }
    agent._clickAxCdpFallbacks.set(tab, new Set(['doc-1|ref_pay', 'native-button-pending:doc-1|ref_pay', 'native-button:doc-1|ref_pay|snapshot-1']));
    assert.equal(agent._taskClickLockAsk(tab, 'click_ax', { ref_id: 'ref_other' }), null, 'another target is not locked');
    const block = agent._taskClickLockAsk(tab, 'click_ax', { ref_id: 'ref_buy' });
    assert.equal(block.repeatBlocked, true);
    assert.deepEqual({ ...block.unverifiedStepConfirmation, stepKey: !!block.unverifiedStepConfirmation.stepKey },
      { guardId: 'clickax-task-click-lock', hard: true, action: 'click', reason: 'repeat_unverified', host: 'shop.example',
        contentLabel: 'page', stepKey: true });
    // Through the real pre-dispatch checks: 'deny' keeps the lock and is not asked again.
    const cards = [];
    const dispatched = [];
    agent._skipPermissionGate = true;
    agent._ensureGateSetting = async () => true;
    for (const name of ['_chromeProtectedPageFailure', '_captchaMutationPreflight', '_messageRecipientGuardBlock',
      '_detectLikelySubmitAction', '_socialPublicationPreSubmitBlock']) agent[name] = async () => null;
    agent._adoptLiveSocialPublishWorkflow = async () => false;
    agent._captureFormValidationState = async () => [];
    agent._waitForFormValidationFailure = async () => null;
    agent._auditRichTextToolbarTarget = async () => {};
    agent._shouldAutoScreenshot = () => false;
    agent._refreshPageFeedbackForCall = async () => false;
    // The click itself: _dispatchClickAx releases an approved target's locks around it.
    agent._dispatchClickAxImpl = async (_tab, args, _scope, _binding, _context, _deadline, _upstream, dispatchState) => {
      dispatched.push({ name: 'click_ax', args });
      dispatchState.started = true;
      return { success: true, dispatched: true, verified: true };
    };
    const run = async (id, ref, answer) => {
      const messages = [];
      await agent._executeToolBatch(tab, [call(id, 'click_ax', { ref_id: ref })], messages, (type, data) => {
        if (type !== 'clarify') return;
        cards.push(data);
        setTimeout(() => agent.submitClarifyResponse(tab, data.clarifyId, answer, 'option'), 20);
      }, provider, null, new Set(['click_ax', 'done']), 1, {});
      return resultFor(messages, id);
    };
    const denied = await run('buy-1', 'ref_buy', 'deny');
    assert.equal(cards.length, 1);
    assert.equal(cards[0].unverifiedStepConfirmation.hard, true);
    assert.equal(cards[0].timeoutAnswer, undefined, 'Instant does not answer a hard card');
    assert.equal(denied.unverifiedStepDeclined, true);
    assert.match(denied.error, /The user chose not to go ahead with clicking this control again/);
    assert.equal(dispatched.length, 0);
    assert.ok(agent._taskClickLockKeys(tab).has('doc-1|ref_buy'), 'the lock stays');
    const again = await run('buy-2', 'ref_buy', 'once');
    assert.equal(cards.length, 1, 'a declined click is not asked about again');
    assert.match(again.error, /already chose not to go ahead/);
    // 'once' releases this target's locks for this one click.
    const approved = await run('pay', 'ref_pay', 'once');
    assert.equal(cards.length, 2);
    assert.deepEqual(dispatched.map(item => item.args.ref_id), ['ref_pay']);
    assert.equal(approved.success, true);
    assert.match(approved.guardAdvisories.find(item => item.guard === 'clickax-task-click-lock').note, /the user approved it/);
    assert.equal(agent._taskClickLockKeys(tab).has('doc-1|ref_pay'), false);
    assert.equal(agent._taskClickLockKeys(tab).has('native-button-pending:doc-1|ref_pay'), false);
    assert.deepEqual([...agent._clickAxCdpFallbacks.get(tab)], [], 'the per-run trusted attempt for this target is released too');
    // An unattended run cannot ask: refused without a card.
    agent._rememberTaskClickLock(tab, 'doc-1|ref_ship');
    agent.scheduledRunPolicies.set(tab, { requireConsequentialConfirmation: false });
    const unattended = await run('ship', 'ref_ship', 'once');
    assert.equal(cards.length, 2);
    assert.match(unattended.error, /This unattended run cannot ask the user about clicking this control again/);
    assert.equal(dispatched.length, 1);
  }
});

// The user's 'once' covers one click that is actually sent. A correction
// that arrives just after the answer hands the turn to the corrected task
// before dispatch: no click, the target stays locked, and the next click on
// it asks again. The real click path runs (its lock fence included) with
// the page's content script stubbed.
test('chrome: an approved repeat click releases its lock only when it is sent', async () => {
  const { Agent } = builds.find(item => item.build === 'chrome');
  const provider = { name: 'lock test', model: 'test', promptTier: 'full', contextWindow: 128000,
    supportsTools: true, supportsVision: false, chat: async () => ({ content: '' }) };
  const agent = new Agent({ getActive: () => provider, getProvider: () => provider, getVisionProvider: async () => null });
  agent.clarifyTimeoutSec = 0;
  agent._persist = () => {};
  agent._persistNow = async () => ({ ok: true });
  const tab = nextTab++;
  agent._taskTokens.set(tab, `task-${tab}`);
  agent._planExecutionGuards.set(tab, { enabled: false, taskKey: `key-${tab}` });
  agent._lastAxScopes.set(tab, { documentToken: 'doc-1', pageUrl: 'https://shop.example/cart' });
  agent._currentUrl = async () => 'https://shop.example/cart';
  for (const ref of ['ref_buy', 'ref_pay']) {
    agent._rememberTaskClickLock(tab, `doc-1|${ref}`);
    agent._rememberTaskClickLock(tab, `native-button-pending:doc-1|${ref}`);
  }
  const tried = ['doc-1|ref_buy', 'native-button-pending:doc-1|ref_buy', 'native-button:doc-1|ref_buy|snapshot-1'];
  agent._clickAxCdpFallbacks.set(tab, new Set(tried));
  const locked = ref => ['doc-1|', 'native-button-pending:doc-1|'].map(prefix => agent._taskClickLockKeys(tab).has(prefix + ref));
  agent._skipPermissionGate = true;
  agent._ensureGateSetting = async () => true;
  for (const name of ['_chromeProtectedPageFailure', '_captchaMutationPreflight', '_messageRecipientGuardBlock',
    '_detectLikelySubmitAction', '_socialPublicationPreSubmitBlock']) agent[name] = async () => null;
  agent._adoptLiveSocialPublishWorkflow = async () => false;
  agent._captureFormValidationState = async () => [];
  agent._waitForFormValidationFailure = async () => null;
  agent._auditRichTextToolbarTarget = async () => {};
  agent._shouldAutoScreenshot = () => false;
  agent._refreshPageFeedbackForCall = async () => false;
  agent._isPdfTab = async () => false;
  agent._captureClickAxObservation = async (_tab, snapshot, sideEffectWatch, startedAt) => ({ startedAt, snapshot, sideEffectWatch });
  agent._maybeFallbackClickAxWithCdp = async (_tab, _args, response) => response;
  // The content script's click: what it reports for each target.
  const clicks = [];
  const content = { ref_buy: () => ({ success: true, dispatched: true, verified: true }),
    ref_pay: () => ({ success: false, dispatched: false, noDispatch: true, fallbackAttempted: false,
      error: 'The element is no longer in the page.' }) };
  const sendMessage = api.tabs.sendMessage;
  api.tabs.sendMessage = async (tabId, message, options) => {
    if (message?.action !== 'click_ax') return sendMessage(tabId, message, options);
    const report = content[message.params.ref_id]();
    if (report.dispatched) clicks.push(message.params.ref_id);
    return report;
  };
  // A correction sent just after the user's answer, before the click.
  let correctAfterAnswer = false;
  const remember = agent._rememberUnverifiedStepDecision.bind(agent);
  agent._rememberUnverifiedStepDecision = (...args) => {
    const entry = remember(...args);
    if (correctAfterAnswer && entry?.choice === 'once') {
      agent._steeringRuns.set(tab, { messages: [{ role: 'user', content: 'Check the cart total first.' }] });
    }
    return entry;
  };
  const cards = [];
  const run = async (id, ref) => {
    const messages = [];
    await agent._executeToolBatch(tab, [call(id, 'click_ax', { ref_id: ref })], messages, (type, data) => {
      if (type !== 'clarify') return;
      cards.push(data);
      setTimeout(() => agent.submitClarifyResponse(tab, data.clarifyId, 'once', 'option'), 20);
    }, provider, null, new Set(['click_ax', 'done']), 1, {});
    return resultFor(messages, id);
  };
  try {
    correctAfterAnswer = true;
    const corrected = await run('buy-1', 'ref_buy');
    correctAfterAnswer = false;
    agent._steeringRuns.delete(tab);
    assert.equal(cards.length, 1);
    assert.equal(cards[0].unverifiedStepConfirmation.hard, true);
    assert.equal(corrected.skipped, true, JSON.stringify(corrected));
    assert.match(corrected.error, /the user steered the current task/);
    assert.deepEqual(clicks, [], 'no click was sent');
    assert.deepEqual(locked('ref_buy'), [true, true], 'the target stays locked');
    assert.deepEqual([...agent._clickAxCdpFallbacks.get(tab)], tried, 'its trusted attempts stay recorded');
    // The answer was used up: the next click asks again, and 'once' sends it.
    const approved = await run('buy-2', 'ref_buy');
    assert.equal(cards.length, 2, 'the next attempt asks again');
    assert.equal(approved.success, true, JSON.stringify(approved));
    assert.deepEqual(clicks, ['ref_buy'], 'exactly one click');
    assert.deepEqual(locked('ref_buy'), [false, false], 'the lock is released by the click that was sent');
    assert.deepEqual([...agent._clickAxCdpFallbacks.get(tab)], []);
    // A click that the page refuses before dispatch locks its target again.
    const refused = await run('pay-1', 'ref_pay');
    assert.equal(cards.length, 3);
    assert.equal(refused.noDispatch, true, JSON.stringify(refused));
    assert.deepEqual(clicks, ['ref_buy']);
    assert.deepEqual(locked('ref_pay'), [true, true], 'an unsent click gets its lock back');
    await run('pay-2', 'ref_pay');
    assert.equal(cards.length, 4, 'and the next attempt asks again');
  } finally {
    api.tabs.sendMessage = sendMessage;
  }
});

// Two guards ask about one click (after a correction, an unidentified
// control that is also locked by an earlier unverified click): each card is
// asked once, the click goes out once, and both answers are spent with it.
test('chrome: a click two guards ask about is asked once per guard and sent once', async () => {
  const { Agent } = builds.find(item => item.build === 'chrome');
  const provider = { name: 'lock test', model: 'test', promptTier: 'full', contextWindow: 128000,
    supportsTools: true, supportsVision: false, chat: async () => ({ content: '' }) };
  const agent = new Agent({ getActive: () => provider, getProvider: () => provider, getVisionProvider: async () => null });
  agent.clarifyTimeoutSec = 30;
  agent._persist = () => {};
  agent._persistNow = async () => ({ ok: true });
  const tab = nextTab++;
  agent._taskTokens.set(tab, `task-${tab}`);
  agent._planExecutionGuards.set(tab, { enabled: false, taskKey: `key-${tab}`, steeringPriorSubmission: { actionSequence: 3 } });
  agent._lastAxScopes.set(tab, { documentToken: 'doc-1', pageUrl: 'https://shop.example/cart' });
  agent._currentUrl = async () => 'https://shop.example/cart';
  agent._rememberTaskClickLock(tab, 'doc-1|ref_buy');
  agent._rememberTaskClickLock(tab, 'native-button-pending:doc-1|ref_buy');
  agent._skipPermissionGate = true;
  agent._ensureGateSetting = async () => true;
  for (const name of ['_chromeProtectedPageFailure', '_captchaMutationPreflight', '_messageRecipientGuardBlock',
    '_detectLikelySubmitAction', '_socialPublicationPreSubmitBlock']) agent[name] = async () => null;
  agent._adoptLiveSocialPublishWorkflow = async () => false;
  agent._captureFormValidationState = async () => [];
  agent._waitForFormValidationFailure = async () => null;
  agent._auditRichTextToolbarTarget = async () => {};
  agent._shouldAutoScreenshot = () => false;
  agent._refreshPageFeedbackForCall = async () => false;
  const dispatched = [];
  agent._dispatchClickAxImpl = async (_tab, args, _scope, _binding, _context, _deadline, _upstream, dispatchState) => {
    dispatched.push(args.ref_id);
    dispatchState.started = true;
    return { success: true, dispatched: true, verified: true };
  };
  const cards = [];
  const run = async id => {
    const messages = [];
    await agent._executeToolBatch(tab, [call(id, 'click_ax', { ref_id: 'ref_buy' })], messages, (type, data) => {
      if (type !== 'clarify') return;
      cards.push(data.unverifiedStepConfirmation.guardId);
      setTimeout(() => agent.submitClarifyResponse(tab, data.clarifyId, 'once', 'option'), 10);
    }, provider, null, new Set(['click_ax', 'done']), 1, {});
    return resultFor(messages, id);
  };
  const first = await run('buy-1');
  assert.deepEqual(cards, ['steer-prior-submission-target-unresolved', 'clickax-task-click-lock'], 'each guard asks once');
  assert.equal(first.success, true, JSON.stringify(first));
  assert.deepEqual(dispatched, ['ref_buy'], 'one click');
  assert.deepEqual(first.guardAdvisories.map(item => item.guard).sort(),
    ['clickax-task-click-lock', 'steer-prior-submission-target-unresolved']);
  // The click went out and released its lock; the correction's answer was
  // spent with it, so the next click on the control asks again.
  await run('buy-2');
  assert.deepEqual(cards.slice(2), ['steer-prior-submission-target-unresolved']);
  assert.deepEqual(dispatched, ['ref_buy', 'ref_buy']);
});

// ── hard-class asks for dead ends ────────────────────────────────────────
// Refusals that ended a run where the user could have settled it by looking
// at the page. Each now asks on WebBrain's hard card: it never answers
// itself, an unattended run is refused, and one answer covers one tool call.
for (const { build, Agent } of builds) {
  const planned = (request, plan = { requestKind: 'execute', requiresStateChange: true, requiresSubmission: true }) => {
    const provider = { name: 'dead end test', model: 'test', promptTier: 'full', contextWindow: 128000,
      supportsTools: true, supportsVision: false, chat: async () => { provider.chats += 1; return { content: '' }; }, chats: 0 };
    const agent = new Agent({ getActive: () => provider, getProvider: () => provider, getVisionProvider: async () => null });
    const tab = nextTab++;
    agent._persist = () => {};
    agent._persistNow = async () => ({ ok: true });
    agent._taskTokens.set(tab, `task-${tab}`);
    agent.conversations.set(tab, [{ role: 'system', content: 'System' }, { role: 'user', content: request }]);
    const guard = agent._startPlanExecutionGuard(tab, 'act', plan);
    return { agent, tab, guard, provider };
  };
  const answering = (agent, tab, value, cards = []) => (type, data) => {
    if (type !== 'clarify') return;
    cards.push(data);
    agent.submitClarifyResponse(tab, data.clarifyId, value, 'option');
  };
  const shape = ask => ({ ...ask, stepKey: !!ask?.stepKey });

  // ── the publication override card for a vision click ───────────────────
  const visionFixture = () => {
    const f = planned('Post this reply.');
    f.vision = true;
    f.agent._visionRunState = () => ({ active: f.vision });
    f.args = { x: 320.5, y: 410.5, coordinate_space: 'css' };
    f.detected = { isSubmit: true, publicationControl: true, frameDocumentIdentity: 'doc-1', url: 'https://x.com/compose/post',
      frameId: 0, submissionIdentity: 'composer|post',
      publicationSnapshot: { complete: true, account: 'twitter:alice', posts: [{ complete: true, bodyText: 'Hello', attachments: [],
        context: { kind: 'reply', target: 'https://x.com/bob/status/123' } }] } };
    f.agent._detectLikelySubmitAction = async () => structuredClone(f.detected);
    f.ask = () => f.agent._publicationGuardOverrideRequest(f.tab, 'click', f.args, f.detected);
    // What the publication checks do with the card's answer.
    f.check = async () => (await f.agent._publicationGuardOverrideApproval(f.tab, 'click', f.args, f.detected) ? null
      : { success: false, dispatched: false, noDispatch: true, error: 'This publication is not authorized.',
        unverifiedStepConfirmation: f.ask() });
    return f;
  };

  test(`${build}: a vision click gets the publication override card, bound to the control at its point`, async () => {
    const f = visionFixture();
    assert.deepEqual(shape(f.ask()), { guardId: 'social-publication-authorization-guard', hard: true, action: 'publish',
      reason: 'step_unverified', host: 'x.com', contentLabel: 'composer',
      text: 'Account: twitter:alice\n\nreply: https://x.com/bob/status/123\nHello', stepKey: true });
    assert.notEqual(f.agent._publicationGuardOverrideRequest(f.tab, 'click', { ...f.args, x: 12.5 }, f.detected).stepKey, f.ask().stepKey,
      'another point is another step');
    f.vision = false;
    assert.equal(f.ask(), null, 'a coordinate click outside a vision run has a ref or selector alternative and stays unbound');
    f.vision = true;
    assert.equal(f.agent._publicationGuardOverrideRequest(f.tab, 'click', { x: 320.5, y: 410.5, coordinate_space: 'screenshot' }, f.detected), null);
    // Go ahead: the answer covers this call, and the point is read again when the click is sent.
    f.agent._beginUnverifiedStepScope(f.tab);
    const cards = [];
    assert.equal(await f.agent._resolveUnverifiedStepConfirmation(f.tab, await f.check(), answering(f.agent, f.tab, 'once', cards), f.check, []), null);
    assert.equal(cards.length, 1);
    assert.equal(cards[0].unverifiedStepConfirmation.hard, true);
    assert.match(cards[0].unverifiedStepConfirmation.content, /twitter:alice[\s\S]*Hello/);
    assert.equal(cards[0].timeoutAnswer, undefined, 'a hard card has no countdown');
    assert.equal(await f.agent._visionMutationBindingBlock(f.tab, f.args, f.detected), null, 'the control the user approved is still at the point');
    const approved = f.detected;
    f.detected = { ...approved, submissionIdentity: 'composer|post-all' };
    const moved = await f.agent._visionMutationBindingBlock(f.tab, f.args, approved);
    assert.equal(moved.actionGuard.reason, 'resource_changed_before_dispatch', 'another control at the point is not clicked');
    assert.equal(moved.noDispatch, true);
    f.detected = approved;
    f.agent._settleUnverifiedStepScope(f.tab);
    assert.ok((await f.check()).unverifiedStepConfirmation, 'the next click asks again');
  });

  test(`${build}: "Don't" on a vision click's override card keeps the refusal, and an unattended run is not asked`, async () => {
    const f = visionFixture();
    const cards = [];
    const declined = await f.agent._resolveUnverifiedStepConfirmation(f.tab, await f.check(), answering(f.agent, f.tab, 'deny', cards), f.check, []);
    assert.equal(cards.length, 1);
    assert.equal(declined.unverifiedStepDeclined, true);
    assert.equal(declined.retryable, false);
    assert.match(declined.error, /The user chose not to go ahead with this step/);
    assert.equal(await f.agent._publicationGuardOverrideApproval(f.tab, 'click', f.args, f.detected), null);
    const unattended = visionFixture();
    unattended.agent.scheduledRunPolicies.set(unattended.tab, { requireConsequentialConfirmation: false });
    const refused = await unattended.agent._resolveUnverifiedStepConfirmation(unattended.tab, await unattended.check(),
      () => assert.fail('an unattended run shows no card'), unattended.check, []);
    assert.match(refused.error, /This unattended run cannot ask the user about this step/);
  });

  // ── steer-post-correction-commit-guard: a commit whose resource is unresolved ──
  const commitFixture = () => {
    const f = planned('Save my display name as Ada.');
    f.guard.steeringPriorSubmission = { actionSequence: 1, dispatched: true, mutationKind: 'submit' };
    f.args = { ref_id: 'ref_9' };
    f.detected = { isSubmit: true, validationSubmitEvidence: 'strong', url: 'https://app.example/settings', frameId: 0,
      frameDocumentIdentity: 'settings-doc', submissionIdentity: 'form|save', method: 'POST', actionUrl: '',
      fields: [{ label: 'Display name', type: 'text', value: 'Ada', changed: true }] };
    f.agent._detectLikelySubmitAction = async () => structuredClone(f.detected);
    f.check = () => f.agent._resourceMutationPreSubmitBlock(f.tab, 'click_ax', f.args, f.detected, f.provider);
    return f;
  };

  test(`${build}: after a correction, a commit whose resource cannot be resolved asks on the override card`, async () => {
    const f = commitFixture();
    const block = await f.check();
    assert.equal(block.actionGuard.reason, 'resource_unresolved');
    const ask = block.unverifiedStepConfirmation;
    assert.deepEqual({ guardId: ask.guardId, hard: ask.hard, action: ask.action, host: ask.host, contentLabel: ask.contentLabel },
      { guardId: 'steer-post-correction-commit-guard', hard: true, action: 'submit', host: 'app.example', contentLabel: 'page' });
    assert.match(ask.text, /^Destination: https:\/\/app\.example\/settings\n.*Ada/);
    // A key press cannot be bound to a control, so it still has no card.
    const keyboard = await f.agent._resourceMutationPreSubmitBlock(f.tab, 'press_keys', { key: 'Enter' }, f.detected, f.provider);
    assert.equal(keyboard.actionGuard.reason, 'click_required');
    assert.equal(keyboard.unverifiedStepConfirmation, undefined);
    f.agent._beginUnverifiedStepScope(f.tab);
    const cards = [];
    assert.equal(await f.agent._resolveUnverifiedStepConfirmation(f.tab, block, answering(f.agent, f.tab, 'once', cards), f.check, []), null);
    assert.equal(cards.length, 1);
    assert.equal(f.guard.resourceMutationAuthorization.userOverride, true);
    assert.equal(f.agent._steeringPriorSubmissionBlock(f.tab, 'click_ax', f.args, f.detected), null, 'the answer also passes the earlier-submission check');
    assert.equal(f.provider.chats, 0, 'no model judged the user\'s answer');
    f.agent._settleUnverifiedStepScope(f.tab);
    assert.equal((await f.check()).actionGuard.reason, 'resource_unresolved', 'the next commit asks again');
    const declined = commitFixture();
    const refused = await declined.agent._resolveUnverifiedStepConfirmation(declined.tab, await declined.check(),
      answering(declined.agent, declined.tab, 'deny'), declined.check, []);
    assert.equal(refused.unverifiedStepDeclined, true);
    assert.match(refused.error, /The user chose not to go ahead/);
    assert.equal(declined.guard.resourceMutationAuthorization, undefined);
  });

  // ── deletion-guard-refusal: a Delete control outside one record ────────
  const toolbarDeleteFixture = () => {
    const f = planned('Delete the selected messages.');
    f.agent._beginCompletionInvariant(f.tab);
    f.args = { ref_id: 'ref_trash' };
    f.detected = { isSubmit: true, mutationKind: 'delete', publicationControl: false, url: 'https://mail.example/inbox',
      frameDocumentIdentity: 'inbox-doc', reconciliationResources: [], reconciliationResourceScanComplete: false };
    f.agent._detectLikelySubmitAction = async () => structuredClone(f.detected);
    f.check = () => f.agent._resourceMutationPreSubmitBlock(f.tab, 'click_ax', f.args, f.detected, f.provider);
    return f;
  };

  test(`${build}: a Delete control outside one record asks on a hard card that names no item`, async () => {
    for (const strict of [false, true]) {
      const f = toolbarDeleteFixture();
      f.agent.strictGuards = strict;
      const block = await f.check();
      assert.equal(block.actionGuard.reason, 'resource_unresolved');
      assert.deepEqual(shape(block.unverifiedStepConfirmation), { guardId: 'deletion-guard-refusal', hard: true, action: 'delete',
        reason: 'delete_unbound', host: 'mail.example', contentLabel: 'page', stepKey: true });
      // A key press or a script still cannot be bound to the control.
      const keyboard = await f.agent._resourceMutationPreSubmitBlock(f.tab, 'press_keys', { key: 'Enter' }, f.detected, f.provider);
      assert.equal(keyboard.actionGuard.reason, 'click_required');
      assert.equal(keyboard.unverifiedStepConfirmation, undefined);
      f.agent._beginUnverifiedStepScope(f.tab);
      const cards = [];
      const advisories = [];
      assert.equal(await f.agent._resolveUnverifiedStepConfirmation(f.tab, block, answering(f.agent, f.tab, 'once', cards), f.check, advisories), null);
      assert.equal(cards.length, 1);
      assert.equal(cards[0].question, 'Click this delete control on mail.example?');
      assert.equal(cards[0].unverifiedStepConfirmation.content, '', 'no item was identified, so none is shown');
      assert.equal(cards[0].timeoutAnswer, undefined);
      assert.deepEqual({ deletion: f.guard.resourceMutationAuthorization.deletion, taskKey: f.guard.resourceMutationAuthorization.taskKey },
        { deletion: true, taskKey: f.guard.taskKey });
      assert.match(advisories[0].note, /WebBrain could not tell which items this control deletes; the user approved it/);
      assert.equal(f.provider.chats, 0, 'no model decided which items the request means');
      assert.equal(await f.check(), null, 'the call\'s later checks see the same answer');
      f.agent._settleUnverifiedStepScope(f.tab);
      assert.ok((await f.check()).unverifiedStepConfirmation, 'one answer covers one click; the next asks again');
    }
  });

  test(`${build}: "Don't delete", a changed page and an unattended run keep an unbound deletion from going out`, async () => {
    const declined = toolbarDeleteFixture();
    const cards = [];
    const refused = await declined.agent._resolveUnverifiedStepConfirmation(declined.tab, await declined.check(),
      answering(declined.agent, declined.tab, 'deny', cards), declined.check, []);
    assert.equal(refused.unverifiedStepDeclined, true);
    assert.equal(refused.retryable, false);
    assert.match(refused.error, /The user chose not to go ahead with this Delete or Remove control/);
    assert.equal(declined.guard.resourceMutationAuthorization, undefined);
    const again = await declined.agent._resolveUnverifiedStepConfirmation(declined.tab, await declined.check(),
      answering(declined.agent, declined.tab, 'once', cards), declined.check, []);
    assert.equal(cards.length, 1, 'a declined deletion is not asked about again');
    assert.match(again.error, /already chose not to go ahead/);
    // The page changes while the card waits: another document, another control.
    const changed = toolbarDeleteFixture();
    const before = await changed.check();
    const moved = await changed.agent._resolveUnverifiedStepConfirmation(changed.tab, before, (type, data) => {
      if (type !== 'clarify') return;
      changed.detected = { ...changed.detected, frameDocumentIdentity: 'another-doc' };
      changed.agent.submitClarifyResponse(changed.tab, data.clarifyId, 'once', 'option');
    }, changed.check, []);
    assert.match(moved.error, /changed while the user was being asked/);
    assert.equal(changed.guard.resourceMutationAuthorization, undefined);
    const unattended = toolbarDeleteFixture();
    unattended.agent.scheduledRunPolicies.set(unattended.tab, { requireConsequentialConfirmation: false });
    const silent = await unattended.agent._resolveUnverifiedStepConfirmation(unattended.tab, await unattended.check(),
      () => assert.fail('an unattended run shows no card'), unattended.check, []);
    assert.match(silent.error, /This unattended run cannot ask the user about this Delete or Remove control/);
  });

  // ── steer-prior-submission-unreconciled: a write WebBrain sends itself ──
  const writeFixture = () => {
    const f = planned('Publish the post through the CMS API.');
    f.guard.steeringPriorSubmission = { actionSequence: 3, dispatched: true };
    f.args = { url: 'https://cms.example/api/posts?draft=0', method: 'POST', body: '{"title":"Hello"}' };
    f.check = (args = f.args, name = 'fetch_url') => f.agent._steeringPriorSubmissionBlock(f.tab, name, args, null);
    return f;
  };

  test(`${build}: after a correction, an API write asks on a hard card that shows the request`, async () => {
    const f = writeFixture();
    const block = f.check();
    assert.equal(block.actionGuard.reason, 'prior_effect_unreconciled');
    assert.deepEqual(shape(block.unverifiedStepConfirmation), { guardId: 'steer-prior-submission-unreconciled', hard: true,
      action: 'submit', reason: 'prior_submission_unreconciled', host: 'cms.example', contentLabel: 'request',
      text: 'POST https://cms.example/api/posts?draft=0\n\n{"title":"Hello"}', stepKey: true });
    assert.equal(f.check({ url: 'https://cms.example/api/posts', method: 'GET' }), null, 'a read is not held');
    assert.equal(f.check({ ...f.args, url: 'https://user:secret@cms.example/api/posts' }).unverifiedStepConfirmation, undefined,
      'an address with credentials is refused without a card');
    f.agent.strictSecretMode = true;
    assert.equal(f.check().unverifiedStepConfirmation.text, 'POST https://cms.example/api/posts?draft=0', 'strict secret handling hides the body');
    f.agent.strictSecretMode = false;
    f.agent._beginUnverifiedStepScope(f.tab);
    const cards = [];
    const advisories = [];
    assert.equal(await f.agent._resolveUnverifiedStepConfirmation(f.tab, block, answering(f.agent, f.tab, 'once', cards), async () => f.check(), advisories), null);
    assert.equal(cards.length, 1);
    assert.equal(cards[0].question, 'Submit this on cms.example?');
    assert.equal(cards[0].unverifiedStepConfirmation.content, 'POST https://cms.example/api/posts?draft=0\n\n{"title":"Hello"}');
    assert.equal(cards[0].timeoutAnswer, undefined);
    assert.match(advisories[0].note, /the user approved it on WebBrain's card for this one step/);
    assert.ok(f.check({ ...f.args, body: '{"title":"Another"}' }).unverifiedStepConfirmation, 'another body is another question');
    f.agent._settleUnverifiedStepScope(f.tab);
    assert.ok(f.check().unverifiedStepConfirmation, 'one answer covers one call; the same write asks again');
  });

  test(`${build}: "Don't" keeps an API write refused, and chrome_web_store_publish asks instead of asking for a click`, async () => {
    const f = writeFixture();
    const cards = [];
    const refused = await f.agent._resolveUnverifiedStepConfirmation(f.tab, f.check(), answering(f.agent, f.tab, 'deny', cards), async () => f.check(), []);
    assert.equal(refused.unverifiedStepDeclined, true);
    assert.match(refused.error, /The user chose not to go ahead with this request, so it was not performed\. Do not repeat it unchanged; report what was not sent\./);
    await f.agent._resolveUnverifiedStepConfirmation(f.tab, f.check(), answering(f.agent, f.tab, 'once', cards), async () => f.check(), []);
    assert.equal(cards.length, 1, 'a declined request is not asked about again');
    const store = writeFixture();
    const detected = { isSubmit: true, host: 'chromewebstore.googleapis.com', reason: 'submit the configured Chrome Web Store release for review' };
    assert.equal(await store.agent._resourceMutationPreSubmitBlock(store.tab, 'chrome_web_store_publish', { publish_type: 'default' }, detected, store.provider),
      null, 'a tool with no page control is not told to use a ref or selector click');
    const block = store.agent._steeringPriorSubmissionBlock(store.tab, 'chrome_web_store_publish', { publish_type: 'default' }, detected);
    assert.deepEqual(shape(block.unverifiedStepConfirmation), { guardId: 'steer-prior-submission-unreconciled', hard: true,
      action: 'publish', reason: 'prior_submission_unreconciled', host: 'chromewebstore.googleapis.com', contentLabel: 'request',
      text: 'chrome_web_store_publish {"publish_type":"default"}', stepKey: true });
    const unattended = writeFixture();
    unattended.agent.scheduledRunPolicies.set(unattended.tab, { requireConsequentialConfirmation: false });
    const silent = await unattended.agent._resolveUnverifiedStepConfirmation(unattended.tab, unattended.check(),
      () => assert.fail('an unattended run shows no card'), async () => unattended.check(), []);
    assert.match(silent.error, /This unattended run cannot ask the user about this request/);
  });

  // ── recipient-guard-refusal: a recipient the page does not name ────────
  const CHAT_URL = 'https://example.test/chat/rooms/one';
  const recipientFixture = () => {
    const f = planned('Send Bob the invoice note.');
    f.guard.messaging = { target_kind: 'named', recipients: [{ identity: 'bob@example.com', role: 'to' }] };
    f.draft = 'Hi Bob, sending the invoice now';
    f.probes = [];
    f.agent._currentUrl = async () => CHAT_URL;
    // The page: a send with a readable draft and no recipient it names. It
    // binds a send without a recipient only when asked to.
    f.agent._messageRecipientGuardProbe = async (_tab, params) => {
      f.probes.push(params);
      return { success: true, conclusive: true, messageSend: true, composerAvailable: true, messageBody: f.draft,
        messageBodyBaselineCount: 0, identityCandidates: [], strongIdentityCandidates: [], strongRecipientCandidates: [],
        observedRecipientCandidates: [],
        ...(params.allowUnidentifiedRecipient === true ? { messageRecipientDispatchBinding: { token: 'wbmr_test_token' } } : {}) };
    };
    f.args = { ref_id: 'ref_send' };
    // The tool batch runs the guard with the card; a handler runs it without.
    f.bind = async (context = {}, options = { recipientCard: true }) => ({ context,
      block: await f.agent._messageRecipientGuardBlock(f.tab, 'click_ax', f.args, CHAT_URL, context, options) });
    return f;
  };

  test(`${build}: a send whose recipient the page does not name asks on a hard card that shows the draft`, async () => {
    const f = recipientFixture();
    const { block, context } = await f.bind();
    assert.equal(block.reasonCode, 'recipient_identity_unavailable');
    assert.deepEqual(shape(block.unverifiedStepConfirmation), { guardId: 'recipient-guard-refusal', hard: true, action: 'send',
      reason: 'recipient_unreadable', host: 'example.test', contentLabel: 'composer', text: f.draft, stepKey: true });
    assert.equal(context.messageRecipientDispatchBinding, undefined);
    assert.equal(f.probes[0].allowUnidentifiedRecipient, undefined, 'nothing is bound without the user\'s answer');
    // A caller without the card (chat_send, the upload handler) keeps the
    // refusal, also when it copies the batch's context; an upload never asks.
    const plain = await f.bind({ ...context }, {});
    assert.equal(plain.block.reasonCode, 'recipient_identity_unavailable');
    assert.equal(plain.block.unverifiedStepConfirmation, undefined);
    assert.equal((await f.agent._messageRecipientGuardBlock(f.tab, 'upload_file', { selector: '#file', filePath: 'C:\\invoice.pdf' }, CHAT_URL,
      {}, { recipientCard: true }))?.unverifiedStepConfirmation, undefined);
    // Go ahead: the same draft is bound to the send, once.
    f.agent._beginUnverifiedStepScope(f.tab);
    const cards = [];
    const advisories = [];
    const approved = {};
    assert.equal(await f.agent._resolveUnverifiedStepConfirmation(f.tab, block, answering(f.agent, f.tab, 'once', cards),
      async () => (await f.bind(approved)).block, advisories), null);
    assert.equal(cards.length, 1);
    assert.equal(cards[0].question, 'Send this message on example.test?');
    assert.equal(cards[0].unverifiedStepConfirmation.content, f.draft);
    assert.equal(cards[0].timeoutAnswer, undefined, 'a hard card has no countdown');
    assert.equal(f.probes.at(-1).allowUnidentifiedRecipient, true);
    assert.deepEqual({ required: approved.messageRecipientGuardRequired, binding: approved.messageRecipientDispatchBinding,
      body: approved.messageRecipientBody, baseline: approved.messageRecipientBodyBaselineCount },
    { required: true, binding: { token: 'wbmr_test_token' }, body: f.draft, baseline: 0 });
    assert.equal(f.guard.messageRecipientTechnicalBlock, undefined);
    assert.match(advisories[0].note, /WebBrain could not read who this message goes to; the user approved it/);
    f.agent._settleUnverifiedStepScope(f.tab);
    const next = await f.bind();
    assert.ok(next.block.unverifiedStepConfirmation, 'the next send asks again');
    assert.equal(next.context.messageRecipientDispatchBinding, undefined);
  });

  test(`${build}: "Don't", a changed draft and an unattended run keep a send without a readable recipient from going out`, async () => {
    const declined = recipientFixture();
    const first = await declined.bind();
    const cards = [];
    const refused = await declined.agent._resolveUnverifiedStepConfirmation(declined.tab, first.block,
      answering(declined.agent, declined.tab, 'deny', cards), async () => (await declined.bind()).block, []);
    assert.equal(refused.unverifiedStepDeclined, true);
    assert.equal(refused.retryable, false);
    assert.equal(refused.reasonCode, 'recipient_identity_unavailable');
    assert.match(refused.error, /The user chose not to go ahead with sending this message, so it was not performed/);
    assert.equal(first.context.messageRecipientDispatchBinding, undefined);
    const again = await declined.agent._resolveUnverifiedStepConfirmation(declined.tab, (await declined.bind()).block,
      answering(declined.agent, declined.tab, 'once', cards), async () => (await declined.bind()).block, []);
    assert.equal(cards.length, 1, 'the same draft is not asked about again');
    assert.match(again.error, /already chose not to go ahead/);
    // The draft changes while the card waits: the answer covered other text.
    const changed = recipientFixture();
    const context = {};
    const moved = await changed.agent._resolveUnverifiedStepConfirmation(changed.tab, (await changed.bind()).block, (type, data) => {
      if (type !== 'clarify') return;
      changed.draft = 'Hi Bob, here is my card number';
      changed.agent.submitClarifyResponse(changed.tab, data.clarifyId, 'once', 'option');
    }, async () => (await changed.bind(context)).block, []);
    assert.match(moved.error, /changed while the user was being asked/);
    assert.equal(context.messageRecipientDispatchBinding, undefined);
    const unattended = recipientFixture();
    unattended.agent.scheduledRunPolicies.set(unattended.tab, { requireConsequentialConfirmation: false });
    const silent = await unattended.agent._resolveUnverifiedStepConfirmation(unattended.tab, (await unattended.bind()).block,
      () => assert.fail('an unattended run shows no card'), async () => (await unattended.bind()).block, []);
    assert.match(silent.error, /This unattended run cannot ask the user about sending this message/);
    // A draft WebBrain cannot read leaves nothing to show: no card.
    const unreadable = recipientFixture();
    unreadable.draft = '';
    assert.equal((await unreadable.bind()).block.unverifiedStepConfirmation, undefined);
  });

  // ── click-duplicate-submit, through the tool batch ─────────────────────
  test(`${build}: a repeated commit click asks on a hard card before it is sent`, async () => {
    const provider = { name: 'repeat test', model: 'test', promptTier: 'full', contextWindow: 128000,
      supportsTools: true, supportsVision: false, chat: async () => ({ content: '' }) };
    const agent = new Agent({ getActive: () => provider, getProvider: () => provider, getVisionProvider: async () => null });
    agent.clarifyTimeoutSec = 0;
    agent._persist = () => {};
    agent._persistNow = async () => ({ ok: true });
    const tab = nextTab++;
    agent._taskTokens.set(tab, `task-${tab}`);
    agent._planExecutionGuards.set(tab, { enabled: false, taskKey: `key-${tab}` });
    agent._lastAxScopes.set(tab, { documentToken: 'doc-1', pageUrl: EDIT_URL });
    agent._currentUrl = async () => EDIT_URL;
    agent._skipPermissionGate = true;
    agent._ensureGateSetting = async () => true;
    for (const name of ['_chromeProtectedPageFailure', '_captchaMutationPreflight', '_messageRecipientGuardBlock',
      '_detectLikelySubmitAction', '_socialPublicationPreSubmitBlock']) agent[name] = async () => null;
    agent._adoptLiveSocialPublishWorkflow = async () => false;
    agent._captureFormValidationState = async () => [];
    agent._waitForFormValidationFailure = async () => null;
    agent._auditRichTextToolbarTarget = async () => {};
    agent._shouldAutoScreenshot = () => false;
    agent._refreshPageFeedbackForCall = async () => false;
    // What each caption does, as a model read it.
    const readings = { Publish: 'publish', Save: 'commit', Next: 'other' };
    agent._controlEffectReading = caption => readings[caption] || null;
    agent._readControlEffect = async caption => readings[caption] || null;
    const clickedAt = Date.now() - 5_000;
    agent._recentSubmitClicks.set(tab, ['Publish', 'Save', 'Next', 'Send'].map(text => (
      { key: `${text.toLowerCase()}|${EDIT_URL}`, ts: clickedAt, url: EDIT_URL, text })));
    // The click handler itself is stubbed: what reaches it is what is checked
    // here (its own check of an approved repeat is in control-effect-readings).
    const dispatched = [];
    let notes = [];
    agent.executeTool = async (_tab, name, args, _onUpdate, context) => {
      dispatched.push({ text: args.text, approved: context.duplicateSubmitApproved });
      notes = [...(context.guardAdvisories || [])];
      return { success: true, dispatched: true, verified: true };
    };
    const cards = [];
    const run = async (id, text, answer) => {
      const messages = [];
      await agent._executeToolBatch(tab, [call(id, 'click', { text })], messages, (type, data) => {
        if (type !== 'clarify') return;
        cards.push(data);
        setTimeout(() => agent.submitClarifyResponse(tab, data.clarifyId, answer, 'option'), 20);
      }, provider, null, new Set(['click', 'done']), 1, {});
      return resultFor(messages, id);
    };
    // A caption that commits nothing repeats without a question.
    const ordinary = await run('next', 'Next', 'deny');
    assert.equal(ordinary.success, true, JSON.stringify(ordinary));
    assert.equal(cards.length, 0);
    assert.deepEqual(dispatched, [{ text: 'Next', approved: false }]);
    // Don't: nothing is clicked, and the same repeat is not asked about again.
    const denied = await run('publish-1', 'Publish', 'deny');
    assert.equal(cards.length, 1);
    assert.deepEqual({ ...cards[0].unverifiedStepConfirmation }, { guardId: 'click-duplicate-submit', hard: true, action: 'click',
      host: 'github.com', reason: 'repeat_unverified', content: 'Publish', contentLabel: 'page' });
    assert.equal(cards[0].timeoutAnswer, undefined, 'Instant does not answer a hard card');
    assert.equal(denied.unverifiedStepDeclined, true);
    assert.equal(denied.blockedDuplicateSubmit, true);
    assert.match(denied.error, /The user chose not to go ahead with clicking this control again so soon/);
    assert.doesNotMatch(JSON.stringify(denied), /_allowResubmit/);
    assert.equal(dispatched.length, 1);
    const again = await run('publish-2', 'Publish', 'once');
    assert.equal(cards.length, 1);
    assert.match(again.error, /already chose not to go ahead/);
    // Go ahead: this one click is sent with the approval the click handler's own check honours.
    const approved = await run('save-1', 'Save', 'once');
    assert.equal(cards.length, 2);
    assert.equal(approved.success, true, JSON.stringify(approved));
    assert.deepEqual(dispatched.at(-1), { text: 'Save', approved: true });
    assert.match(notes.find(item => item.guard === 'click-duplicate-submit').note,
      /This control was already clicked on this page moments ago; the user approved it/);
    await run('save-2', 'Save', 'once');
    assert.equal(cards.length, 3, 'one answer covers one click; the next repeat asks again');
    // An unattended run cannot ask: refused without a card.
    agent.scheduledRunPolicies.set(tab, { requireConsequentialConfirmation: false });
    readings.Send = 'commit';
    const unattended = await run('send', 'Send', 'once');
    assert.equal(cards.length, 3);
    assert.match(unattended.error, /This unattended run cannot ask the user about clicking this control again so soon/);
    assert.equal(dispatched.filter(item => item.text === 'Send').length, 0);
  });
}

// ── side panel ───────────────────────────────────────────────────────────
let chromiumBrowser;
before(async () => { chromiumBrowser = await chromium.launch({ headless: true }); });
after(async () => { await chromiumBrowser?.close(); });

const ringSource = async (build) => (await read(`src/${build}/src/ui/timeout-ring.js`)).replace(/^export /gm, '');

function extract(source, name) {
  source = source.replace(/\r\n/g, '\n');
  const start = source.search(new RegExp(`^(?:async )?function ${name}\\(`, 'm'));
  assert.ok(start >= 0, name);
  return source.slice(start, source.indexOf('\n}', start) + 2);
}

async function panel(build, locale = 'en') {
  const source = await read(`src/${build}/src/ui/sidepanel.js`);
  const english = (await import(`../src/${build}/src/ui/locales/en.js`)).default;
  const strings = (await import(`../src/${build}/src/ui/locales/${locale}.js`)).default;
  const page = await chromiumBrowser.newPage({ viewport: { width: 380, height: 700 } });
  await page.setContent(`<style>${await read(`src/${build}/styles/sidepanel.css`)}</style>
    <div class="message assistant" data-run-request-id="request-1"><div class="message-content"><div class="message-text"></div></div></div>`);
  await page.addScriptTag({ content: `(() => {
    const STRINGS = ${JSON.stringify({ ...english, ...strings })};
    const t = (key, params) => String(STRINGS[key] ?? key).replace(/\\{(\\w+)\\}/g, (_, name) => params?.[name] ?? '{' + name + '}');
    let currentTabId = 9;
    let currentAssistantEl = document.querySelector('.message.assistant');
    const submittedClarificationIds = new Set();
    const sent = [];
    function clarificationSubmissionKey(tabId, requestId, clarifyId) { return JSON.stringify([Number(tabId), String(requestId || ''), String(clarifyId || '')]); }
    function hideActivity() {} function scrollToBottom() {} function hideRecommendedActions() {}
    function resetChatNavigation() {} function addMessage() { return currentAssistantEl; } function applyClarifyTimeoutExtension() {}
    function placeAnsweredClarifyCardInTimeline() {} function maybeShowPermissionEducationHint() {}
    function workflowHealingTargetLabel(value) { return String(value || ''); } function keepClarifyAliveWhileTyping() {}
    function sameTabId(a, b) { return Number(a) === Number(b); } function restoreActiveRunState() {}
    function schedulePersist() {}
    const CAPABILITY_LABEL = {};
    async function sendToBackground(action, payload) { sent.push([action, payload]); return { matched: true }; }
    ${extract(source, 'renderClarifyCard')}
    ${extract(source, 'submitClarify')}
    ${await ringSource(build)}
    ${extract(source, 'clearClarifyCountdown')}
    ${extract(source, 'startClarifyCountdown')}
    ${extract(source, 'lockClarifyCardFromAuto')}
    window.panel = { render: renderClarifyCard, lock: lockClarifyCardFromAuto, sent };
  })();` });
  return page;
}

const stepCard = (extra = {}, step = {}) => ({ clarifyId: 'unverified_card', tabId: 9, promptKind: 'unverifiedStepConfirmation',
  question: 'Commit this on github.com?', options: ['once', 'deny'], timeoutSec: 30, deadlineTs: Date.now() + 30_000, timeoutAnswer: 'once',
  unverifiedStepConfirmation: { guardId: 'github-commit-evidence-binding', hard: false, action: 'commit', host: 'github.com',
    reason: 'editor_unverified', content: '# Notes\n\n<img src=x onerror="window.injected=1"><b>bold</b>', contentLabel: 'editor', ...step },
  ...extra });

for (const build of ['chrome', 'firefox']) {
  test(`${build}: the side panel shows the page text as text, counts down to the decided answer and backs it up`, async () => {
    const page = await panel(build);
    try {
      await page.evaluate(data => window.panel.render(data), stepCard());
      const view = await page.evaluate(() => {
        const card = document.querySelector('.clarify-card');
        return { question: card.querySelector('.clarify-question').textContent,
          reasons: [...card.querySelectorAll('.clarify-reason')].map(node => node.textContent),
          content: card.querySelector('.clarify-content').textContent,
          markup: card.querySelectorAll('img, b').length, injected: window.injected === 1,
          buttons: [...card.querySelectorAll('.clarify-option')].map(button => [button.dataset.value, button.textContent]),
          input: !!card.querySelector('input, textarea'), memory: card.dataset.memorySource,
          countdown: card.querySelector('.clarify-timeout')?.textContent, flag: card.dataset.unverifiedStepConfirmation };
      });
      assert.equal(view.question, 'Commit this on github.com?');
      assert.deepEqual(view.reasons, ['WebBrain typed the text but couldn’t read it back exactly.', 'In the editor now:']);
      assert.equal(view.content, '# Notes\n\n<img src=x onerror="window.injected=1"><b>bold</b>', 'textContent only');
      assert.equal(view.markup, 0);
      assert.equal(view.injected, false);
      assert.deepEqual(view.buttons, [['once', 'Go ahead'], ['deny', 'Don’t']]);
      assert.equal(view.input, false, 'no free text to interpret');
      assert.equal(view.memory, '', 'the answer is not saved to memory');
      assert.equal(view.flag, '1');
      assert.match(view.countdown, /^Picks “Go ahead” in (29|30)s$/);
      // The backup submit sends the decided value and names its label.
      await page.evaluate(data => window.panel.render(data), stepCard({ clarifyId: 'unverified_backup', deadlineTs: Date.now() + 60,
        timeoutAnswer: 'deny' }));
      await page.waitForFunction(() => window.panel.sent.length === 1);
      const backup = await page.evaluate(() => ({ sent: window.panel.sent[0],
        answered: document.querySelector('.clarify-card[data-clarify-id="unverified_backup"] .clarify-your-answer')?.textContent }));
      assert.deepEqual(backup.sent, ['clarify_response', { tabId: 9, clarifyId: 'unverified_backup', answer: 'deny', source: 'timeout' }]);
      assert.equal(backup.answered, 'Auto-selected (timed out): Don’t');
      // A click sends the fixed value.
      await page.click('.clarify-card[data-clarify-id="unverified_card"] button[data-value="once"]');
      const clicked = await page.evaluate(() => ({ sent: window.panel.sent[1],
        answered: document.querySelector('.clarify-card[data-clarify-id="unverified_card"] .clarify-your-answer')?.textContent }));
      assert.deepEqual(clicked.sent, ['clarify_response', { tabId: 9, clarifyId: 'unverified_card', answer: 'once', source: 'option' }]);
      assert.equal(clicked.answered, 'Your answer: Go ahead');
    } finally {
      await page.close();
    }
  });

  test(`${build}: the agent's timeout locks the card; a hard card and an unreadable page show no countdown`, async () => {
    const page = await panel(build, 'tr');
    try {
      await page.evaluate(data => window.panel.render(data), stepCard({ clarifyId: 'unverified_auto' }));
      await page.evaluate(() => window.panel.lock({ clarifyId: 'unverified_auto', answer: 'once', source: 'timeout' }));
      const locked = await page.evaluate(() => {
        const card = document.querySelector('.clarify-card[data-clarify-id="unverified_auto"]');
        return { answered: card.querySelector('.clarify-your-answer')?.textContent,
          disabled: [...card.querySelectorAll('button')].every(button => button.disabled),
          countdown: !!card.querySelector('.clarify-timeout') };
      });
      assert.equal(locked.answered, 'Otomatik seçildi (süre doldu): Devam et');
      assert.equal(locked.disabled, true);
      assert.equal(locked.countdown, false);
      await page.evaluate(data => window.panel.render(data), stepCard({ clarifyId: 'unverified_hard', timeoutSec: 0,
        deadlineTs: undefined, timeoutAnswer: undefined }, { hard: true, action: 'click', reason: 'repeat_unverified', content: '',
        contentLabel: 'page', host: 'shop.example' }));
      const hard = await page.evaluate(() => {
        const card = document.querySelector('.clarify-card[data-clarify-id="unverified_hard"]');
        return { question: card.querySelector('.clarify-question').textContent,
          reasons: [...card.querySelectorAll('.clarify-reason')].map(node => node.textContent),
          content: !!card.querySelector('.clarify-content'), countdown: !!card.querySelector('.clarify-timeout') };
      });
      assert.equal(hard.question, 'shop.example üzerinde bu denetime tıklansın mı?');
      assert.deepEqual(hard.reasons, ['Bu denetime yapılan önceki bir tıklama zaten işe yaramış olabilir ve WebBrain bunu kontrol edemedi.',
        'Yanıtlamadan önce sayfaya bak.']);
      assert.equal(hard.content, false);
      assert.equal(hard.countdown, false, 'a hard card has no countdown');
    } finally {
      await page.close();
    }
  });

  // credential-not-provided: the sign-in password card names the site and
  // the field, says where the text did not come from, shows it masked (or
  // not at all with strict secret handling), and answers "Type it" or
  // "Don't type it".
  test(`${build}: the sign-in password card names the field and shows the text masked`, async () => {
    const page = await panel(build);
    try {
      const credentialCard = (clarifyId, step = {}) => stepCard({ clarifyId, question: 'Type this into a sign-in password field on localhost?',
        timeoutSec: 0, deadlineTs: undefined, timeoutAnswer: undefined },
      { guardId: 'credential-not-provided', hard: true, action: 'type', host: 'localhost', reason: 'credential_not_provided',
        content: 'a••••', contentLabel: 'masked', ...step });
      const view = async clarifyId => page.evaluate(id => {
        const card = document.querySelector(`.clarify-card[data-clarify-id="${id}"]`);
        return { question: card.querySelector('.clarify-question').textContent,
          reasons: [...card.querySelectorAll('.clarify-reason')].map(node => node.textContent),
          content: card.querySelector('.clarify-content')?.textContent ?? null,
          buttons: [...card.querySelectorAll('.clarify-option')].map(button => [button.dataset.value, button.textContent]),
          input: !!card.querySelector('input, textarea'), memory: card.dataset.memorySource,
          countdown: !!card.querySelector('.clarify-timeout') };
      }, clarifyId);
      await page.evaluate(data => window.panel.render(data), credentialCard('unverified_password'));
      const masked = await view('unverified_password');
      assert.equal(masked.question, 'Type this into a sign-in password field on localhost?');
      assert.deepEqual(masked.reasons, ['It isn’t a password you gave in this conversation, your profile or your saved notes.',
        'The text WebBrain would type, masked:']);
      assert.equal(masked.content, 'a••••');
      assert.deepEqual(masked.buttons, [['once', 'Type it'], ['deny', 'Don’t type it']]);
      assert.equal(masked.input, false);
      assert.equal(masked.memory, '', 'the answer is not saved to memory');
      assert.equal(masked.countdown, false, 'a hard card has no countdown');
      await page.evaluate(data => window.panel.render(data), credentialCard('unverified_password_strict', { content: '', contentLabel: 'hidden' }));
      const hidden = await view('unverified_password_strict');
      assert.deepEqual(hidden.reasons, ['It isn’t a password you gave in this conversation, your profile or your saved notes.',
        'Strict secret handling is on, so the text isn’t shown.']);
      assert.equal(hidden.content, null);
      await page.click('.clarify-card[data-clarify-id="unverified_password"] button[data-value="deny"]');
      const answered = await page.evaluate(() => ({ sent: window.panel.sent.at(-1),
        label: document.querySelector('.clarify-card[data-clarify-id="unverified_password"] .clarify-your-answer')?.textContent }));
      assert.deepEqual(answered.sent, ['clarify_response', { tabId: 9, clarifyId: 'unverified_password', answer: 'deny', source: 'option' }]);
      assert.equal(answered.label, 'Your answer: Don’t type it');
    } finally {
      await page.close();
    }
  });

  // The hard-class asks for dead ends: a Delete control whose items WebBrain
  // cannot identify, a message whose recipient it cannot read, a request it
  // would send itself, and an item an earlier attempt may have deleted.
  test(`${build}: the side panel shows the cards for a Delete control, an unreadable recipient, a request and a repeated deletion`, async () => {
    const page = await panel(build);
    try {
      const hardCard = (clarifyId, step) => stepCard({ clarifyId, timeoutSec: 0, deadlineTs: undefined, timeoutAnswer: undefined },
        { hard: true, content: '', contentLabel: 'page', ...step });
      const view = async clarifyId => page.evaluate(id => {
        const card = document.querySelector(`.clarify-card[data-clarify-id="${id}"]`);
        return { question: card.querySelector('.clarify-question').textContent,
          reasons: [...card.querySelectorAll('.clarify-reason')].map(node => node.textContent),
          content: card.querySelector('.clarify-content')?.textContent ?? null,
          subject: card.querySelector('.clarify-subject')?.textContent ?? null,
          markup: card.querySelectorAll('img, b').length,
          buttons: [...card.querySelectorAll('.clarify-option')].map(button => [button.dataset.value, button.textContent]),
          input: !!card.querySelector('input, textarea'), countdown: !!card.querySelector('.clarify-timeout') };
      }, clarifyId);
      await page.evaluate(data => window.panel.render(data), hardCard('unverified_delete',
        { guardId: 'deletion-guard-refusal', action: 'delete', reason: 'delete_unbound', host: 'mail.example' }));
      const deletion = await view('unverified_delete');
      assert.equal(deletion.question, 'Click this delete control on mail.example?');
      assert.deepEqual(deletion.reasons, ['WebBrain can’t tell which items this control would delete.', 'Check the page before you answer.']);
      assert.equal(deletion.content, null, 'no item was identified, so none is shown');
      assert.deepEqual(deletion.buttons, [['once', 'Delete'], ['deny', 'Don’t delete']]);
      assert.equal(deletion.countdown, false, 'a hard card has no countdown');
      assert.equal(deletion.input, false);
      await page.evaluate(data => window.panel.render(data), hardCard('unverified_send', { guardId: 'recipient-guard-refusal',
        action: 'send', reason: 'recipient_unreadable', host: 'example.test', contentLabel: 'composer',
        content: 'Hi Bob <b>now</b><img src=x onerror="window.injected=1">' }));
      const send = await view('unverified_send');
      assert.equal(send.question, 'Send this message on example.test?');
      assert.deepEqual(send.reasons, ['WebBrain couldn’t read who this message goes to.', 'In the composer now:']);
      assert.equal(send.content, 'Hi Bob <b>now</b><img src=x onerror="window.injected=1">', 'the draft is shown as text');
      assert.equal(send.markup, 0);
      assert.equal(await page.evaluate(() => window.injected === 1), false);
      assert.deepEqual(send.buttons, [['once', 'Go ahead'], ['deny', 'Don’t']]);
      assert.equal(send.countdown, false);
      await page.evaluate(data => window.panel.render(data), hardCard('unverified_request', { guardId: 'steer-prior-submission-unreconciled',
        action: 'submit', reason: 'prior_submission_unreconciled', host: 'cms.example', contentLabel: 'request',
        content: 'POST https://cms.example/api/posts\n\n{"title":"Hello"}' }));
      const request = await view('unverified_request');
      assert.equal(request.question, 'Submit this on cms.example?');
      assert.deepEqual(request.reasons, ['Something was already submitted before your correction, and WebBrain couldn’t check what it did.',
        'The request WebBrain would send:']);
      assert.equal(request.content, 'POST https://cms.example/api/posts\n\n{"title":"Hello"}');
      // The deletion card's own reason for an item an earlier attempt may have deleted.
      await page.evaluate(data => window.panel.render(data), { clarifyId: 'deletion_repeat', tabId: 9, promptKind: 'mutationConfirmation',
        question: 'Delete this item on mastoturk.org?', options: ['once', 'deny'],
        mutationConfirmation: { kind: 'delete', reason: 'repeat', host: 'mastoturk.org', item: 'WebBrain test post', url: '', dialog: '' } });
      const repeat = await view('deletion_repeat');
      assert.equal(repeat.question, 'Delete this item on mastoturk.org?');
      assert.deepEqual(repeat.reasons, ['An earlier attempt may already have deleted this item, and WebBrain couldn’t check.']);
      assert.equal(repeat.subject, 'WebBrain test post');
      assert.deepEqual(repeat.buttons, [['once', 'Delete'], ['deny', 'Don’t delete']]);
      await page.click('.clarify-card[data-clarify-id="unverified_delete"] button[data-value="once"]');
      const answered = await page.evaluate(() => ({ sent: window.panel.sent.at(-1),
        label: document.querySelector('.clarify-card[data-clarify-id="unverified_delete"] .clarify-your-answer')?.textContent }));
      assert.deepEqual(answered.sent, ['clarify_response', { tabId: 9, clarifyId: 'unverified_delete', answer: 'once', source: 'option' }]);
      assert.equal(answered.label, 'Your answer: Delete');
    } finally {
      await page.close();
    }
  });
}

test('every locale of both builds translates the card', async () => {
  const keys = ['question.commit', 'question.submit', 'question.publish', 'question.click', 'question.type',
    'question.delete', 'question.send',
    'reason.editor_unverified', 'reason.draft_unverified', 'reason.draft_unobserved',
    'reason.submit_unclear', 'reason.target_unresolved', 'reason.repeat_unverified', 'reason.step_unverified',
    'reason.credential_not_provided',
    'reason.delete_unbound', 'reason.prior_submission_unreconciled', 'reason.recipient_unreadable',
    'content.editor', 'content.composer', 'content.page', 'content.masked', 'content.hidden', 'content.request', 'check_page',
    'go_ahead', 'dont', 'type_it', 'dont_type']
    .map(key => `sp.unverified.${key}`);
  // The deletion card's reason for an item an earlier attempt may have deleted.
  keys.push('sp.delete.reason_repeat');
  for (const build of ['chrome', 'firefox']) {
    const directory = new URL(`../src/${build}/src/ui/locales/`, import.meta.url);
    const files = (await fs.readdir(directory)).filter(name => /^[a-z]{2}\.js$/.test(name));
    assert.equal(files.length, 23, `${build}: locale count`);
    const english = (await import(new URL('en.js', directory))).default;
    for (const file of files) {
      const strings = (await import(new URL(file, directory))).default;
      for (const key of keys) {
        assert.equal(typeof strings[key], 'string', `${build}/${file}: ${key}`);
        assert.ok(strings[key].trim(), `${build}/${file}: ${key}`);
        if (file !== 'en.js') assert.notEqual(strings[key], english[key], `${build}/${file}: ${key} is still English`);
        assert.equal(strings[key].includes('{host}'), key.startsWith('sp.unverified.question.'), `${build}/${file}: ${key} host`);
      }
    }
  }
  // The panel and the agent agree on the card's vocabulary.
  for (const build of ['chrome', 'firefox']) {
    const source = await read(`src/${build}/src/ui/sidepanel.js`);
    const { UNVERIFIED_STEP_ACTIONS, UNVERIFIED_STEP_REASONS, UNVERIFIED_STEP_CONTENT_LABELS } = await import(`../src/${build}/src/agent/unverified-step.js`);
    for (const action of UNVERIFIED_STEP_ACTIONS) assert.match(source, new RegExp(`'${action}'`));
    for (const reason of UNVERIFIED_STEP_REASONS.filter(reason => reason !== 'step_unverified')) assert.match(source, new RegExp(`'${reason}'`));
    for (const label of UNVERIFIED_STEP_CONTENT_LABELS.filter(label => label !== 'page')) assert.match(source, new RegExp(`'${label}'`));
  }
});
