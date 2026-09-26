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

When **Plan before Act** is enabled, action-mode turns (Act or Dev) make an additional planner
call to the same configured provider before any browser tools run. That call
contains the user's task, sanitized page URL/title, a short recent-conversation
digest, and the planner system prompt. Image blocks are dropped before the
planner call; any screenshot text description is treated as untrusted context.

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
inference stay on-device. The optional private Tiny XS v3 text preset can use
an explicitly saved Hugging Face read token solely to download its pinned
data files. It is never attached to inference, prompts, page content, a
configurable endpoint or a URL. This local WebGPU configuration is excluded
from Cloud Sync; local storage and explicit settings backups can contain the
plaintext credential and should be kept private. Public presets need no token.

### Which provider receives the data?

The user chooses their provider in Settings. Options include:

- **WebBrain Compass**: requests go through `api.webbrain.one`; selected interactions may be retained and used for evaluation, improvement, fine-tuning, and training while Help Improve WebBrain is enabled
- **Bring-your-own cloud providers**: OpenAI, Anthropic, Google Gemini, Mistral, DeepSeek, xAI, Groq, OpenRouter, etc. — requests go directly to the provider using the user's credentials and are never collected by WebBrain
- **Local model runtimes**: llama.cpp, Ollama, LM Studio, Jan, vLLM, SGLang,
  LocalAI, GPT4All, and Unsloth Studio — inference requests stay on the user's
  machine when Studio is configured with its loopback URL
- **WebGPU (In-browser), Chromium only**: the selected text model runs in an extension
  Worker with no API key, base URL, localhost server, or model endpoint
- **Local OpenAI-compatible Proxy**: WebBrain connects only to the configured
  local gateway, but the gateway may forward the request context to an upstream
  account. Its configuration and privacy policy determine where data goes.

Local-model and bring-your-own API requests are never collected by WebBrain. WebBrain Compass requests are processed and may be retained as described below.

### Optional research escalation to ChatGPT

Research escalation is **off by default**. A user must enable it under
Settings → General before either `delegate_research` or its consent step is
available to the model. When enabled, WebBrain may propose sending one unusually
complex, read-only research request to ChatGPT. The consent card shows the exact
prompt, puts the continue-locally choice first, and requires the user to select
the explicit approval choice. A timeout, automatic selection, typed variation,
or prior approval does not count. Each approval creates a tab- and
conversation-scoped, single-use authorization that expires after five minutes.

After approval, WebBrain opens `https://chatgpt.com/` in a visible helper tab
and types only the displayed prompt. WebBrain does not separately transmit
ChatGPT cookies, credentials, API keys, browsing history, attachments, user
profile, or undisclosed source-page data; any context sent to ChatGPT must be
visible in that exact prompt before approval. The browser may use the user's
existing ChatGPT session in the normal way. The safety policy also forbids this
path for private or sensitive data, purchases, bookings, mutations, account
actions, or high-stakes decisions. Users should still inspect the displayed
prompt before approving it.

ChatGPT receives and processes the approved prompt under the user's ChatGPT
account and OpenAI settings and policies. WebBrain reads the resulting answer
and source links from the visible page, labels them as untrusted research
evidence, and sends that tool result to the user's configured primary LLM as
part of the ongoing turn. The primary model is instructed to verify decisive
facts instead of treating the delegated answer as instructions or proof.

If ChatGPT is logged out, blocked by a network or regional policy, redirects
off the approved origin, changes to an unsupported page layout, or does not
answer before the configured wait limit, the delegation fails and WebBrain can
continue locally. Visible Log in or Sign up controls fail closed even when
ChatGPT also offers a guest composer; the approved prompt is not submitted
without a logged-in composer on the fixed ChatGPT origin. Stop, closing the
helper tab, or closing the source tab cancels the helper run; the source tab is
checked again before submission. The helper tab is left visible for inspection
on login, layout, or timeout failures. Turning Research escalation off removes
both the delegation tool and the Ask-mode consent schema from later model
requests.

