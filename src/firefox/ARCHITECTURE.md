# WebBrain Firefox Extension — Architecture

> Version 18.0.14 · Manifest V2 · Background Page

## How Firefox Differs from Chrome

Firefox uses Manifest V2 (background page, not service worker) and has **no access to the Chrome DevTools Protocol (CDP)**. Starting with v3.6.x, the Firefox build has been brought to functional parity with Chrome for the accessibility-tree (AX) subsystem — the same tree builder, the same four AX tools (`get_accessibility_tree`, `click_ax`, `type_ax`, `set_field`), and the same ref_id registry. What Firefox still lacks:

- **No trusted events** — clicks and key presses are synthetic (`el.click()`, `new KeyboardEvent()`), and some sites reject `event.isTrusted === false`. All AX-tool click/type paths use synthetic dispatch in Firefox; the CDP-backed trusted-event path in Chrome has no Firefox equivalent.
- **No pixel-perfect / full-page screenshots** — uses `browser.tabs.captureVisibleTab()` instead of CDP `Page.captureScreenshot`.
- **No conversation persistence** — conversations are lost when the sidebar closes (no session-storage equivalent for MV2 background pages).
- **No shadow DOM piercing** — content script can read open shadow roots via `element.shadowRoot`, but cannot pierce closed roots.
- **No offscreen document** — no HTTP fetch proxy for localhost LLM servers with Private Network Access / CORS issues. User must ensure their local LLM server sends permissive CORS headers.
- **No duplicate-submit guard** — the per-tab submit-throttle (Chrome v3.6.5+) is still Chrome-only. Firefox's agent loop does not block rapid duplicate Create/Submit clicks. `blockedDone` and the ambiguous-click candidate payload were ported to Firefox in v4.0.1 (see "Overlay defenses" below).
- **Some Chrome-only tools/features remain absent** — no CDP full-page screenshot, CDP upload automation, tab recording, offscreen fetch proxy, or closed-shadow-root traversal.

Everything else — the agent loop, LLM providers, site adapters, Plan before Act, loop detection, API shortcut observer, trace recorder, scheduler, context management — is architecturally identical to Chrome unless noted below.

---

## High-Level Overview

```
┌────────────┐     messages      ┌─────────────┐    HTTP/JSON     ┌──────────────┐
│  Sidebar   │ ◄──────────────► │  Background │ ◄──────────────► │  LLM Provider│
│  (UI)      │  browser.runtime │  Page       │   fetch()        │  (OpenAI /   │
│  sidepanel │  .sendMessage    │  agent.js   │                  │   Anthropic /│
│  .js       │                  │  background │                  │   llama.cpp) │
└──────┬─────┘                  │  .js        │                  └──────────────┘
       │                        └──────┬──────┘
       │                               │
       │         browser.tabs.executeScript / sendMessage
       │                               │
       │                               ▼
       │                ┌──────────────────────────────┐
       │                │ Content Scripts (injected)   │
       │                │  • accessibility-tree.js      │
       │                │  • content.js                 │
       │                └──────────────────────────────┘
       │                               │
       └───────────────────────────────┘
                    DOM / Page
```

**Key differences from Chrome:** No CDP client. No offscreen document. All DOM interaction happens through content script injection only, and all HTTP requests happen directly from the background page.

## Directory Structure

```
src/firefox/
├── manifest.json                   # Manifest V2 config
├── src/
│   ├── background.html             # Background page (MV2 requirement)
│   ├── background.js               # Message router
│   ├── agent/
│   │   ├── agent.js                # Core agent loop
│   │   ├── tools.js                # Tool schemas + system prompts (incl. 4 AX tools)
│   │   ├── planner.js              # Plan-before-Act structured planner
│   │   ├── permission-gate.js      # Capability x origin permission gate
│   │   ├── adapters.js             # Per-site guidance (identical to Chrome)
│   │   └── scheduler.js            # ScheduledJobManager — alarms-backed deferred tasks
│   ├── content/
│   │   ├── accessibility-tree.js   # AX tree builder + ref_id registry (NEW in 3.6.8)
│   │   └── content.js              # DOM reader / typer / clicker + AX handlers
│   ├── network/
│   │   └── network-tools.js        # fetch_url, research_url
│   ├── providers/
│   │   ├── base.js                 # Provider interface
│   │   ├── manager.js              # Provider lifecycle
│   │   ├── openai.js               # OpenAI-compatible
│   │   ├── anthropic.js            # Anthropic Claude
│   │   └── llamacpp.js             # Local llama.cpp server
│   ├── trace/
│   │   └── recorder.js             # Optional IndexedDB run recorder
│   └── ui/
│       ├── sidepanel.html
│       ├── sidepanel.js            # Chat UI, verbose mode, deep verbose
│       ├── settings.html
│       ├── settings.js
│       ├── traces.html
│       └── traces.js
└── icons/
```

