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
| Provider API key | Yes | Sent as an HTTP header (Bearer token) to the provider's API endpoint |

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

### Which provider receives the data?

The user chooses their provider in Settings. Options include:

- **WebBrain Cloud**: requests go through `api.webbrain.one`; selected interactions may be retained and used for evaluation, improvement, fine-tuning, and training while Help Improve WebBrain is enabled
- **Bring-your-own cloud providers**: OpenAI, Anthropic, Google Gemini, Mistral, DeepSeek, xAI, Groq, OpenRouter, etc. — requests go directly to the provider using the user's credentials and are never collected by WebBrain
- **Local providers**: llama.cpp, Ollama, LM Studio, Jan, vLLM, SGLang — data stays on the user's machine

Local-model and bring-your-own API requests are never collected by WebBrain. WebBrain Cloud requests are processed and may be retained as described below.

### WebBrain Cloud improvement data

Help Improve WebBrain is available under Settings -> General and is
on by default. When it is on, WebBrain may retain eligible Cloud prompts, model
responses, relevant page text, tool calls, browser-agent actions, feedback, and
task outcome information for evaluation, development, improvement, fine-tuning,
training, safety, and browser-automation research. Screenshots and uploaded
images may be processed to answer the request, but image bytes, base64 media,
and image URLs are excluded from WebBrain's improvement database. The extension
sends the current preference, stable conversation id, and an allowlisted
generation label with every WebBrain Cloud model request. It never attaches
those collection fields to local or bring-your-own providers.

Current clients explicitly send `X-WebBrain-Help-Improve: 1` or `0`. Older
WebBrain Cloud clients that send neither the preference header nor a session id
are treated as using the default-on setting. The Cloud service derives a
best-effort opaque legacy session from the device and the first user message;
the raw device and prompt-derived fingerprint are not stored or sent upstream.
Repeated identical opening messages can be grouped together, and compaction can
split a legacy conversation, so current clients' explicit conversation ids are
authoritative. Users of older clients must install the latest client to disable
future collection under Settings -> General.

An explicit `0` is always opted out. Once any explicit opt-out reaches a
derived or client-provided session, the Cloud service permanently marks that
opaque session ineligible. Turning the setting back on applies to the next new
conversation; it cannot make the current conversation eligible again.

Help Improve-off content is not retained in the improvement database and is
routed through an OpenRouter workspace where content logging is disabled. This
does not prevent the minimal metadata-only operational logging required to
provide the service, enforce quotas, prevent abuse, maintain security, or debug
failures. Requests sent to local models or directly to providers using the
user's own credentials never pass through WebBrain Cloud and are never eligible
for WebBrain training.

