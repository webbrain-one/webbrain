/**
 * Local saved-workflow schema and trace compiler.
 *
 * This module is deliberately pure: the schema boundary is shared by Chrome,
 * Firefox, the background worker, and Node tests. A workflow is not an
 * executable trace. Historical element refs and typed values are removed while
 * compiling, and every page target is represented by semantic evidence that
 * must be resolved against the current document at replay time.
 */

export const SAVED_WORKFLOWS_STORAGE_KEY = 'wb_saved_workflows_v1';
export const SAVED_WORKFLOW_SCHEMA = 'webbrain-workflow/1';
export const WORKFLOW_PARAM_REF_KEY = '$workflowParam';

const STORE_VERSION = 1;
const MAX_WORKFLOWS = 100;
const MAX_STEPS = 100;
const MAX_PARAMETERS = 50;
const MAX_TEXT = 240;
// findWorkflowTarget and compile-time strength checks share this floor so a
// saved target that can never match uniquely is rejected at save time.
export const WORKFLOW_TARGET_MATCH_THRESHOLD = 7;

export const REPLAYABLE_WORKFLOW_TOOLS = new Set([
  'navigate',
  'go_back',
  'go_forward',
  'click',
  'click_ax',
  'set_checked',
  'type_ax',
  'set_field',
  'scroll',
  'wait_for_element',
]);

const TARGET_FIELDS = [
  'role', 'name', 'label', 'id', 'fieldName', 'type', 'ariaLabel',
  'placeholder', 'href',
];

function nowMs() { return Date.now(); }
function randomId() { return Math.random().toString(36).slice(2, 10); }

function cleanText(value, max = MAX_TEXT) {
  const text = String(value ?? '')
    .replace(/\u00a0/g, ' ')
    .replace(/[\r\n]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > max ? text.slice(0, max).trim() : text;
}

function cleanId(value, fallback = '') {
  return cleanText(value, 100).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 80) || fallback;
}

function timestamp(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function normalizeComparable(value) {
  return cleanText(value, 500).toLocaleLowerCase().replace(/\s+/g, ' ').trim();
}

export function createSavedWorkflowId(ts = nowMs()) {
  return `workflow_${ts}_${randomId()}`;
}

export function normalizeSavedWorkflowName(value) {
  return cleanText(value, 80);
}

function safeHttpUrl(value) {
  try {
    const url = new URL(String(value || ''));
    if (!['http:', 'https:'].includes(url.protocol)) return '';
    url.username = '';
    url.password = '';
    // Queries and fragments commonly carry searches, OAuth codes, tokens, or
    // user data. V1 stores only the durable route; a changing value must be a
    // runtime workflow parameter rather than historical trace material.
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return '';
  }
}

function pathFamily(pathname) {
  const parts = String(pathname || '/')
    .split('/')
    .filter(Boolean)
    .map((part) => {
      let decoded = part;
      try { decoded = decodeURIComponent(part); } catch {}
      if (/^\d{2,}$/.test(decoded)) return ':id';
      if (/^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(decoded)) return ':id';
      if (/^[A-Za-z0-9_-]{20,}$/.test(decoded) && /\d/.test(decoded)) return ':id';
      return cleanText(decoded, 100);
    });
  return `/${parts.join('/')}` || '/';
}

export function workflowUrlScope(value) {
  const safe = safeHttpUrl(value);
  if (!safe) return null;
  const url = new URL(safe);
  return { origin: url.origin, pathFamily: pathFamily(url.pathname) };
}

export function workflowUrlMatches(scope, value) {
  const current = workflowUrlScope(value);
  if (!scope?.origin || !current || current.origin !== scope.origin) return false;
  const expected = String(scope.pathFamily || '/').split('/');
  const actual = String(current.pathFamily || '/').split('/');
  if (expected.length !== actual.length) return false;
  return expected.every((part, index) => part === ':id' || part === actual[index]);
}

function normalizeWorkflowScope(input) {
  const origin = cleanText(input?.origin, 300);
  try {
    const parsed = new URL(origin);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.origin !== origin) return null;
  } catch {
    return null;
  }
  return {
    origin,
    pathFamily: cleanText(input?.pathFamily || '/', 500) || '/',
  };
}

