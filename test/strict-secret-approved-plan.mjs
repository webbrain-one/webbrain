// Strict secret handling keeps a credential out of the planner's approved
// plan. A QA sign-in run gave a username and password in the request; the
// planner wrote the password into a step ("Fill the username and password
// fields with … and …") and that plan was pinned into every later model
// request and saved with the conversation, although the password was known
// to the redactor as soon as it was typed into the password field: the scrub
// left app-owned approved plans as written. The planner is now also told, in
// strict mode, not to copy credentials into the plan. Typing still gets the
// real value, from the user's message, and without strict mode nothing
// changes.
import assert from 'node:assert/strict';
import { test } from 'node:test';

const SECRET = 'Fake-Pass 7!xq';
const USERNAME = 'test-user-a';
const tab = 61;
const storage = new Map();
const area = {
  get: async key => (typeof key === 'string' ? { [key]: storage.get(key) } : {}),
  set: async values => { for (const [key, value] of Object.entries(values || {})) storage.set(key, value); },
  remove: async key => { storage.delete(key); },
};
// What the content script was asked to type into each field.
const typed = [];
globalThis.chrome = globalThis.browser = {
  storage: { local: area, session: area },
  runtime: { getURL: value => `extension://test/${value}`, sendMessage: async () => ({}) },
  tabs: {
    get: async id => ({ id, url: 'https://portal.example.com/login' }),
    sendMessage: async (_tab, message) => {
      if (message?.action !== 'set_field') return { success: true };
      typed.push({ ref: message.params?.ref_id, text: message.params?.text });
      const fieldMeta = message.params?.ref_id === 'ref_password'
        ? { tag: 'input', type: 'password', name: 'password' }
        : { tag: 'input', type: 'text', name: 'username' };
      return { success: true, verified: true, actual: message.params?.text, fieldMeta };
    },
  },
  scripting: { executeScript: async () => [{ result: null }] },
  webNavigation: { getAllFrames: async () => [{ frameId: 0 }] },
};

const user = text => ({ role: 'user', content: text, webbrainUserAuthoredText: text });
const request = `Sign in to the portal on this page with username ${USERNAME} and password ${SECRET}, then tell me what the welcome message says.`;

// What a model that ignores the rule plans: the password in a step, the
// summary and a risk.
function signInPlan(secret = SECRET) {
  return {
    request_kind: 'execute', scope_relation: 'new', deliverables: ['sign in to the portal', 'report the welcome message'],
    expected_items: null, site_job: null, conditional_site_job: null,
    requires_state_change: true, requires_submission: true, messaging: null,
    completion_requirements: { download: false }, allows_planner_shaped_result: false,
    allows_app_state_tool_evidence: false, read_scope: 'visible_page',
    summary: `Sign in as ${USERNAME} with ${secret} and read the welcome message.`, confidence: 0.95,
    steps: [
      { id: '1', action: 'Inspect the sign-in form.', tools: ['get_accessibility_tree'] },
      { id: '2', action: `Fill the username and password fields with ${USERNAME} and ${secret}.`, tools: ['set_field'] },
      { id: '3', action: 'Submit the form and read the welcome message.', tools: ['click_ax', 'read_page'] },
    ],
    skill_ids: [], memory: { use_scratchpad: false, scratchpad_notes: [], use_progress_ledger: false, progress_action: null },
    scheduling: null, risks: [`The password ${secret} may be rejected.`],
    localized: { locale: 'en', summary: 'Sign in and read the welcome message.', steps: [], risks: [] },
    response_language: { framing_locale: 'en', deliverable_locales: ['en'], preserve_source_text: false },
  };
}

