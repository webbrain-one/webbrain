# WebBrain Architecture

> Version 25.8.5

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
│  run-ui-journal.js     — detached-run reconnect state │
│    └─ agent.js        — agent loop + executeTool()   │
│         ├─ tools.js   — tool schemas + system prompts│
│         ├─ planner.js — Plan-before-Act JSON planner │
│         ├─ adapters.js— per-site guidance            │
│         ├─ permission-gate.js — capability grants     │
│         ├─ credential-fields.js — secret detection   │
│         ├─ rich-text-toolbar-guard.js — obligations  │
│         ├─ rich-text-toolbar-probe.js — page probes  │
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
│    └─ offscreen/       — fetch proxy + recorder + local vision worker │
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

The user types a message, the panel sends a detached `{action: 'chat_start', text, mode, tabId, requestId}` request, then reconnects to the background-owned run journal for `agent_update` events. The acknowledged start becomes the existing `chat` handler and `agent.processMessage()` lifecycle; closing or reloading the panel does not transfer ownership or start the run again. The panel renders tool calls, results, plan-review cards, clarification prompts, and the final answer incrementally.

Each new user/assistant pair starts in a reading-first scroll state: the question
stays visible while a long response grows instead of being pushed immediately
to the live edge. A floating control changes between **Follow response**,
**Jump to latest**, and **Back to question** as the viewport crosses the two
turn anchors. Reaching the bottom deliberately resumes auto-follow; manual
reading positions are otherwise preserved. Blocking plan/clarification/Continue
cards, store-review prompts, new questions, and slash-command output force the
relevant content into view.

Slash commands are defined as structured `SLASH_COMMANDS` metadata in each
side panel. The metadata owns canonical usage signatures, option descriptions,
browser availability, action routing, and busy eligibility; `/help` and the
progressive command/flag autocomplete are generated from it. Parsing is
case-insensitive but token-exact, rejects invalid or retired syntax locally,
and never forwards an unrecognized slash command to the model. Firefox keeps
unsupported Chrome-only commands and flags out of discovery while retaining
enough metadata to return an explicit unsupported error when they are typed.
Normal prompts also have two intentionally undiscoverable run-capture suffixes:
trailing `/record [--save-as <filename>]` wraps a Chrome run in tab recording,
while trailing `/screenshot [--save-as <filename>]` saves before/after viewport
captures in both browsers. The panel strips the suffix before agent dispatch,
starts capture before `chat`, and finalizes it from the run's `finally` path.

Settings transfer is also slash-driven. `/export --config` asks the background
for an allowlisted, default-resolved `webbrain-config/1` snapshot, and
`/import <json>` or `/import --file` validates that schema before replacing the
portable Settings state and rehydrating providers and live agent settings.
Provider and auxiliary-model API keys are intentionally included in plaintext;
device-bound Cloud Sync credentials and device IDs, conversation/runtime data,
scheduled jobs, usage counters, and spend history are intentionally excluded.
If a run activates another tab, the screenshot finalizer reactivates the
originating run tab before capturing its after state.

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

### Rich-text toolbar safety boundary

Text-entry attempts that resolve to formatting controls are blocked before dispatch. `rich-text-toolbar-guard.js` owns the single per-tab obligation ledger, including normalization, deduplication, navigation demotion, `recoveryObligations[]` persistence, completion blocking, and pure recovery matching. The Chrome and Firefox guard modules are byte-identical.

`rich-text-toolbar-probe.js` is the browser adapter: it gathers DOM/CDP evidence, resolves frames, and maps iframe geometry without owning recovery state. A successful probe returns a neutral `dispatchBinding`; click, keyboard, focused/selector typing, and iframe dispatch consume that binding so execution cannot silently retarget after preflight. If recovery is pending, a required binding failure is closed before dispatch. With no pending obligation, the legacy all-frame `iframe_type` fallback remains available.

Recovery requires a positively verified edit with the original text and clear/append semantics in the associated editor scope. Failed or merely unverified edits leave the obligation in the ledger and continue to block a successful completion.

---

## Complete Turn Flow

```
User types "create a product 'namaz' priced 500 CNY, recurring every 2 months"
```

### Step 1: Side Panel → Background
```
sidepanel.js → sendRunWithReconnect('chat_start', {
  text: 'create a product ...',
  mode: 'act',
  tabId: 42,
  requestId: '...'
})
```