function parseAttributes(text) {
  const attrs = {};
  const regex = /([A-Za-z_][\w-]*)="([^"]*)"/g;
  let match;
  while ((match = regex.exec(String(text || '')))) {
    attrs[match[1]] = cleanText(match[2]);
  }
  return attrs;
}

export function parseAccessibilityTreeDescriptors(value) {
  const out = [];
  for (const line of String(value || '').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z][\w-]*)(?:\s+"([^"]*)")?[^\n]*?\[(ref_[A-Za-z0-9_-]+)\](.*)$/);
    if (!match) continue;
    const attrs = parseAttributes(match[4]);
    const descriptor = {
      refId: match[3],
      role: cleanText(match[1]),
      ...(cleanText(match[2]) ? { name: cleanText(match[2]) } : {}),
      ...(attrs.href ? { href: safeHttpUrl(attrs.href) || cleanText(attrs.href) } : {}),
      ...(attrs.type ? { type: attrs.type } : {}),
      ...(attrs.placeholder ? { placeholder: attrs.placeholder } : {}),
      ...(attrs.id ? { id: attrs.id } : {}),
      ...(attrs.name ? { fieldName: attrs.name } : {}),
      ...(attrs['aria-label'] ? { ariaLabel: attrs['aria-label'] } : {}),
    };
    out.push(descriptor);
  }
  return out;
}

function treeTextFromResult(result) {
  if (typeof result === 'string') return result;
  if (!result || typeof result !== 'object') return '';
  return result.pageContent || result.tree || result.content || result.text || result.head || '';
}

function normalizeTarget(input) {
  const target = {};
  for (const field of TARGET_FIELDS) {
    const value = cleanText(input?.[field]);
    if (!value || /^ref_[A-Za-z0-9_-]+$/i.test(value)) continue;
    target[field] = field === 'href' ? (safeHttpUrl(value) || value) : value;
  }
  return Object.keys(target).length ? target : null;
}

function targetFromTrace(refDescriptor, result) {
  const fieldMeta = result?.fieldMeta || {};
  return normalizeTarget({
    ...refDescriptor,
    name: result?.name || refDescriptor?.name,
    href: result?.href || refDescriptor?.href,
    selector: result?.selector || refDescriptor?.selector,
    label: fieldMeta.labelText || refDescriptor?.label,
    id: fieldMeta.id || refDescriptor?.id,
    fieldName: fieldMeta.name || refDescriptor?.fieldName,
    type: fieldMeta.type || refDescriptor?.type,
    ariaLabel: fieldMeta.ariaLabel || refDescriptor?.ariaLabel,
    placeholder: fieldMeta.placeholder || refDescriptor?.placeholder,
  });
}

function sensitiveParameter(target) {
  const identity = [
    target?.name, target?.label, target?.fieldName, target?.ariaLabel,
    target?.placeholder, target?.type,
  ].filter(Boolean).join(' ').toLowerCase();
  return /password|passcode|secret|token|api.?key|otp|2fa|mfa|one.?time|recovery.?code/.test(identity);
}

function parameterBase(target, fallback) {
  return cleanId(
    target?.fieldName || target?.id || target?.label || target?.ariaLabel || target?.name,
    fallback,
  ).toLowerCase();
}

function uniqueParameterId(base, parameters) {
  const used = new Set(parameters.map((parameter) => parameter.id));
  let id = base || `input_${parameters.length + 1}`;
  let suffix = 2;
  while (used.has(id)) id = `${base}_${suffix++}`;
  return id;
}

function isSuccessfulToolEvent(data) {
  const result = data?.result;
  if (result == null) return false;
  if (typeof result !== 'object') return true;
  return result.success !== false && !result.error && !result.denied && !result.cancelled && !result.skipped;
}

