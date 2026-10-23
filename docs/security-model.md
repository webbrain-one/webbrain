# Security Model

This document describes the security architecture of DIV — what the extension can do, what it trusts, how it handles credentials, and how it defends against prompt injection.

For vulnerability disclosure, see [SECURITY.md](../SECURITY.md).

---

## Extension Privileges

### Permissions

```json
{
  "permissions": [
    "sidePanel", "activeTab", "contextMenus", "tabs", "tabGroups",
    "scripting", "storage", "notifications", "webNavigation", "webRequest",
    "debugger", "downloads", "alarms", "unlimitedStorage", "offscreen",
    "privateNetworkAccess", "tabCapture",
    "clipboardWrite", "clipboardRead"
  ],
  "host_permissions": ["<all_urls>", "http://localhost/*", "http://127.0.0.1/*", "http://*/*"]
}
```

(This is the Chrome MV3 manifest. Firefox MV2 grants a narrower set —
`activeTab`, `menus`, `webNavigation`, `webRequest`, `storage`,
`unlimitedStorage`, `tabs`, `tabGroups`, `notifications`, `downloads`,
`alarms`, `clipboard*`, `<all_urls>` — and has no
`debugger`/`offscreen`/`tabCapture`/`sidePanel`/`scripting`/`privateNetworkAccess`,
see Firefox Differences below.)

| Permission | Risk | Mitigation |
|---|---|---|
| `<all_urls>` | Content script injection anywhere — the agent can read and interact with any page the user visits | A turn needs an action mode (Act or Dev) before clicks/types/navigation, and only the user's own request grants one: in their own words or with `/act` or `/dev` (see **Automatic mode selection** below). Ask mode is read-only. General browser-tab creation, enumeration, activation, and run retargeting are not exposed as model-callable tools. The one OTP-skill-gated Mid/Full reader internally selects an already-open supported mailbox and returns only bounded service-matching content; it exposes no tab catalog. Candidate inspection is read-only, while opening a selected message requires Act/Dev and mailbox-host click permission because it may mark mail read. Its disposable inactive clone consumes exact message continuations to completion or fails closed. |
| `debugger` | CDP access provides trusted events and full DOM/network control on any tab | The debugger is attached only to the target tab while a CDP-backed run or mode-scoped Dev diagnostics own it. Run cleanup closes run-scoped WebMCP state and detaches unless Dev diagnostics remain active; conversation cleanup and tab removal drain all owners and detach. |
| `webRequest` | Can observe XHR/fetch metadata for requests made by the active page | API mutation observer is on by default; it keeps only a bounded in-memory per-tab buffer for repeated-click shortcut hints and opaque same-origin replay. |
| `downloads` | Can save files to the user's Downloads folder without prompting | Only the agent's explicit download-capable tool calls (`download_files`, `download_file`, `download_resource_from_page`, `download_social_media`, download-job skill tools) use this, and each is gated by the capability × origin permission prompt. |
| `alarms` | Can wake scheduled jobs in future browser sessions | `schedule_resume` / `schedule_task` are gated; the user-authored `/watch` slash command can also create a page-bound 30–120 second conditional poll. |
| `offscreen` | An offscreen document can make HTTP requests immune to user CSP, run local inference, or play audio without an open panel | Used for the localhost LLM proxy, the optional endpoint-free WebGPU text and vision providers, tab recording, validated download staging, the local controller bridge, and successful `/watch /beep` tones. The text provider receives the same bounded conversation and allowlisted tool schemas that would be sent to another active provider; dedicated local vision receives only its screenshot/prompt. Model files are downloaded from Hugging Face, while inference stays in the worker. Watch audio receives only a style selector, never page content or an arbitrary URL. |
| `sidePanel` | Opens the extension side panel UI | The panel is user-invoked (toolbar click / `Alt+Shift+W`). No model-callable tool opens it silently; it only hosts the chat UI the user already sees. |
| `activeTab` | Temporary access to the currently active tab when invoked | Scoped to the tab the user invoked the extension on. Reads stay read-only in Ask mode; writes still require Act/Dev plus the capability × origin gate. |
| `contextMenus` (`menus` on Firefox) | Adds right-click menu entries | Menu entries only surface user-invoked prompts (selection context, page actions). Invoking one still routes through the normal Ask/Act tool gating — it grants no silent capability. |
| `tabs` / `tabGroups` | Can see tab titles/URLs and group membership | Used for run scoping, tab selection, and conversation recovery. General tab creation, enumeration, activation, and run retargeting are not exposed as model-callable tools. |
| `scripting` (Chrome only) | Can inject content scripts / execute code in pages | Injection targets the user's own open tabs and runs the same audited content scripts (`accessibility-tree.js`, teacher capture, visual indicator). Arbitrary page JS execution (`execute_js`) is a Dev-only tool and always passes the capability × origin gate. |
| `storage` / `unlimitedStorage` | Persists settings, traces, workflows, and model files locally | Data stays in `chrome.storage.local` / IndexedDB on the user's machine. Cloud Sync encrypts credentials, autofill, and memory in an AES-GCM envelope before egress; the sync password never leaves the device. |
| `webNavigation` | Observes navigation events (URL, tab, frame transitions) | Used to scope runs to the current page family, detect navigations mid-run, and invalidate stale element references. It exposes no page content by itself. |
| `notifications` | Can show OS-level notifications | Used as a completion fallback for restricted or discarded background tabs, including scheduled runs. The message is the current tab title, falling back to its URL, so page-controlled titles and sensitive URL components may appear on OS notification surfaces or in notification history. Run output, page bodies, and trace payloads are not intentionally included. |
| `tabCapture` (Chrome only) | Can capture tab audio/video | Used only for the explicit slash-driven tab/screen recording flow. Recording starts on a user command and stops on completion; there is no background capture. |
| `clipboardWrite` / `clipboardRead` | Can write to / read from the clipboard | Writes place agent-produced snippets the user asked for; reads support paste-driven tasks. Clipboard content entering a prompt is treated like other untrusted input and never exfiltrated except as the user's requested result. |
| `privateNetworkAccess` (Chrome only) | Allows requests to local/private-network LLM endpoints | Required for llama.cpp / Ollama / LM Studio on localhost or LAN. Agent network tools block URLs written with private or loopback IP literals and localhost names by default. DNS resolution is not checked, so other hostnames may still reach local addresses. Cloud-metadata IP literals (169.254.169.254) and listed metadata or `*.internal`/`*.local` hostnames remain blocked even when local access is enabled. |
| `http://localhost/*`, `http://127.0.0.1/*`, `http://*/*` host permissions | Lets the extension call local-model servers and plain-HTTP endpoints | Localhost entries exist for local LLM servers (llama.cpp, Ollama, LM Studio). Provider inference and discovery requests to a user-configured HTTP endpoint use the provider transport directly and do not pass the agent-tool permission prompt. Model-callable network tools such as `fetch_url` and `research_url` are separately subject to the capability × origin gate; `connect-src *` in the extension CSP does not waive that gate. |