### Optional Jev (TypeSafe) scheduled-task verification

Settings → Assistive Models → Jev (TypeSafe) contains the Jev controls, disabled by default,
with separate watch and completion switches. Turning the master switch off
preserves those preferences. Removing the key disables all uses and resets
probability thresholds to 70%. Settings import/export preserves the original
`systemOne*` keys and `typesafeApiKey` (plaintext local storage).

The scheduler sends at most 16,000 serialized characters to
`https://api.typesafe.ai/v1/systemone`, pinned to `jev-1.13.0`. State contains
the bounded task, allowlisted textual tool observations from this run, and a
bounded real previous observation for watches. It excludes agent success
summaries, conversation history, screenshots, audio, attachments, raw request
bodies and credential fields. Text is redacted and wrapped as untrusted data.
An action invalidates earlier observations. Missing eligible evidence skips
verification. Redaction is best effort: ordinary page text can contain personal
data, so enabling Jev authorizes sending that limited evidence to TypeSafe.

Jev never upgrades a result. A low judgment on a read-only watch permits another
poll. If an action was dispatched or its outcome is uncertain, a downgrade
preserves its record and requests reconciliation instead of repeating it;
this also applies to recurring tasks. Cancellation or replaced execution
invalidates late responses. Invalid responses, unavailable service, Strict
Secret Mode, offline operation or cost restrictions retain the existing result.

Requests have one total five-second deadline, including up to two retries for
429/529. Connection testing occurs only on a button press and sends one fixed
synthetic example with no retries. Input usage is estimated at $0.042 per million
tokens; output tokens are free under the documented model price. Usage, duration,
model and decision reasons enter cost/trace accounting without raw evidence.
TypeSafe may charge your account; no SDK is installed.

### WebBrain Compass improvement data

Help Improve WebBrain is available under Settings -> General and is
on by default. When it is on, WebBrain may retain eligible Compass prompts, model
responses, relevant page text, tool calls, browser-agent actions, feedback, and
task outcome information for evaluation, development, improvement, fine-tuning,
training, safety, and browser-automation research. Screenshots and uploaded
images may be processed to answer the request, but image bytes, base64 media,
and image URLs are excluded from WebBrain's improvement database. The extension
sends the current preference, stable conversation id, and an allowlisted
generation label with every WebBrain Compass model request. It never attaches
those collection fields to local or bring-your-own providers.

For WebBrain Compass only, an enabled Help Improve preference also allows the
extension to retain one bounded terminal tool call/result and the final run
status in a local durable outbox until the Compass improvement endpoint
acknowledges it. Delivery is retried on a later Compass run after transient
network/server failures. The outbox is not created for local or bring-your-own
providers, and disabling Help Improve stops new terminal records; any older
queued records are sent with the disabled preference so the server discards
them and the client can remove them.

Current clients explicitly send `X-WebBrain-Help-Improve: 1` or `0`. Older
WebBrain Compass clients that send neither the preference header nor a session id
are treated as using the default-on setting. The Compass service derives a
best-effort opaque legacy session from the device and the first user message;
the raw device and prompt-derived fingerprint are not stored or sent upstream.
Repeated identical opening messages can be grouped together, and compaction can
split a legacy conversation, so current clients' explicit conversation ids are
authoritative. Users of older clients must install the latest client to disable
future collection under Settings -> General.

An explicit `0` is always opted out. Once any explicit opt-out reaches a
derived or client-provided session, the Compass service permanently marks that
opaque session ineligible. Turning the setting back on applies to the next new
conversation; it cannot make the current conversation eligible again.

Help Improve-off content is not retained in the improvement database and is
routed through an OpenRouter workspace where content logging is disabled. This
does not prevent the minimal metadata-only operational logging required to
provide the service, enforce quotas, prevent abuse, maintain security, or debug
failures. Requests sent to local models or directly to providers using the
user's own credentials never pass through WebBrain Compass and are never eligible
for WebBrain training.

For eligible completed generations, MySQL is WebBrain's canonical store. The
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