function expectedPostcondition(result) {
  if (!result || typeof result !== 'object') return null;
  if (typeof result.checkedAfter === 'boolean') return { kind: 'checked', value: result.checkedAfter };
  if (result.pageUrlChanged) return { kind: 'url_changed' };
  if (result.verified === true) return { kind: 'tool_verified' };
  return { kind: 'tool_success' };
}

function compileStepArgs(name, rawArgs, target, parameters, warnings) {
  const args = rawArgs && typeof rawArgs === 'object' ? rawArgs : {};
  if (name === 'navigate') {
    const url = safeHttpUrl(args.url);
    if (!url) return null;
    if (String(args.url || '').includes('?') || String(args.url || '').includes('#')) {
      warnings.push('A navigation query or fragment was removed; provide dynamic destinations at run time.');
    }
    return { url };
  }
  if (name === 'go_back' || name === 'go_forward') return {};
  if (name === 'click_ax') return isReplayableWorkflowTarget(target) ? {} : null;
  if (name === 'set_checked') {
    return isReplayableWorkflowTarget(target) && typeof args.checked === 'boolean'
      ? { checked: args.checked }
      : null;
  }
  if (name === 'type_ax' || name === 'set_field') {
    if (!isReplayableWorkflowTarget(target) || parameters.length >= MAX_PARAMETERS) return null;
    const base = parameterBase(target, `input_${parameters.length + 1}`);
    const id = uniqueParameterId(base, parameters);
    parameters.push({
      id,
      label: cleanText(target.label || target.ariaLabel || target.name || target.fieldName || id, 120),
      required: true,
      sensitive: sensitiveParameter(target),
      type: 'text',
    });
    return {
      text: { [WORKFLOW_PARAM_REF_KEY]: id },
      ...(typeof args.clear === 'boolean' ? { clear: args.clear } : {}),
      ...(name === 'set_field' && typeof args.submit === 'boolean' ? { submit: args.submit } : {}),
    };
  }
  if (name === 'click') {
    // Coordinate and historical element-index replay are intentionally absent.
    if (args.x != null || args.y != null || args.index != null) return null;
    const text = cleanText(args.text);
    // A CSS selector can silently resolve to a different element after a page
    // update. Text click retains the existing current-page ambiguity checks;
    // ref-based actions are compiled separately with semantic target evidence.
    return text ? { text } : null;
  }
  if (name === 'scroll') {
    if ((args.ref_id || args.refId) && !target) return null;
    const direction = ['up', 'down', 'left', 'right'].includes(args.direction) ? args.direction : 'down';
    const amount = Number(args.amount);
    return {
      direction,
      ...(Number.isFinite(amount) ? { amount: Math.max(1, Math.min(5000, Math.round(amount))) } : {}),
    };
  }
  if (name === 'wait_for_element') {
    // Same fail-closed rule as click: bare CSS selectors are brittle across
    // layout changes and must not be stored for deterministic replay.
    const text = cleanText(args.text);
    const timeout = Number(args.timeout);
    if (!text) return null;
    return {
      text,
      ...(Number.isFinite(timeout) ? { timeout: Math.max(100, Math.min(30000, Math.round(timeout))) } : {}),
    };
  }
  return null;
}