### Authentication

The extension runs **inside the user's authenticated browser session**. There is no separate "AI account" — every site the user is logged into (GitHub, Gmail, banking, internal tools) is accessible to the agent with the user's full permissions, exactly as if they were clicking themselves.

The system prompt explicitly tells the model:
> "You do NOT need API tokens, OAuth flows, or 'permission to act on the user's behalf'. The browser session already has all that."

This is a feature (it makes the agent useful with zero setup) but also the most important risk: **the agent can do anything the user can do in a browser**.

---

## Credential Handling

### Experimental Local D1 Decisions

D1 is an optional finite-decision provider, not a chat generator or browser
executor. Explicit consent controls download/load: the checkbox on the
Providers page, or the Chrome install guide's optional **Download local
models** button, whose note names D1, its size and its source. The control
handler accepts only the extension's own Providers page and, for status, the
GPU check, download and stop only, its own install guide page; load, unload,
removal and consent stay on the Providers page. The guide's download may name
the chat model to download after D1, and only a shipped, selectable WebGPU
preset is queued. The guide writes no decision settings. Auto uses D1 only after that consent, while the download is complete
and its Load request stands, and never in place of a saved choice; with Compass
as the chat provider, D1 takes only the completion and scheduled checks, and
Compass's managed route keeps semantic decisions. Chrome uses its shared offscreen
document and a separate Worker; Firefox attempts its background-page Worker only
when hardware WebGPU and OPFS are available. Software adapters and inadequate
buffer limits are rejected, but other capable devices are not declared validated.
Only immutable, checksummed model/config/tokenizer data is downloaded from Hugging
Face. Packaged JavaScript/WASM is never loaded from that repository. Inline images
are accepted; page-selected remote image URLs cannot turn D1 into a fetch proxy.

