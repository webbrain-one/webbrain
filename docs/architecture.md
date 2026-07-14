# WebBrain Architecture

> Version 18.0.0

## Overview

WebBrain is a browser extension that gives an LLM control over the user's active browser tab. The user types a natural-language instruction in a side panel, and an autonomous agent loop calls the LLM, executes tool calls (click, type, navigate, read page state, etc.), feeds results back to the LLM, and repeats until the task is done.

There are two builds that share almost all code:
- **Chrome** — Manifest V3, service worker, CDP-backed trusted events
- **Firefox** — Manifest V2, background page, synthetic events only

This doc covers the shared architecture and calls out where the builds diverge.

---

## Layered Architecture

```
┌─────────────────────────────────────────────────────┐
│                   Side Panel (UI)                    │
│  sidepanel.js  ·  settings.js  ·  traces.js          │
│  locale: i18n.js / locales/*.js                      │
└──────────────┬──────────────────────────────────────┘
               │ chrome.runtime.sendMessage({action, ...})
               ▼
┌─────────────────────────────────────────────────────┐
│              Background Script / Service Worker      │
│                                                      │
│  background.js        — message router               │
│    └─ agent.js        — agent loop + executeTool()   │
│         ├─ tools.js   — tool schemas + system prompts│
│         ├─ planner.js — Plan-before-Act JSON planner │
│         ├─ adapters.js— per-site guidance            │
│         ├─ permission-gate.js — capability grants     │
│         ├─ credential-fields.js — secret detection   │
│         ├─ captcha-solver.js — CapSolver integration │
│         ├─ user-memory.js — local preference memory  │
│         ├─ loop-bucket.js — URL-family loop bucketing│
│         └─ pdf-tools.js — PDF text extraction        │
│    ├─ providers/       — LLM provider abstraction    │
│    ├─ network/         — fetch_url, downloads        │
│    ├─ trace/           — optional IndexedDB recorder │
│    └─ recorder/        — tab recording orchestration │
│                                                      │
│  Chrome only:                                        │
│    ├─ cdp/             — Chrome DevTools Protocol    │
│    └─ offscreen/       — fetch proxy + tab recorder  │
└──────┬──────────────────────────────────────────────┘
       │ chrome.scripting.executeScript / CDP
       ▼
┌─────────────────────────────────────────────────────┐
│                Content Scripts (injected)             │
│                                                      │
│  accessibility-tree.js  — AX tree builder + ref_ids  │
│  content.js             — DOM reader, clicker, typer │
│  agent-visual-indicator.js — pulsing border + Stop   │
└─────────────────────────────────────────────────────┘
```

### Side Panel (`src/ui/sidepanel.js`)

The chat UI. Communicates with the background script via `chrome.runtime.sendMessage` (`browser.runtime.sendMessage` on Firefox). Supports three conversation modes:

- **Ask mode** — semantic/read-only tools only (`ASK_ONLY_TOOLS` in `tools.js`). The agent can read, analyze, and summarize but never click, type, or navigate. Ask intentionally excludes developer/debugging read tools like `read_page_source`, `inspect_element_styles`, and the `clarify` tool; ordinary clarification is just normal chat.
- **Act mode** — the selected provider tier's normal browser-agent tools. The agent can take real actions in the browser.
- **Dev mode** — an action mode for page debugging and HTML/CSS inspection. Dev requires a Mid or Full provider tier, uses the selected Act prompt tier, then appends the Dev prompt appendix and exposes Dev add-ons such as source/style tools. Compact-tier providers cannot enter Dev mode.

Model tiering is separate from mode: `compact | mid | full` controls how many normal tools the model sees, while `ask | act | dev` controls what kind of task the user is allowing.

The user types a message, the panel sends `{action: 'chat', text, mode, tabId}` to the background, then listens for `agent_update` events streamed back during the run. The panel renders tool calls, results, plan-review cards, clarification prompts, and the final answer incrementally.

