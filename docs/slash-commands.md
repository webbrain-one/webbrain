# Slash Commands

DIV accepts slash commands as the first thing on a line in the input box.
Type `/help` in the panel to see complete usage signatures and flag
descriptions. Typing a canonical command followed by a space opens autocomplete
for its available flags.

## Reference

| Command | What it does |
|---------|--------------|
| `/help` | Show the list of available commands |
| `/ask` | Switch to Ask mode before sending |
| `/act` | Switch to Act mode before sending |
| `/dev` | Switch to Dev mode before sending |
| `/plan` | Switch to Ask mode with planning intent |
| `/schedule [prompt]` | Create a scheduled task, optionally prefilling its prompt; a prompt that names one http(s) address targets that page instead of the open tab |
| `/schedule --list` | Show scheduled tasks |
| `/watch [--keep] [--secs <30-120>] [--long \| --short] <condition and action> [/beep]` | Poll the current page for a condition; stop after the first match unless `--keep` is set, and optionally play a background alert |
| `/progress` | Show the current progress ledger |
| `/btw [prompt]` | Open a quick side conversation |
| `/scratchpad` | Show the current scratchpad |
| `/scratchpad --append <text>` | Append text to the current scratchpad |
| `/scratchpad --clear` | Clear the current scratchpad |
| `/memory` | Show saved user memory |
| `/memory --add <text>` | Save a user preference to memory |
| `/memory --forget <id>` | Forget a saved memory by ID |
| `/workflow` | Open the saved-workflow manager with Run, Rename, Export, and guarded Delete actions |
| `/workflow --save <name>` | Compile the latest successful traced run into a reusable, value-free workflow |
| `/workflow --run <id>` | Run a saved workflow in Act mode, collecting any runtime parameters locally |
| `/workflow --delete <id>` | Delete a saved workflow |
| `/workflow --export <id>` | Download a sanitized portable `webbrain-workflow/1` JSON file |
| `/workflow --import --file` | Import a portable workflow file as a new local saved workflow |
| `/teach` | Show the current tab's Teacher mode status and captured action count |
| `/teach --start <name>` | Start learning a saved workflow from your demonstrated clicks and field edits |
| `/teach --end` | Stop teaching and compile the captured actions into a value-free saved workflow |
| `/allow-api` | **Per-conversation API mutation override.** See [below](#allow-api). |
| `/foreground [prompt]` | Run one local task in the foreground for visual compatibility |
| `/dangerously-skip-permissions` | **Global permission-prompt bypass.** Turns off `Ask before consequential actions` without opening Settings. DIV will act without per-site prompts until you re-enable the setting (the Permissions page, or the warning button next to the microphone in the side panel composer). |
| `/compact` | Force context compaction for the current conversation |
| `/verbose` | Toggle verbose/compact tool display |
| `/reset` | Clear the conversation and all per-conversation flags |
| `/print` | Open the current page's native print dialog |
| `/screenshot [--full-page]` | Capture the visible tab, or the full scrollable page with `--full-page` (Firefox requires the optional trusted-automation companion) |
| `/record [--full-screen] [--hide-recording-indicator] [--transcribe]` | Record the current tab, or a selected screen/window with `--full-screen` (Chrome only); add `--hide-recording-indicator` to hide the banner or `--transcribe` to save a transcript after stop |
| `/export [--traces [--full] \| --config]` | Download version-stamped conversation Markdown, export the version-stamped tool chain with `--traces`, add `--full` for the complete stored session JSON including screenshots, or export a Settings snapshot with `--config` |
| `/import <json>` | Import a Settings snapshot pasted inline |
| `/import --file` | Choose and import a Settings snapshot JSON file |
| `/profile` | Toggle profile auto-fill on/off without opening Settings |
| `/vision` | Toggle vision mode (screenshot understanding) on the active provider |

## Full-page screenshots on Firefox

Install the [local companion](../firefox-companion/README.md) and enable Firefox trusted automation in Settings before using `/screenshot --full-page`. The capture stays local until you attach it to a message, and Save as exports a PNG. It captures the currently loaded document, including content outside the viewport; it does not scroll to load an infinite feed. Very large pages return an explicit size error. If the privacy scan cannot verify stable sensitive-field geometry, the preview remains saveable but is not attached to the composer. Ordinary `/screenshot` needs no companion.

## `/watch`

`/watch` performs its first check immediately and then polls every 60 seconds by
default. `--secs` accepts 30–120 seconds.

Relative conditions such as "when a new commit appears" establish a baseline on
the first check; absolute conditions such as "when CI is green" can match
immediately.

A trailing `/beep` enables the watch-only alert tool; `--short` and `--long`
select its tone. Alerts play only after a verified successful action, and
`--keep` suppresses repeated alerts for the same stable event key. If a model
verifies the action but omits the optional alert tool, the watch records the
warning and completes or continues without sound.

Polls run in dedicated inactive tabs, so leaving the initiating page does not
navigate it back to the watched URL, and the helper tab is closed when the watch
ends. Transient poll failures are tolerated; three consecutive failures stop the
watch.

## `/foreground`

Regular local runs stay pinned to their original tab and operate without
activating that tab or focusing its window. Chrome captures through CDP with
focus emulation scoped to the run; Firefox captures the target tab directly
with `tabs.captureTab`. If Chrome repeatedly returns a blank background frame,
DIV discards it and continues from DOM and accessibility data.

Use `/foreground <prompt>` as a one-run compatibility escape hatch for a site
whose visual state does not render correctly in the background. It restores tab
activation and window focus for that run. The setting is not persistent, and
managed cloud runs retain their existing foreground behavior because their
browser is dedicated to the task.

## `/allow-api`

`/allow-api` lifts the UI-first restriction for the current conversation so the
agent may use POST/PUT/PATCH/DELETE via `fetch_url` or `research_url` when the UI
is failing. A badge appears while it is active, and it clears on `/reset`.

To keep the same policy active across conversations and browser restarts, turn
on **Always allow API mutations** under **Settings → Advanced**. The
setting is on by default and remains active until you turn it off. `/reset`
still clears the conversation-only `/allow-api` override, but does not change
the persistent setting.

The default UI-first rule exists because API actions are invisible (you don't
see what's being sent), often require separate auth tokens you may not have
configured, and can have a much larger blast radius than a visible mis-click.
Only use `/allow-api` when you've decided you want that tradeoff for a specific
job. See [security model](security-model.md#allow-api-flag).

## Run-capture suffixes

These are intentionally omitted from `/help` and autocomplete.

Append `/record [--save-as <filename>]` to the end of a normal prompt to start
recording the current tab immediately before the run, then stop and save the
WebM when that run settles (Chrome only).

Append `/screenshot [--save-as <filename>]` to save viewport screenshots
immediately before and after the run (Chrome and Firefox). For example,
`Test the checkout /screenshot --save-as checkout.png` saves
`checkout-before.png` and `checkout-after.png`; without `--save-as`, DIV
uses timestamped filenames.

For the Chrome diagnostic suffix, DIV may reactivate the originating run
tab before saving the after screenshot. Firefox captures that tab directly
without activating it. If the recording or initial screenshot cannot be
started and saved, the run is not sent. Standalone `/record` and `/screenshot`
keep their existing behavior.

## Exports, snapshots, and workflows

Full schemas and privacy properties for every export live in
[export and workflow formats](export-and-workflow-formats.md). The short
version:

- **Settings snapshots** use `webbrain-config/1` and include all portable
  Settings values, including provider, vision, transcription, and CapSolver API
  keys, profile data, user memory, custom skills, and permission choices. **The
  JSON is plaintext and should be stored securely.** Device-bound Cloud Sync
  sessions/device IDs, conversations, traces, scheduled jobs, usage counters,
  and accumulated spend are not exported.
- **Saved workflows** use a separate `webbrain-workflow/1` schema; they are not
  raw trace replays. Historical `ref_id` values, action CSS selectors,
  coordinates, query strings, fragments, and typed field values are excluded.
  Typed values become runtime parameters, and each action is bound to the
  recorded origin and URL family. At run time DIV resolves a fresh
  accessibility-tree target and executes through the normal Act permission,
  submit-confirmation, and verification gates. Ambiguous targets fail closed. If
  an action may already have happened but its result is unknown, replay stops
  instead of retrying it. Runtime parameter values are not saved to the
  workflow, conversation, user memory, replay trace, or Agent fallback prompt;
  they are still delivered to the target page by the requested browser action.
  The original opt-in source trace remains separate and can contain raw tool
  arguments until the user deletes that trace.
- If replay starts outside the saved origin or URL family, deterministic replay
  hands control to the Agent with the sanitized start scope so normal
  navigation, permission, and verification rules can recover the workflow
  instead of ending it immediately.
- **Portable workflow files** contain the raw sanitized `webbrain-workflow/1`
  definition and are limited to 1 MiB. Export re-normalizes the definition
  before download. Import normalizes it again, assigns a fresh local ID and
  timestamps, and never overwrites an existing workflow, so the same file can
  safely move between Chrome, Firefox, and DIV Cloud.

`/export --traces --full` uses the same versioned JSON format as the Traces page, without Markdown preview truncation or the 500-turn Markdown limit. It exports recorded data only: earlier recording omissions remain marked, and the panel reports when they exist. Content and screenshots follow the recording privacy setting; the command does not enable lossless recording retroactively. Essential solver outcomes remain available even when the lossless content budget fills.
