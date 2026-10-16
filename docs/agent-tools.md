# Agent Tools

WebBrain separates **model tier** from **conversation mode**.

- **Tier** (`compact`, `mid`, `full`) is a per-provider setting. It controls how
  many normal browser-agent tools a model sees.
- **Mode** (`ask`, `act`, `dev`) is chosen per conversation. It controls what
  kind of task the user is allowing.

| Mode | What it allows |
|---|---|
| **Ask** | Read-only. No clicking, typing, navigating, or downloading. |
| **Act** | The selected tier's normal browser tools. |
| **Dev** | Requires a Mid or Full provider. Adds a source/style/debug appendix, including deeper DOM/frame inspection for Mid-tier Dev runs. Compact Dev is blocked before an LLM request is sent. |

| Tier | Intended model class | Normal tool surface |
|---|---|---|
| `compact` | very small local models | Shortest prompt and a small normal Act tool set. No scheduling, iframe, download-resource, or advanced DOM/UI fallbacks. |
| `mid` | capable local models | Common task tools: downloads, scheduling, iframe tools, form verification. No Full-only advanced fallbacks. |
| `full` | frontier/cloud or large local models | Everything, including hover, drag-drop, frames, and shadow DOM. |

Tier defaults and resolution rules are documented in
[providers and models](providers-and-models.md#prompttool-tiers-and-modes).

## Accessibility read budgets

For complete HTML-table JSON, `extract_data({type:"tables", caption:"Exact caption",
columns:[{name:"ID",index:0,type:"string"}]})` copies the selected cells directly
from the document. Use `table_index` instead of `caption` when needed;
`first_data_row` defaults to 1. An optional `row_filter:{column:0,equals:["ID-1"]}`
selects exact values in document order and refuses missing requested values.

The result contains a small preview and an app-issued `data_ref`. Pass that
reference to `done({summary:"Table export",data_ref:"..."})` to deliver the full
`{rowCount,rows}` JSON after a fresh source check. References expire with the
owning task. String cells retain their literal Unicode and whitespace; numeric
conversion refuses precision loss. The source scan is limited to 10,000 rows
and 2,000,000 cell characters; the complete delivered JSON must fit within
30,000 characters, including JSON escaping. Overlimits fail explicitly before
issuing a complete data reference. Strict secret handling also checks
native column headers, so renaming a credential column cannot bypass it.

`get_accessibility_tree` normally uses a 6,000-character structured page inside
an 8,000-character serialized result. Mid/Full providers with a detected
context window of at least 65,536 tokens advertise the expanded 12,000 / 16,000
pair. When that larger page is requested, its accessibility result alone may
use the 16,000-character serializer window. Compact providers and providers below the
64k boundary remain at 6,000 / 8,000.

The larger window is reserved for complete-thread and whole-document reads.
Ordinary visible/interactive UI reads retain their smaller defaults, other tool
results remain capped at 8,000 characters, and every truncated tree must be
continued with its exact returned `continuationArgs` until the required
coverage is complete. See
[adaptive read windows](accessibility-tree-and-refs.md#adaptive-read-windows).

For Gmail, the first accessibility result identifies the trusted active
conversation with `conversationRootRefId`. Complete coverage pages only that
anchored subtree with `filter:"all"` and `maxDepth:15`; document-root page 2+
contains unrelated inbox rows and does not count. Expansion is independent:
**Collapse all** must be visible as evidence. Ask cannot expand collapsed
messages and returns a clear limitation; Act/Dev can use **Expand all** and then
re-read the trusted conversation subtree from page 1.

## Tool matrix

Legend: **Yes** = available · **-** = not available · **C** = Chrome only ·
**Dev** = Dev-mode add-on (Mid/Full providers; not Compact).

| Tool | Ask | Compact | Mid | Full | Dev |
|------|:---:|:-------:|:---:|:----:|:---:|
| `calculate` | Yes | Yes | Yes | Yes | - |
| `get_accessibility_tree` | Yes | Yes | Yes | Yes | - |
| `read_page` | Yes | Yes | Yes | Yes | - |
| `read_pdf` | Yes | No | Yes | Yes | - |
| `list_webmcp_tools` | C | No | C | C | - |
| `execute_webmcp_tool` | No | No | C | C | - |
| `read_page_source` | No | No | No | No | Yes |
| `get_window_info` | Yes | Yes | Yes | Yes | - |
| `get_interactive_elements` | Yes | No | Yes | Yes | - |
| `scroll` | Yes | Yes | Yes | Yes | - |
| `extract_data` | Yes | Yes | Yes | Yes | - |
| `inspect_element_styles` | No | No | No | No | Yes |
| `wait_for_stable` | Yes | No | Yes | Yes | - |
| `get_selection` | Yes | Yes | Yes | Yes | - |
| `done` | Yes | Yes | Yes | Yes | - |
| `clarify` | No | Yes | Yes | Yes | - |
| `fetch_url` | Yes | Yes | Yes | Yes | - |
| `research_url` | Yes | No | Yes | Yes | - |
| `list_downloads` | Yes | No | Yes | Yes | - |
| `click_ax` | No | Yes | Yes | Yes | - |
| `type_ax` | No | Yes | Yes | Yes | - |
| `set_field` | No | Yes | Yes | Yes | - |
| `browser_batch` | No | No | Yes | Yes | - |
| `resize_window` | No | No | No | Yes | - |
| `click` | No | Yes | Yes | Yes | - |
| `type_text` | No | Yes | Yes | Yes | - |
| `press_keys` | No | Yes | Yes | Yes | - |
| `navigate` | No | Yes | Yes | Yes | - |
| `wait_for_element` | No | Yes | Yes | Yes | - |
| `promote_iframe` | No | No | Yes | Yes | - |
| `scratchpad_write` | No | Yes | Yes | Yes | - |
| `progress_update` | No | Yes | Yes | Yes | - |
| `progress_read` | No | Yes | Yes | Yes | - |
| `download_social_media` | No | No | Yes | Yes | - |
| `get_captcha_capabilities` | No | No | Yes | Yes | Yes |
| `solve_captcha` | No | No | Yes | Yes | Yes |
| `apply_captcha_solution` | No | No | Yes | Yes | Yes |
| `go_back` | No | No | Yes | Yes | - |
| `go_forward` | No | No | Yes | Yes | - |
| `schedule_resume` | No | No | Yes | Yes | - |
| `schedule_task` | No | No | Yes | Yes | - |
| `iframe_read` | No | No | Yes | Yes | - |
| `iframe_click` | No | No | Yes | Yes | - |
| `iframe_type` | No | No | Yes | Yes | - |
| `read_downloaded_file` | No | No | Yes | Yes | - |
| `download_files` | No | No | Yes | Yes | - |
| `download_resource_from_page` | No | No | Yes | Yes | - |
| `upload_file` | No | No | Yes | Yes | - |
| `verify_form` | No | No | Yes | Yes | - |
| `hover` | No | No | No | Yes | - |
| `drag_drop` | No | No | No | Yes | - |
| `get_shadow_dom` | No | No | No | Yes | Yes |
| `shadow_dom_query` | No | No | No | C | C |
| `get_frames` | No | No | No | Yes | Yes |
| `inject_css` | No | No | No | No | C |
| `remove_injected_css` | No | No | No | No | C |
| `patch_element` | No | No | No | No | C |
| `revert_patch` | No | No | No | No | C |
| `execute_js` | No | No | No | No | Yes |
| `read_console` | No | No | No | No | C |
| `inspect_network_requests` | No | No | No | No | C |
| `inspect_event_listeners` | No | No | No | No | C |
| `highlight_element` | No | No | No | No | C |

### Sequential browser batches

`browser_batch({actions:[{name:"set_field",input:{ref_id:"ref_11",text:"Ada"}},
{name:"set_field",input:{ref_id:"ref_12",text:"Lovelace"}}]})` runs predictable
actions in order within one model round trip. It is enabled by default for
Mid/Full Act and their Dev modes, with at most 6 actions for Mid and 10 for Full.
Ask and Compact omit it. The internal `browserBatchEnabled: false` setting
removes both the tool and its optional prompt guidance; there is no Settings
control or recurring batching nudge.

Only advertised tools from the batch action allowlist may run: `click_ax`,
`type_ax`, `set_field`, `set_checked`, `click`, `type_text`, `press_keys`,
`scroll`, `hover`, `drag_drop`, `navigate`, `go_back`, `go_forward`,
`wait_for_element`, `wait_for_stable`, `iframe_click`, and `iframe_type`.
Trailing observations may be `get_accessibility_tree`, `read_page`,
`inspect_viewport`, or `get_window_info`. Full-only actions remain Full-only.
Nested batches, skill/Dev-only tools, network/file tools and control tools are
excluded. All inputs are validated before any action runs; each action still
passes its normal permission, targeting, submit and verification checks.

Use existing refs and known values, then verify the outcome. Do not batch a
decision that depends on an unread result. Failures, unverified actions and
submits stop the remaining actions and sibling calls for a fresh model turn.
Navigation also stops unless only trailing observations remain. Mid's usual
single-action boundary is suspended inside a batch but still applies after it.
Coordinate clicks after an earlier mutation are rejected during validation.

Verified `set_field`/`type_ax`/`type_text` edits to native input and textarea controls can
continue within the same batch using updated evidence for those exact values.
Element identities, labels, surrounding form/recipient bindings, other control
values and user-interaction checks remain fixed. A sibling call or another
batch cannot reuse that exception. Selects, contenteditable editors and clicks
retain the normal context-change stops; batching does not guarantee that every
valid sequence will finish without another model turn.

The model receives one result for the original batch call, with ordered action
results and explicit skipped entries. Page-derived results retain separate
untrusted-content boundaries. Automatic screenshot capture happens once after
the turn's executed actions, rather than after each batch action.

`promote_iframe` is a normal Mid/Full Act tool, not a Dev-only add-on. Dev
sessions using a Mid or Full provider inherit it from the selected Act tier.
See [iframe targeting](accessibility-tree-and-refs.md#iframe-targeting) for the
standalone-frame workflow and safety checks.

> **Shadow DOM note:** The accessibility tree only traverses light DOM. On Web
> Component-heavy pages (Stripe, Salesforce, Shopify), use
> `get_interactive_elements` first; in Full Act or Dev mode, use
> `get_shadow_dom` / `shadow_dom_query` for targeted reads.

## Tools that are not in the table

**Skill tools.** Loaded skills can append tool schemas for the current run. The
bundled FreeSkillz.xyz skill, for example, can expose `read_youtube_transcript`
plus `resolve_public_media` / `download_public_media`. These are not hard-coded:
before the skill is loaded (or if it is removed), the tools are absent. Ask mode
still filters out mutating and download tools even when their owning skill is
loaded. See [skills](skills.md).

**WebMCP (experimental, on by default).** The `list_webmcp_tools` /
`execute_webmcp_tool` rows apply when **Experimental WebMCP** is enabled
under Settings → General → Advanced. The setting is on by default; while off,
the tools and their prompt guidance are omitted from model requests. WebMCP
annotations such as `readOnly` are page-authored hints, not a security boundary.
Every invocation requires Act or Dev, fresh per-call confirmation, and the
normal capability × registration-frame-origin permission. WebMCP currently
requires a supporting Chrome build/page configuration; Firefox does not expose
these tools.

## Dev-mode page editing and diagnostics

Dev tools are only exposed in Dev mode, and Dev mode is blocked for
Compact-tier providers. Chrome's reversible editing tools return patch IDs:
`inject_css` pairs with `remove_injected_css`, and `patch_element` pairs with
`revert_patch`.

- **`inject_css` / `remove_injected_css`** apply and undo temporary CSS by
  `patchId`. Each patch is unique and bound to the exact page document, and its
  metadata is kept in session storage so a service-worker restart does not lose
  the undo handle. Navigating invalidates the old handle instead of letting it
  affect a replacement page.
- **`patch_element` / `revert_patch`** make structured inline-style, class, and
  attribute changes with exact before/after values. Browser-equivalent style and
  HTML attribute names are canonicalized before the undo record is created,
  contradictory set/remove operations are rejected, and executable URL
  attributes reject `javascript:` values (including form `action`).
  `highlight_element` provides a temporary pointer-transparent target overlay;
  because it inserts live DOM, it uses the temporary Dev-patch permission.
- **`execute_js`** runs an async JavaScript function body in the page main
  world. Chrome uses CDP `Runtime.evaluate` with a 15-second execution limit;
  Firefox uses its MV2 content-script evaluator. The tool is host-permission
  gated and receives a fresh submit confirmation.
- **`read_console`, `inspect_network_requests`, `inspect_event_listeners`**
  provide bounded diagnostics on Chrome. Capture starts before either streaming
  or non-streaming Dev runs and stops when the tab leaves Dev mode or its
  conversation is cleared; leaving Dev drains every tab with active capture even
  if the panel switched tabs, removes handlers and buffers, and disables the
  matching CDP domains. Listener inspection briefly adds and restores an
  internal target attribute, follows open-shadow hosts when collecting
  ancestors, and therefore uses the same host permission as temporary Dev
  patches. Network headers and bodies are omitted by default, sensitive header
  names (including common API/subscription-key variants) are redacted before
  buffering, and page-derived diagnostic output is treated as untrusted content.

## See also

- [Adding a tool](adding-a-tool.md) — the checklist for new or changed tools
- [Accessibility tree and refs](accessibility-tree-and-refs.md)
- [Security model](security-model.md) and
  [prompt-injection defense](prompt-injection-defense.md)

## CAPTCHA providers

See [CAPTCHA provider coverage](captcha-provider-coverage.md) for setup, weighted fallback, hCaptcha, browser identity requirements and answer application, and the [complete method reference](captcha-method-reference.md) for all seven providers’ native contracts. In Act/Dev Mid and Full, the agent reads `get_captcha_capabilities` before supplying `providerTasks` to `solve_captcha`; structured results remain available to `apply_captcha_solution`. Ask and Compact request manual completion. A result must still be verified on the page.