Slash commands are defined as structured `SLASH_COMMANDS` metadata in each
side panel. The metadata owns canonical usage signatures, option descriptions,
browser availability, action routing, and busy eligibility; `/help` and the
progressive command/flag autocomplete are generated from it. Parsing is
case-insensitive but token-exact, rejects invalid or retired syntax locally,
and never forwards an unrecognized slash command to the model. Firefox keeps
unsupported Chrome-only commands and flags out of discovery while retaining
enough metadata to return an explicit unsupported error when they are typed.

### Background Script (`src/chrome/src/background.js`)

The central message router. On Chrome it's a service worker (MV3); on Firefox it's a persistent background page (MV2). Responsibilities:

1. **Route messages** between the side panel, content scripts, and the agent
2. **Manage the agent lifecycle**: `chat` / `chat_stream` / `continue` / `abort` / `clear_conversation`
3. **Manage provider config**: load, save, test, switch active provider
4. **Manage side panel visibility**: per-window "WebBrain" tab group controls where the panel is enabled
5. **Observe same-tab XHR/fetch requests** with `webRequest` so loop detection can suggest an exact `fetch_url` shortcut when repeated UI clicks trigger the same background request
6. **Expose Claude OAuth**, tab recording, CAPTCHA, and other sub-features as message handlers

### Content Scripts (`src/chrome/src/content/`)

Injected into every page (`<all_urls>`). Two files loaded sequentially:

1. **`accessibility-tree.js`** — exposes `window.__generateAccessibilityTree()` (DOM walker that produces the flat indented text tree), `window.__wb_ax_lookup()` (ref_id → Element resolver), and `window.__wbElementMap` (WeakRef-backed registry). Ships before `content.js` so the AX handlers are ready.
2. **`content.js`** — DOM reader, interactive-element discovery, click/type/press_keys/scroll implementations, and iframe/frame support. Handlers for all content-script-dispatched tools.

---

## Complete Turn Flow

```
User types "create a product 'namaz' priced 500 CNY, recurring every 2 months"
```

### Step 1: Side Panel → Background
```
sidepanel.js → chrome.runtime.sendMessage({
  action: 'chat',
  text: 'create a product ...',
  mode: 'act',
  tabId: 42
})
```

### Step 2: Background → Agent
```
background.js handleMessage('chat')
  → agent.processMessage(tabId, text, onUpdate, mode)
```

### Step 3: Enrich First User Message
```
_enrichUserMessageWithCurrentPage(tabId, messages, userMessage)

  1. Collect URL + title via chrome.tabs.get(tabId)
  2. If /allow-api set for this tab → inject [USER OVERRIDE] preamble
  3. If site adapters enabled → getActiveAdapter(url) → inject adapter notes
  4. If provider supports vision (or dedicated vision model configured):
     a. Capture viewport screenshot via CDP
     b. (Optional) Sub-call dedicated vision model for text description
     c. Attach image_url block or vision description to first user message
  5. Return enriched user message
```

### Step 4: Plan-before-Act Gate

When `planBeforeAct` is enabled and the run is in an action mode (Act or Dev), the agent calls the active provider once before the tool loop with `planner.js`'s structured JSON prompt. Unset storage defaults to try mode; explicit off remains off. The planner sees the user task, sanitized URL/title, and a short recent-history digest; page context is wrapped as untrusted data and image blocks are dropped.

If the planner returns valid JSON, the side panel receives `agent_update: plan_review` and renders an editable review card. Approval pins the approved plan into the scratchpad so it survives context compaction. Rejection, timeout, invalid JSON after retry, or user abort stops the run before any browser tools execute. Scheduled runs can set `autoApprovePlanReview` and pin the plan without showing the card.