Page text/pixels stay untrusted and existing redaction/wrapping remains in place.
Disabling outsourcing or Strict Secret Mode discards the Worker and its GPU
sessions; cached weights remain until explicitly removed. A caller that stops
waiting cancels only its own request; the Worker's deadline discards a stalled
inference session. Neither invents an answer. While the user's Load on the
Providers page stands, a reload after a restart reads only the verified cache and never
downloads. CPU/WASM control/shape
fallback is disclosed, not represented as pure GPU. A positive experimental D1
judgment alone cannot establish completion: independent LLM or existing checks
still apply, including deterministic recipient/payment/download/authorization
and workflow requirements. The active LLM's existing data-flow policy still
applies to any independent fallback verification.

### Encrypted Cloud Sync

Cloud Sync is an optional subscriber feature. Supported provider API-key
credentials, profile
autofill, and user memory are encrypted before network egress in an authenticated
AES-GCM envelope. The service stores opaque ciphertext and hashed, revocable sync
tokens. Revision-based compare-and-swap prevents silent concurrent overwrite.
The sync password is never sent or persisted and cannot be recovered by DIV.
Legacy OAuth access and refresh token stores are explicitly outside the sync scope.

### Detection

After every `set_field` / `type_ax` call, `credential-fields.js` checks whether the filled field is a credential input. Triggers:

1. `<input type="password">`
2. `autocomplete="current-password" | "new-password" | "one-time-code"`
3. Field name / id / aria-label / placeholder / label text matches `SENSITIVE_NAME_RE`

The regex: `pwd|password|passwd|secret|token|api[-_\s]?key|otp|2fa|mfa|credential|recovery[-_\s]?code|backup[-_\s]?code|access[-_\s]?token|refresh[-_\s]?token|client[-_\s]?secret|private[-_\s]?key|seed[-_\s]?phrase|passphrase|pin[-_\s]?code`

### Strict Secret Mode

When enabled (Settings → "Strict secret handling"), the agent:

- **Is instructed never to quote credentials** in summaries, assistant text, or tool-call arguments — even when the user explicitly asks
- The `done` tool description is swapped for `DONE_TOOL_STRICT`, which adds a hard prohibition
- After filling a sensitive field, `CREDENTIAL_NOTE_STRICT` is injected into the tool result

Those three are prompt-level, so they hold only as far as the model complies.
In every run, a value the agent filled into a field detected as sensitive
(`set_field` or `type_ax`, and `type_text` or `iframe_type` when the page
reports the field it typed into) is held in memory for the conversation and
struck by exact match (also URL-encoded) from what the model writes to its
scratchpad and progress ledger, which are pinned into later requests and saved
with the conversation. Short values are everywhere in ordinary text, so a value
of digits only shorter than six digits (a 4-digit PIN) is never struck, and any
other value under eight characters, or a longer one of digits only (a one-time
code), is struck only as a whole token, not inside a longer word or number.
The values are never stored on their own: a conversation restored after the
browser stopped the extension's worker rebuilds them from its own fill calls
and their results (also when the run loop appended a note to a result). A value
that becomes known after the model already wrote it down (a password it
generated, then typed) is also struck from the model's own text in the existing
scratchpad and from its ledger rows' labels, reasons and fields; the app's
`[auto]` scratchpad lines and a row's `target`, `url` and `href`, which the
runtime may have written, are left as they are. A restored conversation gets
this scrub before the model's next note, once its run has said whether it may
keep credentials. Overlapping values are struck as one stretch. A ledger value
under a field name that says it holds a credential is replaced too: names
ending in a credential word (`password`, `password_confirmation`, `passcode`,
`otp`, `cvv`, `client_secret`), or in `token`, `code`, `key` or `pin` after a
word that makes it one (`access_token`, `sms_code`, `api_key`, `card_pin`, or
`pin` alone), but not `token_count`, `next_page_token`, `zip_code`, `pincode`,
`map_pin` or `secretary`. Row ids stay as written, since they are the rows'
identity. A Cloud run whose final answer is delivered privately keeps its
notes.
Cloud runs add a redaction layer underneath that does not:

