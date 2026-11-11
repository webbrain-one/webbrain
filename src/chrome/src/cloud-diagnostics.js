// Public diagnostics contain only bounded categories, never page text or model prose.
export const diagnosticMessages = Object.freeze({
  timeout: 'The browser operation timed out.',
  network_error: 'The destination could not be reached.',
  connection_lost: 'The browser connection or tab became unavailable.',
  access_denied: 'The destination denied access.',
  not_found: 'The requested page or element was not found.',
  invalid_arguments: 'The tool received invalid or missing arguments.',
  permission_required: 'The action needs permission or user input.',
  repeated_read_failure: 'Repeated reads of the same resource failed. The run stopped.',
  loop_stopped: 'The run stopped after repeated actions made no progress.',
  tool_failed: 'The browser operation failed.',
});
export function diagnosticFailure(value) {
  const text = String(value || '').slice(0, 4000);
  if (/failed three times.*(?:resource|read)|same read-only resource/i.test(text)) return 'repeated_read_failure';
  if (/loop[_ ]stopped|loop detected/i.test(text)) return 'loop_stopped';
  if (/timed?\s*out|timeout|ERR_TIMED_OUT/i.test(text)) return 'timeout';
  if (/disconnected|connection (?:closed|lost)|no tab|tab.*(?:closed|not found)|receiving end does not exist/i.test(text)) return 'connection_lost';
  if (/ERR_NAME_NOT_RESOLVED|ERR_CONNECTION|fetch failed|failed to fetch|network|DNS/i.test(text)) return 'network_error';
  if (/403|401|forbidden|unauthorized|access denied/i.test(text)) return 'access_denied';
  if (/404|not found|no matching|could not find/i.test(text)) return 'not_found';
  if (/invalid.*(?:argument|parameter)|missing.*(?:argument|parameter|required)|required.*(?:argument|parameter)/i.test(text)) return 'invalid_arguments';
  if (/permission|approval|denied|requires.*allow-api/i.test(text)) return 'permission_required';
  return 'tool_failed';
}
export function toolDiagnostic(result) {
  const r = result && typeof result === 'object' ? result : {};
  const status = Number.isInteger(r.status) && r.status >= 100 && r.status <= 599 ? r.status : undefined;
  const blocked = r.denied === true || r.blocked === true;
  const failed = r.success === false || r.isError === true || !!r.error || (status >= 400);
  return {
    version: 1,
    outcome: blocked ? 'blocked' : failed ? 'failed' : r.success === true ? 'succeeded' : 'unknown',
    ...(status ? { httpStatus: status } : {}),
    ...(blocked || failed ? { failureKind: diagnosticFailure(r.error || (blocked ? 'permission denied' : status)) } : {}),
  };
}
