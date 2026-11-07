import assert from 'node:assert/strict';
import { test } from 'node:test';
import { installCompletionDiagnostics, completionDiagnosticModuleSource } from './quality/completion-diagnostics.mjs';

function fixture() {
  const secret = 'PRIVATE_ACCOUNT_BODY_KEY';
  const calls = [], result = { success: true, content: JSON.stringify({ outcome: 'succeeded', reason: secret }),
    finishReason: 'stop', reasoningContent: secret, usage: { completion_tokens: 700 } };
  class Agent {
    constructor() {
      const binding = { taskKey: secret, runToken: secret, sourceSha256: secret, documentToken: secret };
      this._completionSubmitStates = new Map([[1, { semanticCommit: binding, dispatched: true,
        observedAfterSubmit: true, actionSequence: 1, originatingDocument: secret, currentDocument: secret }]]);
      this._lastAxScopes = new Map([[1, { documentToken: secret, pageUrl: secret }]]);
      this._completionVerdicts = new Map([[1, { outcome: 'succeeded', engine: 'llm', reason: secret }]]);
      this._planExecutionGuards = new Map([[1, { semanticSubmissionVerified: true, verifiedSubmissionEvidence: true }]]);
    }
    _completionSemanticContext() { return { taskKey: secret, runToken: secret, sourceSha256: secret,
      lastActionSequence: 1, lastObservationSequence: 2, verificationDebt: false }; }
    _completionSemanticCommitCurrent() { return true; }
    _beginCompletionInvariant(...args) { calls.push({ name: 'begin', owner: this, args }); return result; }
    async _detectLikelySubmitAction(...args) { calls.push({ name: 'detect', owner: this, args }); return result; }
    _recordCompletionSubmitAttempt(...args) { calls.push({ name: 'arm', owner: this, args }); return result; }
    _recordCompletionToolResult(...args) { calls.push({ name: 'record', owner: this, args }); return result; }
    recordSystemOneVerdict(...args) { calls.push({ name: 'verdict', owner: this, args }); return result; }
    async _chatWithCostAllowance(...args) {
      calls.push({ name: 'chat', owner: this, args });
      if (this.failure) throw this.failure;
      return this.response || result;
    }
    async _executeToolImpl(...args) { calls.push({ name: 'execute', owner: this, args }); return result; }
  }
  installCompletionDiagnostics(Agent);
  return { agent: new Agent(), result, calls, secret };
}

test('optional completion diagnostics preserve method ownership, argument identity and original results while retaining no private strings', async () => {
  const { agent, result, calls, secret } = fixture();
  const args = { body: secret }, detected = { isSubmit: true, semanticCommit: true, source: secret };
  const signal = new AbortController().signal;
  assert.equal(agent._beginCompletionInvariant(1, args), result);
  assert.equal(await agent._detectLikelySubmitAction(1, 'click_ax', args), result);
  assert.equal(agent._recordCompletionSubmitAttempt(1, detected, 'click_ax', args, secret, secret, result), result);
  assert.equal(agent._recordCompletionToolResult(1, 'get_accessibility_tree', args, result), result);
  assert.equal(agent.recordSystemOneVerdict(1, { phase: 'done_verification', outcome: 'succeeded', engine: secret, reason: secret }), result);
  assert.equal(await agent._chatWithCostAllowance({}, [{ content: secret }], { signal, maxTokens: 4096 }, {},
    { tabId: 1, generationName: 'completion_verification' }), result);
  assert.equal(await agent._executeToolImpl(1, 'done', args, signal), result);
  assert.equal(calls.length, 7, 'Instrumentation must invoke each original exactly once');
  assert.ok(calls.every(call => call.owner === agent));
  assert.equal(calls.find(call => call.name === 'detect').args[2], args);
  assert.equal(calls.find(call => call.name === 'arm').args[1], detected);
  assert.equal(calls.find(call => call.name === 'chat').args[2].signal, signal);
  const diagnostic = globalThis.webbrainCompletionDiagnostics;
  assert.ok(diagnostic.records.some(row => row.phase === 'submit_arm' && row.detectionSemantic && row.semanticCurrent));
  assert.ok(diagnostic.records.some(row => row.phase === 'judge_response' && row.outcome === 'succeeded' && row.contentPresent));
  assert.equal(JSON.stringify(diagnostic).includes(secret), false,
    'Tasks, accounts, URLs, source keys, request/response prose and private reasons never enter the artifact');
  assert.match(completionDiagnosticModuleSource(), /^import \{ Agent \} from '\.\/agent\/agent\.js';/);
});

test('judge attempts keep the reasons the verifier reports and class any other reason as other', () => {
  const { agent } = fixture();
  const reasons = ['timeout', 'invalid_response', 'unavailable', 'time_budget', 'http_503', 'COMPLETION_TIMEOUT'];
  for (const reason of reasons) agent.recordSystemOneVerdict(1, { phase: 'done_verification', engine: 'llm', modality: 'ax', outcome: 'uncertain', reason });
  const rows = globalThis.webbrainCompletionDiagnostics.records.filter(row => row.phase === 'judge_attempt').slice(-reasons.length);
  assert.deepEqual(rows.map(row => row.reasonClass), ['timeout', 'invalid_response', 'unavailable', 'time_budget', 'http_503', 'other']);
});

test('diagnostic failures and evaluator exceptions cannot change original results, exceptions or abort signals', async () => {
  const { agent, result, secret } = fixture();
  const controller = new AbortController(); controller.abort();
  const failure = agent.failure = new Error(secret);
  await assert.rejects(agent._chatWithCostAllowance({}, [], { signal: controller.signal, maxTokens: 4096 }, {},
    { tabId: 1, generationName: 'completion_verification' }), error => error === failure);
  assert.ok(globalThis.webbrainCompletionDiagnostics.records.some(row => row.phase === 'judge_response' && row.threw && row.signalAborted));
  delete agent.failure;
  agent.response = { content: {} }; // Unexpected provider shape must not make a passive logger throw.
  assert.equal(await agent._chatWithCostAllowance({}, [], {}, {}, { tabId: 1, generationName: 'completion_verification' }), agent.response);
  agent._completionSemanticContext = () => { throw new Error(secret); };
  assert.equal(agent._recordCompletionToolResult(1, 'get_accessibility_tree', {}, result), result);
  assert.equal(JSON.stringify(globalThis.webbrainCompletionDiagnostics).includes(secret), false);
});