Notable absences vs Chrome: no `cdp/`, no `offscreen/`, no `recorder/`, no `providers/fetch-with-fallback.js`.

## Permissions

```json
{
  "permissions": [
    "activeTab",
    "menus",
    "webNavigation",
    "webRequest",
    "storage",
    "unlimitedStorage",
    "tabs",
    "tabGroups",
    "downloads",
    "alarms",
    "clipboardWrite",
    "clipboardRead",
    "<all_urls>"
  ]
}
```

Notably **missing** vs Chrome: `debugger`, `sidePanel`, `scripting`, `offscreen`, `privateNetworkAccess`, `tabCapture`.

- No `debugger` → no CDP, no trusted events
- No `offscreen` → no HTTP fetch proxy; direct fetch from background page only
- No `privateNetworkAccess` → localhost LLM servers must send CORS headers themselves
- `webRequest` is used for the same opt-in in-memory API shortcut observer as Chrome. The setting is off by default.
- Uses `sidebar_action` (MV2) instead of `side_panel` (MV3)
- Uses `browser.tabs.executeScript()` / `browser.tabs.sendMessage()` instead of `chrome.scripting.executeScript()`

`unlimitedStorage` supports the optional IndexedDB trace recorder, matching Chrome's trace storage model.

---

## The Accessibility-Tree System (v3.6.x)

As of v3.6.8, Firefox ships `content/accessibility-tree.js` — the same DOM-walker that Chrome uses to produce a compact, indexed, semantic snapshot of the page for the LLM. The file was ported verbatim from Chrome; it uses only standard DOM APIs and works unchanged in Firefox.

### What the tree is

A flattened outline of the page's interactive and informative nodes, each assigned a stable `ref_id`:

```
[1] button "Sign in"
[2] textbox "Email" value="emre@..."
[3] textbox "Password"
[4] searchbox "Search" aria-controls="listbox-1"
[5] listbox
  [6] option "Every month"
  [7] option "Custom"
```

The tree is produced by a single DOM walk with these rules:

- **Filtering**: `display:none`, `visibility:hidden`, `aria-hidden=true`, and zero-dimension nodes are skipped. Overlay containers (fixed/absolute with very high z-index) are hoisted so portaled dropdowns show up near the input that opened them, not at the end of the tree.
- **Accessible name resolution** — priority order:
  1. `aria-labelledby` resolved to referenced elements' text
  2. `aria-label`
  3. `<label for>` / wrapping `<label>`
  4. `placeholder` (for inputs/textareas, as a weaker hint)
  5. For submit/button/reset inputs: the `value` attribute
  6. For buttons / links / `<summary>` with no inner text: the full `innerText`
  7. **New in 3.6.8**: for unlabeled inputs/textareas/selects/textboxes/searchboxes/spinbuttons/comboboxes, scan preceding siblings and parent's preceding siblings for adjacent text nodes that look like labels
- **Value attribute** (v3.6.8) — `<input>` and `<textarea>` render their live `.value` as a separate `value="..."` attribute on the tree line. Values are truncated to 60 chars. Skipped input types: `submit, button, reset, file, checkbox, radio, image, hidden, color, range, password`. This cleanly separates "what this field is called" from "what it currently contains" — a fix for the v3.6.7 Stripe bug where `textbox "1"` was ambiguous between a textbox named "1" and one containing "1".
- **ref_id registry** — each emitted element is stored in `window.__wbElementMap` as a `WeakRef`, keyed by ref_id. The map is cleared at the start of every tree build so IDs don't leak between turns. All AX tools resolve ref_id through this map, getting fast O(1) lookup and automatic garbage collection of stale entries.
- **Soft truncation** — the tree is capped at ~3000 chars. If it overflows, later elements are dropped with a truncation marker so the LLM knows the snapshot is incomplete.

### AX tools

