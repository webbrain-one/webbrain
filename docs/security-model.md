# Security Model

This document describes the security architecture of WebBrain — what the extension can do, what it trusts, how it handles credentials, and how it defends against prompt injection.

For vulnerability disclosure, see [SECURITY.md](../SECURITY.md).

---

## Extension Privileges

### Permissions

```json
{
  "permissions": [
    "sidePanel", "activeTab", "contextMenus", "tabs", "tabGroups",
    "scripting", "storage", "webNavigation", "webRequest", "debugger",
    "downloads", "alarms", "unlimitedStorage", "offscreen",
    "privateNetworkAccess", "tabCapture",
    "clipboardWrite", "clipboardRead"
  ],
  "host_permissions": ["<all_urls>", "http://localhost/*", "http://127.0.0.1/*", "http://*/*"]
}
```

(This is the Chrome MV3 manifest. Firefox MV2 grants a narrower set —
`activeTab`, `menus`, `webNavigation`, `webRequest`, `storage`,
`unlimitedStorage`, `tabs`, `tabGroups`, `downloads`, `alarms`, `clipboard*`,
`<all_urls>` — and has no `debugger`/`offscreen`/`tabCapture`, see Firefox
Differences below.)

| Permission | Risk | Mitigation |
|---|---|---|
| `<all_urls>` | Content script injection anywhere — the agent can read and interact with any page the user visits | The user must explicitly switch to an action mode (Act or Dev) before clicks/types/navigation. Ask mode is read-only. The agent never auto-activates on new tabs. |
| `debugger` | CDP access provides trusted events and full DOM/network control on any tab | The debugger is only attached during active agent runs and detached on completion/abort. |
| `webRequest` | Can observe XHR/fetch metadata for requests made by the active page | API mutation observer is off by default; when enabled, it keeps only a bounded in-memory per-tab buffer for repeated-click shortcut hints and opaque same-origin replay. |
| `downloads` | Can save files to the user's Downloads folder without prompting | Only the agent's explicit download-capable tool calls (`download_files`, `download_file`, `download_resource_from_page`, `download_social_media`, download-job skill tools) use this, and each is gated by the capability × origin permission prompt. |
| `alarms` | Can wake scheduled jobs in future browser sessions | Only `schedule_resume` / `schedule_task` create alarms, and those tools are gated. |
| `offscreen` | An offscreen document can make HTTP requests immune to user CSP | Only used for localhost LLM provider proxy and tab recording. Never forwards arbitrary URLs. |

### Authentication

The extension runs **inside the user's authenticated browser session**. There is no separate "AI account" — every site the user is logged into (GitHub, Gmail, banking, internal tools) is accessible to the agent with the user's full permissions, exactly as if they were clicking themselves.

The system prompt explicitly tells the model:
> "You do NOT need API tokens, OAuth flows, or 'permission to act on the user's behalf'. The browser session already has all that."

This is a feature (it makes the agent useful with zero setup) but also the most important risk: **the agent can do anything the user can do in a browser**.

---

## Credential Handling

### Encrypted Cloud Sync

Cloud Sync is an optional subscriber feature. Supported provider API-key
credentials, profile
autofill, and user memory are encrypted before network egress in an authenticated
AES-GCM envelope. The service stores opaque ciphertext and hashed, revocable sync
tokens. Revision-based compare-and-swap prevents silent concurrent overwrite.
The sync password is never sent or persisted and cannot be recovered by WebBrain.
Legacy OAuth access and refresh token stores are explicitly outside the sync scope.

### Detection

After every `set_field` / `type_ax` call, `credential-fields.js` checks whether the filled field is a credential input. Triggers:

1. `<input type="password">`
2. `autocomplete="current-password" | "new-password" | "one-time-code"`
3. Field name / id / aria-label / placeholder / label text matches `SENSITIVE_NAME_RE`

