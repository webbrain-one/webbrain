# Tests

Authenticated local/Cloud workflows are separately opt-in. See
[the setup, scenario matrix and verification limits](../website-tests/README.md).
`npm run test:authenticated` checks the harness without live accounts;
`npm run authenticated -- dry-run --target live` previews scoped live cases.

Three layers, each with a different scope, speed, and cost profile.

## Setup (once)

```bash
npm install
npx playwright install chromium firefox
```

### Coverage and live quality checks

`npm run test:coverage` runs the complete default suite with Node V8 coverage,
including unexecuted product modules. The HTML and JSON summary are written to
`ci/artifacts/coverage/`. Vendor code and locale dictionaries are excluded.
This measures Node-executed product code: browser-injected scripts exercised
through Playwright are validated by assertions but do not contribute their
browser execution to Node's coverage percentages.

`npm run test:quality:browser` is a separate, optional live-model test of the
installed Chrome extension, using `OPENROUTER_API_KEY` from the environment.
Its temporary profile is isolated from personal browser profiles and removed
afterward. Form submissions and mid-run corrections target a local fixture
server; the public Wikipedia case only reads. It creates no accounts and
sends no messages to real people. Results and sanitized run evidence are
written under `ci/artifacts/quality-audit-2026-10-07/live-browser/` by default;
override the directory with `WEBBRAIN_QUALITY_ARTIFACTS`.

The native Telegram dialogue is intercepted into a local WebK-shaped fixture;
it sends no Telegram network messages. `test/quality/native-chat-mv3.mjs`
uses a deterministic loopback provider to exercise the complete installed
extension through generated replies and terminal verification.

External Mastoturk account creation is separately opt-in: pass
`--only=mastoturk-signup-and-email --signup-account=/absolute/private/account.json`
only after authorization to create that disposable test account. The private
file supplies `username`, `email` and `password`; usernames must start with
`webbrain_qa_` and email must use `picment.xyz`. This case blocks publishing,
DMs, follows, repeat registration and unrelated inboxes. It records account
attempts and confirmation separately, and redacts passwords and confirmation
tokens from saved evidence. Keep the credential file outside the repository.

`--only=mastoturk-demo-publication --demo-account=/absolute/private/account.json`
additionally requires an already created and confirmed QA account and explicit
authorization to publish and delete one disposable public test post. The case
records the post ID immediately, blocks DMs/follows/media/other deletions and
blocks repeat submission. Inspect its mutation ledger before any rerun: an
uncertain terminal may still have created the post. Do not rerun it against an
existing test post without finishing that post's cleanup first.

Add `--completion-diagnostics` to instrument only that disposable extension
copy. Its bounded diagnostic records contain booleans, approved enums and
counts for commit ownership, navigation, independent verdicts and terminal
gates; task text, account URLs, bodies and keys are excluded. The optional
instrumentation is not part of the packaged extension. The live publication
case requires successful terminal completion for both publication and cleanup,
and checks the removed post returns 404 independently.

```bash
npm run test:quality:browser -- --only=mid-run-steering
npm run test:quality:browser -- --model=minimax/minimax-m3
```

The default deterministic suite includes startup cancellation, conversation
restore, Cloud/scheduler races, chat permission gates, and signed Anthropic
tool-result replay. These checks do not require credentials or external sites.
It also exercises actual installed-MV3 native chat, one-use registration rules,
PNG/PDF download bytes and a PDF attachment POST, plus a 20-row task stopped and
continued through a blocked row and an HTTP 429 inference retry.

### Time budgets on a busy machine

Browser suites run slower when the machine is busy, and on a loaded runner a
fixed budget can expire after every subtest has passed. Their budgets come from
`test/lib/time-budget.mjs`: a long parent test gets a budget that grows with its
number of subtests (`suiteTimeout`), and other budgets and waits for page
events go through `scaled()`. Set `WEBBRAIN_TEST_TIMEOUT_SCALE` to stretch all
of them at once, for example when several browser suites run in parallel:

```bash
WEBBRAIN_TEST_TIMEOUT_SCALE=2 node --test test/page-monitor-dialog.mjs
WEBBRAIN_TEST_TIMEOUT_SCALE=2 node test/quality/native-chat-mv3.mjs
```

It defaults to 1 and must be a positive number. Waits whose expiry is the
expected result, and bounds that are themselves the behaviour under test, are
not scaled. Suites that lease their browsers from `test/lib/shared-browsers.mjs`
launch them in a before hook and close them in an after hook, each with its
own timeout, so browser startup and shutdown count against no test's budget. A
shared browser is replaced once it has served 25 contexts, because Firefox gets
slower with every context it serves.
When a native chat quality path misses its budget, the harness saves
`<path>-timeout-evidence.json` with the run's events and state before aborting.