- Tool results are cut down to success and HTTP status, tool arguments to the few scalar fields a caller needs to score the run, and streamed or final model prose is replaced outright
- Any value the run **types into a page, sends in a request body, or reads from a field with a credential-shaped name** is remembered and struck by exact match from everything published afterwards — clarification questions, warnings, the final answer, the structured result
- The trace and persistence copies of a structured result go further and replace every string and number, since no caller contract depends on them
- Terminal answers retain ordinary visited URLs (article links the run touched), with only credential-shaped URL components struck. Trace update rows still withhold page URLs and arbitrary tool payloads.

**Where it stops.** A secret the model only ever *reads* out of ordinary page
text — a one-time code in the body of an inbox message, say — is never seen in a
form the redactor can recognize. If the model then repeats it in a clarification
or a final answer, only the prompt-level rules above stand in the way. The
same holds for the scratchpad and progress ledger: a secret the user only typed
into chat, or that was never filled into a detected field (Chrome's selector
form of `type_text` reports no field details), is not known to the redactor, a
ledger row id is kept even when it holds one, and the model's original
tool-call arguments stay in the conversation until they are summarized away.
Strict mode raises the cost of a leak
considerably; it is not a guarantee that survives a model that ignores its
instructions.

When disabled (the default — this is a personal-computer tool, not a third-party deployment):

- The model gets soft hygiene guidance ("prefer generic phrasing unless the user asks for the value")
- The user can ask to see credentials and the model will show them
- The `done` tool description still encourages tidy summaries

### Profile Auto-Fill

Users can store a short profile (name, email, throwaway password) in Settings → Memory. This text is appended to the system prompt when enabled. Warnings in the UI:

- Stored in plaintext in `chrome.storage.local`
- Sent to the LLM provider on every turn as part of the system prompt
- Do not put passwords for important accounts here

---

### Cloud Bridge Browser Approval

The Cloud Bridge lets a controller send `cloud_*` run commands to the browser. By default (no token) it behaves as before. When a Cloud Bridge token is configured the bridge adds an opt-in approval step:

- Each socket sends a `hello` with the token, `browserId`, `installationId` and browser/extension/platform info, then is *pending*; the backend must answer `connection_approved` before any command runs. Earlier commands get `connection_not_approved` (403) and never reach the background.
- Approval is **per socket**: a reconnect, URL change or identity change starts pending again. `connection_rejected` closes the socket and stops auto-reconnect, and cancels any pending reconnect timer.
- The token is a Cloud Bridge credential, distinct from provider API keys. It is stored in `chrome.storage.local` and is never included in the bridge `status`.
- The URL stays restricted to `ws://` on localhost, and the allowed actions stay limited to the `cloud_*` run operations rather than general browser APIs. The bridge sends connection metadata (such as the configured URL) and run data (`tabId`, `finalUrl`, `content` and `result`), which may contain sensitive page data.

**Where it stops.** The permission prompts raised during a cloud run (navigate, click, …) are answered by the backend through `cloud_respond`, including "always". An approved backend is therefore effectively an operator of that browser. Approval is per socket and is not persisted. The backend can revoke it with `connection_rejected`, which closes the socket and stops auto-reconnect. Disabling the bridge or changing its URL or identity also closes the active socket; a replacement needs fresh approval if a token remains configured. Details: [cloud-bridge-browser-approval.md](cloud-bridge-browser-approval.md).

---

## Prompt Injection Defenses

The primary threat: a malicious page crafts content that, when read by the agent and fed to the LLM, causes the model to execute unintended actions.

### Defense Layers

