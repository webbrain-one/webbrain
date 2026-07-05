# WebBrain Chrome/Edge Extension — Architecture

> Version 21.5.1 · Manifest V3 · Service Worker background

## High-Level Overview

WebBrain is a browser extension that gives an LLM controlled access to the browser tab the user is looking at. The user types a natural-language instruction in a side panel, chooses Ask, Act, or Dev mode, and an autonomous agent loop calls the LLM, executes allowed tool calls (click, type, navigate, inspect, etc.), feeds the results back to the LLM, and repeats until the task is done or a loop detector halts it.

```
┌─────────────┐     messages      ┌─────────────┐    HTTP/JSON     ┌──────────────┐
│  Side Panel │ ◄──────────────► │  Background  │ ◄──────────────► │  LLM Provider│
│  (UI)       │   chrome.runtime │  (Agent)     │   fetch()        │  (OpenAI /   │
│  sidepanel  │   .sendMessage   │  agent.js    │                  │   Anthropic /│
│  .js        │                  │  background  │                  │   llama.cpp) │
└──────┬──────┘                  │  .js         │                  └──────────────┘
       │                         └──────┬───────┘
       │                                │
       │   ┌────────────────────────────┼──────────────────────┐
       │   │ chrome.debugger (CDP)      │ chrome.scripting     │
       │   ▼                            ▼                      │
       │ ┌──────────┐  ┌──────────────────────────────────┐   │
       │ │ CDP      │  │ Content Scripts (injected)       │   │
       │ │ Client   │  │  • accessibility-tree.js          │   │
       │ │ cdp-     │  │  • content.js                     │   │
       │ │ client.js│  └──────────────────────────────────┘   │
       │ └──────────┘                                          │
       │       │                                               │
       └───────┴──────────── DOM / Page ───────────────────────┘
```

## Directory Structure

The `src/chrome` tree is also the Microsoft Edge build. Edge supports the same
Chromium extension APIs and the same `chrome.*` namespace used by this code.

```
src/chrome/
├── manifest.json              # Manifest V3 config
├── src/
│   ├── background.js           # Service worker — message router
│   ├── agent/
│   │   ├── agent.js            # Core agent loop + tool dispatch
│   │   ├── tools.js            # Tool schemas + system prompts
│   │   ├── skills.js           # Settings skills + dynamic skill tool manifests
│   │   ├── planner.js          # Plan-before-Act structured planner
│   │   ├── permission-gate.js  # Capability x origin permission gate
│   │   ├── adapters.js         # Per-site guidance
│   │   └── scheduler.js        # ScheduledJobManager — alarms-backed deferred tasks
│   ├── cdp/
│   │   └── cdp-client.js       # DevTools Protocol wrapper
│   ├── content/
│   │   ├── accessibility-tree.js  # AX tree builder + ref_id registry
│   │   └── content.js          # Injected DOM reader / typer / clicker
│   ├── network/
│   │   └── network-tools.js    # fetch_url, research_url, downloads, skill HTTP tools
│   ├── offscreen/
│   │   ├── offscreen.html      # Offscreen document host
│   │   └── offscreen.js        # HTTP fetch proxy (localhost/PNA fallback)
│   ├── providers/
│   │   ├── base.js             # Provider interface
│   │   ├── manager.js          # Provider lifecycle
│   │   ├── openai.js           # OpenAI-compatible
│   │   ├── anthropic.js        # Anthropic Claude
│   │   ├── llamacpp.js         # Local llama.cpp server
│   │   └── fetch-with-fallback.js  # Uses offscreen proxy on direct-fetch failure
│   ├── trace/
│   │   └── recorder.js         # Optional IndexedDB run recorder
│   └── ui/
│       ├── sidepanel.html
│       ├── sidepanel.js        # Chat UI, verbose mode, deep verbose
│       ├── settings.html
│       ├── settings.js         # Provider + display settings
│       ├── traces.html
│       └── traces.js           # Trace viewer / model comparison UI
├── skills/                     # Packaged default skills (removable after seeding)
└── icons/
```

## Permissions

```json
{
  "permissions": [
    "sidePanel", "activeTab", "contextMenus", "tabs", "tabGroups",
    "scripting", "storage", "webNavigation", "webRequest",
    "debugger", "downloads", "alarms", "unlimitedStorage",
    "offscreen", "privateNetworkAccess", "tabCapture",
    "clipboardWrite", "clipboardRead"
  ],
  "host_permissions": ["<all_urls>", "http://localhost/*", "http://127.0.0.1/*", "http://*/*"]
}
```