Before retained Compass interactions are used for model development, WebBrain
applies technical measures designed to remove or mask direct identifiers,
credentials, secrets, and other sensitive information. Raw Compass interactions
selected for improvement are retained for no longer than 12 months before
deletion or de-identification. De-identified datasets may be retained for up to
5 years for model development, evaluation, security, and reproducibility.

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
the stored copies are not separately synced to WebBrain.

### Trace Recorder

When enabled (Settings → Display → "Record traces"), every agent run is written
to the local `webbrain_traces` IndexedDB database in one of two privacy tiers:

- **Default metadata-only tier.** The `runs` store keeps run identifiers and
  lineage, model/provider identifiers, token and event totals, timestamps,
  status, and the allowlisted runtime snapshot. It omits the user's message,
  final assistant text, full tab URL/title, and attachment filenames. The
  `events` store keeps allowlisted diagnostic fields such as event kind, step,
  counts, timings, usage, finish/status/error codes, called tool name and
  outcome status, and screenshot marker/caption. It omits raw LLM
  request/response text, tool schemas, tool arguments/results, and error
  messages. Default traces do not write screenshot blobs or data URLs to the
  `shots` store.
- **Lossless debug tier (explicit opt-in).** Enabling lossless tracing under
  Settings → Display adds user/final text, bounded request messages and tool
  schemas, model responses and tool calls, tool arguments/results, detailed
  errors, screenshot bytes, tab URL/title, and attachment filename metadata.
  Lossless payloads have per-request, per-result, per-run, and aggregate
  storage bounds; old completed lossless runs may be evicted to remain within
  the aggregate limit. These runs are visibly marked in the Traces UI.

`click_ax_timing` trace notes retain only bounded stage durations, input-event
counts, outcome categories, and safety-status booleans. URL, target labels,
accessibility references, and other page content are excluded in both tiers,
including lossless traces.

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
If a saved locator stops matching, WebBrain may show sanitized semantic target
descriptions for the user to choose from. It never selects or persists a
replacement automatically: the user must explicitly choose it, the attempted
action must pass its saved postcondition, and the workflow must still be the
same version. The temporary live `ref_id` is never written to storage. A field
repair can upgrade its runtime parameter to sensitive (for example, when the
new target is a password field), but it can never downgrade that protection.
If deterministic replay cannot safely continue, a fallback Agent receives only
saved metadata and must ask the user again for any still-needed value.

### Settings

Provider configs (API keys, base URLs, model selections) are stored in `chrome.storage.local`. API keys are in plaintext — this is a personal-computer tool and the storage is sandboxed by the browser. The extension has no mechanism to exfiltrate these keys.

### User Profile

If the user enables profile auto-fill, the profile text (name, email, throwaway password) is stored in `chrome.storage.local` in plaintext and sent to the LLM provider as part of the system prompt on every turn.

### User Memory

Saved user memory records are stored locally in `chrome.storage.local` /
`browser.storage.local` under `wb_user_memory_v1` in plaintext. Records are meant
for user-stated durable preferences, stable profile hints, and recurring
workflow preferences. WebBrain rejects obvious secrets and credential-like text,
but users should not store passwords, API keys, tokens, recovery codes, or other
sensitive secrets as memory.

When user memory is enabled, active records are appended to the agent system
prompt as a bounded block. Settings -> Profile controls whether memory is
enabled, whether optional auto-learning runs after completed turns, and the
maximum prompt characters injected. `/memory --add <text>` writes an explicit memory
immediately without an extractor call. Export/import JSON is local-only and is
the v1 bridge for moving memory between browser profiles.

### Configuration Snapshot Transfer

`/export --config` creates a local plaintext `webbrain-config/1` JSON file, and
`/import <json>` or `/import --file` reads that snapshot locally before writing
the validated Settings values to extension storage. The snapshot intentionally
includes provider, vision, transcription, and CapSolver API keys as well as
profile text, user memory, custom skills, and saved permission choices. Users
should treat the file like a credential backup and store it securely.