The regex: `pwd|password|passwd|secret|token|api[-_\s]?key|otp|2fa|mfa|credential|recovery[-_\s]?code|backup[-_\s]?code|access[-_\s]?token|refresh[-_\s]?token|client[-_\s]?secret|private[-_\s]?key|seed[-_\s]?phrase|passphrase|pin[-_\s]?code`

### Strict Secret Mode

When enabled (Settings → "Strict secret handling"), the agent:

- **Never quotes credentials** in summaries, assistant text, or tool-call arguments — even when the user explicitly asks
- The `done` tool description is swapped for `DONE_TOOL_STRICT`, which adds a hard prohibition
- After filling a sensitive field, `CREDENTIAL_NOTE_STRICT` is injected into the tool result

When disabled (the default — this is a personal-computer tool, not a third-party deployment):

- The model gets soft hygiene guidance ("prefer generic phrasing unless the user asks for the value")
- The user can ask to see credentials and the model will show them
- The `done` tool description still encourages tidy summaries

### Profile Auto-Fill

Users can store a short profile (name, email, throwaway password) in Settings → Profile. This text is appended to the system prompt when enabled. Warnings in the UI:

- Stored in plaintext in `chrome.storage.local`
- Sent to the LLM provider on every turn as part of the system prompt
- Do not put passwords for important accounts here

---

## Prompt Injection Defenses

The primary threat: a malicious page crafts content that, when read by the agent and fed to the LLM, causes the model to execute unintended actions.

### Defense Layers

| Layer | Mechanism |
|---|---|
| **Untrusted-content wrapping** | Page-derived tool results are wrapped in `<untrusted_page_content>` markers (`_wrapUntrusted` + `UNTRUSTED_CONTENT_TOOLS`) so the model treats them as data, not instructions. See [prompt-injection-defense.md](prompt-injection-defense.md). |
| **Capability × origin gate** | Before a consequential tool runs (click/type/navigate/execute_js/network/download/…), the agent requires a `(capability, host)` grant — Allow once / Always / Deny. Language-agnostic, deterministic, human-in-the-loop (`permission-gate.js`). |
| **Tool result cap** | Individual tool results truncated at 8,000 chars (`_limitToolResult`). Injected text beyond that is silently dropped. |
| **Ask/Act/Dev mode** | Ask mode exposes only semantic read-only tools. The user must explicitly switch to an action mode for clicks/types/navigation. Act exposes the selected provider tier's normal tools. Dev requires Mid/Full tier and adds source/style/page-inspection tools for developer debugging. |
| **Tiered tool exposure** | Provider tiers (`compact | mid | full`) limit the normal browser-agent surface for smaller models. Compact gets the smallest action surface; Mid adds common task tools; Full adds advanced UI/DOM fallbacks. Compact Dev is blocked. |
| **Plan before Act** | When enabled, action-mode runs first produce a structured plan and wait for side-panel approval before any browser tool executes. In Try mode, planner JSON that remains invalid after repair degrades that turn to Ask/read-only; Strict stops. Scheduled runs can auto-approve the plan only through scheduler policy. |
| **Skill import boundary** | Skills can expose read-only HTTP tools and download-job tools through a `webbrain-tools` manifest. Importing or keeping the skill enabled is the trust decision for the declared HTTPS endpoint; declared skill tools use `credentials: "omit"` and should mark third-party results `resultPolicy: "untrusted"`. Download-job skill tools still require an action mode and the normal Downloads permission gate before saving files. |
| **WebMCP boundary** | Experimental WebMCP is off by default, so its tools and prompt guidance do not enter ordinary model requests unless the user opts in under Settings → General → Advanced. When enabled, Chrome page-registered names, descriptions, schemas, frame URLs, annotations, outputs, and errors are page-controlled and always use the untrusted-content wrapper. Calls use opaque IDs. Ask may list tools but cannot invoke them. Because a callback can run arbitrary page logic, every invocation requires Act/Dev, fresh per-call confirmation, and a permission grant for the actual registration-frame origin; a page-authored `readOnly` hint never bypasses those gates. Missing/opaque frame identity fails closed, and the frame plus effective HTTP(S) security origin are revalidated immediately before dispatch to prevent navigation races from borrowing an old grant. |
| **`/allow-api`** | A per-conversation `/allow-api` flag that *waives* the permission prompt for write-method network egress (`fetch_url`/`research_url` with POST/PUT/PATCH/DELETE). It does NOT waive GET egress or any other capability. Clears on conversation reset. |
| **`done()` blocking** | Before accepting completion, the agent probes for open dialogs/forms. If the summary claims "created"/"saved" but a modal is still open, the agent is forced to continue. |
| **Duplicate-submit guard** | Clicks on submit-like text (create/save/submit/add/post/publish/send/confirm/sign up/log in/pay/checkout/order, etc.) are blocked within a 45-second window per tab+URL (Chrome). |
| **CLICK occlusion test** | Before clicking, the resolver calls `elementFromPoint()`. If another element is visually on top, the click is refused. |
| **Modal-scoped click** | When a dialog is open, text clicks are scoped to that subtree so the agent doesn't click a dimmed background element. |
| **Universal preamble** | Every system prompt includes guidance on cookie banners and paywalls — two common injection vectors that look like benign page content. |
| **Loop detection** | Three independent detectors stop the agent if it's repeating the same action or oscillating. Repeated click loops may include an exact same-tab XHR/fetch URL+method hint so the agent can switch to `fetch_url` instead of clicking forever. Limits damage from a persistently injected prompt. |
| **Finance adapters** | Adapters with `category: 'finance'` inject extra confirmation guidance and a warning banner. |
| **Strict secret handling** | Prevents credential exfiltration even if the model is jailbroken into quoting secrets. |
| **Local network blocking** | When disabled (default), `fetch_url` cannot reach private/RFC1918 addresses. Cloud-metadata endpoints (169.254.169.254) are always blocked. |

