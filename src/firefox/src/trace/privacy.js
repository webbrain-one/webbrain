import { normalizeRejectedToolResponse } from '../agent/model-output-diagnostics.js';
import { SEMANTIC_QUESTIONS, SEMANTIC_REPLY_FAILURES } from '../agent/semantic-decisions.js';

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

const STEP_METADATA_FIELDS = ['step', 'ok', 'status', 'code', 'durationMs', 'reason', 'handoffOutcome', 'outputLimited'];

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
const ACTION_PREDICATES = new Set(['target_changed', 'target_unresolved', 'target_ambiguous', 'target_uncovered', 'focus_changed',
  'intervention_changed', 'model_snapshot_invalid', 'model_snapshot_expired', 'pending_feedback',
  'target_hidden', 'target_disabled', 'target_detached', 'parent_changed', 'form_changed',
  'relaxed_grant_expired', 'relaxed_target_changed', 'target_not_actionable', 'semantic_binding_changed',
  'target_hit_changed']);

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

// Where one tool call spent its time before dispatch: the pipeline's stages
// in milliseconds, the tool's name and the call's outcome, never what the
// page or the model said.
const PREDISPATCH_TIMING_MS_FIELDS = [
  'argumentsMs', 'workflowAdoptMs', 'captchaGateMs', 'preparationMs', 'clarificationMs', 'submitPreflightMs',
  'submitProbeMs', 'submitCaptionReadingMs', 'resultBaselineMs', 'validationSnapshotMs',
  'workflowPreSubmitMs', 'resourceMutationMs', 'githubTransitionMs', 'workflowDispatchMs',
  'publicationContractMs', 'publicationAuditMs', 'publicationAuditReusedMs', 'publicationAuditAwaitedMs',
  'publicationRereadMs', 'submitDetectionMs', 'submitConfirmationMs', 'permissionMs', 'completionChecksMs',
  'recipientGuardMs', 'recipientReadingMs', 'checkpointMs', 'pipelineWaitMs', 'toolbarPreflightMs',
  'pipelinePublicationMs', 'feedbackRecheckMs', 'genericChatMs', 'attemptCheckpointMs',
  'dispatchPreparationMs', 'unverifiedStepCardMs', 'preDispatchMs', 'executeToolMs', 'stoppedMs', 'totalMs',
];
function projectPredispatchTiming(data) {
  const extra = {};
  for (const key of PREDISPATCH_TIMING_MS_FIELDS) {
    const value = data?.extra?.[key];
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) extra[key] = Math.min(value, 600_000);
  }
  const tool = data?.extra?.tool;
  if (typeof tool === 'string' && /^[a-z][a-z0-9_]{0,63}$/.test(tool)) extra.tool = tool;
  const outcome = data?.extra?.outcome;
  if (['dispatched', 'not_dispatched', 'blocked'].includes(outcome)) extra.outcome = outcome;
  return { step: Number.isFinite(data?.step) ? data.step : 0, note: 'predispatch_timing', extra };
}

// Auto mode's `run_mode` answers (agent/auto-mode.js runModeDecisionNote):
// closed codes, bounded numbers and model ids in every trace, so a refused
// hand-off shows which model answered what and why it did not count. The
// Only parsed structure is kept; reply prose may contain user data.
const RUN_MODE_CHOICES = Object.keys(SEMANTIC_QUESTIONS.run_mode.choices);
const RUN_MODE_DECISION_ENUMS = {
  purpose: ['route', 'escalation'],
  choice: RUN_MODE_CHOICES,
  plan: Object.keys(SEMANTIC_QUESTIONS.plan_need.choices),
  source: ['decision_model', 'main_model', 'cache', 'unavailable'],
  answeredBy: ['decision_model', 'main_model'],
  decisionModel: ['off', 'context_budget', 'unsure', 'not_settled', 'answered', 'failed'],
  decisionModelChoice: RUN_MODE_CHOICES,
  mainModel: ['not_asked', 'answered', 'rejected', 'failed'],
  format: ['json', 'prose_wrapped'],
  requested: ['act', 'dev'],
  outcome: ['accepted', 'not_action', 'superseded'],
  failure: [...SEMANTIC_REPLY_FAILURES, 'output_limit', 'reasoning_only', 'content_filter', 'provider_empty',
    'truncated_response', 'not_object', 'choice_not_listed', 'evidence_not_quoted', 'timeout', 'request_failed'],
  decisionModelFailure: ['invalid_response_json', 'invalid_usage', 'unexpected_model', 'invalid_answer_map',
    'invalid_answer_type', 'invalid_probability', 'invalid_distribution', 'invalid_choice', 'invalid_score',
    'model_loading', 'model_not_loaded', 'cancelled', 'state_too_long', 'authentication', 'rate_limit',
    'service_overloaded', 'service_error', 'timeout', 'service_unavailable'],
};
const RUN_MODE_DECISION_NUMBERS = { rawChars: 1_000_000, latencyMs: 600_000, decisionModelConfidence: 1 };
const MODEL_ID = /^[a-zA-Z0-9_.:-]{1,120}$/;

