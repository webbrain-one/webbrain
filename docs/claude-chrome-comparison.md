# WebBrain vs Claude Chrome Extension

This note compares the local WebBrain checkout with `../webbrain-claude`, a
deobfuscated Claude Chrome extension tree. It focuses on architecture,
model-callable tools, and website-specific adapter behavior.

## Sources Inspected

WebBrain:

- `docs/architecture.md`
- `docs/adding-a-tool.md`
- `docs/site-adapters.md`
- `docs/accessibility-tree-and-refs.md`
- `docs/webbrain-tool-tiers.xlsx`
- `src/chrome/ARCHITECTURE.md`
- `src/chrome/src/agent/tools.js`
- `src/chrome/src/agent/skills.js`
- `src/chrome/src/agent/adapters.js`
- `src/chrome/skills/freeskillz-xyz.md`
- Matching Firefox files where parity matters

Claude Chrome:

- `../webbrain-claude/manifest.json`
- `../webbrain-claude/settings.html`
- `../webbrain-claude/settings.js`
- `../webbrain-claude/assets/service-worker.js`
- `../webbrain-claude/assets/mcpPermissions.js`
- `../webbrain-claude/assets/PermissionManager.js`
- `../webbrain-claude/assets/sidepanel.js`
- `../webbrain-claude/assets/accessibility-tree.js`

The Claude tree is bundled/minified in places. Tool names below were recovered
from `toAnthropicSchema()` definitions, native-message dispatch, and the
sidepanel quick-command prompt.

## Architecture

| Area | WebBrain | Claude Chrome extension |
|---|---|---|
| Browser support | Two mirrored extension builds: Chrome/Edge MV3 and Firefox MV2. | Chrome MV3 only in this tree. |
| Agent location | Extension owns the full agent loop in `agent.js`; providers are local extension modules. | Two paths: a normal Anthropic tool-calling loop in the sidepanel, plus a native-host/MCP bridge in the service worker. |
| LLM provider model | Provider abstraction supports OpenAI-compatible, Anthropic, local llama.cpp/LM Studio/Ollama-style endpoints, and provider settings. | Primarily Anthropic Messages API; sidepanel quick mode points at `http://localhost:4000` when configured, and native host names target Claude desktop / Claude Code integration. |
| Tool dispatch | `getToolsForMode()` returns OpenAI-style function schemas from `tools.js`, optionally extended by enabled skill tools. `agent.js` dispatches tools to content scripts, Chrome APIs, CDP, network helpers, or skill executors. | MCP-style schemas live in `mcpPermissions.js`. Sidepanel executes tool calls by name. Quick mode uses a compact command DSL with no Anthropic tools, then converts commands into synthetic tool-use/results. |
| Page reading | Preferred AX tree tool with stable `ref_id`s plus prose/page-source/PDF readers. | AX tree reader also exists and uses `window.__wbElementMap` / `ref_` IDs, but the primary browser action tool is more coordinate/computer oriented. |
| Trusted browser events | Chrome uses CDP for trusted mouse/keyboard events, screenshots, closed shadow-root access, and some file-upload paths. Firefox uses synthetic events. | Chrome uses `debugger`/CDP for computer actions, screenshots, JavaScript evaluation, uploads, console/network tracking, and zoom screenshots. |
| Conversation controls | Ask/Act modes, plan-before-act, scratchpad, progress ledger, scheduled tasks/resumes, optional traces. | Permission modes, plan approval via `update_plan`, domain transition prompts, tab groups, compaction, native host/MCP status. |
| Dynamic extension model | User/imported skills can inject prompt text and declare `webbrain-tools` runtime tools. | Native/MCP and shortcuts are the extension points visible in the deobfuscated tree; no equivalent user-editable Markdown tool manifest was found. |

## WebBrain Tool Surface

Current static core tools from the local source:

- Chrome: 48 core tools.
- Firefox: 47 core tools.
- Chrome-only core tools: `shadow_dom_query`, `upload_file`.
- Firefox-only core tool: `execute_js`.
- Dynamic skill tools can add more schemas at runtime and are not included in those counts.

Ask-mode core tools:

```text
get_accessibility_tree, read_page, read_pdf, read_page_source,
get_window_info, get_interactive_elements, scroll, extract_data,
inspect_element_styles, get_selection, clarify, done, wait_for_stable,
fetch_url, research_url, list_downloads
```

Full Chrome core tool list:

```text
get_accessibility_tree, click_ax, type_ax, set_field, hover, drag_drop,
read_page, read_pdf, read_page_source, get_window_info, resize_window,
get_interactive_elements, click, type_text, press_keys, scroll, navigate,
go_back, go_forward, extract_data, inspect_element_styles, wait_for_element,
wait_for_stable, schedule_resume, schedule_task, get_selection, new_tab,
done, clarify, get_shadow_dom, shadow_dom_query, get_frames, iframe_read,
iframe_click, iframe_type, fetch_url, research_url, list_downloads,
read_downloaded_file, download_resource_from_page, download_files,
upload_file, scratchpad_write, progress_update, progress_read,
verify_form, download_social_media, solve_captcha
```

Full Firefox differs by replacing Chrome-only `shadow_dom_query` and
`upload_file` with `execute_js`.

### WebBrain Tool Families

| Family | Tools |
|---|---|
| AX-first DOM control | `get_accessibility_tree`, `click_ax`, `type_ax`, `set_field`, `hover`, `drag_drop` |
| Legacy DOM fallback | `get_interactive_elements`, `click`, `type_text`, `press_keys`, `scroll`, `wait_for_element`, `wait_for_stable` |
| Navigation and tabs | `navigate`, `go_back`, `go_forward`, `new_tab` |
| Reading/extraction | `read_page`, `read_pdf`, `read_page_source`, `extract_data`, `inspect_element_styles`, `get_selection` |
| Shadow DOM and frames | `get_shadow_dom`, `shadow_dom_query` on Chrome, `get_frames`, `iframe_read`, `iframe_click`, `iframe_type` |
| Network and files | `fetch_url`, `research_url`, `list_downloads`, `read_downloaded_file`, `download_resource_from_page`, `download_files`, `upload_file` on Chrome |
| Long-running work | `schedule_resume`, `schedule_task`, `scratchpad_write`, `progress_update`, `progress_read` |
| Safety/workflow | `verify_form`, `clarify`, `done`, `solve_captcha` |
| Media | `download_social_media`, plus dynamic skill tools when enabled |

### WebBrain Dynamic Skill Tools

WebBrain has two tool classes declared inside skill Markdown fences:

- `kind: "http"`: read-only HTTPS GET/POST tools, available in Ask and Act
  according to their manifest `modes`.
- `kind: "httpDownloadJob"`: Act-only HTTPS POST job tools that create a job,
  poll status, fetch the file, save through browser Downloads, and clean up.

The bundled `FreeSkillz.xyz` skill exposes:

```text
read_youtube_transcript
resolve_public_media
download_public_media
```

These are not `/allow-api` mutations. They are trusted at skill import/enable
time, use `credentials: "omit"`, and should mark third-party results as
untrusted.

## Claude Chrome Tool Surface

Recovered MCP/tool schemas:

```text
computer, javascript_tool, file_upload, find, form_input, get_page_text,
gif_creator, navigate, read_console_messages, read_network_requests,
read_page, resize_window, tabs_context, tabs_create, turn_answer_start,
update_plan, upload_image, tabs_context_mcp, tabs_create_mcp, tabs_close_mcp,
shortcuts_list, shortcuts_execute
```

The biggest design difference is that Claude collapses many browser actions into
`computer`, with an `action` enum:

```text
left_click, right_click, type, screenshot, wait, scroll, key,
left_click_drag, double_click, triple_click, zoom, scroll_to, hover
```

The sidepanel quick mode has a separate command DSL:

```text
ST tabId        select tab
NT url          open new tab
LT              list tabs
C x y           click
RC x y          right-click
DC x y          double-click
TC x y          triple-click
H x y           hover
T text          type
K keys          press keys
S dir amt x y   scroll
D x1 y1 x2 y2  drag
Z x1 y1 x2 y2  zoom screenshot region
N url           navigate, back, or forward
J code          execute JavaScript
W               wait for page settle
```

