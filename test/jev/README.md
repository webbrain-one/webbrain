# Jev speed evaluation

The experimental fast browser flow is disabled by default. It is not a verified
speedup until the paired live evaluation passes. A confidence or probability
threshold is a routing heuristic, not an accuracy guarantee.

`node test/jev/benchmark.mjs --dry-run` validates the 120-attempt schedule without
model requests: search, filtering, dynamic selection, a multi-field form, saving
a record and sending a message; baseline and Jev; Chrome and Firefox; five
repetitions with matched English/Turkish prompts. Each trial starts in a new tab
on the same local fixture. Failed attempts remain in the report. Fixtures keep
an independent action ledger so wrong and repeated final actions are counted.
`node --test test/jev/fixtures.test.mjs` validates fixture scoring in both engines.

Live evaluation requires explicit user authorization for the test budget and:

- `JEV_API_KEY` and `JEV_LLM_API_KEY` (environment only; never commit them).
- `JEV_LLM_BASE_URL` and `JEV_LLM_MODEL` for the same active OpenAI-compatible
  model in both variants.
- `JEV_LLM_INPUT_USD_PER_MILLION` and `JEV_LLM_OUTPUT_USD_PER_MILLION`, verified
  for that model before running. Cost results are estimates at these rates.
- `FIREFOX_BINARY` when Firefox is not at the macOS default application path.

Run `node test/jev/benchmark.mjs --live --budget-usd <authorized-budget> --out
<private-output-directory>`. Temporary extension profiles isolate settings and
keys; cleanup removes them. The normal planner, permission prompts, submit
checks, executor and completion checks remain active. The runner accepts planner
reviews for these explicitly requested local fixture tasks, but does not blanket
approve clarification or permission prompts. Such a blocked attempt counts as a
failure. Runtime cost limits stop subsequent calls; a request already in flight
can exceed an estimated remaining allowance, so this is not a provider billing
cap. No live evaluation has been run for this change.

`report.json` contains every attempt and totals, p50/p95 duration, success, wrong
and repeated actions, LLM/Jev call counts, fallbacks and total estimated model
cost. Acceptance requires all 120 attempts, at least 25% lower median duration,
no success regression and no wrong or repeated Jev actions. No general speed
claim should be made from fixture-only or mocked results.

For manual runs, exported traces now contain `⚡ Jev` entries for routing,
fallback and usage. An initial or automatic browser screenshot does not by itself
disable the AX-only path. `reason=current_visual_input` means a current user
attachment, explicit screenshot-tool result or unknown non-text input kept that
decision on the active provider. Sensitive controls use
`reason=sensitive_controls`. No screenshot pixels or bounded Jev evidence are
included in the export. Response-contract failures use a specific bounded
reason such as `invalid_distribution` or `unexpected_model`; the raw response is
not exported, and the first such response disables Jev for the rest of that run.

## Settings and documentation checks

Configure Jev under **Settings → Models → Decision → Jev (TypeSafe)**, after
Vision and Speech to text. The two speed switches are independent of scheduled
verification and remain off by default.

`npm run test:systemone:ui` checks both browsers in English and Turkish at narrow
and wide widths, including the retained `#multimodal` link, remembered tabs,
provider-filter independence, preference retention, and save/test/delete.
Connection tests are mocked; the test never calls TypeSafe.

To refresh the documentation images from this synthetic configuration, run
`JEV_DOC_SCREENSHOTS=web/docs/assets/screenshots npm run test:systemone:ui`.
Review the resulting screenshots before committing them. The capture clears the
synthetic Jev key and disables every Jev option before taking documentation images.

## Completion trace investigation

A user-supplied v36.7.1 trace showed 8 `done` attempts among 27 tool calls in its
first task. Six were rejected by the form-validation completion guard and one
by the submission-evidence guard; the final result was partial. Reads meanwhile
showed post-login administration pages. The retained failed-submit state needs
a separate task-scoped reconciliation investigation; navigating to another page
alone is not sufficient proof that the requested operation succeeded. The text
export truncates diagnostic payloads and does not establish exact per-call
latencies. No credentials or raw trace have been copied into this repository.

Jev completion is only a candidate. It neither clears validation failure state
nor bypasses the completion guards, so this particular loop must not be claimed
as fixed by enabling Jev. Separately, a successful navigation-producing action
whose original-document result is uncertain can now be reconciled by a later
successful read of the resulting URL. This removes a redundant generic `done`
recovery turn for search-like navigation while preserving all job-specific
submit, send, publish and payment evidence requirements.