### What is NOT defended

- **The LLM provider itself**: if the provider is compromised or malicious, it sees all conversation content including credentials the user types.
- **Extension-unique fingerprinting**: websites could detect the content script (pulsing border, `window.__wbElementMap`, custom event handlers).
- **Timing-channel attacks**: the agent's tool-call latency could be observable from page JS.

---

## `/allow-api` Flag

Set per-conversation via the `/allow-api` slash command in the side panel. When active, it waives the permission prompt for **write-method network egress only**:

- `fetch_url` / `research_url` with `method: POST/PUT/PATCH/DELETE`

It does NOT waive GET egress, `execute_js`, or any other capability — those still
go through the capability × origin gate. (`isNetworkMutation` in
`permission-gate.js` is what `/allow-api` keys off; `execute_js` is its own
`Capability.EXECUTE_JS` and is always gated.)

The system prompt adds a preamble telling the model to:
- State the URL, method, and payload in plain text before any destructive API call
- Default to UI-first; only reach for the API when UI has actually failed

Loop-detection API shortcut hints do not bypass this policy. They can expose
the exact method and URL the page was already calling, including POST/PATCH/etc.,
but write-method `fetch_url` / `research_url` calls still require the
conversation's `/allow-api` state. GET requests and non-network capabilities
still go through the normal capability × origin gate.

Cleared on conversation reset.

---

## Trace Data Isolation

The trace recorder (`trace/recorder.js`) writes to IndexedDB on the user's machine when explicitly enabled (Settings → Display → "Record traces"). Data never leaves the browser:

- `runs` store: model, provider, token totals, timestamps
- `events` store: LLM requests/responses, tool calls, screenshot metadata
- `shots` store: screenshot blobs

The traces page (`ui/traces.html`) reads from local IndexedDB only. Export produces a JSON blob identical to what the user sees on screen — no telemetry, no network calls.

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
- No duplicate-submit guard (the timestamp Map is declared but unwired)

Everything else — the permission gate, untrusted-content wrapping, credential
detection, loop detection, adapter system, and the **trace recorder** (it ships
identically in `src/firefox/src/trace/recorder.js`) — is the same.

---

## Reporting Issues

See [SECURITY.md](../SECURITY.md) for the disclosure contact and policy.