## 1. Unit — `npm test`

`test/run.js`. Pure-JS tests covering loop detection, adapter routing, provider parity, permission gates, tool classifications, planner logic, skills, slash commands, credential fields, and context management. No browser, no network. Run the complete unit suite with `npm test`.

## 2. Fixtures — `npm run test:fixtures`

`test/fixtures/`. Playwright loads local HTML files that reproduce failure modes for overlay defenses and interaction patterns:

- `modal-scoping.html` — dialog with "Create" over a background that also has "Create" + "Publish release". Verifies `_findTopmostModal()` scopes the text resolver, so `click({text:"Create"})` picks the dialog's button and `click({text:"Publish release"})` returns a scoped no-match.
- `occlusion.html` — target button covered by a transparent overlay with higher z-index. Verifies the post-click `elementFromPoint` hit-test refuses with `{occluded:true}`, and that coord clicks correctly bypass the check.
- `ambiguity-candidates.html` — two "Cancel" buttons in different landmarks. Verifies the ambiguity response carries `{cx, cy, ancestor}` with the containing form / section identified.

No LLM, no API keys, no network. Deterministic, ~5 seconds. Run on every PR.

### Real Chrome WebMCP smoke test

`test/webmcp-e2e.mjs` verifies the experimental browser API and CDP domain
against a local fixture, then loads the real unpacked WebBrain extension and
repeats discovery and invocation through its `Agent` and `CDPClient`. The
coverage includes schema transport, default-off and Ask/Act gates, trusted frame
metadata preparation, paginated and cross-frame discovery, asynchronous
success, script exceptions, UI state changes, dynamic unregistration, and stale
tool IDs. It uses the repository's Playwright dependency and requires Google
Chrome 149 or newer. The runner starts and stops its own loopback fixture server
on a random port:

```bash
npm run test:webmcp
```

Set `WEBMCP_CHROME_PATH` when Chrome is installed outside its standard Windows,
macOS, or Linux location. The test launches Chrome headlessly with
`WebMCP,WebMCPTesting,DevToolsWebMCPSupport` enabled (Chrome 157 removed
`WebMCPTesting`; Chrome ignores feature names it does not know). It remains separate from
`npm test` because the browser API and CDP domain are experimental. Each browser
phase has a 30-second timeout; set `WEBMCP_TIMEOUT_MS` to override it or
`WEBMCP_DEBUG=1` to print phase progress while diagnosing a failure. The
dedicated `WebMCP E2E` workflow runs it for pull requests and main-branch pushes
that touch the Chrome extension, WebMCP fixtures, runner, dependencies, or the
workflow itself.

## 3. Anonymous scenarios — `npm run test:anonymous`

`test/anonymous/`. Playwright launches Chromium with the Chrome extension loaded, opens each scenario's URL, fires a `chat` message at the background service worker, waits for the agent's final reply, and runs the scenario's `check`. Uses a persistent profile (`.test-profile/`, gitignored) so configuration sticks between runs.

### First run

No providers are configured yet. The runner opens Settings → Models → LLM; add a provider + API key there, close the browser, re-run. Or run `npm run test:anonymous -- --setup` just to open that section without trying to execute.

### Scenarios

Defined in `scenarios.json` — add more by following the shape. Supported `check` types:

- `{type:"contains", value:"...", field:"content"}` — substring match against the agent's final text answer (case-insensitive). Add `minLength` to require a non-trivial reply.
- `{type:"regex", value:"...", flags:"i"}` — full regex.

Only anonymous/public sites here. Signed-in scenarios (Gmail, GitHub issue filing, Stripe) need a baked session and can be driven via the same harness once you add auth handling — but don't try to automate those in CI; keep them local.

### Usage

```bash
npm run test:anonymous                              # all scenarios
npm run test:anonymous -- --scenario=arxiv-attention-title  # just one
npm run test:anonymous -- --setup                   # open Settings → Models → LLM only
```

Headed by default so you can watch runs and intervene. Budget ≈ 10–30 seconds per scenario + LLM tokens per the configured provider.

## 4. Vision probe — `node vision-probe.mjs <image>`