| Permission | Why |
|---|---|
| `debugger` | CDP access — trusted mouse/keyboard, pixel-perfect screenshots, shadow-DOM piercing. The single most important differentiator in the Chrome/Edge build vs Firefox. |
| `webRequest` | Opt-in, in-memory same-tab XHR/fetch observer for repeated-click API shortcut hints and opaque same-origin replay. Off by default. |
| `alarms` | Scheduled tasks and scheduled resumes across browser sessions. |
| `unlimitedStorage` | Optional trace recorder persists agent runs (LLM I/O + screenshots) into IndexedDB. A multi-step run can be 1–10 MB; the default ~10 MB origin cap fills after a few runs. |
| `offscreen` | Localhost LLM servers (llama.cpp, LM Studio, Ollama) are unreachable from the MV3 service worker due to CORS / Private Network Access restrictions. An offscreen document hosts the fetch proxy AND the tab recorder. |
| `privateNetworkAccess` | Same motivation — allow calling `http://localhost:8080` from the extension. |
| `tabCapture` | Optional "Record this tab" feature in the sidepanel. Pulls a MediaStream of the active tab's video+audio via `chrome.tabCapture.getMediaStreamId()`, hands it to the offscreen document which runs the MediaRecorder. |

---

## Plan-before-Act Gate (v18.0.0)

When `planBeforeAct` is enabled, action-mode runs (Act or Dev) call `agent/planner.js`
before the first tool loop. The planner returns a bounded JSON plan with steps,
memory strategy, scheduling hints, and risks. The side panel renders that plan
as an editable approval card; approving it pins the plan to the scratchpad so it
survives context compaction. Rejecting, timing out, invalid JSON after retry, or
pressing Stop cancels before browser tools execute. Scheduled runs can set
`autoApprovePlanReview` so the plan is pinned without blocking on the UI.
The feature is off by default.

Planner LLM requests are recorded in traces with `phase: "planner"` and use the
same cost allowance and abort checks as the main loop.

Planner prompts keep optional policy text mechanically gated. The base planner
prompt includes general repeated-task pacing, but API replay guidance is appended
only when the tab conversation already has `/allow-api`; unavailable paths should
not bloat every planner request.

---

## Skills and Dynamic Skill Tools

Settings -> Skills stores enabled skills under `customSkills`. On first run,
`background.js` seeds packaged skills from `skills/*`; FreeSkillz.xyz is enabled
by default but is just a stored built-in skill, so the user can remove it. If a
packaged built-in skill changes and the user still has it enabled, startup
refreshes the stored copy without re-adding deleted skills.

`agent/skills.js` splits each skill into two surfaces:

- prompt instructions appended by `buildCustomSkillsPrompt()`;
- optional tool schemas declared in fenced `webbrain-tools` JSON blocks.

The manifest fence is stripped before prompt injection. Declared skill tools are
appended to `getToolsForMode(...)` at LLM-call time and executed through
`executeHttpSkillTool()` in `network-tools.js`. Current skill tools support
read-only HTTPS GET/POST integrations and HTTPS download-job integrations that
poll a same-origin status URL, save through browser Downloads, and clean up the
provider job. Requests use `credentials: "omit"`, optional URL input allowlists,
and optional response limits.

Importing/enabling a skill is the trust boundary. After import, the declared
tool can contact its declared endpoint without a per-call permission prompt.
Download-job tools still run in action modes and use the normal Downloads
permission gate before saving files. Third-party results should use
`resultPolicy: "untrusted"` so the agent wraps and digests them like page
content instead of trusted instructions.

---

## Recorder (v7.4+)

Recording is user-driven from slash commands, not model-callable tools. `/record`
captures the active tab's video + audio + (optionally) microphone into a single
webm file and shows the red side-panel banner/timer. Add `--transcribe` to
`/record` or `/record-full-screen` to run Whisper transcription after stop.
`/record-full-screen` opens Chrome's screen/window picker from the offscreen
recorder context through `getDisplayMedia()`, records without showing the WebBrain
recording banner, and can be stopped by double Escape on WebBrain or browser
pages. Chrome's picker decides what can be captured: the user must choose the
browser window or whole screen if they want the WebBrain panel in the video.

