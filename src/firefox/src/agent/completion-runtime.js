import { semanticCommitDocumentMatches } from './semantic-commit-navigation.js';
import { DECISION_SETTINGS_KEYS, decisionFeatureEnabled } from './decision-config.js';
import { resolveCurrentDecisionConfig } from './decision-availability.js';
import { createSystemOneJudge } from './systemone-judge.js';
import { redactSystemOneText, wrapSystemOneData, boundedSystemOneText as boundedText } from './systemone-evidence.js';
import { COMPLETION_INSTRUCTIONS, LATER_OUTCOME_FIELD, SUMMARY_KIND_FIELD, READ_METHOD_FIELD, completionQuestions, decisionCompletionVerdict, llmCompletionVerdict, verifyCompletion, withCompletionTimeout, completionStopError } from './completion-verifier.js';
import { calculationResultInText } from './calculator.js';
import { isPageIndependentCalculationCompletion, literalCalculationSummaryFormatMatches } from './page-feedback-policy.js';

// Tool IDs survive compaction and separate this execution from retained history.
// Reused assets and durable task receipts keep their own authority checks.
function currentExecutionToolCalls(agent, tabId) {
  const run = agent.completionInvariants.get(tabId);
  const messages = agent.conversations.get(tabId) || [];
  return run?.historyToolCallIdsBeforeRun instanceof Set
    ? messages.flatMap(message => message.tool_calls || [])
      .filter(call => call.id && !run.historyToolCallIdsBeforeRun.has(call.id)) : [];
}

const TOOL_NAME = /^[a-z][a-z0-9_]{0,63}$/;
const CREDENTIAL_PLACEHOLDER = '[credential omitted]';
// Text-entry tools whose result reports the field the text went into.
const TEXT_ENTRY_TOOLS = new Set(['set_field', 'type_ax', 'type_text', 'iframe_type']);
// Main-document field edits whose staged result the accessibility tree shows.
const STAGED_FIELD_TOOLS = new Set(['set_field', 'type_ax', 'type_text', 'set_checked']);
const BATCH_METADATA = '[browser_batch metadata] ';
// The accessibility tree shows at most this many characters of a value.
const AX_VALUE_PREFIX_CHARS = 60;