### Step 2: Background → Agent
```
background.js handleMessage('chat_start')
  → launchDetachedRun('chat', request)
  → background.js handleMessage('chat')
  → agent.processMessage(tabId, text, onUpdate, mode, attachments, runOptions)
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

#### Page context reduction

WebBrain does not send raw HTML or a raw DOM dump to the model by default. The
initial page context is the sanitized URL and title, matching site-adapter
guidance, and an optional viewport screenshot when vision is available. When a
task needs page content, the agent requests it on demand as a reduced semantic
accessibility tree or as extracted text.

These reads use visibility filters where appropriate, enforce character
budgets, and paginate larger results instead of placing the entire rendered
document into one model request. See [accessibility read budgets](agent-tools.md#accessibility-read-budgets)
and [adaptive read windows](accessibility-tree-and-refs.md#adaptive-read-windows).
Raw page-source access through `read_page_source` is available only in Dev mode.

### Step 4: Plan-before-Act Gate

Manual action-mode runs (Act or Dev) call the active provider once before the tool loop with `planner.js`'s structured JSON prompt. Off uses the compact intent schema; Try and Strict use the full plan schema. Unset storage defaults to Try, while explicit Off remains Off. The planner sees the user task, sanitized URL/title, and a short recent-history digest; page context is wrapped as untrusted data and image blocks are dropped.

When the active site adapter has a validated `webbrain-adapter-workflow/2`
profile, both planner variants also receive its bounded app-owned job IDs and
descriptions. The planner returns a nullable `site_job`; the runtime resolves
that ID again against the exact active adapter instead of trusting page text or
matching user-language keywords. A selected job can tighten state-change and
require job-bound terminal evidence after submission (for example paid/ticket-
issued transaction state or recipient-bound sent-message state). Jobs that
require a ledger must exactly reconcile terminal ledger IDs against a complete
app-owned accessibility-tree or seeded inventory; model-created rows cannot prove
coverage. Every matched adapter records adapter/revision/notes-injected as
content-free trace metadata, while a selected workflow additionally records its
adapter/revision/job/template. Any user edit to reviewed plan text discards the
hidden job binding.

If the planner returns valid JSON, the side panel receives `agent_update: plan_review` and renders an editable review card. Approval pins the approved plan into the scratchpad so it survives context compaction. Rejection, timeout, or user abort stops the run before any browser tools execute. In Try mode, invalid JSON after one repair degrades only that turn to the Ask prompt and read-only tool catalog; Strict mode still stops before tools. Scheduled runs can set `autoApprovePlanReview` and pin the plan without showing the card.

### Step 5: Main Agent Loop
```
while (steps < maxSteps) {
  // 5a. Call LLM
  const tier = provider.promptTier;
  const result = await chatMainTurn(messages, {
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

When an interactive, tool-capable run exhausts its configured agent steps
without a terminal answer, the browser loop stays closed and WebBrain performs
one context-only handoff with only `done` available. That terminal schema permits
`partial` or `failed`, never `success`; invalid output falls back to the
deterministic step-limit summary. This also applies to the selected WebBrain
Compass provider without changing its advisory in-loop observation checkpoints.
Structured Cloud API runs keep their separate `done_json` output contract and do
not enter this handoff.

### Ask-only provider streaming

`chatMainTurn()` normally delegates to the established cost-aware
`provider.chat()` call. It selects the stream aggregator only when all of these
conditions are true:

- the mode is `ask`;
- the run came from the normal interactive detached `chat_start` path;
- the Advanced Ask-streaming kill switch (persisted under the legacy
  `openaiAskStreamingEnabled` storage key) is not off;
- the provider reports `_supportsInteractiveAskStreaming() === true`;
- the run is not a trusted Continue, cloud run, scheduled/non-interactive run,
  or a run whose stream circuit breaker already opened.

Official OpenAI GPT-5.6 and streaming-capable Responses-only GPT-5 Pro variants
use Responses streaming. Other supported official OpenAI models use Chat
Completions streaming. Anthropic uses its native Messages event parser, Azure
OpenAI uses its deployment-based parser, and Gemini, DeepSeek, xAI, Mistral,
Nvidia NIM, Groq, Together AI, Fireworks, z.ai, OpenRouter, WebBrain Compass,
Ollama, LM Studio, Jan, vLLM, SGLang, LocalAI, and Unsloth Studio use the OpenAI-compatible
Chat Completions parser. z.ai streaming tool calls add its documented
`tool_stream` request flag. llama.cpp uses its dedicated OpenAI-compatible
parser. Alibaba Cloud remains non-streaming because DashScope rejects
`tools` together with `stream: true`, while Ask always supplies its read-only
tool catalog. Models whose official OpenAI capability table lacks either
streaming or function calling, including GPT-5.5 Pro, also remain non-streaming.

The aggregator forwards only output-text deltas to the side panel. Reasoning,
usage, response Items, and function calls remain in memory until the provider
emits its terminal event: `response.completed` for Responses, `message_stop`
for Anthropic, or `[DONE]` for Azure/OpenAI-compatible SSE. Only then does it
return the canonical result to the existing agent loop, which may execute
buffered tools or persist the assistant turn. A transport read failure,
malformed/premature EOF, or missing terminal event clears emitted text,
disables streaming for the rest of that run, and silently retries the same
generation once through `provider.chat()`. Terminal HTTP/API or in-stream
provider errors, `content_filter` finish reasons, `response.incomplete`, and
`response.failed` propagate without issuing a duplicate non-streaming request.
The persistent setting is unchanged by a transient failure.

Live `text_delta` messages are broadcast immediately. Reconnect-journal
snapshots for consecutive deltas are cloned and written to `storage.session`
on a 200 ms trailing interval; any non-delta update, terminal state, or
pre-tool durability checkpoint cancels that timer and persists the latest
snapshot immediately.

This is intentionally an integration inside `processMessage()`, not a handoff
to the older full `processMessageStream()` loop. Attachments, detached-run
ownership, reconnect replay, persistence, traces, tool guards, and completion
invariants therefore keep one production lifecycle.

### Selected-text source scopes

Selected-text runs always carry an explicit, durable `source_grounding` policy.
Fixed actions keep `selection_only`, which uses the selected text as the only
page source while still allowing intrinsic model knowledge to explain terms
named in that selection. A free-form question may use `selection_context`, which
permits intrinsic model knowledge and a bounded projection of earlier
user/assistant dialogue so
references such as “the above” can be resolved. That projection is explicitly
non-authoritative: wrapped page text, tool results, screenshots, attachments,
and app-owned state are excluded. The current selection remains untrusted page
data inside its own boundary.

The visible transcript and provider payload are intentionally different views.
The transcript keeps every bubble for reading and recovery; the provider view
adds the scope system note, the current selection, and (for `selection_context`)
only the safe dialogue projection. Each selection adds an inline scope divider
and the side-panel banner explains the included/excluded material. The user can
confirm **Use broader conversation** to remove the scope before the next
turn; only that explicit action allows the normal conversation payload again.

`source_grounding` and the selection anchor are persisted with the per-tab
conversation, survive panel/service-worker restart, retries, tab switches, and
compaction, and are cleared by New conversation. The selection-scope fields in
trace runtime metadata record only the policy, anchor presence, and
`selection_scope_excluded_messages` count — never projected text or anchor/message
fingerprints. This allowlist does not change the broader Trace retention contract:
other run, event, screenshot, deep-debug, or lossless fields follow the current
privacy mode documented in [Privacy & Data Flow](privacy-and-data-flow.md). Treat
trace and diagnostic exports as privacy-sensitive data.

### Step 6: Tool Execution

`executeTool(tabId, name, args, onUpdate)` dispatches by name:

| Tool group | Handler | Where it runs |
|---|---|---|
| `get_accessibility_tree`, `click_ax`, `type_ax`, `set_field`, `hover` | content script message | Injected page context |
| `click`, `type_text`, `press_keys`, `scroll`, `read_page`, etc. | content script message | Injected page context |
| `navigate`, `go_back`, `go_forward` | `chrome.tabs` / `browser.tabs` API | Background script |
| `fetch_url`, `research_url`, `list_downloads`, etc. | `network-tools.js` | Service worker |
| Enabled skill tools | `skills.js` registry + `executeHttpSkillTool()` | Service worker |
| `list_webmcp_tools`, `execute_webmcp_tool` | experimental CDP `WebMCP` domain | Chrome service worker + page-registered callback |
| `done` | agent.js — captures verification screenshot + page state probe | Service worker + CDP |
| `clarify` | agent.js — pauses for user input | Service worker |
| `delegate_research` | agent.js — opens and probes a visible, fixed-origin ChatGPT helper tab | Service worker + `chrome.tabs`/`browser.tabs` + isolated page script |
| `solve_captcha` | captcha-solver.js | Service worker + CapSolver API |
| `read_pdf` | pdf-tools.js | Service worker |
| `scratchpad_write` | agent.js — in-memory pinned note | Service worker |
| `read_page_source`, `inspect_element_styles` | agent/content helpers | Dev-only source/style inspection |
| `inject_css`, `remove_injected_css` | `chrome.scripting.insertCSS/removeCSS` + document-bound session patch metadata | Chrome Dev-only reversible CSS |
| `patch_element`, `revert_patch`, `highlight_element` | permission-gated content-script Dev helpers | Chrome Dev-only structured DOM edits / overlay |
| `execute_js` | bounded CDP `Runtime.evaluate` (Chrome) / content script (Firefox) | Dev-only page JavaScript |
| `read_console`, `inspect_network_requests` | mode-scoped bounded CDP Runtime/Log/Network buffers | Chrome Dev-only diagnostics |
| `inspect_event_listeners` | permission-gated content target marker + CDP `DOMDebugger.getEventListeners` | Chrome Dev-only listener diagnosis |
| `read_email_verification_message` | service worker + bounded accessibility reads | Mid/Full only after the OTP skill is active; directly scopes verified already-open message routes, requires Act/Dev plus mailbox-host click permission to open an inbox item, and completes or rejects bounded message continuations |
| `get_shadow_dom`, `shadow_dom_query`, `get_frames` | content/CDP helpers | Full Act advanced fallbacks; also added to Mid in Dev mode |

Browser-tab creation, enumeration, activation, and run retargeting are not general model-callable capabilities. To inspect another URL, the agent uses an available URL reader; to interact with it, it navigates the current run tab. Explicit separate-tab requests are surfaced as a limitation rather than silently converted into current-tab navigation. The only private-tab exception is the single OTP-skill-gated reader above: the runtime chooses an already-open supported mailbox without exposing the tab catalog, and any message-opening helper is inactive and disposable. Internal research/helper tabs and normal page-authored `target=_blank` behavior remain separate infrastructure.

Chrome CSS patch records include the top-level `documentId` and a patch-specific CSS marker. Full navigation clears persisted records, and `remove_injected_css` checks the live document before calling `removeCSS`, preventing an old patch ID from removing equivalent CSS on a replacement page. If navigation races either identity check during injection, WebBrain removes that patch's exact uniquely marked CSS from the replacement document before discarding its record. Chrome `execute_js` passes a 15-second timeout to CDP. Dev diagnostic event handlers are registered before either agent-loop variant starts and own their debugger session across turns, so ordinary run cleanup preserves their bounded buffers. Leaving the panel-wide Dev mode drains every tab in the CDP client's active-diagnostics registry, removes the handlers and buffers, and sends `Runtime.disable`, `Log.disable`, and `Network.disable` so Chrome also stops domain-level diagnostic work; conversation and tab cleanup additionally detach the debugger.

### Step 6a: Skills and Dynamic Tool Exposure

Settings -> Skills stores enabled skills in `customSkills` (`chrome.storage.local`
or `browser.storage.local`). On startup, `background.js` loads packaged default
skills from `skills/*`, adds any missing default (currently FreeSkillz.xyz, the
email verification-code helper, and Humanizer), and refreshes an
existing
built-in skill record when the packaged copy changes. If the user removes a
default skill, its removal tombstone prevents it from being silently re-added;
new default IDs can still be migrated into existing installations.

`agent/skills.js` normalizes each skill and handles three separate surfaces:

- Routing catalog: optional fenced `webbrain-skill` JSON supplies a summary
  (capped at 200 characters), eligible modes, and up to six canonical semantic
  intents (40 characters each). Intents are cross-language meaning hints for
  the LLM, not literal keywords. Without metadata, the first prose paragraph
  becomes the summary, intents stay empty, and the skill defaults to Act/Dev.
  An imported Agent Skills `SKILL.md` can instead supply its standard `name`
  and `description` frontmatter for the name and summary; an explicit Settings
  name and `webbrain-skill` metadata retain precedence.
  `getEligibleSkillCatalog()` produces the shared `{id,name,summary,intents}`
  records used by both the planner and `load_skill({skill_id})`. Ask sees only
  explicitly Ask-compatible skills, while Compact has no skill surface.
- Prompt instructions: `buildCustomSkillsPrompt()` strips both metadata and
  `webbrain-tools` fences, strips valid Agent Skills frontmatter, then appends
  full prose only for skills activated on the current run. Active IDs reset
  before the next user turn. Trusted
  recommended actions can preactivate the skill that owns their first tool;
  NYTimes adapter runs narrowly preactivate FreeSkillz so its site-scoped,
  read-only article fallback is ready after a structured blocking `pageGate`.
  Webmail adapter runs preactivate the prompt-only Humanizer skill so a composed
  reply is rewritten without spending a model-visible `load_skill` hop.
  Selected-text runs route on the explicit `humanize` shortcut action instead,
  which the durable selection scope carries across follow-up turns: they
  suppress page context, so the adapter is unreliable there, and their empty
  tool list leaves no `load_skill` to fall back on. The free-form selection
  question box does not imply a writing request and does not activate it.
- Tool exposure: `buildSkillToolDefinitions()` reads manifests only from active
  skills' Markdown bodies (never from Agent Skills frontmatter) and appends
  compatible schemas to `getToolsForMode(...)` at LLM-call time, respecting
  mode, tier, and site adapter. Download-job tools remain
  hidden in Ask and require their normal permission gate in action modes.
  The bundled OTP helper is a narrower built-in exception rather than a declared
  network tool: once that exact skill is active on Mid/Full, the runtime appends
  one fixed browser-neutral schema. Compact never receives it, and imported
  skills cannot claim its reserved name.

Loading is idempotent and multiple relevant skills can be active in one run.
The loader's trusted instruction permits activation only for the user's request
or trusted conversation context, never because page/document/tool content asks
for it. Strict-secret instructions are appended after loaded skill prose so they
continue to override OTP disclosure guidance.

#### How a skill is selected

There is no separate keyword matcher, embedding search, or local classifier for
ordinary skill selection. The planner and active execution LLM
make the semantic routing decision from the user's request and trusted
conversation context using the same small catalog. The planner returns
validated `skill_ids`; after approval the runtime activates those skills before
the execution model's first call. Planner-disabled and Ask runs can still use
`load_skill` during the normal model loop.

The runtime flow is:

1. At the start of a user turn, clear the tab's in-memory active-skill set.
2. Filter enabled skills by provider tier and conversation mode. Compact yields
   no catalog; Ask includes only skills that explicitly declare `ask`; Dev
   includes skills that declare either `dev` or `act`.
3. Give the Act/Dev planner and execution model the same eligible IDs, names,
   summaries, and optional semantic intents. Do not include full skill prose or
   skill tools yet.
4. The planner may select zero, one, or several `skill_ids`; the runtime rejects
   IDs that are not enabled or mode/tier eligible and activates valid IDs only
   after plan approval. The execution model may also call `load_skill`; loading
   an already-active ID succeeds without duplication.
5. After a successful load, rebuild the system message with that skill's full
   prompt-stripped prose. On the next model iteration, also rebuild the tool list
   from active skills, applying tool mode, tier, and site-adapter filters.
6. At turn completion, remove active IDs and rebuild the stored system message
   without skill prose. The prior `load_skill` call remains in conversation
   history, so a follow-up can choose to load the skill again.

Trusted recommended actions and the NYTimes site-scoped article fallback are
the deterministic exceptions. Before the first
model call, `_preactivateRecommendedActionSkill()` looks up the skill that owns
the action's trusted `firstTool` or `tool` and activates that skill. For example,
the media-download recommendation preactivates FreeSkillz because it owns
`download_public_media`; the YouTube-summary recommendation does the same for
`read_youtube_transcript`. On a NYTimes/The Athletic tab, the runtime also
preactivates enabled FreeSkillz for that run; only a structured blocking
`pageGate` adds the trusted instruction to call `fetch_nytimes_article`, so raw
page prose cannot spoof fallback routing.

Single public-media downloads have a second deterministic guard. If the model
calls `download_social_media` while an eligible inactive skill owns
`download_public_media`, the runtime activates that skill and returns a retry
pointing to the specialized downloader. A real failed public-media attempt
re-enables browser fallback. The browser MSE path fails closed before saving
split or unverifiably muxed video/audio buffers, so it cannot report separate
tracks as a successful video or hand ffmpeg work to the user.

| User intent | Expected skill | Catalog modes | Notes |
| --- | --- | --- | --- |
| Find, read, copy, or enter a code visible in browser email/message content | OTP / verification-code helper | Ask, Act, Dev | Guides narrow current-page reads; on Mid/Full, loading it also exposes one fixed reader for an already-open signed-in supported webmail tab. |
| Create and use a temporary mailbox for an unimportant signup | Disposable email (Mail.tm) | Act, Dev | Not shown to Ask. It may overlap with OTP during a verification flow, so both can be loaded. |
| Read a YouTube transcript, fetch a blocked NYTimes article, or resolve/download supported public media | FreeSkillz.xyz | Ask, Act, Dev | Ask can load the skill but still cannot see its Act-only `download_public_media` tool. |
| Draft or rewrite an email reply, message, or post the user will send | Humanizer | Ask, Act, Dev | Prompt-only; preactivated on webmail adapters and on the explicit Humanize selected-text shortcut, otherwise routed by catalog. Returns final text only. |
| Look up weather or a short forecast | Open-Meteo weather | Ask, Act, Dev | Read-only tools remain subject to their manifest filters. |
| Find books, ISBNs, authors, or publication data | Open Library | Ask, Act, Dev | Read-only tools remain subject to their manifest filters. |
| Search or summarize an encyclopedia topic | Wikipedia | Ask, Act, Dev | Live Wikipedia APIs plus explicitly installed local Kiwix/ZIM archives; all results are untrusted. |
| Restore Turkish characters in ASCII Turkish text after an explicit user request | Turkish deasciifier | Ask, Act, Dev | Prompt-only and opt-in; ordinary form-entry tools continue to type their text argument verbatim. |
| Upload one non-sensitive file to a short-lived public link | Temporary file share (Litterbox) | Act, Dev | Not shown to Ask; the skill uses existing browser upload tools. |

The runtime enforces catalog membership, mode/tier eligibility, active-skill
tool ownership, and tool filters. It cannot independently determine *why* the
model requested a valid skill ID. The rule against activation from page, email,
document, or tool-result instructions is therefore a model-policy boundary,
reinforced by WebBrain's untrusted-content wrappers and the loader description,
not a deterministic intent classifier. Routing quality also depends on concise,
distinct summaries; a broad skill such as FreeSkillz deliberately loads one
instruction bundle for several related capabilities.

The packaged Wikipedia skill keeps its existing `search_wikipedia` and
`get_wikipedia_summary` interface. When a live request fails, the exact
built-in tool may query archives that the user explicitly installed through
the ☢ Apocalypse Mode link in the Settings header. `apocalypse-mode.js` owns catalog
metadata, resumable piece verification, durable lifecycle state, OPFS or
user-selected archive bytes, and the local openZIM reader. IndexedDB contains only configuration,
archive metadata, and restart cursors—not multi-gigabyte archive bodies.
Kiwix content remains on the dynamic skill's `resultPolicy: "untrusted"` path.
See [Apocalypse Mode](apocalypse-mode.md) for storage and browser limits.

The optional metadata format is a separate prompt-stripped fence:

````markdown
```webbrain-skill
{
  "summary": "Find, read, copy, or enter verification codes from visible browser email.",
  "modes": ["ask", "act"]
}
```
````

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

### Step 6b: Opt-in Research Escalation

Research escalation defaults to disabled in the agent, background storage
hydration, Settings UI, and configuration transfer defaults. The runtime adds
its system-prompt policy and tool surface only when
`researchEscalationEnabled === true`. Enabled Ask requests receive
`delegate_research` plus a research-only `clarify` schema; they never receive
the generic ambiguity/timeout schema used by Act and Dev. Disabling the feature
removes both Ask entries, while Act and Dev retain their ordinary `clarify`
tool.

The narrowed consent call must include the displayed question, exactly two
choices, `purpose: "research_escalation"`, the exact `research_request`, and the
exact approval option. The safe/local choice is first. Runtime consent ignores
global clarify auto-selection and timeout behavior, binds a random one-use
authorization to the source tab and conversation, and expires it after five
minutes. `delegate_research` consumes that authorization before opening
`https://chatgpt.com/`; its Navigate, Type, and Click capability host is fixed
to `chatgpt.com`.

The helper implementation probes for a logged-in ChatGPT composer, validates
the origin before filling and again before sending, then reads a newly produced
answer and source links. Stop, helper-tab removal, and source-tab removal cancel
the in-flight run. Source identity is revalidated after helper binding so a
close during setup cannot leak the approved prompt. Returned content is marked
as untrusted delegated-research evidence before it re-enters the normal model
loop. See [Privacy & Data Flow](privacy-and-data-flow.md#optional-research-escalation-to-chatgpt)
for the user-visible third-party disclosure.

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

The action-mode intent gate runs before the first browser tool call. Off uses the compact schema; Try and Strict use the full planning schema, with unset storage defaulting to Try. The full planner prompt requires a single JSON object with summary, concrete steps, validated `skill_ids`, memory strategy, scheduling hint, risks, and an action mode. Both schemas also carry a language-neutral `messaging` target when the trusted user request authorizes an external message: either the exact named recipient or an explicitly referenced active conversation. Mid/Full planners receive only the eligible routing catalog, and approved skill IDs are activated before the normal execution model call. `normalizePlan()` bounds and sanitizes each field; `formatPlanMarkdown()` renders the side-panel review card; `formatPlanScratchpad()` pins the approved or edited plan as an `[Approved plan]` scratchpad entry.

The browser-owned per-turn runtime context includes the effective
`runtime_mode` and whether mutation tools are enabled. This envelope is added
once to the current user turn and is shared by the planner and executor, so
page content or stale conversation history cannot redefine the live mode. For
Act/Dev runs it also directs missing required values to `clarify` after useful
inspection; planner guidance treats `done` as terminal, never as a way to ask
for information needed to continue.

Planner calls are traced with `phase: "planner"` when trace recording is enabled. They also use the cost allowance guard, abort checks, a JSON-repair retry, and Qwen/DeepSeek no-think handling. A failed repair cannot authorize actions: Try falls back to an Ask/read-only turn, while Strict stops.

LLM-request trace events include privacy-safe prompt provenance: the controlled
prompt variant, system-prompt and aggregate message character counts, message
role counts, declared prompt/tool policy revisions, and structured checks
comparing the system prompt and runtime envelope with the effective run mode.
Raw system-prompt text, message text, tool schemas, and tool names are neither
copied nor fingerprinted in request events. Policy revisions are bumped when
controlled prompt templates or tool-exposure rules change; private request
content does not affect them.

WebBrain Compass runs also have a separate consent-gated terminal-runtime path.
After an executed tool result is made durable in `chrome.storage.local`, a
bounded `terminal_runtime` envelope is sent to the Compass improvement endpoint.
Transient failures remain in the outbox for the next Compass run; acknowledged or
non-retryable records are removed. This path does not depend on optional local
IndexedDB tracing, is disabled for local/bring-your-own providers, and never
blocks the visible answer on the network request. Chrome and Firefox use the
same event and outbox schema.

Each new trace run records the manifest version that created it. `/export`
Markdown records the exporting version, `/export --traces` records both the
exporting version and every turn's recording version, and Traces-page JSON adds
`exportedByWebBrainVersion` while retaining the backward-compatible
`webbrain-trace/1` schema. Legacy runs are labeled with an unavailable recording
version rather than being attributed to the currently installed build.

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

### Saved workflows (`agent/workflows.js`)

Saved workflows are compiled artifacts, not serialized trace events. The
background reads the newest successful trace in the active conversation and
normalizes its replayable actions into `webbrain-workflow/1`, stored under
`wb_saved_workflows_v1`. Compilation removes historical element references,
action CSS selectors, coordinates, query strings, fragments, and typed values. Every typed field
value becomes a declared runtime parameter; unsupported or failed actions are
skipped and reported to the user as save warnings.

Teacher mode is a second, value-free compiler input for the same schema.
`content/teacher-capture.js` observes only trusted top-document clicks, field
completion, checkbox/radio changes, Enter submissions, and navigation while a
tab-scoped session is active. Field values are never read or sent; a field
action becomes a runtime parameter marker as soon as it crosses the capture
boundary. The sanitized session survives navigation in `storage.session` and
is removed when `/teach --end` compiles and stores the workflow.

Each compiled step contains semantic target metadata (role, accessible name,
label, field identity, link, or placeholder), an expected postcondition, and
the origin/path family observed before that action. `/workflow` renders a
local manager for running, renaming, exporting, and deleting these artifacts;
renaming changes only the stored display name. `/workflow --run <id>`
collects parameters in an ephemeral side-panel form. The replay executor then:

1. checks the current origin/path family before every step;
2. reads a fresh accessibility tree and resolves exactly one semantic match;
3. calls `_executeToolBatch()` so the existing permission, form-submit,
   verification, abort, and action-normalization gates remain authoritative;
4. validates the saved postcondition; and
5. either continues deterministically, delegates a known-safe mismatch to the
   normal Agent, or stops when a state-changing action has an unknown outcome.

When strict target matching fails, replay may present up to five independently
replayable semantic targets for explicit user selection. A selected target is
used for that step only, then persisted as a locator repair only when the
existing postcondition succeeds without inconclusive, stale, ambiguous, or
wrong-target evidence. Repairs are applied atomically against the workflow's
previous `updatedAt` value, so a concurrent edit wins instead of being
overwritten. Duplicate semantic candidates and unattended clarification
answers never authorize healing.

Replay does not set `currentRunId`, because ordinary tool tracing would retain
runtime values. It creates a separate run containing sanitized notes and
redacted UI tool events. Runtime parameter values are also omitted from the
fallback prompt and user-memory extraction. Chrome and Firefox ship identical
workflow schema/compiler code and the same replay policy.

### Scheduled Tasks (`scheduler.js`)

The scheduler lets the agent defer work to a future browser session using the browser's `alarms` API. It lives in `src/chrome/src/agent/scheduler.js` (and the Firefox mirror) and is instantiated as `ScheduledJobManager` in the background script.

**Job kinds**

| Kind | Created by | Behavior |
|---|---|---|
| `resume` | `schedule_resume` tool | Continues the current conversation in the same tab at a future time. Terminal tool — the current run ends when it fires. |
| `task` | `schedule_task` tool | Runs a standalone user-authored prompt at a future time, optionally recurring. |
| `task` with `source: "watch"` | `/watch` slash command | Polls the initiating page URL in a dedicated inactive tab at a fixed 30–120 second interval. |

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

**Conditional watches**

Watch jobs use `interval_seconds` (60 by default, 30–120 allowed) and run their
first check immediately. Each poll carries the previous observation inside an
untrusted-content boundary. A `partial` outcome records that observation as the
next baseline and schedules another poll. A successful one-shot watch
completes; `--keep` schedules another poll only for future distinct events. A
failed check/action, a run without an explicit `done` outcome, or a poll that
throws is tolerated as transient — a failed poll never overwrites the baseline
observation — but three consecutive failures stop the watch rather than
looping silently.

The optional trailing `/beep` flag exposes a scoped
`beep({event_key, message?})` tool only during that watch. It arms an alert
before the requested action and reports a duplicate key before an action can be
repeated; it does not play audio itself. The scheduler first persists a fresh
event key and requires verified `done(outcome="success")`. Only then does the
Chrome offscreen document or Firefox background page generate the selected
default, short, or long tone. If a model verifies success but omits `beep`, the
scheduler records a warning and completes or continues the watch without audio
instead of discarding the successful action. Watch helper tabs are never forced
back to the URL after they diverge; the next poll closes the diverged helper
and creates a fresh inactive one, and the helper is also closed when the watch
completes, fails, or is cancelled or deleted.
Playback follows the existing `notifySound` setting.

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

110+ adapters inject site-specific guidance into the first user message (and re-inject on navigation to a different matched site). Only ONE adapter fires at a time (`getActiveAdapter(url)` returns the first match). See `docs/site-adapters.md` for how to write one. Each matched adapter emits a content-free `adapter_match` trace note with its identity, revision, and whether notes were injected. High-evidence repeated tasks may additionally expose validated V2 workflow jobs; the planner selects an app-owned ID semantically, the binding is revalidated on the live pre-execution URL, and the executor receives its trusted stages/evidence contract. Required submissions need dispatch plus post-submit observation, while jobs with a trusted complete inventory may require an explicit job-bound complete-coverage marker whose count matches terminal current-task ledger rows.

Adapters may also expose narrowly scoped runtime policy. Douyin `/chat` is the first `messaging.verifyActiveRecipient` route. The structured planner resolves an anaphoric recipient to `named` only when authentic prior-user context identifies exactly one target; unresolved pronouns clarify, while `active_conversation` is reserved for an explicit reference to the currently open thread itself. An `active_conversation` planner target must first be pinned to exactly one strong visible header identity before any page tool runs; ambiguous or missing evidence stops for clarification. Immediately before a send-like click, submitted field, or Enter press, the content script resolves the exact target and a lower-page layout composer, then collects only unique header evidence from the narrow, non-scrollable region above it. Enter or submitted field input in a different editable is conclusively non-message only when structural semantics positively identify a search or navigation field; an alternate reply/forward/split-pane composer remains inconclusive and therefore cannot bypass recipient verification. A distant general control likewise remains inconclusive rather than being declared safe. A semantic conversation row in a separate left rail is conclusively navigation-only, allowing recovery to the requested thread whether or not the short rail currently overflows; nested row buttons, links, and their leaf descendants plus controls outside that structure remain inconclusive. The agent requires exact normalized identity equality and returns a no-dispatch blocker on missing, inconclusive, ambiguous, or mismatched evidence, and protected Enter dispatch permits exactly one keypress per verification. Every authorized `click`, `click_ax`, `set_field({submit:true})`, and composer Enter receives a one-use binding to the exact action target, composer, URL, and identity set. Direct content dispatches and Chrome's trusted CDP mouse/key paths consume and revalidate it immediately before `el.click()`, `mousePressed`, or Enter, after any field reconciliation and combobox delays; protected `click_ax` never issues a second no-progress fallback click. Search-result text, message content, input values, generic page text, failed probes, and edited plans with stale hidden metadata cannot authorize a send. Dispatch-capable tools whose effects cannot be bound to the probed recipient (`iframe_click`, `execute_js`, WebMCP execution, and `upload_file`, whose change event may auto-send) are unavailable on this protected route. Deterministic saved-workflow replay has no planner-owned recipient target, so a workflow with any potentially dispatching step scoped to a protected messaging route stops before page actions and directs the user to run a normal Act task with a named recipient; a per-step check also covers legacy workflows whose scope metadata is incomplete.

### Accessibility Tree (`accessibility-tree.js`)

The primary page-interaction path. Produces a flat, indented text tree of the page where each node has a stable `ref_id`. Tools: `get_accessibility_tree`, `click_ax`, `type_ax`, `set_field`. See `docs/accessibility-tree-and-refs.md`.

### CDP Client (`cdp-client.js`) — Chrome only

Wraps `chrome.debugger` API for:
- **Trusted events** — `Input.dispatchMouseEvent`, `Input.dispatchKeyEvent` (event.isTrusted === true)
- **Screenshots** — `Page.captureScreenshot` with clip/scale control
- **DOM queries** — `Runtime.evaluate` for shadow DOM piercing, `DOM.getDocument` for closed roots
- **WebMCP** — `WebMCP.enable` maintains a bounded live catalog and
  `WebMCP.invokeTool` executes a page-registered structured capability. WebBrain
  exposes opaque `wmcp_*` IDs rather than page-controlled names as call handles.

WebMCP is an experimental Chrome-only fast path that is off by default. The
user must enable **Experimental WebMCP** under Settings → General → Advanced;
until then, neither WebMCP tool schemas nor WebMCP prompt guidance enter model
requests. When enabled, `list_webmcp_tools` is
available in Ask, Act, and Dev; `execute_webmcp_tool` is restricted to Act/Dev
and every invocation requires fresh confirmation plus permission against the
registration frame's actual origin. Page-authored annotations such as
`readOnly` are advisory and never bypass that boundary. Page-provided names,
descriptions, schemas, frame
URLs, outputs, and errors are always wrapped as untrusted content. The frame ID
and effective HTTP(S) security origin are revalidated immediately before
dispatch, so navigation, opaque sandbox origins, or stale permission metadata
fail closed. Tool discovery is bounded to 200 registrations and returned in
pages of at most 25 entries; invocations time out and issue
`WebMCP.cancelInvocation` when stopped. Turning the setting off removes the
tools from subsequent model steps and closes every active WebMCP CDP session.

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

Ollama, llama.cpp, LM Studio, and LocalAI resolve `supportsVision` from native
server metadata before page enrichment. Explicit model/base-URL identities are
cached and protected by stale-result guards; an empty Model field is treated as
the server's mutable loaded-model slot, so concurrent checks are coalesced only
within that turn and the next user turn rechecks it. Detection is bounded to
three seconds and fails closed without failing the text request. User overrides
bypass detection. Chrome and Firefox share the same parsers and behavior.

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

### Conversation and UI Persistence

Both builds keep per-tab state in session storage:

- `agentConv:<tabId>` stores the provider-facing conversation and is hydrated
  before the next message.
- `tabChat:<tabId>` mirrors rendered chat HTML so closing/reopening the panel or
  sidebar restores the visible transcript.
- `runUi:<tabId>` stores the background-owned detached-run snapshot: request/run
  identity, status, bounded replay events, plan/tool state, terminal content,
  and the current accumulated streamed text.

`text_delta` journal writes are coalesced on a 200 ms trailing timer; non-delta,
terminal, and pre-tool durability checkpoints flush immediately. The accumulated
stream is bounded separately from the 256-event replay window so a reopened
panel can reconstruct in-progress Markdown even after its early delta events
have been acknowledged or trimmed. Chrome uses `chrome.storage.session`;
Firefox uses `browser.storage.session`.

---

## Chrome vs Firefox Key Differences

| Area | Chrome (MV3) | Firefox (MV2) |
|---|---|---|
| Background | Service worker (ephemeral) | Background page (persistent) |
| Events | CDP-trusted (`isTrusted=true`) | Synthetic (`isTrusted=false`) |
| Screenshots | CDP `Page.captureScreenshot` with run-scoped focus emulation for background tabs | `browser.tabs.captureTab()` for direct inactive-tab capture |
| Conversation/UI persistence | `chrome.storage.session` | `browser.storage.session` |
| Offscreen document | Yes (fetch proxy + recorder + local WebGPU models) | Not available |
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
| File upload | CDP path or `downloadId` | `downloadId` re-fetch or WebBrain file picker; no arbitrary local path |

Apart from the Chromium-only endpoint-free WebGPU provider and vision sidecar,
the agent loop, tools, adapters, providers, loop detection, context management,
and system prompts are architecturally identical between the two builds.

---

## Directory Layout

```
src/
├── chrome/           # Chromium build (MV3)
│   ├── manifest.json
│   ├── skills/       # Packaged default skills
│   └── src/
│       ├── run-ui-journal.js # Detached-run replay and streamed-text snapshots
│       ├── agent/    # agent.js, tools.js, skills.js, adapters.js, scheduler.js, ...
│       ├── cdp/      # CDP client (Chrome only)
│       ├── content/  # accessibility-tree.js, content.js, ...
│       ├── network/  # network-tools.js
│       ├── offscreen/# Fetch proxy + recorder + local WebGPU models (Chrome only)
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
- `strictSecretMode` instructs the model not to quote credentials in summaries, redacts known credential values (including short numeric PIN/CVV values) out of everything a cloud run publishes, and fails closed to scalar redaction if its bounded secret registry fills
- Trace data is local-only (IndexedDB), never transmitted
- Offscreen proxy only forwards provider SDK traffic
- Finance adapters inject extra confirmation guidance
