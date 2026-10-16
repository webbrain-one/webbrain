import { normalizeRejectedToolResponse } from '../agent/model-output-diagnostics.js';

/**
 * Privacy projection for durable trace records.
 *
 * The default trace tier is metadata-only. Keep the policy at the recorder
 * boundary so IndexedDB, the Traces UI, JSON exports, and OTLP exports all
 * start from the same safe event log. The lossless tier is an explicit opt-in
 * and intentionally bypasses these projections.
 */

const RUN_CONTENT_FIELDS = [
  'userMessage', 'finalContent', 'tabUrl', 'tabTitle', 'attachments',
];

const RESPONSE_METADATA_FIELDS = [
  'step', 'usage', 'latencyMs', 'model', 'phase', 'attempt', 'repair', 'empty',
  'finishReason', 'contentChars', 'toolCallCount', 'reasoningPresent',
  'reasoningChars', 'reasoningTokens', 'outputTokens', 'requestedMaxTokens',
  'recoveryAttempt', 'emptyReason', 'validationFailure', 'candidateAttempt',
];

const REQUEST_METADATA_FIELDS = [
  'step', 'providerClass', 'providerId', 'model', 'phase', 'attempt', 'repair',
  'messageCount', 'toolsCount', 'imageBlockCount', 'documentBlockCount',
  'runtimeMode', 'requestedMaxTokens',
];

const STREAMING_METADATA_FIELDS = [
  'step', 'status', 'protocol', 'reason', 'errorCode', 'textDeltaCount',
  'textChars', 'firstDeltaMs', 'durationMs', 'toolCallCount',
];

const STEP_METADATA_FIELDS = ['step', 'ok', 'status', 'code', 'durationMs', 'reason', 'handoffOutcome'];

const NOTE_METADATA_FIELDS = [
  'attempt', 'delayMs', 'code', 'status', 'progress', 'loaded', 'total',
  'context', 'visionRoute', 'phase', 'failureKind', 'reason', 'queryCount',
  'matchCount', 'multiSource', 'attempted', 'archiveDates', 'durationMs',
  'success', 'approved', 'outcome', 'verification', 'count',
  'adapter', 'revision', 'notesInjected', 'workflowSchema', 'job', 'template',
  'validationFailure', 'candidateAttempt', 'stage', 'retryMode',
  'certificationFailure', 'monitoringRelaxed', 'predicate', 'targetCount', 'focusedTargetAvailable', 'captureMs',
];

// Checker diagnostics are finite protocol labels, never arbitrary model text
// or JSON property names. A malformed reply can contain private source text in
// a duplicate field name, so metadata-only traces must normalize it here.
const VALIDATION_FAILURE_CODES = new Set([
  'empty_response', 'invalid_json', 'binding_mismatch', 'invalid_aligned',
  'invalid_reason', 'unexpected_fields', 'reasoning_only', 'output_limit',
  'provider_empty', 'content_filter', 'truncated_response', 'request_failed',
  'invalid_replacement_plan', 'malformed_or_multiple_json_objects',
  'response_not_object', 'key_mismatch', 'action_mismatch',
  'authorized_not_boolean', 'reason_not_string', 'invalid_response',
  ...['key', 'actionId', 'authorized', 'reason'].map(field => 'missing_' + field),
  ...['key', 'actionId', 'authorized', 'reason', 'version', 'status', 'actions',
    'requirements', 'prohibited', 'extra_field'].map(field => 'duplicate_' + field),
]);
const PUBLICATION_CONTRACT_FAILURES = new Set([
  'object fields', 'list bounds', 'enum', 'source reference', 'anchor occurrence',
  'missing start occurrence', 'missing end occurrence', 'ambiguous start anchor',
  'ambiguous end anchor', 'anchor order', 'text exceeds supported payload size',
  'media nesting', 'media count', 'media constraint', 'version/reason',
  'duplicate prohibition', 'action id', 'prohibited destination',
  'empty body source', 'post context', 'duplicate action id',
  'requirement nesting', 'unknown or repeated action reference', 'incomplete requirements',
]);
const PUBLICATION_CONTRACT_CODES = new Set([...PUBLICATION_CONTRACT_FAILURES]
  .map(detail => 'contract_' + detail.replace(/[^a-z0-9]+/g, '_')));
