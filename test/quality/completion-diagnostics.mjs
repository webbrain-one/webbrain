// Optional instrumentation for a disposable installed extension. Nothing from
// a task, page, account, provider configuration or request body is retained.
export function installCompletionDiagnostics(Agent) {
  const records = [];
  const tabs = new Map();
  let nextTab = 0, nextRun = 0;
  const tools = new Set(['click', 'click_ax', 'set_field', 'type_ax', 'press_keys', 'navigate',
    'get_accessibility_tree', 'read_page', 'verify_form', 'iframe_read', 'iframe_click', 'fetch_url', 'done']);
  const outcomes = new Set(['succeeded', 'pending', 'failed', 'uncertain', 'success', 'partial']);
  const engines = new Set(['llm', 'legacy', 'freshness', 'local', 'typesafe', 'openrouter', 'compass']);
  const reasons = new Set(['unavailable', 'timeout', 'invalid_response', 'capture_unavailable', 'verifier_unavailable',
    'verifiers_unavailable_or_uncertain', 'evidence_changed', 'insufficient_evidence', 'judged', 'time_budget']);
  const reasonClass = value => reasons.has(value) || /^http_[1-5]\d{2}$/.test(String(value || ''))
    ? value : value ? 'other' : null;
  const toolName = value => tools.has(value) ? value : 'other';
  const verdictOutcome = value => outcomes.has(value) ? value : null;
  const verdictEngine = value => engines.has(value) ? value : value ? 'other' : null;
  const originalSemanticCurrent = Agent.prototype._completionSemanticCommitCurrent;
  const snapshot = (agent, tabId) => {
    const submit = agent._completionSubmitStates?.get(tabId);
    const binding = submit?.semanticCommit;
    const scope = agent._lastAxScopes?.get(tabId);
    const context = agent._completionSemanticContext?.(tabId) || {};
    const verdict = agent._completionVerdicts?.get(tabId);
    const guard = agent._planExecutionGuards?.get(tabId);
    const expectedAction = binding?.verificationNavigation?.actionSequence ?? submit?.actionSequence;
    return {
      submitPresent: !!submit, semanticDetected: !!binding, semanticInvalidated: binding?.invalidated === true,
      dispatched: submit?.dispatched === true, observedAfterSubmit: submit?.observedAfterSubmit === true,
      formValidationFailed: submit?.formValidationFailed === true,
      originCurrentDocEqual: !!submit?.originatingDocument && submit.originatingDocument === submit.currentDocument,
      currentScopeDocEqual: !!submit?.currentDocument && submit.currentDocument === scope?.documentToken,
      originBindingDocEqual: !!submit?.originatingDocument && submit.originatingDocument === binding?.documentToken,
      taskBound: !!binding && binding.taskKey === context.taskKey,
      runBound: !!binding && binding.runToken === context.runToken,
      sourceBound: !!binding && binding.sourceSha256 === context.sourceSha256,
      lastActionMatches: !!submit && expectedAction === context.lastActionSequence,
      observationAfterAction: !!submit && context.lastObservationSequence > expectedAction,
      verificationDebt: context.verificationDebt === true, cancelled: context.cancelled === true,
      semanticCurrent: !!binding && originalSemanticCurrent.call(agent, tabId, submit, scope?.pageUrl || ''),
      independentOutcome: verdictOutcome(verdict?.outcome), independentEngine: verdictEngine(verdict?.engine),
      independentReasonClass: reasonClass(verdict?.reason),
      semanticSubmissionVerified: guard?.semanticSubmissionVerified === true,
      verifiedSubmissionEvidence: guard?.verifiedSubmissionEvidence === true,
    };
  };
  const record = (agent, tabId, phase, fields = {}) => {
    // Logging must never change the real method's result or exception.
    try {
      let tab = tabs.get(tabId);
      if (!tab) { tab = { tab: ++nextTab, run: 0 }; tabs.set(tabId, tab); }
      records.push({ sequence: records.length ? records.at(-1).sequence + 1 : 1,
        tab: tab.tab, run: tab.run, phase, ...snapshot(agent, tabId), ...fields });
      if (records.length > 2000) records.shift();
    } catch { /* Diagnostics cannot interfere with product behavior. */ }
  };
  const wrapSync = (name, observe) => {
    const original = Agent.prototype[name];
    Agent.prototype[name] = function (...args) {
      const result = original.apply(this, args);
      try { observe.call(this, args, result); } catch { /* Preserve the original result. */ }
      return result;
    };
  };
  const wrapAsync = (name, observe, before = null) => {
    const original = Agent.prototype[name];
    Agent.prototype[name] = async function (...args) {
      const started = performance.now();
      try { before?.call(this, args); } catch { /* Preserve the original call. */ }
      try {
        const result = await original.apply(this, args);
        try { observe.call(this, args, result, false, performance.now() - started); } catch { /* Diagnostic only. */ }
        return result;
      } catch (error) {
        try { observe.call(this, args, null, true, performance.now() - started); } catch { /* Preserve the original exception. */ }
        throw error;
      }
    };
  };
  wrapSync('_beginCompletionInvariant', function ([tabId]) {
    let tab = tabs.get(tabId);
    if (!tab) { tab = { tab: ++nextTab, run: 0 }; tabs.set(tabId, tab); }
    tab.run = ++nextRun; record(this, tabId, 'run_begin');
  });
  wrapAsync('_detectLikelySubmitAction', function ([tabId, name], result, threw) {
    record(this, tabId, 'submit_detection', { tool: toolName(name), detectionSubmit: result?.isSubmit === true,
      detectionSemantic: result?.semanticCommit === true, threw });
  });
  wrapSync('_recordCompletionSubmitAttempt', function ([tabId, detected, name, , , , actionResult]) {
    record(this, tabId, 'submit_arm', { tool: toolName(name), detectionSubmit: detected?.isSubmit === true,
      detectionSemantic: detected?.semanticCommit === true, actionSuccess: actionResult?.success === true,
      actionUnknown: actionResult?.outcomeUnknown === true, actionInconclusive: actionResult?.inconclusive === true,
      actionNoDispatch: actionResult?.noDispatch === true || actionResult?.dispatched === false });
  });
  wrapSync('_recordCompletionToolResult', function ([tabId, name]) {
    record(this, tabId, 'tool_recorded', { tool: toolName(name) });
  });
  wrapSync('recordSystemOneVerdict', function ([tabId, metadata]) {
    if (metadata?.phase === 'done_verification') record(this, tabId, 'judge_attempt', {
      outcome: verdictOutcome(metadata.outcome), engine: verdictEngine(metadata.engine),
      reasonClass: reasonClass(metadata.reason), modality: ['ax', 'vision'].includes(metadata.modality) ? metadata.modality : null });
  });
  wrapAsync('_chatWithCostAllowance', function ([, , options, , context], result, threw, elapsedMs) {
    if (context?.generationName !== 'completion_verification') return;
    let parsed; try { parsed = JSON.parse(String(result?.content || '')); } catch {}
    record(this, context.tabId, 'judge_response', {
      maxTokens: Number.isFinite(options?.maxTokens) ? options.maxTokens : null,
      finishReason: ['stop', 'length', 'tool_calls', 'content_filter'].includes(result?.finishReason) ? result.finishReason : null,
      contentPresent: !!result?.content?.trim(), contentLength: result?.content?.length || 0,
      reasoningLength: result?.reasoningContent?.length || 0, outcome: verdictOutcome(parsed?.outcome),
      completionTokens: Number.isFinite(result?.usage?.completion_tokens) ? result.usage.completion_tokens : null,
      elapsedMs: Math.round(elapsedMs), threw, signalAborted: options?.signal?.aborted === true,
    });
  });
  wrapAsync('_executeToolImpl', function ([tabId, name], result, threw) {
    if (name !== 'done') return;
    record(this, tabId, 'done_after', {
      done: result?.done === true, success: result?.success === true, successPresent: typeof result?.success === 'boolean',
      successfulDone: result?.done === true && result?.outcome === 'success' && result?.success !== false && !result?.blockedDone,
      outcome: verdictOutcome(result?.outcome),
      blockedDone: result?.blockedDone === true, completionPageBlock: result?.completionPageBlock === true,
      completionInvariant: result?.completionInvariant === true, planOnlyTerminal: result?.planOnlyTerminal === true,
      completionDecisionOutcome: verdictOutcome(result?.completionDecision?.outcome),
      completionDecisionEngine: verdictEngine(result?.completionDecision?.engine),
      relevantFormCount: Number.isFinite(result?.pageState?.relevantFormCount) ? result.pageState.relevantFormCount : null,
      threw,
    });
  }, function ([tabId, name]) { if (name === 'done') record(this, tabId, 'done_before'); });
  globalThis.webbrainCompletionDiagnostics = { version: 1, records };
}

export function completionDiagnosticModuleSource() {
  return "import { Agent } from './agent/agent.js';\n(" + installCompletionDiagnostics.toString() + ')(Agent);\n';
}