### Flow

```
sidepanel.js  [/record]
      │ runtime.sendMessage {action:'start_tab_recording', tabId, options}
      ▼
background.js
      ├─ chrome.tabCapture.getMediaStreamId({targetTabId}) → streamId
      └─ offscreen recorder-start {source:'tab', streamId, options}

sidepanel.js  [/record-full-screen]
      │ prepare_recording_host
      │ runtime.sendMessage {action:'start_display_recording', options}
      ▼
background.js
      └─ offscreen recorder-start {source:'display', options}
                      │
                      ▼
offscreen/recorder.js
      ├─ display: navigator.mediaDevices.getDisplayMedia({audio:true, video:true})
      ├─ tab: navigator.mediaDevices.getUserMedia(chromeMediaSource:'tab', streamId)
      ├─ navigator.mediaDevices.getUserMedia({audio:true})       (mic, best-effort)
      ├─ AudioContext:
      │     captured audio ─→ mixDestination
      │     mic            ─→ mixDestination
      │     tab audio only ─→ audioContext.destination   (passthrough so user hears the call)
      ├─ MediaStream(video tracks ∪ mixDestination audio tracks when audio exists)
      └─ MediaRecorder(mimeType selected from actual final video/audio tracks)
              └─ ondataavailable → chunks[]
                                  → on stop, Blob → dataURL → background

background.js (on recorder-stop)
      ├─ chrome.downloads.download(dataURL → webbrain-recording-<ts>.webm)
      └─ if transcribeAfter → runTranscription()
              ├─ providerManager.providers → pick first OpenAI-compatible
              │   (openai → whisper-1, groq → whisper-large-v3, …)
              ├─ POST /v1/audio/transcriptions (multipart: file + model + response_format)
              └─ chrome.downloads.download(.txt sibling)

sidepanel listens for recording_update broadcast events:
   started        → /record shows the banner; /record-full-screen stays hidden
   stopped        → banner hides, "saved to Downloads" toast
   transcribing   → "Transcribing audio with Whisper…"
   transcribed    → "Transcript saved" + Summarize button (Phase 3)
```

The 2-hour safety cap lives in `recorder/host.js` as a service-worker timeout
plus a `chrome.alarms` watchdog, so hidden display recordings remain bounded
after the side panel closes.

### Audio passthrough — the gotcha

By default, when `chrome.tabCapture` is active, Chromium browsers reroute the tab's
audio into the capture stream — the user can no longer hear what's playing
in the tab. For a meeting recorder this is catastrophic (you can't follow
the call). `offscreen/recorder.js` works around this with Web Audio:

```js
const tabAudioSource = audioContext.createMediaStreamSource(captureStream);
tabAudioSource.connect(mixDestination);          // into the recording
tabAudioSource.connect(audioContext.destination); // back to the user's speaker
```

Mic, by contrast, is only piped into the recording (NOT to the speaker —
that would feed back).

### Why a shared offscreen document

Chrome/Edge MV3 allows exactly one offscreen document per extension. The
localhost-fetch proxy already needs one for Private Network Access
workarounds. Rather than fight over it, `offscreen/offscreen.html` loads
both `offscreen.js` (fetch proxy) and `recorder.js` (tab recorder).
`src/offscreen/ensure.js` is the single creation helper, declaring all
reasons up front: `LOCAL_STORAGE` (fetch), `DISPLAY_MEDIA` (tab/display
capture), `USER_MEDIA` (mic). Each script binds its own `runtime.onMessage` filter
(`offscreen-fetch` vs `recorder-*`) so they don't collide.

### Transcription provider selection

There is intentionally no separate "Whisper provider" settings tab. The
existing OpenAI-compatible provider configs already cover everything we
need. `src/agent/transcribe.js` picks the first usable one in priority
order:

| Priority | Provider id | Default model |
|---|---|---|
| 1 | `openai` | `whisper-1` |
| 2 | `groq`   | `whisper-large-v3` |
| 3 | `lmstudio` | user-configured local whisper model |
| 4 | `llamacpp` | user-configured local whisper model |
| 5 | Any other `type:'openai'` provider not on the blocklist |