export function compileWorkflowFromTrace(run, events, options = {}) {
  const ts = timestamp(options.now, nowMs());
  const name = normalizeSavedWorkflowName(options.name);
  if (!name) return { workflow: null, warnings: [], reason: 'name_required' };
  if (!run || run.status !== 'done') return { workflow: null, warnings: [], reason: 'successful_run_required' };
  const urlScope = workflowUrlScope(run.tabUrl);
  if (!urlScope) return { workflow: null, warnings: [], reason: 'http_start_url_required' };

  const warnings = [];
  const parameters = [];
  const steps = [];
  const refs = new Map();
  let currentUrl = safeHttpUrl(run.tabUrl);
  let toolCount = 0;
  let skippedToolCount = 0;

  for (const event of Array.isArray(events) ? [...events].sort((a, b) => (a?.seq || 0) - (b?.seq || 0)) : []) {
    if (event?.kind !== 'tool') continue;
    toolCount += 1;
    const data = event.data || {};
    if (data.name === 'get_accessibility_tree') {
      const observedUrl = safeHttpUrl(data.result?.currentUrl || data.result?.pageUrl || data.result?.url);
      if (observedUrl && observedUrl !== currentUrl) {
        currentUrl = observedUrl;
        refs.clear();
      }
      for (const descriptor of parseAccessibilityTreeDescriptors(treeTextFromResult(data.result))) {
        refs.set(descriptor.refId, descriptor);
      }
      continue;
    }
    if (!REPLAYABLE_WORKFLOW_TOOLS.has(data.name) || !isSuccessfulToolEvent(data)) {
      skippedToolCount += 1;
      continue;
    }
    const rawArgs = data.args && typeof data.args === 'object' ? data.args : {};
    const refId = rawArgs.ref_id || rawArgs.refId;
    const target = targetFromTrace(refs.get(refId), data.result);
    const args = compileStepArgs(data.name, rawArgs, target, parameters, warnings);
    if (!args) {
      skippedToolCount += 1;
      warnings.push(`Skipped ${data.name}: it had no safe, reusable target or arguments.`);
      continue;
    }
    const stepScope = workflowUrlScope(currentUrl);
    steps.push({
      id: `step_${steps.length + 1}`,
      tool: data.name,
      args,
      ...(target ? { target } : {}),
      ...(stepScope ? { scope: stepScope } : {}),
      expected: expectedPostcondition(data.result),
    });
    const resultUrl = safeHttpUrl(
      data.result?.currentUrl
      || data.result?.pageUrl
      || (data.name === 'navigate' ? rawArgs.url : data.result?.url),
    );
    if (resultUrl && resultUrl !== currentUrl) {
      currentUrl = resultUrl;
      refs.clear();
    }
    if (steps.length >= MAX_STEPS) break;
  }

  if (!steps.length) return { workflow: null, warnings, reason: 'no_replayable_steps' };
  const workflow = normalizeSavedWorkflow({
    schema: SAVED_WORKFLOW_SCHEMA,
    id: options.id || createSavedWorkflowId(ts),
    name,
    createdAt: ts,
    updatedAt: ts,
    source: {
      runId: cleanId(run.runId),
      webbrainVersion: cleanText(run.webbrainVersion, 40),
    },
    start: urlScope,
    parameters,
    steps,
    stats: { sourceToolCount: toolCount, compiledStepCount: steps.length, skippedToolCount },
  }, { now: ts });
  return workflow
    ? { workflow, warnings, reason: '' }
    : { workflow: null, warnings, reason: 'normalization_failed' };
}

function normalizeParameter(input) {
  const id = cleanId(input?.id).toLowerCase();
  if (!id) return null;
  return {
    id,
    label: cleanText(input?.label || id, 120),
    required: input?.required !== false,
    sensitive: input?.sensitive === true,
    type: 'text',
  };
}

function normalizeArgsValue(value, parameterIds, depth = 0) {
  if (depth > 6) return undefined;
  if (value == null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'string') {
    if (/^ref_[A-Za-z0-9_-]+$/i.test(value)) return undefined;
    return cleanText(value, 1000);
  }
  if (Array.isArray(value)) {
    const out = value.map((item) => normalizeArgsValue(item, parameterIds, depth + 1));
    return out.some((item) => item === undefined) ? undefined : out;
  }
  if (typeof value !== 'object') return undefined;
  if (Object.keys(value).length === 1 && Object.hasOwn(value, WORKFLOW_PARAM_REF_KEY)) {
    const id = cleanId(value[WORKFLOW_PARAM_REF_KEY]).toLowerCase();
    return parameterIds.has(id) ? { [WORKFLOW_PARAM_REF_KEY]: id } : undefined;
  }
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    if (/^(ref_?id|x|y|index|replayRequestId|apiReplayRequestId)$/i.test(key)) return undefined;
    const normalized = normalizeArgsValue(item, parameterIds, depth + 1);
    if (normalized === undefined) return undefined;
    out[key] = normalized;
  }
  return out;
}