For eligible completed generations, MySQL is WebBrain's canonical store. The
service strips media, compresses the request/response payload, encrypts it with
AES-256-GCM, and stores it with an opaque HMAC session id. Interrupted streams
and failed generations are not stored as improvement content. Eligible requests
also use an isolated OpenRouter workspace with private Input & Output Logging
enabled as a redundant review copy. OpenRouter documents a minimum retention of
three months and says data may be retained longer unless deletion is requested.
Its separate **Use Inputs/Outputs** training/discount option remains disabled.
OpenRouter logging is not treated as permanent storage or an image backup. See
[OpenRouter Input & Output Logging](https://openrouter.ai/docs/guides/features/input-output-logging).

Before retained Cloud interactions are used for model development, WebBrain
applies technical measures designed to remove or mask direct identifiers,
credentials, secrets, and other sensitive information. Raw Cloud interactions
selected for improvement are retained for no longer than 12 months before
deletion or de-identification. De-identified datasets may be retained for up to
5 years for model development, evaluation, security, and reproducibility.

---

## What Stays in the Browser

### Conversation History

Stored in `chrome.storage.session` (Chrome) or in-memory (Firefox). Used to restore conversation across service-worker restarts. Relevant conversation content is sent to the configured provider as request context; the stored copy is not separately synced to WebBrain.

### Trace Recorder

When enabled (Settings → Display → "Record traces"), every agent run is written to an IndexedDB database (`webbrain_traces`):

- **`runs` store**: model, provider, token totals, timestamps, user message, final content
- **`events` store**: per-step LLM requests/responses, tool calls with args and results
- **`shots` store**: screenshot blobs

The Traces page (`ui/traces.html`) reads from local IndexedDB only. Export produces a JSON blob saved to the user's Downloads folder. **No trace data ever leaves the browser.**

### Saved Workflows

`/workflow --save <name>` locally compiles the latest successful trace into a
separate `webbrain-workflow/1` record in browser local storage
(`wb_saved_workflows_v1`). The saved record contains action names, sanitized
arguments, semantic target descriptors, URL origin/path families,
postconditions, and parameter descriptors. It does not contain typed field
values, raw historical `ref_id` values, action CSS selectors, coordinates, URL query strings, or URL
fragments.

`/workflow --run <id>` collects declared values in a temporary side-panel form
and sends them directly to the background replay executor. The values are not
written to the workflow, chat text, retry payload, user memory, replay trace,
or Agent fallback prompt. They necessarily reach the active page when the
requested field action runs. A source trace is a separate opt-in record and may
still contain the original raw tool arguments; saving a workflow does not
delete or redact that source trace.

Replay traces contain workflow/step IDs, semantic match status and score,
postcondition status, fallback status, and estimated model calls saved. They do
not contain runtime parameter values or freshly resolved element references.
If deterministic replay cannot safely continue, a fallback Agent receives only
saved metadata and must ask the user again for any still-needed value.

### Settings

Provider configs (API keys, base URLs, model selections) are stored in `chrome.storage.local`. API keys are in plaintext — this is a personal-computer tool and the storage is sandboxed by the browser. The extension has no mechanism to exfiltrate these keys.

When the default-disabled Chrome Web Store release skill is enabled, its
user-owned Google OAuth client credentials, OAuth access/refresh tokens,
publisher/item IDs, and selected release ZIP are also stored in extension-local
storage. ZIP bytes are sent only to the official
`chromewebstore.googleapis.com` upload endpoint after the upload permission is
approved. Tokens and ZIP bytes are never placed in model prompts, tool
arguments, traces, configuration exports, or tool results. The model receives
only bounded package metadata and Chrome Web Store API responses; API responses
are treated as untrusted content. Disconnecting removes OAuth tokens, while the
separate Clear selected ZIP control removes the locally staged package.

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
state, the WebBrain Cloud device ID, conversations, traces, scheduled jobs,
usage counters, or accumulated spend. Import does not upload the JSON to
WebBrain Cloud or to the configured LLM provider.

### Optional Encrypted Cloud Sync

Active WebBrain Cloud subscribers may explicitly enable encrypted profile sync in
Settings. The extension combines user memory, profile autofill, and provider
configuration (including API keys, but excluding legacy OAuth access/refresh
token stores) into one vault and
encrypts it in the browser with AES-256-GCM. Its key is derived from the sync
password with PBKDF2-HMAC-SHA-256 (600,000 iterations). The password and derived
key are retained in memory only for the browser session.

WebBrain Cloud receives only ciphertext and cryptographic/version metadata. It
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

WebMCP is off by default. A user must enable **Experimental WebMCP** under
Settings → General → Advanced before WebBrain sends its tool schemas or prompt
guidance to the configured LLM. On supporting Chrome pages, WebBrain can then
enable the experimental CDP `WebMCP` domain. Chrome reports the structured tools registered by the current page,
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
separate product-telemetry endpoint. When WebBrain Cloud is selected, the model
request itself goes to `api.webbrain.one` and is subject to the Cloud data-use
terms above. Operational request metadata is retained separately for quota,
security, abuse prevention, and debugging.

The only outbound HTTP requests are:
1. **WebBrain Cloud model calls** to `https://api.webbrain.one/v1` (when WebBrain Cloud is selected; the Help Improve WebBrain preference is sent with each request)
2. **Other LLM provider API calls** (directly to URLs the user configured)
3. **CapSolver API calls** (if the user enables CAPTCHA solving)
4. **Content fetches** via `fetch_url` / `research_url` tools (to URLs the agent is asked to fetch)
5. **Skill tool calls** (to the HTTPS endpoint(s) declared by network-capable enabled skills — see "Bundled Skills" below; the default email verification-code helper declares no endpoint)
6. **User memory extraction calls** (only if auto-learn is enabled; sent to the configured LLM provider after a completed turn)
7. **Encrypted Cloud Sync calls** to `https://api.webbrain.one/v1/sync` (only after a subscriber explicitly enables sync; vault content is encrypted before upload)
8. **Slash-driven tab/screen recording** creates no outbound traffic (the .webm is saved to the Downloads folder via `chrome.downloads.download`)

The opt-in `webRequest` API shortcut observer is off by default and does not
create outbound requests; when enabled, it observes replay metadata for requests
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
is prompt-only, and declares no external tool or endpoint. It guides WebBrain's
existing page-reading tools to
prefer selected text or a bounded, message-scoped accessibility-tree subtree on
the active run tab when finding a recent, service-matching code. It cannot list
or switch to background tabs, read SMS, phone notifications, native apps, or
another device, and it forbids private mailbox APIs or sign-in bypasses. The
skill itself creates no additional network request. When the user asks WebBrain
to read a code, however, the scoped page content and extracted code are included
in the normal request to the user's configured LLM provider as part of the
current conversation. When Record traces is enabled, the raw page-reading tool
result and model response are also retained locally in the `webbrain_traces`
IndexedDB database until the user deletes those traces; the skill cannot erase
conversation or trace history after use. Its instructions disclose that
retention before reading, treat message content as untrusted, honor Strict
secret handling, reject ambiguous numeric strings and recovery tokens, and
prohibit intentionally copying the code into scratchpad or user memory.

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

### Screenshot Flow

```
CDP capture → JPEG/PNG data URL
  │
  ├─ If dedicated vision model configured → sub-call to describe → text description
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
| Browser ↔ CapSolver | CAPTCHA token requests | HTTPS; user opted in |
| Extension ↔ Offscreen document | Fetch proxy requests | Same extension, same origin |
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
| Strict secret handling | Prevents credentials discovered in chat or page reads from appearing in assistant text or completion summaries |
| Profile auto-fill | Controls whether user profile text is sent to the LLM |
| User memory | Controls whether saved memory records are sent to the LLM |
| User memory auto-learn | Controls whether post-turn extractor calls run |
| Site adapters toggle | Controls whether site-specific guidance is prepended |
| `/allow-api` | Controls whether the agent can use API mutations |
| CapSolver toggle | Controls whether CAPTCHA data is sent to a third-party solver |

---

## Firefox Differences

Firefox has no offscreen document. The trace recorder and `unlimitedStorage`
are present and identical to Chrome (`src/firefox/src/trace/recorder.js`). All
data-flow patterns are otherwise the same, except:

- No dedicated vision sub-call (screenshots go directly to the main provider if vision is supported)
- No slash-driven tab/screen recording
- Conversation history is not persisted (lost when the sidebar closes)