const EMPTY_OUTPUT_REASONS = new Set(['output_limit', 'reasoning_only', 'content_filter', 'provider_empty']);
const RECOVERY_STAGES = new Set([
  'model', 'inference', 'planning', 'plan_alignment', 'publication_audit',
  'completion_verification', 'verification', 'action_preparation',
  'response_generation', 'browser_interaction',
]);
const RECOVERY_RETRY_MODES = new Set(['resume', 'publication_without_audit', 'publication_audit_bypass', 'action_monitoring_relaxed']);
const CERTIFICATION_FAILURES = new Set(['owner_unresolved', 'identity_unobserved', 'capture_limit', 'identity_limit',
  'target_uncovered', 'context_uncertified']);
const ACTION_PREDICATES = new Set(['target_changed', 'target_unresolved', 'target_uncovered', 'focus_changed',
  'intervention_changed', 'model_snapshot_invalid', 'model_snapshot_expired', 'pending_feedback',
  'target_hidden', 'target_disabled', 'target_detached', 'parent_changed', 'form_changed',
  'relaxed_grant_expired', 'relaxed_target_changed', 'target_not_actionable']);

function validationFailureMetadata(value) {
  if (VALIDATION_FAILURE_CODES.has(value) || PUBLICATION_CONTRACT_CODES.has(value)) return value;
  const prefix = 'Invalid publication contract: ';
  const detail = typeof value === 'string' && value.startsWith(prefix) ? value.slice(prefix.length) : '';
  return PUBLICATION_CONTRACT_FAILURES.has(detail)
    ? 'contract_' + detail.replace(/[^a-z0-9]+/g, '_')
    : 'invalid_response';
}

const CLICK_AX_TIMING_MS_FIELDS = [
  'preflightMs', 'syntheticDispatchMs', 'syntheticResponseMs',
  'postClickObservationMs', 'fallbackPreparationMs', 'fallbackDispatchMs',
  'trustedObservationMs', 'clickPathMs',
];

// Where a completion check spent its time: numbers and the verdict's own
// enums only, never what the page or the model said.
const DONE_TIMING_MS_FIELDS = ['preparationMs', 'readingMs', 'verificationMs'];
function projectDoneTiming(data) {
  const extra = {};
  for (const key of DONE_TIMING_MS_FIELDS) {
    const value = data?.extra?.[key];
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) extra[key] = Math.min(value, 600_000);
  }
  const outcome = data?.extra?.outcome;
  if (['succeeded', 'pending', 'failed', 'uncertain'].includes(outcome)) extra.outcome = outcome;
  const engine = data?.extra?.engine;
  if (typeof engine === 'string' && /^[a-zA-Z0-9_.-]{1,120}$/.test(engine)) extra.engine = engine;
  return { step: Number.isFinite(data?.step) ? data.step : 0, note: 'done_timing', extra };
}

function projectClickAxTiming(data) {
  const extra = {};
  for (const key of CLICK_AX_TIMING_MS_FIELDS) {
    const value = data?.extra?.[key];
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
      extra[key] = Math.min(value, 120_000);
    }
  }
  const trustedInputEvents = data?.extra?.trustedInputEvents;
  if (Number.isSafeInteger(trustedInputEvents) && trustedInputEvents >= 0) {
    extra.trustedInputEvents = Math.min(trustedInputEvents, 16);
  }
  for (const key of ['syntheticDispatched', 'trustedFallbackAttempted', 'outcomeUnknown', 'safetyVeto', 'duplicateFallbackBlocked']) {
    if (typeof data?.extra?.[key] === 'boolean') extra[key] = data.extra[key];
  }
  const outcome = data?.extra?.outcome;
  if (['verified', 'inconclusive', 'no_progress', 'failed', 'pre_dispatch', 'unknown'].includes(outcome)) {
    extra.outcome = outcome;
  }
  return {
    step: Number.isFinite(data?.step) ? data.step : 0,
    note: 'click_ax_timing',
    extra,
  };
}

function pick(source, fields) {
  if (!source || typeof source !== 'object' || Array.isArray(source)) return {};
  const output = {};
  for (const field of fields) {
    if (source[field] !== undefined) output[field] = source[field];
  }
  return output;
}