| Layer | Mechanism |
|---|---|
| **Untrusted-content wrapping** | Page-derived tool results are wrapped in `<untrusted_page_content>` markers (`_wrapUntrusted` + `UNTRUSTED_CONTENT_TOOLS`) so the model treats them as data, not instructions. See [prompt-injection-defense.md](prompt-injection-defense.md). |
| **Capability × origin gate** | Before a consequential tool runs (click/type/navigate/execute_js/network/download/…), the agent requires a `(capability, host)` grant — Allow once / Always / Deny. Language-agnostic, deterministic, human-in-the-loop (`permission-gate.js`). |
| **Tool result cap** | Individual tool results truncated at 8,000 chars (`_limitToolResult`). Injected text beyond that is silently dropped. |
| **Ask/Act/Dev mode** | Ask mode exposes only semantic read-only tools. Clicks/types/navigation need an action mode, which only the user's own request grants (see **Automatic mode selection**). Act exposes the selected provider tier's normal tools. Dev requires Mid/Full tier and adds source/style/page-inspection tools for developer debugging. |
| **Automatic mode selection** | Always on; the side panel has no mode toggle. The user's own request takes the place of the toggle as the action authorization: a turn enters Act or Dev only on a sure decision-model answer to `run_mode` about the user's words and run state, or on a `request_action_mode` call from a read-only Ask turn that quotes the user's latest message exactly (for Retry or Continue of a read-only run, the continued task's own words; DIV's continuation text never counts) and that the page-free `run_mode` question, asked again, confirms. Page text, titles and addresses never reach the route, and an unsure, slow or failed route starts read-only. A selected-text scope, the standalone window, Cloud runs, context-menu prompts and messages that carry page text always stay in Ask. The action run's planner gate, permission gates and confirmation cards apply as in a mode the user chose, except that in Try planning a turn that the same decision request is sure is a short, direct task (`plan_need`) runs the gate's compact intent check instead of the full planner. |
| **Tiered tool exposure** | Provider tiers (`compact | mid | full`) limit the normal browser-agent surface for smaller models. Compact gets the smallest action surface; Mid adds common task tools; Full adds advanced UI/DOM fallbacks. Compact Dev is blocked. |
| **Plan before Act** | When enabled, action-mode runs first produce a structured plan and wait for side-panel approval before any browser tool executes. In Try mode, planner JSON that remains invalid after repair degrades that turn to Ask/read-only; Strict stops. Also in Try, a turn that automatic mode routed with a sure `plan_need: direct` answer runs only the compact intent check and shows no plan card: `direct` is an authorizing choice (0.85 threshold) for a short, single-purpose job, and risky work (payments, purchases, bookings, deletion, bulk changes, credentials, messages to several people) answers `plan`. A `direct` answer about a request cut to fit the decision model is not used. Strict, and plan review set to Always, plan every turn. Scheduled runs can auto-approve the plan only through scheduler policy. |
| **Skill import boundary** | Skills can expose read-only HTTP tools and download-job tools through a `webbrain-tools` manifest. Importing or keeping the skill enabled is the trust decision for the declared HTTPS endpoint; declared skill tools use `credentials: "omit"` and should mark third-party results `resultPolicy: "untrusted"`. Download-job skill tools still require an action mode and the normal Downloads permission gate before saving files. |
| **WebMCP boundary** | Experimental WebMCP is on by default, so its tools and prompt guidance enter ordinary model requests unless the user opts out under Settings → Bridge. Chrome page-registered names, descriptions, schemas, frame URLs, annotations, outputs, and errors are page-controlled and always use the untrusted-content wrapper. Calls use opaque IDs. Ask may list tools but cannot invoke them. Because a callback can run arbitrary page logic, every invocation requires Act/Dev, fresh per-call confirmation, and a permission grant for the actual registration-frame origin; a page-authored `readOnly` hint never bypasses those gates. Missing/opaque frame identity fails closed, and the frame plus effective HTTP(S) security origin are revalidated immediately before dispatch to prevent navigation races from borrowing an old grant. |
| **API mutation override** | A per-conversation `/allow-api` flag, or the default-on persistent setting under Settings → Advanced, *waives* the permission prompt for write-method network egress (`fetch_url`/`research_url` with POST/PUT/PATCH/DELETE) in Act and Dev. Ask stays read-only: an Ask run, including a turn that automatic mode starts in Ask, refuses a write-method request whatever these say. Neither option waives GET egress or any other capability. Conversation reset clears only the slash-command override. |
| **Decision models** | Auto (default) uses a downloaded D1 for completion and scheduled checks, whatever the chat provider; while Compass is the chat provider, Compass's managed route answers semantic decisions, and completion checks until D1 is downloaded. Off uses none. In On, OpenRouter, direct TypeSafe and local/custom System One endpoints share independent per-feature switches. Keys are optional for local servers. Compass completion uses its managed decision route unless D1 is downloaded (Auto) or chosen, or the in-browser chat model is chosen. Bounded/redacted task and fresh page evidence are untrusted data. Judges have no browser executor; ordinary tool calls still pass policy, permission and completion layers. Strict Secret Mode, cancellation, quota and cost limits apply. Unavailable or malformed judgments fall through to the active LLM and existing checks. |
| **`done()` verification** | Decision and tool-free LLM checks prefer vision, then AX. Confident pending/failed outcomes require read-only recovery before another submission. Accepted task-bound proof can satisfy generic evidence despite an unrelated comment form, while explicit recipient, payment, download, authorization and workflow contracts remain required. Existing dialog/form checks are the final fallback. |
| **Grouped search approval** | A same-site GET form with no credential, payment or hidden token field, and no side-effect action address, shares one task-scoped approval for its navigation, typing and submit when the page's structure marks it as a search: a search landmark, a search-typed field or one whose keyboard says search, code names such as `q` or `query`, a search address, or a submit control a model read, in any language, as only searching or filtering. Words in a field's visible label decide nothing. Every other form keeps its fresh confirmation. |
| **Duplicate-submit guard** | A second text click on the same caption within 45 seconds on the same tab and URL is blocked when a model read the caption, in any language, as committing something (sending, saving, paying, publishing, creating, confirming and so on). A caption read as anything else, or that could not be read, stays repeatable; app-observed popups, links, fields and draft tools are always repeatable. Both builds. |
| **Placeholder-value guard** | A form submission whose edited field still holds that field's own placeholder text, the page's example such as `you@example.com` in an email box, is not sent and gets no card unless the user gave that value as a whole answer on one of the current task's cards. The words of a request do not count, whether they give the value or refuse it ("do not use you@example.com"): a text match cannot tell which, in any language, so the model asks and the answer decides. An earlier, unrelated turn's answers do not count either. A field counts as edited when the submit probe sees it differ from its default or DIV's own write put the value into that same field in this task, with tracing on or off. The field is matched by its ref, which names one element in one document: the write's own ref, or for a write by selector or focus, the ref its target check resolved. An append whose result does not report the field's whole value counts for whatever the field then holds. A name or id is not enough, since another form, page or frame can reuse it. The receipts are kept in memory and rebuilt from the task's own fill calls and results, so a worker restart does not lose them. In Chrome, a submit control the page probe cannot reach (a closed shadow root) has its form's fields read through the debugger. This holds with confirmations off and in scheduled runs too. The probe checks every field of the form, not only the eight its summary shows, and never reports a password. Without a form, a field `set_field({submit:true})` types into and commits with Enter is checked on its own. The model is told to ask the user for the value. A script (`execute_js`) is not covered: what it fills is not known before it runs. A placeholder without a letter or shorter than three characters (a `1` in a quantity box) does not count, and grouped searches keep their approval. Both builds. |
| **CLICK occlusion test** | Before clicking, the resolver calls `elementFromPoint()`. If another element is visually on top, the click is refused. |
| **Modal-scoped click** | When a dialog is open, text clicks are scoped to that subtree so the agent doesn't click a dimmed background element. |
| **Universal preamble** | Every system prompt includes guidance on cookie banners and paywalls — two common injection vectors that look like benign page content. |
| **Loop detection** | Three independent detectors stop the agent if it's repeating the same action or oscillating. Repeated click loops may include an exact same-tab XHR/fetch URL+method hint so the agent can switch to `fetch_url` instead of clicking forever. Limits damage from a persistently injected prompt. |
| **Finance adapters** | Adapters with `category: 'finance'` inject extra confirmation guidance and a warning banner. |
| **Strict secret handling** | Instructs the model not to quote credentials, strikes credentials it filled into sensitive fields from its scratchpad and progress ledger, and in cloud runs strikes every credential it typed, sent, or read from a labelled field out of what gets published. A secret it only saw in page prose still depends on the instruction. |
| **Local network blocking** | Local-network access is off by default. When access is off, URLs written with private or loopback IP literals and localhost names are blocked. DNS resolution is not checked, so other hostnames may still reach local addresses. Cloud-metadata IP literals (169.254.169.254) and listed metadata or `*.internal`/`*.local` hostnames stay blocked even when local-network access is enabled. |

