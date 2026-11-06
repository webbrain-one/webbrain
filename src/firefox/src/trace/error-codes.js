/**
 * Trace error codes — the stable vocabulary for structured `error` events and
 * `turn_end` failure reasons in the trace event log.
 *
 * Pure and browser-neutral so it can be unit-tested in test/run.js without a
 * DOM or IndexedDB.
 *
 * Before this module, trace failures carried only a formatted message; the
 * Traces UI and exporters had no stable signal to route on. Codes here are
 * used ONLY at trace call sites (recording which failure class occurred) —
 * agent behavior must never route on them, and providers keep their own
 * error semantics. `normalizeErrorCode` guarantees the stored value is always
 * one of the catalog entries, so a caller can never smuggle an arbitrary
 * string into a trace payload.
 */

export const ERROR_CODES = Object.freeze([
  'QUOTA',
  'RATE_LIMIT',
  'CONTEXT_WINDOW_EXCEEDED',
  'EMPTY_RESPONSE',
  'OUTPUT_LIMIT',
  'INVALID_CREDENTIAL',
  'TRANSPORT',
  'TOOL_TIMEOUT',
  'COST_LIMIT',
  'SERVICE_WORKER_EVICTED',
  'UNKNOWN',
]);

const CODE_SET = new Set(ERROR_CODES);

export function isErrorCode(code) {
  return CODE_SET.has(code);
}

export function normalizeErrorCode(code) {
  if (isErrorCode(code)) return code;
  return 'UNKNOWN';
}