function parsedObject(text) {
  try {
    const value = typeof text === 'string' ? JSON.parse(text) : text;
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch { return null; }
}

// Unwrap only a wrapper that starts the message and closes with its own
// nonce: page text inside an unwrapped result (a field label in a set_field
// result) can contain wrapper markup. Trusted runtime notes may follow on
// later lines; a result's own JSON never contains a raw newline.
function parsedToolResult(content) {
  if (typeof content !== 'string' || content.length > 50000) return null;
  const wrapped = content.match(/^<untrusted_page_content id="([a-z0-9]+)"[^>\n]*>\n([\s\S]*?)\n<\/untrusted_page_content id="\1">/);
  const text = wrapped ? wrapped[2] : content;
  return parsedObject(text) || parsedObject(text.split('\n', 1)[0]);
}

// A folded browser_batch answer (foldBrowserBatchMessages): app-written
// header lines, then each child's own header and result in order. A child
// result is read only up to the close of its own nonce wrapper, and the next
// child is looked for after it, so page bytes inside one result cannot stand
// in for another.
function batchChildActions(call, content) {
  const actions = parsedObject(call.function?.arguments)?.actions;
  const text = typeof content === 'string' && content.length <= 200000 ? content : '';
  const lines = text.split('\n', 2);
  const metadata = lines[1]?.startsWith(BATCH_METADATA) ? parsedObject(lines[1].slice(BATCH_METADATA.length)) : null;
  if (!Array.isArray(actions) || !Array.isArray(metadata?.actions)) return [];
  const results = new Map();
  let cursor = lines[0].length + lines[1].length + 1;
  for (let index = 0; index < metadata.actions.length; index++) {
    const at = text.indexOf(`\nactions[${index}] `, cursor);
    const lineEnd = at < 0 ? -1 : text.indexOf('\n', at + 1);
    if (lineEnd < 0) break;
    const ran = / → ran$/.test(text.slice(at + 1, lineEnd));
    const open = text.slice(lineEnd + 1, lineEnd + 120).match(/^<untrusted_page_content id="([a-z0-9]+)"[^>\n]*>\n/);
    if (!open) { cursor = lineEnd; continue; }
    const close = `\n</untrusted_page_content id="${open[1]}">`;
    const bodyStart = lineEnd + 1 + open[0].length;
    const bodyEnd = text.indexOf(close, bodyStart);
    if (bodyEnd < 0) break;
    if (ran) results.set(index, parsedToolResult(text.slice(bodyStart, bodyEnd)));
    cursor = bodyEnd + close.length;
  }
  // Only children the batch actually ran count as recorded actions.
  return actions.flatMap((action, index) => metadata.actions[index]?.ran === true && TOOL_NAME.test(action?.name || '')
    ? [{ name: action.name, args: parsedObject(action.input) || {}, result: results.get(index) || null }] : []);
}

// Each action of this execution with browser_batch children expanded, and the
// app's own result while the conversation still retains it.
function currentExecutionActions(agent, tabId) {
  const calls = currentExecutionToolCalls(agent, tabId);
  const counts = new Map();
  for (const call of calls) counts.set(call.id, (counts.get(call.id) || 0) + 1);
  const answers = new Map();
  for (const message of agent.conversations.get(tabId) || []) {
    if (message.role === 'tool' && counts.get(message.tool_call_id) === 1 && !answers.has(message.tool_call_id)) {
      answers.set(message.tool_call_id, message.content);
    }
  }
  return calls.flatMap(call => {
    const name = call.function?.name;
    if (!TOOL_NAME.test(name || '')) return [];
    if (name === 'browser_batch') return batchChildActions(call, answers.get(call.id));
    return [{ name, args: parsedObject(call.function.arguments) || {}, result: parsedToolResult(answers.get(call.id)) }];
  });
}

// Booleans the app itself recorded about an action, plus the `ref_N` target
// it named. No other argument: entered values can be secrets without
// recognizable labels.
function recordedActionFacts(action) {
  const result = action.result;
  return {
    ...(/^ref_\d{1,40}$/.test(action.args?.ref_id || '') ? { ref: action.args.ref_id } : {}),
    ...(result && typeof result.verified === 'boolean' ? { verified: result.verified } : {}),
    ...(result?.success === false ? { failed: true } : {}),
    ...(result?.sensitiveField === true ? { sensitive: true } : {}),
  };
}

// Values this execution entered into password inputs, in every form evidence
// can show them: as typed; as the accessibility tree prints one that a "show
// password" control made visible (normalized, without control characters,
// trimmed, cut to its first 60 characters); each line of a multi-line value,
// since redaction and AX lines split it and an input drops the line breaks;
// and each of those escaped inside AX or JSON text. A password input shows its
// value only when a control reveals it, so masking it rarely costs a judge
// anything it could compare with the request. A value entered into any other
// field stays, even where the app flags the field as a credential ("Security
// code", "Token amount"): the page shows it, and a judge needs it to catch a
// mistyped value.
function credentialValueForms(actions) {
  const forms = new Set();
  const axEscape = value => value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const jsonEscape = value => JSON.stringify(value).slice(1, -1);
  for (const action of actions) {
    const value = action.args?.text;
    // Content-script entries describe their field as fieldMeta; Chrome's CDP
    // type_text into the focused field describes it as focusedField.
    const password = [action.result?.fieldMeta, action.result?.focusedField]
      .some(field => String(field?.type || '').toLowerCase() === 'password');
    if (!TEXT_ENTRY_TOOLS.has(action.name) || !password || typeof value !== 'string') continue;
    let printed = value.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
    try { printed = printed.normalize('NFKC'); } catch { /* keep the unnormalized form */ }
    printed = printed.trim();
    const whole = [value, printed, printed.slice(0, AX_VALUE_PREFIX_CHARS)];
    for (const shown of [...whole, ...whole.flatMap(text => text.split('\n').map(line => line.trim()))]) {
      for (const form of [shown, axEscape(shown), jsonEscape(shown), jsonEscape(axEscape(shown))]) {
        if (form.length >= 4) forms.add(form);
      }
    }
  }
  return [...forms].sort((a, b) => b.length - a.length);
}

function maskCredentialValues(value, credentials) {
  let text = String(value ?? '');
  for (const credential of credentials) text = text.split(credential).join(CREDENTIAL_PLACEHOLDER);
  return text;
}

// Line redaction first: masking a value that spells a keyword ("password")
// would otherwise keep the rest of that line.
function redactJudgeEvidence(value, credentials) {
  return maskCredentialValues(redactSystemOneText(value), credentials);
}

// A credential field's AX line keeps its role and ref, so a judge can match
// the field with its recorded entry; the rest of the line is omitted. Page
// text in a name or attribute can add ref-like tokens, even on a line of its
// own, but cannot remove the formatter's, and the formatter prints each ref
// once. So a line keeps its ref only when it has exactly one and no other
// line repeats it.
function redactJudgeObservation(text, credentials) {
  const lines = String(text ?? '').split('\n');
  const seen = new Map();
  for (const line of lines) for (const ref of line.match(/\[ref_\d{1,40}\]/g) || []) seen.set(ref, (seen.get(ref) || 0) + 1);
  return lines.map(line => {
    const redacted = redactJudgeEvidence(line, credentials);
    if (redacted !== CREDENTIAL_PLACEHOLDER) return redacted;
    const refs = line.match(/\[ref_\d{1,40}\]/g);
    const node = refs?.length === 1 && seen.get(refs[0]) === 1 && line.match(/^( *)([a-z]{1,24}) /);
    return node ? `${node[1]}${node[2]} ${refs[0]} ${CREDENTIAL_PLACEHOLDER}` : redacted;
  }).join('\n');
}

// The active model already holds the user's request, the approved plan and
// its own summary verbatim. Dropping each line that merely names a credential
// ("fill the form with a random password") would hide the task from its
// judge, so its copy keeps every line and masks only what every judge's copy
// masks: addresses are cut to origin and path, and bearer tokens and values
// entered into password inputs are hidden. Masking whatever follows a
// credential word ("Password:", "password is") could change what the request
// asks, so nothing is masked by guesswork. A decision sidecar that may be a
// third party keeps line redaction.
function maskTrustedJudgeText(value, credentials) {
  return maskCredentialValues(String(value ?? '').replace(/https?:\/\/[^\s"<>]+/gi, raw => {
    try { const url = new URL(raw); return `${url.origin}${url.pathname}`; } catch { return '[url]'; }
  }).replace(/\bBearer\s+\S+/gi, CREDENTIAL_PLACEHOLDER), credentials);
}

export function completionReportingContext(agent, tabId) {
  const run = agent.completionInvariants.get(tabId);
  if (!run?.runToken) return null;
  const known = run.historyToolCallIdsBeforeRun instanceof Set;
  const calls = currentExecutionToolCalls(agent, tabId);
  const names = new Map(), duplicateIds = new Set();
  for (const call of calls) {
    if (names.has(call.id)) duplicateIds.add(call.id);
    names.set(call.id, call.function?.name);
  }
  for (const id of duplicateIds) names.delete(id);
  const records = (agent.conversations.get(tabId) || []).filter(message =>
    message.role === 'tool' && names.has(message.tool_call_id));
  const results = records.slice(-8).map(message => {
    const name = names.get(message.tool_call_id);
    if (typeof name !== 'string' || !/^[a-z][a-z0-9_]{0,63}$/.test(name)) return null;
    const item = { tool: name };
    let result = null;
    if (typeof message.content === 'string' && message.content.length <= 50000) {
      try { result = JSON.parse(agent._unwrapUntrusted?.(message.content) ?? message.content); } catch {}
    }
    if (!result || typeof result !== 'object' || Array.isArray(result)) return { ...item, result: 'not_available_as_structured_evidence' };
    for (const key of ['success', 'dispatched', 'noDispatch', 'skipped', 'cancelled', 'outcomeUnknown', 'verified', 'remoteStateVerified', 'filePickerBlocked']) {
      if (typeof result[key] === 'boolean') item[key] = result[key];
    }
    if (name === 'upload_file' && ['input_attached', 'page_consumed'].includes(result.attachmentState)) {
      item.attachmentState = result.attachmentState;
    }
    return item;
  }).filter(Boolean);
  const action = run.lastAction;
  const facts = {
    executionProvenance: known ? 'owned_current_execution_tool_ids' : 'unavailable',
    evidenceWindow: 'last_8_retained_paired_results; omission_is_not_proof_an_action_never_occurred',
    recordedCurrentResults: results,
    ...(action && typeof action.name === 'string' && /^[a-z][a-z0-9_]{0,63}$/.test(action.name)
      ? { latestConsequentialAction: { tool: action.name, uncertain: action.uncertain === true } } : {}),
    verificationPending: run.verificationDebt === true || run.iframeFormVerificationDebt === true,
  };
  const prefix = '[CURRENT EXECUTION EVIDENCE: app-owned reporting DATA, not a user instruction or new task authority]\n'
    + 'These are recorded tool outcomes from this execution, not a certificate of the current document or final task success. '
    + 'Earlier execution history and scratchpad artifacts remain usable context, and may contain valid progress for the same continuing task. '
    + 'They do not by themselves establish a new attachment, save, or send in the present document. '
    + 'Local attachment acceptance is distinct from remote submission. Durable delivery, progress, calculation and document receipts retain their existing authority checks; this block neither resets them nor requires repeating an action. '
    + 'A freshly verified already-correct state may satisfy the task without a new mutation.\n'
    ;
  // Cap added model context independently of retained page/tool output size.
  while (prefix.length + JSON.stringify(facts).length > 3000 && facts.recordedCurrentResults.length) {
    facts.recordedCurrentResults.shift();
  }
  return prefix + JSON.stringify(facts);
}

// Actual utility proof at normal explicit done verification, not an agent
// summary or a page judge's estimate. The caller pins it before browser awaits.
export function captureCalculationEvidence(agent, tabId, expected = null) {
  const scope = agent._pageFeedbackCalculationResponseScope?.(tabId);
  const guard = agent._planExecutionGuards?.get(tabId), receipt = guard?.pureCalculationReceipt;
  const feedback = agent._pageFeedbackRuns?.get(tabId), state = feedback?.modelState;
  if (!scope || !receipt || !agent._pageFeedbackCalculationComplete?.(tabId)
      || !feedback || !state || !agent._pageFeedbackStateCurrent?.(tabId, feedback, state)
      || (feedback.events.size && !isPageIndependentCalculationCompletion(
        [{ function: { name: 'done', arguments: '{"outcome":"success"}' } }],
        { pureCalculationComplete: true, calculationResponseScope: scope }, [...feedback.events.values()]))
      || typeof receipt.result !== 'string') return null;
  if (expected && (expected.guard !== guard || expected.receipt !== receipt || expected.owner !== scope.owner
      || expected.runToken !== scope.runToken || expected.expression !== scope.expression
      || expected.actualExpression !== receipt.expression || expected.result !== receipt.result || expected.fraction !== receipt.fraction
      || expected.feedback !== feedback || expected.token !== feedback.token || expected.url !== state.url
      || expected.documentId !== state.documentId
      || expected.frames.some(([id, frame]) => feedback.frames.get(id)?.id !== frame.id
        || feedback.frames.get(id)?.token !== frame.token))) return null;
  return expected || { guard, receipt, owner: scope.owner, runToken: scope.runToken,
    expression: scope.expression, actualExpression: receipt.expression, result: receipt.result, fraction: receipt.fraction,
    feedback, token: feedback.token, url: state.url, documentId: state.documentId,
    frames: [...state.frames].map(([id, frame]) => [id, { ...frame }]) };
}

export function captureCalculationCompletion(agent, tabId, summary, expected = null) {
  const evidence = captureCalculationEvidence(agent, tabId, expected);
  const requirements = agent._pageFeedbackCalculationResponseScope?.(tabId)?.outputRequirements;
  return evidence && calculationResultInText(summary, evidence.result, evidence.fraction)
    && literalCalculationSummaryFormatMatches(summary, requirements, evidence.result, evidence.fraction) ? evidence : null;
}

export async function refreshCalculationEvidence(agent, tabId, expected) {
  if (!expected || !captureCalculationEvidence(agent, tabId, expected)) return null;
  try {
    const api = typeof browser !== 'undefined' ? browser : chrome;
    const [tab, frames] = await Promise.all([api.tabs.get(tabId), api.webNavigation?.getAllFrames?.({ tabId })]);
    const main = frames?.find(frame => frame.frameId === 0);
    if (tab?.url !== expected.url || (main?.url && main.url !== expected.url)
        || (expected.documentId && main?.documentId !== expected.documentId)) return null;
    for (const [frameId, original] of expected.frames) {
      const live = frames?.find(frame => frame.frameId === frameId);
      if (!live || (original.id && live.documentId !== original.id)) return null;
      if (!original.id) {
        const current = await api.tabs.sendMessage(tabId, { target: 'content', action: 'page_monitor_state', active: true }, { frameId });
        if (current?.ready !== true || current.active !== true || current.runToken !== expected.token
            || current.documentToken !== original.token || !captureCalculationEvidence(agent, tabId, expected)) return null;
      }
    }
    return captureCalculationEvidence(agent, tabId, expected);
  } catch { return null; }
}

export async function refreshCalculationCompletion(agent, tabId, summary, expected) {
  return await refreshCalculationEvidence(agent, tabId, expected)
    ? captureCalculationCompletion(agent, tabId, summary, expected) : null;
}

async function evidenceKey(state) {
  // Wrapper nonces delimit untrusted content; they are not evidence changes.
  const canonical = JSON.stringify(state, (_key, value) => typeof value === 'string'
    ? value.replace(/(<\/?untrusted_page_content) id="[^"]*"/g, '$1') : value);
  const bytes = new TextEncoder().encode(canonical);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), n => n.toString(16).padStart(2, '0')).join('');
}