### Step 5: Main Agent Loop
```
while (steps < maxSteps) {
  // 5a. Call LLM
  const tier = provider.promptTier;
  const result = await provider.chat(messages, {
    tools: getToolsForMode(mode, { tier }),
    temperature: mode === 'ask' ? 0.3 : 0.15,
    maxTokens: 4096,
  })

  // 5b. Parse response
  if (result.toolCalls) {
    // 5c. Execute tool batch
    for (const tc of result.toolCalls) {
      const toolResult = await executeTool(tabId, name, args)

      // 5d. Loop detection
      const loop = _checkLoop(tabId, name, args, toolResult)
      if (loop.kind === 'stop') → return loop.message

      // 5e. Auto-screenshot (if mode permits)
      if (_shouldAutoScreenshot(name)) {
        capture CDP screenshot → attach image_url block
      }

      messages.push({ role: 'tool', content: toolResult })
    }
  } else {
    // 5f. Text-only response → final answer
    return result.content
  }
}
```

### Step 6: Tool Execution

`executeTool(tabId, name, args, onUpdate)` dispatches by name:

| Tool group | Handler | Where it runs |
|---|---|---|
| `get_accessibility_tree`, `click_ax`, `type_ax`, `set_field`, `hover` | content script message | Injected page context |
| `click`, `type_text`, `press_keys`, `scroll`, `read_page`, etc. | content script message | Injected page context |
| `navigate`, `new_tab`, `go_back`, `go_forward` | `chrome.tabs` / `browser.tabs` API | Background script |
| `fetch_url`, `research_url`, `list_downloads`, etc. | `network-tools.js` | Service worker |
| Enabled skill tools | `skills.js` registry + `executeHttpSkillTool()` | Service worker |
| `done` | agent.js — captures verification screenshot + page state probe | Service worker + CDP |
| `clarify` | agent.js — pauses for user input | Service worker |
| `solve_captcha` | captcha-solver.js | Service worker + CapSolver API |
| `read_pdf` | pdf-tools.js | Service worker |
| `scratchpad_write` | agent.js — in-memory pinned note | Service worker |
| `read_page_source`, `inspect_element_styles` | agent/content helpers | Dev-only source/style inspection |
| `inject_css`, `remove_injected_css` | `chrome.scripting.insertCSS/removeCSS` + document-bound session patch metadata | Chrome Dev-only reversible CSS |
| `patch_element`, `revert_patch`, `highlight_element` | permission-gated content-script Dev helpers | Chrome Dev-only structured DOM edits / overlay |
| `execute_js` | bounded CDP `Runtime.evaluate` (Chrome) / content script (Firefox) | Dev-only page JavaScript |
| `read_console`, `inspect_network_requests` | mode-scoped bounded CDP Runtime/Log/Network buffers | Chrome Dev-only diagnostics |
| `inspect_event_listeners` | permission-gated content target marker + CDP `DOMDebugger.getEventListeners` | Chrome Dev-only listener diagnosis |
| `get_shadow_dom`, `shadow_dom_query`, `get_frames` | content/CDP helpers | Full Act advanced fallbacks; also added to Mid in Dev mode |

Chrome CSS patch records include the top-level `documentId` and a patch-specific CSS marker. Full navigation clears persisted records, and `remove_injected_css` checks the live document before calling `removeCSS`, preventing an old patch ID from removing equivalent CSS on a replacement page. If navigation races either identity check during injection, WebBrain removes that patch's exact uniquely marked CSS from the replacement document before discarding its record. Chrome `execute_js` passes a 15-second timeout to CDP. Dev diagnostic event handlers are registered before either agent-loop variant starts; leaving the panel-wide Dev mode drains every tab in the CDP client's active-diagnostics registry, removes the handlers and buffers, and sends `Runtime.disable`, `Log.disable`, and `Network.disable` so Chrome also stops domain-level diagnostic work.

### Step 6a: Skills and Dynamic Tool Exposure