function normalizeExpected(input) {
  const kind = cleanText(input?.kind, 40);
  if (!['tool_success', 'tool_verified', 'url_changed', 'checked'].includes(kind)) return { kind: 'tool_success' };
  return kind === 'checked' ? { kind, value: input?.value === true } : { kind };
}

export function normalizeSavedWorkflow(input, options = {}) {
  const ts = timestamp(options.now, nowMs());
  if (input?.schema !== SAVED_WORKFLOW_SCHEMA) return null;
  const name = normalizeSavedWorkflowName(input?.name);
  const id = cleanId(input?.id, createSavedWorkflowId(ts));
  const start = normalizeWorkflowScope(input?.start);
  if (!name || !id || !start) return null;

  const parameters = [];
  const parameterIds = new Set();
  for (const raw of Array.isArray(input?.parameters) ? input.parameters : []) {
    const parameter = normalizeParameter(raw);
    if (!parameter || parameterIds.has(parameter.id)) continue;
    parameterIds.add(parameter.id);
    parameters.push(parameter);
    if (parameters.length >= MAX_PARAMETERS) break;
  }

  const steps = [];
  for (const raw of Array.isArray(input?.steps) ? input.steps : []) {
    const tool = cleanText(raw?.tool, 80);
    if (!REPLAYABLE_WORKFLOW_TOOLS.has(tool)) continue;
    let args = normalizeArgsValue(raw?.args || {}, parameterIds);
    if (!args || typeof args !== 'object' || Array.isArray(args)) continue;
    if (tool === 'click') {
      const text = cleanText(args.text);
      if (!text) continue;
      args = { text };
    }
    if (tool === 'wait_for_element') {
      const text = cleanText(args.text);
      if (!text) continue;
      const timeout = Number(args.timeout);
      args = {
        text,
        ...(Number.isFinite(timeout) ? { timeout: Math.max(100, Math.min(30000, Math.round(timeout))) } : {}),
      };
    }
    if ((tool === 'type_ax' || tool === 'set_field') && !args.text?.[WORKFLOW_PARAM_REF_KEY]) continue;
    const target = normalizeTarget(raw?.target);
    const scope = normalizeWorkflowScope(raw?.scope);
    if (['click_ax', 'set_checked', 'type_ax', 'set_field'].includes(tool)
        && !isReplayableWorkflowTarget(target)) {
      continue;
    }
    steps.push({
      id: cleanId(raw?.id, `step_${steps.length + 1}`),
      tool,
      args,
      ...(target ? { target } : {}),
      ...(scope ? { scope } : {}),
      expected: normalizeExpected(raw?.expected),
    });
    if (steps.length >= MAX_STEPS) break;
  }
  if (!steps.length) return null;

  const createdAt = timestamp(input?.createdAt, ts);
  return {
    schema: SAVED_WORKFLOW_SCHEMA,
    id,
    name,
    createdAt,
    updatedAt: timestamp(input?.updatedAt, createdAt),
    source: {
      runId: cleanId(input?.source?.runId),
      webbrainVersion: cleanText(input?.source?.webbrainVersion, 40),
    },
    start,
    parameters,
    steps,
    stats: {
      sourceToolCount: Math.max(0, Math.floor(Number(input?.stats?.sourceToolCount) || 0)),
      compiledStepCount: steps.length,
      skippedToolCount: Math.max(0, Math.floor(Number(input?.stats?.skippedToolCount) || 0)),
    },
  };
}

export function normalizeSavedWorkflowStore(input, options = {}) {
  const ts = timestamp(options.now, nowMs());
  const workflows = [];
  const ids = new Set();
  for (const raw of Array.isArray(input?.workflows) ? input.workflows : []) {
    const workflow = normalizeSavedWorkflow(raw, { now: ts });
    if (!workflow || ids.has(workflow.id)) continue;
    ids.add(workflow.id);
    workflows.push(workflow);
    if (workflows.length >= MAX_WORKFLOWS) break;
  }
  workflows.sort((a, b) => b.updatedAt - a.updatedAt);
  return { version: STORE_VERSION, updatedAt: timestamp(input?.updatedAt, ts), workflows };
}

