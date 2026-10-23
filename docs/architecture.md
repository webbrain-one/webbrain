# DIV Architecture

> Version 25.8.5

## Overview

DIV is a browser extension that gives an LLM control over the user's active browser tab. The user types a natural-language instruction in a side panel, and an autonomous agent loop calls the LLM, executes tool calls (click, type, navigate, read page state, etc.), feeds results back to the LLM, and repeats until the task is done.

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

**Automatic mode selection** is the default: the side panel sends `mode: 'auto'`. The composer's "!" menu also has an Auto | Ask | Act | Dev picker. Ask, Act or Dev chosen there is kept for the tab's chat (`composer-mode-pin.js`, one session-storage key per tab, so a reopened panel finds it): the panel then sends that mode as in Manual, and the menu's trigger shows it. A new chat or a recovered history record returns to Auto; Act and Dev pass the same checks as the shortcuts (selection scope, in-browser model, Compact for Dev), and the standalone window hides the picker. The agent routes the turn in `auto-mode.js`, shared by both builds:

1. Run state decides alone when it can: a continuation keeps an action run's mode. A continuation of a read-only run (Retry, Continue, or a quota or cost resume, which the panel sends as `auto` for a run it saw routed to Ask, marked `data-auto-routed`) is routed like a new turn from the continued task's own words, its request and the answers, updates and corrections bound to it, never from DIV's continuation text; its hand-off must quote those words, and the background's `continue` handler restarts it like `chat` does. Without such words it stays in Ask. A turn for an in-browser (WebGPU) model, which runs as a tiny Ask, a selected-text scope, the standalone window, a Cloud run and a message that carries an `<untrusted_page_content>` block (a selection shortcut with page context) stay in Ask; and a video attachment, which can only be uploaded, needs Act. Context-menu and selection prompts are sent as Ask, as in Manual.
2. Otherwise the decision model answers the fixed-choice `run_mode` question (`semantic-decisions.js`) about the user's own words, the previous turn's mode and the earlier task. It never sees page text, title or address. The question starts as soon as the turn's cost state exists and is awaited after `_enrichUserMessageWithCurrentPage`, so it overlaps page capture; after capture the turn waits at most `AUTO_MODE_ROUTE_GRACE_MS` (250 ms). Only a sure `act` or `dev` answer (the choices are `authorizing`) selects an action mode; Compact maps Dev to Act. The same decision request also asks `plan_need` about the same words (`direct`, `plan` or `unclear`); a sure answer travels with an action route as `modeRoute.plan`, which lets Try skip the full planner for a direct task ([Step 4](#step-4-plan-before-act-gate)). It adds no request and no data. The routed mode replaces the provisional Ask setup: run mode, system prompt, the turn's trusted runtime line and dialog handling (Chrome) or the BiDi run (Firefox).
3. Without a sure answer, or with no decision model, the turn starts in Ask at once. So does a turn whose user sent a correction while the route ran or while the action run's browser setup started (`route_corrected`): the route did not read it, so an action answer is not trusted. That check follows the setup's last await, so nothing arrives between it and the committed mode. Its tools add `request_action_mode`, and its system prompt adds `AUTO_MODE_ASK_NOTE`. The tool is never dispatched. Page updates that arrive while the model decides (a timeline's counters and relative times, page-script focus) do not discard the call (`page-feedback-policy.js` treats it like the other page-independent tools): it never runs on the page, and the action run reads the page again before acting. The person's own input on the page, a navigation or a correction still makes the model decide again. The loop accepts the call only when its `evidence` quotes the user's own words exactly (the request, or a correction sent during the turn) and, because the calling model has read the page, when the same `run_mode` question, about the request with its corrections and asked again without any page content (decision model, then the active model with a quoted reason; a sure routing answer is reused from the semantic-decision cache) also answers act or dev. A correction sent while that check runs supersedes the call like any pending correction: the next step applies it and the model asks again, so a correction that needs Dev gets a Dev hand-off. Corrections sent during the read-only pass, applied or still pending, go with the hand-off: they stay journaled under the same request, and the action run queues them before its first model or tool boundary, so it never acts on the uncorrected request. A correction that arrives after the check (while the hand-off is saved) marks the escalation `reroute`: the background then restarts the request in Automatic again, and that route reads the request with its carried corrections; a third such restart runs read-only (`reroute_limit`, without the hand-off tool): it applies the corrections and answers, and never runs in a mode chosen before the latest correction. An accepted hand-off restores the conversation and per-tab turn state captured before the turn gathered its context (approved plans, site-adapter and API notes, the follow-up allowance, the durable-turn marker) and returns; the background's `chat` handler then restarts the same request with `modeEscalation` in the requested mode, under the same request ID, so Stop still cancels it. The page-free check asks `plan_need` alongside `run_mode` too, and a sure answer rides along as `modeEscalation.plan`. The action run's planner gate reads the request again before any action. A refused call gets a tool result with the reason, and a second refusal withdraws the tool. Chrome drains Dev diagnostics only when a routed turn after Dev ends without handing itself to Dev.

The agent reports the routed mode with a `run_mode` update (`{ mode, source }`), which the run journal stores as the snapshot's mode and the panel stores on the assistant message for Retry, Continue and recovery. Traces record a `mode_route` note with the source, the decision latency and the time the turn waited. Slash commands and the Ctrl+Shift+A/X/D shortcuts choose a mode for one message only, also while a mode is kept; the shortcuts write the slash command in front of the draft. Context-menu and selection prompts stay Ask either way. The Ask system prompt, shared by chosen and automatic Ask turns, defers to `AUTO_MODE_ASK_NOTE` wherever it would tell the user to switch to Act mode, and the note says it replaces those instructions. An automatically routed Ask answer gets no one-click "Switch to Act & retry" offer (`ask_mode_handoff`): the turn could hand itself off, and the user's next message, a "yes" to an offer included, is routed again. A chosen Ask turn keeps the offer.

The user types a message, the panel sends a detached `{action: 'chat_start', text, mode, tabId, requestId}` request, then reconnects to the background-owned run journal for `agent_update` events. The acknowledged start becomes the existing `chat` handler and `agent.processMessage()` lifecycle; closing or reloading the panel does not transfer ownership or start the run again. The panel renders tool calls, results, plan-review cards, clarification prompts, and the final answer incrementally.

While a run is active, Send / Enter queues follow-up messages per tab. **Steer** / **Alt+Enter** sends a text correction to that same run; queued messages also have a Steer action. The background accepts corrections only from the extension chat panel and only for the matching run request ID. Both agent loops consume corrections as user messages before the next model request. An already running tool finishes; the remaining tool calls in its batch receive skipped results before the correction enters the conversation. Steering preserves the current mode and permission checks. If the run ends before consuming a correction, a journal event puts it at the front of that tab's queue for the next turn. A transport error retains the draft without automatically resending it. An accepted correction aborts the in-flight main model request (it has no browser side effects; like Stop, its usage is not metered) and is applied before any pending page refresh. After Stop (panel or page button), queued messages and unconsumed corrections stay in the queue, marked as paused, until the user edits, steers or deletes them; nothing is sent automatically. Right-click menu and selection-shortcut prompts pending for the tab at Stop, or arriving while it stops, are held the same way: the hold is stored with the prompt, so neither a reopened panel, another panel instance nor a restarted worker starts it. The queue lists each held prompt as paused with Send and Delete; Send releases the hold and runs it through the usual claim and lease with its original selection grounding, and Delete clears it. A newer prompt for the tab replaces a held one, as it replaces any pending prompt, and a conversation clear keeps its own rules for these prompts. An accepted correction is acknowledged only after it is journaled in session storage (`agentSteer:<tabId>`), and it stays there until the run has saved it into its conversation or handed it back, so a background restart (MV3 service worker or Firefox background page) cannot drop it. When the panel resumes the interrupted request, the resumed run restores its unapplied corrections ahead of any newer ones and applies them at its first boundary, before the old task acts again; corrections already saved in the conversation are not applied twice, and corrections of another request are never applied to it. If the run does not resume (recovery refused or failed, Stop, or a newer request in the tab), the panel puts them back in the queue marked as paused; clearing the conversation or closing the tab discards them with the rest of the run state.

In Act and Dev, steering links the initiating request and ordered corrections into one task authority with internal run, message, and revision metadata. At the next safe boundary, both execution paths revalidate that authority through the configured intent or planning gate and refresh execution, recipient, workflow, progress, and tool policy. A newer correction supersedes an in-flight result and invalidates any pending plan-review card. Planner failure stops further dispatch with its concrete error. Ask stays read-only, and ordinary later chat messages remain new tasks. Task-authority messages survive compaction and session recovery; prior submission receipts survive separately from reset completion evidence. A correction preserves the original mutation receipt. Further consequential work requires reconciliation of that effect and authorization under the latest validated request; accepting a correction never authorizes replaying the original submission.

Completion uses submission receipts belonging to the current task authority;
receipts from an earlier revision remain available for reconciliation and replay
protection but cannot certify the revised task as complete.

Action checks distinguish observation and preparation from publication or deletion.
Positively resolved ordinary controls can open menus or editors without acquiring
publication authority. Commit controls retain task, payload, account and resource
checks. This classification uses the observed control and its context; a page
label or a missing publication contract cannot grant mutation authorization.
Links (including clicks on their text or icons), menu items, tabs, options,
toggles, disclosure summaries, typeless buttons outside forms and a composer's
own draft tools are ordinary controls. A link with a real destination is
navigation even when named Trash, unless its query performs a destructive
action; removing a filter or search term is a view change. On X and Bluesky a
non-publish app control id disproves publication wording such as Reply;
deletion, send, save and payment wording still marks a commit. After a
correction, searches and in-form toggles need no reconciliation. A form without
record identity is bound by its action and values: an identical resubmission is
reported as already made, a corrected in-place save needs the observed earlier
result and authorization under the latest request, and a different target
(another form or platform) needs a known earlier outcome. Account names, read
on X and Bluesky only, name a post's platform; any other attempt, such as a
Mastodon post or a form, is placed by the site it was made on. Hosts that share
their last two labels count as one site, and x.com and twitter.com as one
platform. A post on another site than the earlier attempt counts as another
platform only when the correction's receipt lists every publication the task
had made and none was on the post's site; on x.com, twitter.com and bsky.app
only a composer publication posts, so a settings save or a consent click there
is not one. Their other hosts and clients, such as X Pro, post without the
composer controls DIV recognizes, so there any action that may have been
sent counts as a publication unless the page probe proved it cannot post (an
ordinary form, a deletion, or a control resolved as a link, field, menu item or
other non-submitting control). There, a control that looks ordinary only
because no model read its caption in time proves nothing, and under a
correction it is not clicked; Enter in the app-marked post editor edits the
draft, as on x.com.
The agent records, for the task from its first run on, the site of every
dispatched attempt that may have changed something and of every publication
among them (a search, a send the browser refused or a form the page rejected
is not one; an action Stop interrupted after it was sent is). The record is
saved with the conversation, and on its own just before each action that may
commit something is sent, so a restart right after that action still counts
it. When that save fails before a possible post on X or Bluesky, or an action
of unknown site, the action is not sent and the run stops with persistence
degraded, as it does when the run's recovery checkpoint cannot be saved. Each
correction copies the record into its receipt. A post made under the
correction is kept from repeating by the publication contract's outcomes and
dispatch records of the run that applied it, and by that run's own list of
the possible posts they never see, such as one from X Pro; a run rebuilt from the saved
conversation, as after a restart or a typed "continue", has neither, so there
a publication anywhere in the task on the post's site holds it too. Without a
complete record, or with an earlier publication on the post's own site, the
post stops once with a report instead of a search for the other site's post.
For such a post, any page read since the earlier attempt was sent, including
one after the correction, makes its outcome known; where account names or an
ordinary form tell the targets apart, the earlier result must be observed as
before. Whether a correction
asks to delete the earlier post or record first is a fixed-choice question
that a model answers from the correction as the user wrote it, in any language
(see "Language decisions" below): removing characters, words or hashtags from a
post is an edit; removing the post or record itself makes deleting the original
a prerequisite. An unsure answer, or none, publishes or submits nothing.

Whether a clicked control deletes one item or several, publishes, commits,
moves to a next step, only edits the draft or only changes the view is what a
model read its captions as (see `control_effect` below); no word list decides
it. A deletion of a record that has a permalink is bound to that URL. A deletion
of a record without one (a cart item, a mail or table row) is bound to the
record instead; a caption read as deleting several or the selected items gets
no record. The page probe takes the nearest row, list item or article
holding no other visible deletion control (one repeating the clicked control's
own caption, or read as a deletion), or else a bounded container that
stops at lists, landmarks, editors, headings, other records, other deletion
controls (including hover-only ones) and 2,000 characters, and keeps its
visible text without the control's own caption, together with the text of up
to twelve records of the same kind beside it, nearest first. A menu item
borrows the record of its expanded aria-controls or popover launcher, or, for a
menu the page mounts elsewhere without that link (a portal), of the launcher
whose own click the probe saw open it: the one new menu shown within three
seconds of that click, counted even while it fades in, never a menu opened by
a script, by another launcher, or alongside a second new one. A menu that opens
inside a dialog already on screen counts, and so does a menu inside a new
wrapper that opened with it. A Mastodon post's
menu and its confirmation are captured the same way for the native post, and
the action bar Mastodon draws beside a detailed status belongs to that status.
On a post of the signed-in account, the menu's entries Mastodon marks dangerous
(Delete, Delete & re-draft; buttons since 4.4, links drawn as buttons in 4.3)
are deletions of that post by page structure, read or not: with Mastodon's confirmation preference on, the confirmation such an
entry's click opens belongs to the post; with it off, the entry is the deletion
itself. Mastodon makes the rest of the page inert while its confirmation is
open, so the native identity reads (the post, its links and text, the signed-in
account) look through the inert mark on the siblings of that open modal root,
and through nothing else. The signed-in account is the navigation's account
link, or, in layouts without one, the account the app's initial state names;
the two must agree. The confirmation's primary button counts as Mastodon's own
commit in any layout, also below 1175 px, where Mastodon shows no composer
beside the timeline. The probe identifies the page's records once per run,
however many of its checks need them. A
confirmation dialog borrows the record of the agent's own authorized click
only when it opened after that click was checked, within 30 seconds, and holds
that one deletion control. The probe receives nothing from the request.

Whether the latest request asks to delete this exact item is a fixed-choice
question (`deletion_request`) that a model answers from the request as the user
wrote it, in any language, and the item as the page shows it: its text, its
link, the step (the item's own control or the site's confirmation dialog, whose
question it also sees) and the items beside it, all as untrusted data. The
answer is one of: delete this item; unclear (another item fits as well, or it
is named only by position); another item; no deletion asked; told not to
delete. Only "delete this item" deletes without asking, and only with a
quotation from the request that supports it. "Told not to delete" refuses
without a card. Everything else, including no answer, goes to the user on
DIV's card below. The same record is never deleted twice at the same step
in a task, even after a reload, and a changed record, step or set of
neighbours changes the checked action, so a decision cannot carry over to it.
Toolbar, bulk and selection deletions, menus with neither a linked launcher nor
that click provenance, and confirmation dialogs that cannot be linked get no
record and stay blocked.
Completion after such a deletion uses the ordinary post-submit checks.

When the decision is not a clear "delete this item", DIV asks the user on
its own card instead of refusing: "Delete this item on <site>?" with the item's
text as the page shows it (plain, bounded text), its link when it has one, the
site's own confirmation question at that step, and fixed choices (Delete,
Don't delete) without free text. Delete authorizes that item for the rest of
the task, including the confirmation dialog its click opens, with no further
model check; the checks run again on a fresh reading of the page before the
click, so a changed item is not deleted. Don't delete keeps it, and the item is
not offered again in the task. Stop or a correction cancels the card and
records nothing. Unattended scheduled runs are not asked and delete nothing.
Toolbar, bulk and selection deletions, unlinked confirmation dialogs and
repeated deletions stay refused: the user could not judge them from the card.

When a runtime check ends a run, the chat shows a plain-language answer: what
happened and what to check next. The exact diagnostic stays in verbose tool
rows, later model turns and traces.

When automatic page or iframe updates would discard a terminal Ask reply, the
configured provider can make a bounded dependency check for that exact reply.
An exact reply that uses only conversation facts or general knowledge can finish
without repeating page reads or generation. The proof belongs to the current run,
task, provider, mode and main document; Stop and genuine corrections revoke it.
Page-dependent answers retain fresh observation checks. Automatic frame changes
also consume the existing five-attempt recovery budget when a reply cannot be
retained, instead of causing unlimited model calls. The dependency call is traced
as `ask_response_scope` and uses the normal cost and abort guards. It grants no
browser action or publication authority.

LinkedIn message inspection recognizes image-preview controls in history and native conversation-list rows in the separate rail. A preview requires its image descendant, visible enabled control, matching hit target, and active modal scope outside the composer or form; its label alone is insufficient. Nested row actions and actual Send controls retain recipient verification. The adapter directs the agent to locate the named sender, scroll the history pane to earlier messages, and inspect each attachment in sender context before asking for any missing event details.

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
4. **Manage side panel visibility**: per-window "DIV" tab group controls where the panel is enabled
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
  2. If persistent API permission or this tab's /allow-api is active → inject [API ALLOWED] preamble
  3. If site adapters enabled → getActiveAdapter(url) → inject adapter notes
  4. If provider supports vision (or dedicated vision model configured):
     a. Capture viewport screenshot via CDP
     b. (Optional) Sub-call dedicated vision model for text description
     c. Attach image_url block or vision description to first user message
  5. Return enriched user message
```

#### Page context reduction

DIV does not send raw HTML or a raw DOM dump to the model by default. The
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

In Try, a turn that automatic mode routed to Act or Dev with a sure `plan_need: direct` answer also uses the compact intent schema (`_routedDirectTask`), and the trace records a `planner_skipped` note with `reason: 'direct_task'`. `direct` is an authorizing choice, so it needs the 0.85 threshold, and its description leaves out risky work (payments, purchases, bookings, deletion, bulk changes, credentials, messages to several people) as well as work with several goals, many items, several sites or pages, conditions, schedules or facts to carry across many steps: those answer `plan`. Strict, plan review set to Always, a steering revision, and any action turn without a sure `direct` answer, such as one in a mode the user chose, keep the full planner. So does a turn whose task the decision model could not read whole. That covers a request over 6,000 characters, an earlier task cut at 600, a decision state over its 12,000-byte budget, and text that redaction changed (a credential line, a URL query). It also covers a turn with attached files and the continuation of a read-only run, whose task lies partly outside the question. A `direct` answer is not used for these turns.

Planner latency grows with the tokens the model writes, so both prompts ask for little. `summary`, `steps` and `risks` are English; `localized` is `null` for an English `wbLocale`, and for another locale it is required only when the user reads the plan: `clarify`, `plan_only`, and an `execute` plan shown for review, whose rule the full prompt states from the current review settings (`plannerReviewRule()`). An English `clarify` uses its summary as the question. When a plan the user reads arrives without its copy (`normalizePlan()` marks it `localized.missing`), `_localizedPlanForDisplay()` translates the display fields in one small request (trace phase `planner_localize`) before the review card or the plan-only answer is shown. Execution keeps the English plan. A translation that fails or leaves out a step or risk is not used, so the user sees the English text rather than a mix. A non-English `clarify` without its copy is handled the same way: its English question is translated before it is asked. `memory: null` turns off the scratchpad and the progress ledger together, and `normalizePlan()` reads it as a declared `disabled` ledger, so no progress-classifier call follows. The compact intent check writes no steps for `execute` (its plan-only steps stay), and full-plan steps are one short sentence each.

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

Publication verification distinguishes a resolved request with no explicit
metadata values from an unresolved request. A resolved empty requirement list
still needs the same dispatch-bound resource and verified final submission.
Saved metadata and message drafts can bind complete, verified authored field
replacements or native choices to the current task and document, then require
exact fresh readback after saving. Explicit user-supplied values remain required.
GitHub release verification also compares the reviewed native tag, title and raw
Markdown notes with the saved release's own edit form. Chrome captures the review
in the submit probe's isolated content-script world and frame, so its AX form
reference identifies the same form; saved HTML readback needs no AX reference.
Failure diagnostics name
the missing verification step and preserve whether submission already occurred.

If the planner returns valid JSON and needs review, the side panel receives `agent_update: plan_review` and renders an editable review card. Approval pins the approved plan into the scratchpad so it survives context compaction. If no decision arrives within two minutes, the original plan is automatically approved and execution continues; the runtime emits `plan_resolved` with `decision: 'approve'` and `source: 'timeout'` to clear the pending review and its notifications. Rejection or user abort stops the run before any browser tools execute. A Cancel delayed past approval stops the matching active request and plan; its rejected resolution is journaled so reconnect can recover a lost acknowledgement without stopping a newer request. In Try mode, invalid JSON after one repair degrades only that turn to the Ask prompt and read-only tool catalog; Strict mode still stops before tools. Scheduled runs can set `autoApprovePlanReview` and pin the plan without showing the card.

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
without a terminal answer, the browser loop stays closed and DIV performs
one context-only handoff with only `done` available. That terminal schema permits
`partial` or `failed`, never `success`; invalid output falls back to the
deterministic step-limit summary. This also applies to the selected DIV
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
Nvidia NIM, Groq, Together AI, Fireworks, z.ai, OpenRouter, DIV Compass,
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

An Ask answer is about the page as the person asked about it. What they do on
the page while it is written (scrolling, selecting, clicking, typing, and the
page's changes from those), and any scroll or viewport resize, does not make
it stale: the answer already shown is kept and is not written again, and
its decision does not wait for the person to stop typing or scrolling. A
navigation of the page to another address, a new document, a correction, and
the page's own changes are weighed as before, so a page-dependent answer still
refreshes after automatic churn within its retry budget.

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

### Page selection bar and inline cards

Selecting text on a page shows a bar (Translate, Explain, Proofread, More…) drawn by a
content script in a closed Shadow DOM, in the top frame and in the PDF viewer page.
**More…** opens the full popup; its actions (Summarize, Quiz me, Humanize, with the three
the bar already offers left out) and question box queue a side-panel prompt as
described above. Translate, Explain and Proofread answer in place instead: the script sends
one `WB_SELECTION_SHORTCUT_INLINE` message and the background builds the same allowlisted
selection prompt (the selection inside its untrusted boundary, `selection_only` grounding)
behind a short fixed system message, then makes a single tool-less model call through the
cost allowance (90 s timeout) and returns the text. The output budget is sized to the
selection (at least 2,000 tokens; Translate and Proofread grow to about two tokens per
character, up to 8,000) and never exceeds the provider's own output ceiling or the room its
context window leaves after the prompt (estimated on the high side, since the provider's tokenizer
is not available: a whole token per ASCII character, as dense text such as minified code or hashes can need, four per other character, the most a byte-level fallback spends on one code point (accented letters, CJK, emoji),
plus a reserve), so a small local window is not sent a request it would reject. When the prompt
leaves less than 256 tokens for the answer, the background makes no call and answers with a plain
context-window error (not the cut-off shape: the side panel sizes its reply to the same window and
would refuse the same selection, so the card must not offer it as a way to finish). If the reply
still stopped at the cap (finish reason, Anthropic `stop_reason` or Responses
`incomplete_details`, or token usage at the budget when no reason is reported; OpenAI
Responses reports the limit as an error, which the background treats the same way and
answers with whatever text the provider returned) the response
is flagged `truncated`, and the card says so and offers **Continue in side panel** instead
of passing a cut-off translation off as complete. An answer is held to 64,000 characters, a limit enforced rather than inferred from the token budget (tokens are not a fixed number of characters): the background cuts a longer one there (never inside a surrogate pair) and flags it `truncated`, and the card applies the same limit to whatever it receives, so a follow-up or a continuation carries exactly the text the card shows and nothing is silently shortened afterwards. The call that reaches the configured cost allowance still returns its answer (the
background passes the allowance's own message as `notice`, from the result or, for a Responses
cut-off, the error), and the card shows it under that answer, since the next card would otherwise
fail with no warning. Continue sends the unfinished text as
`continueFrom`; the background wraps it inside the selection's untrusted block (whole, up to the
most a card holds, because the side panel shows that block to the user) with a trusted request to resume from where it stops, because running the action again
would meet the same output limit. The card keeps the whole unfinished answer to show, but once the active provider's context window is known the background sends only its tail (`buildContinuationSelectionPrompt`'s `contextWindow` option, marked with a leading ellipsis): it keeps what the window leaves after the rest of the prompt, the side panel's own prompt (`SIDE_PANEL_SELECTION_SYSTEM_TOKENS`, which a test holds above the real prompt) and a reply of up to 2,048 tokens, or only the 256-token minimum when the window is tight, so a long answer produced on a small local model is not refused as too long when it is continued. A card follow-up is sized the same way, but keeps the start of the earlier answer and says that the rest was left out (`buildFollowUpSelectionText`'s `contextWindow`, `question` and `language` options; a follow-up that brings the page as context manages its own context and is left alone). The estimate counts a system message, which is DIV's own prose and never page text, at a token per three characters instead of the worst case used for everything else, because otherwise the side panel's own prompt alone fills a 4k window. A window that cannot take the rest of the prompt and that minimum (about 2k) keeps the whole text and is refused, with the reason, when it runs. The side-panel reply to a continuation or a card follow-up carries the earlier answer as well as the selection, and a selection-only run skips context management, so that reply is sized to the room the model's context window leaves (the same worst-case estimate, `fitAnswerToContext`) rather than asking for the provider's full output ceiling; when the window leaves no room it says the selection is too long for the model and sends nothing. A resumed Proofread gets its own instruction, without the ordinary request for one complete corrected version, so a model asked for only the remainder is not also asked to write the corrected text again. A side-panel reply that is cut off again says so (the
response-only path appends a notice when the provider reports a length finish, WebGPU
reports `outputTruncated`, or OpenAI Responses raises the limit as an error carrying
`partialContent`, whose text is then shown), so a long remainder never passes as complete
and can be continued by asking. The call that reaches the cost allowance says so under the reply, whether it finished or was recovered from that error, so the next continuation does not fail unexplained. Each call carries a job id, and a card
that is closed, retried or retargeted sends `WB_SELECTION_SHORTCUT_INLINE_CANCEL` so the
background aborts the paid request it no longer needs (a page that unloads mid-answer sends the
same cancel from `pagehide`, since it can no longer close the card itself; for the in-browser WebGPU models the
provider also sends `webgpu-chat-cancel`, and the offscreen worker interrupts the running
generation or drops a queued one, and the offscreen host remembers a cancel that arrives while the request is still being routed to a worker, so the generation never starts, and the Bonsai 2 Vision worker re-checks for a cancel before each prefill slice so a long prompt stops at the next slice boundary; those workers report `outputTruncated` when an answer used
its token budget, since they have no finish reason); the card also claims its request id
before it waits for the language bundle, so a double click starts only one call, and **More…** takes a newer id on the same wait, so an action clicked just before it never reaches the model. Selections
over 4,000 characters skip the card and use the side-panel flow. The card draws the answer as DOM
nodes (paragraphs, lists, bold, italic and code), never as HTML, and takes the source
language from the browser's own detector, with no network call. If the language bundle cannot be
loaded, the card runs on its built-in English text and still lists the translation targets. A follow-up typed in a card
continues in the side panel as a custom question. In Chrome the background opens the panel
only when none is showing in that window: re-running `sidePanel.setOptions()` + `open()` on an
open panel closes it, so each panel reports its visibility over a long-lived port
(`sidepanel-presence.js`) and the background reads that synchronously, before the user
gesture can lapse, then hands an already-open panel the prompt by message. A panel whose port
was dropped by a background restart reconnects at once (only a port that is refused straight
away backs off), so the restarted worker is not left unaware of a panel that is still showing.
A new panel reports as soon as it knows its window, ahead of its other start-up awaits, so an
action arriving while it is still opening does not open it a second time.
A panel the browser carries to another window (the tab dragged out) keeps its document; the window scope
notices on its next live `windows.getCurrent()` lookup and the reporter (`setWindowId()`) names the new
window, so the background does not treat the old window as occupied and the new one as empty.
The PDF viewer does the same for the window id it sends with a selection: `pdf-viewer-window.js`
takes the new window straight from `tabs.onAttached` for its own tab (no lookup to race a click that
follows the drop, and a lookup begun before the move is discarded), re-reads `windows.getCurrent()`
when the window gains focus and at the start of every pointer gesture as a backstop, and the selection
script reads those fields when it sends, not once at load.
A selection made in the bundled PDF viewer, whose message carries only a tab id, brings the
window too (Chrome's `sender.tab` for that tab, else the window the viewer reported from
`windows.getCurrent()`), so the same check applies there; that path opens the panel once in the
click and queues the verified prompt with `panelOpened`, because a panel that is still starting
up has not reported in yet and a second `open()` would close it. The card's
answer travels inside the selection's untrusted boundary, labelled as an earlier answer that
may contain mistakes and
capped at 64,000 characters (the most a card is ever held to), so model output derived from page text never becomes trusted
instruction. The selection and the answer go to the configured provider like any other
model call.

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

Chrome CSS patch records include the top-level `documentId` and a patch-specific CSS marker. Full navigation clears persisted records, and `remove_injected_css` checks the live document before calling `removeCSS`, preventing an old patch ID from removing equivalent CSS on a replacement page. If navigation races either identity check during injection, DIV removes that patch's exact uniquely marked CSS from the replacement document before discarding its record. Chrome `execute_js` passes a 15-second timeout to CDP. Dev diagnostic event handlers are registered before either agent-loop variant starts and own their debugger session across turns, so ordinary run cleanup preserves their bounded buffers. Leaving the panel-wide Dev mode drains every tab in the CDP client's active-diagnostics registry, removes the handlers and buffers, and sends `Runtime.disable`, `Log.disable`, and `Network.disable` so Chrome also stops domain-level diagnostic work; conversation and tab cleanup additionally detach the debugger.

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

A `pageGate` is a wall in front of an article: an overlay on an article page, or
a block inside the article, whose text a model read as keeping the article
from the reader until they subscribe, register or sign in (the `page_blocker`
question, in any language; an offer beside readable text is not a wall). An
overlay or block is read by its own name and title and by chunks of its
rendered text: its elements in page order, an element longer than 600
characters with block children split into them, gathered into texts of at
most 600 characters, a heading starting a new one, and a longer stretch of
inline text read in pieces of that length. The chunks are read in page order
up to the first one read as a wall, at most 30 of them. In an article the
wall starts at that chunk, or at a chunk before it nobody has read, since the
wall's text may be there, so only text read as no wall comes before it: a
preview in chunks before the wall stays readable, also inside the wall's own
block, while the part of the wall's own chunk before its text is withheld
with it. Of several walls in an article, the one that starts first decides;
an overlay is the wall as a whole. A wall's label is its name or title, or
the first line of the element its starting chunk begins in, and none when an
unread chunk comes first, since what follows a wall's first line may be the
article. A page read reports at most 40 texts nobody has read, overlays first
and then blocks offering a control a wall would (a button, a field, a form or
a link standing on its own), in `pageTextsNeeded`; the agent has them read
(the decision model first, the active model within four seconds) and reads
the page again with the readings, up to three times while each read reaches
more. A text that differs only in its numbers from texts read as one wall
is that wall at once, and is still reported to be read until two texts of
its shape were read as that wall, so a countdown wall stands between reads
at the cost of one more reading, and a quota that stops being a wall when
its number changes reads as what it is once read; a shape with any other
reading carries nothing over. When a text reads as
a wall and the page cannot be read again, the read fails rather than return
the answer made without that reading; so does an answer without that wall
applied while texts are still unread, at any pass, as with a wall whose
other text changes on every read or whose next text no model answered. An
unread text is no wall, so the page reads as it is, and a text no model
answered after both had their turn is not asked again for 30 seconds. A wall
withholds the article, its links, forms and frames; its own text and
controls stay readable. The CDP mirror of the page read (`readPage` in
cdp-client.js) applies the same rules.

Checks that run in the page, such as this one, the CAPTCHA scans, the submit
probe and the recipient guard, receive the agent's most recent readings of
their questions (the latest 400, at most 80,000 characters). A text the agent
read earlier that a check still reports unread is not asked again: its reading
becomes one of the most recent and the check runs again with it. Texts are
keyed alike on both sides: spaces collapsed, and a text cut at its limit loses
a trailing space or half of a surrogate pair.

Single public-media downloads have a second deterministic guard. If the model
calls `download_social_media` while an eligible inactive skill owns
`download_public_media`, the runtime activates that skill and returns a retry
pointing to the specialized downloader. A real failed public-media attempt
re-enables browser fallback. The browser MSE path fails closed before saving
split or unverifiably muxed video/audio buffers, so it cannot report separate
tracks as a successful video or hand ffmpeg work to the user.

The packaged FreeSkillz resolver and downloader allow Bluesky post URLs.
Mastodon uses an `inputUrlAllowlist` rule of `{ "siteAdapter": "mastodon" }`
so supported instances do not need a fixed host list in the skill manifest.
That rule accepts only exact HTTPS status permalinks on known instances or
instances independently verified through same-origin NodeInfo discovery and
`software.name: mastodon`. The credentialless verification rejects redirects,
limits metadata reads to 64 KiB and 10 seconds, and never probes the post URL.
Internationalized domains are accepted using URL-normalized IDNA hostnames.
Credentials, custom ports, and local-network destinations are rejected; query
strings and fragments are removed before forwarding Mastodon status URLs.
Feeds/profiles stay behind the visible-target guard. Both sites use the existing
provider job lifecycle to deliver one final media file and clean up the job.

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
reinforced by DIV's untrusted-content wrappers and the loader description,
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
tool, including its recipient purposes (`message_recipient`, `recipient_change`);
only `research_escalation` and its fields are opt-in. Because Ask's only
`clarify` is the consent card, the Ask policy note asks for a missing research
constraint in the final answer instead.

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

The action-mode intent gate runs before the first browser tool call. Off uses the compact schema; Try and Strict use the full planning schema, with unset storage defaulting to Try. Try also uses the compact schema for a turn automatic mode routed as a direct task ([Step 4](#step-4-plan-before-act-gate)). The full planner prompt requires a single JSON object with summary, concrete steps, validated `skill_ids`, a nullable memory strategy, scheduling hint, risks, a nullable `localized` copy for the user's language, and an action mode. Both schemas also carry a language-neutral `messaging` target when the trusted user request authorizes an external message: either the exact named recipient or an explicitly referenced active conversation. Mid/Full planners receive only the eligible routing catalog, and approved skill IDs are activated before the normal execution model call. `normalizePlan()` bounds and sanitizes each field; `formatPlanMarkdown()` renders the side-panel review card; `formatPlanScratchpad()` pins the approved or edited plan as an `[Approved plan]` scratchpad entry.

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

DIV Compass runs also have a separate consent-gated terminal-runtime path.
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

### Language decisions (`semantic-decisions.js`)

Where a rule depends on what the user's words mean, DIV asks a model one
closed question instead of matching words (`semantic-decisions.js`, shared by
both builds). Each question lists its choices and what each one means. The
request is the user's own text; page text is passed as untrusted data and can
never change the question or the choices. The decision model answers when it
is enabled in settings and sure enough (0.85 for a choice that lets an action
go ahead without asking, 0.7 otherwise); otherwise the active model answers
and must quote the request for a choice that lets an action go ahead. Choices
outside the list, a missing quotation and failed calls count as no answer, and
every caller treats no answer as "ask the user" or "do nothing". Identical
questions are answered once. Stop or a correction during a decision cancels
it. The questions are: does the request ask to delete this item; does a
correction ask to delete the earlier post first; does the request say not to
send this message; and does a short Act turn sent after an earlier task only
continue it or acknowledge it. That last answer is read once, when the turn
arrives, and stored on the turn, so the task anchor, the progress ledger's
scope and an approved plan read it without words. The Continue command is a
continuation by construction; long turns, Ask turns, first turns and turns
without a sure answer are new requests. A carousel scan asks whether the
request wants the slides from last to first; no sure answer is the usual
order. Consent itself never comes from reading words: who receives a message
and whether an unclear deletion proceeds are answered on DIV's own cards
with fixed choices, and a question the model asks, and whatever the user
answers to it, approves neither.

Plans and progress intents are the models' own reading of the request. No
rule rewrites a plan from the request's words, an edited plan's expected items
come only from its own expected-items line, and the items a repeated-action
task leaves out ("everyone except alice") come from the intent model's
`excludedTargets`. Ledger rows written before rows were stamped belong to the
current task only when its classified intent allows the action they record.
A click is recorded on the ledger when it lands on a row's own control, or
when a model reads its label, in any language, as doing one of the run's
allowed actions to an item (`progress_action`: it does the action, undoes it,
or does something else); the item is then the ledger row for that action the
label names, or the page its link opens. On a Mastodon instance's own pages
(known instances, `mastodon.*` hosts, remote profiles and interaction routes;
a `/@handle` page of another site is no fediverse account), a model reads
the page's control and field labels while a ledger tracks the run
(`follow_state`: follows, already followed or requested, asks for the user's
own server, or something else) and which domain the request names as the
user's own server (`home_instance`). A follow row is marked processed only
after a followed state is read, and a server field arms the remote-follow
handoff to that server; unread labels say nothing.
Typed messages are sent as typed; `/screenshot` is the explicit local capture.

The completion judge (the decision model or the active model) answers two
more fixed-choice questions in the same request as its verdict: whether the
request also expects something no run can verify, such as votes or moderators
keeping a post up, and whether the candidate summary gives the result, only
says that an answer was given, or only describes what will be done next. A sure
"expects later" answer adds the note that publication was verified while later
votes and moderation remain unverified; a summary read as a claim or a plan is
sent back once for the actual result. Where no judge runs, a model reads the
summary with the `done_summary` question: a short Ask answer with no structure
of its own (a colon, line breaks or a list mean it carries content), and an Act
run's failed or partial summary, which may also blame the agent's own Ask or
read-only mode and then gets the runtime-mode correction. A planner-shaped
object is recognized by its shape, and one the model rates at zero confidence
is its refusal; a plain final message in an Act run gets one recovery whatever
it says. No word list reads a summary or a final message.

When the model request fails after an Act run sent a submission, DIV reads
the page itself and completes the run only while that submission is still the
run's latest action (or a navigation bound to its result) and the plan names at
most one deliverable; its answer claims only that submission. Otherwise the run
stops as partial with Retry and Give up. Right after the submission the message
says the action may have completed. After later steps, such as opening the next
site of a two-site post, it names the site the earlier submission went to, so
the next run does not take a later, unsent step for a possible duplicate.

A request that contains one arithmetic expression (found by structure: the
one span the calculator accepts, not digits inside a word or code) is read with
the `calculation_request` question when the planner gave it no page reads,
state changes or submissions. Only a sure "only the result" reading limits the
run to the calculator and lets the calculator's receipt complete it while the
page keeps changing. When the request also sets a form for the answer, the
active model writes it down (only the number, the number last, an ending and
other required texts), each text copied exactly from the request and checked
against it; a form it cannot write down that way is left to the completion
judge, with the calculator's result as evidence. The reading and the form are
kept on the execution guard and read again only when the request changes.

Questions about several items (`missing_value`, and the page readings that
follow) are batched: the decision model gets one question per item in chunks of
16, and the active model answers up to 64 items in one reply. A required value
of an expected item that only says it is missing ("unknown", "bilinmiyor", "—")
is found this way once, at a successful done, among values of 40 characters or
fewer; no sure answer leaves the value counted as given. Missing values are
otherwise JSON null. Action names in progress rows and requested field names
are the canonical names the models are given; another word for one is rejected
(progress_update) or names no field (the requirement stays incomplete).

Page text is read by structure first. A page's words decide nothing where
the page's own structure answers: Gmail's result range is parsed by its
numbers whatever separates them; a carousel's slide total comes from the shape
of its labels (two numbers joined by one word or a slash, or a series of
labels that differ only in their number) read inside the post that holds the
media; carousel back-and-forth is detected from the slide indexes the steps
reach; ChatGPT's log-in, stop and send controls are its own test ids and auth
links; and a trimmed accessibility tree keeps first the buttons that share a
form or composer with a visible text entry. The completion judge's evidence is
the latest read of each of the four most recently read pages, told apart by
the address each read reports. Where structure cannot answer, a model reads
the specific label once (the `carousel_control` question finds a carousel's
Next control among the visible labels; only one sure "next" is clicked).

What a page says after a submit is read the same way, never matched against
words. Short page texts (300 characters, 500 for a validation alert) are read
with one fixed-choice question each and remembered per text, so the
synchronous checks that follow (`_pageTextReading`) cost nothing more; a text
nobody read proves nothing. `status_message` reads whether a message says a
submission succeeded, reports an error, or neither. At a successful done, when
a submission still needs proof, it reads the page's live messages and the
statuses the agent observed after the submit (the accessibility tree's
status, alert and log lines, a page read short enough to be one message, a
screenshot's short description, and, after the submit led to another
document, its title); `pageState.successMessages` holds only the live
messages read as success and is never taken from the page. A submitted
iframe needs one new message read as success and none read as an error. Form
validation sorts alerts by page structure: an alert an invalid field points
to, one inside a form with an invalid field, or one the site's own id, class
or state marks as an error rejects a submit unless it is read as success; any
other alert rejects it only when read as an error. Only alerts new to the
page are read (all of them after an earlier rejected submit). A site
workflow's last step (`workflow_state`: a draft saved, a message sent on the
sites whose own notice is part of the job, a form submitted, changes saved,
review threads resolved) is shown by a page text read as reached with none
read as failed or pending, among its live messages, dialog titles, prominent
headings and status regions, the statuses observed after the submit, and the
lines of a page short enough to be a confirmation page. Those are read only
once the rest of the workflow's evidence is in place. Beside them, at the same
time, an update-metadata or publication job reads which requested detail each
field saved after the dispatch holds (`metadata_field`, `publication_field`),
so the saved values can be compared with the requested ones in any language;
a write in such a job reads its own field's labels and names before it is
recorded.

What a clicked control does is read from its captions the same way
(`control_effect`: it publishes, commits, deletes one saved item, deletes
several or the selected items, moves a form to its next step, only edits the
form or draft, only changes the view, or is unclear), once per caption. The
submit probe classifies every click by these readings before it is sent. The
agent passes the readings it holds; on a collect pass the probe returns the
activated control's unread captions (its text, ARIA and title names, action
name and an input's value and labels, plus the other controls of a dialog it
sits in) before it changes any page state, the decision model reads them (the
active model within four seconds when there is none), and a final pass
decides. Fields and plain links have no captions to read. A caption no model
could read decides nothing, which is what any caption in a language the former
word lists lacked always did: the control is ordinary unless page structure
says otherwise. While the active model decides on a page, the decision model
alone pre-reads the captions of the buttons, menu items and tabs its
accessibility tree shows, so a click usually finds them read.

Readings decide: a deletion (the record binding above, or no record for
several items); a draft tool (a composer control not read as a commit, a
publication or a deletion, and a draft edit only when the removed item is
visibly an attachment); an ordinary control (outside a form, not read as a
publication, commit or deletion; for an X or Bluesky control with a
non-publish test id a publication reading does not count, while a popup
launcher read as publishing stays a commit); strong submit evidence for a
`type=button` control in a form (a caption read as a commit, publication or
next step); an unnamed X or Bluesky composer control read as a publication; a
dialog's named button outside any form read as only changing the view
(closing, cancelling, going back), which is not a submit; and Mastodon's own
"…" menu and dangerous item. A saved workflow's deterministic replay asks the
decision model alone for these readings, never the active model. Form validation waits for a rejection after a caption read
as a commit, a publication or a next step; a workflow click submits its form by
structure or such a caption; and a rapid second text click is a duplicate only
for a caption read as a commit or publication, asked then if the first click
left it unread. Words in a CSS selector are not read. At a successful done, a
visible form made only of search fields, or of one empty, unnamed text field,
sent with GET and holding no other task evidence, counts as a task form still
on screen unless every one of its submit captions is read as `view` (showing,
filtering or searching); an empty, unread or unclear caption keeps it counted.
When no submit control has a caption (icon-only buttons), the field's own
label or placeholder is read instead with its own question (`field_purpose`:
it searches or filters the site, takes content to send, post or save, or is
unclear), since `control_effect` calls a control that only opens an editor
`view`; only `search` releases the form.

On a page whose sends the recipient guard checks (see the messaging
adapters below), the page's own texts are read the same way, by what they mean
in any language: what a control does, from its name (`message_control`: it
sends something to someone, publishes, opens a reply or forward, opens a new
message, opens a new post, only works on the draft being written, is one of the
conversation's own tools such as a call, search, settings or back button, is
something else such as a contact's name, or is unclear); which row of a message
a field or a group of address chips is, from its labels and names
(`message_field`: To, Cc, Bcc, subject, body or something else); whether a
message's label says the page's own user sent it (`message_author`: self or
other); and what a sent message's status says (`message_status`: delivered or
read, sent, pending or failed, unclear). The agent hands the readings it holds
to the page with each guard check and chat observation; texts the check
consulted unread come back, are read (the decision model first, the active
model within four seconds) and the check runs again, up to three times while
it reaches texts nobody has read (a send control's name first, the recipient
rows behind it next). The check waits four seconds, but a slower active model
is not cut off: its read goes on in the background for the run (charged and
traced to it, cancelled when the run stops or ends, given up after 20 seconds),
and the retried click joins it instead of asking again. Only the latest check's
reads are carried over; a check about other texts cancels them. An in-browser
model, whose requests cannot be cancelled, is still cut off at four seconds. The page monitor's capture reports only that texts were
consulted unread; page feedback then asks for them, reads them and captures
again, so the conversation that owns a footer action is decided with the
readings. While the active model decides on such a page, the decision model
alone pre-reads its button, menu item and tab names for the control question
too. Until a text is read each check takes it the cautious way: a control as
one that could send, a field as holding no recipient, a message as nobody's in
particular, a status as not delivered. Readings decide: without a composer, a
control read as sending, or not read yet, stays guarded (an unread one is
blocked as retryable, so the click can be tried again once read), while any
other is not a message send; a composer control read as only working on the
draft is a composer utility; a Gmail control read as opening a reply or forward
is composer setup; LinkedIn's feed entry read as opening a new post opens one;
a conversation header's controls read as actions are not its contact; a
Discord settings control, a LinkedIn image preview or Telegram's settings
entry read as sending is not exempt; a webmail field read as a To, Cc or Bcc
row holds that row's addresses (an email-typed field on a mail page is a To
row, and an address chip keeps the row its field gave it); a Gmail chip takes
its row from the labelled row around it, after the app's own row names; a
message whose label reads as the user's own counts toward the sent-body
baseline and is outgoing in a chat observation; and a native WhatsApp message
counts as sent once its status reads as delivered. The content script keeps no
word list: Discord's channel composer is found by its channelTextArea
container and a channel or contact is named by the longest text of its
selected rail link that the composer's label also contains, LinkedIn's
conversation list by its class, a formatting toolbar by its role, WhatsApp's
contact drawer closes through its header's one named button, and a phone
number in a composer's label is taken by its digits.

Chrome's one trusted retry click on a generic element whose synthetic click
changed nothing visible (see `accessibility-tree-and-refs.md`) is decided the
same way. Page structure rules out native, form, stateful, download, covered
and handler-bound targets first; then the element's name is read once
(`control_repeat`: a second click could send, buy, delete, like, follow,
download or otherwise act twice or undo itself, it is harmless, or it is
unclear) while the page settles. A name read as changing something is not
clicked again; a harmless, unclear or unread name keeps the retry, as an
unrecognized name always did. The content script keeps no word list.

Requested field values (a message or post body, release notes, a title) come
from the intent model too. A short value is returned as is; a long one is
returned as its exact first and last words, and the runtime copies the text
between them from the request or the approved plan, the way the social
publication contract copies post bodies. No word list finds where a body
starts or ends. An anchor that is missing, repeated or out of order resolves to
nothing, so the field stays unresolved and nothing is verified against a
guessed value.

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
same local store from the side panel. Settings → Memory provides enable,
auto-learn, edit, delete, clear, export, and import controls for Chrome and
Firefox.

Auto-learning is enabled by default. After successful `chat`,
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
- `paused` — the user or settings paused the job, or the scheduler paused a recurring task that needs the user (see Schedule); no alarm is set.
- `cancelled` / `failed` / `completed` — terminal states.

**Targets**

- `current_tab` — runs against the tab that was active when the job was created; fails if the tab is gone or has navigated away.
- `url` — opens (or reuses) a tab for a given http(s) URL at run time. A tab already on that URL is used as it is. Otherwise the run opens its own inactive helper tab and keeps it for later runs; only that helper is ever navigated back to the URL. The tab the task was created from belongs to the user and is never navigated away from its page. The run is told that an error or "not found" page at the address means the target is missing, so it ends as failed and repeated failures pause the task.

**Schedule**

- `once` — fires at a single `run_at` or `after_seconds` time. `after_seconds: 0` starts the task immediately.
- `recurring` — fires repeatedly at `interval_minutes` (1 min – 1 year); after each run completes, `nextRunAt` is advanced and the next alarm is set. A fixed interval is not a calendar schedule: 30 days drifts against calendar months, and the creation result says so. A run that ends with the planner asking the user a question, or a third failed run with no successful or partial run in between, pauses the task instead (runs without an outcome leave the count unchanged). Resuming a task the scheduler paused restarts the interval from that moment; a task the user or Settings paused keeps its next run, or runs a minute after resuming if that time has passed. Either way the failure count starts over.

A scheduled task run, recurring or one-shot, is never required to call `schedule_task`, and the planner's scheduling tag does not make it state-changing: its stored prompt keeps the user's original timing ("in 30 minutes, remind me…"), and either requirement made each run schedule the task again or end without success. The planner is told the run executes an existing task, and a state-change mark that only the scheduling tag explains is dropped (the raw plan must list only observing tools for every step, set submission explicitly false, and show no download, site job, message target, progress action or skill); the plan's own state-change, submission and download requirements still apply. A recurring run is told not to create another schedule for its task; a one-shot run is told not to schedule the task again and to create a different schedule only when the task explicitly asks to set one up (for example "on Monday at 9, start an hourly check"). A scheduled resume of an interactive task keeps both.

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

Adapters may also expose narrowly scoped runtime policy. Douyin `/chat` is the first `messaging.verifyActiveRecipient` route. The structured planner resolves an anaphoric recipient to `named` only when authentic prior-user context identifies exactly one target; unresolved pronouns clarify, and words that refer back to someone named earlier never mean the open thread. `active_conversation` is reserved for a request that points at the conversation on screen itself instead of naming it ("reply here", "this one", "this user", in any language): the planner never sees the page, so it does not ask who that is. An `active_conversation` planner target must first be pinned to exactly one strong visible header identity, while planning or, where the identity needs the page's own preparation first (Gmail's collapsed reply composer, a native WhatsApp contact drawer), at the first send in the thread open when the run was authorized; ambiguous or missing evidence stops for clarification. Its `recipients` are only the people the same request also names. On a route where a conversation reaches one person, the pinned conversation is the target and stays authorized for the whole task, while each named person is kept as requested (`requestedMessaging`, shown in the reviewed plan) and confirmed on DIV's recipient card before the first send to them. Native WhatsApp checks a contact through its drawer once per run, for the first chat the run looks at, except that a request naming its recipient may first open that person's chat from the chat list: its anchor follows the chat selection until the run arms its check with the guarded contact-name click. Once that check is invalidated, as by a change of the chat selection after it was armed (or at all, in a request for the open chat), the observer and the recipient probe report `native_whatsapp_contact_check_spent`, and the agent is told that the chat needs a new request instead of being sent to retry. Before the check, a blocked message action names the exact contact-name or Close control to click (`nativeWhatsappRepairTarget`). A chat only hidden for a moment, as behind a modal, is not a spent check. On a recipient-set route such as mail the named people are not added to the pin, since a planner copies names as the user wrote them while a mail composer shows addresses. The pin is the thread's recipients as before: one taken while planning sends a differing set to the card, while one taken at the first send from Gmail's collapsed reply composer is whatever that composer holds then, an existing limit. The first user message's screenshot note is dropped from the planner's copy of the task with the image the planner never receives. Immediately before a send-like click, submitted field, or Enter press, the content script resolves the exact target and a lower-page layout composer, then collects only unique header evidence from the narrow, non-scrollable region above it. Enter or submitted field input in a different editable is conclusively non-message only when structural semantics positively identify a search or navigation field; an alternate reply/forward/split-pane composer remains inconclusive and therefore cannot bypass recipient verification. A distant general control likewise remains inconclusive rather than being declared safe. A semantic conversation row in a separate left rail is conclusively navigation-only, allowing recovery to the requested thread whether or not the short rail currently overflows, and a row of WhatsApp's native chat list is navigation-only even while the open chat's contact is unconfirmed; nested row buttons, links, and their leaf descendants plus controls outside that structure remain inconclusive. The agent requires exact normalized identity equality and returns a no-dispatch blocker on missing, inconclusive, ambiguous, or mismatched evidence, and protected Enter dispatch permits exactly one keypress per verification. Every authorized `click`, `click_ax`, `set_field({submit:true})`, and composer Enter receives a one-use binding to the exact action target, composer, URL, and identity set. Direct content dispatches and Chrome's trusted CDP mouse/key paths consume and revalidate it immediately before `el.click()`, `mousePressed`, or Enter, after any field reconciliation and combobox delays; protected `click_ax` never issues a second no-progress fallback click. Search-result text, message content, input values, generic page text, failed probes, and edited plans with stale hidden metadata cannot authorize a send. Dispatch-capable tools whose effects cannot be bound to the probed recipient (`iframe_click`, `execute_js`, WebMCP execution, and `upload_file`, whose change event may auto-send) are unavailable on this protected route. Deterministic saved-workflow replay has no planner-owned recipient target, so a workflow with any potentially dispatching step scoped to a protected messaging route stops before page actions and directs the user to run a normal Act task with a named recipient; a per-step check also covers legacy workflows whose scope metadata is incomplete.

### Accessibility Tree (`accessibility-tree.js`)

The primary page-interaction path. Produces a flat, indented text tree of the page where each node has a stable `ref_id`. Tools: `get_accessibility_tree`, `click_ax`, `type_ax`, `set_field`. See `docs/accessibility-tree-and-refs.md`.

### CDP Client (`cdp-client.js`) — Chrome only

Wraps `chrome.debugger` API for:
- **Trusted events** — `Input.dispatchMouseEvent`, `Input.dispatchKeyEvent` (event.isTrusted === true)
- **Screenshots** — `Page.captureScreenshot` with clip/scale control
- **DOM queries** — `Runtime.evaluate` for shadow DOM piercing, `DOM.getDocument` for closed roots
- **WebMCP** — `WebMCP.enable` maintains a bounded live catalog and
  `WebMCP.invokeTool` executes a page-registered structured capability. DIV
  exposes opaque `wmcp_*` IDs rather than page-controlled names as call handles.

During active Chrome Act/Dev runs (including saved workflow replay), native
JavaScript dialogs are continued through `Page.javascriptDialogOpening` and
`Page.handleJavaScriptDialog`. Alerts are acknowledged; confirmations and text
prompts are dismissed. A dialog event cannot prove which click triggered it,
so a running task or an input command in flight never grants permission to
accept a confirmation. Cached dialogs from idle time are also dismissed.

A `beforeunload` warning chooses Leave only for a one-use navigation permission
created immediately before a navigation or history navigation tool dispatches,
after its existing permission and unsaved-change checks. The warning must come
from the same top-level source URL. The permission expires on the first accepted
warning, navigation completion/failure, cancellation, or after ten seconds.
Other navigation warnings choose Stay. Dialog text is never treated as instructions.

The handler runs independently of blocked page commands and is removed on
Stop, completion, or detach, even when Dev diagnostics retain the debugger.
A run whose start page the debugger cannot attach to, such as
chrome://extensions, or whose debugger connection drops, keeps its wish to
answer dialogs: the next debugger attach arms it, and each navigation and
history navigation arms it before dispatch and again on the page it reaches.
Stop while a navigation waits for that arming sends nothing. The person
cancelling the debugger ends it for the run.
Ask mode and idle tabs do not auto-answer dialogs. Already-observed dialogs are
resolved before startup commands. Dialogs opened before debugger attachment
may need manual dismissal. Startup responds to Stop and times out after five
seconds instead of holding the run indefinitely.
This does not handle browser permission requests, authentication windows, or
OS file pickers. Firefox WebExtensions provide no equivalent native-dialog API;
those dialogs still require manual handling in Firefox.

WebMCP is an experimental Chrome-only fast path that is on by default. The
user can disable **Experimental WebMCP** under Settings → Bridge;
when disabled, neither WebMCP tool schemas nor WebMCP prompt guidance enter model
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

When the API mutation observer is enabled and a repeated `click` /
`click_ax` loop is detected, `_detectApiShortcut()` checks the per-tab
webRequest buffer populated by `background.js`. The observer is on by default,
can be disabled in Settings, and stays disabled if its preference cannot be read
or contains a non-boolean value.
If each repeated click produced the same exact URL + HTTP method within a
3-second window, the loop warning includes a `fetch_url({url, method})`
suggestion. For replayable XHR/fetch mutations, the observer also keeps bounded
request bodies and a small allowlist of replay-safe headers behind an opaque
`replayRequestId`; hidden form tokens are reused internally by `fetch_url` only
for the same tab and origin, not printed into model context. Write methods are
authorized by the persistent **Always allow API mutations** setting (on by
default) or the conversation's `/allow-api` override. An unreadable persistent
setting grants no authorization. GET requests and non-network capabilities still
use the normal permission gate.

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
| Cloud Bridge socket | Offscreen document (`offscreen/cloud-bridge.js`) | Background page (`cloud-bridge.js`) |
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
| File upload | CDP path or `downloadId` | `downloadId` re-fetch or DIV file picker; no arbitrary local path |

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
- An unanswered `clarify` question follows Settings → Budgets → "When a question times out": finish the task (default) or play it safe. Questions about deletion, money, credentials, the recipient, or an unrequested publication always time out to the safe answer (see `docs/security-model.md`).
- The persistent **Always allow API mutations** setting (on by default) or the conversation's `/allow-api` override waives permission prompts for write-method `fetch_url` / `research_url` calls
- Tool results capped at 8 KB to limit prompt-injection surface
- `strictSecretMode` instructs the model not to quote credentials in summaries, redacts known credential values (including short numeric PIN/CVV values) out of everything a cloud run publishes, and fails closed to scalar redaction if its bounded secret registry fills
- Trace data is local-only (IndexedDB), never transmitted
- Offscreen proxy only forwards provider SDK traffic
- Finance adapters inject extra confirmation guidance

### Jev scheduled-task verification

Which decisions a decision model answers is resolved in one place:
`decision-config.js` maps the stored `decisionMode` (Auto, On, Off; a profile
from before modes with `systemOneEnabled` reads as On) to a configuration whose
`features` say which decisions it answers, and callers ask
`decisionFeatureEnabled(config, feature)`. `decision-availability.js` adds the
one thing Auto needs at run time, whether Ternary Bonsai 2 2B Vision is
downloaded (Chrome only; Firefox's copy never finds it).

The static decision-models card lives on the Decision tab of the Providers page
(`ui/providers.html#decision`), outside the dynamic provider list on the LLM tab.
It never participates in chat model selection. Old `settings.html#multimodal`
links open the Vision tab of the Providers page. `systemone-judge.js` owns the pinned HTTP contract,
strict typed responses and a shared deadline for retries. `systemone-evidence.js`
collects bounded allowlisted observations and invalidates them on page changes.
Scheduler evaluation returns keep/downgrade/skip plus metadata, revalidates the
execution after awaiting the response and never requeues a downgraded action.
The agent supplies the original run cost state and trace ID to the sidecar.
No evidence is written to additional diagnostic logs. Watch baselines alone
persist a bounded observation to support change comparisons after an actual
judgment. Skips leave the stored verdict and Jev baseline unchanged and do not
create verdict trace notes; billable responses still record usage. If the tab's
run changes during verification, the still-owned scheduler execution enters
reconciliation instead of remaining running. Post-response cost enforcement
rejects a judgment that crosses the allowance; an already sent request can
still incur charges.

### Experimental Jev decisions

`systemone-fast.js` produces existing tool calls, a fallback, or a completion
candidate. Separate default-off settings control read-scope/Ask-handoff
classification and Act/Dev browser decisions. The normal planner and intent
checks still precede the loop. Both streaming and non-streaming loops dispatch
Jev-selected calls through `_executeToolBatch`, including final submit/save/send
clicks. Ask cannot use this browser path.

The existing AX walk supplies at most 24 structured controls with its own refs;
page-authored ref strings are never parsed. Internal snapshots are stripped from
public tool results and diagnostics. Identity, document, form structure, options,
value and occlusion are checked again before dispatch. Frames, shadow roots,
unsupported actions and pages containing credential, payment, OTP or file controls
fall back as a whole. The request includes only operations that have observed
candidates and omits target questions that would contain only the `none` choice.
Field values come from
the active provider only after a confident fill action/target is selected. The
first uncached fill uses a second Jev request to map those prepared values;
clicks, completion candidates and fallbacks do not prepare text. Cached values
and queued independent writes avoid repeated preparation. Each write is
executed separately with a new observation. Labels must match the prepared
field purpose, and ambiguous labels fall back. Changed form/document context
invalidates queued writes and cached values.

Choice probability and confidence must both reach 85% for classifiers and 90%
for browser decisions. Each Jev request has one second and no retry. Errors or
low confidence fall back in the current step. Two fallbacks on the same observed
snapshot suspend further paid decisions until a new snapshot changes the
context. A malformed usage/model/answer response permanently stops Jev for that
run after the first response, even if the page changes, and the trace stores a
bounded reason code rather than the response. This suspension is separate from
the permanent run stop for unknown outcomes or no progress. Completion guidance is added only to the model's system
message copy, never to persisted user messages. Two unchanged observations after
Jev decisions disable the path for the rest of the run. Unknown outcomes and
denied/cancelled calls also disable it. Strict Secret Mode, offline connectivity,
run cancellation and model cost limits apply. `done` remains an active-model
operation using existing evidence checks. RAG, skill routing and direct watch
poll optimization are not part of this integration. See `test/jev/README.md` for
benchmark protocol and its unverified live-performance status.

An action such as a submitted search field can lose its original-document
verification while successfully navigating. When that result is successful,
verified, marked `outcomeUnknown`, and reports a real URL change, a later
successful read of the resulting URL can reconcile the generic plan-execution
counter. A read from before the action, a failed read, or a different document
cannot do so. This does not satisfy submit/send/publish/payment or site-workflow
terminal contracts; those still require their existing bound evidence.

Initial-page and automatic browser screenshots do not make the AX-only path
ineligible, and their pixels are never included in a Jev request. A current user
attachment, explicit screenshot-tool result or unknown non-text input routes that
decision to the active provider. The fast path may resume after that provider has
consumed the input. Trace exports render Jev routing, fallback and usage metadata,
including skip reasons, without exporting evidence.