Settings -> Skills stores enabled skills in `customSkills` (`chrome.storage.local`
or `browser.storage.local`). On startup, `background.js` loads packaged default
skills from `skills/*`, seeds FreeSkillz.xyz the first time, and refreshes an
existing built-in skill record when the packaged copy changes. If the user
removes a default skill, the seeding marker prevents it from being silently
re-added.

`agent/skills.js` normalizes each skill and handles two separate surfaces:

- Prompt instructions: `buildCustomSkillsPrompt()` strips fenced
  `webbrain-tools` blocks before appending the skill text to the system prompt.
- Tool exposure: `buildSkillToolDefinitions()` reads the manifest and appends
  declared tool schemas to `getToolsForMode(...)` at LLM-call time, respecting
  the active conversation mode and provider tier. Download-job skill tools are
  hidden in Ask and available in action modes (Act and Dev) when their declared
  tier allows them.

The manifest format is a fenced JSON block inside the skill markdown:

````markdown
```webbrain-tools
{
  "tools": [
    {
      "name": "read_youtube_transcript",
      "kind": "http",
      "readOnly": true,
      "method": "POST",
      "endpoint": "https://freeskillz.xyz/v1/youtube/transcript",
      "activeTabUrlArg": "url",
      "inputUrlArg": "url",
      "resultPolicy": "untrusted",
      "parameters": {
        "type": "object",
        "properties": {
          "url": { "type": "string" }
        },
        "required": []
      }
    }
  ]
}
```
````

Current skill tools support `kind: "http"` for read-only HTTPS GET/POST
integrations and `kind: "httpDownloadJob"` for short-lived HTTPS POST jobs that
poll a same-origin status URL, save the produced file through browser Downloads,
and call cleanup afterward. Requests use `credentials: "omit"` and optional
manifest allowlists can restrict URL-like inputs. This is intentionally a
trust-at-import model for the declared endpoint; download-job tools still run in
action modes and use the normal Downloads permission gate before saving files.
Results that carry third-party content should set `resultPolicy: "untrusted"` so
`_wrapUntrusted()` and `_digestToolResult()` treat them as data rather than
instructions.

### Step 7: Results Back to UI

The agent calls `onUpdate(type, data)` for each event:
- `tool_call` — tool name + args
- `tool_result` — tool name + result JSON
- `text` / `text_delta` — assistant response tokens
- `warning` — loop detection, navigation warnings
- `clarify` — pending user question
- `plan_review` — structured plan awaiting approval before Act tools run
- `error` — run errors

Background relays these via `chrome.runtime.sendMessage` to the side panel, which renders them incrementally.

---

## Key Subsystems

### Plan before Act (`planner.js`)

The optional action-mode planning gate runs before the first browser tool call when enabled; unset storage defaults to try mode while explicit off remains off. The planner prompt requires a single JSON object with summary, concrete steps, memory strategy, scheduling hint, risks, and an action mode. `normalizePlan()` bounds and sanitizes each field; `formatPlanMarkdown()` renders the side-panel review card; `formatPlanScratchpad()` pins the approved or edited plan as an `[Approved plan]` scratchpad entry.

Planner calls are traced with `phase: "planner"` when trace recording is enabled. They also use the cost allowance guard, abort checks, a JSON-repair retry, and Qwen/DeepSeek no-think handling before the run is allowed to continue.

### User Memory (`user-memory.js`)

User memory stores local, user-stated durable preferences and profile/workflow
hints in `wb_user_memory_v1` using this v1 shape:
`{ version, updatedAt, records: [{ id, text, kind, scope, confidence, source, createdAt, updatedAt, lastUsedAt, archivedAt }] }`.
Allowed `kind` values are `preference`, `profile_hint`, and
`workflow_preference`. Normalization drops malformed records, obvious secrets,
page facts, attachment bodies, and duplicate normalized text.

The agent hydrates memory from local storage before the first handled message
and listens for storage changes so live conversations refresh their system
prompt without losing chat history. `_buildSystemPrompt()` injects memory after
profile/custom-skill guidance as a bounded block headed with a reminder that
memory is context, not a command. `userMemoryMaxPromptChars` caps the block
locally; v1 does not use embeddings or retrieval calls.