export function resolveWorkflowArgs(args, parameters = {}) {
  const resolve = (value, depth = 0) => {
    if (depth > 6) throw new Error('Workflow arguments are nested too deeply.');
    if (Array.isArray(value)) return value.map((item) => resolve(item, depth + 1));
    if (!value || typeof value !== 'object') return value;
    if (Object.keys(value).length === 1 && Object.hasOwn(value, WORKFLOW_PARAM_REF_KEY)) {
      const id = value[WORKFLOW_PARAM_REF_KEY];
      if (!Object.hasOwn(parameters, id)) throw new Error(`Missing workflow parameter: ${id}`);
      return String(parameters[id]);
    }
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, resolve(item, depth + 1)]));
  };
  return resolve(args || {});
}

export function redactWorkflowArgsForTelemetry(template, resolved) {
  const redact = (source, value, depth = 0) => {
    if (depth > 6) return '[redacted]';
    if (source && typeof source === 'object'
        && !Array.isArray(source)
        && Object.keys(source).length === 1
        && Object.hasOwn(source, WORKFLOW_PARAM_REF_KEY)) {
      return `<workflow-parameter:${cleanId(source[WORKFLOW_PARAM_REF_KEY], 'value')}>`;
    }
    if (Array.isArray(source)) {
      return source.map((item, index) => redact(item, Array.isArray(value) ? value[index] : undefined, depth + 1));
    }
    if (!source || typeof source !== 'object') return value;
    const out = {};
    for (const [key, item] of Object.entries(source)) {
      out[key] = redact(item, value?.[key], depth + 1);
    }
    return out;
  };
  return redact(template || {}, resolved || {});
}

export function redactWorkflowResultForTelemetry(tool, result) {
  if (!result || typeof result !== 'object') return result;
  const redactKeys = new Set(['actual', '_expectedValue', 'value', 'text']);
  const redact = (value, depth = 0) => {
    if (depth > 5 || value == null || typeof value !== 'object') return value;
    if (Array.isArray(value)) return value.map((item) => redact(item, depth + 1));
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      out[key] = redactKeys.has(key) && ['type_ax', 'set_field'].includes(tool)
        ? '[workflow parameter redacted]'
        : redact(item, depth + 1);
    }
    return out;
  };
  return redact(result);
}

function redactWorkflowSubmitField(field) {
  if (!field || typeof field !== 'object') return field;
  const out = { ...field };
  for (const key of ['value', 'text', 'actual', 'currentValue', 'newValue', 'oldValue']) {
    if (Object.hasOwn(out, key) && out[key] != null && out[key] !== '') {
      out[key] = '[workflow parameter redacted]';
    }
  }
  return out;
}

/**
 * Submit-confirmation and similar clarify events can carry live form field
 * values that were just typed as workflow parameters. Keep host/tool labels
 * for the user prompt, but strip values and free-text summaries from UI
 * telemetry during replay.
 */
export function redactWorkflowClarifyForTelemetry(data = {}) {
  const out = { ...(data && typeof data === 'object' ? data : {}), workflowReplay: true };
  if (out.submitConfirmation && typeof out.submitConfirmation === 'object') {
    const sc = { ...out.submitConfirmation };
    if (sc.summary) sc.summary = '[workflow form summary redacted]';
    if (Array.isArray(sc.fields)) sc.fields = sc.fields.map(redactWorkflowSubmitField);
    if (Array.isArray(sc.changedFields)) {
      sc.changedFields = sc.changedFields.map(redactWorkflowSubmitField);
    }
    out.submitConfirmation = sc;
  }
  return out;
}

