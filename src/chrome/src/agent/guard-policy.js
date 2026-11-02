// How WebBrain's own checks treat a model-requested action.
//
// A guard is WebBrain code (not the user) that refuses, defers or stops a
// tool call, a write, a submit or a completion. Every guard is registered
// here with a class and two behaviors:
//
// - onDecided: what it does when it KNOWS the action is wrong.
// - onCannotDecide: what it does when it cannot tell (evidence missing,
//   unreadable, stale or timed out).
//
// Only the short list of HARD classes may refuse an action outright: the
// wrong recipient, deleting data, money, credentials, and publishing
// something the user did not ask for. When a hard guard cannot decide it
// asks the user on WebBrain's own card where one exists ('ask'), and
// otherwise refuses ('block').
//
// Every other guard is 'quality' (verification, exact readback, evidence,
// completion checks): it tells the model about the problem instead of
// stopping it ('advise'), or asks the user when it cannot verify a
// consequential step such as a commit or a publish ('ask'). Settings →
// General → "Strict checks" restores blocking for every quality guard.
//
// permission_gate (the user's own permissions, modes and budgets),
// host_check (same-site, frame and task-authority boundaries, CAPTCHA and
// access walls, a human acting in the same tab), budget (loop and observation
// limits), infra (a call that cannot run as given) and user_control (Stop,
// corrections, cancelled cards) are not guards in this sense and keep their
// behavior.
//
// Rule for new guards (enforced by test/guard-policy.mjs): register the id
// here, declare onCannotDecide, and name a test of a legitimate task the
// guard must not block (mustNotBlock: 'test/file.mjs#exact test name').
// See docs/guards.md. Shared verbatim by the Chrome and Firefox builds.

export const HARD_GUARD_CLASSES = Object.freeze(['recipient', 'deletion', 'money', 'credentials', 'unrequested_publication']);
export const NON_GUARD_CLASSES = Object.freeze(['permission_gate', 'host_check', 'budget', 'infra', 'user_control']);
export const GUARD_CLASSES = Object.freeze([...HARD_GUARD_CLASSES, 'quality', ...NON_GUARD_CLASSES]);
export const GUARD_OUTCOMES = Object.freeze(['block', 'ask', 'advise']);

// Guards that existed when this registry was introduced. Each later guard
// must name a mustNotBlock test (see the header).
export const GRANDFATHERED_GUARD_COUNT = 158;

