# Privacy & Data Flow

---

## What Leaves the Browser

### LLM Provider Requests

The user's message, the current page content (AX tree, screenshot, or extracted text), and the tool-call history are sent to the **configured LLM provider** on every turn.

| Data | Sent to provider? | Notes |
|---|---|---|
| User's chat message | Yes | This is the core feature — the user typed it |
| Page URL + title | Yes | Injected into the first user message for context |
| Page content (AX tree / extracted text) | Yes | The agent reads the page to act on it |
| Viewport screenshot | Yes | If the provider supports vision (or a dedicated vision model is configured) |
| Tool call history | Yes | Previous tool results are context for the next LLM call |
| User memory | Yes, if enabled | Active records are injected into the system prompt; disabled memory is not sent |
| User credentials (passwords, API keys) | Yes | If the user types them in chat or the agent fills them and they appear in tool results |
| Provider API key | Yes, when applicable | Sent as an HTTP header to endpoint-based providers; the in-browser WebGPU provider has no key or endpoint |

On Google's sites the account control in Google's bar names the signed-in person. Text reads of the page (the accessibility tree, tool results, link and element lists, and the element list sent with a screenshot) call it `Google account` and keep only the origin and path of its link; see [signed-in account chrome](accessibility-tree-and-refs.md#signed-in-account-chrome). The screenshot image and the page title (Gmail's includes the account's address) are sent as they are.

When **Plan before Act** is enabled, action-mode turns (Act or Dev) make an additional planner
call to the same configured provider before any browser tools run. That call
contains the user's task, sanitized page URL/title, a short recent-conversation
digest, and the planner system prompt. Image blocks are dropped before the
planner call; any screenshot text description is treated as untrusted context.
When a plan the user will read (a review card or a plan-only answer) comes back
without its copy in the user's language, one more call to the same provider
sends that plan's English summary, steps and risks to be translated.

When **User Memory auto-learn** is enabled, successful chat or continue turns may
make a best-effort background extractor call to the same configured provider
after the assistant response has already completed. That call includes only the
latest user text, the final assistant text, the current saved memory list, mode,
and success state. It does not include page/tool results, raw trace events,
screenshots, or attachment bodies. If the provider cost allowance is exhausted,
the extractor is skipped silently.

**No separate analytics payload is added to provider requests.** The request data above is sent only as needed to run the selected provider and agent features.

When either Chromium in-browser WebGPU path is used, first use downloads the
public model, tokenizer, and configuration files from Hugging Face. That
request contains only ordinary model-download metadata; screenshots, page
content, and conversation data are not included. The downloaded files are
cached by the browser, and both general text/tool inference and screenshot
inference stay on-device.

### Which provider receives the data?

The user chooses their provider on the Providers page (side panel provider picker → More…). Options include:

- **DIV Compass**: requests go through `api.webbrain.one`; selected interactions may be retained and used for evaluation, improvement, fine-tuning, and training while Help Improve DIV is enabled
- **Bring-your-own cloud providers**: OpenAI, Anthropic, Google Gemini, Mistral, DeepSeek, xAI, Groq, OpenRouter, etc. — requests go directly to the provider using the user's credentials; DIV receives a separate research copy only if the user enables that provider's **Share queries for research** switch
- **Local model runtimes**: llama.cpp, Ollama, LM Studio, Jan, vLLM, SGLang,
  LocalAI, GPT4All, and Unsloth Studio — inference requests stay on the user's
  machine when Studio is configured with its loopback URL
- **WebGPU (In-browser), Chromium only**: the selected text model runs in an extension
  Worker with no API key, base URL, localhost server, or model endpoint. In Ask,
  a model that reads images also gets a screenshot of the visible page when its
  own on-device readout says the question needs it (not in Strict Secret Mode);
  it stays in the browser and is not saved with the chat (the stored question
  only notes that one was used, so a follow-up can look again)
- **Local OpenAI-compatible Proxy**: DIV connects only to the configured
  local gateway, but the gateway may forward the request context to an upstream
  account. Its configuration and privacy policy determine where data goes.

Local-model and bring-your-own API requests do not pass through DIV Compass. A separate, per-provider research-sharing switch is off by default; when enabled, bounded copies and diagnostic metadata are sent to DIV as described below. DIV Compass requests are processed and may be retained separately.

### Optional research escalation to ChatGPT

Research escalation is **off by default**. A user must enable it under
Settings → General before either `delegate_research` or its consent step is
available to the model. When enabled, DIV may propose sending one unusually
complex, read-only research request to ChatGPT. The consent card shows the exact
prompt, puts the continue-locally choice first, and requires the user to select
the explicit approval choice. A timeout, automatic selection, typed variation,
or prior approval does not count. Each approval creates a tab- and
conversation-scoped, single-use authorization that expires after five minutes.

After approval, DIV opens `https://chatgpt.com/` in a visible helper tab
and types only the displayed prompt. DIV does not separately transmit
ChatGPT cookies, credentials, API keys, browsing history, attachments, user
profile, or undisclosed source-page data; any context sent to ChatGPT must be
visible in that exact prompt before approval. The browser may use the user's
existing ChatGPT session in the normal way. The safety policy also forbids this
path for private or sensitive data, purchases, bookings, mutations, account
actions, or high-stakes decisions. Users should still inspect the displayed
prompt before approving it.

ChatGPT receives and processes the approved prompt under the user's ChatGPT
account and OpenAI settings and policies. DIV reads the resulting answer
and source links from the visible page, labels them as untrusted research
evidence, and sends that tool result to the user's configured primary LLM as
part of the ongoing turn. The primary model is instructed to verify decisive
facts instead of treating the delegated answer as instructions or proof.

If ChatGPT is logged out, blocked by a network or regional policy, redirects
off the approved origin, changes to an unsupported page layout, or does not
answer before the configured wait limit, the delegation fails and DIV can
continue locally. Visible Log in or Sign up controls fail closed even when
ChatGPT also offers a guest composer; the approved prompt is not submitted
without a logged-in composer on the fixed ChatGPT origin. Stop, closing the
helper tab, or closing the source tab cancels the helper run; the source tab is
checked again before submission. The helper tab is left visible for inspection
on login, layout, or timeout failures. Turning Research escalation off removes
both the delegation tool and the Ask-mode consent schema from later model
requests.

### Decision models and completion verification

Providers → Decision has three decision-model modes. **Auto** (the
default) sends nothing anywhere new: it uses D1 on the device once D1 is
downloaded (with its explicit consent, on the Providers page or from the Chrome
install guide), for completion and scheduled checks only, whatever the
conversation provider. While Compass is the conversation provider, Compass's
managed Cloud decision route answers semantic decisions as before, and
completion checks too until D1 is downloaded. With neither, no decision model
is used. A downloaded chat or vision model never enables decisions.
**Off** uses none, Compass's included.
**On** selects OpenRouter, TypeSafe, a local/custom System One endpoint, D1 or
the in-browser chat model; completion verification, watch checks, scheduled
completion checks, classifications and browser decisions share that selection,
each with its own switch (on unless turned off), while semantic decisions
always use the selected provider.
Existing TypeSafe credentials, opted-in features and scheduler thresholds are
retained: a profile saved before modes with System One enabled reads as On with
its previous switches. With Compass active, On still uses Compass's managed
route unless D1 or the in-browser chat model is chosen.

Each turn the user sends from the side panel also
asks the configured decision model one `run_mode` question: the text of that
message, the previous turn's mode and the user's earlier task in the
conversation. The same request asks `plan_need` (whether an action turn needs
a written plan) about the same data, so it sends nothing more. No page text,
title, address or screenshot is included, and the
question is asked only when a message is sent, never while it is typed. Without
a decision model the turn starts in Ask; only when the active model asks to
hand the turn to Act or Dev is the same page-free question sent to the active
model to confirm it.

The experimental **in-browser chat model** decision provider (Chrome) runs
decisions on the already downloaded WebGPU chat model in the offscreen
worker. Its state, questions and screenshots never leave the browser, and it
downloads nothing beyond the chat model itself.

The optional experimental **D1 WebGPU** decision provider has no inference
endpoint or API key. Its bounded text/JSON state, questions and inline screenshots
stay in the local decision Worker. Explicit download consent permits only pinned
ONNX/config/tokenizer downloads (about 0.95 GB) from Hugging Face, verified against
the packaged manifest and checksums. The full FP32 checkpoint stays in the
separate FP32 repository for external reproducibility; the browser never
downloads it. JS/WASM stays bundled with the extension. Cache and
consent are local and device-bound; no download is triggered by a decision call.
Usage traces use the existing bounded model/provider/token/cost metadata, not an
additional copy of D1 state or pixels. Existing separately configured trace and
research-sharing policies remain applicable.

A local decision provider does not make the main conversation provider local.
In particular, D1 cannot be the sole positive completion authority: verification
continues to the active LLM or existing checks. An active cloud LLM can still
receive the existing bounded task and redacted screenshot/AX evidence through
that fallback. Selecting D1 does not bypass Strict Secret Mode or consent,
cancellation, permissions, recipient, payment, authorization or workflow gates.

Successful action-mode `done` and `done_json` attempts send bounded original task,
requirements, recent action/read evidence, document identity and fresh redacted
pixels (when supported) or AX to the selected judge. Page content and pixels are
untrusted data; an agent success summary is not proof. Text is bounded by
serialized UTF-8 bytes; screenshots use the configured capture/redaction budgets.
Recorded actions carry only their tool names, the `ref_N` target each named
and app-owned booleans (verified, failed, credential field), never other
arguments or entered values. A value of four characters or more that the
current run entered into a password input, as the entry tool's own result
reports the field, is masked in all judge evidence text while the conversation
still holds that entry: as typed, as the accessibility tree prints it once a
"show password" control reveals it (normalized, trimmed and cut to 60
characters), line by line, and escaped. Values entered into other fields,
including fields DIV flags as credentials such as a one-time-code box, are
not masked: the page shows them, and judges compare them with the request.
Screenshots are not masked this way; a password input shows only dots. The
active conversation model already holds the task, approved plan and candidate
summary, so its own check receives every line of them, with addresses cut to
origin and path, bearer tokens hidden and entered passwords masked. A decision
provider that stays on this device (Local Kev on a loopback address, or D1), or
Compass's managed Cloud decision route while Compass is the conversation
provider, receives that same copy. Any other decision provider receives those
texts with every line that names a credential removed; when that removal leaves
it without the task or plan while the active model can judge, it is not asked.
Page evidence is redacted the same way for every judge: each line naming a
credential is removed, and a credential field's accessibility line keeps at
most its role and ref.
Local Kev uses `/v1/systemone`, requires no key by default and works offline.
Keys stay in local storage; config exports include them in plaintext.

If automatic page or iframe updates would discard a terminal Ask reply, a
ten-second dependency check can send the current user task, qualified prior
conversation text and the exact candidate answer to the active conversation
provider. It uses that provider's normal cost, cancellation and privacy controls;
it does not change the selected decision provider. An exact answer's result is
cached only within its current task/run/provider/document scope. This check
cannot authorize a browser action or retain an answer after a user correction.

Decision requests have a five-second deadline and no transport retries; dedicated
tool-free LLM checks have ten seconds. Visual uncertainty or unsupported images
tries AX. Authentication/transport failures fall through to the active LLM, then
existing checks. Confident pending/failed verdicts require recovery. Quota,
cancellation and cost limits stop the run. Verdicts are bound to task, run, latest
action, document, evidence digest and model configuration. A matching fresh verdict
can be reused for scheduled completion without another model call. Generic
publication can be verified despite an unrelated comment form; recipient, payment,
download, authorization and workflow contracts remain required. Future votes and
moderation outcomes are not certified.

GitHub release verification may read the exact saved release's edit form with a
bounded authenticated same-origin GET to compare its tag, title and raw Markdown
notes with the reviewed form. These values remain in private execution state;
verification diagnostics contain predicate names and status only. This readback
does not submit or republish the release.

The Cloud decision endpoint logs route, model, modality, latency, outcome, usage
and fallback reasons without raw screenshots or page evidence. Consent and
privacy-key selection follow the existing Compass policy. Reported decision cost
is accounted separately, with configured rates as fallback.

### Scheduled decision checks

In On, the watch and scheduled-completion switches are on unless turned off; a
profile from before modes keeps them as separate opt-ins. Auto checks both with
the downloaded in-browser model only. Changing the mode preserves the switches;
Reset returns to Auto, deletes keys and resets those scheduler thresholds to 70%. Config import/export retains the original
`systemOne*` and `typesafeApiKey` keys together with new decision settings.

The scheduler sends bounded textual task and allowlisted tool observations to the
selected endpoint, plus a bounded real previous observation for watches. Legacy
TypeSafe uses `https://api.typesafe.ai/v1/systemone`, model `jev-1.13.0`. Scheduler
sidecar state excludes agent success summaries, full history, screenshots, audio,
attachments, raw request bodies and credential fields. Text is redacted and wrapped
as untrusted data. Actions invalidate earlier observations. Missing evidence skips
the check. Ordinary page text may contain personal data, so enabling outsourcing
authorizes sending that limited evidence to the selected endpoint.

The scheduled sidecar only downgrades an existing success. A low read-only watch
judgment permits another poll. Dispatched actions or uncertain outcomes retain
their record and require reconciliation instead of automatic repetition. Existing
scheduled-check deadlines and 429/529 retries remain unchanged. Connection tests
run only on button press and never retry; image-enabled tests additionally check
two synthetic images. Reported cost takes precedence over configured model rates.
Legacy TypeSafe input is estimated at $0.042 per million tokens with free output.
Usage/model/reason metadata enters accounting and traces without raw evidence.
Strict Secret Mode disables judging; offline loopback decisions remain available.

### DIV Compass improvement data

Help Improve DIV is available under Settings → Advanced and is
on by default. When it is on, DIV may retain eligible Compass prompts, model
responses, relevant page text, tool calls, browser-agent actions, feedback, and
task outcome information for evaluation, development, improvement, fine-tuning,
training, safety, and browser-automation research. Screenshots and uploaded
images may be processed to answer the request, but image bytes, base64 media,
and image URLs are excluded from DIV's improvement database. The extension
sends the current preference, stable conversation id, and an allowlisted
generation label with every DIV Compass model request. It never attaches
those collection fields to local or bring-your-own providers.

For DIV Compass only, an enabled Help Improve preference also allows the
extension to retain one bounded terminal tool call/result and the final run
status in a local durable outbox until the Compass improvement endpoint
acknowledges it. Delivery is retried on a later Compass run after transient
network/server failures. The outbox is not created for local or bring-your-own
providers, and disabling Help Improve stops new terminal records; any older
queued records are sent with the disabled preference so the server discards
them and the client can remove them.

Current clients explicitly send `X-DIV-Help-Improve: 1` or `0`. Older
DIV Compass clients that send neither the preference header nor a session id
are treated as using the default-on setting. The Compass service derives a
best-effort opaque legacy session from the device and the first user message;
the raw device and prompt-derived fingerprint are not stored or sent upstream.
Repeated identical opening messages can be grouped together, and compaction can
split a legacy conversation, so current clients' explicit conversation ids are
authoritative. Users of older clients must install the latest client to disable
future collection under Settings → Advanced.

An explicit `0` is always opted out. Once any explicit opt-out reaches a
derived or client-provided session, the Compass service permanently marks that
opaque session ineligible. Turning the setting back on applies to the next new
conversation; it cannot make the current conversation eligible again.

Help Improve-off content is not retained in the improvement database and is
routed through an OpenRouter workspace where content logging is disabled. This
does not prevent the minimal metadata-only operational logging required to
provide the service, enforce quotas, prevent abuse, maintain security, or debug
failures. Requests sent to local models or directly to providers using the
user's own credentials never pass through DIV Compass for inference. They
are not collected by DIV unless the user separately opts in to that
provider's research sharing.

For eligible completed generations, MySQL is DIV's canonical store. The
service strips media, compresses the request/response payload, encrypts it with
AES-256-GCM, and stores it with an opaque HMAC session id. Interrupted streams
and failed generations are not stored as generation content. Separately,
eligible terminal-runtime envelopes are de-identified, encrypted, and stored
idempotently so evaluation can distinguish provider export gaps from actual
execution outcomes. Eligible requests
also use an isolated OpenRouter workspace with private Input & Output Logging
enabled as a redundant review copy. OpenRouter documents a minimum retention of
three months and says data may be retained longer unless deletion is requested.
Its separate **Use Inputs/Outputs** training/discount option remains disabled.
OpenRouter logging is not treated as permanent storage or an image backup. See
[OpenRouter Input & Output Logging](https://openrouter.ai/docs/guides/features/input-output-logging).

Before retained Compass interactions are used for model development, DIV
applies technical measures designed to remove or mask direct identifiers,
credentials, secrets, and other sensitive information. Raw Compass interactions
selected for improvement are retained for no longer than 12 months before
deletion or de-identification. De-identified datasets may be retained for up to
5 years for model development, evaluation, security, and reproducibility.

### Voluntary external/local provider research sharing

**Share queries for research** is off by default for each local or bring-your-own
provider. If the user turns it on, DIV sends a bounded copy of that
provider's model-facing request and response to the Compass improvement service.
It also sends a bounded diagnostic timeline for model-attempt runs, including
failed ones: steps, tool names, outcomes, error codes, and timings. A failed run
may include its bounded model-facing request and displayed blocker even when no
response was produced. Screenshot and other binary bytes are stripped; raw tool
arguments and results are not included in the diagnostic timeline. Text in the
shared conversation can still contain sensitive personal information after
truncation and automated de-identification, so users should not enable this
switch for content they do not want to share.

The extension records a local trace for an opted-in run even if the separate
Record traces switch is off. The upload projects only metadata from that trace,
even when Record traces also keeps its full request details locally. Research
shares use a durable, revocable local outbox and are retried after temporary
delivery failures; the provider's live sharing consent is checked before each
send. The Compass service admits these records only under explicit
share-session consent, de-identifies and encrypts them, and applies its
improvement-data retention rules. They are not counted as Compass inference
requests.

---

## What Stays in the Browser

### Conversation History

Stored in browser session storage: `chrome.storage.session` on Chrome and
`browser.storage.session` on Firefox. Per-tab provider history
(`agentConv:<tabId>`), rendered chat (`tabChat:<tabId>`), and the detached-run
UI journal (`runUi:<tabId>`) let a panel/sidebar close, reload, or background
restart restore the conversation and an in-progress run. The UI journal keeps
a bounded event window plus separately bounded accumulated streamed text so
in-progress Markdown can be reconstructed after reconnect. Relevant
conversation content is sent to the configured provider as request context;
the stored copies are not separately synced to DIV.

### Trace Recorder

**Local feedback diagnostics** is enabled by default under Settings → Advanced.
When ordinary trace recording is off, it retains metadata-only diagnostics for
up to ten completed runs, seven days, and 2 MiB (with a 128 KiB per-run cap).
These automatic records never inherit lossless tracing and contain no raw
conversation/tool text or screenshot bytes. Turning the setting off stops this
recording and removes its automatic history; explicitly recorded traces remain.
Retention and event-budget omissions are identified in feedback exports.

When enabled (Settings → Advanced → "Record traces"), every agent run is written
to the local `webbrain_traces` IndexedDB database with its full request details
(the lossless tier below); one switch turns both on or off. An external/local
provider with **Share queries for research** enabled also records its run
locally for the bounded diagnostic upload, even when Record traces is off; such
runs use the metadata-only tier:

- **Metadata-only tier.** This is the default tier for runs recorded while
  Record traces is off. The `runs` store keeps run identifiers and
  lineage, model/provider identifiers, token and event totals, timestamps,
  status, and the allowlisted runtime snapshot. It omits the user's message,
  final assistant text, full tab URL/title, and attachment filenames. The
  `events` store keeps allowlisted diagnostic fields such as event kind, step,
  counts, timings, usage, finish/status/error codes, called tool name and
  outcome status, and screenshot marker/caption. It omits raw LLM
  request/response text, tool schemas, tool arguments/results, and error
  messages. Metadata-only traces do not write screenshot blobs or data URLs to
  the `shots` store.
- **Lossless debug tier (opt-in, through Record traces).** Record traces adds user/final
  text, bounded request messages and tool schemas, model responses and tool
  calls, tool arguments/results, detailed errors, screenshot bytes, tab
  URL/title, and attachment filename metadata. Lossless payloads have
  per-request, per-result, per-run, and aggregate storage bounds; old completed
  lossless runs may be evicted to remain within the aggregate limit. These runs
  are visibly marked in the Traces UI. Full request details used to have a
  switch of their own; on update, an install that recorded traces without them
  has them turned on once, so the single switch matches what is recorded.

`click_ax_timing` trace notes retain only bounded stage durations, input-event
counts, outcome categories, and safety-status booleans. URL, target labels,
accessibility references, and other page content are excluded in both tiers,
including lossless traces.

`predispatch_timing` trace notes retain only bounded per-stage milliseconds of
one tool call's pre-dispatch pipeline, the tool name and an outcome category.
`publication_prefetch` notes retain only a status label and a duration. Page,
draft and model content are excluded in both tiers, including lossless traces.

`done_timing` trace notes retain only the milliseconds a completion check spent
preparing its evidence, reading the page's status texts and reaching a verdict,
with the verdict's outcome and engine names. Completion verification attempts
in `system_one` notes retain the engine, modality (`vision` or `ax`), outcome,
a reason code and their capture and evaluation times; a model's own words, the
probabilities, the task, the summary and page content are excluded in both
tiers, including lossless traces.

Default trace redaction does not disable `/workflow --save`. While a traced run
is active, the recorder keeps bounded raw tool payloads in memory only. On
successful completion, the agent immediately compiles them into the existing
value-free saved-workflow schema: typed values and historical element references are
removed, URL data is reduced to origin/path families, and inputs become runtime
parameter placeholders. Only that sanitized temporary draft is added to the
already session-scoped `agentConv:<tabId>` recovery record. It is cleared with
the conversation and becomes a durable saved workflow only after the user runs
`/workflow --save <name>`.

The Traces page (`ui/traces.html`) reads from local IndexedDB only. Export saves
a local file to the user's Downloads folder; trace recording itself makes no
network request. Both Markdown and JSON export paths mask credential-shaped
values in lossless structured data, but screenshots and remaining page/chat
content can still be sensitive. Lossless recording is off by default.

The projection applies to newly recorded rows. Historical trace rows are not
rewritten during an update, so a user upgrading with existing traces
should treat those rows and their exports under the retention behavior of the
version that recorded them, or delete them from the Traces page.

Each run also records an allowlisted effective runtime snapshot (including mode
and prompt tier). Trace Markdown surfaces that snapshot and the privacy-safe
request provenance so mode/prompt mismatches can be diagnosed without exporting
the full private prompt payload. Policy revisions change with controlled
prompt/tool rules, not with private request content.

### Saved Workflows

`/workflow --save <name>` promotes the latest successful value-free draft (or
uses a compatible legacy/lossless trace as a fallback) into a separate
`webbrain-workflow/1` record in browser local storage
(`wb_saved_workflows_v1`). The saved record contains action names, sanitized
arguments, semantic target descriptors, URL origin/path families,
postconditions, and parameter descriptors. It does not contain typed field
values, raw historical `ref_id` values, action CSS selectors, coordinates, URL
query strings, or URL fragments.

`/teach --start <name>` records a user demonstration in temporary,
tab-scoped session storage. The page capture code never reads field values:
it sends only the field's semantic identity, and the compiler immediately
represents that action as a runtime parameter. Click/field target labels and
sanitized URL origin/path families are retained because replay needs them to
find the same controls. `/teach --end` removes the temporary session whether
compilation succeeds or fails; a successful compilation writes the same
`webbrain-workflow/1` format described above.

`/workflow --run <id>` collects declared values in a temporary side-panel form
and sends them directly to the background replay executor. The values are not
written to the workflow, chat text, retry payload, user memory, replay trace,
or Agent fallback prompt. They necessarily reach the active page when the
requested field action runs. A lossless or legacy source trace may still
contain the original raw tool arguments; saving a workflow does not delete or
redact that separate trace.

Replay traces contain workflow/step IDs, semantic match status and score,
postcondition status, fallback status, and estimated model calls saved. They do
not contain runtime parameter values or freshly resolved element references.
If a saved locator stops matching, DIV may show sanitized semantic target
descriptions for the user to choose from. It never selects or persists a
replacement automatically: the user must explicitly choose it, the attempted
action must pass its saved postcondition, and the workflow must still be the
same version. The temporary live `ref_id` is never written to storage. A field
repair can upgrade its runtime parameter to sensitive (for example, when the
new target is a password field), but it can never downgrade that protection.
If deterministic replay cannot safely continue, a fallback Agent receives only
saved metadata and must ask the user again for any still-needed value.

### New Tab Page

The new tab page (`docs/newtab.md`) makes one network request of its own, the DIV
bulletin check (item 11 below). Apart from that: backgrounds
are bundled, there are no fonts, favicons, link-title lookups, weather, quotes or
analytics requests, and no error reporting. Custom backgrounds are images you upload;
they are stored in the browser and never leave it. The exceptions are things you
choose: if you give a quick link or app link a custom icon URL, enter custom CSS that
references remote resources (`url(...)`, `@import`), or import settings that point a
background at a URL, the page loads them from the addresses you gave, each time it is
shown. Links without a custom icon use a local letter tile; nothing is looked up. Whether the page is shown is a single local flag (`newTabEnabled`), off until the user ticks the onboarding checkbox or turns it on in Settings; it is never sent anywhere.

Its settings, quick links and uploaded backgrounds stay in the browser under a separate
`wbnt:` prefix. Text typed into its box is held briefly in extension storage (one
record per tab) to hand it to the side panel and removed once claimed. A record that is
never claimed is ignored by the panel once it is older than a couple of minutes, but it can
stay in `storage.local` until the next submission from that tab replaces it, the tab is
closed, or the browser starts again (one written in the ten seconds before a crash waits for the start after that); a task handed back to its tab (for example after a tab
switch mid-send) is kept the same way until it is delivered. **Search** mode uses the browser's own
default search engine, so a query typed there goes to that engine as it would from the
address bar.

### Settings

Provider configs (API keys, base URLs, model selections) are stored in `chrome.storage.local`. API keys are in plaintext — this is a personal-computer tool and the storage is sandboxed by the browser. The extension has no mechanism to exfiltrate these keys.

### User Profile

If the user enables profile auto-fill, the profile text (name, email, throwaway password) is stored in `chrome.storage.local` in plaintext and sent to the LLM provider as part of the system prompt on every turn.

### User Memory

Saved user memory records are stored locally in `chrome.storage.local` /
`browser.storage.local` under `wb_user_memory_v1` in plaintext. Records are meant
for user-stated durable preferences, stable profile hints, and recurring
workflow preferences. DIV rejects obvious secrets and credential-like text,
but users should not store passwords, API keys, tokens, recovery codes, or other
sensitive secrets as memory.

When user memory is enabled, active records are appended to the agent system
prompt as a bounded block. Settings → Memory controls whether memory is
enabled, whether optional auto-learning runs after completed turns, and the
maximum prompt characters injected. `/memory --add <text>` writes an explicit memory
immediately without an extractor call. Export/import JSON is local-only and is
the v1 bridge for moving memory between browser profiles.

### Configuration Snapshot Transfer

An optional MemCode connection is documented in [MemCode recall](memcode-recall.md).
It is disabled by default and separate from local user memory. When enabled,
short agent-selected search queries go to MemCode, and returned memories can be
sent as untrusted tool context to the configured LLM provider. OAuth tokens stay
in extension-local storage outside portable configuration snapshots; disconnect
removes them locally. No local memory is automatically uploaded.

`/export --config` creates a local plaintext `webbrain-config/1` JSON file, and
`/import <json>` or `/import --file` reads that snapshot locally before writing
the validated Settings values to extension storage. The snapshot intentionally
includes provider, vision, transcription, and CAPTCHA provider API keys as well as
profile text, user memory, custom skills, and saved permission choices. Users
should treat the file like a credential backup and store it securely.

The snapshot does not include device-bound Cloud Sync authentication/session
state, the DIV Compass device ID, conversations, traces, scheduled jobs,
usage counters, or accumulated spend. Import does not upload the JSON to
DIV Compass or to the configured LLM provider.

### Optional Encrypted Cloud Sync

Active DIV Compass subscribers may explicitly enable encrypted profile sync in
Settings → Memory. The extension combines user memory, profile autofill, and provider
configuration (including API keys, but excluding legacy OAuth access/refresh
token stores) into one vault. Chromium-only WebGPU provider configuration and
selection remain device-local so a Firefox sync cannot replace that local choice.
The extension
encrypts it in the browser with AES-256-GCM. Its key is derived from the sync
password with PBKDF2-HMAC-SHA-256 (600,000 iterations). The password and derived
key are retained in memory only for the browser session.

DIV Compass receives ciphertext, cryptographic/version metadata, and three
counts supplied by the extension with each vault upload: configured portable
providers, saved memory records, and whether the freeform profile text is
nonempty (0 or 1). These counts support the authenticated admin stats page;
provider names, memory text, profile text, and API keys remain inside the
encrypted vault. Older vaults have unknown counts until a newer extension syncs.
DIV Compass cannot decrypt the vault or recover a forgotten password.
Authentication uses a separate email-approved, scoped token; the billing device GUID alone cannot read
a vault. Sync is off by default, local writes continue while locked or offline,
and chat history, traces, tasks, permissions, and extraction queues are excluded.

### API Shortcut Observer

The background script keeps a small in-memory buffer of same-tab XHR/fetch
metadata: URL, HTTP method, and timestamp for the last 40 observed requests per
tab. It is used only when loop detection sees repeated clicks, so the agent can
suggest the exact matching `fetch_url` call instead of clicking again. Request
bodies and response bodies are not captured. The buffer is deleted when the tab
closes, and no observer data leaves the browser unless a loop warning surfaces
the URL + method to the active LLM conversation.

### Experimental WebMCP

WebMCP is on by default. A user can disable **Experimental WebMCP** under
Settings → Bridge to prevent DIV from sending its tool schemas
or prompt guidance to the configured LLM. On supporting Chrome pages, DIV
can enable the experimental CDP `WebMCP` domain. Chrome reports the structured tools registered by the current page,
including their page-supplied name, description, input schema, annotations, and
registration frame. DIV keeps a bounded in-memory per-tab catalog, assigns
opaque `wmcp_*` IDs, and removes it when the conversation/tab CDP session is
cleaned up. The catalog is not uploaded separately, but catalog fields and tool
results enter the ordinary conversation context when the model calls
`list_webmcp_tools` or `execute_webmcp_tool`, so they are sent to the configured
LLM provider like other page content. They are always wrapped as untrusted page
data. Turning the setting off closes active WebMCP sessions. Firefox does not
support this path.

---

## Telemetry / Analytics

The extension does not include an analytics SDK or crash-reporting SDK. Opt-in
research sharing uses separate improvement endpoints; it is not general product
telemetry. When DIV Compass is selected, the model
request itself goes to `api.webbrain.one` and is subject to the Compass data-use
terms above. Operational request metadata is retained separately for quota,
security, abuse prevention, and debugging.

The only outbound HTTP requests are:
1. **DIV Compass model calls** to `https://api.webbrain.one/v1` (when DIV Compass is selected; the Help Improve DIV preference is sent with each request)
2. **Other LLM provider API calls** (directly to URLs the user configured)
3. **CAPTCHA provider API calls** (only for enabled services, or an explicit balance test)
4. **Content fetches** via `fetch_url` / `research_url` tools (to URLs the agent is asked to fetch)
5. **Skill tool calls** (to the HTTPS endpoint(s) declared by network-capable enabled skills — see "Bundled Skills" below; the default email verification-code helper declares no endpoint)
6. **User memory extraction calls** (only if auto-learn is enabled; sent to the configured LLM provider after a completed turn)
7. **Encrypted Cloud Sync calls** to `https://api.webbrain.one/v1/sync` (only after a subscriber explicitly enables sync; vault content is encrypted before upload)
8. **Slash-driven tab/screen recording** creates no outbound traffic (the .webm is saved to the Downloads folder via `chrome.downloads.download`)
9. **Voluntary research shares** to `https://api.webbrain.one/v1/improvement/generations` and `/v1/improvement/diagnostic-traces` (only for a local or bring-your-own provider with its separate sharing switch enabled)
10. **Feedback trace attachments** uploaded by GitHub's native issue editor,
    only after the user chooses **Upload trace and open GitHub** in the extension.
    Preparing, viewing, and downloading the trace are local operations. The
    attachment includes only recordings preceding the opening of the rating
    prompt; later turns and screenshots in the same conversation are excluded.
    The confirmation identifies the conversation, recorded content tier, run and
    screenshot counts, size, and any fallback or omissions. GitHub makes the
    attachment publicly accessible immediately, before the issue is submitted.
    **Continue without trace** uploads no trace. Export scrubs credential-shaped
    values, but conversation/page text and screenshots can still be sensitive.
    Temporary exports expire after one hour and are removed after completion,
    cancellation, or closing the destination tab. Failed handoffs can retry the
    same authorized bytes. Full traces that exceed the attachment limit use an
    explicitly disclosed diagnostic fallback; the original stays available as
    a local download.
11. **DIV bulletins**: a `GET` of a fixed static file on `https://webbrain.one`, with no
    cookies, referrer, query string or identifiers. The new tab page reads
    `/newtab-comm.html` at most once every 10 minutes per browser (only while the new tab is
    shown); Apocalypse Mode pages read `/apocalypse-comm.html` when they open. Both files ship
    empty, and an empty file shows nothing. Published markup is shown in a sandboxed frame
    under a restrictive Content Security Policy that cannot run scripts or load external
    subresources. See `docs/newtab.md` (DIV bulletin).

The `webRequest` API shortcut observer is on by default and does not
create outbound requests; it observes replay metadata for requests
the page already made so repeated UI mutations can be diagnosed.

### Bundled Skills

Two built-in skills are enabled by default and can be removed independently in
Settings → Skills. A removed default is remembered and is not silently restored.
Enabled means available on demand, not injected into every request. Mid/Full
runs send the configured LLM provider a small mode-eligible catalog containing
skill IDs, names, summaries, and optional canonical semantic intents (each
summary is capped at 200 characters; intents are capped at six 40-character
identifiers). The Act/Dev planner receives the same routing-only catalog so it
can select relevant skills before execution. Intents are semantic hints, not a
literal keyword matcher.
Full skill instructions and compatible tool schemas are sent only after
`load_skill` activates a relevant skill for the current run; active skills reset
before the next user turn. Compact sends no skill catalog, prose, or tools. Ask
catalogs only explicitly Ask-compatible skills and still filters out mutating
or download tools. Trusted recommended actions may preactivate their owning
skill, such as FreeSkillz for `download_public_media`. NYTimes/The Athletic
tabs also preactivate the enabled FreeSkillz skill for the current run so a
structured blocking `pageGate` can expose its site-scoped read-only fallback
without a second `load_skill` turn.

Trace records store the DIV version that created each run. Conversation
Markdown records the exporting version; trace Markdown records both the
exporting version and each turn's recording version, while trace JSON includes
`exportedByWebBrainVersion` plus the run's `webbrainVersion` when available.
Legacy runs without recording metadata are labeled as version unavailable.

The "FreeSkillz.xyz" skill (`skills/freeskillz-xyz.md`) is explicitly Ask/Act
compatible and declares
`read_youtube_transcript`, `fetch_nytimes_article`, `resolve_public_media`, and
`download_public_media` tools. When the model calls one of those tools,
DIV sends only the current or model-provided URL, plus declared options
such as transcript language, media kind, maximum height, or filename hint, to
the declared `https://freeskillz.xyz` endpoint over HTTPS — a first-party
service operated by the extension's developer, separate from the user's
configured LLM provider. The article fallback is limited to allowlisted
`nytimes.com` URLs (including The Athletic paths) and sends only that URL
without browser credentials or cookies. The transcript tool is limited to
YouTube/youtu.be URLs, while the media tools are limited to public media hosts
declared in the skill manifest. Mastodon status URLs must use HTTPS and a
known instance host or an instance verified through public NodeInfo metadata.
For unknown hosts, DIV first reads `/.well-known/nodeinfo` and its
same-origin metadata link without cookies or credentials, with redirects
blocked. Those checks do not include the post path, query string, or fragment.
Only the verified status origin and path are sent to FreeSkillz; Mastodon query
strings and fragments are discarded. The read-only article, transcript, and
resolver tools do not require
`/allow-api`; `download_public_media` is available only in action modes and
requires download permission because it creates a short-lived provider job,
saves the completed file through the browser Downloads API, and then asks the
provider to delete the job. These calls do not send page content, chat history,
or browsing history beyond the URL and declared tool arguments. Users can
remove this skill, or any user-imported skill tool, from Settings → Skills to
stop this data flow entirely.

The "OTP / verification-code helper (email)" skill
(`skills/otp-verification-code-helper.md`) is explicitly Ask/Act compatible,
and declares no external endpoint. It guides DIV's existing page-reading
tools to prefer selected text or a bounded, message-scoped accessibility-tree
subtree on the active run tab. On Mid/Full, and only after that exact skill is
active, one fixed internal tool may inspect an already-open signed-in supported
webmail tab. The runtime enumerates tabs locally but returns only a provider and
bounded service-matching previews with opaque message references; disclosure
requires the full normalized service identity or all sufficiently discriminative
service tokens. It does not send the tab catalog, mailbox URL, or accessibility
references to the model. A provider-verified already-open message is scoped and
read directly across the supported providers. If an inbox candidate must be
opened, the operation is unavailable in Ask because opening can mark the email
read. In Act/Dev it receives the normal click permission for the mailbox host,
clones the mailbox URL into a temporary inactive tab, consumes every exact bounded
message-scoped continuation or fails closed without paginating the wider mailbox,
and closes the clone.
That clone can make ordinary authenticated requests to the same webmail origin;
the helper does not call a mailbox API or external skill endpoint. Compact has
no such tool. The skill cannot read SMS, phone notifications, native apps, or
another device, and it forbids sign-in bypasses. When the user asks DIV to
read a code, the scoped page content and extracted code are included
in the normal request to the user's configured LLM provider as part of the
current conversation. When Record traces is enabled, the raw page-reading tool
result and model response are also retained locally in the `webbrain_traces`
IndexedDB database until the user deletes those traces; the skill cannot erase
conversation or trace history after use. Its instructions disclose that
retention before reading, treat message content as untrusted, honor Strict
secret handling, reject ambiguous numeric strings and recovery tokens, and
prohibit intentionally copying the code into scratchpad or user memory.

### Opt-in packaged skills

Additional packaged skills ship disabled until the user enables them in
Settings → Skills. When enabled and activated for a run, their declared HTTPS
skill tools may call third-party endpoints (for example Mail.tm, Open-Meteo,
Open Library, or Wikipedia). Those calls send only the tool arguments declared
in the skill manifest — not browsing history or unrelated chat — and treat
responses as untrusted unless the manifest says otherwise. Removing or
disabling a skill stops that data flow. See [Skills](skills.md#bundled-skills)
for the full packaged catalog.

The opt-in **Phone calls (Phonr)** skill uses ordinary `fetch_url` requests to
`https://phonr.xyz/v1`. The selected phone number, purpose, language, and optional
system message go to Phonr; Phonr uses its configured OpenAI and telephone
provider accounts to conduct the call and retain call history and configured
recordings. The bearer key is supplied by the user and included in tool arguments,
which can be present in the configured LLM conversation and enabled traces; this
skill does not provide a separate credential vault. Returned call details and
transcripts enter the conversation as untrusted data. The skill ships without a
key and does not send unrelated browsing content. POST requests keep DIV's
existing API-mutation permission gate; merely enabling the skill does not dial.

The packaged Wikipedia skill does not silently create an offline corpus.
Apocalypse Mode is disabled by default and requires a separate opt-in under
Settings → Advanced. Catalog browsing sends the selected archive language to
Kiwix; resolving an archive fetches its Metalink. Archive bytes are downloaded
only after a second confirmation that displays the exact size, date, source,
license notice, integrity pieces, and reported storage availability.

Downloaded or imported `.zim` bytes live in extension-owned OPFS storage by
default. Chromium users can instead select an external file through the File
System Access API; Firefox uses OPFS. IndexedDB stores only settings, archive
metadata, progress, retry state, and storage references (including a persisted
file handle where supported). Each downloaded piece is checked before writing.
Pause, cancellation, deletion, corruption, restart, and bounded retry states
are durable. A ready archive that becomes unreadable is marked as an error and
requires reinstall or re-import. Live Wikipedia results are not copied into this store. When an
installed archive answers a later request, only the relevant extracted passage
and its canonical Wikipedia attribution enter the normal untrusted tool-result
path and are sent to the user's configured LLM. See
[Apocalypse Mode](apocalypse-mode.md) for browser-specific limits.

---

## Data Flow Diagrams

### Basic Chat Turn

```
User types message
  │
  ▼
Side panel → Background (chrome.runtime.sendMessage)
  │
  ▼
Agent enriches: URL + title + adapter notes + (optional) screenshot
  │          + enabled user memory prompt block
  │
  ▼
Optional Plan before Act call: provider.chat(planner messages, no tools)
  │
  ▼
Agent calls provider.chat(messages, tools)
  ├─ Provider API key → HTTP header to provider endpoint
  ├─ Messages + page content → HTTP body to provider endpoint
  │
  ▼
Provider returns → agent executes tool calls → results appended
  │
  ▼
Loop until done → background sends final reply → side panel displays
```

### Trace Recording Flow (when enabled)

```
Agent turn
  │
  ├─ startRun()     → IndexedDB.runs   { runId, model, userMessage, ... }
  ├─ recordLLMRequest()  → IndexedDB.events  { runId, seq, kind:'llm_request', ... }
  ├─ recordLLMResponse() → IndexedDB.events  { runId, seq, kind:'llm_response', ... }
  ├─ recordToolCall()    → IndexedDB.events  { runId, seq, kind:'tool', ... }
  ├─ recordScreenshot()  → IndexedDB.shots   { runId, seq, blob } + events marker
  └─ endRun()       → IndexedDB.runs   (update duration, tokens, status)
```

All IndexedDB reads happen only when the user opens the Traces page.

### Research Escalation Flow (when enabled and approved)

```
Model proposes one exact read-only research prompt
  │
  ▼
DIV consent card shows the exact prompt
  ├─ Decline / timeout / automatic answer → continue locally; nothing sent
  └─ Explicit approval → single-use, five-minute authorization
                              │
                              ▼
                    Visible chatgpt.com helper tab
                              │  exact approved prompt only
                              ▼
                    ChatGPT answer + source links
                              │  marked untrusted
                              ▼
                    Configured primary LLM → final answer
```

### Screenshot Flow

```
CDP capture → JPEG/PNG data URL
  │
  ├─ If dedicated vision model configured → remote sub-call or local inference
  │   → describe as text
  │   → only the description text is sent to the main provider
  │
  ├─ If main provider supports vision → image_url block attached to user message
  │   → the image is visible to the LLM
  │
  └─ If no vision → screenshot still captured for internal state, but image data is not sent to the model
```

---

## Security Boundaries

| Boundary | Data crossing it | Protected by |
|---|---|---|
| Browser ↔ LLM provider | Chat messages, page content, screenshot | HTTPS; user chose the provider |
| Browser ↔ LLM provider | Enabled user memory prompt block and optional extractor input | HTTPS; user chose the provider |
| Browser ↔ ChatGPT | Exact, user-approved research prompt; returned answer and links | Off-by-default setting; visible fixed-origin tab; per-prompt explicit consent; one-use authorization; result treated as untrusted |
| Browser ↔ enabled CAPTCHA providers | Supplied page/challenge metadata, image/audio and optional proxy/cookie inputs | HTTPS; per-provider opt-in; fallback may contact several services |
| Extension ↔ Offscreen document | Fetch proxy, recording, and optional local model requests | Same extension, same origin |
| Service worker ↔ IndexedDB | Trace data | Browser sandbox; never transmitted |
| Service worker ↔ `chrome.storage.local` | API keys, settings | Browser sandbox (plaintext) |

---

## User Controls

| Setting | Effect |
|---|---|
| Provider selection | Choose which LLM receives the data, or run locally |
| Provider prompt/tool tier | Choose Compact, Mid, or Full tool exposure for non-cloud providers |
| Ask / Act / Dev mode | Choose read-only, normal action, or developer/page-inspection mode |
| Tracing toggle | Controls ordinary local trace recording; a separately opted-in provider research share records a run for metadata-only diagnostic upload even when this toggle is off |
| Local feedback diagnostics | Keeps bounded metadata locally when ordinary tracing is off; disabling it clears automatic history. Uploading a feedback attachment requires separate confirmation. |
| Screenshot fallback | Controls whether page images are sent to the LLM |
| Auto-screenshot mode | Controls how frequently viewport captures are sent |
| Strict secret handling | Keeps credentials out of assistant text and completion summaries: an instruction to the model, exact-match redaction of credentials it filled into sensitive fields from its scratchpad and progress-ledger notes, plus exact-match redaction in cloud runs of anything it typed, sent, or read from a labelled field |
| Profile auto-fill | Controls whether user profile text is sent to the LLM |
| User memory | Controls whether saved memory records are sent to the LLM |
| User memory auto-learn | Controls whether post-turn extractor calls run |
| Site adapters toggle | Controls whether site-specific guidance is prepended |
| Research escalation | Off by default; when enabled, permits per-prompt consent requests for the visible ChatGPT helper flow |
| Always allow API mutations / `/allow-api` | The persistent setting (on by default) or a per-conversation override waives permission prompts for write-method network egress |
| CAPTCHA provider enabled checkboxes | Each controls whether that service participates in solving; a retained key alone does not enable it |

---

## Firefox Differences

Firefox has no offscreen document. The trace recorder and `unlimitedStorage`
are present and identical to Chrome (`src/firefox/src/trace/recorder.js`). All
data-flow patterns are otherwise the same, except:

- No dedicated vision sub-call (screenshots go directly to the main provider if vision is supported)
- Full-page screenshots use the optional local Firefox trusted-automation companion over native messaging and loopback BiDi. The PNG stays local until the user attaches it to a model request. Capture-time page-coordinate redaction scans must agree before a privacy-enabled capture can be staged; otherwise only local preview/save is offered.
- No slash-driven tab/screen recording
- Conversation, rendered chat, and detached-run UI journals use
  `browser.storage.session`, matching Chrome's session-scoped persistence.

### Experimental browser decisions and classifications

The two additional decision switches are independent opt-ins. Existing enabled keys
or scheduler settings do not enable them. Fast classification sends bounded
request context; fast browser decisions send the task, up to 24 structured AX
controls, observed options and bounded prepared field values. These may include
ordinary personal text explicitly supplied for a form. Credential-related tasks
and pages containing credential, payment, OTP or file controls are excluded from
the fast path as a whole. Redaction remains best effort. Initial and automatic
browser screenshots do not disable the AX-only path, but their pixels are never
sent to the fast decision model. A current user attachment, explicit screenshot-tool result or unknown
non-text input keeps that decision on the active chat provider. That provider also
prepares free text and gives the final answer; the fast decision path receives neither screenshots nor
full conversation history for browser decisions. Separate requests use the same
selected model, cost accounting and untrusted-data boundaries, with a one-second
deadline and zero retries. Unsupported operations and their target questions are
omitted rather than sending a one-option placeholder Choice. A malformed model,
usage or answer response stops further Jev requests for that run; exported traces
show only its bounded reason code along with Jev decisions and usage, never the
response or bounded request evidence.

### CAPTCHA provider integration details

The seven-provider catalog, enabled-state controls, data sent during fallback, explicit host-only cookie application, and managed Cloud broker isolation are documented in [CAPTCHA provider coverage](captcha-provider-coverage.md#security-and-data-flow). Model-visible discovery does not expose saved provider keys. Native task inputs may include explicitly supplied proxies/cookies; the browser cookie jar is not automatically exported. Provider-returned scripts are never executed.