| Tool | Purpose |
|---|---|
| `get_accessibility_tree` | Returns the rendered tree (string) plus metadata — used as the LLM's primary page-understanding surface for v3.6.x |
| `click_ax` | Click an element by ref_id. Resolves through `__wbElementMap`, scrolls into view, dispatches `el.click()` |
| `type_ax` | Type into an input/textarea/contenteditable by ref_id. Uses the native value setter (bypasses React controlled-input wrappers), dispatches `input` + `change` |
| `set_field` | Combined type-and-submit for fields that participate in a combobox/autocomplete. Types the value, detects whether the field is a combobox (role=searchbox/combobox, aria-autocomplete, aria-controls pointing at a listbox, or any visible listbox on the page), and if so dispatches `ArrowDown → Enter` with small delays to commit the highlighted option. Otherwise falls back to `form.requestSubmit()`. This is the main fix for the Stripe "Every N months" bug — it lets the agent close combobox selections deterministically |

Firefox's AX tools use synthetic events only — there is no trusted-event path. Sites that check `event.isTrusted` will reject these the same way they reject legacy `click` / `type_text`.

### What was intentionally skipped in the Firefox port

These Chrome v3.6.x features depend on CDP or agent-level state and were not ported — they can be re-evaluated later:

- **CDP-enriched `click_ax` frontmost resolution** — when `click_ax` lands on a node that overlaps many candidates, Chrome re-queries via CDP to pick the frontmost hit. Firefox relies on the initial ref_id resolution plus the v4.0.1 occlusion hit-test (see below).
- **Duplicate-submit guard** — Chrome's agent.js tracks recent submit tool calls and blocks duplicates within a short window. Not in Firefox's agent loop.
- **Offscreen fetch fallback** — Chrome falls through to an offscreen-document proxy when direct fetch fails (common for localhost LLM servers and private-network destinations). Firefox has no offscreen API; local servers must handle CORS themselves.

### Overlay defenses (v4.0.1+)

Brought to Chrome parity in v4.0.1 — same three layers, synthetic-event-safe so they work without CDP:

1. **Modal-scoped text click.** `click({text: ...})` in `content.js` resolves `_findTopmostModal()` (native `<dialog open>`, `aria-modal`, `[role=dialog]`, common overlay patterns) and scopes its `querySelectorAll` to that subtree — plus the label→input map, the 3×scroll-down retry, and the contenteditable/[role]/[tabindex] fallback. Closes the GitHub "dimmed Publish button behind Create-tag dialog" class of failures.
2. **Post-click occlusion hit-test.** For text/selector/index clicks (skipped for x,y and SELECT), after `scrollIntoView` but before `.click()`, the resolver calls `elementFromPoint(cx, cy)` at the target center. If topmost is neither the target nor a DOM ancestor/descendant, the click is refused with `{occluded: true, occludedBy}` and a force-click hint.
3. **Rich ambiguity payload.** Ambiguous text matches now return Chrome's `{index, tag, role, text, cx, cy, rect, ancestor}` candidates. The `ancestor` string identifies the containing dialog/form so the model can disambiguate "Cancel in alertdialog" vs "Cancel in form" by location.

**`blockedDone` heuristic (ported in v4.0.1).** Firefox's `done` now probes open dialogs, visible forms, and live-region messages via `browser.tabs.executeScript` (MV2 equivalent of Chrome's CDP probe). If the summary claims completion while a modal or form is still visible, returns `{blockedDone: true}` up to 2× per tab before letting `done` through with a loud verification note. Block count cleared on `clearConversation`.

System prompt has a new "MODALS & DIALOGS" section describing the intended flow and the "dialog still open" failure pattern.

---

## Agent Loop

The agent loop is structurally identical to Chrome. The same `processMessage()` / `processMessageStream()` flow runs:

```
User message
    │
    ▼
_enrichFirstUserMessage()     ← same as Chrome (URL/title + screenshot + adapter)
    │
    ▼
Main Loop (max 120 steps)
    │
    ├─ provider.chat(messages, {tools, temp:0.3, maxTokens:4096})
    ├─ If tool_calls → _executeToolBatch() → push results → continue
    ├─ If text only → return as final answer
    └─ If done() → return summary
```

### No conversation persistence

Chrome persists conversations to `chrome.storage.session` and hydrates on service-worker restart. Firefox does **not** — conversations live only in memory on the background page and are lost when the sidebar closes or the background page unloads.