The blocklist (`anthropic`, `gemini`, `mistral`, `deepseek`, `xai`, `nvidia`)
covers providers that don't host Whisper despite being OpenAI-compatible
for chat. If none of the eligible providers is configured, transcription
is skipped with a clear "configure OpenAI or Groq" error — the .webm is
still saved.

### Hard limits

| | Works |
|---|---|
| Google Meet (browser) | ✓ |
| Zoom web client (`zoom.us/wc/...`) | ✓ |
| **Native Zoom desktop app** | ✓ via `/record-full-screen` when the user selects the Zoom window or screen in Chrome's picker; `/record` tab capture cannot reach it. |
| DRM-protected video (Netflix, Disney+) | ✗ — the browser blocks the encoder at the platform level. |
| chrome:// / edge:// / chrome-extension:// pages | ✗ — tabCapture is not allowed there. |
| Background tabs at start time | ⚠ — `getMediaStreamId` requires the target tab to be active; we briefly activate it before capture. The user can switch away after capture starts. |

### Firefox

Not yet — Firefox MV2 has no `chrome.tabCapture` equivalent; `browser.tabCapture`
doesn't exist. Only `getDisplayMedia` is available, which always shows the
system picker. That's a different UX (and matches "desktop capture only" —
the user's explicit "tab only" requirement can't be honoured there). Tracked
as a separate follow-up.

---

## The Accessibility-Tree System (v3.6.x)

The primary page-interaction path is now an AX tree + `ref_id` model, replacing the older index-based `get_interactive_elements` for almost all flows.

### `accessibility-tree.js`

Injected before `content.js` via `content_scripts`. Exposes three globals on `window`:

- `__generateAccessibilityTree(filter, maxDepth, maxChars, ref_id)` — walks the DOM and emits a flat, indented text tree:

  ```
  dialog [ref_166]
   heading "Add a product" [ref_167]
   button "Close" [ref_169]
   textbox "Name" [ref_170] type="text" placeholder="Product name" value="namaz"
   combobox "…" [ref_180] type="button"
  ```

- `__wb_ax_lookup(ref_id)` — resolves a `ref_N` string back to the live `Element`. Backed by a `window.__wbElementMap` of `WeakRef`s, so ids stay stable across calls as long as the element stays in the DOM.
- `__wb_ax_suggest(ref_id, n)` — when a lookup misses, returns nearby still-valid refs so the error message can guide the model back on track.

### Filters

| filter | Behavior |
|---|---|
| `all` | Whole DOM. Useful when anchoring at a specific `ref_id`. |
| `visible` | **Default for the agent.** In-viewport, visible nodes only, soft-truncated at 3000 chars. |
| `interactive` | Only clickable/typeable things. |

### What makes the tree useful for small models

- **Overlay hoisting.** Open dialogs / listboxes / menus / `[aria-expanded=true]` comboboxes are emitted first under an `[open overlays]` banner so portal-rendered popups (React / Radix / Stripe) survive the 3000-char soft cap.
- **Accessible-name resolution** (`getAccessibleName`): priority is `<select>` selected option → `aria-label` → `aria-labelledby` (concatenates all referenced ids) → `placeholder` → `title` → `alt` → `<label for>` → input `value` (submit/button/reset only, never for text inputs — those emit `value="..."` separately) → direct text → `innerText` fallback for buttons/links/summary → `innerText` fallback for option/menuitem/tab/listitem/row/gridcell/cell → preceding-sibling text for unlabeled form fields ("Every 1 month(s)" pattern) → direct-text fallback.
- **`ref_id` stability.** WeakRef-backed registry with a monotonic counter means a ref you saw three turns ago still works if the element survived.

### AX tools (content-script handlers)

| Tool | Returns | Notes |
|---|---|---|
| `get_accessibility_tree` | Text tree + viewport | Primary page read path. |
| `click_ax({ref_id})` | `{success, method, tag, rect, name, href?, navigates?, hint?}` | Scrolls into view → focuses → `el.click()`. Emits hints: text-entry elements get a `next_required: 'type_ax'` nudge; combobox openers get "the popup is in a portal — re-read the full tree". |
| `type_ax({ref_id, text, clear})` | `{success, method, rect}` | React-compatible: uses the native HTMLInputElement/HTMLTextAreaElement value setter. Rejects non-typeable INPUT subtypes (checkbox/radio/submit/file/...) with a clear error pointing at `click_ax`. |
| `set_field({ref_id, text, clear, submit})` | `{success, verified, ...}` | One-shot focus + clear + type + (optional) submit. **Combobox-aware:** if the element or an ancestor looks like a searchbox/combobox/open listbox, `submit:true` dispatches `ArrowDown` → `Enter` with small delays (Stripe-style virtualized pickers need the first option highlighted before Enter commits it). Bare text inputs still get `Enter` + `form.requestSubmit()`. |