`vision-probe.mjs`. One-shot caption-quality check against any OpenAI-compatible vision endpoint (llama.cpp, Ollama, LM Studio, vLLM, LiteLLM, OpenRouter, …) using **the exact same system prompt, user text, and parameters** the extension's vision sub-call sends — `VISION_SYSTEM_PROMPT`, temperature 0, max_tokens 800, `chat_template_kwargs.enable_thinking: false`. If your vision model produces garbage here, it will produce garbage in the extension too.

### Usage

```bash
node vision-probe.mjs <image-path> [endpoint] [model]
```

- `<image-path>` — PNG/JPEG on disk. Typically a screenshot to check the model against.
- `endpoint` — defaults to `http://127.0.0.1:8080`. Given a bare host, `/v1/chat/completions` is appended.
- `model` — optional; if omitted, the server picks. Required for OpenRouter / multi-model servers.
- `VISION_PROBE_KEY` env var — bearer token, if the endpoint needs one.
- `VISION_PROBE_FOLD_SYSTEM=1` — fold the system prompt into the user message for chat templates that reject separate system messages. This is automatic when the model name contains `molmo`.

### Examples

```bash
# Local llama.cpp
node vision-probe.mjs ./shot.png

# Local llama.cpp with an explicit model label
node vision-probe.mjs ./shot.png http://127.0.0.1:8080 Gemma-4-E2B-It

# Ollama (note the /v1 suffix matters for OpenAI compat)
node vision-probe.mjs ./shot.png http://localhost:11434/v1 llava:13b

# LM Studio with Molmo
node vision-probe.mjs ./shot.png http://127.0.0.1:1234/v1 molmo2-8b

# OpenRouter with a key
VISION_PROBE_KEY=sk-or-v1-... node vision-probe.mjs ./shot.png \
  https://openrouter.ai/api/v1 openai/gpt-4o
```

### What to look for

The prompt asks the model for a 6-section structured caption (page purpose, exact visible text, inputs, state signals, blockers, unknowns). The planner depends on sections **2 (exact strings)** and **4 (state signals)** above all — those drive `click({text})` and error-state detection. When evaluating a candidate vision model:

- Does it quote button/link text **verbatim**, or does it paraphrase?
- Does it hallucinate strings that aren't on the screen?
- Does it surface red error borders, disabled buttons, CAPTCHAs, cookie banners?
- Does it correctly flag "unknown" when it can't read a number, not guess?

Keep the two constants at the top of `vision-probe.mjs` in sync with `src/chrome/src/agent/agent.js` (`VISION_SYSTEM_PROMPT` and the user-message text). If the real prompt changes, update the probe so results stay comparable.

### 100-case vision benchmark — `test/vision/`

For model-to-model success rates rather than a one-image sanity check, use the
100-case suite under `test/vision/`. It keeps the production prompt and request
parameters, adds deterministic easy-to-challenging viewport images, weighted
rubrics, per-difficulty/category summaries, and prompt-drift validation.

```bash
node test/vision/run.mjs --model Gemma-4-E2B-It
node test/vision/run.mjs --model molmo2-8b --only 1,21,41,61,81
npm run test:vision:validate
```

See `test/vision/README.md` for endpoint, hosted-provider, prompt-mode, scoring,
and corpus-regeneration details.

## 5. Manual memory tutorial — `test/memory/`

Static HTML tutorial for the user-memory feature. Serve it locally and drive it
with the extension side panel:

```bash
python3 -m http.server 8765 -d test/memory
```

Then open `http://127.0.0.1:8765/`. The page walks through `/memory --add`,
form-derived learning, normal auto-learning, replaying saved memories into a
later form, and Profile auto-fill.

### Native browser dialogs

`node --test test/browser-dialogs.mjs` covers dialog responses, per-tab ownership,
Stop/abort, retained Dev sessions, and protocol races (included in `npm test`).
`node test/browser-dialogs-e2e.mjs` uses installed Chrome through Playwright to
verify real alert/confirm/prompt and beforeunload continuation.

`node --test test/cdp-worker-restart.mjs` checks recovery of an extension-owned
debugger after its service-worker heap is replaced. The installed
`node test/quality/cdp-worker-restart-mv3.mjs` verifies the actual Chrome API with
two owned extensions, including rejected foreign-namespace commands and
preservation of the foreign debugger. Both are included in `npm test`.

`node --test test/chat-pending-reconciliation.mjs` checks uncertain-send
reconciliation through the actual Chrome and Firefox confirmation cards and
Agent. An uncertain send without fresh native delivery evidence requires a
manual, one-use answer for the exact pending message; automatic answers and
stale task, provider, thread or run ownership are rejected. Normal sends clear
their pending state after fresh native delivery verification. This paired test
runs by default.