```javascript
// Chrome has:
this.conversations = new Map();  // + _persist() + _hydrate()

// Firefox has:
this.conversations = new Map();  // memory only, no persistence
```

---

## Tools

### Complete tool list

AX tier (preferred in 3.6.x):

| Tool | Description |
|---|---|
| `get_accessibility_tree` | Indexed semantic snapshot + ref_id map |
| `click_ax` | Click by ref_id |
| `type_ax` | Type into field by ref_id |
| `set_field` | Type + combobox-aware commit (ArrowDown+Enter) or form submit |
| `hover` | Synthetic hover (mouseenter/mouseover/pointerover events). `isTrusted: false` — sites that gate hover-reveal on event trust will not respond. Works on most React/Vue handlers that listen to the standard events. |
| `drag_drop` | Synthetic drag: pointerdown/move/up + HTML5 dragstart/dragover/drop with constructed DataTransfer. Less reliable than Chrome's CDP-trusted path; verify by re-reading the tree. |

Legacy tier (kept for compatibility with older prompts and for non-AX flows):

| Tool | Description |
|---|---|
| `read_page`, `screenshot`, `get_interactive_elements` | Page content / image / indexed elements |
| `click`, `type_text`, `press_keys` | Text/selector/index-based interaction |
| `scroll`, `navigate`, `go_back`, `go_forward`, `new_tab`, `wait_for_element`, `wait_for_stable` | Page control. `wait_for_stable` polls MutationObserver + in-flight fetch/XHR — works identically to Chrome. |
| `extract_data`, `get_selection`, `execute_js` | Data extraction / arbitrary JS |
| `get_shadow_dom`, `get_frames`, `iframe_read`, `iframe_click`, `iframe_type` | Frame / shadow DOM |
| `fetch_url`, `research_url` | HTTP / open-and-read |
| `list_downloads`, `read_downloaded_file`, `download_resource_from_page`, `download_files` | Download helpers via `browser.downloads` where available |
| `verify_form` | Reads form field values + viewport screenshot before submit |
| `done` | Signal completion |

Chrome-only (absent in Firefox): `full_page_screenshot`, `shadow_dom_query` (CDP shadow-pierce variant), `upload_file` (CDP-driven file input), `record_tab`, `stop_recording`.

### Click — content script implementation

Firefox's click implementations (both legacy `click` and new `click_ax`) live entirely in the content script. No CDP fallback:

```javascript
// Text-based click: auto-fallback matching (legacy click tool)
const modes = explicit ? [explicit] : ['exact', 'prefix', 'contains'];
for (const m of modes) {
  matches = tryMode(m);
  if (matches.length === 1) break;
  if (matches.length > 1) break;
}

// If found: synthetic click
el.scrollIntoView({ behavior: 'smooth', block: 'center' });
el.click();  // ← NOT trusted
```

`click_ax` skips the text matching entirely and resolves the element via `window.__wbElementMap[ref_id]?.deref()`, then runs the same scroll + synthetic-click dispatch.

### Type — three paths

Both `type_text` and `type_ax` end up in the same typing core:

1. **ContentEditable**: sets `textContent`, dispatches `beforeinput` + `input` + `change`
2. **Select elements**: matches option by value or visible text
3. **Input/Textarea**: uses the native property setter via `Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, value)` to bypass React/Vue controlled-component wrappers, then dispatches `input` + `change`

### set_field — combobox-aware submit

```javascript
'set_field': async () => {
  // ... type the value, verify it landed ...
  if (submit) {
    const roleAttr = (el.getAttribute('role') || '').toLowerCase();
    const controls = el.getAttribute('aria-controls');
    let isCombobox = roleAttr === 'searchbox' || roleAttr === 'combobox'
      || el.getAttribute('aria-autocomplete')
      || el.getAttribute('aria-expanded') === 'true';
    // controls-id lookup + visible-listbox fallback...
    if (isCombobox) {
      await new Promise(r => setTimeout(r, 80));
      dispatchKey('keydown', 'ArrowDown', 40);
      dispatchKey('keyup', 'ArrowDown', 40);
      await new Promise(r => setTimeout(r, 30));
    }
    dispatchKey('keydown', 'Enter', 13);
    // ... + form.requestSubmit() fallback for non-combobox
  }
}
```

### Press keys

