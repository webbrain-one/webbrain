# Security Model

This document describes the security architecture of WebBrain — what the extension can do, what it trusts, how it handles credentials, and how it defends against prompt injection.

For vulnerability disclosure, see [SECURITY.md](../SECURITY.md).

---

## Extension Privileges

### Permissions

```json
{
  "permissions": [
    "sidePanel", "activeTab", "scripting", "storage",
    "webNavigation", "debugger", "downloads",
    "unlimitedStorage", "offscreen", "privateNetworkAccess",
    "tabCapture"
  ],
  "host_permissions": ["<all_urls>", "http://localhost/*", "http://127.0.0.1/*"]
}
```

| Permission | Risk | Mitigation |
|---|---|---|
| `<all_urls>` | Content script injection anywhere — the agent can read and interact with any page the user visits | The user must explicitly switch to Act mode; Ask mode is read-only. The agent never auto-activates on new tabs. |
| `debugger` | CDP access provides trusted events and full DOM/network control on any tab | The debugger is only attached during active agent runs and detached on completion/abort. |
| `downloads` | Can save files to the user's Downloads folder without prompting | Only the agent's explicit tool calls (`download_files`, `screenshot({save:true})`, `record_tab`) use this. |
| `offscreen` | An offscreen document can make HTTP requests immune to user CSP | Only used for localhost LLM provider proxy and tab recording. Never forwards arbitrary URLs. |

### Authentication

The extension runs **inside the user's authenticated browser session**. There is no separate "AI account" — every site the user is logged into (GitHub, Gmail, banking, internal tools) is accessible to the agent with the user's full permissions, exactly as if they were clicking themselves.

The system prompt explicitly tells the model:
> "You do NOT need API tokens, OAuth flows, or 'permission to act on the user's behalf'. The browser session already has all that."

This is a feature (it makes the agent useful with zero setup) but also the most important risk: **the agent can do anything the user can do in a browser**.

---

## Credential Handling

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
| **Tool result cap** | Individual tool results truncated at 8,000 chars (`_limitToolResult`). Injected text beyond that is silently dropped. |
| **Ask/Act mode** | In Ask mode, only read-only tools are available. The user must explicitly switch to Act for the agent to click/type/navigate. |
| **`/allow-api` gate** | Destructive HTTP methods (POST/PUT/PATCH/DELETE) via `fetch_url` require the user to explicitly set a per-conversation `/allow-api` flag. The flag clears on conversation reset. |
| **`done()` blocking** | Before accepting completion, the agent probes for open dialogs/forms. If the summary claims "created"/"saved" but a modal is still open, the agent is forced to continue. |
| **Duplicate-submit guard** | Clicks on submit-like text (create/save/submit/add/post/publish/send/confirm) are blocked within a 45-second window per tab+URL. |
| **CLICK occlusion test** | Before clicking, the resolver calls `elementFromPoint()`. If another element is visually on top, the click is refused. |
| **Modal-scoped click** | When a dialog is open, text clicks are scoped to that subtree so the agent doesn't click a dimmed background element. |
| **Universal preamble** | Every system prompt includes guidance on cookie banners and paywalls — two common injection vectors that look like benign page content. |
| **Loop detection** | Three independent detectors stop the agent if it's repeating the same action or oscillating. Limits damage from a persistently injected prompt. |
| **Finance adapters** | Adapters with `category: 'finance'` inject extra confirmation guidance and a warning banner. |
| **Strict secret handling** | Prevents credential exfiltration even if the model is jailbroken into quoting secrets. |
| **Local network blocking** | When disabled (default), `fetch_url` cannot reach private/RFC1918 addresses. Cloud-metadata endpoints (169.254.169.254) are always blocked. |

### What is NOT defended

- **The LLM provider itself**: if the provider is compromised or malicious, it sees all conversation content including credentials the user types.
- **Extension-unique fingerprinting**: websites could detect the content script (pulsing border, `window.__wbElementMap`, custom event handlers).
- **Timing-channel attacks**: the agent's tool-call latency could be observable from page JS.

---

## `/allow-api` Flag

Set per-conversation via the `/allow-api` slash command in the side panel. When active, the agent may use:

- `fetch_url` with `method: POST/PUT/PATCH/DELETE`
- `execute_js` with mutation code (Firefox only)

The system prompt adds a preamble telling the model to:
- State the URL, method, and payload in plain text before any destructive API call
- Default to UI-first; only reach for the API when UI has actually failed

Cleared on conversation reset.

---

## Trace Data Isolation

The trace recorder (`trace/recorder.js`) writes to IndexedDB on the user's machine when explicitly enabled (Settings → Display → "Record traces"). Data never leaves the browser:

- `runs` store: model, provider, token totals, timestamps
- `events` store: LLM requests/responses, tool calls, screenshot metadata
- `shots` store: screenshot blobs

The traces page (`ui/traces.html`) reads from local IndexedDB only. Export produces a JSON blob identical to what the user sees on screen — no telemetry, no network calls.

---

## Firefox Differences

Firefox has no CDP (`debugger` permission), so:

- No trusted events (synthetic `el.click()` only)
- No full-page screenshots
- No shadow DOM piercing for closed roots
- No offscreen document (CORS must be handled by LLM servers)
- No trace recorder
- No duplicate-submit guard

Everything else (permissions model, credential detection, loop detection, adapter system) is identical.

---

## Reporting Issues

See [SECURITY.md](../SECURITY.md) for the disclosure contact and policy.