---

## Agent Loop

Lives in `agent.js`, runs in the service worker. Same shape as always:

```
User message
    │
    ▼
_enrichFirstUserMessage()
    • Attach page URL + title
    • Inject site adapter notes (if URL matches)
    • Capture viewport screenshot (if provider supports vision)
    • Build multimodal content [text, image_url]
    │
    ▼
Main loop (max steps from Settings, default 60)
    1. provider.chat(messages, {tools, temp, maxTokens})
    2. If response has tool_calls:
       a. _executeToolBatch() — run each tool
       b. Push tool results into messages
       c. Auto-screenshot if state changed AND provider has vision
          (mode configurable: off / navigation / state_change / every_step)
       d. Loop detection — nudge or stop
       e. Navigation detection — warn on unintended SPA routing
       f. Record trace event if tracing enabled
    3. If response has text only → final answer
    4. If done() called → summary (but see blockedDone below)
```

### Execution modes

| | `processMessage()` | `processMessageStream()` |
|---|---|---|
| LLM call | `provider.chat()` | `provider.chatStream()` (SSE) |
| UI updates | `onUpdate('text', ...)` at end | `onUpdate('text_delta', ...)` live |
| Tool calls | Parsed from `result.toolCalls` | Accumulated from stream deltas |

### done() blocking (v3.6.4+)

`done()` doesn't mean "done" if the page disagrees. Before accepting the summary, the agent probes for visible dialogs / forms / live-region messages. If the summary claims "created" / "saved" but a modal is still open, it returns `{success: false, blockedDone: true}` up to 2 times per tab, forcing the model to take another step. This stopped a class of "hallucinated success" failures on Stripe.

### Overlay defenses (v4.0.1+)

Three layered defenses keep the agent from interacting with the wrong surface when a dialog is open:

