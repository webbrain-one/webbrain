/** Tool freshness policy for passive page observations. Mirror in Firefox. */
import { calculateExpression, calculationExpressionSpans, calculationResultInText, tokenizeCalculationExpression } from './calculator.js';

const FRESH_READS = new Set([
  'get_accessibility_tree', 'get_interactive_elements', 'read_page', 'read_page_source',
  'extract_data', 'get_selection', 'get_shadow_dom', 'shadow_dom_query', 'get_frames',
  'iframe_read', 'get_window_info', 'list_webmcp_tools', 'inspect_viewport', 'screenshot',
  'wait_for_element', 'wait_for_stable', 'read_console', 'inspect_network_requests',
  'inspect_element_styles', 'verify_form', 'chat_observe', 'read_pdf', 'get_captcha_capabilities', 'find_text',
]);
const DETACHED_TOOLS = new Set([
  'calculate', 'list_downloads', 'read_downloaded_file', 'scratchpad_write', 'progress_read',
  'progress_update', 'recall_memcode', 'clarify', 'generate_image', 'schedule_task', 'schedule_resume', 'resize_window',
]);
const AX_ACTIONS = new Set(['click_ax', 'type_ax', 'set_field', 'set_checked']);
// The arithmetic in a request is found by its structure: the one span the
// calculator accepts. What the request asks for is not read from its words: a
// model answers the calculation_request question in any language, and the
// agent stores that sure reading on the execution guard as
// `calculationReading` ({ task, expression, choice }). Only a reading of this
// exact request and expression counts.
const CALCULATION_ONLY_READINGS = new Set(['only_result', 'only_result_with_form']);

// An expression's tokens, without a period that ends the sentence after its
// last number ("2 + 2." is "2 + 2").
function canonicalTokens(expression) {
  const tokens = tokenizeCalculationExpression(expression);
  return tokens.map((token, index) => (index === tokens.length - 1 && /^\d+\.$/.test(token) ? token.slice(0, -1) : token));
}