The snapshot does not include device-bound Cloud Sync authentication/session
state, the WebBrain Compass device ID, conversations, traces, scheduled jobs,
usage counters, or accumulated spend. Import does not upload the JSON to
WebBrain Compass or to the configured LLM provider.

### Optional Encrypted Cloud Sync

Active WebBrain Compass subscribers may explicitly enable encrypted profile sync in
Settings. The extension combines user memory, profile autofill, and provider
configuration (including API keys, but excluding legacy OAuth access/refresh
token stores) into one vault. Chromium-only WebGPU provider configuration and
selection remain device-local so a Firefox sync cannot replace that local choice.
The extension
encrypts it in the browser with AES-256-GCM. Its key is derived from the sync
password with PBKDF2-HMAC-SHA-256 (600,000 iterations). The password and derived
key are retained in memory only for the browser session.

WebBrain Compass receives only ciphertext and cryptographic/version metadata. It
cannot decrypt the vault or recover a forgotten password. Authentication uses a
separate email-approved, scoped token; the billing device GUID alone cannot read
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
Settings → General → Advanced to prevent WebBrain from sending its tool schemas
or prompt guidance to the configured LLM. On supporting Chrome pages, WebBrain
can enable the experimental CDP `WebMCP` domain. Chrome reports the structured tools registered by the current page,
including their page-supplied name, description, input schema, annotations, and
registration frame. WebBrain keeps a bounded in-memory per-tab catalog, assigns
opaque `wmcp_*` IDs, and removes it when the conversation/tab CDP session is
cleaned up. The catalog is not uploaded separately, but catalog fields and tool
results enter the ordinary conversation context when the model calls
`list_webmcp_tools` or `execute_webmcp_tool`, so they are sent to the configured
LLM provider like other page content. They are always wrapped as untrusted page
data. Turning the setting off closes active WebMCP sessions. Firefox does not
support this path.

---

## Telemetry / Analytics

The extension does not include an analytics SDK, crash-reporting SDK, or a
separate product-telemetry endpoint. When WebBrain Compass is selected, the model
request itself goes to `api.webbrain.one` and is subject to the Compass data-use
terms above. Operational request metadata is retained separately for quota,
security, abuse prevention, and debugging.

The only outbound HTTP requests are:
1. **WebBrain Compass model calls** to `https://api.webbrain.one/v1` (when WebBrain Compass is selected; the Help Improve WebBrain preference is sent with each request)
2. **Other LLM provider API calls** (directly to URLs the user configured)
3. **CapSolver API calls** (if the user enables CAPTCHA solving)
4. **Content fetches** via `fetch_url` / `research_url` tools (to URLs the agent is asked to fetch)
5. **Skill tool calls** (to the HTTPS endpoint(s) declared by network-capable enabled skills — see "Bundled Skills" below; the default email verification-code helper declares no endpoint)
6. **User memory extraction calls** (only if auto-learn is enabled; sent to the configured LLM provider after a completed turn)
7. **Encrypted Cloud Sync calls** to `https://api.webbrain.one/v1/sync` (only after a subscriber explicitly enables sync; vault content is encrypted before upload)
8. **Slash-driven tab/screen recording** creates no outbound traffic (the .webm is saved to the Downloads folder via `chrome.downloads.download`)

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

Trace records store the WebBrain version that created each run. Conversation
Markdown records the exporting version; trace Markdown records both the
exporting version and each turn's recording version, while trace JSON includes
`exportedByWebBrainVersion` plus the run's `webbrainVersion` when available.
Legacy runs without recording metadata are labeled as version unavailable.