Quick mode sends Anthropic `tools: []`, parses these textual commands, executes
them locally, then appends synthetic `tool_use` / `tool_result` messages with a
fresh screenshot.

### Claude Tool Families

| Family | Tools |
|---|---|
| Browser/computer actions | `computer`, `navigate`, `resize_window` |
| Page reading/search | `read_page`, `get_page_text`, `find` |
| DOM/form/file work | `form_input`, `file_upload`, `upload_image`, `javascript_tool` |
| Debugging | `read_console_messages`, `read_network_requests` |
| Tabs and MCP tab groups | `tabs_context`, `tabs_create`, `tabs_context_mcp`, `tabs_create_mcp`, `tabs_close_mcp` |
| Workflow and permissions | `update_plan`, `turn_answer_start` |
| Reuse/export | `gif_creator`, `shortcuts_list`, `shortcuts_execute` |

## Tool Differences

| Capability | WebBrain | Claude Chrome |
|---|---|---|
| Tool granularity | Many narrow tools: separate AX click/type/set-field, network, downloads, scheduler, iframe, PDF, source, progress tools. | Fewer high-level tools; browser input is mostly one `computer` tool plus action enum. |
| Primary reading path | `get_accessibility_tree` is the preferred first read and returns stable refs with pagination/auto-degradation behavior. | `read_page` also returns an accessibility tree, but screenshot-driven coordinate control is more central, especially in quick mode. |
| Natural-language element lookup | No standalone model-powered `find`; the model usually reads the AX tree and chooses refs. | Has `find`, which runs a small model call over the accessibility tree and returns matching refs. |
| Page text | `read_page` is prose/article-oriented; `get_accessibility_tree` is UI-oriented. | Splits `read_page` as AX tree and `get_page_text` as raw/article text. |
| PDF reading | `read_pdf` extracts PDF text directly. | No equivalent recovered. |
| Raw source reading | `read_page_source` exposes server-delivered HTML and asset URLs. | No equivalent recovered. |
| Network fetch | `fetch_url` / `research_url`, with WebBrain-specific API mutation rules and `/allow-api` for mutating methods. | No generic fetch tool recovered. Debug network logs exist through `read_network_requests`. |
| Console/network inspection | No dedicated console log reader in the core WebBrain tool list. Network shortcuts exist for API observation, but not a model-facing request-log reader in the same way. | Dedicated `read_console_messages` and `read_network_requests`. |
| Downloads | Several browser download/file tools plus dynamic download-job skill tools. | `downloads` permission exists and `gif_creator` can download exports, but no general download manager equivalent was recovered. |
| Media download | `download_public_media` skill first; `download_social_media` browser fallback. | No public-media download equivalent recovered. |
| File upload | Chrome has `upload_file` by downloadId/path-oriented flow; Firefox lacks it. | `file_upload` directly sets local absolute paths on a file input; `upload_image` uploads captured/user images by ref or coordinate. |
| Scheduler | `schedule_resume` and `schedule_task`. | Scheduled task UI/prompt strings exist, but no equivalent model-callable scheduler schema was recovered in the visible tool list. |
| CAPTCHA | `solve_captcha` when CapSolver is configured. | Explicit security prompt says respect CAPTCHAs and never bypass; no solver tool recovered. |
| Persistent agent memory | `scratchpad_write`, `progress_update`, `progress_read`. | Conversation compaction exists; no equivalent scratchpad/progress tools recovered. |
| Form safety | `verify_form` for important forms. | `form_input` can set values; no dedicated verify-form tool recovered. |
| Iframes | Dedicated `get_frames`, `iframe_read`, `iframe_click`, `iframe_type`. | No dedicated iframe tools recovered; actions are likely through coordinates/JS where permitted. |
| Shortcuts/workflows | Custom skills are Markdown plus optional tool manifests. | `shortcuts_list` / `shortcuts_execute` expose saved shortcuts/workflows. |
| GIF/video workflow | Slash-driven recording exists in WebBrain Chrome, but not as model-callable tools. | `gif_creator` is model-callable and can record/export browser automation sessions as GIF. |

## Website-Specific Adapters

### WebBrain