### What is NOT defended

- **The LLM provider itself**: if the provider is compromised or malicious, it sees all conversation content including credentials the user types.
- **Extension-unique fingerprinting**: websites could detect the content script (pulsing border, `window.__wbElementMap`, custom event handlers).
- **Timing-channel attacks**: the agent's tool-call latency could be observable from page JS.

---

## Unanswered Questions

When the agent asks a `clarify` question and nobody answers before the clarify
timeout (Settings → Budgets, default 60 s), the setting **When a question times
out** decides the answer:

- **Finish the task** (default) keeps the run moving. The option the model named
  as `finish_option` applies as the user's answer; without one, the model
  continues with the choice that best completes the task and reports it in its
  summary. Runs no longer stall because the user stepped away.
- **Play it safe** selects `options[0]` as a safe default. It authorizes nothing
  consequential unless the model marked that option `safe_first`; otherwise
  consequential actions and a success completion stay blocked until the user
  answers directly.

The model classifies every question with `consequence`. A question whose
answer would approve a deletion, a payment, credentials, the recipient of a
message, or a publication the user did not ask for (any `consequence` other
than `none`, or a recipient `purpose`) always times out to its safe first
option, whatever the setting, and that answer authorizes nothing, even when
the model marked it `safe_first`: consequential actions and a success
completion stay blocked until the user answers directly. So does a question
the model did not classify: only `consequence: "none"` lets a timeout finish
the task. Instant (a timeout
of 0) answers by the same rules. A timed-out answer is never recorded as the
user's own words in the task authority or the publication contract. DIV's
own confirmation cards (site permissions, form submits, recipients, deletions)
are separate prompts: they never time out.