### Real-time native chat soak

`node test/quality/native-chat-soak.mjs` runs the installed Chrome extension
for 60 actual minutes against an isolated native Telegram fixture and local
deterministic provider. It exercises real `chrome.alarms`, two actual service
worker restarts, Stop/Continue during inference, delivery deduplication and
final completion after resume. No external messages are sent. This optional
long run is outside `npm test`; set `WEBBRAIN_SOAK_MINUTES` to 3..180 for a
different wall-clock duration. Evidence goes to `WEBBRAIN_QUALITY_ARTIFACTS`
or the default ignored quality artifacts directory.

For finite-context compaction and restart verification, use
`WEBBRAIN_SOAK_CONTEXT_WINDOW=64000`, `WEBBRAIN_SOAK_MAX_OUTPUT_TOKENS=512`,
`WEBBRAIN_SOAK_MINUTES=3` and `WEBBRAIN_SOAK_SEED_PRIOR_HISTORY=1`. The seed
contains complete owned read-only tool groups. The runner checks that actual
compaction preserves the task and newest tool group, and records request size
including tool schemas; its character estimate is not a provider tokenizer.

### Installed workflow, media and watch checks

`npm run test:quality:workflow` teaches an owned native form, compiles and
exports/imports the workflow, then replays exact private parameters in a fresh
document. It checks reused IDs, Stop, late consent and uncertain writes.
`npm run test:quality:media` exercises the native side panel, owned Comfy queue,
exact downloads, IndexedDB recovery after a real worker restart, cancellation,
and per-tab drafts. Both installed checks are in the default suite.

`npm run test:quality:whatsapp` runs fifteen serial installed-extension cases
against an owned native WhatsApp fixture. They cover fresh canonical contact
identity, grouped incoming messages, opaque-ID delivery, real worker recovery,
Stop, steering, peer changes, lost document/baseline evidence and late contact
drawer results. It also verifies that an exact draft read cannot authorize a
send through an old snapshot, and exercises manual pending-send recovery.
The paired bootstrap regressions use the actual native editor's generic
placeholder and title-control structure, while rejecting the surrounding
header, avatar, call, search, menu and Send controls before contact identity
is established. `test/whatsapp-native-bootstrap.mjs` runs by default in both
browser engines; the installed bootstrap case follows the exact repair
reference through a fresh scoped accessibility read and guarded native click.
`test/whatsapp-drawer-identity.mjs` also runs in both engines. It preserves
unchanged native phone/name witnesses through decorative Close and media
updates, while rejecting changed/replaced identity fields, hidden drawer reuse
and removal without the guarded native Close action. The installed matrix
includes the corresponding asynchronous visual updates.

`test/whatsapp-read-latest.mjs` verifies a canonical conversation genuinely
showing older history. The public observation and predispatch refusal provide
an exact native message-pane reference for a scoped AX read and bottom scroll.
A fresh observation must establish the latest-position baseline before any
send; the repair hint cannot create a floor, clear uncertain delivery or widen
recipient/task authority. The installed `native_scroll_latest` case repeats
the grounded 49-row, 246.7-pixel history gap through the actual Agent.

`test/whatsapp-read-preparation.mjs` checks that the existing bounded AX capture
before inference includes only the current private native repair target when
one is needed. The installed `native_prepared_repair` case intentionally omits
extra model AX calls for official carrier, Close and historical message-pane
references, while still requiring a genuine fresh capture certificate and
rejecting Send before identity verification. Subsequent action, task, document
and recipient validation remain mandatory.

`test/run-ui-scheduled-lifecycle.mjs` checks production journal/background
lifecycle and current sidebar completion predicates in both browser sources.
The shared applied-steering boundary prevents a prior task's success or error
from classifying a corrected task. It preserves historical events, uncertain
action receipts, quota/persistence blockers and fresh verified recovery success.
The Scheduler callback cases test defensive accounting; public scheduled runs
retain their independent execution policy.

The runner records source hashes and rejects a source change during the
matrix. The matrix and paired native/contact/bootstrap/drawer/completion
regressions are in `npm test`; no external messages are sent.

`npm run test:quality:watch` runs approximately three minutes using actual
30-second Chrome alarms, distinct and duplicate events, a real worker restart,
Stop and consecutive failures. This elapsed-time check is optional; its paired
checkpoint and terminal Stop/steering regression suite runs by default. These
checks use isolated profiles and owned services, without external messages,
new accounts or paid generation.