function projectUsage(usage) {
  return pick(usage, [
    'prompt_tokens', 'completion_tokens', 'input_tokens', 'output_tokens',
    'cached_tokens', 'prompt_cache_hit_tokens', 'cost',
  ]);
}

function projectPromptProvenance(value) {
  return pick(value, [
    'systemPromptVariant', 'promptPolicyRevision', 'systemPromptChars',
    'messageChars', 'toolPolicyRevision', 'runtimeEnvelopeMode',
    'runtimeEnvelopeRequired', 'runtimeEnvelopeMatches',
    'systemPromptMatchesRuntime',
  ]);
}

function projectNoteExtra(value) {
  const output = pick(value, NOTE_METADATA_FIELDS);
  if (Object.hasOwn(output, 'validationFailure')) {
    output.validationFailure = validationFailureMetadata(output.validationFailure);
  }
  if (Object.hasOwn(output, 'stage')) output.stage = RECOVERY_STAGES.has(output.stage) ? output.stage : 'model';
  if (Object.hasOwn(output, 'retryMode')) {
    output.retryMode = RECOVERY_RETRY_MODES.has(output.retryMode) ? output.retryMode : 'resume';
  }
  if (Object.hasOwn(output, 'certificationFailure') && !CERTIFICATION_FAILURES.has(output.certificationFailure)) delete output.certificationFailure;
  if (Object.hasOwn(output, 'predicate') && !ACTION_PREDICATES.has(output.predicate)) delete output.predicate;
  for (const key of ['monitoringRelaxed', 'focusedTargetAvailable']) {
    if (Object.hasOwn(output, key) && typeof output[key] !== 'boolean') delete output[key];
  }
  for (const key of ['targetCount', 'captureMs']) {
    if (Object.hasOwn(output, key)) {
      if (typeof output[key] !== 'number' || !Number.isFinite(output[key]) || output[key] < 0) delete output[key];
      else output[key] = Math.min(key === 'targetCount' ? 512 : 120000, output[key]);
    }
  }
  if (Object.hasOwn(output, 'candidateAttempt') && !Number.isSafeInteger(output.candidateAttempt)) {
    delete output.candidateAttempt;
  }
  if (Array.isArray(output.archiveDates)) {
    output.archiveDates = output.archiveDates.slice(0, 3).map(item => String(item).slice(0, 20));
  }
  return output;
}

function projectToolResultMetadata(result) {
  if (result == null) return { resultStatus: 'unknown' };
  const failed = typeof result === 'object'
    && (result.success === false || Boolean(result.error));
  const output = { resultStatus: failed ? 'error' : 'success' };
  const errorCode = result && typeof result === 'object'
    ? (result.errorCode || result.code)
    : '';
  if (failed && errorCode != null && String(errorCode).trim()) {
    output.resultErrorCode = String(errorCode).trim().slice(0, 120);
  }
  return output;
}

export function projectTraceRun(run, { includeContent = false } = {}) {
  const projected = run && typeof run === 'object' ? { ...run } : {};
  if (!includeContent) {
    for (const field of RUN_CONTENT_FIELDS) delete projected[field];
  }
  return projected;
}