The "FreeSkillz.xyz" skill (`skills/freeskillz-xyz.md`) is explicitly Ask/Act
compatible and declares
`read_youtube_transcript`, `fetch_nytimes_article`, `resolve_public_media`, and
`download_public_media` tools. When the model calls one of those tools,
WebBrain sends only the current or model-provided URL, plus declared options
such as transcript language, media kind, maximum height, or filename hint, to
the declared `https://freeskillz.xyz` endpoint over HTTPS — a first-party
service operated by the extension's developer, separate from the user's
configured LLM provider. The article fallback is limited to allowlisted
`nytimes.com` URLs (including The Athletic paths) and sends only that URL
without browser credentials or cookies. The transcript tool is limited to
YouTube/youtu.be URLs, while the media tools are limited to public media hosts
declared in the skill manifest. The read-only article, transcript, and resolver
tools do not require
`/allow-api`; `download_public_media` is available only in action modes and
requires download permission because it creates a short-lived provider job,
saves the completed file through the browser Downloads API, and then asks the
provider to delete the job. These calls do not send page content, chat history,
or browsing history beyond the URL and declared tool arguments. Users can
remove this skill, or any user-imported skill tool, from Settings → Skills to
stop this data flow entirely.

The "OTP / verification-code helper (email)" skill
(`skills/otp-verification-code-helper.md`) is explicitly Ask/Act compatible,
and declares no external endpoint. It guides WebBrain's existing page-reading
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
another device, and it forbids sign-in bypasses. When the user asks WebBrain to
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
key and does not send unrelated browsing content. POST requests keep WebBrain's
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
WebBrain consent card shows the exact prompt
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
| Browser ↔ CapSolver | CAPTCHA token requests | HTTPS; user opted in |
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
| Tracing toggle | Prevents any trace data from being stored |
| Screenshot fallback | Controls whether page images are sent to the LLM |
| Auto-screenshot mode | Controls how frequently viewport captures are sent |
| Strict secret handling | Keeps credentials out of assistant text and completion summaries: an instruction to the model, plus exact-match redaction in cloud runs of anything it typed, sent, or read from a labelled field |
| Profile auto-fill | Controls whether user profile text is sent to the LLM |
| User memory | Controls whether saved memory records are sent to the LLM |
| User memory auto-learn | Controls whether post-turn extractor calls run |
| Site adapters toggle | Controls whether site-specific guidance is prepended |
| Research escalation | Off by default; when enabled, permits per-prompt consent requests for the visible ChatGPT helper flow |
| Always allow API mutations / `/allow-api` | The persistent setting (on by default) or a per-conversation override waives permission prompts for write-method network egress |
| CapSolver toggle | Controls whether CAPTCHA data is sent to a third-party solver |

---

## Firefox Differences

Firefox has no offscreen document. The trace recorder and `unlimitedStorage`
are present and identical to Chrome (`src/firefox/src/trace/recorder.js`). All
data-flow patterns are otherwise the same, except:

- No dedicated vision sub-call (screenshots go directly to the main provider if vision is supported)
- No slash-driven tab/screen recording
- Conversation, rendered chat, and detached-run UI journals use
  `browser.storage.session`, matching Chrome's session-scoped persistence.

### Experimental Jev decisions

The two additional Jev switches are independent opt-ins. Existing enabled keys
or scheduler settings do not enable them. Fast classification sends bounded
request context; fast browser decisions send the task, up to 24 structured AX
controls, observed options and bounded prepared field values. These may include
ordinary personal text explicitly supplied for a form. Credential-related tasks
and pages containing credential, payment, OTP or file controls are excluded from
the fast path as a whole. Redaction remains best effort. Initial and automatic
browser screenshots do not disable the AX-only path, but their pixels are never
sent to Jev. A current user attachment, explicit screenshot-tool result or unknown
non-text input keeps that decision on the active chat provider. That provider also
prepares free text and gives the final answer; Jev receives neither screenshots nor
full conversation history for browser decisions. Separate requests use the same
pinned model, cost accounting and untrusted-data boundaries, with a one-second
deadline and zero retries. Unsupported operations and their target questions are
omitted rather than sending a one-option placeholder Choice. A malformed model,
usage or answer response stops further Jev requests for that run; exported traces
show only its bounded reason code along with Jev decisions and usage, never the
response or bounded request evidence.