export const GUARDS = Object.freeze({
  "auto-progress-resume": { class: "quality", family: "completion", decides: "knows", onDecided: "advise", onCannotDecide: "advise",
    summary: "Two consecutive stalled outputs with unresolved progress rows schedule a resume (scheduler or cloud deferResume) instead of failing." },
  "bot-memory-uncertain-done": { class: "quality", family: "completion", decides: "no-evidence", onDecided: "advise", onCannotDecide: "advise",
    summary: "In a managed Cloud bot run, done(success)/done_json while a dispatched bot-memory action still has an uncertain outcome." },
  "completion-evidence-freshness": { class: "quality", family: "completion", decides: "no-evidence", onDecided: "advise", onCannotDecide: "advise",
    summary: "Completion evidence went stale while done was being verified: judged evidence or document identity changed, the pure-calculation receipt authority changed, the submitted iframe snapshot is missing or changed after a succeeded verdict, or calculation evidence captured at done start is no longer…" },
  "completion-failure-only-done": { class: "quality", family: "completion", decides: "no-evidence", onDecided: "advise", onCannotDecide: "advise",
    summary: "When a forced verification turn made no progress, or no observation tool is available, done is advertised with outcome enum partial/failed only; a done(success) is then rejected by schema validation." },
  "completion-page-warning": { class: "quality", family: "completion", decides: "mixed", onDecided: "advise", onCannotDecide: "advise",
    summary: "Structural page warnings at done(success): an open dialog, a recorded submit that failed validation, a task-relevant form still visible without a verified submit transition, or a create/edit route without success; refused at most twice per key, then accepted with a loud note." },
  "completion-recovery-forced-turns": { class: "quality", family: "completion", decides: "no-evidence", onDecided: "advise", onCannotDecide: "advise",
    summary: "After a refused completion the next turn is rewritten by _completionRecoveryPolicy: read-only verification tools only (fetch_url forced to GET, or verify_form / download readers) with toolChoice required, then a done-only turn." },
  "completion-verifier-advisory-outputs": { class: "quality", family: "completion", decides: "no-evidence", onDecided: "advise", onCannotDecide: "advise",
    summary: "Non-refusing verifier outputs: an uncertain verdict (all engines unsure/unavailable, budget spent, D1 success without confirmation) sets no verified submission evidence, and a sure later_outcome side answer appends a \"future votes/moderation unverified\" note." },
  "completion-verifier-not-done": { class: "quality", family: "completion", decides: "knows", onDecided: "advise", onCannotDecide: "advise",
    summary: "The independent completion judge (decision-model sidecar or active LLM) returns a sure pending or failed verdict for done(success): refused and re-armed as verification debt (forced read-only turn)." },
  "done-iframe-form-unverified": { class: "quality", family: "completion", decides: "no-evidence", onDecided: "advise", onCannotDecide: "advise",
    summary: "done(success) or a plain final while edited iframe form targets have not been read back by a matching verify_form (which compares textContent against an expected value that keeps newlines)." },
  "done-invariant-shape-checks": { class: "quality", family: "completion", decides: "mixed", onDecided: "advise", onCannotDecide: "advise",
    summary: "Act/Dev done without outcome success/partial/failed, or done(success) in the same assistant batch as the action/observation it relies on (or with verification debt at batch start)." },
  "done-rich-text-toolbar-obligation": { class: "quality", family: "completion", decides: "knows", onDecided: "advise", onCannotDecide: "advise",
    summary: "done(success) or a plain final while the last text entry hit a rich-text formatting toolbar and no verified editor-body edit has released the obligation." },
  "done-summary-meta-only": { class: "quality", family: "completion", decides: "knows", onDecided: "advise", onCannotDecide: "advise",
    summary: "The done summary only says that an answer was given (\"Explained how...\") without the answer (judge summary_kind or done_summary reading): refused for a fresh answer turn." },
  "done-video-duration": { class: "quality", family: "completion", decides: "mixed", onDecided: "advise", onCannotDecide: "advise",
    summary: "A requested video is shorter than its target, unjoined or undelivered, or its duration could not be verified: completion is refused once, then accepted with a caveat; known incomplete delivery ends as partial.",
    mustNotBlock: "test/video-duration-guard-policy.mjs#a generated video with unavailable duration verification can finish after one note" },
  "done-verification-debt": { class: "quality", family: "completion", decides: "no-evidence", onDecided: "advise", onCannotDecide: "advise",
    summary: "done(success) or a plain final after a consequential action with no later successful explicit observation (downloads need list_downloads/read_downloaded_file)." },
  "exact-table-done": { class: "quality", family: "completion", decides: "mixed", onDecided: "advise", onCannotDecide: "advise",
    summary: "Exact table export completion: table JSON without a current data_ref from an exact extract, rowCount != rows.length, an unknown/expired/superseded/foreign data_ref, or a fresh re-read that differs from the exported snapshot (done with any outcome and plain finals)." },
  "github-committed-file-verification": { class: "quality", family: "completion", decides: "mixed", onDecided: "advise", onCannotDecide: "advise",
    summary: "After a GitHub edit-file-and-commit, the raw blob at the commit SHA must byte-match the requested text (SHA-256), be on the requested branch, in the expected repository, listed in the commit file list, with a bound verified editor replacement; oversized or unreadable raw files and an unproven scope…" },
  "incomplete-task-check-stale": { class: "host_check", family: "completion", decides: "no-evidence", onDecided: "block", onCannotDecide: "block",
    summary: "The task, run, provider, steering or observed document changed before or during the incomplete_task reading: the partial/failed ending is refused and the model reconsiders the current task." },
  "incomplete-task-redirect": { class: "quality", family: "completion", decides: "knows", onDecided: "advise", onCannotDecide: "advise",
    summary: "An honest done(partial/failed) in an Act/Dev execute task is redirected (at most twice) when the incomplete_task judge says the flow is still loading/validating (wait_then_check) or a reasonable permitted next step remains (continue_now); unsure judges accept the ending." },
  "native-chat-receipt-not-durable": { class: "recipient", family: "completion", decides: "no-evidence", onDecided: "block", onCannotDecide: "block",
    summary: "Fresh native chat delivery proof exists but its receipt cannot be persisted: done(success) is refused so a resumed run does not resend the delivered message." },
  "page-feedback-ask-answer-superseded": { class: "host_check", family: "completion", decides: "mixed", onDecided: "block", onCannotDecide: "block",
    summary: "An Ask answer written while the page changed (non-passive churn) is discarded and the model re-asked with fresh feedback, unless an ask_response_scope reading says the answer is page-independent." },
  "plain-final-done-protocol": { class: "quality", family: "completion", decides: "protocol", onDecided: "advise", onCannotDecide: "advise",
    summary: "An Act/Dev run that executed an action (state observed) ends with plain text: forced into a done-only turn." },
  "plain-final-rejected-text-compaction": { class: "quality", family: "completion", decides: "knows", onDecided: "advise", onCannotDecide: "advise",
    summary: "When another plain-final block fires and the reply repeats a long paragraph three times or hit the output limit, the assistant turn is replaced by a rejection marker and a \"do not repeat\" nudge." },
  "plain-final-two-strike-partial": { class: "quality", family: "completion", decides: "protocol", onDecided: "advise", onCannotDecide: "advise",
    summary: "The third plain final under a completion block (second at max steps) ends the run as partial, keeping the model text when nothing else is pending." },
  "plain-final-unusable-output": { class: "quality", family: "completion", decides: "protocol", onDecided: "advise", onCannotDecide: "advise",
    summary: "The model returned no text and no tool call, a context-compression placeholder, or (on-device standalone chat) an answer ending mid-sentence: one nudge, then auto-resume (progress pending) or stop." },
  "plan-done-summary-shape": { class: "quality", family: "completion", decides: "protocol", onDecided: "advise", onCannotDecide: "advise",
    summary: "The done summary is a plan or planner/policy JSON instead of a result, or a partial/failed summary blames WebBrain's own Ask/read-only mode in an Act/Dev run (one focused correction, then stop)." },
  "plan-execution-evidence-missing": { class: "quality", family: "completion", decides: "no-evidence", onDecided: "advise", onCannotDecide: "advise",
    summary: "Plan-execution guard default: done(success) with no successful task tool, a state-changing task with no verified consequential tool (an already-correct page cannot be success), evidence recorded under another task key, or planning failed so success needs a verified consequential tool; one nudge,…" },
  "plan-plain-final-protocol": { class: "quality", family: "completion", decides: "protocol", onDecided: "advise", onCannotDecide: "advise",
    summary: "In an execute Act/Dev run every plain-text final (including an echoed stale \"[Stopped by user]\" status) gets one done-protocol nudge with the text cleared, then the run stops." },
  "plan-publication-evidence-missing": { class: "quality", family: "completion", decides: "mixed", onDecided: "advise", onCannotDecide: "advise",
    summary: "Success of a publication task needs job-bound terminal evidence for every requested social destination (also when the publication contract could not be compiled) and, for published_resource jobs, a bound dispatch record, same workflow/task, a bound saved resource matching the requested payload…" },
  "plan-required-evidence-missing": { class: "quality", family: "completion", decides: "no-evidence", onDecided: "advise", onCannotDecide: "advise",
    summary: "Plan-execution guard: success needs job-specific evidence that was not observed: a successful schedule_task/scheduled:true, completed DOWNLOAD-capability evidence, a non-submit job's own evidence (deterministic count, transcript, terminal read coverage, PR diff read, reconciled collection, scoped…" },
  "plan-submission-evidence-missing": { class: "quality", family: "completion", decides: "no-evidence", onDecided: "advise", onCannotDecide: "advise",
    summary: "Success of a submit/send/commit task needs evidence that it took effect: the selected site job's terminal state (recipient-bound sent message, paid/ticket-issued transaction, form confirmation bound to the inventoried form, saved state with bound metadata, resolved threads, verified final submit)…" },
  "plan-task-drifted": { class: "host_check", family: "completion", decides: "knows", onDecided: "block", onCannotDecide: "block",
    summary: "Plan-execution guard: the progress task key changed after the run was authorized, so execution evidence no longer binds; one nudge, then the run stops (task_binding_changed)." },
  "plan-unauthorized-mutation-recorded": { class: "quality", family: "completion", decides: "knows", onDecided: "advise", onCannotDecide: "advise",
    summary: "Success is refused after the fact when a conditional editor repair was blocked for lacking a matching workflow contract, or a prepare-only form job dispatched a submit." },
  "progress-ledger-unresolved": { class: "quality", family: "completion", decides: "knows", onDecided: "advise", onCannotDecide: "advise",
    summary: "Act mode with unresolved (pending/acted) rows in the app-owned progress ledger: done with any outcome is refused and plain finals are redirected with the progress_read payload." },
  "progress-success-claim-checks": { class: "quality", family: "completion", decides: "knows", onDecided: "advise", onCannotDecide: "advise",
    summary: "done(success) while the expected ordered rows are missing, duplicated, unprocessed or lack required fields (a short value read as \"missing\" counts as absent), or while ledger rows are skipped or failed." },
  "pure-calculation-done-checks": { class: "quality", family: "completion", decides: "mixed", onDecided: "advise", onCannotDecide: "advise",
    summary: "done on a literal-arithmetic task before any actual calculate attempt (any outcome), or done(success) whose summary omits/changes the calculator receipt value or breaks the requested literal format." },
  "read-coverage-ask-limitation": { class: "quality", family: "completion", decides: "no-evidence", onDecided: "advise", onCannotDecide: "advise",
    summary: "Ask mode, whole-thread Gmail read required, pages covered but message expansion not confirmed: the model answer (done or plain final) is replaced by a fixed limitation and the run ends read_scope_limited." },
  "read-coverage-incomplete": { class: "quality", family: "completion", decides: "mixed", onDecided: "advise", onCannotDecide: "advise",
    summary: "The user asked for a whole thread/document and read coverage is incomplete (pages missing, or no terminal page / expansion confirmed): done with any outcome and plain finals are refused." },
  "step-limit": { class: "permission_gate", family: "completion", decides: "knows", onDecided: "block", onCannotDecide: "block",
    summary: "The user-configured maxSteps budget is reached without a final response: the run ends (max_steps) with Continue offered." },
  "structured-cloud-output-contract": { class: "infra", family: "completion", decides: "protocol", onDecided: "block", onCannotDecide: "block",
    summary: "Structured cloud runs: done_json outside a cloud run with an output schema, a result that fails outputSchema (one repair, then cloudFailed), or prose instead of done_json (one nudge, then required_tool_missing)." },
  "terminal-recovery-no-success": { class: "quality", family: "completion", decides: "protocol", onDecided: "advise", onCannotDecide: "advise",
    summary: "The forced delivery turn after the observation limit, and the step-limit handoff, may only end partial/failed; invalid output falls back to the deterministic ledger partial or a fixed failure text (delivery_recovery_failed)." },
  "content-action-outcome-unknown": { class: "quality", family: "content-write", decides: "no-evidence", onDecided: "advise", onCannotDecide: "advise",
    summary: "A content/CDP deadline, lost message channel or Stop after dispatch makes a mutation outcome-unknown; for text writes the finalizer then records debt (also across Stop)." },
  "set-field-bundled-submit-outcome": { class: "quality", family: "content-write", decides: "mixed", onDecided: "advise", onCannotDecide: "ask",
    summary: "set_field({submit:true}) withholds the bundled Enter/requestSubmit when the value did not verify, and reports a native form that failed checkValidity instead of submitting it." },
  "text-write-debt-arm": { class: "quality", family: "content-write", decides: "no-evidence", onDecided: "advise", onCannotDecide: "advise",
    summary: "_finalizeTextMutationResult (every set_field/type_ax/type_text result, timeouts and cancellations included) turns any unverified, unproven or unknown write into success:false + outcomeUnknown + repeatBlocked, records debt for the editor and drops contenteditable proofs; a verified value with an…" },
  "text-write-debt-block": { class: "quality", family: "content-write", decides: "no-evidence", onDecided: "advise", onCannotDecide: "advise",
    summary: "Any write (any tool, ref or locator) to an editor that has unresolved text-write debt in this document is refused unless it is the identical original replacement and readback-only recovery verifies it (then a no-dispatch \"recovered\" result is returned)." },
  "text-write-preinsert-unproven": { class: "quality", family: "content-write", decides: "no-evidence", onDecided: "advise", onCannotDecide: "advise",
    summary: "The write is stopped before its text goes out because the pre-insert state cannot be proven: DraftJS structure unreadable before the write (no dispatch), select-all could not be proven to cover the managed editor, or select-all+Delete could not be proven to empty the field." },
  "text-write-readback-unverified": { class: "quality", family: "content-write", decides: "mixed", onDecided: "advise", onCannotDecide: "advise",
    summary: "Post-write readback cannot confirm the exact text: content set_field/type_ax/contenteditable insert/DraftJS paste mismatches (innerText fallback reader + strict comparator), a replaced element, DraftJS unreadable after the write, CDP verifyTextEntry/focused textContent checks, uncertain…" },
  "truncated-preview-replacement": { class: "deletion", family: "content-write", decides: "knows", onDecided: "block", onCannotDecide: "block",
    summary: "A clearing write whose text ends with \"...\" or another truncation marker and whose prefix starts the field's longer current value would erase everything after the preview: nothing is typed (set_field, type_ax, type, CDP type_text, iframe typing)." },
  "trusted-field-retry-guards": { class: "quality", family: "content-write", decides: "mixed", onDecided: "advise", onCannotDecide: "advise",
    summary: "WebBrain's own trusted CDP retry of a set_field/type_ax write is suppressed after a possibly dispatched original write, or fails its preparation (focus press, reselection, CDP error, preparation veto predicates); an exact readback proving the editor unchanged makes the failure retryable without…" },
  "typing-target-identity": { class: "quality", family: "content-write", decides: "mixed", onDecided: "advise", onCannotDecide: "advise",
    summary: "Typing target identity checks in the type_text/press_keys handlers: the focused editor bound by the toolbar preflight changed or could not be prepared/revalidated, or the selector backend node id cannot be pinned for safe typing." },
  "delivery-observation-checkpoint": { class: "budget", family: "loop", decides: "knows", onDecided: "block", onCannotDecide: "block",
    summary: "Consecutive read/scroll/wait observations without verified progress (an unverified write does not count as progress): nudge every 4, and at 8 browser tools stop for a done-only (partial/failed) delivery turn; advisory for cloud runs and the WebBrain Cloud provider." },
  "loop-failed-action-target": { class: "budget", family: "loop", decides: "knows", onDecided: "block", onCannotDecide: "block",
    summary: "The same mutation target (failureScope, else tool + bucketed args) failed, was refused before dispatch or made no progress: nudge at 2, stop the run at 3 (4 for occlusion). Every failureScope-tagged refusal feeds it." },
  "loop-observation-stop": { class: "budget", family: "loop", decides: "knows", onDecided: "block", onCannotDecide: "block",
    summary: "Observation loops: repeated clicks in the same 5 px coordinate bucket (nudge 5, stop 8), accessibility-tree nodes read one by one without acting (stop at 6 suspicious or 12 non-sequential), the same scroll direction on the same target without movement (nudge 2, stop 3)." },
  "loop-repeat-stop": { class: "budget", family: "loop", decides: "knows", onDecided: "block", onCannotDecide: "block",
    summary: "_checkLoop repeat/oscillation stops: the same call key 3x in 6 or ABAB after eight nudges, carousel oscillation, the same verified navigation returning to an unchanged page four times, the same non-retryable failure twice, a checkbox still wrong after three attempts, the same read-only GET resource…" },
  "loop-unavailable-tool": { class: "budget", family: "loop", decides: "knows", onDecided: "block", onCannotDecide: "block",
    summary: "Repeated calls to a tool this run does not offer (counted by name): nudge at 3, stop at 10." },
  "loop-verification-dialog-reopen": { class: "host_check", family: "loop", decides: "knows", onDecided: "block", onCannotDecide: "block",
    summary: "The same verification (CAPTCHA) dialog was dismissed and reopened repeatedly on the same page: nudge, then stop." },
  "page-feedback-supersession-stop": { class: "budget", family: "loop", decides: "knows", onDecided: "block", onCannotDecide: "block",
    summary: "Budget over no-dispatch supersessions caused by passive churn or unknown attribution (or an unverified action context): nudge at 2, stop the run at 5 with a Retry/Give up failure-recovery card." },
  "api-mutation-permission": { class: "permission_gate", family: "predispatch", decides: "knows", onDecided: "block", onCannotDecide: "block",
    summary: "fetch_url/research_url with a write method in an Ask-mode run, or without /allow-api (conversation or persistent API permission)." },
  "browser-batch-fresh-turn-interrupt": { class: "quality", family: "predispatch", decides: "knows", onDecided: "advise", onCannotDecide: "advise",
    summary: "After a failed, refused, unverified or outcome-unknown browser action (a browser_batch child, any multi-call batch, or any pre-dispatch refusal of a browser-mutation tool) every later call in the assistant batch is skipped so the next action is planned on fresh evidence." },
  "browser-control-handoff-stale-batch": { class: "user_control", family: "predispatch", decides: "knows", onDecided: "block", onCannotDecide: "block",
    summary: "Browser control changed hands (manual takeover or cloud handoff) after the batch was planned: every remaining call is skipped and a fresh app-owned tree is injected." },
  "capability-host-permission": { class: "permission_gate", family: "predispatch", decides: "knows", onDecided: "block", onCannotDecide: "block",
    summary: "Capability x host permission gate: a standing deny or a Deny on the capability card (navigate, click, type, execute_js, dev_patch, network, download, upload, window, schedule) refuses the call on that host. upload_file is approved for its exact file; a file from outside the run is asked about every call, even with prompts off, and refused in an unattended run." },
  "captcha-gate-action-block": { class: "host_check", family: "predispatch", decides: "knows", onDecided: "block", onCannotDecide: "block",
    summary: "A supported verification challenge is active (solve_required) or its one solve has not been confirmed cleared (verification_pending): page mutations, network mutations and done(success)/done_json are refused until solve_captcha runs once / a read confirms clearance." },
  "captcha-gate-manual-required": { class: "host_check", family: "predispatch", decides: "knows", onDecided: "block", onCannotDecide: "block",
    summary: "The challenge needs manual completion (unsupported widget, failed solve, Cloudflare managed challenge, or no CAPTCHA tools in this mode/tier): the gated call is refused and the run stops asking the user to complete it." },
  "chat-send-evidence-unavailable": { class: "quality", family: "predispatch", decides: "no-evidence", onDecided: "advise", onCannotDecide: "ask",
    summary: "A recipient-verified chat send whose conversation cannot be observed before sending, or whose native WhatsApp message baseline cannot be saved: nothing is sent." },
  "chat-send-preconditions": { class: "quality", family: "predispatch", decides: "mixed", onDecided: "advise", onCannotDecide: "advise",
    summary: "Chat send preconditions (generic chat dispatch and decideChatSend): a new incoming message appeared since the last observation, empty or over-long message, terminal chat session, unverified native message baseline, unavailable or non-empty composer." },
  "chat-send-recipient-guards": { class: "recipient", family: "predispatch", decides: "mixed", onDecided: "block", onCannotDecide: "ask",
    summary: "Chat send protection of the recipient and against duplicates: the observed thread differs from the recipient-verified baseline or stored session, the exact message is already visible as outgoing or an earlier outbound is still pending verification, the pending message cannot be persisted before…" },
  "chat-user-input-required": { class: "credentials", family: "predispatch", decides: "knows", onDecided: "block", onCannotDecide: "block",
    summary: "The chat counterpart or page asks for a one-time code, PIN, card/CVC, password or login, or an explicit user decision (or the thread changed): replying is paused until the user completes it." },
  "chrome-protected-page": { class: "host_check", family: "predispatch", decides: "knows", onDecided: "block", onCannotDecide: "block",
    summary: "A DOM/debugger tool on a Chrome-protected page (Web Store developer dashboard; gallery after one retry) gets a non-retryable protected-page failure; repeated hits end the run with a visual-fallback or manual-required handoff." },
  "clarify-timeout-not-authorization": { class: "permission_gate", family: "predispatch", decides: "knows", onDecided: "block", onCannotDecide: "block",
    summary: "After a clarify answer was auto-selected on a waited timeout, consequential capabilities (click, type, script, network, download, upload, schedule), CAPTCHA solve/apply, done(success)/done_json and plain finals are refused; the second attempt or the last step stops the run asking for an explicit…" },
  "consequential-durability-checkpoint": { class: "unrequested_publication", family: "predispatch", decides: "no-evidence", onDecided: "block", onCannotDecide: "ask",
    summary: "Before a consequential call, the run-UI/scheduler recovery checkpoint, or the task-attempt record for an action that may post on X, Bluesky or an unknown site, cannot be saved: the run stops (persistence_degraded) before sending." },
  "coordinate-click-provenance": { class: "infra", family: "predispatch", decides: "mixed", onDecided: "block", onCannotDecide: "block",
    summary: "A coordinate click without coordinate_space, with from_screenshot conflicting with css, with normalized 0-1 values, or with a missing/stale capture_id or a point outside the capture is refused before any probe (checked again inside executeTool)." },
  "deletion-confirm-card": { class: "deletion", family: "predispatch", decides: "mixed", onDecided: "block", onCannotDecide: "ask",
    summary: "A deletion whose item the latest request does not clearly name (not_requested, other_item, unclear) or whose semantic decision is unavailable goes to WebBrain's deletion card (\"once\" re-runs every workflow check, then dispatches; deny, timeout or auto answer refuses; a change during the card…" },
  "deletion-guard-refusal": { class: "deletion", family: "predispatch", decides: "mixed", onDecided: "block", onCannotDecide: "ask",
    summary: "Deletion checks in _resourceMutationPreSubmitBlock that refuse without a card: a deletion through coordinates/keys/set_field submit/execute_js (click_required), a Delete/Remove control outside one identifiable record (toolbar, bulk, selection), the same record/permalink already deleted in this…" },
  "form-validation-unchanged-repeat": { class: "quality", family: "predispatch", decides: "knows", onDecided: "advise", onCannotDecide: "advise",
    summary: "The same submit (or verify_form) is retried while the page shows the same invalid fields as the last failed submission." },
  "generate-image-config-invalid": { class: "infra", family: "predispatch", decides: "protocol", onDecided: "block", onCannotDecide: "block",
    summary: "generate_image with an unknown provider, missing API key, invalid model or malformed ComfyUI workflow: the provider cannot be called." },
  "github-commit-evidence-binding": { class: "quality", family: "predispatch", decides: "no-evidence", onDecided: "advise", onCannotDecide: "ask",
    summary: "A commit click in the GitHub edit-file-and-commit workflow is refused unless exactly one verified editor-replacement proof (readbackSha256), the requested commit message summary/body, path and branch are bound to exact pre-submit evidence; proofs are re-digested before every attempt, unverifiable…" },
  "github-commit-split-write-required": { class: "quality", family: "predispatch", decides: "knows", onDecided: "advise", onCannotDecide: "ask",
    summary: "In the GitHub edit-file-and-commit workflow a submit-capable non-click (execute_js, set_field submit, Enter) that may submit is refused: writes must be verified separately and the commit activated by a separate click." },
  "github-conditional-commit-rearm": { class: "quality", family: "predispatch", decides: "protocol", onDecided: "advise", onCannotDecide: "advise",
    summary: "The first editor action of an authorized conditional repair branch arms the edit-file-and-commit workflow (system prompt rebuilt, evidence counters reset) and is itself not dispatched." },
  "github-conditional-commit-unbound": { class: "unrequested_publication", family: "predispatch", decides: "knows", onDecided: "block", onCannotDecide: "block",
    summary: "A scheduled-resume verification task (no state change or submission authorized) tries to mutate a GitHub repo editor or run execute_js/an API mutation on a repo page and no matching conditional edit-file-and-commit job can be bound (none planned, other repository, task drift, opaque mutation)." },
  "grouped-search-card": { class: "permission_gate", family: "predispatch", decides: "knows", onDecided: "block", onCannotDecide: "block",
    summary: "A low-risk same-site GET search group (navigate, type, submit) without a standing grant asks once on WebBrain's grouped-search card; deny refuses the unchanged search." },
  "otp-open-message-gate": { class: "permission_gate", family: "predispatch", decides: "knows", onDecided: "block", onCannotDecide: "block",
    summary: "read_email_verification_message open_message is refused in Ask mode (opening can mark mail read) or without the one-use open grant minted by the mailbox permission gate for that message_ref." },
  "owned-native-chat-read-repair": { class: "quality", family: "predispatch", decides: "no-evidence", onDecided: "advise", onCannotDecide: "advise",
    summary: "While an app-issued native Telegram/WhatsApp read repair is pending (latest messages not verified), the model batch or plain final answer is preempted and the app runs its own exact read first." },
  "permission-host-unidentified": { class: "host_check", family: "predispatch", decides: "no-evidence", onDecided: "block", onCannotDecide: "block",
    summary: "The target frame/host of a call cannot be identified (iframe tools without urlFilter, apply_captcha_solution without frameUrl, WebMCP without a target URL, OTP without a mailbox URL): fail closed instead of charging the top page grant." },
  "preparation-timeout-action-pipeline": { class: "quality", family: "predispatch", decides: "no-evidence", onDecided: "advise", onCannotDecide: "ask",
    summary: "The shared deadline around the in-pipeline preparation (rich-text toolbar preflight, social publication audit, generic chat send preparation, task-attempt checkpoint) expired before dispatch: nothing was sent." },
  "preparation-timeout-captcha-preflight": { class: "host_check", family: "predispatch", decides: "no-evidence", onDecided: "block", onCannotDecide: "block",
    summary: "The CAPTCHA safety preflight (dialog scan / AWS-WAF gate) did not finish before the content-action deadline: the page mutation is refused (retryable) so a challenge cannot be dismissed or resubmitted unseen." },
  "preparation-timeout-permission-detection": { class: "permission_gate", family: "predispatch", decides: "no-evidence", onDecided: "block", onCannotDecide: "block",
    summary: "Grouped-search form detection or submit-action detection timed out before the permission/submit cards could be chosen: the call is refused rather than bypassing the submit card." },
  "preparation-timeout-recipient-preflight": { class: "recipient", family: "predispatch", decides: "no-evidence", onDecided: "block", onCannotDecide: "ask",
    summary: "The message-recipient safety preflight (_messageRecipientGuardBlock probe) timed out on a protected messaging page: the send is refused." },
  "preparation-timeout-submit-preflight": { class: "deletion", family: "predispatch", decides: "no-evidence", onDecided: "block", onCannotDecide: "ask",
    summary: "The submit/form-validation preflight (_detectLikelySubmitAction, result baseline, validation snapshot) timed out: the call is refused. This probe is the only source of mutationKind:\"delete\" for the deletion guard and of publicationControl for the X/Bluesky gates." },
  "pure-calculation-stale-authority": { class: "host_check", family: "predispatch", decides: "knows", onDecided: "block", onCannotDecide: "block",
    summary: "The captured arithmetic task authority (owner, run token or expression) no longer matches the current task (steering or a new turn after the batch was planned): every tool, done included, is refused." },
  "pure-calculation-tool-scope": { class: "quality", family: "predispatch", decides: "knows", onDecided: "advise", onCannotDecide: "advise",
    summary: "On an owned literal-arithmetic task, any tool other than calculate(exact expression) or done, a calculate with another expression, or a repeated calculate after the result was verified is refused (checked again in-pipeline)." },
  "recipient-active-conversation-pin": { class: "recipient", family: "predispatch", decides: "no-evidence", onDecided: "block", onCannotDecide: "ask",
    summary: "At planning time a task that targets \"the open conversation\" cannot pin it to one verified recipient identity: the run stops before any page tool." },
  "recipient-draft-evidence-unavailable": { class: "quality", family: "predispatch", decides: "no-evidence", onDecided: "advise", onCannotDecide: "ask",
    summary: "The recipient is authorized (or confirmable) but the composer draft body cannot be read, or the existing-message baseline needed to verify a new send is unavailable." },
  "recipient-guard-refusal": { class: "recipient", family: "predispatch", decides: "mixed", onDecided: "block", onCannotDecide: "ask",
    mustNotBlock: "test/social-publish-contract.mjs#a public X post is not a message send, so the recipient guard lets it through",
    summary: "_messageRecipientGuardBlock refusals on protected messaging pages (Gmail, X DMs, LinkedIn, Discord, native WhatsApp/Telegram, generic mail/chat): Enter with repeat>1, a send path that cannot be bound to the verified recipient (iframe_click, execute_js, WebMCP, ambiguous upload), no observable…" },
  "recipient-guard-target-preparation": { class: "quality", family: "predispatch", decides: "no-evidence", onDecided: "advise", onCannotDecide: "advise",
    summary: "Recipient-guard target failures that establish no mismatch: the requested control cannot be resolved in the page/frame (message_target_unresolved), or a native Telegram read-only preparation click is not bound to one exact current control/owner/binding token or changed before the click." },
  "recipient-guard-unrequested-send": { class: "unrequested_publication", family: "predispatch", decides: "knows", onDecided: "block", onCannotDecide: "ask",
    summary: "A send or public post the task did not ask for: a LinkedIn public Post control in a private-message task, a send the latest request forbids (sending_forbidden reading), and a verifiable send the plan did not authorize or that names no recipient (card with reason unrequested/unnamed; refused when…" },
  "recipient-mismatch-confirm-card": { class: "recipient", family: "predispatch", decides: "knows", onDecided: "block", onCannotDecide: "ask",
    summary: "A conclusive send whose observed recipient set differs from the task target and is not user-approved goes to WebBrain's recipient card (once/always re-run the guard, deny records a declined recipient, a changed conversation or Stop refuses/aborts); when the card cannot be offered (unattended run,…" },
  "resource-mutation-task-authority-changed": { class: "host_check", family: "predispatch", decides: "knows", onDecided: "block", onCannotDecide: "block",
    summary: "_resourceMutationPreSubmitBlock current() check: a delete control (or a post-correction publish/commit) while the plan guard is not an enabled execute guard, the task key changed, Stop was pressed, or a correction is pending or unvalidated." },
  "rich-text-toolbar-target-unresolved": { class: "quality", family: "predispatch", decides: "no-evidence", onDecided: "advise", onCannotDecide: "advise",
    summary: "The rich-text toolbar safety preflight cannot resolve or preserve the typing target (ambiguous/unresolved iframe selector, iframe recovery pending, selector-backed or focused type_text, page changed during resolution, trusted resolver cannot attach, iframe toolbar target cannot be scrolled into…" },
  "rich-text-toolbar-wrong-target": { class: "quality", family: "predispatch", decides: "knows", onDecided: "advise", onCannotDecide: "advise",
    summary: "Text about to be typed into a rich-text formatting-toolbar control (font, size, style, color, link) instead of the editor body, by structural score >= 4 plus the optional vision audit: refused and a recovery obligation is recorded." },
  "social-api-publication-route": { class: "unrequested_publication", family: "predispatch", decides: "no-evidence", onDecided: "block", onCannotDecide: "block",
    summary: "A write-method API call to an X/Bluesky post endpoint (CreateTweet, statuses, createRecord app.bsky.feed.post) is refused even after /allow-api: an API payload cannot pass the composer contract and audit." },
  "social-preflight-context-mismatch": { class: "recipient", family: "predispatch", decides: "mixed", onDecided: "block", onCannotDecide: "ask",
    summary: "The composer post kind or parent target differs from the contract: a fully observed draft needs explicit approval of its current target; an unobserved composer cannot inherit approval." },
  "social-publication-audit": { class: "unrequested_publication", family: "predispatch", decides: "mixed", onDecided: "block", onCannotDecide: "ask",
    summary: "Independent LLM audit of the concrete draft: denial or an unavailable checker offers an explicit one-call publication override for an identified draft; otherwise Retry-without-audit / Give up. A user-approved override skips the audit." },
  "social-publication-authorization-guard": { class: "unrequested_publication", family: "predispatch", decides: "mixed", onDecided: "block", onCannotDecide: "ask",
    summary: "X/Bluesky publication authorization: unresolved or rejected intent offers a hard Go ahead card for the observed composer. Explicit approval overrides model judgments for one unchanged action; unidentified controls and stale task/page bindings still require a fresh target." },
  "social-publication-draft-quality": { class: "quality", family: "predispatch", decides: "mixed", onDecided: "advise", onCannotDecide: "ask",
    summary: "X/Bluesky preflight quality checks: a detected submit made with set_field submit/Enter/execute_js/WebMCP instead of a click, and a composer snapshot whose body, media or thread length differs from the contract or cannot be observed (composer_incomplete, body_unobserved, baseline_incomplete)." },
  "social-publication-host-checks": { class: "host_check", family: "predispatch", decides: "mixed", onDecided: "block", onCannotDecide: "block",
    summary: "X/Bluesky publication guard host/authority checks: a write-method fetch whose destination is missing, not http(s) or carries credentials; the task, guard or correction state changed while a resolved preparatory control or the publication audit was being checked." },
  "steer-post-correction-commit-guard": { class: "unrequested_publication", family: "predispatch", decides: "mixed", onDecided: "block", onCannotDecide: "ask",
    summary: "After a correction, publication/form authorization includes explicit clarification answers. Policy refusals offer an identified-action override; Go ahead covers one call, including final checks, without turning cached authorization into a standing grant." },
  "steer-prior-submission-target-unresolved": { class: "quality", family: "predispatch", decides: "no-evidence", onDecided: "advise", onCannotDecide: "ask",
    summary: "After a correction with an earlier dispatched submission, a submit-capable call whose target the probe could not resolve as a link, field, menu item or ordinary button is refused." },
  "steer-prior-submission-unreconciled": { class: "unrequested_publication", family: "predispatch", decides: "no-evidence", onDecided: "block", onCannotDecide: "ask",
    summary: "_steeringPriorSubmissionBlock: after a correction, any network mutation, chrome_web_store_publish or committing submit is refused until the earlier submission is reconciled, unless _resourceMutationPreSubmitBlock authorized this exact action: reconciled with it, or a deletion that the latest request or the user's card bound to its item." },
  "steering-and-page-feedback-call-fence": { class: "host_check", family: "predispatch", decides: "mixed", onDecided: "block", onCannotDecide: "block",
    summary: "A user correction is pending, or page-monitor feedback (user input/intervention, unknown attribution, non-passive churn, stale scroll/model state) arrived after the model observation: the stale call (Act done and Ask answers included) and the rest of the batch are skipped and a fresh observation is…" },
  "submit-confirmation-card": { class: "permission_gate", family: "predispatch", decides: "knows", onDecided: "block", onCannotDecide: "block",
    summary: "With consequential confirmation on (not bypassed), a detected submit that is not a low-risk same-site GET search shows WebBrain's submit card (credential, payment and side-effect forms always get a fresh card); deny, timeout or an unexpected answer refuses the submit." },
  "tool-call-malformed": { class: "infra", family: "predispatch", decides: "protocol", onDecided: "block", onCannotDecide: "block",
    summary: "The call cannot run as given: invalid browser_batch parent (disabled tier, bad ids, too many/unbatchable children, schema failure), empty function name, arguments that are not valid JSON, an invalid get_accessibility_tree continuationArgs, a closed-schema violation, or a failed per-handler argument…" },
  "tool-not-advertised": { class: "permission_gate", family: "predispatch", decides: "knows", onDecided: "block", onCannotDecide: "block",
    summary: "A call to a tool that is not in this run tool set (mode, provider tier, unloaded skill) or to a retired tool is refused without dispatch." },
  "tool-routing-redirects": { class: "infra", family: "predispatch", decides: "knows", onDecided: "block", onCannotDecide: "block",
    summary: "fetch_url/research_url against an enabled skill HTTPS endpoint is redirected to the skill tool; a single-item download_social_media is redirected to download_public_media when that is available and untried, or skipped after it already succeeded." },
  "user-stop-or-card-cancel": { class: "user_control", family: "predispatch", decides: "knows", onDecided: "block", onCannotDecide: "block",
    summary: "The user pressed Stop before dispatch, or stopped/corrected the task while a permission, submit, grouped-search, deletion or recipient card was open: the run aborts with nothing dispatched." },
  "webmcp-mode-and-setting-gate": { class: "permission_gate", family: "predispatch", decides: "knows", onDecided: "block", onCannotDecide: "block",
    summary: "execute_webmcp_tool/list_webmcp_tools while Experimental WebMCP is disabled in Settings, or in Ask mode (page readOnly annotations are not trusted): refused in preparation and again in the handler." },
  "webmcp-tool-id-invalid": { class: "infra", family: "predispatch", decides: "protocol", onDecided: "block", onCannotDecide: "block",
    summary: "execute_webmcp_tool without an exact registered opaque tool_id (missing, invented, stale) or with a failed CDP registry lookup: nothing to invoke." },
  "sched-reconciliation-required": { class: "unrequested_publication", family: "scheduler", decides: "mixed", onDecided: "block", onCannotDecide: "ask",
    summary: "Unattended scheduled tasks are paused (needs_user_input) instead of re-running an action that may already have happened: a downgraded success after a side effect or pending consequential action, a pending consequential call not settled by an independently verified completion, or a judge context…" },
  "sched-systemone-downgrade": { class: "quality", family: "scheduler", decides: "mixed", onDecided: "advise", onCannotDecide: "advise",
    summary: "Opt-in System One judge after a scheduled run reported success: P(task_complete) below threshold or incomplete score downgrades the job outcome to partial (malformed answers or service failure keep success)." },
  "action-no-progress-classification": { class: "quality", family: "tool", decides: "knows", onDecided: "advise", onCannotDecide: "advise",
    summary: "Post-dispatch: the same click identity twice with an identical page snapshot, or an unbound arrow key that changed nothing observable, is reclassified as a no-progress failure (feeds the loop detector)." },
  "bot-memory-reservation": { class: "unrequested_publication", family: "tool", decides: "mixed", onDecided: "block", onCannotDecide: "block",
    summary: "Managed-bot cross-run idempotency: an action remote memory says is already completed, an opaque execute_js/schedule_* call in a memory-protected run, an unobserved/unresolved/changed target, or a reservation/durable dispatch that memory did not confirm." },
  "captcha-paid-solve-protection": { class: "money", family: "tool", decides: "knows", onDecided: "block", onCannotDecide: "block",
    summary: "Keeps paid CAPTCHA solving to one dispatch per challenge/page document: the gate refuses solve_captcha after the allowed solve, the handler refuses a second native/automatic solve, an AWS gate that is no longer solve_required, an exhausted AWS provider set, and any provider call whose dispatch lock…" },
  "captcha-solution-binding": { class: "host_check", family: "tool", decides: "mixed", onDecided: "block", onCannotDecide: "block",
    summary: "Native solve page URLs must match the active tab/frames and the root document must be bound before a native request; a returned solution is applied only to the same unchanged page/frame; a provider-mandated User-Agent mismatch retains the paid answer without injection and asks for manual completion." },
  "captcha-solve-detection-binding": { class: "quality", family: "tool", decides: "mixed", onDecided: "advise", onCannotDecide: "ask",
    summary: "solve_captcha arguments conflict with the detected widget (type, invisibility, enterprise flag, pageAction, rqdata, metadata), token injection has no detected frame, or the hCaptcha frame User-Agent cannot be read: refused before any paid dispatch." },
  "carousel-traversal-guards": { class: "quality", family: "tool", decides: "mixed", onDecided: "advise", onCannotDecide: "advise",
    summary: "A forward carousel scan asks for an index at or below the highest verified one (reverse order assumed only on a sure reading), or Instagram did not honor img_index / the media did not change (post-dispatch failure)." },
  "click-coordinate-intent": { class: "infra", family: "tool", decides: "knows", onDecided: "block", onCannotDecide: "block",
    summary: "A coordinate click whose own expected_name/expected_role assertion does not match what the point resolves to (or nothing resolves there) is refused before dispatch, as the tool contract promises. Without an assertion, a resolver error falls back to the raw point." },
  "click-duplicate-submit": { class: "unrequested_publication", family: "tool", decides: "knows", onDecided: "block", onCannotDecide: "ask",
    summary: "A second click within 45 s on a control whose caption reads as commit/publish, on the same unchanged URL, is refused (model escape _allowResubmit:true)." },
  "click-native-os-ui": { class: "infra", family: "tool", decides: "knows", onDecided: "block", onCannotDecide: "block",
    summary: "Clicks that would open native OS UI the agent cannot control: a native <select> dropdown (refused, or reported as a failure after the click) and a native file chooser (suppressed, with a pointer to upload_file)." },
  "click-text-ambiguous": { class: "infra", family: "tool", decides: "knows", onDecided: "block", onCannotDecide: "block",
    summary: "click({text}) matched several elements with no single interactive one." },
  "clickax-native-button-preparation": { class: "quality", family: "tool", decides: "mixed", onDecided: "advise", onCannotDecide: "advise",
    summary: "Trusted native-button input preparation vetoes: the button changed or moved during preparation, could not be captured or verified while settling, input was observed while it settled, or the task/browser owner changed before the press." },
  "clickax-task-click-lock": { class: "unrequested_publication", family: "tool", decides: "no-evidence", onDecided: "block", onCannotDecide: "ask",
    summary: "A trusted click (native button or click_ax trusted fallback) on this exact document+ref earlier in the task may have landed and was never verified: the same target is not clicked again (one trusted fallback per ref per run)." },
  "clickax-trusted-retry-vetoes": { class: "quality", family: "tool", decides: "knows", onDecided: "advise", onCannotDecide: "advise",
    summary: "WebBrain's automatic trusted retry of a click_ax that produced no visible change is skipped for concurrent tab/network/download activity, mutating captions, changed or ineligible targets." },
  "downloaded-file-conversation-scope": { class: "permission_gate", family: "tool", decides: "knows", onDecided: "block", onCannotDecide: "block",
    summary: "read_downloaded_file of a download this conversation did not produce (WebBrain's download tools, or a download that started during one of its runs) reads nothing unless the user approves that exact file on WebBrain's card; an unattended run cannot ask and reads nothing.",
    mustNotBlock: "test/download-conversation-scope.mjs#a download from this conversation is listed and read without asking" },
  "downloaded-file-task-changed": { class: "host_check", family: "tool", decides: "mixed", onDecided: "block", onCannotDecide: "block",
    summary: "read_downloaded_file discards bytes when steering arrived, the page-feedback owner, the download or the pinned document changed during the read, or the reader/document cannot be pinned." },
  "iframe-target-binding": { class: "infra", family: "tool", decides: "mixed", onDecided: "block", onCannotDecide: "block",
    summary: "The iframe selector matches several elements (or none) across matching frames, or the clicked element was replaced after the scroll / the frame monitor is unavailable." },
  "iframe-urlfilter-required": { class: "host_check", family: "tool", decides: "knows", onDecided: "block", onCannotDecide: "block",
    summary: "iframe_click/iframe_type without urlFilter: the iframe target and permission scope cannot stay stable." },
  "jev-target-changed": { class: "quality", family: "tool", decides: "mixed", onDecided: "advise", onCannotDecide: "advise",
    summary: "The Jev-bound target (or the checkbox of a set_checked) changed, or its validation probe failed, before dispatch." },
  "media-download-target-binding": { class: "quality", family: "tool", decides: "knows", onDecided: "advise", onCannotDecide: "advise",
    summary: "download_public_media on a feed/profile page without an explicit media permalink, or a social media download whose focused media/document changed between inference and download (media_binding_changed)." },
  "navigation-scheme-and-internal-pages": { class: "host_check", family: "tool", decides: "knows", onDecided: "block", onCannotDecide: "block",
    summary: "navigate to a non-http(s) scheme or unresolvable relative URL; go_back/go_forward on chrome://, about:, extension or view-source pages." },
  "network-url-safety": { class: "host_check", family: "tool", decides: "knows", onDecided: "block", onCannotDecide: "block",
    summary: "fetch/research URL safety: metadata and .internal/.local hosts always, localhost/private IPs unless \"Allow local network\", redirects into blocked URLs or across registrable domains (body discarded), cross-origin page resources." },
  "otp-mailbox-scope": { class: "credentials", family: "tool", decides: "mixed", onDecided: "block", onCannotDecide: "block",
    summary: "The OTP helper only exposes a verification message that visibly matches the named service in one unambiguous, unchanged mailbox tab, and never a truncated message without a safe continuation (skill must be loaded)." },
  "page-blocker-wall": { class: "host_check", family: "tool", decides: "mixed", onDecided: "block", onCannotDecide: "block",
    summary: "A read that showed a subscription, registration or sign-in wall WebBrain could not apply returns nothing behind the wall." },
  "page-feedback-dispatch-fence": { class: "host_check", family: "tool", decides: "mixed", onDecided: "block", onCannotDecide: "block",
    summary: "Transport-boundary fence (beforePageAgentDispatch, the content page monitor, the execute_js gate, the trusted Enter path): human input or feedback during preparation, a changed document mapping, focus moved into a child frame, an unprepared or rejecting monitor vetoes the dispatch; after input…" },
  "page-feedback-target-binding": { class: "quality", family: "tool", decides: "mixed", onDecided: "advise", onCannotDecide: "advise",
    summary: "The selector/ref of a state-changing call cannot be bound to the observed action certificate (target_ambiguous, target_unresolved, target_uncovered, capture budget exhausted) or its original owner context was never certified: nothing is dispatched and a bounded fresh capture is queued for the next…" },
  "pdf-viewer-dom-tools": { class: "host_check", family: "tool", decides: "knows", onDecided: "block", onCannotDecide: "block",
    summary: "A DOM/action tool on Chrome's built-in PDF viewer (read_page is redirected to read_pdf)." },
  "preparation-timeout-generic": { class: "quality", family: "tool", decides: "no-evidence", onDecided: "advise", onCannotDecide: "advise",
    summary: "A non-consequential preparation stage exceeded the content-action deadline before dispatch (form-validation snapshot, executeTool entry deadline, click page snapshot/observation, click_ax content-script injection, coordinate target resolution, set_checked trusted recovery): nothing was sent." },
  "promote-iframe-ambiguous": { class: "host_check", family: "tool", decides: "knows", onDecided: "block", onCannotDecide: "block",
    summary: "promote_iframe with several matching child frames and no (or an out-of-range) matchIndex." },
  "recipient-clarify-cannot-repair-technical": { class: "quality", family: "tool", decides: "knows", onDecided: "advise", onCannotDecide: "advise",
    summary: "A clarify about the recipient is refused while a technical recipient block (identity/body/baseline/binding unavailable) is active, because approval cannot supply missing page evidence." },
  "recipient-dispatch-binding-revalidate": { class: "recipient", family: "tool", decides: "mixed", onDecided: "block", onCannotDecide: "ask",
    summary: "Last-moment recipient checks at dispatch: the one-use binding token, composer, target, conversation, Telegram baseline or body changed between guard approval and the press/Enter (no CDP fallback for recipient-bound clicks), and recipient-bound uploads whose authorization key, file source, file…" },
  "research-escalation-authorization": { class: "permission_gate", family: "tool", decides: "knows", onDecided: "block", onCannotDecide: "block",
    summary: "delegate_research needs escalation enabled in Settings and a one-use authorization token bound to the exact prompt from an explicit clarify consent form for this tab/conversation." },
  "rich-text-toolbar-recovery-obligation": { class: "quality", family: "tool", decides: "mixed", onDecided: "advise", onCannotDecide: "advise",
    summary: "While a toolbar recovery obligation is pending, a ref, selector or region belonging to the recorded formatting toolbar is refused (also when the target probe is unresolved or the dispatch binding is not ready)." },
  "schedule-owner-changed": { class: "host_check", family: "tool", decides: "knows", onDecided: "block", onCannotDecide: "block",
    summary: "Scheduling is refused when the owning run, steering revision, plan guard, conversation or active task changed (or Stop) while the job was being created." },
  "schedule-resume-chat-state-not-durable": { class: "recipient", family: "tool", decides: "no-evidence", onDecided: "block", onCannotDecide: "block",
    summary: "schedule_resume is refused when the latest chat workflow state (pending sends, sent keys) cannot be persisted, so a resumed run cannot resend." },
  "stale-ax-ref": { class: "infra", family: "tool", decides: "knows", onDecided: "block", onCannotDecide: "block",
    summary: "A click_ax/set_checked ref_id belongs to a previous document or route, or several controls match the checkbox marker." },
  "strict-secret-credential-handling": { class: "credentials", family: "tool", decides: "knows", onDecided: "block", onCannotDecide: "block",
    summary: "Credential handling: filled password/token/OTP-like field values are removed from results (and noted in strict mode), notes/ledger rows holding them are redacted in strict secret mode, and strict mode refuses exporting credential columns from tables." },
  "tool-feature-availability-gates": { class: "permission_gate", family: "tool", decides: "knows", onDecided: "block", onCannotDecide: "block",
    summary: "Run-type/tier feature gates inside executeTool: recall_memcode in managed bot runs, skills unavailable for Compact tier or not enabled in this mode, beep outside a /watch run created with /beep (or a second event_key)." },
  "unsaved-changes-data-loss": { class: "deletion", family: "tool", decides: "mixed", onDecided: "block", onCannotDecide: "block",
    summary: "navigate/go_back/go_forward on a page with attached files or two or more dirty fields, and promote_iframe on a frame with changed fields, attached files or a known unverified iframe edit, would discard that content (force:true overrides)." },
  "upload-compact-tier-sources": { class: "permission_gate", family: "tool", decides: "knows", onDecided: "block", onCannotDecide: "block",
    summary: "Compact-tier upload_file accepts only attachmentId plus a targetId from its own discovery phase (no selector, downloadId or filePath; stale targetId rediscovered)." },
  "upload-selector-ambiguity": { class: "infra", family: "tool", decides: "knows", onDecided: "block", onCannotDecide: "block",
    summary: "The upload selector matched several file inputs (now or on the previous attempt, until an inspection runs)." },
  "upload-source-validation": { class: "infra", family: "tool", decides: "mixed", onDecided: "block", onCannotDecide: "block",
    summary: "The local upload path is missing/unreadable (inconclusive probes pass as unverified), or the file bytes do not match, or cannot be verified against, the input accept types." },
  "video-length-cap": { class: "permission_gate", family: "tool", decides: "knows", onDecided: "block", onCannotDecide: "block",
    summary: "generate_image scenes over 120 s or 24 clips are refused before submission, and an estimate over 120 s asks the user on WebBrain's card before the shorter version is generated (an unattended run generates nothing).",
    mustNotBlock: "test/generative-media-video.mjs#a video of two minutes or less generates without asking" },
  "viewport-inspection-budget": { class: "permission_gate", family: "tool", decides: "knows", onDecided: "block", onCannotDecide: "block",
    summary: "inspect_viewport is skipped once the user-configured maxScreenshotsPerTurn budget is used up." },
  "webmcp-frame-binding": { class: "host_check", family: "tool", decides: "mixed", onDecided: "block", onCannotDecide: "block",
    summary: "WebMCP execution without trusted frame metadata, after the registration frame/origin changed since the permission check, or for a tool id no longer registered." },});