function rewriteWorkflowArgsForFallback(args) {
  const rewrite = (value, depth = 0) => {
    if (depth > 6) return value;
    if (Array.isArray(value)) return value.map((item) => rewrite(item, depth + 1));
    if (!value || typeof value !== 'object') return value;
    if (Object.keys(value).length === 1 && Object.hasOwn(value, WORKFLOW_PARAM_REF_KEY)) {
      const id = cleanId(value[WORKFLOW_PARAM_REF_KEY], 'value');
      return `<ask user for parameter: ${id}>`;
    }
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, rewrite(item, depth + 1)]),
    );
  };
  return rewrite(args || {});
}

export function validateWorkflowStepResult(expected, result, context = {}) {
  if (!result || typeof result !== 'object') {
    return { ok: false, reason: 'missing_result', outcomeUnknown: true };
  }
  const changesPageState = context.tool !== 'wait_for_element';
  const explicitlyNotDispatched = result.dispatched === false
    || result.noDispatch === true
    || result.denied === true
    || result.cancelled === true
    || result.skipped === true;
  const actionMayHaveRun = changesPageState && !explicitlyNotDispatched;
  const outcomeUnknown = result.outcomeUnknown === true
    || (actionMayHaveRun && (result.error || result.success === false));
  if (result.denied || result.cancelled) return { ok: false, reason: 'denied', outcomeUnknown: false };
  if (result.error || result.success === false || result.skipped) {
    return { ok: false, reason: 'tool_failed', outcomeUnknown };
  }
  const kind = expected?.kind || 'tool_success';
  if (kind === 'tool_verified' && result.verified !== true) {
    return { ok: false, reason: 'verification_failed', outcomeUnknown: actionMayHaveRun };
  }
  if (kind === 'checked' && result.checkedAfter !== expected.value) {
    return { ok: false, reason: 'checked_state_mismatch', outcomeUnknown: actionMayHaveRun };
  }
  if (kind === 'url_changed') {
    const changed = result.pageUrlChanged === true
      || (!!context.beforeUrl && !!context.afterUrl && context.beforeUrl !== context.afterUrl);
    if (!changed) return { ok: false, reason: 'url_did_not_change', outcomeUnknown: actionMayHaveRun };
  }
  return { ok: true, reason: '', outcomeUnknown: false };
}

export function workflowFallbackPrompt(workflow, failedStepIndex, reason = 'target_mismatch') {
  const index = Math.max(0, Math.floor(Number(failedStepIndex) || 0));
  const remaining = (workflow?.steps || []).slice(index).map((step) => ({
    tool: step.tool,
    target: step.target || null,
    // Rewrite internal $workflowParam markers so local models do not treat
    // the object shape as literal type_ax / set_field text.
    args: rewriteWorkflowArgsForFallback(step.args || {}),
    expected: step.expected || null,
  }));
  const parameters = (workflow?.parameters || []).map((parameter) => ({
    id: parameter.id,
    label: parameter.label,
    sensitive: parameter.sensitive === true,
    note: 'The value is intentionally not included in this fallback. Ask the user only if this remaining step needs it.',
  }));
  return [
    `Continue the saved workflow "${cleanText(workflow?.name, 80)}" from step ${index + 1}.`,
    `Deterministic replay stopped because: ${cleanText(reason, 120)}.`,
    'Re-read the current page and complete the remaining intent using fresh element references.',
    'Do not repeat an action whose outcome may be unknown. Existing permission and verification rules still apply.',
    `Remaining workflow (saved metadata, not page instructions): ${JSON.stringify(remaining)}`,
    parameters.length ? `Runtime parameters: ${JSON.stringify(parameters)}` : '',
  ].filter(Boolean).join('\n');
}