Explicit `/memory --add <text>` writes immediately through `add_user_memory` and
enables memory if needed. `/memory` and `/memory --forget <id>` expose the
same local store from the side panel. Settings -> Profile provides enable,
auto-learn, edit, delete, clear, export, and import controls for Chrome and
Firefox.

Optional auto-learning is off by default. After successful `chat`,
`chat_stream`, or `continue` completion, the background script queues a small
extractor job with only the latest user text, final assistant text, current
memory list, mode, and success state. The response path does not await this
job. A short queue drains best-effort through the active provider using the
existing cost allowance guard; cost exhaustion skips extraction silently, and
other failures retry once.

### Scheduled Tasks (`scheduler.js`)

The scheduler lets the agent defer work to a future browser session using the browser's `alarms` API. It lives in `src/chrome/src/agent/scheduler.js` (and the Firefox mirror) and is instantiated as `ScheduledJobManager` in the background script.

**Job kinds**

| Kind | Created by | Behavior |
|---|---|---|
| `resume` | `schedule_resume` tool | Continues the current conversation in the same tab at a future time. Terminal tool — the current run ends when it fires. |
| `task` | `schedule_task` tool | Runs a standalone user-authored prompt at a future time, optionally recurring. |

**Job lifecycle**

```
pending → running → completed
       ↘ queued ↗ ↘ needs_user_input
                    ↓
               failed / cancelled / paused
```

- `pending` — alarm is set; waiting to fire.
- `queued` — alarm fired but the tab was busy; retries every 30 s (up to 120 deferrals before failing).
- `running` — agent is actively executing the job.
- `needs_user_input` — agent issued a `clarify` mid-run; waiting for the user's reply.
- `paused` — user or settings paused the job; no alarm is set.
- `cancelled` / `failed` / `completed` — terminal states.

**Targets**

- `current_tab` — runs against the tab that was active when the job was created; fails if the tab is gone or has navigated away.
- `url` — opens (or reuses) a tab for a given http(s) URL at run time.

**Schedule**

- `once` — fires at a single `run_at` or `after_seconds` time. `after_seconds: 0` starts the task immediately.
- `recurring` — fires repeatedly at `interval_minutes` (1 min – 1 year); after each run completes, `nextRunAt` is advanced and the next alarm is set.

**Persistence**

Jobs are stored in `chrome.storage.local` under the key `wb_scheduled_jobs` as a JSON array. On background restart, any jobs in `running`/`needs_user_input` are demoted to `queued` and retried, so no run is silently lost.

**Settings**

| Key | Default | Effect |
|---|---|---|
| `scheduledTasksEnabled` | `true` | If false, pending jobs are paused instead of executed when their alarm fires. |
| `scheduledRequireConsequentialConfirmation` | `true` | Passes a policy flag to the agent requiring explicit user confirmation before consequential scheduled actions. |

**LLM tools**

| Tool | When to use |
|---|---|
| `schedule_resume({after_seconds\|run_at, reason, resume_instruction})` | Durable pause for the *current* task when blocked on an external event (CI build, email, deploy). Terminal — the run ends after calling it. |
| `schedule_task({title, prompt, schedule, target, mode})` | Create a standalone one-shot or recurring task. `after_seconds: 0` starts now; nonzero future delays still require at least 60 seconds. Only when the user explicitly asks for scheduled work. |

---

### Site Adapters (`adapters.js`)

58+ adapters inject site-specific guidance into the first user message (and re-inject on navigation to a different matched site). Only ONE adapter fires at a time (`getActiveAdapter(url)` returns the first match). See `docs/site-adapters.md` for how to write one.

### Accessibility Tree (`accessibility-tree.js`)

The primary page-interaction path. Produces a flat, indented text tree of the page where each node has a stable `ref_id`. Tools: `get_accessibility_tree`, `click_ax`, `type_ax`, `set_field`. See `docs/accessibility-tree-and-refs.md`.