1. **Modal-scoped text click.** `click({text: ...})` now resolves `_findTopmostModal()` and scopes its `querySelectorAll` (plus label map, scroll retry, and contenteditable fallback) to that subtree. Previously this was only enforced for index-based `get_interactive_elements`, so a text-click could still land on a dimmed background button (e.g. GitHub's "Publish release" while the "Create new tag" dialog was open). Error messages call out the scoping so the model knows why a page-wide lookup returns no match.
2. **Post-click occlusion hit-test.** For text / selector / index clicks (not x,y — the model chose those coords deliberately), after `scrollIntoView` but before `.click()`, the resolver calls `elementFromPoint(cx, cy)` at the target's center. If the topmost paint is neither the target nor a DOM ancestor/descendant, the click is refused with `{occluded: true, occludedBy: {...}}` and a suggestion to force-click via coordinates if the model really wants to hit what's on top.
3. **Modal-aware ambiguity payload.** When multiple elements match the text, the `ancestor` field in each candidate now identifies the containing dialog/form (`"dialog: Create new tag"` vs `"form: release"`) so the model can pick by location instead of re-calling the same query.

System prompt has a new "MODALS & DIALOGS" section that describes the intended flow and the "dialog still open" failure pattern.

### Duplicate-submit guard (v3.6.5+)

Before any `click` whose resolved text matches `^(create|save|submit|add|post|publish|send|confirm|place order|pay|checkout|update|finish|done)\b` the agent checks a per-tab+URL 45-second window. Duplicate clicks in that window are blocked unless `_allowResubmit` is set. Prevents the "clicked Create three times → three products created" failure mode.

### API shortcut observer (v18.0.0)

When the API mutation observer setting is enabled, `background.js` records the
last 40 same-tab XHR/fetch requests using `chrome.webRequest.onBeforeRequest`.
The setting is off by default. When loop detection sees the same `click` /
`click_ax` repeat, `_detectApiShortcut()` checks whether each click produced the
same exact URL + method within 3 seconds. If so, the warning suggests
`fetch_url({url, method})` instead of another click. This is advisory only:
POST/PUT/PATCH/DELETE still depend on the conversation's `/allow-api` state, and
GET/non-network capabilities still follow the normal permission gate.

### Ambiguous-click CDP enrichment (v3.6.4+)

When `click({text})` or `click({selector})` finds multiple matches, the error payload now carries full candidates (`ref_id`, rect, accessible name, ancestor summary) instead of just count. Lets the model pick the right one instead of looping.

---

## Tools (full list)

The model-facing tool surface is selected by conversation mode plus provider
tier:

- **Ask**: semantic/read-only page tools only. Ask intentionally excludes
  `clarify`, `read_page_source`, `inspect_element_styles`, and action tools.
- **Act**: the selected provider tier's normal browser-agent tools.
- **Dev**: Mid/Full only. Uses the selected Act tier, then adds source/style
  tools and Dev-extended shadow/frame inspection. Compact Dev is blocked.

### Core page reading
`get_accessibility_tree`, `read_page`, `read_pdf`, `get_window_info`, `get_interactive_elements`, `get_selection`, `extract_data`, `wait_for_stable`

### Interaction
`click_ax`, `type_ax`, `set_field`, `click` (by text/selector/index/coords), `type_text`, `press_keys`, `scroll`, `navigate`, `go_back`, `go_forward`, `new_tab`, `wait_for_element`, `iframe_read`, `iframe_click`, `iframe_type`, `upload_file`

Full Act also adds advanced UI/DOM fallbacks: `resize_window`, `hover` (CDP-trusted, for reveal-on-hover menus), `drag_drop` (CDP-trusted pointer sequence, for Trello/Linear-style reordering), `get_shadow_dom`, `shadow_dom_query`, and `get_frames`. Mid Dev gets the shadow/frame inspection tools as Dev-extended debugging tools, but not hover/drag-drop.

> **Note:** `execute_js` was removed from the Chrome/Edge MV3 tool schema — `new Function()` is blocked by the extension_pages CSP and always throws EvalError. The agent uses `read_page`, `click`, `type_text`, `scroll`, and other fine-grained tools instead. `execute_js` is available only as a Firefox Dev add-on.

### Network / files
`fetch_url`, `research_url`, `list_downloads`, `read_downloaded_file`, `download_resource_from_page`, `download_files`, `download_social_media`

### Safety / control
`verify_form`, `clarify`, `done`, `schedule_resume`, `schedule_task`, `scratchpad_write`, `progress_update`, `progress_read`, `solve_captcha`

### Dev add-ons
`read_page_source` and `inspect_element_styles` are Dev-only: they do not appear in Ask or normal Act. Future HTML/CSS editing/debugging tools should attach to Dev mode unless they are normal browser-operation tools.

---

## DevTools Protocol (CDP)

`cdp-client.js` wraps `chrome.debugger`:

| Capability | CDP Domain | Use |
|---|---|---|
| Screenshot | `Page.captureScreenshot` | Viewport + full-page |
| Click | `Input.dispatchMouseEvent` | Trusted mouse events |
| Keyboard | `Input.dispatchKeyEvent` | Trusted keystrokes |
| Evaluate | `Runtime.evaluate` | Run code in page context |
| DOM query | `DOM.*` | Shadow DOM piercing |

CDP events are **trusted** (`event.isTrusted === true`). Many sites reject synthetic `el.click()`; CDP is what lets WebBrain work on those.

### CDP click vs content-script click

| | CDP path | Content-script fallback |
|---|---|---|
| How | `Input.dispatchMouseEvent(x,y)` | `el.click()` |
| Trusted | Yes | No |
| Cross-origin | Works | Blocked |
| Used when | Default in Chrome/Edge, or `click({x,y})` / `click({text})` after coord resolution | `click_ax` (focuses the exact element, dispatches in-page) |

---

## Provider System

### Interface (`base.js`)

```javascript
class BaseProvider {
  async chat(messages, options)         // → { content, toolCalls, usage }
  async *chatStream(messages, options)  // yields { type, content }
  get supportsTools()
  get supportsVision()
  async testConnection()
}
```

### Implementations

| Provider | Endpoint | Vision detection |
|---|---|---|
| `OpenAIProvider` | `/v1/chat/completions` | Model-name regex |
| `AnthropicProvider` | `/v1/messages` | `claude-(3\|sonnet-4\|opus-4)` patterns |
| `LlamaCppProvider` | `localhost:8080/v1/chat/completions` | Explicit opt-in |
| Ollama (via OpenAI provider) | `localhost:11434/v1/*` | Explicit opt-in |

### Anthropic conversion

OpenAI format → Anthropic blocks: system → separate `system` field; `assistant + tool_calls` → `assistant + tool_use` blocks; `tool` role → `user + tool_result` blocks; `image_url` data URLs → `image source`.

### fetch-with-fallback

`providers/fetch-with-fallback.js` tries a direct `fetch` first. On failure (typically a `TypeError: Failed to fetch` against localhost), it lazily creates an offscreen document and proxies through it. This is the only reason the `offscreen` permission exists.

---

## Scheduled Tasks (`scheduler.js`)

`ScheduledJobManager` (Chrome/Edge build: `src/chrome/src/agent/scheduler.js`) is instantiated in `background.js` and uses `chrome.alarms` to fire deferred work.

**Chromium/Edge-specific behavior vs Firefox:**

- URL-target tasks open their tab in the **background** (`active: false`) so the user isn't interrupted.
- A **service-worker keepalive** (`startChromeAlarmKeepAlive`) pings `chrome.runtime.getPlatformInfo` every 20 s while a scheduled job is executing, keeping the MV3 service worker alive for the duration of the run.
- Alarm names are prefixed `wb_scheduled_job:<jobId>`; restored on service-worker startup via `restoreAlarms()`.

**Job kinds, lifecycle, and tools** are identical to the shared design — see `docs/architecture.md § Scheduled Tasks`.

| Limits | Value |
|---|---|
| Min delay (`schedule_resume`) | 30 s |
| Min delay (`schedule_task`) | 0 s to start now; otherwise 60 s |
| Max delay (both) | 7 days |
| Min recurring interval | 1 min |
| Max recurring interval | 1 year (525 600 min) |
| Max queue deferrals before failure | 120 (≈ 1 h of retries) |

---

## Loop Detection

Three independent detectors, strongest action wins:

1. **General repeat** — last 6 tool calls by (name + args hash + outcome). Nudge at 3 identical or ABAB. Stop at 8 nudges without 2 consecutive healthy calls between.
2. **Coordinate click** — 5-pixel bucketing. Nudge at 5 same-bucket clicks. Stop at 8.
3. **Navigation** — snapshot URL before `click`/`navigate`/`iframe_click`, compare 200 ms later. Unexpected change → `[NAVIGATION OCCURRED]` warning.

---

## Context Management

- **Auto-trim** (`_manageContext`): triggered at >50 messages or >80,000 chars; keeps system prompt + LLM-summarized old messages (cap 2000 chars) + last 16 verbatim.
- **Emergency trim** (`_emergencyTrim`): on provider context-overflow error.
- **Image pruning** (`_pruneOldImages`): before every call, strip base64 images from all but the last 4 messages.
- **Tool result cap**: individual results truncated at 8,000 chars with `[truncated]` marker.

---

## Conversation Persistence

MV3 service workers die; conversations mustn't:

```
chrome.storage.session['agentConv:<tabId>'] = JSON.stringify(messages)
```

Persisted debounced 300 ms after any change; lazily hydrated on first message to a tab; per-tab isolated.

---

## Trace Recorder (optional)

Off by default. Enabled via Settings → Display → "Record traces". When on, every agent run writes to an IndexedDB database (`webbrain-traces`):

- `runs` store: one row per user message — model, provider, token totals, timestamps.
- `events` store: one row per LLM request/response, tool call, screenshot. Rows are indexed by `(runId, seq)`.

The Traces page (`ui/traces.html`) lists runs and renders their event timelines. Exporting produces a JSON blob identical to the ones used in this session's debugging. Data never leaves the machine — this is why `unlimitedStorage` is requested (a multi-step run with screenshots is 1–10 MB).

---

## Display Settings

`Settings → Display` toggles (stored in `chrome.storage.local`):

| Setting | Effect |
|---|---|
| Verbose mode | Shows full tool args + JSON results in chat instead of compact labels. |
| Screenshot fallback | Capture a screenshot when DOM read fails or returns insufficient content. |
| Site adapters | Inject per-site guidance into the first user message (default on). |
| Auto-screenshot | `off` / `navigation` / `state_change` (default) / `every_step`. |
| Record traces | Enable the trace recorder (see above). |
| Completion sound | Play a chime in the side panel when the agent finishes. |
| Max Agent Steps | Step cap, default 60. |

---

## Site Adapters

58 adapters inject site-specific guidance into the first user message. Re-injected mid-conversation if the user navigates to a different matched site. Only ONE adapter fires at a time (the first matching `match(url)` wins), so the prompt cost is fixed regardless of total adapter count — what grows is the maintenance surface.

| Category | Sites |
|---|---|
| Code & Dev | GitHub, GitLab, Stack Overflow, Hacker News |
| Coding practice | LeetCode, HackerRank |
| Productivity | Gmail, Outlook, Google Docs, Google Sheets, Google Calendar, Slack, Notion, Jira, Trello |
| Social | Twitter/X, LinkedIn, Reddit, YouTube, Instagram, TikTok, Facebook |
| Messaging | Discord, WhatsApp Web, Telegram |
| Publishing | Medium, Substack, WordPress |
| Commerce | Amazon, eBay, Walmart, Target, Etsy |
| Travel | Airbnb, Booking.com, Expedia, Google Maps, Google Flights, Kayak, OpenTable |
| Cloud / Infra | AWS, GCP, Cloudflare, Vercel |
| News (paywalls) | NYT, WSJ, FT, Bloomberg, Economist, Washington Post |
| Job portals | Greenhouse, Workday |
| Finance | Stripe, Coinbase, Robinhood, TradingView, `finance-generic` (banks/exchanges/payments) |

Finance adapters carry a `[FINANCE / HIGH-STAKES]` banner and extra confirmation guidance. The `finance-generic` adapter matches a curated regex of bank, brokerage, crypto exchange, and payment domains as a catch-all when no site-specific adapter exists.

---

## Side Panel UI

### Modes
- **Ask** — read-only tools, analysis / Q&A.
- **Act** — selected provider tier's normal browser-action tools.
- **Dev** — Mid/Full action mode for source/style/page-debugging work; adds Dev tools and is blocked for Compact-tier providers.

### Verbose mode
- **Normal** — compact step labels.
- **Verbose ON** — full JSON args + truncated results.
- **Deep verbose** (Shift+click verbose button) — dump the full LLM request/response ring buffer (200 entries) to DevTools console with color-coded groups.

---

## Message Flow — Complete Walkthrough

```
1. User types "create a product 'namaz' priced 500 CNY, recurring every 2 months"

2. sidepanel.js → chrome.runtime.sendMessage({action:'chat', text, mode:'act', tabId:42})

3. background.js → agent.processMessage(42, text, onUpdate, 'act')

4. _enrichFirstUserMessage: attach URL/title + site adapter + viewport screenshot

5. provider.chat(messages, {tools, temp:0.15, maxTokens:4096})
   → trace recorder logs llm_request

6. LLM returns tool_calls: [{name:'get_accessibility_tree', args:{filter:'visible'}}]

7. _executeToolBatch → content script → window.__generateAccessibilityTree(...)
   → returns indented tree text

8. Agent appends tool result, auto-screenshots (state unchanged → skipped), loops

9. Over ~15 steps the agent: clicks "Create product", fills name via set_field,
   fills price, opens currency combobox, types "CNY" with submit:true
   (ArrowDown+Enter commits the filtered option), opens billing-period dropdown,
   selects "Custom", sets count to 2 and unit to "month(s)", clicks "Add product".

10. done() returns the summary — blockedDone check passes since the dialog closed
    and an alertdialog "Product created" is now visible.

11. sidepanel renders the assistant message + optional completion chime.
```

---

## Security Model

- Extension runs with the user's full browser permissions — no additional auth.
- `<all_urls>` host permission → content-script injection anywhere.
- `debugger` → trusted events on any tab.
- Cross-origin iframes reachable via content-script injection (extension privilege).
- Plan before Act can require user approval before any action-mode tool executes.
- `/allow-api` flag required for API mutations (POST/PUT/PATCH/DELETE via `fetch_url`).
- Finance adapters layer extra confirmation guidance.
- Tool results capped at 8 KB to limit prompt-injection surface.
- Offscreen proxy only forwards requests the user's own code initiated (provider SDK traffic).
- Trace data is local-only — never transmitted.