WebBrain has a real site-adapter system:

- Adapter files live in both `src/chrome/src/agent/adapters.js` and
  `src/firefox/src/agent/adapters.js`.
- `getActiveAdapter(url)` returns the first matching adapter.
- Only one adapter fires at a time.
- Adapter notes inject into the first user message.
- If navigation moves to a different matching adapter mid-conversation, WebBrain
  injects a new `[Site context changed ...]` user message.
- `UNIVERSAL_PREAMBLE` is added to the system prompt when adapters are enabled.
  It covers cookie/consent banners, paywalls, and PDF-tab behavior.
- Finance adapters carry high-stakes wording and must precede
  `finance-generic`.
- Chrome and Firefox adapter changes should stay mirrored.

Current adapter inventory from `listAdapters()`:

```text
github, gitlab, stackoverflow, hackernews, gmail, google-docs,
google-calendar, slack, notion, jira, twitter, linkedin, reddit, youtube,
medium, substack, wordpress, amazon, aws, gcp, cloudflare, vercel, nytimes,
wsj, ft, bloomberg, economist, washingtonpost, stripe, coinbase, robinhood,
tradingview, finance-generic, airbnb, booking, expedia, google-maps,
google-flights, kayak, opentable, ebay, walmart, target, etsy, sahibinden,
trendyol, apple, outlook, google-sheets, trello, instagram, tiktok, facebook,
leetcode, hackerrank, greenhouse, workday, discord, whatsapp-web, telegram,
mastodon
```

Notable adapter behavior:

- Adapters encode page-shape guidance, not brittle selectors.
- WordPress is host-agnostic over `/wp-admin` and `/wp-login.php`.
- Mastodon uses a large known-host set plus conservative URL matching to avoid
  claiming every generic `/@user` path on the web.
- Finance precedence matters: broad finance matching can shadow specific
  adapters unless exclusions/order are maintained.

### Claude Chrome

The deobfuscated Claude tree has settings UI that claims "Site adapters":

- `settings.html` exposes a "Site adapters" toggle.
- `settings.js` reads and writes `useSiteAdapters`.

However, no backing adapter registry, `getActiveAdapter` equivalent, universal
preamble injection, or site-specific guidance injection path was found in the
inspected Claude tree. Searches for WebBrain-style adapter markers only found
the settings label/storage path.

The closest Claude equivalents are not website adapters:

- Domain permission modes and domain-transition prompts.
- Managed policy / domain block handling.
- Domain skills metadata in tab-context reminders.
- MCP/Gmail/Google-style integration labels elsewhere in the UI bundle.

So the practical adapter difference is:

- WebBrain has website-specific prompt augmentation as a first-class browser
  agent feature.
- Claude Chrome, in this deobfuscated tree, appears to rely on screenshots,
  `find`, domain permissions, and tab/domain context rather than per-site
  adapter notes.

## Ideas Worth Borrowing

Potentially useful Claude ideas for WebBrain:

- A `find` tool that uses a small/fast model over the AX tree to return
  candidate refs for vague element descriptions.
- Model-facing console and network request readers for debugging web apps.
- A GIF/workflow export tool if model-callable recording/export is desired.
- Shortcut/workflow list and execution primitives, if WebBrain wants a reusable
  workflow layer separate from Markdown skills.
- Direct image upload by captured screenshot/image ID, if sidepanel image
  attachment workflows grow.

Ideas to avoid copying directly:

- A settings-only "site adapters" surface without a backing registry and
  injection path.
- Collapsing too many deterministic browser operations into one `computer`
  schema if WebBrain wants to preserve its current narrow, auditable tool
  semantics.
- Treating screenshot/coordinate control as the primary path when stable AX refs
  are available.

## Documentation Follow-Ups

If this comparison becomes user-facing docs:

- Update counts from `src/chrome/src/agent/tools.js` and
  `src/firefox/src/agent/tools.js` before publishing.
- Re-run `listAdapters()` to avoid stale adapter inventory.
- Treat Claude details as local reverse-engineering, not an upstream product
  contract.
- If the Claude tree is refreshed, re-check whether `useSiteAdapters` gained a
  backing adapter registry.