### CDP Client (`cdp-client.js`) — Chrome only

Wraps `chrome.debugger` API for:
- **Trusted events** — `Input.dispatchMouseEvent`, `Input.dispatchKeyEvent` (event.isTrusted === true)
- **Screenshots** — `Page.captureScreenshot` with clip/scale control
- **DOM queries** — `Runtime.evaluate` for shadow DOM piercing, `DOM.getDocument` for closed roots

Without CDP (Firefox), all events are synthetic (`el.click()`, `new KeyboardEvent()`).

### Provider System (`providers/`)

Abstracts LLM backends behind a common interface (`BaseLLMProvider`):

```
chat(messages, options)       → { content, toolCalls, usage }
chatStream(messages, options) → async generator
supportsTools                 → boolean
supportsVision                → boolean
promptTier                    → 'compact' | 'mid' | 'full'
testConnection()              → { ok, error, model }
```

`promptTier` drives both the action prompt and the normal tool subset. Local providers default to Mid, cloud providers are forced Full, and the legacy `useCompactPrompt` flag maps to Compact for existing configs. Dev mode is a separate conversation mode: Mid/Full Dev uses the selected Act tier plus `SYSTEM_PROMPT_DEV_APPENDIX`; Compact Dev is blocked before an LLM request is sent.

See `docs/providers-and-models.md`.

### Loop Detection (`agent.js`)

Three independent detectors run after every tool call:

1. **General repeat** — last 6 tool calls by (name + args hash + outcome). Nudge at 3 identical or ABAB. Stop at 8 nudges without 2 healthy calls between.
2. **Coordinate click** — 5px-bucketed. Nudge at 5 same-bucket clicks. Stop at 8.
3. **Navigation** — snapshot URL before click/navigate/iframe_click, compare after.

When the opt-in API mutation observer is enabled and a repeated `click` /
`click_ax` loop is detected, `_detectApiShortcut()` checks the per-tab
webRequest buffer populated by `background.js`. The observer is off by default.
If each repeated click produced the same exact URL + HTTP method within a
3-second window, the loop warning includes a `fetch_url({url, method})`
suggestion. For replayable XHR/fetch mutations, the observer also keeps bounded
request bodies and a small allowlist of replay-safe headers behind an opaque
`replayRequestId`; hidden form tokens are reused internally by `fetch_url` only
for the same tab and origin, not printed into model context. Write methods still
require the conversation's `/allow-api` state; GET requests and non-network
capabilities still use the normal permission gate.

### Context Management (`agent.js`)

- **Auto-compaction** (`_manageContext`) — runs both at the start of each user turn *and* at the top of every agent-loop iteration, so a long autonomous run compacts mid-flight ("when it's due"), not only between turns. Triggers on whichever fires first:
  - **message count** > 50, or **raw chars** > 80,000, or
  - **token budget** — the running input-token count crossing `contextCompactRatio` (0.75) of the active provider's `contextWindow` (`providers/base.js`; category-aware default of 16k for local backends and 128k for cloud/router, overridable per provider via `config.contextWindow`). The token count prefers the provider's reported `usage.prompt_tokens` (which includes the system prompt + tool schemas) and falls back to a chars/4 estimate on the streaming path.
  - On compaction it keeps system prompt + original user task + LLM-summarized old messages + last 30 verbatim, then emits `onUpdate('context_compacted', …)`. The side panel renders an inline **"Context automatically compacted"** separator so the user knows history was summarized, not lost.
- **Emergency trim** on context overflow: keeps only last 6 messages (the hard fallback when a provider still rejects the request after auto-compaction)
- **Image pruning**: strips base64 images from all but the last 4 messages before each LLM call
- **Tool result cap**: individual results truncated at 8,000 chars

### Conversation Persistence (Chrome only)