for (const build of ['chrome', 'firefox']) {
  const { Agent } = await import(`../src/${build}/src/agent/agent.js`);
  const { buildPlannerSystemPrompt, buildPlannerIntentSystemPrompt, PLANNER_STRICT_SECRET_RULE } =
    await import(`../src/${build}/src/agent/planner.js`);

  function fixture({ strict = true } = {}) {
    storage.clear();
    typed.length = 0;
    const provider = { model: 'owned-strict-plan-fixture', config: { category: 'local' }, chat: async () => ({ content: '{}' }) };
    const agent = new Agent({ getActive: () => provider, getVisionProvider: async () => null });
    agent._persist = () => {};
    agent._persistSubmittedTurn = async () => ({ ok: true });
    agent.useSiteAdapters = false;
    agent.strictSecretMode = strict;
    agent.conversations.set(tab, [{ role: 'system', content: 'sys' }]);
    agent.conversationModes.set(tab, 'act');
    agent.conversationIds.set(tab, 'strict-plan-conversation');
    agent.setPlanBeforeActMode('try');
    agent.setPlanReviewSettings({ mode: 'never' });
    const plannerSystemPrompts = [];
    let plan = signInPlan();
    agent._chatWithCostAllowance = async (_provider, modelMessages) => {
      let payload;
      try { payload = JSON.parse(modelMessages.at(-1).content); } catch {}
      if (payload?.task_binding) {
        return { content: JSON.stringify({ task_binding: payload.task_binding, aligned: true, reason: 'The plan signs in as asked.' }) };
      }
      plannerSystemPrompts.push(modelMessages[0].content);
      return { content: JSON.stringify(plan) };
    };
    return { agent, plannerSystemPrompts, setPlan: next => { plan = next; } };
  }

  // One planned turn, as the run loop starts it: the gate pins the plan and
  // the run's execution guard is built from the gate's outcome.
  async function plannedTurn(agent, text) {
    const messages = agent.conversations.get(tab);
    const outcome = await agent._maybeRunPlannerGate(tab, messages, user(text), () => {}, 'act', {}, null,
      { tabUrl: 'https://portal.example.com/login', tabTitle: 'Portal sign-in' });
    assert.equal(outcome.proceed, true, JSON.stringify(outcome));
    agent._startPlanExecutionGuard(tab, 'act', outcome, {});
    return outcome;
  }

  const scratchpadOf = agent => {
    const messages = agent.conversations.get(tab);
    const index = agent._findScratchpadIndex(messages);
    return { message: messages[index], body: index >= 0 ? agent._extractScratchpadBody(messages[index].content) : '' };
  };

  test(`${build}: a credential typed into a password field is struck from the pinned planner plan and its copies`, async () => {
    const { agent } = fixture();
    const outcome = await plannedTurn(agent, request);
    assert.match(outcome.approvedScratchpadText, /^\[Approved plan — pinned by planner\]/);
    // The agent types the value the user gave.
    const username = await agent.executeTool(tab, 'set_field', { ref_id: 'ref_username', text: USERNAME });
    const password = await agent.executeTool(tab, 'set_field', { ref_id: 'ref_password', text: SECRET });
    assert.equal(username.success, true);
    assert.equal(password.success, true);
    assert.deepEqual(typed, [{ ref: 'ref_username', text: USERNAME }, { ref: 'ref_password', text: SECRET }]);

    const { message, body } = scratchpadOf(agent);
    assert.equal(body.includes(SECRET), false);
    assert.match(body, /Fill the username and password fields with test-user-a and \[redacted credential\]\./);
    assert.match(body, /Sign in as test-user-a with \[redacted credential\] and read the welcome message\./);
    assert.match(body, /The password \[redacted credential\] may be rejected\./);
    // Still the app's approved plan: owned, recognized and anchored.
    const ranges = agent._scratchpadApprovedPlanRanges(message);
    assert.equal(ranges.length, 1);
    assert.equal(ranges[0].text.startsWith('[Approved plan — pinned by planner]\n'), true);
    assert.equal(JSON.stringify(message.webbrainAppOwnedApprovedPlans).includes(SECRET), false);
    assert.equal(agent._hasApprovedExecutionPlan(agent.conversations.get(tab)), true);
    // The run's copies follow: steering still finds the plan by the guard's
    // text, and the recovery anchor repeats the struck plan.
    const guard = agent._planExecutionGuards.get(tab);
    assert.equal(guard.approvedPlanText.includes(SECRET), false);
    assert.equal(guard.approvedPlanText, ranges[0].text);
    assert.equal(body.includes(guard.approvedPlanText), true);
    assert.equal(guard.approvedPlanAnchor, agent._approvedExecutionPlanAnchor(guard.approvedPlanText));
    assert.match(guard.approvedPlanAnchor, /\[redacted credential\]/);
    assert.equal(guard.approvedPlanAnchor.includes(SECRET), false);
    assert.match(agent._executionTaskRecoveryAnchor(guard), /"approvedPlan":"[^"]*\[redacted credential\]/);
    // What later requests carry and what is saved: only the user's own
    // message, which the agent types from, still holds the value.
    const holding = agent.conversations.get(tab).filter(entry => JSON.stringify(entry).includes(SECRET));
    assert.deepEqual(holding.map(entry => entry.content), [request]);
    const saved = JSON.stringify(agent._conversationStorageEntry(tab));
    assert.equal(saved.split(SECRET).length - 1, 2, 'The saved user message and its authored text, nothing else');
  });

  test(`${build}: a plan pinned after the credential is known is pinned without it`, async () => {
    const { agent, setPlan } = fixture();
    await plannedTurn(agent, request);
    await agent.executeTool(tab, 'set_field', { ref_id: 'ref_password', text: SECRET });
    agent.conversations.get(tab).push({ role: 'assistant', content: 'Signed in. The welcome message says hello.' });
    // A new task in the same conversation; the planner copies the known
    // value from the earlier request.
    setPlan(signInPlan());
    const outcome = await plannedTurn(agent, 'Sign out, then sign in again with the same password.');
    assert.equal(outcome.approvedScratchpadText.includes(SECRET), false);
    assert.match(outcome.approvedScratchpadText, /with test-user-a and \[redacted credential\]\./);
    const { message, body } = scratchpadOf(agent);
    assert.equal(body.includes(SECRET), false);
    assert.deepEqual(agent._scratchpadApprovedPlanRanges(message).map(range => range.text), [outcome.approvedScratchpadText]);
    const guard = agent._planExecutionGuards.get(tab);
    assert.equal(guard.approvedPlanText, outcome.approvedScratchpadText);
    assert.equal(guard.approvedPlanAnchor.includes(SECRET), false);
    // A value of the plan's own marker is never struck from it.
    agent._rememberCredentialValues(tab, ['planner'], { scrub: false });
    assert.equal(agent._redactApprovedPlanCredentials(tab, '[Approved plan — pinned by planner]\nAsk the planner team.'),
      '[Approved plan — pinned by planner]\nAsk the [redacted credential] team.');
  });

  test(`${build}: without strict secret handling the plan and the planner prompt are unchanged`, async () => {
    const { agent, plannerSystemPrompts } = fixture({ strict: false });
    const outcome = await plannedTurn(agent, request);
    await agent.executeTool(tab, 'set_field', { ref_id: 'ref_password', text: SECRET });
    assert.deepEqual(typed, [{ ref: 'ref_password', text: SECRET }]);
    const { body } = scratchpadOf(agent);
    assert.equal(body, outcome.approvedScratchpadText);
    assert.match(body, /with test-user-a and Fake-Pass 7!xq\./);
    assert.equal(agent._planExecutionGuards.get(tab).approvedPlanText, outcome.approvedScratchpadText);
    assert.equal(plannerSystemPrompts.length, 1);
    assert.equal(plannerSystemPrompts[0].includes(PLANNER_STRICT_SECRET_RULE), false);
  });

  test(`${build}: strict secret handling tells the planner to keep credentials out of the plan`, async () => {
    const { agent, plannerSystemPrompts } = fixture();
    await plannedTurn(agent, request);
    assert.equal(plannerSystemPrompts.length, 1);
    assert.equal(plannerSystemPrompts[0].includes(PLANNER_STRICT_SECRET_RULE), true);
    assert.match(PLANNER_STRICT_SECRET_RULE, /never copy a password/);
    for (const builder of [buildPlannerSystemPrompt, buildPlannerIntentSystemPrompt]) {
      assert.equal(builder({ strictSecretMode: true }).includes(PLANNER_STRICT_SECRET_RULE), true);
      assert.equal(builder({}).includes(PLANNER_STRICT_SECRET_RULE), false);
    }
  });
}