The logic lives in `src/*/src/agent/clarify-timeout.js`.

## Guards

DIV's own checks on model actions are registered in
`src/*/src/agent/guard-policy.js`. Only five classes may refuse an action
outright: the wrong recipient, deleting data, money, credentials, and
publishing or sending something the user did not ask for. Verification,
readback, evidence and completion checks leave a note for the model instead,
and a completion accepted over them tells the user what was not verified.
Permission gates, host and frame boundaries, CAPTCHA and access walls, and
loop budgets are not guards and keep their behavior. Settings → General →
**Strict checks** makes every verification check block again.
`docs/guards.md` lists what still refuses and the rule for adding a guard.

## `/allow-api` Flag

Set per-conversation via the `/allow-api` slash command in the side panel, or
persistently with **Always allow API mutations** under **Settings →
Advanced**. The persistent setting is on by default when absent. Read failures
and non-boolean stored values grant no authorization. When either option is
active, it waives the permission prompt for **write-method network egress only**:

- `fetch_url` / `research_url` with `method: POST/PUT/PATCH/DELETE`

It does NOT waive GET egress, `execute_js`, or any other capability — those still
go through the capability × origin gate. (`isNetworkMutation` in
`permission-gate.js` is what `/allow-api` keys off; `execute_js` is its own
`Capability.EXECUTE_JS` and is always gated.)

The system prompt adds a preamble telling the model to:
- State the URL, method, and payload in plain text before any destructive API call
- For the nine supported [CMS content recipes](cms-api-first.md), prefer the
  official API after capability/auth discovery when task scope, CMS rights and
  DIV mutation permission allow it. Ask remains read-only.
- For other tasks, default to UI-first; only reach for the API when UI has actually failed

Loop-detection API shortcut hints do not bypass this policy. They can expose
the exact method and URL the page was already calling, including POST/PATCH/etc.,
but write-method `fetch_url` / `research_url` calls still require either the
conversation's `/allow-api` state or the persistent setting. GET requests and
non-network capabilities still go through the normal capability × origin gate.

Conversation reset clears the slash-command override. It does not change the
persistent setting, which remains active until the user turns it off.

---

## Trace Data Isolation

The separately configurable **Local feedback diagnostics** setting is enabled
by default. When ordinary recording is disabled, it keeps only metadata locally,
bounded to ten completed runs, seven days, 2 MiB total, and 128 KiB per run.
It cannot enable lossless recording. Disabling it clears automatic records and
leaves explicit recordings intact.

Feedback prepares a snapshot of the conversation selected when the rating prompt
opened. A recording cutoff captured before the asynchronous lookup excludes
later runs, events, screenshots, and completion details, even in the same
conversation. Untimestamped records are excluded from feedback snapshots;
mutable byte counters, omission flags, and repair metadata are excluded with
an explanatory note. Ordinary full-session exports remain unbounded. A dedicated
dialog must authorize the actual attachment before it leaves the browser: GitHub uploads
files immediately, even before issue submission.
Viewing a trace and continuing without it never authorize an upload. The handoff
is restricted to the chat panel, an exact GitHub repository and destination tab,
the top frame, an expiring random token, and immutable staged bytes. Transfers
are chunked; reloads do not automatically repeat an uncertain upload. The user
reviews and submits the GitHub issue separately. Legacy and lossless feedback
exports mask credential-shaped data, but this does not anonymize screenshots or
arbitrary conversation/page content.