MV3 service workers can die between turns. Conversations are persisted to `chrome.storage.session` (debounced 300ms) and hydrated on first message to a tab. Per-tab isolated.

---

## Chrome vs Firefox Key Differences

| Area | Chrome (MV3) | Firefox (MV2) |
|---|---|---|
| Background | Service worker (ephemeral) | Background page (persistent) |
| Events | CDP-trusted (`isTrusted=true`) | Synthetic (`isTrusted=false`) |
| Screenshots | CDP `Page.captureScreenshot` | `browser.tabs.captureVisibleTab()` |
| Conversation persistence | `chrome.storage.session` | In-memory only |
| Offscreen document | Yes (fetch proxy + recorder) | Not available |
| Trace recorder | IndexedDB (opt-in) | IndexedDB (opt-in) — same `trace/recorder.js` |
| Duplicate-submit guard | Yes | Not available |
| `execute_js` | Dev mode through CDP `Runtime.evaluate` | Dev mode through the MV2 content-script evaluator |
| Reversible Dev patches | CSS + structured element patches with patch IDs | Not yet available |
| Console/network/listener diagnostics | Bounded CDP-backed Dev tools | Not yet available |
| Shadow DOM piercing | CDP for closed roots; `shadow_dom_query` is Chrome-only | Open roots only |
| Localhost CORS | Offscreen proxy fallback | Server must set CORS headers |
| API shortcut observer | `chrome.webRequest` URL/method buffer | `browser.webRequest` URL/method buffer |
| Slash-driven tab/screen recording | `chrome.tabCapture` / `getDisplayMedia()` + offscreen | Not available |
| Side panel | `sidePanel` API (MV3) | `sidebar_action` (MV2) |
| File upload | CDP-powered | Manual dispatch |

Everything else (agent loop, tools, adapters, providers, loop detection, context management, system prompts) is architecturally identical between the two builds.

---

## Directory Layout

```
src/
├── chrome/           # Chromium build (MV3)
│   ├── manifest.json
│   ├── skills/       # Packaged default skills
│   └── src/
│       ├── agent/    # agent.js, tools.js, skills.js, adapters.js, scheduler.js, ...
│       ├── cdp/      # CDP client (Chrome only)
│       ├── content/  # accessibility-tree.js, content.js, ...
│       ├── network/  # network-tools.js
│       ├── offscreen/# Fetch proxy + slash-driven recorder (Chrome only)
│       ├── providers/# BaseLLMProvider + implementations
│       ├── recorder/ # Recording orchestration
│       ├── trace/    # IndexedDB recorder
│       └── ui/       # sidepanel, settings, traces, i18n
├── firefox/          # Firefox build (MV2)
│   ├── manifest.json
│   ├── skills/       # Packaged default skills
│   └── src/          # Same structure, minus cdp/, offscreen/, recorder/
└── vendor/           # Third-party libs (pdfjs, katex)
```

Both builds share the same adapter set, provider implementations, accessibility tree, and most tool code. The `src/shared/` pattern is intentionally avoided — files are duplicated between `chrome/` and `firefox/` so each build is self-contained and can be loaded directly without a build step for development.

---

## Security Model

See `docs/security-model.md` and `src/chrome/ARCHITECTURE.md` for details.

Key points:
- Extension runs with `<all_urls>` + `debugger` permissions — full browser access
- No additional auth: the agent IS the user's browser session
- Ask is read-only; Act and Dev are action modes. Dev adds source/style/page-debugging tools and is blocked for Compact-tier providers.
- Plan before Act can require human approval before any action-mode tool call
- `/allow-api` flag gates destructive HTTP methods via `fetch_url`
- Tool results capped at 8 KB to limit prompt-injection surface
- `strictSecretMode` prevents the model from quoting credentials in summaries
- Trace data is local-only (IndexedDB), never transmitted
- Offscreen proxy only forwards provider SDK traffic
- Finance adapters inject extra confirmation guidance
