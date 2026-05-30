# WebBrain Architecture

> Version 8.8.0

## Overview

WebBrain is a browser extension that gives an LLM control over the user's active browser tab. The user types a natural-language instruction in a side panel, and an autonomous agent loop calls the LLM, executes tool calls (click, type, navigate, screenshot, etc.), feeds results back to the LLM, and repeats until the task is done.

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
│         ├─ adapters.js— per-site guidance            │
│         ├─ credential-fields.js — secret detection   │
│         ├─ captcha-solver.js — CapSolver integration │
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

The chat UI. Communicates with the background script via `chrome.runtime.sendMessage` (`browser.runtime.sendMessage` on Firefox). Supports two modes:

- **Ask mode** — read-only tools only (`ASK_ONLY_TOOLS` in `tools.js`). The agent can read, analyze, and summarize but never click, type, or navigate.
- **Act mode** — full tool set. The agent can take real actions in the browser.

The user types a message, the panel sends `{action: 'chat', text, mode, tabId}` to the background, then listens for `agent_update` events streamed back during the run. The panel renders tool calls, results, and the final answer incrementally.

### Background Script (`src/chrome/src/background.js`)

The central message router. On Chrome it's a service worker (MV3); on Firefox it's a persistent background page (MV2). Responsibilities:

1. **Route messages** between the side panel, content scripts, and the agent
2. **Manage the agent lifecycle**: `chat` / `chat_stream` / `continue` / `abort` / `clear_conversation`
3. **Manage provider config**: load, save, test, switch active provider
4. **Manage side panel visibility**: per-window "WebBrain" tab group controls where the panel is enabled
5. **Expose Claude OAuth**, tab recording, CAPTCHA, and other sub-features as message handlers

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

### Step 4: Main Agent Loop
```
while (steps < maxSteps) {
  // 4a. Call LLM
  const result = await provider.chat(messages, {
    tools: getToolsForMode(mode),
    temperature: 0.3,
    maxTokens: 4096,
  })

  // 4b. Parse response
  if (result.toolCalls) {
    // 4c. Execute tool batch
    for (const tc of result.toolCalls) {
      const toolResult = await executeTool(tabId, name, args)

      // 4d. Loop detection
      const loop = _checkLoop(tabId, name, args, toolResult)
      if (loop.kind === 'stop') → return loop.message

      // 4e. Auto-screenshot (if mode permits)
      if (_shouldAutoScreenshot(name)) {
        capture CDP screenshot → attach image_url block
      }

      messages.push({ role: 'tool', content: toolResult })
    }
  } else {
    // 4f. Text-only response → final answer
    return result.content
  }
}
```

### Step 5: Tool Execution

`executeTool(tabId, name, args, onUpdate)` dispatches by name:

| Tool group | Handler | Where it runs |
|---|---|---|
| `get_accessibility_tree`, `click_ax`, `type_ax`, `set_field`, `hover` | content script message | Injected page context |
| `click`, `type_text`, `press_keys`, `scroll`, `read_page`, `screenshot`, etc. | content script message | Injected page context |
| `navigate`, `new_tab` | `chrome.tabs` API | Service worker |
| `fetch_url`, `research_url`, `list_downloads`, etc. | `network-tools.js` | Service worker |
| `done` | agent.js — captures verification screenshot + page state probe | Service worker + CDP |
| `clarify` | agent.js — pauses for user input | Service worker |
| `solve_captcha` | captcha-solver.js | Service worker + CapSolver API |
| `record_tab`, `stop_recording` | recorder/host.js | Service worker + offscreen doc |
| `read_pdf` | pdf-tools.js | Service worker |
| `scratchpad_write` | agent.js — in-memory pinned note | Service worker |

### Step 6: Results Back to UI

The agent calls `onUpdate(type, data)` for each event:
- `tool_call` — tool name + args
- `tool_result` — tool name + result JSON
- `text` / `text_delta` — assistant response tokens
- `warning` — loop detection, navigation warnings
- `clarify` — pending user question
- `error` — run errors

Background relays these via `chrome.runtime.sendMessage` to the side panel, which renders them incrementally.

---

## Key Subsystems

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
chat(messages, options)      → { content, toolCalls, usage }
chatStream(messages, options) → async generator
supportsTools                 → boolean
supportsVision                → boolean
useCompactPrompt              → boolean
testConnection()              → { ok, error, model }
```

See `docs/providers-and-models.md`.

### Loop Detection (`agent.js`)

Three independent detectors run after every tool call:

1. **General repeat** — last 6 tool calls by (name + args hash + outcome). Nudge at 3 identical or ABAB. Stop at 8 nudges without 2 healthy calls between.
2. **Coordinate click** — 5px-bucketed. Nudge at 5 same-bucket clicks. Stop at 8.
3. **Navigation** — snapshot URL before click/navigate/iframe_click, compare after.

### Context Management (`agent.js`)

- **Auto-trim** at >50 messages or >80,000 chars: keeps system prompt + original user task + LLM-summarized old messages + last 30 verbatim
- **Emergency trim** on context overflow: keeps only last 6 messages
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
| Full-page screenshot | CDP scroll+stitch | Not available |
| Conversation persistence | `chrome.storage.session` | In-memory only |
| Offscreen document | Yes (fetch proxy + recorder) | Not available |
| Trace recorder | IndexedDB (opt-in) | Not available |
| Duplicate-submit guard | Yes | Not available |
| `execute_js` | Blocked by CSP | Available |
| Shadow DOM piercing | CDP for closed roots | Open roots only |
| Localhost CORS | Offscreen proxy fallback | Server must set CORS headers |
| Tab recording | `chrome.tabCapture` + offscreen | Not available |
| Side panel | `sidePanel` API (MV3) | `sidebar_action` (MV2) |
| File upload | CDP-powered | Manual dispatch |

Everything else (agent loop, tools, adapters, providers, loop detection, context management, system prompts) is architecturally identical between the two builds.

---

## Directory Layout

```
src/
├── chrome/           # Chromium build (MV3)
│   ├── manifest.json
│   └── src/
│       ├── agent/    # agent.js, tools.js, adapters.js, ...
│       ├── cdp/      # CDP client (Chrome only)
│       ├── content/  # accessibility-tree.js, content.js, ...
│       ├── network/  # network-tools.js
│       ├── offscreen/# Fetch proxy + tab recorder (Chrome only)
│       ├── providers/# BaseLLMProvider + implementations
│       ├── recorder/ # Tab recording orchestration
│       ├── trace/    # IndexedDB recorder
│       └── ui/       # sidepanel, settings, traces, i18n
├── firefox/          # Firefox build (MV2)
│   ├── manifest.json
│   └── src/          # Same structure, minus cdp/, offscreen/, trace/
└── vendor/           # Third-party libs (pdfjs, katex)
```

Both builds share the same adapter set, provider implementations, accessibility tree, and most tool code. The `src/shared/` pattern is intentionally avoided — files are duplicated between `chrome/` and `firefox/` so each build is self-contained and can be loaded directly without a build step for development.

---

## Security Model

See `docs/security-model.md` and `src/chrome/ARCHITECTURE.md` for details.

Key points:
- Extension runs with `<all_urls>` + `debugger` permissions — full browser access
- No additional auth: the agent IS the user's browser session
- `/allow-api` flag gates destructive HTTP methods via `fetch_url`
- Tool results capped at 8 KB to limit prompt-injection surface
- `strictSecretMode` prevents the model from quoting credentials in summaries
- Trace data is local-only (IndexedDB), never transmitted
- Offscreen proxy only forwards provider SDK traffic
- Finance adapters inject extra confirmation guidance