No CDP, so Firefox dispatches synthetic `KeyboardEvent` and Tab is implemented via manual focus advancement:

```javascript
const ev = new KeyboardEvent('keydown', {
  key: 'Escape', code: 'Escape', keyCode: 27, which: 27,
  bubbles: true, cancelable: true
});
target.dispatchEvent(ev);
document.dispatchEvent(ev);
```

### Verify form

Reads all form field values via `browser.tabs.executeScript()` and captures a viewport screenshot via `browser.tabs.captureVisibleTab()`. The system prompt guides the LLM to call this before submitting important multi-field forms.

---

## Content Script

The content script is the **only** way Firefox interacts with the page. `content.js` now imports `accessibility-tree.js` (as a separate file loaded first in the content_scripts list) and exposes the following handlers relevant to v3.6.x:

```
get_accessibility_tree  →  window.buildAccessibilityTree() → { tree, metadata }
click_ax                →  resolveRef(id) → scrollIntoView + el.click()
type_ax                 →  resolveRef(id) → native setter + input/change
set_field               →  type + combobox detect → ArrowDown/Enter or submit
```

Plus the legacy handlers: `read_page`, `screenshot`, `click`, `type_text`, `press_keys`, `scroll`, `extract_data`, `get_selection`, `get_shadow_dom`, `get_frames`, `iframe_*`.

### Manifest wiring

```json
"content_scripts": [{
  "matches": ["<all_urls>"],
  "js": ["src/content/accessibility-tree.js", "src/content/content.js"],
  "run_at": "document_idle"
}]
```

`accessibility-tree.js` is loaded first so its `window.buildAccessibilityTree` and `window.__wbElementMap` are available by the time `content.js` wires up the message handlers.

---

## Provider System

Identical to Chrome. Same five providers (OpenAI, Anthropic, llama.cpp, Ollama, and generic OpenAI-compatible) with the same message format and conversion logic. Ollama uses the OpenAI-compatible provider with `localhost:11434/v1`.

Uses `browser.storage.local` instead of `chrome.storage.local` for config persistence.