function projectRunModeDecision(data, includeContent) {
  const source = data?.extra && typeof data.extra === 'object' && !Array.isArray(data.extra) ? data.extra : {};
  const extra = {};
  for (const [key, allowed] of Object.entries(RUN_MODE_DECISION_ENUMS)) {
    if (allowed.includes(source[key])) extra[key] = source[key];
  }
  // A choice that is not there is part of the reading: the answer was null.
  if (source.choice === null) extra.choice = null;
  for (const [key, max] of Object.entries(RUN_MODE_DECISION_NUMBERS)) {
    const value = source[key];
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) extra[key] = Math.min(value, max);
  }
  if (typeof source.model === 'string' && MODEL_ID.test(source.model)) extra.model = source.model;
  return { step: Number.isFinite(data?.step) ? data.step : 0, note: 'run_mode_decision', extra };
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

// Vision mode's notes (agent/vision-runtime.js _visionTraceNote). Metadata
// traces keep their codes from closed lists and their bounded numbers, never
// an error text, a region or a page size string: a capture failure must read
// as one, not as the generic note stage 'model'.
const VISION_NOTES = new Set([
  'vision_frame', 'vision_frame_error', 'vision_tool_error', 'vision_upload_handoff',
  'vision_redaction_skipped', 'vision_capture_retry', 'vision_layout_changed',
]);
const VISION_NOTE_ENUMS = {
  kind: ['keyframe', 'patch', 'none', 'zoom'],
  stage: ['start', 'observe', 'encode', 'resume', 'armed', 'ended', 'refused'],
  reason: ['start of turn', 'requested', 'page changed', 'layout changed', 'first frame', 'vision resumed',
    'forced', 'not comparable', 'no visible change', 'patch chain limit', 'large change', 'patch cost', 'local change',
    'page_changed', 'scrolled', 'uploaded', 'navigated', 'expired', 'unreachable', 'no_source', 'exhausted'],
  code: ['decode_failed', 'scan_unavailable', 'pixelate_failed', 'error', 'transient'],
  context: ['keyframe', 'patch', 'zoom'],
  tool: ['take_screenshot', 'zoom', 'scroll_at', 'hover_at', 'drag_at', 'wait', 'click_at'],
  mimeType: ['image/webp', 'image/jpeg', 'image/png'],
};
const VISION_NOTE_NUMBERS = {
  width: 20_000, height: 20_000, cssWidth: 20_000, cssHeight: 20_000, captureWidth: 40_000, captureHeight: 40_000,
  devicePixelRatio: 8, bytes: 50_000_000, estimatedTokens: 1_000_000, frameTokens: 1_000_000, changedRatio: 1,
  count: 100, attempt: 100,
};
const VISION_IMAGE_ID = /^[fpz]\d{1,7}$/;

function projectVisionNote(data) {
  const source = data?.extra && typeof data.extra === 'object' && !Array.isArray(data.extra) ? data.extra : {};
  const extra = {};
  for (const [key, allowed] of Object.entries(VISION_NOTE_ENUMS)) {
    if (allowed.includes(source[key])) extra[key] = source[key];
  }
  for (const [key, max] of Object.entries(VISION_NOTE_NUMBERS)) {
    const value = source[key];
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) extra[key] = Math.min(value, max);
  }
  for (const key of ['id', 'keyframe', 'frame']) {
    if (typeof source[key] === 'string' && VISION_IMAGE_ID.test(source[key])) extra[key] = source[key];
  }
  if (Array.isArray(source.ids)) {
    const ids = source.ids.filter(id => typeof id === 'string' && VISION_IMAGE_ID.test(id)).slice(0, 16);
    if (ids.length) extra.ids = ids;
  }
  if (typeof source.dispatched === 'boolean') extra.dispatched = source.dispatched;
  if (typeof source.profile === 'string' && /^[a-z0-9_-]{1,32}$/i.test(source.profile)) extra.profile = source.profile;
  return {
    step: Number.isFinite(data?.step) ? data.step : 0,
    note: data.note,
    ...(Object.keys(extra).length ? { extra } : {}),
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
    for (const key of ['latencyMs', 'estimatedCostUsd', 'captureMs', 'evaluateMs', 'elapsedMs', 'timeoutMs']) {
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
  if (kind === 'note' && data?.note === 'run_mode_decision') {
    return projectRunModeDecision(data, includeContent);
  }
  if (kind === 'note' && data?.note === 'done_timing') {
    return projectDoneTiming(data);
  }
  if (kind === 'note' && data?.note === 'predispatch_timing') {
    return projectPredispatchTiming(data);
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
  if (kind === 'note' && VISION_NOTES.has(source.note)) return projectVisionNote(source);
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