// Where the expression occurs in the request. Whitespace may separate tokens,
// never change a number, exponent or name; a final sentence period is
// punctuation, while a continuing decimal is part of the arithmetic token.
function literalExpressionOccurrences(task, expression) {
  if (typeof task !== 'string' || typeof expression !== 'string' || !expression.trim()
      || task.length > 6000 || expression.length > 6000) return null;
  const normalized = task.trim().replace(/\s+/g, ' ');
  try {
    const tokens = canonicalTokens(expression);
    const escaped = tokens.map(value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    const pattern = new RegExp('(?<![\\p{L}\\p{N}_.])' + escaped.join('\\s*')
      + '(?![\\p{L}\\p{N}_]|\\.\\d)', 'gu');
    return [...normalized.matchAll(pattern)].filter(match => {
      const actual = tokenizeCalculationExpression(match[0]);
      return actual.length === tokens.length && actual.every((value, index) => value === tokens[index]);
    });
  } catch { return null; }
}

// Two spellings name the same arithmetic when each occurs once in the request,
// at the same place, with the same tokens ("2 + 2" and the span "2 + 2.").
function sameOccurrence(task, left, right) {
  const a = literalExpressionOccurrences(task, left), b = literalExpressionOccurrences(task, right);
  try {
    return a?.length === 1 && b?.length === 1 && a[0].index === b[0].index
      && canonicalTokens(left).join(' ') === canonicalTokens(right).join(' ');
  } catch { return false; }
}

// Arithmetic, not a lone number: an operator between two numbers, or a
// calculator function.
function isArithmetic(expression) {
  try {
    const tokens = tokenizeCalculationExpression(expression);
    return tokens.some(token => /^[a-z]/i.test(token))
      || (tokens.filter(token => /^[\d.]/.test(token)).length >= 2 && tokens.some(token => /^[+\-*/]$/.test(token)));
  } catch { return false; }
}

// The one expression the request contains, by structure alone; the reading
// decides whether the request asks for nothing else. A request with no valid
// expression, or with several numbers or expressions, has no candidate.
// Digits inside a word or code (CALC_2026-10-08) are not arithmetic.
export function literalCalculationCandidate(task) {
  const candidates = calculationExpressionSpans(task).filter(expression =>
    literalExpressionOccurrences(task, expression)?.length === 1 && calculateExpression(expression).success === true);
  return candidates.length === 1 && isArithmetic(candidates[0]) ? candidates[0] : null;
}

export function literalCalculationTaskExpression(task, scope) {
  const expression = literalCalculationCandidate(task);
  return expression && isLiteralCalculationTask(task, expression, scope) ? expression : null;
}

// A request that asks only for this arithmetic, so its answer does not depend
// on live page data: the expression occurs once, the planner did not ask for
// page reads, and a sure reading of this exact request says it asks for the
// result alone. This tightens retention; it never authorizes another tool or
// skips the terminal completion gate.
export function isLiteralCalculationTask(task, expression, { readScope = null, calculationReading = null } = {}) {
  if (literalExpressionOccurrences(task, expression)?.length !== 1) return false;
  if (readScope != null && readScope !== 'none') return false;
  return !!calculationReading && CALCULATION_ONLY_READINGS.has(calculationReading.choice)
    && typeof calculationReading.task === 'string' && calculationReading.task.trim() === task.trim()
    && typeof calculationReading.expression === 'string' && sameOccurrence(task, calculationReading.expression, expression);
}

// How the answer must be written. A request that sets no form leaves only the
// structural check that the calculator's result is in the answer. When it
// sets one, the active model writes the form down with every required text
// copied from the request (calculationAnswerFormMessages), and the copies are
// checked against the request. A form that cannot be written down that way
// returns null here, so the completion judge reads the answer against the
// request in any language with the calculator's result as evidence.
export function literalCalculationOutputRequirements(task, expression, scope) {
  if (!isLiteralCalculationTask(task, expression, scope)) return null;
  const { choice, form } = scope.calculationReading;
  if (choice === 'only_result') return { markers: [], suffix: null, onlyScalar: false, scalarAtEnd: false };
  return form ? { ...form, markers: [...form.markers] } : null;
}

export function calculationAnswerFormMessages(request, expression) {
  return [
    { role: 'system', content: 'The user\'s request in `request` asks a browser agent only to calculate `expression` and '
      + 'report the result, and says how the answer must be written. Write that form down. Return only JSON '
      + '{"only_result":boolean,"result_last":boolean,"ending":string,"include":[string]}. "only_result" is true when the '
      + 'answer must be the result and nothing else. "result_last" is true when the answer must end with the result. '
      + '"ending" is the exact text the answer must end with when the request gives one (such as a marker or code), '
      + 'copied character for character from the request without quotation marks around it; otherwise "". "include" '
      + 'lists any other exact texts the answer must contain, copied the same way. Judge the meaning in any language. '
      + 'Never translate, complete or invent a text.' },
    { role: 'user', content: JSON.stringify({ request: String(request ?? ''), expression: String(expression ?? '') }) },
  ];
}

// The written-down form, kept only when every required text is copied from
// the request and the parts agree; otherwise null.
export function acceptCalculationAnswerForm(answer, request) {
  if (!answer || typeof answer !== 'object' || Array.isArray(answer)) return null;
  const source = String(request ?? '');
  const copied = value => typeof value === 'string' && !!value && value.length <= 80
    && value.trim() === value && !/[\r\n]/.test(value) && source.includes(value);
  const ending = answer.ending == null ? '' : answer.ending;
  const include = answer.include == null ? [] : answer.include;
  if ((ending !== '' && !copied(ending)) || !Array.isArray(include) || include.length > 8 || !include.every(copied)) return null;
  const onlyScalar = answer.only_result === true, resultLast = answer.result_last === true;
  if (onlyScalar && (ending || include.length)) return null;
  if (!onlyScalar && !resultLast && !ending && !include.length) return null;
  return { markers: [...new Set([...include, ...(ending ? [ending] : [])])], suffix: ending || null,
    onlyScalar, scalarAtEnd: resultLast && !ending };
}

export function literalCalculationSummaryFormatMatches(summary, requirements, result, fraction) {
  const literalPresent = value => {
    const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const left = /^[\p{L}\p{N}_]/u.test(value) ? '(?<![\\p{L}\\p{N}_])' : '';
    const right = /[\p{L}\p{N}_]$/u.test(value) ? '(?![\\p{L}\\p{N}_])' : '';
    return new RegExp(left + escaped + right, 'u').test(summary);
  };
  const suffixPresent = value => {
    const text = summary.trimEnd();
    return text.endsWith(value) && (!/^[\p{L}\p{N}_]/u.test(value)
      || !/[\p{L}\p{N}_]$/u.test(text.slice(0, -value.length)));
  };
  return typeof summary === 'string' && !!requirements
    && requirements.markers.every(literalPresent)
    && (!requirements.suffix || suffixPresent(requirements.suffix))
    && (!(requirements.onlyScalar || requirements.scalarAtEnd) || calculationResultInText(summary, result, fraction,
      { onlyScalar: requirements.onlyScalar, atEnd: requirements.scalarAtEnd }));
}
// A candidate only: the isolated monitor must validate the private snapshot
// captured together with the page observation before the model made this call.
const BOUND_ACTIONS = new Set(['click', 'click_ax', 'type_text', 'type_ax', 'set_field', 'set_checked',
  'press_keys', 'hover', 'upload_file']);
function hasBoundTarget(name, args, state) {
  return BOUND_ACTIONS.has(name) && !!state.actionBinding?.snapshotToken
    && !Number.isFinite(args.x) && !Number.isFinite(args.y)
    && (args.frameId == null || Number(args.frameId) === 0)
    && (args.targetFrame == null || Number(args.targetFrame) === 0)
    && !args.allFrames && !args.all && !args.urlFilter
    && (/^ref_[A-Za-z0-9_-]+$/.test(args.ref_id || '')
      || (typeof args.selector === 'string' && !!args.selector.trim())
      || (['type_text', 'press_keys'].includes(name) && !args.ref_id && !args.selector
        && state.actionBinding.focusedTargetAvailable === true));
}
const httpUrl = value => {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.href : null;
  } catch { return null; }
};