**No fetch-with-fallback.** Chrome has a `providers/fetch-with-fallback.js` layer that catches direct-fetch failures (typically CORS/PNA on localhost LLM servers) and retries through an offscreen document. Firefox has no equivalent — all provider fetches go directly from the background page, and the local LLM server must set `Access-Control-Allow-Origin: *` (or the extension's `moz-extension://…` origin) itself.

---

## Scheduled Tasks (`scheduler.js`)

Firefox ships the same `ScheduledJobManager` class (`src/firefox/src/agent/scheduler.js`), using `browser.alarms` instead of `chrome.alarms`. Feature parity with the Chrome build except for two differences:

- **No service-worker keepalive.** Chrome pings `chrome.runtime.getPlatformInfo` every 20 s during a job run to prevent the MV3 service worker from dying mid-run. Firefox has a persistent background page (MV2) that is always alive, so no keepalive is needed.
- **URL-target tabs open active.** On Firefox, URL-target tasks open their tab with `active: true` (Chrome opens them in the background). This is a cosmetic difference with no behavioural impact.

All job kinds (`resume`, `task`), lifecycle states, retry/deferral logic, schedule types (`once`, `recurring`), LLM tools (`schedule_resume`, `schedule_task`), and storage key (`wb_scheduled_jobs`) are identical to Chrome. See `docs/architecture.md § Scheduled Tasks` for the full reference.

---

## Loop Detection, Context Management, Verbose Mode, Site Adapters

All identical to Chrome:

- **Loop detection** — three detectors (general repeat, coordinate click, navigation) with the same thresholds and nudge/stop behavior
- **Context management** — auto-trim at >50 messages or >80,000 chars, LLM-powered summarization, emergency trim on context overflow, image pruning (last 4 only), tool-result cap at 8,000 chars
- **Verbose mode** — three levels: Normal / Verbose ON / Deep verbose (Shift+click dumps the LLM-payload ring buffer to DevTools console). Deep verbose works identically; there's just no persisted trace UI to browse it from
- **Site adapters** — same adapter set as Chrome (58 sites across code/dev, productivity, social, messaging, e-commerce, travel, finance, news paywalls, job portals, etc.); same `getActiveAdapter(url)` matching, same mid-conversation re-injection on navigation. Only ONE adapter fires at a time so prompt cost is fixed regardless of total count.

---

## Side Panel UI

| Feature | Chrome | Firefox |
|---|---|---|
| Panel type | Side panel (MV3 API) | Sidebar action (MV2) |
| Chat persistence | Survives panel close | Lost on close |
| Tab tracking | `chrome.tabs.onActivated` + session storage | `browser.tabs.onActivated` + in-memory Map |
| Background comms | `chrome.runtime.sendMessage` | `browser.runtime.sendMessage` (Promise-based) |
| Trace viewer | Yes (`ui/traces.html`) | No |

---

## Message Flow — Walkthrough (Stripe "Every 2 months" example)

```
1. User: "create a product priced at 500 CNY billed every 2 months"
   in a Stripe product-creation tab.

2. sidepanel.js → background.js → agent.processMessage(tabId, text, 'act')

3. Agent builds messages: [system prompt, user msg + URL/title + screenshot].

4. Agent calls provider.chat(...)

5. LLM: get_accessibility_tree {}
   → content.js runs buildAccessibilityTree
   → tree returned:
        [12] textbox "Name"
        [17] textbox "Price" value="500"
        [22] combobox "Currency" value="CNY"
        [31] combobox "Billing period"
        ...

6. LLM: set_field {ref_id: 31, value: "Custom", submit: true}
   → content.js types "Custom", detects combobox (role=combobox +
     aria-controls listbox), fires ArrowDown+Enter → option commits.

7. Agent auto-screenshots, pushes tree+screenshot back.

8. LLM: get_accessibility_tree {}
   → tree now shows the newly-rendered "Every N months" row with
     [45] spinbutton "Every" value="1" and adjacent labels resolved
     by the preceding-sibling scan.

9. LLM: type_ax {ref_id: 45, value: "2"}
   → native setter writes 2, input event fires.

10. LLM: click_ax {ref_id: <Save button>} → synthetic click.

11. LLM: done({summary: "Product created..."})
    → sidepanel renders final message.
```

Same end-to-end shape as Chrome, minus the CDP-trusted-event path and the offscreen fetch fallback.

Planner prompts follow Chrome's token-minimal gating: the base planner prompt
includes general repeated-task pacing, while API replay guidance is appended only
when the tab conversation already has `/allow-api`.

---

## Limitations vs Chrome

| Limitation | Impact | Workaround |
|---|---|---|
| No CDP (no `debugger` permission) | Clicks are synthetic (`isTrusted: false`) | Most sites work; some banking/captcha sites may reject |
| No offscreen document | Localhost LLM fetches fail on CORS | Configure server CORS headers |
| No conversation persistence | Chat lost when sidebar closes | None — MV2 limitation |
| No trusted keyboard events | `press_keys` may not land on all sites | Dispatched to both activeElement and document |
| No full-page screenshot | Only visible viewport | Scroll + multiple captures |
| No shadow-root piercing (closed) | Can't read closed shadow roots | `execute_js` with manual traversal |
| No file upload | Can't automate file input dialogs | User uploads manually |
| No duplicate-submit guard | Agent may submit twice if LLM loops | Rely on site-level idempotence / user watches |
| No ambiguous-click CDP enrichment | Overlapping hit-target ambiguity resolved by ref_id only | Prompting / adapter guidance |
| MV2 background page | Less efficient than MV3 service worker | `persistent: false` helps |

---

## Security Model

Same as Chrome, minus CDP:

- Extension runs with user's full browser permissions
- `<all_urls>` host permission allows content-script injection anywhere
- Cross-origin iframes accessible via extension privilege
- Plan before Act can require user approval before any Act-mode tool executes
- API shortcut observer is off by default; when enabled, it records bounded same-tab XHR/fetch replay metadata in memory only
- `/allow-api` flag required for API mutations (POST/PUT/PATCH/DELETE via `fetch_url`)
- Finance adapters get extra safety warnings
- Tool results capped at 8KB
- No remote code execution: all providers called via `fetch()` with user-supplied keys; no eval of LLM responses

---

## Versioning & Port Status

Firefox remains a self-contained MV2 build with mirrored agent/provider/UI code
where the browser APIs allow it. The historical v3.6.8 port brought the AX
subsystem to parity; current 18.0.0 parity includes Plan before Act, scheduled
tasks, trace recording, the API shortcut observer, and browser-history tools.
The remaining gaps are browser-platform gaps listed above, mostly CDP/offscreen
features.