export function guardEntry(id) {
  return Object.hasOwn(GUARDS, id) ? GUARDS[id] : null;
}

export function isHardGuardClass(cls) {
  return HARD_GUARD_CLASSES.includes(cls);
}

/**
 * What a registered guard does when it fires.
 * decided: true when the guard knows the action is wrong, false when it
 * cannot decide. strict: Settings → "Strict checks" (quality guards block).
 * Unknown ids keep today's behavior ('block') so an unregistered refusal is
 * never silently relaxed.
 */
export function guardOutcome(id, { decided = true, strict = false } = {}) {
  const entry = guardEntry(id);
  if (!entry) return 'block';
  const outcome = decided ? entry.onDecided : entry.onCannotDecide;
  if (entry.class === 'quality' && strict) return 'block';
  return GUARD_OUTCOMES.includes(outcome) ? outcome : 'block';
}

/** A note a quality guard leaves for the model instead of refusing. */
export function guardAdvisory(id, message) {
  const text = String(message || '').replace(/\s+/g, ' ').trim().slice(0, 600);
  return { guard: String(id), note: text };
}

/**
 * Attach advisory notes to a tool result. They go first, so a result that
 * is truncated for the model keeps them, and duplicates collapse.
 */
export function withGuardAdvisories(result, advisories) {
  const list = [];
  const seen = new Set();
  for (const item of Array.isArray(advisories) ? advisories : []) {
    if (!item || typeof item !== 'object' || !item.guard) continue;
    const key = `${item.guard}\u0000${item.note || ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    list.push({ guard: String(item.guard), note: String(item.note || '') });
  }
  if (!list.length || !result || typeof result !== 'object' || Array.isArray(result)) return result;
  const existing = Array.isArray(result.guardAdvisories) ? result.guardAdvisories : [];
  const merged = [...existing];
  for (const item of list) {
    if (!merged.some(prior => prior?.guard === item.guard && prior?.note === item.note)) merged.push(item);
  }
  const { guardAdvisories: _drop, ...rest } = result;
  return { guardAdvisories: merged, ...rest };
}
