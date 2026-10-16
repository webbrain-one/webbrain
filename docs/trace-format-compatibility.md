# Trace format compatibility

WebBrain's trace data has three independent version layers:

- `DB_VERSION` describes IndexedDB object-store structure and changes only when
  stores or indexes change.
- `traceFormatVersion` describes the meaning of a persisted run and its event
  log. New optional fields and new event kinds are additive and remain at the
  current version. Bump this value only when an existing meaning changes, a
  field becomes required, or `seq`/`ts` semantics change.
- `schema` describes the JSON export envelope. `webbrain-trace/1` remains the
  envelope for additive run and event changes. A new schema is reserved for a
  container-shape or semantic break.

## Reader obligations

Planner alignment and publication checks record their auxiliary model requests and responses, including `requestedMaxTokens`, `candidateAttempt`, finish/token diagnostics, and a finite `validationFailure` code. Technical repairs keep the candidate binding fixed and are distinct from a replacement plan after a valid semantic rejection. Metadata-only traces retain those diagnostics without prompts, replies, arbitrary JSON property names, or checker explanations; content-enabled traces follow the existing recording policy.

Recoverable failures may include a `failure_recovery_offered` note with the failed stage and retry mode. Chat controls use an opaque runtime recovery ID bound to the exact task and conversation. Starting another run, changing the task, stopping, or choosing Give up expires the offer. Model, response-generation and interaction failures resume through normal continuation checks. For `action_context_unverified`, `action_monitoring_relaxed` identifies one explicitly accepted Retry run on the same task and document; publication Retry remains the separately bound, one-use audit exemption described in the publication contract. Metadata-only `page_action_validation` notes include a finite `certificationFailure` or dispatch `predicate` and a `monitoringRelaxed` boolean. Private grant tokens and target/page content are excluded.

Tool events may include an optional `data.outcome` summary containing bounded dispatch, application, provider, error, and CAPTCHA-gate diagnostics. In lossless recordings, this summary survives the content-budget marker, while answer tokens, cookies, provider keys, and form inputs are excluded from the summary. Readers should still honor `_truncated` and `losslessBudgetOmitted`; the summary does not reconstruct discarded content.

`/export --traces --full` exports the stored conversation through the existing `webbrain-trace/1` session envelope, including stored screenshots. It adds no Markdown preview or turn-count truncation. Recording-time omissions and privacy projections remain explicit. The side panel reads the shared trace database and assembles the download locally; only the session identity crosses runtime messaging, so screenshot-heavy exports do not hit the browser message-size limit.

Treat a missing or malformed `traceFormatVersion` as the legacy baseline. Keep
missing optional fields harmless. Reject a numeric `traceFormatVersion` newer
than the latest version the reader supports instead of interpreting `seq` and
`ts` with older semantics. Readers must not fail an entire export because one
event kind is unknown:

- the Traces UI shows a labeled placeholder with the raw event view;
- machine-readable exporters preserve an unknown event as a generic record with
  its event kind;
- the Markdown summary may omit unknown event details, but reports the count.

Raw JSON re-export keeps the original fields. Compatibility handling does not
perform destructive migration and does not change the default privacy policy.

## Browser batch tool events

`browser_batch` records a parent tool event and ordinary events for the actions
it executes. Sub-call events may carry optional
`data.batch: {parentId, index, total}` metadata linking them to the original
model tool-call ID. `index` is the action's zero-based position within the batch;
`total` is the number of requested actions, including any later skipped ones.
The wrapper result summarizes completion or the stop reason; skipped actions
are reported as not run. Readers must tolerate absent `batch` metadata on old
events and ordinary tool calls, and preserve it when re-exporting JSON.

This is an additive field: no database, trace-format or export-envelope version
bump is required. Trace grouping does not change the provider transcript,
which contains one tool result per original batch call and keeps supplemental
images after the parent results.

## Session bundles

The existing single-run `webbrain-trace/1` shape remains valid. A session bundle
may carry a `session` identity and a `runs` array containing `{ run, events }`
entries. Session-aware consumers use persisted `conversationId`, `parentRunId`,
and `parentSessionId` values; they do not infer lineage from in-memory state.