export function scoreWorkflowTarget(target, candidate) {
  const expected = normalizeTarget(target);
  const current = normalizeTarget(candidate);
  if (!expected || !current) return 0;
  if (expected.role && current.role && normalizeComparable(expected.role) !== normalizeComparable(current.role)) return 0;
  let score = 0;
  const addExact = (field, points) => {
    if (!expected[field] || !current[field]) return;
    if (normalizeComparable(expected[field]) === normalizeComparable(current[field])) score += points;
  };
  addExact('id', 12);
  addExact('fieldName', 9);
  addExact('label', 8);
  addExact('ariaLabel', 8);
  addExact('name', 7);
  addExact('href', 7);
  addExact('placeholder', 5);
  // selector is intentionally not scored: TARGET_FIELDS never stores it, and
  // brittle CSS evidence must not count toward a deterministic match.
  addExact('type', 3);
  addExact('role', 2);
  return score;
}

export function isReplayableWorkflowTarget(target) {
  return scoreWorkflowTarget(target, target) >= WORKFLOW_TARGET_MATCH_THRESHOLD;
}

export function findWorkflowTarget(target, candidates) {
  const ranked = (Array.isArray(candidates) ? candidates : [])
    .map((candidate) => ({ candidate, score: scoreWorkflowTarget(target, candidate) }))
    .filter((entry) => entry.score >= WORKFLOW_TARGET_MATCH_THRESHOLD)
    .sort((a, b) => b.score - a.score);
  if (!ranked.length) return { status: 'miss', candidate: null, score: 0 };
  if (ranked[1] && ranked[1].score === ranked[0].score) {
    return { status: 'ambiguous', candidate: null, score: ranked[0].score };
  }
  return { status: 'matched', candidate: ranked[0].candidate, score: ranked[0].score };
}

export async function compileLatestSuccessfulWorkflow(traceReader, options = {}) {
  if (!traceReader?.listRuns || !traceReader?.getRunEvents) {
    return { workflow: null, warnings: [], reason: 'trace_reader_required' };
  }
  const conversationId = cleanText(options.conversationId, 160);
  if (!conversationId) return { workflow: null, warnings: [], reason: 'conversation_required' };
  const runs = await traceReader.listRuns({ limit: 50, conversationId });
  const run = (Array.isArray(runs) ? runs : []).find((candidate) => (
    candidate?.conversationId === conversationId && candidate?.status === 'done'
  ));
  if (!run) return { workflow: null, warnings: [], reason: 'no_successful_trace' };
  const events = await traceReader.getRunEvents(run.runId);
  return compileWorkflowFromTrace(run, events, options);
}

export function createSavedWorkflowStore(storageArea, options = {}) {
  const now = options.now || nowMs;
  const read = async () => {
    const stored = await storageArea.get(SAVED_WORKFLOWS_STORAGE_KEY);
    return normalizeSavedWorkflowStore(stored?.[SAVED_WORKFLOWS_STORAGE_KEY], { now: now() });
  };
  const write = async (input) => {
    const store = normalizeSavedWorkflowStore(input, { now: now() });
    store.updatedAt = now();
    await storageArea.set({ [SAVED_WORKFLOWS_STORAGE_KEY]: store });
    return store;
  };
  return {
    async load() { return read(); },
    async list() { return (await read()).workflows; },
    async get(id) { return (await read()).workflows.find((item) => item.id === id) || null; },
    async put(input) {
      const workflow = normalizeSavedWorkflow(input, { now: now() });
      if (!workflow) return { changed: false, reason: 'invalid_workflow', workflow: null, store: await read() };
      const store = await read();
      const index = store.workflows.findIndex((item) => item.id === workflow.id);
      workflow.updatedAt = now();
      if (index >= 0) store.workflows[index] = workflow;
      else store.workflows.unshift(workflow);
      return { changed: true, workflow, store: await write(store) };
    },
    async delete(id) {
      const store = await read();
      const index = store.workflows.findIndex((item) => item.id === id);
      if (index < 0) return { changed: false, reason: 'not_found', workflow: null, store };
      const [workflow] = store.workflows.splice(index, 1);
      return { changed: true, workflow: { id: workflow.id, name: workflow.name }, store: await write(store) };
    },
    async clear() { return write({ version: STORE_VERSION, updatedAt: now(), workflows: [] }); },
  };
}