const BASE_STYLE_LINK = /^(?:base|style|link)(?:$|[\s#.])/;
export function isPassivePageFeedback(events) {
  return !!events?.length && events.every(event => event.kind === 'dom' && event.source === 'page'
    && event.frameId === 0 && !BASE_STYLE_LINK.test(event.target || ''));
}

// Automatic feedback is an observed page consequence with no evidence of a
// human gesture. Every 'user' event, main-frame navigation, any top-level
// viewport change (the monitor reports those as unknown) and base/style/link
// updates keep the strict fence. Focus moved to an <iframe> is page-script focus: Chromium and
// Firefox fire no parent focusin for a click or Tab inside a frame (a Tab
// reaches the parent monitor as user keydown activity).
const AUTOMATIC_SOURCES = new Map([['dom', ['page', 'unknown']], ['scroll', ['page', 'unknown']],
  ['resize', ['page', 'unknown']], ['navigation', ['page', 'unknown']], ['activity', ['page']], ['input', ['page']]]);
export function isAutomaticPageFeedbackEvent(event) {
  if (!AUTOMATIC_SOURCES.get(event?.kind)?.includes(event.source)
      || BASE_STYLE_LINK.test(typeof event.target === 'string' ? event.target : '')) return false;
  const childFrame = Number.isSafeInteger(event.frameId) && event.frameId > 0;
  return event.kind === 'navigation' || event.kind === 'resize' ? childFrame : true;
}

export function isAutomaticPageFeedback(events) {
  return !!events?.length && events.every(isAutomaticPageFeedbackEvent);
}

function axTargetContext(page, refId) {
  if (!page || page.success === false || page.depthTruncated || page.truncated || !/^ref_[A-Za-z0-9_-]+$/.test(refId || '')) return null;
  const lines = String(page.pageContent || '').split(/\r?\n/);
  const indices = lines.flatMap((line, index) => line.includes(`[${refId}]`) ? [index] : []);
  if (indices.length !== 1) return null;
  const index = indices[0], line = lines[index];
  if (/\b(?:occluded|disabled|inert)=true\b/.test(line)) return null;
  let depth = line.length - line.trimStart().length;
  const ancestors = [];
  let scope = index, scopeRole = '';
  let navigation = false;
  const href = /\bhref=("(?:\\.|[^"\\])*")/.exec(line);
  if (/^\s*link\b/.test(line) && href) {
    try { navigation = !!httpUrl(new URL(JSON.parse(href[1]), page.url).href); } catch {}
  }
  for (let i = index - 1; i >= 0 && depth > 0; i--) {
    const ancestorDepth = lines[i].length - lines[i].trimStart().length;
    if (lines[i].trim() && ancestorDepth < depth) {
      ancestors.unshift(lines[i]); depth = ancestorDepth;
      // A form/dialog/region binds the action to its recipient/composer/entity,
      // not just to a same-labelled control elsewhere on the document.
      const role = /^\s*(form|dialog|region|article|listitem)\b/.exec(lines[i])?.[1];
      if (!navigation && role && (scope === index || (scopeRole === 'form' && role !== 'form'))) {
        scope = i; scopeRole = role;
      }
    }
  }
  const scopeDepth = lines[scope].length - lines[scope].trimStart().length;
  let end = scope + 1;
  while (end < lines.length && (!lines[end].trim() || lines[end].length - lines[end].trimStart().length > scopeDepth)) end++;
  // Conversation/entity headings often sit outside the composer form.
  // Bind their full AX subtree just as the local monitor does, so an unchanged
  // control cannot silently transfer to another recipient or resource.
  const headings = [];
  if (!navigation) for (let i = 0; i < lines.length; i++) {
    if (!/^\s*heading\b/.test(lines[i])) continue;
    const headingDepth = lines[i].length - lines[i].trimStart().length;
    let last = i + 1;
    while (last < lines.length && (!lines[last].trim() || lines[last].length - lines[last].trimStart().length > headingDepth)) last++;
    headings.push(lines.slice(i, last));
  }
  return { line, context: JSON.stringify([ancestors, lines.slice(scope, end), headings]) };
}

export function pageFeedbackCallPolicy(name, args = {}, state = {}, currentPage = null, events = []) {
  if (FRESH_READS.has(name)) return { kind: 'observe' };
  if (DETACHED_TOOLS.has(name)) return { kind: 'independent' };
  if (['fetch_url', 'research_url'].includes(name) && httpUrl(args.url)
      && ['GET', 'HEAD'].includes(String(args.method || 'GET').toUpperCase())
      && !args.replayRequestId && !args.apiReplayRequestId && !args.body) return { kind: 'independent' };
  // A concrete API request does not act on a DOM target. Retaining it only
  // preserves the proposed call: API consent, recipient, submission and CAPTCHA
  // checks still run before dispatch. Captured replays depend on page state.
  if (name === 'fetch_url' && httpUrl(args.url)
      && ['POST', 'PUT', 'PATCH', 'DELETE'].includes(String(args.method || '').toUpperCase())
      && !args.replayRequestId && !args.apiReplayRequestId
      && (args.body == null || typeof args.body === 'string')) return { kind: 'request' };
  if (['download_files', 'download_file'].includes(name)) {
    // Match the handler's singular-URL alias and precedence exactly. Page churn
    // does not alter a concrete resource URL already supplied to the download.
    const urls = Array.isArray(args.urls) && args.urls.length ? args.urls : args.url ? [args.url] : [];
    if (urls.length && urls.every(httpUrl)) return { kind: 'independent' };
  }
  if (name === 'download_public_media' && (httpUrl(args.url) || httpUrl(state.url))) return { kind: 'independent' };
  if (name === 'navigate' && httpUrl(args.url)) return { kind: 'navigate' };
  // Ask exposes a summary-only done schema. Its answer can come from completed
  // detached research, so unrelated counters (or a failed AX refresh) do not
  // require a new inference. The run mode is private pre-inference state.
  const askSummary = state.runMode === 'ask'
    && !Object.prototype.hasOwnProperty.call(args, 'outcome')
    && typeof args.summary === 'string' && !!args.summary.trim();
  if (name === 'done' && (askSummary || ['partial', 'failed'].includes(args.outcome)
      || (args.outcome === 'success' && (currentPage?.success !== false
        || state.pureCalculationComplete === true)))) return { kind: 'observe', terminal: true };
  if (name === 'download_social_media' && !args.scroll && !args.all
      && [undefined, 'main', 'auto'].includes(args.mode)
      && [undefined, 'dom', 'auto'].includes(args.strategy)
      && (args.limit == null || args.limit === 1)) {
    const target = !args.target || args.target === 'media' ? 'auto' : args.target;
    if (['auto', 'image', 'video'].includes(target)) {
      const binding = state.mediaBindings?.[target];
      if (binding && (args.mode === 'main' || binding.focused)) return { kind: 'media', binding, target };
      // An unavailable optional precapture is not a changed page. Dispatch a
      // read-only resolver result so the model can inspect actual media sources;
      // this policy never permits an unbound fetch/save or a fallback mutation.
      return { kind: 'media_resolve', target, reason: binding ? 'focus_unverified' : 'media_binding_missing' };
    }
  }
  if (hasBoundTarget(name, args, state)) return { kind: 'bound_target' };
  // Without a private footprint the AX text comparison certifies content only.
  // It cannot revalidate focus, input, scroll, geometry or a child document.
  if (!AX_ACTIONS.has(name) || !currentPage || events.some(event => event?.kind !== 'dom'
      || /^(?:form|input|textarea|select|option)(?:$|[\s#.])/.test(event.target || ''))) return { kind: 'unsafe' };
  const before = axTargetContext(state.page && { ...state.page, url: state.page.url || state.url }, args.ref_id);
  const after = axTargetContext({ ...currentPage, url: currentPage.url || state.url }, args.ref_id);
  if (!before || before.context !== after?.context) return { kind: 'unsafe' };
  // Submissions retain all existing model, form, recipient and dispatch gates.
  // A changing submit surface must be reconsidered rather than accepted from AX alone.
  if (name === 'click_ax' && /\btype="submit"/.test(after.line)) return { kind: 'unsafe' };
  return { kind: 'target' };
}

export function isPageIndependentCalculationCompletion(calls, state, events) {
  if (state?.pureCalculationComplete !== true || !state.calculationResponseScope
      || calls?.length !== 1 || !events?.length || calls[0].function?.name !== 'done') return false;
  let args;
  try { args = JSON.parse(calls[0].function.arguments); } catch { return false; }
  if (args?.outcome !== 'success') return false;
  // Spontaneous page focus remains material for browser actions. A current
  // literal calculation receipt and its terminal answer do not depend on it.
  // Physical gestures, editing, navigation and focus into a frame stay fenced.
  return events.every(event => isPassivePageFeedback([event])
    || (event.kind === 'activity' && event.source === 'page' && event.frameId === 0
      && !/^(?:iframe|frame)(?:$|[\s#.])/i.test(event.target || '')));
}

// These tools inspect the current top-level document without acting on focus.
// Read-preparation tools that can click a profile or wait/scroll remain excluded
// after page focus or synthetic input changed the interactive page state.
const PAGE_ACTIVITY_READS = new Set([
  'get_accessibility_tree', 'get_interactive_elements', 'read_page', 'read_page_source', 'verify_form',
]);

export function canRetainPageFeedbackCalls(calls, state, currentPage, events, { pending = false } = {}) {
  if (!calls?.length) return false;
  const passive = isPassivePageFeedback(events);
  const calculation = isPageIndependentCalculationCompletion(calls, state, events);
  const automatic = !passive && isAutomaticPageFeedback(events);
  if (!passive && !calculation && !automatic) return false;
  const interactive = !passive && events.some(event => ['activity', 'input'].includes(event?.kind));
  return calls.every(call => {
    let args;
    try { args = JSON.parse(call.function?.arguments); } catch { return false; }
    if (!args || typeof args !== 'object' || Array.isArray(args)) return false;
    const policy = pageFeedbackCallPolicy(call.function?.name, args, state, currentPage, events);
    if (policy.terminal && calls.length !== 1) return false;
    // An Act completion survives automatic churn (ad frames, page focus,
    // unattributed scroll or DOM): superseding it on every tick would end a
    // finished task as page_unstable. Its batch still runs the completion
    // verifier on fresh evidence, and user input still supersedes it. Ask
    // answers keep their own scope classification and passive-only fence.
    if (policy.terminal) return passive || calculation || (automatic && state?.runMode !== 'ask');
    if (interactive && policy.kind === 'observe' && !PAGE_ACTIVITY_READS.has(call.function?.name)) return false;
    // A target comparison only certifies the snapshot just read. Further DOM
    // changes require local revalidation; fresh readers/media have their own fences.
    if (pending && policy.kind === 'target') return false;
    return policy.kind !== 'unsafe';
  });
}