export function projectTraceEventData(kind, data, { includeContent = false } = {}) {
  if (kind === 'llm_response' && data?.rejectedToolResponse) {
    data = { ...data, rejectedToolResponse: normalizeRejectedToolResponse(data.rejectedToolResponse) };
  }
  // Auxiliary decisions never retain evidence, even in the opt-in content tier.
  if (kind === 'note' && data?.note === 'system_one') {
    const extra = {};
    for (const key of ['decision', 'reason', 'model', 'phase', 'engine', 'modality', 'outcome']) {
      const value = data.extra?.[key];
      if (typeof value === 'string' && /^[a-zA-Z0-9_.-]{1,120}$/.test(value)) extra[key] = value;
    }
    for (const key of ['latencyMs', 'estimatedCostUsd', 'captureMs', 'evaluateMs', 'elapsedMs']) {
      const value = data.extra?.[key];
      if (typeof value === 'number' && Number.isFinite(value) && value >= 0) extra[key] = value;
    }
    const usage = projectUsage(data.extra?.usage);
    for (const key of Object.keys(usage)) {
      if (typeof usage[key] !== 'number' || !Number.isFinite(usage[key]) || usage[key] < 0) delete usage[key];
    }
    if (Object.keys(usage).length) extra.usage = usage;
    return { step: Number.isFinite(data.step) ? data.step : 0, note: 'system_one', extra };
  }
  if (kind === 'note' && data?.note === 'click_ax_timing') {
    return projectClickAxTiming(data);
  }
  if (kind === 'note' && data?.note === 'done_timing') {
    return projectDoneTiming(data);
  }
  if (includeContent || data == null) return data;
  const source = data && typeof data === 'object' && !Array.isArray(data) ? data : {};

  if (kind === 'llm_request') {
    const projected = pick(source, REQUEST_METADATA_FIELDS);
    if (Object.hasOwn(projected, 'requestedMaxTokens')
        && (!Number.isSafeInteger(projected.requestedMaxTokens) || projected.requestedMaxTokens < 1)) {
      delete projected.requestedMaxTokens;
    }
    if (source.promptProvenance && typeof source.promptProvenance === 'object') {
      projected.promptProvenance = projectPromptProvenance(source.promptProvenance);
    }
    if (source.localWikipediaRag && typeof source.localWikipediaRag === 'object') {
      projected.localWikipediaRag = pick(source.localWikipediaRag, [
        'status', 'attempted', 'matchCount', 'multiSource', 'archiveDates',
      ]);
    }
    return projected;
  }

  if (kind === 'llm_response') {
    const projected = pick(source, RESPONSE_METADATA_FIELDS);
    if (Object.hasOwn(projected, 'requestedMaxTokens')
        && (!Number.isSafeInteger(projected.requestedMaxTokens) || projected.requestedMaxTokens < 1)) {
      delete projected.requestedMaxTokens;
    }
    if (Object.hasOwn(projected, 'emptyReason') && !EMPTY_OUTPUT_REASONS.has(projected.emptyReason)) {
      delete projected.emptyReason;
    }
    if (Object.hasOwn(projected, 'validationFailure')) {
      projected.validationFailure = validationFailureMetadata(projected.validationFailure);
    }
    if (Object.hasOwn(projected, 'candidateAttempt') && !Number.isSafeInteger(projected.candidateAttempt)) {
      delete projected.candidateAttempt;
    }
    if (source.rejectedToolResponse) projected.rejectedToolResponse = source.rejectedToolResponse;
    if (source.usage && typeof source.usage === 'object') projected.usage = projectUsage(source.usage);
    return projected;
  }

  if (kind === 'tool') {
    return {
      ...pick(source, ['step', 'name', 'latencyMs']),
      ...(source.batch && typeof source.batch.parentId === 'string'
        && /^[a-zA-Z0-9_-]{1,200}$/.test(source.batch.parentId)
        && Number.isInteger(source.batch.index) && source.batch.index >= 0
        && Number.isInteger(source.batch.total) && source.batch.total > source.batch.index && source.batch.total <= 10
        ? { batch: pick(source.batch, ['parentId', 'index', 'total']) } : {}),
      ...projectToolResultMetadata(source.result),
    };
  }
  if (kind === 'error') return pick(source, ['step', 'phase', 'code']);
  if (kind === 'streaming') return pick(source, STREAMING_METADATA_FIELDS);
  if (kind === 'note') {
    const projected = pick(source, ['step', 'note']);
    const extra = projectNoteExtra(source.extra);
    if (Object.keys(extra).length) projected.extra = extra;
    return projected;
  }
  if (kind === 'screenshot') return pick(source, ['step', 'caption']);
  if (kind === 'vision_sub_call') {
    return pick(source, [
      'step', 'context', 'visionRoute', 'captureId', 'fallbackReason', 'model',
      'baseUrl', 'latencyMs', 'errorCode', 'recoveryOutcome',
    ]);
  }
  if (kind === 'vision_route') {
    return pick(source, ['step', 'context', 'visionRoute', 'captureId', 'model', 'fallbackReason']);
  }
  if (kind === 'turn_start' || kind === 'turn_end' || kind === 'step_start' || kind === 'step_end') {
    return pick(source, STEP_METADATA_FIELDS);
  }
  if (kind === 'terminal_runtime') {
    return pick(source, ['step', 'status', 'toolName', 'callId', 'errorCode', 'durationMs', 'success']);
  }
  return {};
}