// A run that read a page in the background (agent.js keeps what those reads
// reported) also asks the judge whether the request says how pages are to be
// opened or read; done then reports what the reads did. A verdict judged
// without that question is not reused once such a read exists.
const asksReadMethod = run => Array.isArray(run?.backgroundReads) && run.backgroundReads.length > 0;

function invalidateCompletionProof(agent, tabId) {
  const guard = agent._planExecutionGuards.get(tabId);
  if (guard?.semanticSubmissionVerified) {
    guard.verifiedSubmissionEvidence = false;
    guard.semanticSubmissionVerified = false;
  }
  agent._completionVerdicts?.delete(tabId);
}

async function evaluateBrowserCompletion(agent, tabId, options = {}) {
  const { pageState = {}, pageUrl = '', summary = '', refreshOnly = false } = options;
  const calculationEvidence = Object.prototype.hasOwnProperty.call(options, 'calculationEvidence')
    ? options.calculationEvidence : captureCalculationEvidence(agent, tabId);
  const provider = agent._activeProvider(tabId);
  if (agent.strictSecretMode || !provider) {
    invalidateCompletionProof(agent, tabId);
    return { outcome: 'uncertain', engine: 'legacy', reason: 'unavailable' };
  }
  const stored = await chrome.storage.local.get(DECISION_SETTINGS_KEYS);
  const compass = provider.config?.providerName === 'webbrain-cloud' ? provider.config : null;
  // The models this task keeps in the in-browser worker, which a decision must not unload.
  const inBrowserModels = () => agent._inBrowserModels?.(provider);
  const config = await resolveCurrentDecisionConfig(stored, compass, { feature: 'done', inBrowserModels });
  const context = agent.systemOneContext(tabId);
  const signal = agent._runAbortSignal(tabId);
  const guard = agent._planExecutionGuards.get(tabId);
  const task = agent._progressTaskAnchorText?.(tabId) || guard?.taskText || agent._latestTaskText(tabId) || agent._originalTaskText(tabId);
  const run = agent.completionInvariants.get(tabId);
  const readMethod = asksReadMethod(run);
  const scope = JSON.stringify([run?.runToken, run?.lastAction?.sequence, agent._progressTaskKeyHash(tabId), config.provider, config.model, config.url, provider.model, provider.supportsVision, JSON.stringify(config), readMethod]);
  agent._completionVerdicts ??= new Map();
  const currentRun = () => context.isCurrent() && !signal?.aborted && agent._activeProvider(tabId) === provider
    && (!calculationEvidence || captureCalculationEvidence(agent, tabId, calculationEvidence))
    && scope === JSON.stringify([agent.completionInvariants.get(tabId)?.runToken, agent.completionInvariants.get(tabId)?.lastAction?.sequence, agent._progressTaskKeyHash(tabId), config.provider, config.model, config.url, provider.model, provider.supportsVision, JSON.stringify(config), asksReadMethod(agent.completionInvariants.get(tabId))]);
  const currentIdentity = async evidence => !!evidence.identity && currentRun()
    && JSON.stringify(await resolveCurrentDecisionConfig(await chrome.storage.local.get(DECISION_SETTINGS_KEYS), compass, { feature: 'done', inBrowserModels })) === JSON.stringify(config)
    && evidence.identity === await agent._completionDocumentStamp(tabId, true) && currentRun();
  const current = async evidence => {
    if (!await currentIdentity(evidence)) return false;
    if (evidence.modality !== 'vision') {
      // Re-read the bounded AX evidence actually sent to the judge. Full-body
      // clocks/feeds outside that evidence do not establish staleness.
      const fresh = await capture('ax', true);
      return (!evidence.resultScope || fresh?.resultScope === evidence.resultScope)
        && fresh?.key === (evidence.key || evidence.evidenceKey) && await currentIdentity(evidence);
    }
    // Text and input stamps cannot detect canvas, image or CSS changes. Take a
    // new redacted, budgeted capture after the request; never reuse that cache.
    let fresh;
    try { fresh = await capture('vision', true); }
    catch (error) { if (completionStopError(error, signal)) throw error; }
    if (!await currentIdentity(evidence)) return false;
    if (fresh?.key === (evidence.key || evidence.evidenceKey)) return true;
    // Moving pixels cannot certify the old image, but need not mean the task
    // changed. Discard that verdict and judge a fresh AX read instead.
    throw Object.assign(new Error('Visual evidence changed or could not be refreshed.'), { code: 'COMPLETION_VISUAL_CHANGED' });
  };
  const messages = agent.conversations.get(tabId) || [];
  // Tool IDs survive conversation compaction. Unknown provenance or reused
  // pre-run IDs cannot certify that this task performed a required read.
  const calls = currentExecutionToolCalls(agent, tabId);
  const toolNames = new Map(calls.map(call => [call.id, call.function?.name]));
  // Entered values can be secrets without recognizable labels. Action names,
  // targets and the app's own outcome booleans supply history without sending
  // arbitrary tool arguments to another judge. Batched actions count too.
  const actions = currentExecutionActions(agent, tabId);
  // A vision run's drag (a slider, a reorder) changes state like a click.
  const recordedActions = actions.filter(action => /^(type|fill|click|navigate|set_)/.test(action.name) || action.name === 'drag_at').slice(-8)
    .map(action => ({ tool: action.name, ...recordedActionFacts(action) }));
  // A password the run entered can still show up in its summary, in the
  // request, or in a field a "show password" control made visible.
  const credentialValues = credentialValueForms(actions);
  const redactEvidence = value => redactJudgeEvidence(value, credentialValues);
  // The trusted texts, as the active model and as the sidecar receive them.
  const taskBudget = guard?.approvedPlanAnchor ? 1700 : 2500;
  const llmTexts = { task: boundedText(maskTrustedJudgeText(task || '', credentialValues), taskBudget),
    plan: guard?.approvedPlanAnchor ? boundedText(maskTrustedJudgeText(guard.approvedPlanAnchor, credentialValues), 800) : null,
    summary: boundedText(maskTrustedJudgeText(summary, credentialValues), 600) };
  // A decision route that stays on this device, or WebBrain Cloud's own route
  // while WebBrain Cloud is also the conversation provider, keeps these texts
  // local or already holds them, so it gets the same copy. Any other sidecar
  // may be a third party and gets every line naming a credential removed.
  const sidecarSharesTexts = config.local === true || (!!compass && config.provider === 'compass');
  const sidecarTexts = sidecarSharesTexts ? llmTexts : { task: boundedText(redactEvidence(String(task || '')), taskBudget),
    plan: guard?.approvedPlanAnchor ? boundedText(redactEvidence(guard.approvedPlanAnchor), 800) : null,
    summary: boundedText(redactEvidence(String(summary)), 600) };
  const reads = messages.filter(m => m.role === 'tool' && /^(read_page|get_accessibility_tree|verify_form|iframe_read)$/.test(toolNames.get(m.tool_call_id) || ''));
  // The latest read of each of the four most recently read pages, so a page
  // the task depended on earlier (its rules, a source) is not crowded out by
  // repeated reads of the result page. Pages are told apart by the address
  // their read reports, never by what their text says.
  const readPage = message => {
    try {
      const result = JSON.parse(String(agent._unwrapUntrusted?.(message.content) ?? message.content));
      const address = typeof result?.url === 'string' ? result.url : '';
      return address ? address.replace(/#.*$/, '') : '';
    } catch { return ''; }
  };
  const latestReadByPage = new Map();
  for (const message of reads) {
    const key = readPage(message) || `read:${message.tool_call_id || latestReadByPage.size}`;
    latestReadByPage.delete(key);
    latestReadByPage.set(key, message);
  }
  const selectedReads = [...latestReadByPage.values()].slice(-4);
  const history = selectedReads.map(m => ({ tool: toolNames.get(m.tool_call_id) || m.name, evidence: wrapSystemOneData(boundedText(redactEvidence(String(m.content)), 450)) }));
  // A failed HTTP read may prove absence after a deletion. Supply only the
  // actual response status and URL, never response prose or a success waiver.
  // Pre-run/orphan tool IDs remain excluded by the current-run call map.
  const resourceReads = messages.filter(m => m.role === 'tool' && toolNames.get(m.tool_call_id) === 'fetch_url').slice(-2).flatMap(m => {
    let result; try { result = JSON.parse(String(agent._unwrapUntrusted?.(m.content) ?? m.content)); } catch { return []; }
    if (!Number.isInteger(result?.status) || result.status < 100 || result.status > 599 || typeof result.url !== 'string') return [];
    return [{ tool: 'fetch_url', evidence: wrapSystemOneData(JSON.stringify({
      url: boundedText(redactEvidence(result.url), 1000), status: result.status,
    })) }];
  });
  const resultSnapshot = async () => {
    try { return await agent._completionResultSnapshot?.(tabId); } catch { return null; }
  };
  const initialResult = await resultSnapshot();
  // Staged, unsubmitted field values read exactly from the accessibility tree
  // (credential fields through their verified entries). A screenshot masks
  // them, and the focused field's blinking caret makes it stale before its
  // judgment returns, which only costs a discarded request.
  const stagedFieldEdits = guard?.requiresSubmission === false && STAGED_FIELD_TOOLS.has(run?.lastAction?.name)
    && agent._currentCompletionSubmitState?.(tabId)?.dispatched !== true;
  const preferAx = (!!initialResult?.scopeRef && !!initialResult?.text) || stagedFieldEdits;
  const captures = new Map();
  const capture = async (modality, refresh = false) => {
    const before = await agent._completionDocumentStamp(tabId, true);
    if (!semanticCommitDocumentMatches(agent._currentCompletionSubmitState(tabId), before)) return null;
    const cached = captures.get(modality);
    const reusable = cached?.identity === before && context.isCurrent();
    if (!refresh && reusable) return cached;
    // A new vision judgment needs both its evidence and its post-request
    // freshness capture. With only one slot left, use AX before paying a judge.
    if (modality === 'vision' && agent._canTakeAutoScreenshot?.(tabId, refresh || reusable ? 1 : 2) === false) return null;
    let observation, resultScope, resultView, resultFingerprint;
    if (modality === 'vision') {
      const result = await resultSnapshot();
      if (result?.identity === before && result.scopeRef && result.rect && result.viewport) {
        resultScope = result.scopeRef;
        resultView = { rect: result.rect, viewport: result.viewport };
        resultFingerprint = await evidenceKey([result.scopeRef, result.text, result.composerEmpty, result.truncated, result.controlFingerprint]);
      }
      if (refresh && cached?.resultScope && cached.resultScope !== resultScope) return null;
      let pixels = await agent._captureCompletionJudgeImage(tabId, resultView || null);
      if (!pixels) return null;
      const budget = agent._budgetForCapture();
      pixels = (await agent._shrinkImageForBudget(pixels, 0, 0, { ...budget, maxTargetPx: Math.min(1408, budget.maxTargetPx), maxTargetTokens: Math.min(1400, budget.maxTargetTokens) })).dataUrl;
      observation = { type: 'image_url', image_url: { url: pixels } };
    } else {
      const result = await resultSnapshot();
      if (result?.identity === before && result.scopeRef && typeof result.text === 'string' && result.text) {
        resultScope = result.scopeRef;
        resultFingerprint = await evidenceKey([result.scopeRef, result.text, result.composerEmpty, result.truncated, result.controlFingerprint]);
        observation = { observation: wrapSystemOneData(boundedText(redactEvidence(result.text), 4500)),
          truncated: result.truncated === true, composerEmpty: result.composerEmpty === true };
      }
      if (refresh && cached?.resultScope && cached.resultScope !== resultScope) return null;
      if (!observation) {
        const submit = agent._currentCompletionSubmitState(tabId);
        // Certify a single same-document form against its entire subtree rather
        // than unrelated page counters or feeds. Unknown/replaced scopes and
        // navigation still require the complete page. Live statuses and dialogs
        // outside the form are refreshed below and participate in freshness.
        const sameForm = guard?.requiresSubmission === true && !guard?.siteWorkflow?.job
          && Number(pageState.relevantFormCount) === 1 && submit?.dispatched === true
          && submit.observedAfterSubmit === true && submit.documentChanged !== true
          && /^ref_\d+$/.test(String(submit.formRef || ''))
          && agent._normalizeUrl(submit.originatingUrl || '') === agent._normalizeUrl(pageUrl)
          && agent._normalizeUrl(submit.currentUrl || '') === agent._normalizeUrl(pageUrl)
          && (!submit.originatingDocument || !submit.currentDocument || submit.originatingDocument === submit.currentDocument);
        let result = await agent.executeTool(tabId, 'get_accessibility_tree',
          sameForm ? { ref_id: submit.formRef, filter: 'all', maxDepth: 15, maxChars: 5500 } : { filter: 'all', maxDepth: 15, maxChars: 5500 });
        if (sameForm && (result?.success === false || result?.error || !result?.pageContent)) {
          result = await agent.executeTool(tabId, 'get_accessibility_tree', { filter: 'all', maxDepth: 15, maxChars: 5500 });
        }
        if (result?.success === false || !result?.pageContent) return null;
        observation = { observation: wrapSystemOneData(boundedText(redactJudgeObservation(result.pageContent, credentialValues), 4500)) };
      }
    }
    // A bounded or scoped AX tree can omit inline confirmation outside a form.
    // Include visible live-region and open-dialog text separately and refresh it with the
    // evidence so a removed/replaced acknowledgement cannot preserve success.
    let liveStatusMessages = [];
    if (typeof agent._completionLiveStatusMessages === 'function') {
      try { liveStatusMessages = await agent._completionLiveStatusMessages(tabId); } catch { liveStatusMessages = null; }
    }
    const frame = typeof agent._completionIframeSnapshot === 'function' ? await agent._completionIframeSnapshot(tabId) : null;
    const identity = await agent._completionDocumentStamp(tabId, true);
    if (!identity || identity !== before || !context.isCurrent()) return null;
    const submit = agent._currentCompletionSubmitState(tabId);
    const binding = submit?.workflowBinding;
    const workflowBinding = binding ? { adapterName: binding.adapterName, revision: binding.revision,
      job: binding.job, verificationKind: binding.verificationKind, recipientBound: binding.recipientBound === true } : null;
    const info = {
      task: sidecarTexts.task,
      ...(sidecarTexts.plan != null ? { approved_plan: sidecarTexts.plan } : {}),
      requirements: { requiresSubmission: guard?.requiresSubmission, requiresStateChange: guard?.requiresStateChange, workflow: boundedText(guard?.siteWorkflow?.job?.id, 120) },
      action: wrapSystemOneData(boundedText(redactEvidence(JSON.stringify({ submit: submit ? {
        dispatched: submit.dispatched, observedAfterSubmit: submit.observedAfterSubmit,
        formRef: submit.formRef,
        formValidationFailed: submit.formValidationFailed,
        completionSignalObserved: typeof agent._completionObservedSuccess === 'function'
          ? agent._completionObservedSuccess(submit) : submit.completionSignalObserved === true,
        documentChanged: submit.documentChanged, originatingUrl: submit.originatingUrl, resultingUrl: submit.currentUrl,
        workflowBinding,
      } : null, lastAction: run?.lastAction })), 1000)),
      recorded_reads: history, recorded_actions: recordedActions, document: boundedText(redactEvidence(pageUrl), 1000),
      ...(resultScope ? { result_scope: resultScope } : {}),
      ...(resultView ? { result_view: resultView } : {}),
      ...(calculationEvidence ? { recorded_calculations: [{ tool: 'calculate',
        expression: boundedText(calculationEvidence.actualExpression, 1000), result: boundedText(calculationEvidence.result, 1000),
        ...(calculationEvidence.fraction ? { fraction: boundedText(calculationEvidence.fraction, 1000) } : {}) }] } : {}),
      resource_reads: resourceReads,
      page_errors: wrapSystemOneData(boundedText(redactEvidence(JSON.stringify(pageState?.validationMessages || pageState?.errorMessages || [])), 500)),
      page_status_messages: wrapSystemOneData(boundedText(Array.isArray(liveStatusMessages)
        ? liveStatusMessages.map(text => redactEvidence(String(text))).join('\n') : '[Live status unavailable]', 900)),
      ...(frame ? { submitted_frame: wrapSystemOneData(boundedText(redactEvidence(JSON.stringify({
        url: frame.url, identity: frame.identity, stamp: frame.stamp, observedAfterSubmit: frame.observedAfterSubmit,
        messages: frame.messages, text: frame.text,
      })), 5000)) } : {}),
      candidate_summary_not_proof: wrapSystemOneData(sidecarTexts.summary),
    };
    const state = [info, observation];
    // The active model's own copy of the trusted texts (see maskTrustedJudgeText).
    const llmInfo = { ...info, task: llmTexts.task, ...(llmTexts.plan != null ? { approved_plan: llmTexts.plan } : {}),
      candidate_summary_not_proof: wrapSystemOneData(llmTexts.summary) };
    // Fingerprint the complete local read too: redaction/truncation must not
    // let a changed result reuse an earlier judgment. Raw text stays local.
    const evidence = { identity, modality, state, llmState: [llmInfo, observation], ...(resultScope ? { resultScope } : {}), ...(frame ? { submittedFrameStamp: frame.stamp } : {}), key: await evidenceKey([state, llmInfo, resultFingerprint || null]) };
    captures.set(modality, evidence);
    return evidence;
  };
  const prior = agent._completionVerdicts.get(tabId);
  const priorCurrent = prior?.scope === scope && prior.outcome !== 'uncertain' && await current(prior).catch(error => {
    if (error?.code === 'COMPLETION_VISUAL_CHANGED') return false;
    throw error;
  });
  if (priorCurrent) {
    const fresh = await capture(prior.modality);
    if (fresh?.key === prior.evidenceKey) return prior;
  }
  invalidateCompletionProof(agent, tabId);
  // Scheduler checkpoints may reuse an already accepted verdict only while
  // its exact task/action/document/evidence remains current. Never pay for a
  // new judgment or promote an uncertain outcome during settlement.
  if (refreshOnly) return { outcome: 'uncertain', engine: 'freshness', reason: 'evidence_changed' };
  const online = globalThis.navigator?.onLine !== false;
  const sidecar = decisionFeatureEnabled(config, 'done') && (config.local || online) ? {
    name: config.provider, model: config.model, supportsVision: config.supportsVision,
    requiresIndependentSuccessConfirmation: config.requiresIndependentSuccessConfirmation === true,
    evaluate: async evidence => {
      const headers = compass ? { 'X-WebBrain-Device-Id': compass.deviceGuid || '', 'X-WebBrain-Client': 'extension', 'X-WebBrain-Help-Improve': compass.helpImproveWebBrain === false ? '0' : '1' } : {};
      const result = await agent.evaluateSystemOne(tabId, createSystemOneJudge({ maxRetries: 0 }), {
        config, state: evidence.state, questions: completionQuestions({ readMethod }), signal, headers,
        metadata: compass ? { session_id: agent.conversationIds.get(tabId), trace: { generation_name: 'completion_verification' } } : {},
      }, context);
      const verdict = decisionCompletionVerdict(result, config.threshold);
      // It cannot say what a summary it read only in part does.
      if (sidecarTexts.summary === llmTexts.summary || !verdict.summaryKind) return verdict;
      const { summaryKind: _unread, ...rest } = verdict;
      return rest;
    },
  } : null;
  // These switches outsource checks to the decision sidecar. The approved
  // routing still uses the active LLM when that sidecar is off/unconfigured.
  const llm = typeof provider.chat === 'function' && (online || provider.config?.category === 'local') ? {
    name: 'llm', model: provider.model, supportsVision: provider.supportsVision,
    evaluate: async (evidence, modality, { timeoutMs = 10000 } = {}) => {
      const judged = evidence.llmState || evidence.state;
      const [info, observation] = judged;
      // Thinking providers count hidden reasoning inside their output limit.
      // Leave bounded room for it and the verdict without overriding the
      // provider's reasoning configuration or adding another model request.
      const result = await withCompletionTimeout(requestSignal => agent._chatWithCostAllowance(provider, [
        { role: 'system', content: `${COMPLETION_INSTRUCTIONS} Return only JSON {"outcome":"succeeded|pending|failed|uncertain","reason":"brief evidence-based reason","later":"asked|not_asked","summary":"result|meta_only|plan_only"${readMethod ? ',"read":"asked|not_asked"' : ''}}. ${LATER_OUTCOME_FIELD} ${SUMMARY_KIND_FIELD}${readMethod ? ` ${READ_METHOD_FIELD}` : ''} Do not call tools or perform actions.` },
        { role: 'user', content: modality === 'vision' ? [{ type: 'text', text: JSON.stringify(info) }, observation] : JSON.stringify(judged) },
      ], { temperature: 0, maxTokens: 4096, signal: requestSignal }, context.costState || agent._newCostRunState(), { tabId, generationName: 'completion_verification' }), signal,
      Math.max(1, Math.min(10000, Number(timeoutMs) || 10000)));
      if (result.costAllowanceMessage) throw agent._costAllowanceError(result.costAllowanceMessage);
      // Its token counts go to the trace with the verdict, as the decision
      // model's do: a slow judge that spent its output on reasoning shows.
      return { ...llmCompletionVerdict(result.content, { readMethod }), model: provider.model, ...(result.usage ? { usage: result.usage } : {}) };
    },
  } : null;
  // When the sidecar's copy of the request or plan lost every line naming a
  // credential, no verdict of its can be tied to the task: a blind one kept
  // answering pending for a form the user said not to submit. While the
  // active model can judge, the sidecar is neither waited on nor sent evidence.
  const sidecarBlind = sidecarTexts.task !== llmTexts.task || sidecarTexts.plan !== llmTexts.plan;
  const decision = sidecar && sidecarBlind && llm ? null : sidecar;
  if (sidecar && !decision) {
    agent.recordSystemOneVerdict(tabId, { phase: 'done_verification', engine: sidecar.name, outcome: 'uncertain', reason: 'task_redacted' }, context);
  }
  const verdict = await verifyCompletion({ decision, llm, capture, isCurrent: current, signal, preferAx,
    onAttempt: ({ reason, ...metadata }) => agent.recordSystemOneVerdict(tabId, {
      phase: 'done_verification', ...metadata,
      // A model's own words never reach the trace: a sure verdict is recorded
      // as judged, an unsure one as insufficient evidence.
      ...(reason ? { reason: /^(?:capture_unavailable|unavailable|timeout|invalid_response|time_budget|COMPLETION_VISUAL_CHANGED|http_\d{3}|JEV_[A-Z_]+)$/.test(reason) ? reason
        : metadata.outcome && metadata.outcome !== 'uncertain' ? 'judged' : 'insufficient_evidence' } : {}),
    }, context) });
  const accepted = { ...verdict, scope, ...(captures.get(verdict.modality)?.submittedFrameStamp
    ? { submittedFrameStamp: captures.get(verdict.modality).submittedFrameStamp } : {}) };
  agent._completionVerdicts.set(tabId, accepted);
  return accepted;
}

export async function verifyBrowserCompletion(agent, tabId, options) {
  try {
    const calculationProof = Object.prototype.hasOwnProperty.call(options || {}, 'calculationProof')
      ? options.calculationProof : captureCalculationCompletion(agent, tabId, options?.summary);
    if (calculationProof) return await refreshCalculationCompletion(agent, tabId, options?.summary, calculationProof)
      ? { outcome: 'succeeded', engine: 'calculation', modality: 'utility' }
      : { outcome: 'pending', engine: 'freshness', reason: 'calculation_authority_changed' };
    return await evaluateBrowserCompletion(agent, tabId, options);
  }
  catch (error) {
    invalidateCompletionProof(agent, tabId);
    if ((error?.status ?? error?.httpStatus) === 402) error.code = 'WB_COST_ALLOWANCE';
    if (error?.code === 'STALE_COMPLETION') return { outcome: 'pending', engine: 'freshness', reason: 'evidence_changed' };
    if (completionStopError(error, agent._runAbortSignal(tabId))) throw error;
    return { outcome: 'uncertain', engine: 'legacy', reason: 'verifier_unavailable' };
  }
}