The trace recorder (`trace/recorder.js`) writes to IndexedDB on the user's
machine for bounded automatic feedback diagnostics, when explicitly enabled
(Settings → Advanced → "Record traces"), or when a local/bring-your-own provider's
separate **Share queries for research** switch is enabled for that run. The latter
forces a local record so a bounded,
content-free diagnostic timeline can be uploaded under that explicit consent.
The default tier is metadata-only: run records omit user and final assistant
text; event records keep allowlisted counts, timings, usage, status/error codes,
tool names/outcome status, and screenshot markers while omitting raw model
messages, tool schemas, tool arguments/results, and detailed error text. Default
run records also omit full tab URLs/titles and attachment filenames, and default
traces do not write screenshot blobs or data URLs to the `shots` store.

The lossless debug tier is off by default and is an opt-in: Record traces
records it, and an update turns it on once for an install that recorded traces
without it. A lossless run may retain bounded user/final text, request and response
payloads, tool schemas/calls/arguments/results, error details, screenshot
bytes, tab URL/title, and attachment filename metadata. It is visibly marked,
subject to per-payload, per-run, and aggregate storage bounds, and should be
treated as sensitive. Export masks
credential-shaped values in lossless structured data but cannot make page/chat
content or screenshots non-sensitive.

Saved-workflow compatibility does not restore raw payloads to default traces.
The recorder holds bounded copies in memory only while the run is active, then
compiles a successful run into a value-free workflow draft. Only the sanitized
draft is added to the existing session-scoped conversation recovery record; it is
cleared with that conversation and becomes durable only after an explicit
`/workflow --save <name>` command.

The traces page (`ui/traces.html`) reads from local IndexedDB only. Export saves
a local file; recording and viewing traces perform no telemetry or network
upload.

These rules apply to newly written trace rows. Historical rows are not migrated
or rewritten during an extension update and retain the behavior of the version
that recorded them.

---

## Saved-Workflow Replay Boundary

Saved workflows deliberately do not replay raw trace calls. Compilation uses an
allowlist, replaces every typed value with a runtime parameter, discards raw
references, action CSS selectors, coordinates and URL query or fragment data, and binds each action to
an origin/path family plus a semantic target and postcondition.

Before an action, replay must be on the recorded URL family and find one
unambiguous target in a fresh accessibility tree. The action is dispatched
through the same capability-by-origin permission gate, submit confirmation,
form validation, and trusted-event path as a normal Act run. A known pre-action
mismatch can be delegated to the Agent with no parameter values. A failed or
unverified state-changing action whose dispatch cannot be disproved is treated
as outcome-unknown and is never automatically retried. Replay telemetry and UI
events redact runtime values and fresh `ref_id` values.

An initial origin/path-family mismatch is one such safe pre-action mismatch.
Replay passes only the sanitized saved start scope to the Agent, which may
navigate through the ordinary Act tool path; deterministic replay does not
navigate directly or gain new authority.

---

## Firefox Differences

Firefox has no CDP (`debugger` permission), so:

- No trusted events (synthetic `el.click()` only)
- No full-page screenshots
- No shadow DOM piercing for closed roots
- No WebMCP discovery or invocation (the integration uses Chrome's experimental CDP `WebMCP` domain)
- `execute_js` is a Dev add-on in both builds: Firefox uses its MV2 content-script evaluator, while Chrome uses CDP `Runtime.evaluate`; neither build exposes it in Ask or normal Act
- Chrome's reversible CSS/element patches are Dev-only and host-permission gated. Console and network diagnostics are Dev-only reads. Event-listener inspection briefly adds and restores an internal target attribute, while element highlighting inserts a temporary overlay; both use the temporary page-modification permission. All page-derived diagnostic results are wrapped as untrusted content. Network headers/bodies are excluded by default and sensitive header names are always redacted before buffering
- No offscreen document (CORS must be handled by LLM servers)
- No slash-driven tab/screen recording (Chrome's capture APIs and `recorder/` are absent)

Everything else — the permission gate, untrusted-content wrapping, credential
detection, loop detection, adapter system, and the **trace recorder** (it ships
identically in `src/firefox/src/trace/recorder.js`) — is the same.

---

## Reporting Issues

See [SECURITY.md](../SECURITY.md) for the disclosure contact and policy.
