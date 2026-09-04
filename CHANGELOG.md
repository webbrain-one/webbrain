# Changelog

All notable changes to WebBrain are documented in this file.

This changelog was generated from the repository Git history and release tags. Versions without a Git tag are inferred from version-bump commits and the current `package.json` / browser manifest versions.

## [Unreleased]

### Added
- Added one Mid/Full-only, OTP-skill-gated email verification reader. It can inspect an already open signed-in supported webmail tab, directly scope an already-open message across all supported providers, and, when needed, open one opaque inspected inbox item in a temporary inactive duplicate that is always closed. Candidate disclosure requires the full normalized service identity or all sufficiently discriminative service tokens. Ask remains read-only; opening requires Act/Dev plus mailbox-host click permission because it may mark mail read, and it dispatches only against the one-use authorization that gate issues. Mailbox list and pagination routes are never treated as an open message, a tab that navigates off the mailbox is never read, and a stop during a read still ends the run. Message continuations are consumed within hard bounds or fail closed, and the model receives no general tab catalog, tab switch, mailbox URL, or internal accessibility reference.

### Removed
- Removed model-callable browser tab creation, listing, and activation from every prompt tier. URL readers and current-tab navigation remain available; internal research/helper tabs and normal `target=_blank` behavior are unchanged.

### Fixed
- Added a final max-step handoff for tool-capable interactive runs, including WebBrain Compass: after the normal loop exhausts its configured steps, one context-only turn exposes only `done(outcome: "partial" | "failed")` so collected evidence reaches the user. Invalid terminal output falls back to a visible deterministic blocker. The existing advisory 4/8 observation checkpoints for Compass and the structured Cloud `done_json` contract are unchanged.
- Reserved the retired tab-tool names, so an enabled custom skill can no longer re-declare `new_tab`, `list_tabs`, or `activate_tab` and hand the model back a capability the prompts say it does not have.
- Gave Ask mode its own wording for the browser-tab limitation. The shared text offered current-tab navigation, which read-only Ask cannot perform; it now offers to read the URL or to switch to Act.
- Retuned the LLM benchmark goldens that still expected retired tools, so a model running against the current schemas is no longer scored wrong for answers it cannot give. `test/run.js` now fails when any golden or seeded turn names a tool its own mode does not offer.
- Relabelled the `csp-blocked-eval` scenarios (and scenario 020) as Dev. They replay a CSP-rejected `execute_js`, which ships only in Dev, so an Act history was showing the model a tool that surface never gave it.
- Added a `skipped` verdict to the scenario harness. A scenario whose mode has no payload at the tier under test is reported as skipped instead of erroring, sends no request, and stays out of the safety and regrade denominators.

## [34.1.6] - 2026-09-04

### Changed
- Packaged the current extension fixes for browser stores.

## [34.1.4] - 2026-09-03

### Changed
- ui: use a globe for the language switcher and group the header prefs
- ui: make the sidepanel language switcher a plain header icon
- version up
- build(deps): bump the npm_and_yarn group across 1 directory with 2 updates

## [34.1.2] - 2026-09-02

### Changed
- Return only known fields from a failed OTP open
- Fail closed on ungated OTP opens and Gmail list routes
- fix: abort source-bound helper tabs when sidebar Stop is pressed
- Gate OTP message opens and complete reads
- Reject Gmail search listings as messages
- Harden OTP mailbox message matching
- Add skill-gated OTP mailbox reader
- fix: give Ask mode a read-only fallback for tab requests
- test/llm: report inapplicable scenarios as skipped, not errors
- test/llm: validate goldens per declared surface, not a union
- fix: reserve retired tab-tool names; score /screenshot for case 065
- docs(test/llm): stop hardcoding a tool count that rots
- test/llm: update benchmark goldens for removed tab tools
- Remove browser tab management tools
- dist: rebuild submission zips for v34.1.1
- chore: release v34.1.1
- docs: added

## [34.1.1] - 2026-09-02

### Changed
- docs: added
- dist: rebuild submission zips for v34.1.0
- chore: release v34.1.0
- 34.0.0
- fix: migrate stored Compass provider label
- fix: keep Compass name unlocalized
- feat: rename managed provider to WebBrain Compass
- feat(sidepanel): refine empty conversation state
- feat(sidepanel): consolidate conversation controls
- fix(opencode): scope Zen migrations and model normalization
- Improve selected-text localization and run details
- fix(ui): correct zoom compensation in sidepanel scale
- fix(opencode): Zen muse-spark-1.2-contributor-free Responses routing
- fix(ui): address review findings on sidepanel scale controls
- Verify the booking that was paid for, and the values a form was given
- Group custom ARIA radios, and stop counting readonly controls
- Settle window-based evidence after the window is recorded
- Carry a consumed form upload across Continue, and require a real activator
- Reread a form after an upload, and name the video on every YouTube route
- Bind every transcript window to its video, and resolve requested labels first
- Let the last diff window close coverage, and keep in-place wizard rows
- Close the diff from a root read only, and stop counting disabled controls
- fix(ui): render scale only after persist and compensate zoom width
- Close the diff only from an exhaustive reader, in its own coordinates
- Treat an unanswered field classifier as inconclusive, and read the whole diff
- Carry transcript and release-asset evidence across Continue
- Scope thread coverage and drafts, state native optionality, archive iframe steps
- fix(i18n): translate sidepanel scale labels
- fix(ui): harden sidepanel scale behavior
- Keep visually replaced native controls in the form inventory
- Bind deferred replies to their thread, tighten label matching, keep ids stable
- Chain transcript windows, prove empty comments, bound collections
- feat(ui): add configurable scale shortcuts
- feat(ui): add sidepanel scale controls
- feat(ui): persist sidepanel scale preference
- feat(ui): add sidepanel scale model
- Bind each job's evidence to its own resource and stop trusting bare rows
- Read the count tool's real fields, check transcript coverage, allow empty sets
- Invalidate the mutated iframe, and give every non-submit job a contract
- Fail prepare-only jobs that submit, and hold read jobs to their contract
- Keep hidden file inputs and match requested fields on content words
- Keep page-text lines and let iframe-only inventories verify their submit
- Keep finished wizard steps, thread replies, and hidden iframe fields honest
- Pin open-thread drafts, read localized resolve controls, drop hidden fields
- Bind form confirmations to their form and keep requested optional rows
- Rebuild paginated inventories on page one and keep body line structure
- Match requested send bodies and bind release assets to their release
- Hand draft addressees to the guard and rebuild branched form inventories
- Bind draft addressees and let an empty thread inventory finish
- Keep short-frame iframe rows and bind drafts to authorized field values
- Verify Gmail drafts and subjects, and page large iframe inventories
- Re-route the site workflow after substantive plan steps edits
- Preserve form inventory on submit, exact publish payload, and 16 Gmail recipients
- Refresh form inventories after value mutations in workflow tests.
- Stale form inventories after successful value-driven mutations.
- Resolve Gmail inline-reply recipients from the enclosing reply container.
- Bind simulated workflow evidence to the current task key in tests.
- Bind publish success to requested payload and allow empty thread inventories.
- Keep live workflow contracts after plan wording edits.
- Escape AX inventory values before quoting them.
- fix: restore Ask-streaming copy in 10 locales after mojibake
- Stop inferring optional fields and keep lone failed frames incomplete.
- Clamp card-wide max output tokens to the selected model's ceiling.
- test: guard zh Ask-streaming copy against mojibake regression
- fix: restore Chinese Ask streaming copy
- Localize max output tokens setting label
- Use cost-aware OpenAI context default
- Configure OpenAI and Anthropic model limits
- Make provider model limits configurable
- Tighten metadata readback and iframe completeness after review.
- Tighten Compact workflow contract under the brief-length budget.
- Shrink Compact workflow prompts and stop evidence false positives.
- Bound form-workflow inventory to a v1 evidence kernel.
- Keep runtime notices out of the execution task binding
- fix: require exhaustive workflow evidence
- fix: bind fulfillment to dispatched records
- fix: verify consumed uploads after observation
- Bind recipient clarifications to send tasks
- fix: retain post-action workflow evidence
- Preserve clarified tasks across restart
- Distinguish runtime blockers from task results
- fix: bind workflow evidence to live controls
- Preserve repeated clarification context
- Keep clarification answers bound to tasks
- fix: close iframe inventory gaps
- fix: bind workflow completion to exact outcomes
- Keep WebBrain Cloud observation checkpoints advisory
- Harden execution task authority
- fix: enforce complete workflow reconciliation
- fix: bind workflow targets to exact evidence
- fix: preserve workflow inventory coverage
- fix: bind exact messaging and publish targets
- fix: defer scoped workflow evidence
- fix: enforce reachable workflow evidence
- fix: handle asynchronous workflow evidence
- fix: bind terminal workflow evidence
- fix: stabilize workflow reconciliation
- fix: complete adapter form inventories
- dist: rebuild submission zips for v33.6.0
- chore: release v33.6.0
- Restore default compact activity history
- Encode Exacto as an OpenRouter model variant
- fix: address adapter workflow review findings
- Preserve OpenRouter model variants when routing
- Sync routing after loaded model selection
- Add OpenRouter routing variant controls
- p1 fixes
- feat: add DeepSeek provider support and update compatibility handling
- feat: add report-driven adapter workflows
- Allow honest exit after failed verification
- Preserve honest completion when verification is unavailable
- Harden scoped completion observations
- Coordinate completion recovery with runtime gates
- Keep forced completion active through validation
- Keep completion recovery scope across retries
- Fix background-tab completion verification
- Fix post-navigation completion recovery
- Add DeepSeek V4 Flash Vision benchmark post
- version 33.5.0
- Localize activity status messages
- Improve agent activity status display
- dist: rebuild submission zips for v33.4.1
- chore: release v33.4.1
- Fix selected-text chat actions
- Update social proof artwork
- Fix attention favicon flashing on dynamic sites
- dist: rebuild submission zips for v33.4.0
- chore: release v33.4.0
- Bind recurring planner notices to latest run
- Fix scheduled planner fallback notice race
- Fix planner fallback notice placement
- Keep MCP naming consistent across docs
- version up
- fix: keep shadow_dom_query selector guard on the real code
- fix: preserve selector no-click proof
- fix: make iframe marker cleanup nonblocking
- fix: defer iframe dispatch marking
- fix: keep focus-only iframe expiry retryable
- fix: release expired fallback gestures
- fix: stop late fallback page mutations
- fix: release fallback keys after deadline
- fix: guard fallback input dispatch deadlines
- fix: recheck deadlines after click validation
- fix: stop expired accessibility clicks
- fix: carry deadlines into page mutations
- fix: prevent actions after page deadlines
- Add Qwen3.8 and GLM-5.3 Flash benchmarks
- fix: reject late page mutations
- fix: guard queued selector focus
- fix: prevent late selector focus
- fix: link coordinate reconciliation deadlines
- fix: release timed-out CDP key presses
- fix: bound Firefox file upload injection
- fix: bound Chrome file upload actions
- fix: close preflight review gaps
- fix: bound pre-dispatch page probes
- Fix top-edge selection shortcut fallback
- fix: bound pending toolbar probes
- fix(ui): reflow selected-text scope banner
- fix: bound preflight and validation pipeline
- Refine selected-text chat shortcut
- fix: bound primary Chrome click pipeline
- fix: cancel late dispatch pipelines
- fix: stop late clear and classify click timeouts
- fix: bound early CDP action pipelines
- fix: bound action observation pipelines
- fix: bound click progress snapshots
- fix(agent): secure Gmail result counting
- fix: cancel expired trusted mouse press
- fix: cancel timed-out action recovery
- fix: bound trusted field recovery
- fix(agent): narrow search-field unsaved exemption
- fix: bound coordinate click reconciliation
- fix(agent): distinguish Gmail probe failures from page bounds
- ui: compact sidebar header actions
- fix: bound post-dispatch action completion
- fix(agent): harden Gmail result counting and coordinate clicks
- fix: cover accessibility clicks with action deadlines
- fix: recover stalled page actions
- dist: rebuild submission zips for v33.3.0
- chore: release v33.3.0
- feat(selection): add immediate broader context option
- docs: remove Product Hunt link from readme
- refactor(selection): simplify grounding controls
- fix(ui): refine scope and provider guidance
- Add EasyCLIProxy subscription guide
- fix(ui): add Unsloth provider icon
- version up
- version up
- fix(trace): preserve private workflow compilation
- docs(chat): scope trace privacy claims precisely
- fix(chat): reject busy scope restore races
- fix(chat): disable scope restore while busy
- fix(chat): describe selection scope recovery accurately
- fix(chat): disclose full selection scope restore
- fix(chat): describe selection scope recovery accurately
- fix(chat): disclose full selection scope restore
- fix(chat): disclose full selection scope restore
- docs(trace): clarify metadata-only retention
- fix(chat): bound safe selection dialogue context
- fix(unsloth): list only resident models
- fix(chat): bound safe selection dialogue context
- fix(chat): bound safe selection dialogue context
- fix(chat): bound safe selection dialogue context
- docs(chat): clarify selection trace privacy and verification
- docs(chat): wrap scope trace note
- docs(chat): verify selection context contract
- fix(chat): offer scope recovery for strict selections
- fix(chat): explain selection reference recovery
- feat(chat): expose selection context controls
- fix(chat): preserve safe dialogue across selections
- fix(trace): preserve redacted outcome metadata
- feat(providers): add Unsloth Studio integration
- Migrate stored catalog vision flags when the default model did not change.
- Enable vision on catalog defaults whose models already match the detector.
- Avoid rewriting unchanged provider snapshots on every load.
- Persist migrated provider snapshots when Settings is not saved.
- Migrate stored context windows with untouched default models.
- Migrate untouched stored provider defaults and enable StepFun vision.
- Update router and local open-source model lists to current API IDs.
- Update cloud provider model lists to current API IDs.
- fix: avoid 64 MiB sendResponse limit in /record slashcommand
- Add step-limit edge case test for completion recovery
- Fix step-limit edge case: emit partial when recovery exhausts budget
- Relax completion recovery: 2 retry turns and 12k output cap
- feat(trace): enforce metadata-only default privacy
- Add Muse Glimmer benchmarks and blog post
- fix(trace): preserve stats when repairing interrupted runs
- Bound structured completion recovery
- Rename Chromium bridge setting to MCP
- Version up
- fix: scope YouTube loop recommendation
- feat: add YouTube video loop suggestion
- docs: expand MCP client integrations
- test(trace): close OTLP contract coverage gaps
- test(trace): cover OTLP collector contract
- fix(trace): complete session export compatibility
- feat(trace): export conversation trace bundles
- fix(trace): harden OTLP compatibility normalization
- feat(trace): add session-aware OTLP export compatibility
- dist: rebuild submission zips for v33.2.1
- chore: release v33.2.1
- fix: keep ordinary clarification independent of research
- fix: diagnose empty model responses
- dist: rebuild submission zips for v33.2.0
- chore: release v33.2.0
- fix: read release context via jq --rawfile in AI changelog step
- dist: rebuild submission zips for v33.1.7
- chore: release v33.1.7
- fix(settings): treat seeded local API key sentinels as empty
- dist: rebuild submission zips for v33.1.6
- chore: release v33.1.6
- feat(trace): add session lineage navigation
- feat(providers): support optional local API keys
- mark tech post
- Version up
- feat(web): use real brand icons on homepage
- Version up
- fix: survive background throttling in completion attention flash
- fix(progress): require identity agreement for hydration batch merges
- fix: blink favicon itself on completion attention flash
- fix(progress): preserve canonical collected fields during hydration repair
- feat(trace): add session statistics aggregation
- Preserve capped trace request metadata
- Keep trace markers past lossless cap
- Retry unaccepted claimed prompts
- Retry prompts after cleanup failures
- Count escaped trace result bytes
- Clamp lossless traces by UTF-8 bytes
- Preserve newer lossless byte totals
- Persist lossless event totals atomically
- Skip migrated lossless rescans
- Serialize trace run finalization
- Rotate failed-clear recovery tokens
- Guard failed-clear scope recovery
- Migrate trace totals before cap checks
- Refresh migrated active trace totals
- Serialize aggregate lossless scans
- Serialize lossless byte migration
- Migrate lossless trace byte totals
- Requeue attachments after failed clears
- Suppress recovered follower cancellation errors
- Settle failed-clear recovery queues
- Restore cache before durable rollback
- Cancel only active run followers
- Wait for followers before plan recovery
- Drain prompts after reset clears
- Preserve lossless cache on clear failure
- Preserve prompts created during conversation clears
- Revalidate queued prompt drain targets
- fix(progress): strip action prefixes before colon delimiters
- Preserve screenshots when clears fail
- Honor clear cancellation after state replay
- fix: persist explicit success verdicts for scheduled Ask runs
- Recover active runs after failed clears
- fix: classify successful scheduled Ask runs for badge styling
- fix: pair badge fallback with a system notification
- Rollback conversation clears on scheduler failure
- fix: flash scheduled runs that require clarification
- fix(progress): harden auto identity checks in ledger reconciliation
- fix: reject billing terminals in Ask badge classification
- Make conversation clear storage atomic
- more test vision results
- fix: use exact done predicate for Act badges and cover all run paths
- test: track vision benchmark results and stop ignoring test/vision/results
- blog: compare six budget Qwen vision models on OpenRouter
- blog: compare six budget Qwen vision models on OpenRouter
- Make failed conversation clears recoverable
- fix: preserve run outcome in background flashes and export flash setting
- Clear durable prompts within conversation reset
- fix: own all attention flashes in the background lifecycle
- Reconcile repeated-item progress placeholders
- Keep reset queues stopped after partial clear
- fix: trigger scheduled flashes from the background
- Prevent stale run adoption after clear
- fix: clean cancelled screenshot recovery
- fix: clear focused-window badges without volatile tracking
- fix: scope queue drains and SSE heartbeats
- fix: address sixth review round on completion tab flash
- fix: preserve prompt and route identity
- fix: address fifth review round on completion tab flash
- fix: close conversation clear state races
- fix: address fourth review round on completion tab flash
- fix: resume queues after failed conversation clear
- fix: address third review round on completion tab flash
- fix: guard restored-run clear races
- fix: address second review round on completion tab flash
- fix: preserve typing identity through load completion
- fix(trace): close trajectory rows for unlisted terminal end statuses
- fix: harden issue 300 edge cases
- fix: address review notes on completion tab flash
- feat: flash finished tab when user switched away
- Fix Gmail complete-thread read loops
- feat(trace): add step trajectory table
- highlights
- google featured
- dist: rebuild submission zips for v33.1.1
- chore: release v33.1.1
- 33.1.0
- Add WebBrain VL 2 benchmark blog posts
- webbrain-vl-2-450m
- fix(trace): gate lossless eviction on a cached total and scan all runs
- fix(trace): redact recovery_code in JSON exports and refresh lossless tier pins
- fix(trace): close repair races and bound the stale-run scan
- fix(trace): protect runs with recent durable activity
- fix(trace): scan stale runs once when traces opens
- fix(trace): repair runs interrupted by service-worker eviction
- fix(trace): evict oldest lossless runs within budget
- fix(trace): redact lossless JSON exports and serialize recovery
- Count the Emergency Box among the Apocalypse Mode essentials
- Sign the Apocalypse Mode pages with the WebBrain mark
- Add the WebBrain logo to the Traces header
- added logo to settings and history.html
- Restore the Apocalypse Mode nuclear emoji at its source and fix two broken tests
- footer tightened
- cosmetic changes
- Fix Cloud runtime outbox delivery
- Add durable terminal runtime outbox
- docs: fix vision benchmark GitHub link
- test: add vision benchmark and model comparison
- fix(trace): address lossless tier review findings
- fix(trace): preserve lifecycle event integrity
- feat(trace): opt-in lossless recording tier sharing the event pipeline
- feat(trace): turn/step boundary events with structured failure codes
- fix(trace): preserve derived run lineage
- feat(trace): plumb parent lineage from cloud_run and replay entry points
- feat(trace): add session lineage fields and DB v2 lookup indexes
- feat(trace): add event model with run-level format version and tolerant read path
- refactor(ui): share schedule message reconciliation
- fix(ui): reconcile schedule confirmations
- fix(ui): deduplicate scheduled job messages
- dist: rebuild submission zips for v33.0.8
- chore: release v33.0.8
- fix: resume vision downloads and organize settings
- fix: require vision cache marker and isolate queued worker deadlines
- fix: verify local vision cache and abort timed-out remote vision
- fix: preflight mixed attachments and preserve queued vision stop
- dist: rebuild submission zips for v33.0.7
- chore: release v33.0.7
- feat: make research escalation explicit opt-in
- fix: reject staged screenshots without vision route
- fix: make screenshot vision explicit and bounded
- fix: close research escalation consent races
- fix: bound actionable discovery resets
- fix: preserve progress at observation limit
- fix: keep long ChatGPT research answers as valid JSON
- fix: ignore null research mappings and abort closed source tabs
- fix: keep research mapping out of ordinary side-panel tabs
- fix: stop research wait when the ChatGPT tab closes
- fix: cancel research wait when ChatGPT helper tab closes
- fix: treat ChatGPT stop-button test id as generating
- fix: keep research Stop on the source run
- dist: rebuild submission zips for v33.0.6
- chore: release v33.0.6
- fix: recheck ChatGPT origin before research submit
- dist: rebuild submission zips for v33.0.5
- chore: release v33.0.5
- fix: prevent duplicate extension manifests
- fix: expose research consent in ask mode
- feat: add consent-gated research escalation
- dist: rebuild submission zips for v33.0.4
- chore: release v33.0.4
- dist: rebuild submission zips for v33.0.3
- chore: release v33.0.3
- test: keep Wikipedia translation assertion with its call
- fix(offline): skip personal non-English tasks and prefer the selected source language
- fix(offline): keep prior-turn language for Wikipedia follow-ups
- dist: rebuild submission zips for v33.0.2
- chore: release v33.0.2
- fix(offline): detect Wikipedia language from the original direct query
- fix(offline): skip disabled Wikipedia translation and disambiguate shared scripts
- Keep Clarify open while typing
- fix(offline): detect Wikipedia translation language from the resolved query
- Handle streamed WebBrain quota limits
- fix(offline): disambiguate Han queries and reject non-string translations
- Address WebBrain Plus review feedback
- fix(offline): tighten multilingual Wikipedia retrieval routing
- web: add an Apocalypse Mode video popup under Install WebBrain
- Add WebBrain Plus upgrade prompt
- fix(offline): restore script-based query language hints
- dist: rebuild submission zips for v33.0.1
- chore: release v33.0.1
- test: allow GPL licensing checks after version bumps
- Improve multilingual offline Wikipedia retrieval
- web: make the Downloads FAQ a full-block link and publish the GPL 33 note
- fix(chrome): stop sibling status polls from migrating Bonsai
- fix(chrome): keep Emergency Box open when switching Minimal and Basic
- test: update WebGPU text model label expectations
- fix(settings): serialize model-load saves
- fix(settings): ignore stale model list responses
- fix(ui): name Minimal and Basic as text models in download boxes
- fix(apocalypse): deduplicate corpus download starts
- fix(offline-rag): keep emergency text pack status stable during extraction
- fix(chrome): preserve CDP lifecycle ownership
- fix(oauth): deduplicate subscription token refreshes
- fix(chrome): make debugger teardown race-safe
- test(chrome): cover debugger cleanup on run errors
- fix(chrome): release debugger sessions after runs

## [34.1.0] - 2026-09-01

### Added
- Refined the sidepanel empty conversation state and consolidated conversation controls.

### Changed
- Renamed the managed provider to **WebBrain Compass** (branding update).
- Updated Compass provider label migration to match the new Compass naming.
- Kept Compass name unlocalized to preserve consistent display across locales.

### Fixed
- Scoped Zen migrations and model normalization to avoid unintended side effects.
- Improved selected-text localization and run details.

### Tests
- Updated/added LLM/vision benchmark fixtures and snapshots used by the test suite (including OpenRouter-related scenarios).

## [33.6.0] - 2026-08-28

### Added
- Added OpenRouter routing variant controls, including support for encoding **Exacto** as an OpenRouter model variant

### Changed
- Restored the **default compact activity history** behavior
- Preserved OpenRouter model variants when routing, and synced routing after loaded model selection (Chrome + Firefox)
- Updated provider compatibility handling for DeepSeek support

### Fixed
- Improved completion recovery behavior around verification availability:
  - Allowed honest exit after failed verification
  - Preserved honest completion when verification is unavailable
  - Hardened scoped completion observations and recovery across retries
  - Fixed background-tab completion verification and post-navigation completion recovery

### Tests
- Added/updated OpenRouter routing and DeepSeek-related benchmark fixtures/snapshots (including DeepSeek V4 Flash Vision)

## [33.5.0] - 2026-08-27

### Added
- Added versioned site-workflow contracts for high-evidence GitHub, Product Hunt, Microsoft Forms, Gmail, LinkedIn, YouTube, 12306, Douyin, NaukriGulf, Greenhouse, and Workday tasks (Chrome + Firefox)
- Added semantic planner routing through app-owned `site_job` IDs and content-free adapter/job/revision trace metadata
- Added content-free `adapter_match` trace metadata for notes-only and structured adapters, plus live-UI-verified AdSense and SofaScore guidance without promoting either to a workflow contract

### Changed
- Redesigned the sidebar loading and thinking UI with clearer live activity updates and a toggleable compact activity history (Chrome + Firefox)
- Localized the new activity statuses and improved screen-reader announcements across all supported languages
- Tightened selected site-workflow completion: live-URL binding survives trusted continuation only on the same adapter/job, the executor receives the app-owned stages/evidence contract, submission success needs job-bound terminal evidence (including paid/ticket-issued transaction state and recipient-bound sent confirmation), and ledger-backed workflows need exact reconciliation against an app-owned inventory rather than model-created rows
- Bounded form-workflow inventory v1: exhaustive root reads must not be depth-truncated on includable descendants, skipped required rows cannot prove success (optional `required: false` rows may skip), and checkbox/Next actions stale completeness until a fresh root read

### Fixed
- Compact selected-workflow prompts now inject a brief execution contract and a shorter `progress_update.workflowReconciliation` schema; Mid/Full keep the full contract
- YouTube `update-metadata` verification matches AX-truncated values via prefix plus `value_len`/`value_fp` after the same NFKC normalization used by verification, and values that equal the accessible name
- AX inventory `value=` tokens escape backslash then quote, and inventory readback restores the app-owned string
- Unknown metadata field names no longer discard the rest of the requirement list, but discarded classifier fields keep saved-state verification incomplete; playlist plural aliases are recognized
- Form inventory emits `required=` only for explicit native/`aria-required` state, ignores decorative DOM depth, and omits erroring/empty third-party frames only when another frame already inventoried form controls; a lone failed cross-origin application frame stays incomplete
- Reviewed plan wording edits re-resolve the live site-workflow contract instead of dropping it, and ARIA `searchbox` controls enter the form inventory
- GitHub, LinkedIn, and Douyin publish success now requires the classifier-bound tag, title, notes, body, or visibility on the published resource, not only a re-observed URL
- A complete empty GitHub `resolve-review-threads` inventory can reconcile as a no-op when no unresolved threads exist
- Gmail inline thread replies resolve To/Cc/Bcc chips from the enclosing reply container when the composer is not inside a dialog or form
- Successful `type_ax`, `set_field`, and `iframe_type` mutations stale a complete form inventory so value-driven branching cannot reconcile against the prior snapshot
- Form workflow reconciliation completeness is preserved across final submit actions so post-submit confirmation navigation can complete successfully
- Publication workflow field verification checks exact resource lines and blocks instead of unanchored substrings
- The Gmail recipient probe returns up to 16 candidates to match the schema and guard capacity

## [33.4.1] - 2026-08-27

### Changed
- Fix selected-text chat actions
- Update social proof artwork
- Fix attention favicon flashing on dynamic sites

## [33.4.0] - 2026-08-27

### Added
- Added Qwen3.8 and GLM-5.3 Flash benchmarks (OpenRouter) to the benchmark suite

### Changed
- Kept MCP naming consistent across docs (Chrome + Firefox)

### Fixed
- Fixed scheduled planner fallback notice timing issues (race + placement), improving reliability of fallback guidance
- Bound recurring planner notices to the latest run to prevent stale notices from showing
- Hardened planner fallback and action pipelines against late mutations:
  - Prevented actions after page deadlines
  - Released fallback keys after deadline
  - Stopped late fallback page mutations and expired fallback gestures
  - Guarded fallback input dispatch deadlines and rechecked deadlines after click validation
- Improved iframe marker cleanup and dispatch timing to avoid blocking and late dispatch behavior
- Fixed focus/selector handling by preventing queued selector focus and late selector focus
- Bounded Firefox and Chrome file upload injection actions to avoid runaway retries
- Fixed CDP key press release after timeout
- Preserved selector “no-click proof” behavior and ensured selector guard logic stays on the real code
- Fixed top-edge selection shortcut fallback behavior
- Fixed planner fallback gestures and accessibility click expiry handling
- Kept MCP naming consistent across docs (Chrome + Firefox)

### Tests
- Added/updated benchmark fixtures and result snapshots for Qwen3.8 Flash and GLM-5.3 Flash (OpenRouter)

## [33.3.0] - 2026-08-26

### Added
- Immediate broader context option for selection (Chrome + Firefox)

### Changed
- Simplified selection grounding controls and refined scope/provider guidance
- Updated selection context controls to improve how selection scope is exposed and recovered
- Added EasyCLIProxy subscription guide
- Added Unsloth provider icon and improved Unsloth model listing (resident models only)

### Fixed
- Preserved private workflow compilation during trace handling
- Prevented selection scope restore races by rejecting busy restore and disabling scope restore while busy
- Improved selection scope recovery messaging and disclosure of full selection scope restore
- Bounded safe selection dialogue context to avoid over-expanding selection context
- Preserved redacted outcome metadata in traces
- Fixed trace privacy/retention messaging and clarified metadata-only retention
- Fixed busy scope restore race conditions in chat selection context continuity

### Tests
- Added/updated vision benchmark fixtures and expectations used by the test suite

## [33.2.1] - 2026-08-23

### Changed
- fix: keep ordinary clarification independent of research
- fix: diagnose empty model responses

## [33.2.0] - 2026-08-23

### Added
- Session lineage navigation in Traces (Chrome + Firefox)

### Changed
- Support optional local API keys for providers (Chrome + Firefox)
- Improve release-context handling in the AI changelog step (prevents missing/incorrect context during release generation)

### Fixed
- Treat seeded local API key sentinels as empty (Chrome + Firefox)

### Tests
- Added/updated vision benchmark fixtures and expectations used by the test suite

## [33.1.7] - 2026-08-23

### Changed
- fix(settings): treat seeded local API key sentinels as empty
- feat(trace): add session lineage navigation
- feat(providers): support optional local API keys

## [33.1.6] - 2026-08-23

### Changed
- mark tech post
- Version up
- feat(web): use real brand icons on homepage
- Version up
- fix: survive background throttling in completion attention flash
- fix(progress): require identity agreement for hydration batch merges
- fix: blink favicon itself on completion attention flash
- fix(progress): preserve canonical collected fields during hydration repair
- feat(trace): add session statistics aggregation
- Preserve capped trace request metadata
- Keep trace markers past lossless cap
- Retry unaccepted claimed prompts
- Retry prompts after cleanup failures
- Count escaped trace result bytes
- Clamp lossless traces by UTF-8 bytes
- Preserve newer lossless byte totals
- Persist lossless event totals atomically
- Skip migrated lossless rescans
- Serialize trace run finalization
- Rotate failed-clear recovery tokens
- Guard failed-clear scope recovery
- Migrate trace totals before cap checks
- Refresh migrated active trace totals
- Serialize aggregate lossless scans
- Serialize lossless byte migration
- Migrate lossless trace byte totals
- Requeue attachments after failed clears
- Suppress recovered follower cancellation errors
- Settle failed-clear recovery queues
- Restore cache before durable rollback
- Cancel only active run followers
- Wait for followers before plan recovery
- Drain prompts after reset clears
- Preserve lossless cache on clear failure
- Preserve prompts created during conversation clears
- Revalidate queued prompt drain targets
- fix(progress): strip action prefixes before colon delimiters
- Preserve screenshots when clears fail
- Honor clear cancellation after state replay
- fix: persist explicit success verdicts for scheduled Ask runs
- Recover active runs after failed clears
- fix: classify successful scheduled Ask runs for badge styling
- fix: pair badge fallback with a system notification
- Rollback conversation clears on scheduler failure
- fix: flash scheduled runs that require clarification
- fix(progress): harden auto identity checks in ledger reconciliation
- fix: reject billing terminals in Ask badge classification
- Make conversation clear storage atomic
- more test vision results
- fix: use exact done predicate for Act badges and cover all run paths
- test: track vision benchmark results and stop ignoring test/vision/results
- blog: compare six budget Qwen vision models on OpenRouter
- blog: compare six budget Qwen vision models on OpenRouter
- Make failed conversation clears recoverable
- fix: preserve run outcome in background flashes and export flash setting
- Clear durable prompts within conversation reset
- fix: own all attention flashes in the background lifecycle
- Reconcile repeated-item progress placeholders
- Keep reset queues stopped after partial clear
- fix: trigger scheduled flashes from the background
- Prevent stale run adoption after clear
- fix: clean cancelled screenshot recovery
- fix: clear focused-window badges without volatile tracking
- fix: scope queue drains and SSE heartbeats
- fix: address sixth review round on completion tab flash
- fix: preserve prompt and route identity
- fix: address fifth review round on completion tab flash
- fix: close conversation clear state races
- fix: address fourth review round on completion tab flash
- fix: resume queues after failed conversation clear
- fix: address third review round on completion tab flash
- fix: guard restored-run clear races
- fix: address second review round on completion tab flash
- fix: preserve typing identity through load completion
- fix(trace): close trajectory rows for unlisted terminal end statuses
- fix: harden issue 300 edge cases
- fix: address review notes on completion tab flash
- feat: flash finished tab when user switched away
- Fix Gmail complete-thread read loops
- feat(trace): add step trajectory table
- highlights
- google featured

## [33.1.1] - 2026-08-22

### Changed
- Reconcile planner expected-item placeholders with classifier and concrete progress rows, preserving one ordered canonical row per repeated-task target across Chrome, Firefox, and restored sessions.
- 33.1.0
- Add WebBrain VL 2 benchmark blog posts
- webbrain-vl-2-450m
- fix(trace): gate lossless eviction on a cached total and scan all runs
- fix(trace): redact recovery_code in JSON exports and refresh lossless tier pins
- fix(trace): close repair races and bound the stale-run scan
- fix(trace): protect runs with recent durable activity
- fix(trace): scan stale runs once when traces opens
- fix(trace): repair runs interrupted by service-worker eviction
- fix(trace): evict oldest lossless runs within budget
- fix(trace): redact lossless JSON exports and serialize recovery
- Count the Emergency Box among the Apocalypse Mode essentials
- Sign the Apocalypse Mode pages with the WebBrain mark
- Add the WebBrain logo to the Traces header
- added logo to settings and history.html
- Restore the Apocalypse Mode nuclear emoji at its source and fix two broken tests
- footer tightened
- cosmetic changes
- Fix Cloud runtime outbox delivery
- Add durable terminal runtime outbox
- docs: fix vision benchmark GitHub link
- test: add vision benchmark and model comparison
- fix(trace): address lossless tier review findings
- fix(trace): preserve lifecycle event integrity
- feat(trace): opt-in lossless recording tier sharing the event pipeline
- feat(trace): turn/step boundary events with structured failure codes
- fix(trace): preserve derived run lineage
- feat(trace): plumb parent lineage from cloud_run and replay entry points
- feat(trace): add session lineage fields and DB v2 lookup indexes
- feat(trace): add event model with run-level format version and tolerant read path
- refactor(ui): share schedule message reconciliation
- fix(ui): reconcile schedule confirmations
- fix(ui): deduplicate scheduled job messages

## [33.1.0] - 2026-08-22

### Changed
- Switched to WebBrain VL 2 450M as the local vision fallback.

## [33.0.8] - 2026-08-20

### Changed
- Changed the Chrome local vision fallback to the fine-tuned `webbrain-one/webbrain-vl-2-450M-onnx` release, with renewed opt-in consent and a versioned ready marker so older caches cannot be mistaken for the new model.
- Added a consent-gated, durable WebBrain Compass terminal-runtime outbox so executed terminal tool results survive provider-trace export gaps and can be joined through stable de-identified references.
- fix: resume vision downloads and organize settings
- fix: require vision cache marker and isolate queued worker deadlines
- fix: verify local vision cache and abort timed-out remote vision
- fix: preflight mixed attachments and preserve queued vision stop
- fix: reject staged screenshots without vision route
- fix: make screenshot vision explicit and bounded

## [33.0.7] - 2026-08-20

### Changed
- feat: make research escalation explicit opt-in
- fix: close research escalation consent races
- fix: bound actionable discovery resets
- fix: preserve progress at observation limit
- fix: keep long ChatGPT research answers as valid JSON
- fix: ignore null research mappings and abort closed source tabs
- fix: keep research mapping out of ordinary side-panel tabs
- fix: stop research wait when the ChatGPT tab closes
- fix: cancel research wait when ChatGPT helper tab closes
- fix: treat ChatGPT stop-button test id as generating
- fix: keep research Stop on the source run
- fix: recheck ChatGPT origin before research submit
- fix: expose research consent in ask mode
- feat: add consent-gated research escalation

## [33.0.6] - 2026-08-20

### Changed
- Packaged the current extension fixes for browser stores.

## [33.0.5] - 2026-08-20

### Changed
- fix: prevent duplicate extension manifests

## [33.0.4] - 2026-08-20

### Changed
- Packaged the current extension fixes for browser stores.

## [33.0.3] - 2026-08-20

### Changed
- test: keep Wikipedia translation assertion with its call
- fix(offline): skip personal non-English tasks and prefer the selected source language
- fix(offline): keep prior-turn language for Wikipedia follow-ups
- fix(offline): detect Wikipedia language from the original direct query
- fix(offline): skip disabled Wikipedia translation and disambiguate shared scripts
- fix(offline): detect Wikipedia translation language from the resolved query
- fix(offline): disambiguate Han queries and reject non-string translations
- fix(offline): tighten multilingual Wikipedia retrieval routing
- fix(offline): restore script-based query language hints
- Improve multilingual offline Wikipedia retrieval

## [33.0.2] - 2026-08-20

### Changed
- Keep Clarify open while typing
- Handle streamed WebBrain quota limits
- Address WebBrain Plus review feedback
- web: add an Apocalypse Mode video popup under Install WebBrain
- Add WebBrain Plus upgrade prompt

## [33.0.1] - 2026-08-20

### Changed
- test: allow GPL licensing checks after version bumps
- web: make the Downloads FAQ a full-block link and publish the GPL 33 note
- fix(chrome): stop sibling status polls from migrating Bonsai
- fix(chrome): keep Emergency Box open when switching Minimal and Basic
- test: update WebGPU text model label expectations
- fix(settings): serialize model-load saves
- fix(settings): ignore stale model list responses
- fix(ui): name Minimal and Basic as text models in download boxes
- fix(apocalypse): deduplicate corpus download starts
- dist: rebuild submission zips for v33.0.0
- fix(offline-rag): keep emergency text pack status stable during extraction
- release: prepare WebBrain 33.0.0
- fix(chrome): preserve CDP lifecycle ownership
- fix(oauth): deduplicate subscription token refreshes
- build(release): package Bonsai resume fix
- fix(chrome): validate resumed Bonsai downloads
- fix(onboarding): keep Skip gated when provider scan fails
- fix(chrome): make debugger teardown race-safe
- test(chrome): cover debugger cleanup on run errors
- fix(onboarding): localize install showcase headlines
- build(release): regenerate 32.2.3 packages
- fix(chrome): release debugger sessions after runs
- fix(offline-rag): address follow-up Xapian review
- fix(onboarding): restore cloud status after a privacy retry
- fix: use integer schema for bounded tree size
- fix(browser): skip capture-ended notify on recorder start failure
- fix(onboarding): keep privacy choice consistent and announced
- fix: coordinate offline download ownership
- fix(offline-rag): address Xapian review findings
- fix(onboarding): acknowledge privacy provider reload
- fix(onboarding): gate skip on provider scan
- fix(chrome): rearm queued download work
- fix(chrome): complete Bonsai review follow-ups
- fix(release): address GPL packaging review
- fix(chrome): address Bonsai download review feedback
- fix(onboarding): await privacy choice before skip
- fix(browser): clean up capture resource lifecycles
- feat(onboarding): showcase WebBrain features on install
- docs: resolve Chinese offline RAG conflict
- Run Apocalypse archive downloads offscreen
- fix(release): publish GPL corresponding source
- fix(ui): keep relative time wording explicit
- fix(ui): preserve message info scrollability
- fix(ui): freeze opened message timestamps
- fix(ui): show relative message timestamps
- bugfix
- Stop 40GB Wikipedia downloads stalling on OPFS createWritable.
- Fix Basic (Bonsai) cache.put failing on chrome-extension URLs.
- Speed up large Wikipedia archive downloads without breaking resume.
- Show LFM2.5 and Bonsai beside Minimal/Basic without extra i18n keys.
- Add Minimal/Basic model-name strings to every Apocalypse locale.
- Persist Bonsai weights before marking Basic ready.
- Rename Apocalypse text presets to Minimal and Basic.
- Expect Basic in the uncached WebGPU selection error.
- Show Basic/Pro text presets and keep download progress visible.
- Fix Bonsai 27B download hitting Transformers.js config.json.
- Keep Apocalypse kit CSS identical across Chrome and Firefox.
- Add Bonsai 27B as an opt-in Chrome WebGPU text model.
- feat(offline-rag): turn on the vendored Xapian full-text worker
- vendor xapian/libzim wasm runtime built from source
- fix(build): survive the wasm-opt crash on the final Wasm link
- fix(build): explain the WSL integration switch when docker is missing
- docs(build): lead with the WSL work tree for the clock-skew fix
- fix(build): detect Docker mount clock skew before it aborts the build
- fix(offline-rag): stop claiming a running download is already verified
- fix(offline-rag): register the build:zim-xapian npm script
- docs(offline-rag): correct the archive tier description and warn on manual imports
- feat(offline-rag): register the Xapian provider behind the bundled flag
- feat(offline-rag): reproducible source build and worker driver for the Xapian runtime
- feat(offline-rag): record the GPL approval and detect ZIM full-text indexes

## [33.0.0] - 2026-08-20

### Changed
- License WebBrain 33.0.0 and later under GPL-3.0-or-later because the distributed extension bundles and integrates the GPL-licensed Xapian/libzim WebAssembly runtime; releases before 33.0.0 remain MIT-licensed.
- Remove baked-in copy from onboarding-only screenshots so localized HTML captions do not overlap the artwork; Chrome Web Store screenshots remain separate and unchanged.
- Increase the size and contrast of the `Alt+Shift+W` onboarding shortcut hint.

## [32.2.3] - 2026-08-19

### Changed
- feat(offline-rag): keep adult CPR off baby queries and measure it
- fix(offline-rag): keep the field guide when encyclopedia passages outrank it
- fix(offline-rag): stop discarding the Wikipedia article that answers the question
- feat(offline-rag): recover misspelled, inflected, and suffixed queries
- Add hover tooltip on Edge card for Mac/Linux users

## [32.2.2] - 2026-08-18

### Changed
- dist: rebuild submission zips for v32.2.1
- chore(vendor): drop the unreachable ONNX jsep runtime
- feat(offline-rag): answer with a labelled caveat when offline evidence misses
- style update
- fix(offline-rag): manage the answer engine on Apocalypse Mode
- fix(offline-rag): restore answer-engine readiness on Emergency Box
- added emergency box pdf source linking
- docs: add remote downloads and data sources documentation with flowchart diagram
- fix(offline-rag): search health topics, not leftover stopwords
- fix(ui): render markdown tables in skill previews and chat history
- Revert "fix(ui): render markdown tables in skill previews and chat history"
- fix(ui): render markdown tables in skill previews and chat history
- feat(offline-rag): emergency download system with semantic runtime
- fix(offline-rag): fix progress percentage calculation in apocalypse-mode emergency text pack card
- fix(offline-rag): fix data-i18n keys for emergency corpus and semantic model descriptions in apocalypse-mode.html
- fix(offline-rag): publish Emergency Pack & Semantic Model download state to shared download tracker in apocalypse-mode
- fix(offline-rag): keep offline answer engine readiness box hidden in standalone chat when apocalypse button is clicked
- fix(offline-rag): remove redundant Open Emergency Box link from readiness section on apocalypse-mode.html
- feat(offline-rag): show Emergency text pack and Multilingual semantic model cards in apocalypse-mode.html
- feat(offline-rag): auto-download emergency corpus and semantic model, protect files, and hide offline answer engine
- Replace apocalypse mode indicator dot with ☢️ nuclear waste emoji
- added apocalypse mode visual
- updated numbers
- style update
- updated changelog
- version up
- fix(ui): respect IME composition in composer
- fix(offline-rag): resolve PR 280 review findings and standalone chat routing
- fix(ui): keep markdown tables after headings and in history
- ask webbrain a question bubble opacity 0.8 + bugfix
- made ask webbrain a question work
- fix(ui): render markdown tables
- docs: add offline RAG documentation and FAQ entries
- fix(ui): harden selection quote follow-up action
- feat: offline RAG with emergency corpus, retrieval, and reranking
- Stop treating editor arrows and current-slide labels as carousel failures.
- fix(ui): keep Escape run semantics
- fix(ui): harden selection action lifecycle
- fix(ui): clear stale selection actions on send
- fix(ui): keep answer selection action usable
- fix(ui): preserve selection action lifecycle
- fix(ui): position answer selection action before repaint
- feat(ui): quote selected answers for follow-up questions
- instagram carousel findings fixed
- trigger merge re-check
- fix(apocalypse): ignore stale PDF search results
- fix(ui): ignore stale list refreshes
- fix apocalypse downloads and readiness showcase
- fix(apocalypse): validate resumed PDF ranges
- fix(anthropic): yield done when replay fails mid-stream instead of throwing
- test(apocalypse): reflect hidden Wikipedia callout
- fix(settings): list built-in provider default models
- fix(providers): keep routed o-series on legacy contract
- add basic/full kit downloads, built-in communication reader, size estimates, and i18n translations
- fix(anthropic): preserve thinking content across turns
- hide Offline Wikipedia box in apocalypse mode
- restore apocalypse-comm from backup
- fix(content): observe final submit cancellation state
- fix(content): observe final submit cancellation state
- add apocalypse comm pages and update docs
- fix(agent): verify same-URL history traversal
- fix(providers): scope routed contract detection by provider
- fix(providers): classify routed reasoning model contracts by provider
- feat(providers): add OrcaRouter
- apocalypse mode documented in english and chinese
- style up apocalypse mode
- fix(content): use one set_field submit path
- fix(providers): keep routed GPT-5 Pro token contract
- test(agent): exercise scaled click loop path
- fix(providers): omit unset models for every local config
- fix(content): require observed submits for set_field
- fix(content): keep the Enter trio and submit natively only when the page did not handle Enter
- fix(providers): bound the reasoning-contract regex and share it with settings
- fix(i18n): localize the window permission verb and harden the prompt fallback
- fix(providers): require a model for local servers that need one, omit for LM Studio
- fix(azure): stop guessing the wire contract from the deployment name
- test(agent): pin image-space coord-click bucketing under screenshot downscaling
- Release 32.1.0 with blank provider duplicates
- Polish message info metadata
- Fix provider duplicate lifecycle
- Keep offline Wikipedia library reachable
- Restore complete Wikipedia library management
- Guard Wikipedia history navigation races
- Fix message info streaming and accessibility
- Refine homepage AI story and section flow
- fix(message-info): propagate streamed finish reasons and expose a semantic info toggle
- Keep small Wikipedia images compact
- Render offline equations and showcase Apocalypse Mode
- Harden Apocalypse offline answers
- fix(azure): use max_completion_tokens and omit temperature for reasoning deployments
- Build localized Apocalypse offline library
- feat(/print): extract executePrintSlashCommand helper and add behavioral tests
- fix(message-info): pass endedAt through synthesized run_complete on restore
- fix(duplicate-provider): address Copilot review comments
- Fail closed on alternate message composers
- Resolve recipient follow-ups and nested controls
- Stop unsafe messaging workflow replay
- Bind all recipient sends to final dispatch
- Bind recipient verification to message dispatch
- Allow verified conversation retargeting
- Distinguish chat composer from navigation controls
- Block uploads on protected messaging routes
- Require recipient-specific header evidence
- Harden direct-message recipient verification
- Fix FAQ search icon alignment
- Localize FAQ accessibility labels
- Validate FAQ language routes
- Move FAQ into multilingual docs
- Fix resumable large download cancellation
- Scope the compare base to chrome source and port-specific firefox code
- feat: expand Apocalypse Mode for offline use
- fix: avoid misleading message metadata
- feat: show message info on click
- Add duplicate provider configurations
- Preserve selection scope for /print
- Add /print slash command
- Rearm Apocalypse downloads after cancellation
- Rebuild optimized archive artifacts
- Optimize offline archive storage and lookup
- Rebuild offline download artifacts
- Harden resumable offline downloads
- Rebuild artifacts after upstream merge
- Rebuild ZIM matching artifacts
- Make ZIM matching locale independent
- Rebuild Apocalypse polling artifacts
- Keep Apocalypse polling and lookup responsive
- Rebuild ZIM title lookup artifacts
- Cover combined ZIM title capitalization
- Rebuild Apocalypse keepalive artifacts
- Keep Apocalypse workers and imports race-safe
- Handle LFM directional scroll aliases
- Parse LFM2.5 native tool calls
- Document Apocalypse archive tiers
- Limit WebGPU presets to LFM2.5
- Rebuild Apocalypse streaming artifacts
- Stream Apocalypse pieces within one wake
- Clarify Apocalypse update and import behavior
- Default WebGPU to compact prompts
- Fix WebGPU download conflict handling
- Rebuild Apocalypse retry artifacts
- Preserve Apocalypse retries and redirect aliases
- Add LFM2.5 WebGPU reasoning preset
- Rebuild Apocalypse failure artifacts
- Keep Apocalypse failure lifecycle progressing
- Rebuild Apocalypse control artifacts
- Harden Apocalypse title lookup and controls
- Rebuild Apocalypse scheduling artifacts
- Keep Apocalypse download scheduling race-safe
- Rebuild download retry review artifacts
- Harden Apocalypse download retries
- Add Ternary Bonsai WebGPU preset
- Rebuild schedule recovery artifacts
- Restore Apocalypse schedules safely
- Add Gemma WebGPU preset
- Rebuild catalog tier review artifacts
- Expose all Apocalypse catalog tiers
- Use flag-only language picker trigger
- Rebuild WebGPU progress review artifacts
- Filter WebGPU vision download progress
- Rebuild search race review artifacts
- Guard Apocalypse search error state
- Rebuild Apocalypse review artifacts
- Fix Apocalypse completion races
- Scope WebGPU transfer state by model
- Rebuild 32.0.0 store archives
- Fix Apocalypse archive lifecycle races
- Add selectable WebGPU models
- Keep Ling WebGPU session options mutable
- Reduce Ling WebGPU buffer pressure
- feat: complete Apocalypse Mode offline setup
- Fix Ling WebGPU inference failures
- Add managed Ling model downloads
- fix: align Firefox minimum version
- Keep WebGPU state out of profile sync
- version update
- fix: close Apocalypse Mode lifecycle races
- fix: harden Apocalypse Mode archive lifecycle
- feat: rework offline Wikipedia as Apocalypse Mode
- fix: keep Wikipedia cache provenance coherent
- fix: preserve rich Wikipedia cache records
- feat: add offline Wikipedia retrieval
- Add endpoint-free WebGPU local provider
- Remove DOM handling explanation from README
- Keep the explicit translation exception in the brief rendering
- Trim the response-language policy prompt cost
- Anchor fallback language on continuation
- blog: show shipped WebGPU vision in WebBrain 31
- Persist continuation language policy
- Preserve language across continuations
- Reject empty deliverable language policies
- Fail closed on incomplete language policy
- Preserve request language without planner
- Fix response language policy

## [32.2.1] - 2026-08-18

### Added
- Added comprehensive offline remote downloads and data sources documentation (`docs/remote-downloads.md`).

### Fixed
- Fixed Emergency text pack and multilingual semantic search model download state broadcasting to the shared download tracker in Apocalypse Mode.
- Fixed progress calculation and display sync on the Emergency text pack card.
- Fixed data-i18n translation keys for corpus and semantic model descriptions.

## [32.2.0] - 2026-08-18

### Added
- Added a "Ask WebBrain a Question" bubble with improved opacity and lifecycle handling.
- Added markdown table rendering for assistant responses, preserving tables after headings and across conversation history.
- Added Apocalypse Mode basic and full kit downloads with a built-in communication reader, size estimates, and i18n translations.

### Changed
- Improved Instagram carousel handling by no longer treating editor arrows and current-slide labels as carousel failures.

### Fixed
- Fixed markdown tables being removed after headings and in conversation history.
- Fixed offline RAG PR review findings and standalone chat routing.
- Fixed selection quote follow-up action lifecycle and hardening.
- Fixed stale selection actions being cleared on send.
- Fixed answer selection action positioning and lifecycle preservation.
- Fixed Escape key run semantics.
- Fixed Anthropic thinking content preservation across turns and graceful handling when replay fails mid-stream.
- Fixed built-in provider default model listing in settings.
- Fixed OpenAI o-series routed provider legacy contract handling.
- Fixed Apocalypse Mode PDF range validation and stale search result handling.
- Fixed stale list refresh handling.
- Fixed Apocalypse Mode downloads and readiness showcase.
- Fixed SPA same-url navigation history handling.

### Tests
- Added offline RAG documentation and FAQ entries.

## [32.1.1] - 2026-08-18

### Added
- Added offline RAG support with emergency corpus, SQLite FTS5 search, multilingual semantic reranking, and local text citation readers.
- Added selection quote follow-up action for Ask WebBrain.

### Fixed
- Fixed offline RAG lifecycle recovery, SQLite SAH pool database cleanup on cancellation, and multilingual emergency query routing.

### Tests
- Added test coverage for offline RAG emergency corpus recovery, lock bypass, and multilingual query detection.

## [32.1.0] - 2026-08-16

### Added
- Added a `/print` slash command that prints either the current page or the user's active selection without losing the selected scope.
- Added independently configurable duplicate provider cards in Settings, with one additional instance per eligible provider and preserved provider-specific behavior across Chrome and Firefox.
- Added click-to-reveal message metadata, including system-timezone sent times and verbose model completion details.

### Changed
- Refined the homepage story and Apocalypse Mode showcase, including offline equation rendering and more compact handling of small Wikipedia images.

### Fixed
- Duplicate provider cards now open completely blank instead of copying credentials, endpoints, models, costs, compatibility overrides, or other settings from the source provider; suggestion-backed model controls also remain visibly blank until configured.
- Kept duplicate-provider creation, removal, draft preservation, active-provider fallback, reload validation, and local model/vision behavior independent and reliable.
- Improved message metadata accuracy, streaming/restoration behavior, keyboard accessibility, compact one-line presentation, and local-timezone formatting without a separate info icon.
- Kept the offline Wikipedia library reachable from Apocalypse Mode and hardened archive history navigation and offline answer generation.

### Tests
- Added mirrored Chrome and Firefox regressions for blank provider duplication, duplicate lifecycle behavior, message metadata rendering and keyboard operation, `/print` selection handling, and Apocalypse Mode reliability.

## [32.0.0] - 2026-08-14

### Added
- Added opt-in Apocalypse Mode for downloading or importing Wikipedia Kiwix/ZIM archives and searching them locally when the built-in Wikipedia skill cannot reach its online source.
- Added an on-device archive manager, available from the ☢ Apocalypse Mode link beside Support in the Settings header, with expanded language choices, full-text archives with an optional images toggle, background download progress, storage estimates, update checks, removal controls, and reauthorization for external archive files.
- Added browser-native ZIM parsing and search, including Zstandard-compressed clusters, without uploading archive contents.
- On supported Chromium browsers, enabling Apocalypse Mode now enables and downloads the local LFM2.5-VL vision fallback automatically, with persistent progress shown on the management page.
- Localized the Apocalypse Mode interface across all supported Chrome and Firefox locales.

### Fixed
- Prevented direct-message sends on protected messaging routes unless the planner carries the user-authorized recipient and a read-only pre-dispatch probe verifies one unique, exact active-conversation header identity. Pronoun follow-ups resolve to a named recipient only from unique authentic prior-user context, otherwise they clarify; generic pronouns never silently mean the open thread. Active-conversation requests are pinned to that identity before any page tool runs; ordinary conversation text never counts as recipient evidence, structurally verified search/navigation fields stay distinct from composer submission, and alternate or ambiguous editable composers plus unresolved or distant controls and dispatch paths that cannot bind to the verified recipient—including attachment injection that may auto-send—fail closed. Structurally verified conversation rows in the separate left rail remain selectable so the agent can recover from an initially wrong thread, while nested row actions and their span/SVG descendants remain blocked; verified Enter sends are limited to one keypress. Send-capable field edits, clicks, accessibility clicks, and Enter presses carry a one-use action/composer/identity binding that is revalidated at the actual click or key dispatch point; protected accessibility clicks never issue a second no-progress fallback click. Saved workflows that could dispatch on a protected messaging route stop before replay and direct the user to a normal Act task, where fresh structured recipient authorization is available. The first enforced adapter is Douyin chat, with Chrome/Firefox parity.
- Isolated browser-managed archive storage per download so reinstalling the same archive cannot corrupt another record.
- Required explicit Apocalypse Mode opt-in before catalog or Metalink network access.
- Made stale-import recovery generation-safe and preserved partial data while a live importer may still be writing.
- Added explicit permission recovery for external ZIM files after browser restarts and prevented automatic retries while authorization is required.
- Removed unbounded alarm retries after unexpected archive-download failures.
- Routed local vision progress through the service worker, probed WebGPU before automatic selection, restored the prior vision provider after automatic preload failures, preserved later local-vision opt-outs, and refreshed the Settings controls after cross-tab changes.

### Tests
- Added planner, adapter-routing, active-conversation pinning, recipient-normalization, exact-match, mismatch, missing-authorization, inconclusive-probe, alternate-dispatch, and non-message regressions for the direct-message recipient guard in both browser builds.
- Added mirrored Chrome and Firefox regression coverage for ZIM validation and search, archive downloads and imports, opt-in network gates, recovery races, external-file permissions, and retry behavior.

## [31.0.1] - 2026-08-14

### Changed
- blog: announce WebGPU vision and correct EXL3 date
- i18n: localize local vision fallback
- dist: rebuild submission zips for v31.0.0
- fix: use visual local vision health probe
- docs: add 31.0.0 changelog
- version up
- dist: rebuild extension packages
- fix: make local vision probe reliable
- dist: rebuild extension packages
- fix: harden WebGPU vision lifecycle
- improvements
- Retry quantized WebGPU map failures with fp16 before aborting
- Skip WASM fallback for quantized WebGPU models
- Retry WebGPU unaligned-access failures with fp16 dtype
- Reset WebGPU mode when WASM kernel init fails
- Improve WebGPU fallback errors and switch default ONNX model to Gemma
- Add robust fallback for WebGPU buffer map failures
- Handle WebGPU OrtRun buffer download/CPU data failures with retry mode
- Fix WebGPU CPU tensor access error in worker pipeline
- 9.0.2
- 9.0.0
- WebGPU: keep outputs on GPU to avoid mapAsync OOM
- title change
- WebGPU: move inference to a dedicated Worker + upgrade to Qwen 3.5 0.8B
- WebGPU: disable wasm-cache for chrome-extension scheme
- WebGPU: address PR #66 codex review (tool-call streaming + cache key)
- WebGPU: enable cross-origin isolation for SharedArrayBuffer
- WebGPU: force .jsep wasm variant so WebGPU EP actually engages
- WebGPU: surface fallback-adapter / no-GPU case in Test Connection
- WebGPU: document fp16 fallback when q4f16 kernel overflows
- WebGPU: switch default dtype from q4 to q4f16
- WebGPU: vendor asyncify WASM variant for CPU fallback ops
- WebGPU: vendor onnxruntime-common, patch second bare specifier
- WebGPU: vendor UNMINIFIED builds (Web Store policy + readability)
- WebGPU: fix bare-specifier import (vendor ort.webgpu.bundle, patch specifier)
- version up
- Vendor @huggingface/transformers 4.2.0 (WebGPU + ONNX runtime)
- WebGPU: download progress indicator
- Update offscreen.html
- chore: bump version 7.3.1 → 7.4.0
- WebGPU + ONNX provider (Qwen 3 0.6B, in-browser, no server needed)

## [31.0.0] - 2026-08-14

### Added
- Added a one-click, Chrome-only in-browser vision fallback powered by WebGPU, using LiquidAI's LFM2.5-VL-450M ONNX model as a dedicated screenshot-description sidecar rather than a general planning provider.

## [30.0.7] - 2026-08-14

### Changed
- fix(memory): validate extraction confidence defaults
- fix(actions): preserve Messenger thread routes
- fix(session): recompute recent boundary after filtering
- 30.0.6
- docs: explain page context reduction
- Default extraction confidence to 1 when the model omits it
- Reject lookalike commerce hosts and short-link DM paths
- Drop tool results orphaned by assistant compaction in session snapshots
- Clarify the non-finite overflow comment per review feedback
- Fix clipped plan review steps
- Reject non-finite numbers in cloud output schema validation
- Added Product Hunt

### Fixed
- Keep ordinary and forced-recovery answers in the trusted user-request language while allowing explicit translation targets, user-edited plan targets, multilingual deliverables, and source-faithful quotations to use their requested languages.
- Shrink the response-language instruction on ordinary turns from about 150 tokens to about 40, stop repeating it in the `done` tool schema when the system prompt already carries it, and keep an explicitly empty planner deliverable list instead of discarding it as malformed. Translation, multilingual, approved-plan-override, and forced-delivery turns keep the full wording.

## [30.0.5] - 2026-08-13

### Changed
- bugfixes
- Handle nested opaque iframe origins
- Fix agent safety and reliability regressions
- removed unnecessary files

## [30.0.3] - 2026-08-13

### Changed
- feat: add local OpenAI-compatible proxy provider
- fix: recognize localized Gmail expansion controls
- Preserve hidden prompts for restored retries
- Fix thread actions and anchored pagination

## [30.0.2] - 2026-08-13

### Changed
- Packaged the current extension fixes for browser stores.

## [30.0.1] - 2026-08-12

### Changed
- fix: disambiguate nested Gmail label routes
- fix: reject Gmail list routes with hex names
- fix: bind tree pagination to content revisions
- fix: require fresh Gmail root metadata
- Update contributor count in webstore explainer
- fix: reject Gmail list routes for thread reads
- fix: polish standalone window UX
- feat: add standalone Ask window
- Fix Gmail thread read completeness
- Polish selection shortcut actions
- fix: isolate standalone chat context
- fix: require verified download completion
- 29.0.3
- updated numbers
- Fix #466: Expand sidepanel into standalone window
- Fix #2752: Derive planner download completion requirements without prose heuristics
- fix: preserve legacy click dispatch behavior
- refactor: reconcile screenshot clicks through semantic AX targets
- fix: constrain general knowledge to custom selections
- fix(planner): require structured download completion evidence
- feat: add general knowledge selection scope
- feat: resolve visual targets to semantic refs

## [30.0.0] - 2026-08-12

### Changed
- Expanded the side panel into a standalone window.

## [29.0.2] - 2026-08-12

### Changed
- dist: rebuild submission zips for v29.0.1
- fix: make store submission code reviewable

## [29.0.1] - 2026-08-11

### Changed
- dist: rebuild submission zips for v29.0.0
- fix: refine settings control order
- docs: add 29.0.0 changelog
- 29.0.0
- Clean up settings organization

## [29.0.0] - 2026-08-12

### Changed
- Reorganized Settings to surface frequently used controls and group advanced options more clearly.

## [28.2.3] - 2026-08-11

### Changed
- Add active provider filter

## [28.2.2] - 2026-08-11

### Changed
- fix streaming multipart offscreen uploads
- fix transcription runtime fallback transport
- fix chrome multipart offscreen fallback
- fix multimodal provider validation
- Fix anchored accessibility pagination
- Reset protected gallery state after URL reads
- Fix planner retry error handling
- Handle protected Chrome Web Store pages
- Fix planner provider compatibility and Act fallback

## [28.2.1] - 2026-08-11

### Changed
- version up
- fix: hide localized context menu instructions
- blog: publish EXL3 + SparkInfer on Blackwell lite post
- blog: add EXL3 + SparkInfer on Blackwell lite post (scheduled)
- Apply suggestions from code review
- feat: localize selection shortcuts
- fix: dedupe run progress replay gaps
- test(memory): cover newly formed memory cues
- style(memory): animate the Firefox memory cue
- feat(memory): render the Firefox memory cue
- feat(memory): notify the Firefox side panel
- feat(memory): mirror new-memory tracking in Firefox
- style(memory): animate the Chrome memory cue
- feat(memory): render the Chrome memory cue
- feat(memory): notify the Chrome side panel
- feat(memory): track newly formed memories

## [28.2.0] - 2026-08-11

### Changed
- Localized the selection shortcut and native context-menu items across all 23 supported interface languages in Chrome and Firefox, including action names, translation targets, status messages, right-to-left layout, and live language changes.
- Localized shortcut-generated prompts so responses follow the active interface language without exposing model-only language instructions in the visible conversation.

### Fixed
- Smoothed the effects of bounded run memory by showing a replay-gap notice only once per run, even as acknowledged event boundaries advance, while continuing to restore completed output after side-panel reconnects.

## [28.1.5] - 2026-08-11

### Changed
- fix: defer download intent normalization
- fix: recover planner localization and download intent
- test(onboarding): cover install guide transition
- fix(onboarding): advance Firefox install guide
- fix(onboarding): advance Chromium install guide

## [28.1.4] - 2026-08-11

### Changed
- version up
- fix: harden runtime mode recovery and trace diagnostics
- Apply suggestions from code review
- fix: localize Cloud Sync settings

## [28.1.2] - 2026-08-11

### Changed
- fix: preserve rich-text editor appends

## [28.1.1] - 2026-08-11

### Changed
- version up
- fix: enforce complete thread read coverage
- Fix restored compact tool details
- fix: honor complete thread read intent
- fix: require complete thread reads
- 28
- ci: make cloud smoke manual-only
- fix: toggle vision for custom local providers
- fix: detect vision for custom local providers
- fix: preserve local model capability identity
- feat: detect vision support for local providers
- Fix Ollama vision slash toggle
- Detect Ollama vision capabilities
- fix: address post-merge review findings
- feat: harden coupon domain refresh
- fix: call window.focus() before inputEl.focus() for focus-input command
- fix: use storage.onChanged for command dispatch instead of runtime.sendMessage
- docs: correct tab grouping visibility model
- fix(firefox): change focus-input shortcut from Ctrl+Slash to Ctrl+Period
- fix(firefox): add browser-level keyboard shortcuts via commands API
- test: preserve runner line endings
- test: cover automatic tab grouping opt-out
- feat(settings): add Firefox tab grouping preference
- feat(i18n): add zh Firefox tab grouping labels
- feat(i18n): add vi Firefox tab grouping labels
- feat(i18n): add uk Firefox tab grouping labels
- feat(i18n): add tr Firefox tab grouping labels
- feat(i18n): add tl Firefox tab grouping labels
- feat(i18n): add th Firefox tab grouping labels
- feat(i18n): add ru Firefox tab grouping labels
- feat(i18n): add pt Firefox tab grouping labels
- feat(i18n): add pl Firefox tab grouping labels
- feat(i18n): add nl Firefox tab grouping labels
- feat(i18n): add ms Firefox tab grouping labels
- feat(i18n): add ko Firefox tab grouping labels
- feat(i18n): add ja Firefox tab grouping labels
- feat(i18n): add id Firefox tab grouping labels
- feat(i18n): add hi Firefox tab grouping labels
- feat(i18n): add he Firefox tab grouping labels
- feat(i18n): add fr Firefox tab grouping labels
- feat(i18n): add fa Firefox tab grouping labels
- feat(i18n): add es Firefox tab grouping labels
- feat(i18n): add en Firefox tab grouping labels
- feat(i18n): add de Firefox tab grouping labels
- feat(i18n): add bn Firefox tab grouping labels
- feat(i18n): add ar Firefox tab grouping labels
- feat(settings): add Firefox tab grouping preference
- feat(settings): add Firefox tab grouping preference
- feat(settings): honor Firefox tab grouping preference
- feat(settings): honor Firefox tab grouping preference
- feat(settings): honor Firefox tab grouping preference
- feat(i18n): add zh tab grouping labels
- feat(i18n): add vi tab grouping labels
- feat(i18n): add uk tab grouping labels
- feat(i18n): add tr tab grouping labels
- feat(i18n): add tl tab grouping labels
- feat(i18n): add th tab grouping labels
- feat(i18n): add ru tab grouping labels
- feat(i18n): add pt tab grouping labels
- feat(i18n): add pl tab grouping labels
- feat(i18n): add nl tab grouping labels
- feat(i18n): add ms tab grouping labels
- feat(i18n): add ko tab grouping labels
- feat(i18n): add ja tab grouping labels
- feat(i18n): add id tab grouping labels
- feat(i18n): add hi tab grouping labels
- feat(i18n): add he tab grouping labels
- feat(i18n): add French tab grouping labels
- feat(i18n): add Persian tab grouping labels
- feat(i18n): localize Chrome tab grouping preference
- feat(settings): add Chrome tab grouping preference
- feat(settings): update Chrome agent tab grouping
- feat(settings): add tab grouping opt-out
- test: cover pinduoduo adapter
- agent: mirror pinduoduo adapter in firefox
- agent: add adapter for pinduoduo
- test: preserve run.js line endings
- ci: keep patch release changelog in sync
- test: cover patch release changelog ordering
- docs: backfill patch release changelog
- fix(captcha): serialize Cloudflare gate hydration
- fix(captcha): ignore unrelated response tokens
- fix(captcha): make English matcher additive
- fix(captcha): revalidate cleared token state
- fix(captcha): retire post-solve read inference
- fix(captcha): detect Cloudflare challenge pages
- ux improvements
- feat: generate coupon merchant coverage
- feat: add verified coupon code action
- documentation enhanced

## [28.1.0] - 2026-08-11

### Fixed
- Required complete communication-thread requests to read every page or expanded message before finishing, with multilingual intent handling and deterministic recovery across Chrome and Firefox.
- Restored compact tool-step **Details** controls after side-panel transcripts reload, including synchronized accessible expanded state in both browser builds.

### Tests
- Added mirrored coverage for complete-thread classification and pagination, premature-completion guards, bounded read windows, trace metadata, and restored compact detail toggles.

## [27.1.5] - 2026-08-08

### Changed
- Updated the LM Studio plugin for the current browser-delegation protocol.
- Added model-bound vision capability detection for llama.cpp, LM Studio, and LocalAI, with Auto / Force on / Off settings and fail-closed Chrome/Firefox request routing.

### Fixed
- Hid empty assistant placeholders until response content is ready to render.

## [27.1.4] - 2026-08-08

### Fixed
- Kept timed-out plan reviews visible and added an explicit retry path.

## [27.1.3] - 2026-08-08

### Fixed
- Corrected assistant response bubble width in the side panel.

## [27.1.2] - 2026-08-08

### Changed
- Expanded MCP setup and usage documentation.

### Fixed
- Reported API-mutation grants in the transcript and removed stale authorization presentation.

## [27.1.1] - 2026-08-08

### Changed
- Hardened CI integration and release security checks for the 27.1 series.

## [27.1.0] - 2026-08-08

### Added
- Added a value-free teacher mode (`/teach --start <name>` / `/teach --end`) that records a user's demonstrated clicks, field completions, checkbox/radio toggles, Enter submissions, and navigations into a tab-scoped session. The capture code never reads field values — only semantic identity — and every field action becomes a runtime parameter at the capture boundary. The session persists across navigation and compiles into the same `webbrain-workflow/1` format as successful runs. Automated runs are blocked while a teacher session is active for a tab.
- Added an interactive saved workflow manager (`/workflow`) to list, run, rename, export, and delete saved workflows in Chrome and Firefox.
- Added user-approved workflow locator healing: when a saved workflow target no longer matches uniquely, up to five independently replayable semantic candidates are presented for explicit single-selection. Approved replacements are applied atomically against the workflow's previous `updatedAt` value, so a concurrent edit wins instead of being overwritten; concurrent edits, unattended answers, and duplicate candidates can never authorize a healing.
- Added a WebBrain MCP server introduction blog post covering setup for Claude Code, OpenCode, Codex, and Cursor, the loopback security model, and how WebBrain MCP differs from headless browser tools.

### Changed
- Excluded WebBrain Compass from per-run cost limits and metered dedicated vision provider costs separately, so vision-heavy WebBrain Compass work does not count against the local/router cost allowance (Chrome and Firefox parity).
- Merged Cloud Bridge (MCP/LM Studio browser delegation) settings into Settings → General → Advanced → Cloud bridge, with synchronized setup guidance and the three bridge ports (MCP `17374`, LM Studio `17375`, WebBrain Cloud `17373`).
- Hardened screenshot and attachment handling: staged screenshots persist durably until delivery is confirmed at every call site, the per-turn screenshot budget charges only when a model actually receives the capture (vision description or attachment), redaction binds to capture time and scopes to rendered frames, and a child frame URL that cannot identify exactly one descriptor fails closed instead of risking mis-paired redaction regions.
- Did not stage a full-page screenshot when the capture-time privacy scan cannot prepare redaction geometry; the capture now reports `redactionUnavailable`, explains the blocker, and skips staging while still rendering the preview and save button (Chrome only).
- Removed the sticky API mutation badge from the Chrome and Firefox side panels. The `/allow-api` override now confirms once in the transcript instead of as a persistent composer badge.
- Passed trace run options through both Chrome and Firefox builds at startup.
- Allowed automatic i18n for AMO links and updated slash-command documentation across locales.

### Fixed
- Stopped sending automatic screenshots to text-only Ollama models by resolving the selected model's native `/api/show` vision capability before each run, with model- and case-sensitive-endpoint-bound caching, cancellable three-second metadata reads, legacy metadata fallbacks, live localized Auto / Force on / Off status, and Chrome/Firefox parity.
- Fixed a screenshot redaction fail-open path: the deferred full-page redaction now refuses the send when the snapshot had regions but `_redactScreenshotDataUrl` returned the bytes unchanged.
- Fixed `mergeRedactionFrameRegions` to return `null` under `requireCompleteFrameCoverage` when an object/embed subdocument or unpaired child frame has no DOM descriptor, instead of reporting the snapshot as complete.
- Fixed `loadStagedScreenshots` and `clearStagedScreenshots` to enumerate keys per-tab instead of reading all of `storage.local`, preventing 16 MB record churn on tab switch and reconnect.
- Fixed `consumePendingAttachmentsForTab` to key on `stagedAttachmentId` instead of object identity, preventing stale chips from wedging the composer after a rejection reconciled from storage.
- Fixed `reconcilePersistedStagedScreenshots` to only delete durable pixels on confirmed inclusion, preserving the user's only copy when delivery fails through a torn-down service worker.
- Fixed teacher submit capture and workflow cleanup to retain workflow claims and prevent stale submissions from clearing run claims prematurely.
- Preserved screenshots and attachments through terminal delivery, reconnect, and workflow replay, including cancelled-before-validation and unknown-delivery cases.

### Tests
- Added mirrored Chrome/Firefox coverage for teacher mode: value-free demonstration capture, session store normalization, automated-run rejection, Enter-as-submit semantics, and cross-browser slash-command wiring.
- Added mirrored coverage for the saved workflow manager, user-approved locator healing, atomic healing persistence with concurrent-update rejection, and workflow run-claim lifecycle.
- Added mirrored coverage for screenshot redaction fail-closed behavior, staged attachment recovery, viewport budget charging, full-page capture refusals, Cloud Bridge settings placement, and the WebBrain Compass cost-limit exclusion.
- Updated `test/run.js` with the API badge removal assertions and the sidepanel authorization state checks.

## [27.0.0] - 2026-08-07

### Added
- Added the WebBrain MCP server so Claude Code, Codex, Cursor, OpenClaw, and other MCP clients can delegate Ask or Act tasks to an already-authenticated Chromium session through the local browser bridge, with tools for connection checks, status polling, clarification responses, and aborting runs.
- Updated the LM Studio plugin with the same authenticated-browser delegation through `browser_task`, `browser_status`, `browser_respond`, and `browser_abort`, while retaining its standalone `fetch_url` and `research_url` tools.
- Added a default-off persistent setting for API mutations and strict JSON Schema output support for WebBrain Cloud runs.

### Changed
- Hardened local bridge task handling across MCP and LM Studio with bounded command and run deadlines, resumable status polling, disconnect recovery, explicit run aborts, and actionable connection diagnostics.
- Improved Act follow-up routing and planner continuity so completed-step summaries remain available to later turns, and localized tool-completion status labels across Chrome and Firefox.

### Fixed
- Kept Ask-mode bridge runs read-only, rejected web-page WebSocket origins, preserved active runs across bridge disconnects, and prevented temporary API authorization or timeout state from leaking into later requests.
- Tightened WebBrain Cloud structured-output validation, secret redaction, public-URL handling, scheduled-job scoping, and run-ID generation without discarding valid schema-shaped results.
- Made iframe form automation fail closed on ambiguous targets and improved promoted-frame navigation, submission, and persisted-value verification in Chrome and Firefox.

### Tests
- Added MCP and LM Studio bridge suites covering connection handshakes, concurrent commands, polling, timeouts, clarification, aborts, disconnect recovery, and clean shutdown.
- Expanded WebBrain Cloud smoke scenarios and mirrored Chrome/Firefox regressions for structured output, privacy boundaries, iframe recovery, Act follow-ups, and localized completion states.

## [26.2.0] - 2026-08-06

### Changed
- Repaired minor release workflow ordering to ensure consistent build/publish sequencing.
- Rebuilt distribution zips for Chrome/Edge/Firefox to match the corrected release workflow.

### Fixed
- Fixed minor release workflow ordering issues that could lead to out-of-order release artifacts.

### Tests
- Updated `test/run.js` to align with the corrected minor release workflow behavior.

## [26.1.0] - 2026-08-05

### Added
- Added a Chrome and Firefox rich-text editor safety system that identifies formatting controls before text entry, uses visual confirmation when available, and requires a corrected, verified editor-body edit before a run can complete.

### Changed
- Unified toolbar classification across content scripts, DevTools Protocol targeting, iframe dispatch, and recovery so the same control is judged consistently through navigation and extension reinjection.
- Bounded safety captures within the configured per-turn screenshot budget while reserving the first guarded edit for structural or visual inspection.

### Fixed
- Prevented ordinary toolbar searches, compact composers, trusted focused fields, and labelled controls from being mistaken for formatting targets without supporting editor evidence.
- Kept recovery obligations attached to the correct editor, route, and frame across rerenders and navigation while preserving distinct live sibling frames.
- Failed closed on ambiguous cross-frame responses, conflicting geometry claims, and page-owned classifier substitutions without stranding a run in unrecoverable toolbar debt.

### Tests
- Expanded mirrored Chrome/Firefox regression and vision-probe coverage for toolbar variants, shadow DOM, nested iframes, navigation, screenshot limits, recovery deduplication, and verified corrected edits.

## [26.0.11] - 2026-08-05

### Changed
- Routed advice and drafting follow-ups through response-only handling when trusted conversation context is sufficient, even while Act mode is selected.
- Closed built-in tool schemas and made the runtime mode authoritative during execute tasks.
- Kept Turkish deasciification opt-in and instruction-only, with skill instructions loadable only from the enabled catalog after explicit conversion intent.
- Bounded Chrome and Firefox conversation, chat, and run-replay session snapshots so live work can continue safely when recovery persistence is unavailable.

### Fixed
- Rejected undeclared tool arguments and mixed click targets before dispatch with structured `invalid_tool_arguments` / `noDispatch` results.
- Suppressed planner-shaped JSON beside tool calls, retried planner-shaped terminals once, and replaced raw execute-protocol failures with a user-facing unverified-completion message.
- Prevented unknown required form values from being represented by empty focus, clear, or write actions.
- Normalized nested and object-shaped failures before UI, trace, and dedupe handling so `[object Object]` is never rendered.
- Made assistant-message Copy controls idempotent, added a localized **Copy message** label, and collapsed rejected `done` retries into one visible diagnostic row.
- Preserved acknowledged replay boundaries without false warnings while deduplicating genuine discarded-event gaps per request.
- Retried quota failures with compact snapshots, marked unrecoverable runs non-durable, warned once, and prevented consequential action replay after connection loss without deleting other tab/session data.

### Tests
- Added mirrored Chrome/Firefox coverage for closed schemas, disabled skill arguments, Act/planner enforcement, nested errors, Copy deduplication, replay boundaries, multi-tab quota exhaustion, attachment/screenshot compaction, and fail-closed reconnect durability.


## [26.0.10] - 2026-08-04

### Added
- Added a rich-text toolbar safety preflight that stops the agent from typing document text into an editor's formatting controls (font size, font family, style preset, colour, link). The target is scored structurally, confirmed against an annotated screenshot where a vision model is available, and blocked before dispatch; the run cannot report success until the edit is redone in the editor body and verified.

### Changed
- Text-entry tools now report verification as a positive proof only. `type_text`, `set_field`, and `iframe_type` mark an edit `verified` when the field's final value proves it landed and stay silent otherwise, instead of reporting an unproven edit as refuted. Masked inputs, `maxlength` truncation, framework-reformatted fields, and whitespace-normalising rich-text bodies no longer register as failed actions.
- `iframe_type` now binds its dispatch to a single resolved frame when a toolbar recovery is pending, and reports the candidate frame URLs so a `urlFilter` can disambiguate them. Ordinary calls keep the previous all-frames behaviour, so pages with repeated same-origin frames continue to work unchanged.
- Moved the toolbar heuristic into one shared module used by both browser builds and by the DevTools Protocol probe, so an element scores the same whichever dispatch route reaches it.

### Fixed
- Fixed the toolbar preflight taking a screenshot that was then discarded, which cost an extra capture and vision call on every guarded edit.
- Fixed the toolbar preflight treating `[role="toolbar"]` ancestry as evidence on its own. An ordinary labelled field in an app toolbar scored high enough to escalate, so with no vision model available the guard blocked prose typed into it and held the run open on a recovery that could never be discharged. A control now also needs a formatting label, a numeric preset value, or a toolbar whose editor body resolves.
- Fixed the append verification rescanning a field's full contents at every candidate position with arbitrary-precision arithmetic, which could stall a page holding a large rich-text document.
- Fixed the cross-frame geometry handshake accepting whichever frame answered first; a second frame claiming the same exchange now fails it closed.
- Fixed toolbar classifier screenshots escaping the per-turn screenshot budget. They now share the cap with the captures the model sees, so the number you configure bounds the vision spend. The first safety capture of a turn is still reserved, so a low cap degrades the check to structural scoring rather than blinding it on the first guarded edit, and both the reserved capture and the fall-back are surfaced.
- Fixed a navigation during an open toolbar recovery stranding the debt without the state that discharges it, which left the guard inactive for the rest of the run while completion stayed blocked and no corrected edit could clear it. An editor whose only recovery handle was a page-scoped ref now carries across as unknown-target recovery instead of being dropped.
- Fixed selector preflights trusting a page-owned toolbar-classifier global; the DevTools Protocol path now captures only the packaged classifier and fails closed when that source cannot be loaded.
- Fixed navigation and extension-recovery paths duplicating one semantic editor obligation or reinjecting `content.js` without its toolbar classifier. Child-frame scope survives navigation while live sibling frames remain distinct.

### Tests
- Added mirrored Chrome/Firefox coverage for the verification contract, the `iframe_type` fallback, the toolbar heuristic's false positives, and the recovery contract, and pinned the heuristic to a single implementation across both builds and the DevTools Protocol probe.
- Added mirrored Chrome/Firefox coverage for the debt and state maps agreeing across a navigation, in both directions: an obligation that loses its ref stays dischargeable, and a debt nothing can discharge is dropped with its state.

## [26.0.0] - 2026-07-26

### Added
- Added non-blocking local browser runs: regular Chrome and Firefox tasks stay pinned to their original tab without activating it or stealing window focus, while `/foreground [prompt]` provides a one-run compatibility escape hatch for sites that must render visually in the foreground.
- Added offline converters for exported traces in Agent Trajectory Interchange Format (ATIF) and OpenTelemetry Protocol (OTLP), with documentation and regression coverage.
- Added an accessible in-panel **New conversation** confirmation that works when Vivaldi Web Panels suppress native browser dialogs.

### Changed
- Rebuilt CAPTCHA handling around frame-aware challenge detection and targeted response injection for reCAPTCHA, hCaptcha, and Turnstile, including branded-dialog and ancestor-loader recognition, cross-frame verification, manual-completion recovery, explicit gate abandonment, and fail-closed handling for ambiguous or conflicting candidates.
- Isolated selected-text context from independent, scheduled, cloud, and saved-workflow runs while preserving grounded follow-ups, attachments, compaction, and shortcuts within the originating selection conversation.
- Extended the rapid duplicate-submit guard to Firefox and made acknowledged resubmits re-arm the protection window in both browsers.
- Refreshed and reorganized the English, French, and Chinese documentation, landing-page demos, language ordering, and agent/skills/slash-command references.
- Polished the floating chat-navigation control, linked Settings title behavior, full-screen recording status, and slash-command keyboard actions.
- Extracted shared loop-detection, image-budget, and text tool-call parsing helpers without changing their browser parity.

### Fixed
- Rejected blank Chrome full-page captures, improved background screenshot compatibility, and verified inactive Firefox tabs before declaring a run complete.
- Fixed CapSolver key migration so valid saved `CAP-` keys enable solving consistently while malformed keys remain disabled.
- Fixed selection-scoped history, workflow, attachment, and navigation paths that could leak context into unrelated runs.
- Fixed CAPTCHA frame visibility, challenge correlation, response-field targeting, token fallback, and recovery after redirects or manual completion.
- Fixed the full-screen recording message so it matches whether the recording indicator is actually visible.

### Tests
- Added mirrored Chrome/Firefox regression coverage for background runs, inactive-tab capture, CAPTCHA gating and injection, selection-scope isolation, duplicate-submit protection, trace conversion, and the updated UI flows.

## [25.9.0] - 2026-07-25

### Added
- Added 76 new LLM providers (icons, docs, and README updates across English, French, and Chinese) alongside interactive Ask-mode streaming support for the expanded provider list.
- Added a `/watch` slash command with conditional scheduler polling, alerts on distinct successful events, dedupe-aware helper-tab cleanup, transient-failure tolerance, and locale/docs coverage.
- Added reCAPTCHA Enterprise support to the Chrome CapSolver agent tool, including v3/Enterprise widget and script detection across DOM, URL, and iframe paths, an `isEnterprise` schema field, and clearer parameter-vs-dispatch error triage.
- Restyled sidepanel tabs in Chrome and Firefox, with resize and RTL layout fixes.
- Published workflow export/import format documentation.

### Changed
- Centralized text sanitization and shared UI utilities and standardized provider message logic across Chrome and Firefox, including a Firefox utils dedup follow-up.
- Hardened interactive Ask streaming: traced the streaming run lifecycle, preserved trace ordering, redacted JSON-shaped streaming secrets, and fixed duplicate normalized streamed answers.
- Hardened chat/run clearing and cancellation: kept the composer locked while clearing, bounded unavailable stop-state probes, waited for stopped/local/direct run followers before clearing, suppressed updates from cleared runs, guarded the Stop fallback and stopped runs until a terminal state, scoped New Chat aborts to their originating tab, discarded queued prompts before clearing, stopped active runs before starting new chats, and cancelled schedules once active runs settle.
- Added WebBrain Compass interface strings and microphone permission messages to all locales, refreshed the evroc provider icon and provider counts, and updated Discord links and added a Chinese community section to the docs sidebars.
- Disabled the mode-pill animation for `prefers-reduced-motion`.

### Fixed
- Fixed detached side panel window routing in Chrome.
- Recovered workflow replay from a start-scope mismatch.
- Parsed action parameters with `URL.searchParams` to preserve decoded characters.
- Preserved pending upload evidence and fixed `find_text` selection verification and advancement.
- Fixed store submission automation.

### Tests
- Added mirrored Chrome/Firefox coverage for CapSolver Enterprise version/edition/action detection and error triage, `/watch` polling and dedupe behavior, and the centralized UI/text-sanitization utilities.

## [25.8.0] - 2026-07-23

### Added
- Added Inkling planner benchmark (OpenRouter default, Chrome thinkingmachines/inkling frozen fixtures) and published the corresponding benchmark docs/blog page.

### Changed
- Improved sidepanel UI polish for picker controls and the language menu.
- Added new UI locales for **de** and **nl**, including flag assets, and updated locale ordering/initialization to match expected dropdown behavior in both **Chrome and Firefox**.
- Updated provider/model documentation and synced docs with recent streaming requirements (including explicit Mistral stream usage guidance).
- Enabled Ask streaming behavior updates across providers while aligning provider-specific streaming/usage expectations.
- Rebuilt distribution zips for Chrome/Edge/Firefox.

### Fixed
- Fixed locale dropdown initialization and ordering issues (including missing locale pieces for **nl**/**de**).
- Avoided retrying terminal Ask stream errors to prevent incorrect fallback behavior.
- Corrected provider streaming usage handling for Mistral Ask (ensuring required usage/stream events are used as documented).
- Preserved provider-specific streaming compatibility rules (e.g., keeping Alibaba Ask non-streaming where required).

### Tests
- Added Inkling planner benchmark result fixtures to the test suite (Chrome thinkingmachines/inkling frozen set).

## [25.7.12] - 2026-07-23

### Changed
- Expanded interactive Ask streaming from GPT-5.6 to documented streaming- and function-calling-capable official OpenAI models, while keeping GPT-5.5 Pro and other unsupported variants non-streaming.
- Routed Responses-only GPT-5 Pro variants through the Responses API and retained Chat Completions streaming for other supported OpenAI models.
- Enabled interactive Ask streaming for Anthropic, Azure OpenAI, Gemini, DeepSeek, xAI, Mistral, Nvidia NIM, Groq, Together AI, Fireworks, z.ai, OpenRouter, WebBrain Compass, llama.cpp, Ollama, LM Studio, Jan, vLLM, SGLang, and LocalAI with provider-specific terminal-event validation.
- Generalized the Advanced streaming control and made safe transport/protocol fallback silent: the affected generation retries non-streaming once, then streaming stays disabled for the rest of that run.

### Fixed
- Treat premature official OpenAI Chat Completions stream EOF as an interrupted generation, clearing partial text and retrying once through the non-streaming path.
- Normalized GPT-5 Pro reasoning effort to its supported `high` value.
- Propagated explicit Chat Completions, Anthropic, and Azure in-stream API error events instead of accepting a later terminal sentinel as success; HTTP/API errors never trigger the silent fallback.
- Rejected OpenAI-compatible and Azure streams that finish with `content_filter`, clearing any partial text instead of persisting a filtered response or retrying it non-streaming.
- Added the documented `gpt-5.2-chat-latest` model to official OpenAI Ask streaming capability detection.
- Hardened llama.cpp streaming with readable-body, malformed-frame, explicit-error, usage, reasoning, and terminal `[DONE]` handling before enabling its silent non-streaming fallback.
- Added z.ai's required `tool_stream` request option for streaming generations that expose agent tools.
- Preserved Groq token usage delivered in the provider-specific `x_groq` streaming envelope.
- Rejected z.ai streams that finish with `sensitive`, `network_error`, or `model_context_window_exceeded` instead of persisting partial output as a successful response.
- Kept Alibaba Cloud Ask calls non-streaming because DashScope rejects its required `tools` payload when `stream: true`.
- Requested Mistral streaming usage events explicitly so interactive Ask turns remain included in cloud cost allowances.
- Preserved in-progress streamed Markdown across side-panel/sidebar closes, reloads, and reconnects in Chrome and Firefox.
- Rebuilt restored streams from the background-owned UI journal without duplicating deltas, losing Markdown structure, or leaving an unfinished stream in its incremental render state.

### Tests
- Added mirrored Chrome/Firefox coverage for OpenAI streaming capability detection, GPT-5.4 Pro routing, Chat Completions completion sentinels, and transport fallback.
- Added mirrored capability, terminal-event, malformed-frame, explicit-error, content-filter, and silent one-time fallback coverage for the newly enabled providers.
- Added mirrored regression coverage for persisted streamed text, reconnect replay, restored finalization, and journal size limits.

## [25.7.11] - 2026-07-23

### Fixed
- Ranked provider Settings search results by exact provider name/ID, then prefix, then substring matches while preserving the configured provider order for ties.

### Tests
- Added Chrome and Firefox provider-search ranking coverage.

## [25.7.10] - 2026-07-23

### Fixed
- Rendered streamed assistant output as Markdown while deltas arrive and finalized the same message when the terminal response is received.
- Replaced rejected or corrected streamed terminal content instead of appending a duplicate response.
- Finalized restored streamed responses consistently after reconnect.

## [25.7.9] - 2026-07-23

### Changed
- Refined reading-first navigation so new questions remain visible while long responses grow, explicit reader positions are preserved, and restored chats return to the latest turn.
- Added floating **Follow response**, **Jump to latest**, and **Back to question** controls for clipped long replies.

### Fixed
- Kept Continue bars, plan/clarification prompts, store-review prompts, new questions, and slash-command output visible when they require attention.
- Resumed live follow after an explicit jump to the response edge without overriding deliberate reading positions.

## [25.7.8] - 2026-07-23

### Added
- Added reading-first navigation for long replies across Ask, Act, and Dev modes in Chrome and Firefox.

### Removed
- Removed the packaged Chrome Web Store release skill, its privileged upload/publish routing, setup UI, dashboard adapter, protected-page exception, and previously seeded local skill records.

### Fixed
- Kept blocking prompts and slash-command output visible without losing live follow when a run resumes.
- Kept the navigation control available whenever response content extends below the viewport.

### Tests
- Added mirrored long-reply navigation, localization, restored-turn, and instant auto-follow regression coverage.

## [25.7.6] - 2026-07-22

### Added
- Added portable saved workflow JSON export and import commands with Chrome and Firefox parity.

### Changed
- Updated the official OpenAI model picker to list current dated model variants.
- Portable workflow imports are normalized, size-bounded, assigned fresh local identity, and rejected when unsafe or over the saved-workflow limits.

### Tests
- Added mirrored portable workflow parsing, file transfer, redaction, fresh-identity, and account-limit coverage.

## [25.7.0] - 2026-07-22

### Added
- Added safe saved workflow schema and UI support for saving and managing traced runs (Chrome and Firefox parity).

### Changed
- Updated workflow replay to use the new safe saved workflow schema, improving reliability and reducing brittle replay behavior (Chrome and Firefox parity).
- Updated documentation for privacy/data flow and security model to reflect saved workflow/replay behavior.

### Fixed
- Guarded workflow replay by page scope to prevent cross-page/brittle replays.
- Rejected brittle selector replay during saved workflow replay to avoid incorrect actions.
- Improved workflow replay safety by replaying saved actions in a more controlled manner.
- Closed workflow gaps for save, replay, and telemetry to ensure consistent end-to-end behavior (Chrome and Firefox parity).

### Tests
- Updated test runner (`test/run.js`) to align with the saved workflow/replay changes.

## [25.6.0] - 2026-07-22

### Added
- Added Ask-only OpenAI Responses streaming for interactive Ask-mode chats (Chrome and Firefox parity).

### Changed
- Updated planner benchmark coverage by adding Nanbeige 4.2 planner benchmark results to the repo.

### Fixed
- Improved structured plan review/editor stability by preserving editor scroll position across input and keeping step editing scroll stable (Chrome and Firefox parity).

### Tests
- Added Nanbeige 4.2 planner benchmark fixtures/results to the test suite.

## [25.5.0] - 2026-07-22

### Added
- Added a default-on Advanced setting to disable OpenAI Ask response streaming immediately and return new chats to the established non-streaming provider path.
- Improved plan review with structured, in-place editing (Chrome and Firefox parity).

### Changed
- Official OpenAI Responses calls now stream visible text for interactive Ask-mode chats while retaining the detached `chat_start` lifecycle, reconnect journal, and image/text attachment handling.
- Tool calls and assistant-history persistence remain buffered until `response.completed`; Act, Dev, scheduled, cloud, and Continue runs remain on `provider.chat()`.
- Drag-and-drop reordering of planner steps.
- Hardened mixed plan editor modes to keep editing behavior consistent.
- Preserved multiline plan step edits during editing and review flows.
- Preserved collapsed raw plan approvals through review.
- Preserved raw plan edits after review.
- Stripped canonical plan tool suffixes for cleaner plan tool display.

### Fixed
- Interrupted OpenAI Ask transports now clear their partial visible text, open a per-run circuit breaker, and retry through `provider.chat()` without accepting incomplete tool calls or persisting an incomplete assistant turn; terminal HTTP, API, and `response.incomplete` errors propagate without a duplicate fallback request.
- Live Ask text deltas remain immediate while durable reconnect snapshots are coalesced on a short trailing interval, avoiding a full journal clone and `storage.session` write for every SSE chunk; terminal updates and tool checkpoints still flush immediately.
- Fixed plan review scroll behavior and the run label during plan review/editing.
- Kept plan step editing scroll stable while interacting with the editor.
- Captured plan editor scroll before input to prevent scroll jumps.

### Tests
- Added mirrored Chrome/Firefox coverage for streaming scope, attachment delivery, terminal tool-call gating, coalesced reconnect persistence, detached lifecycle wiring, the kill switch, and transport-only non-streaming fallback.
- Updated test runner (`test/run.js`) to align with the new plan editor/review behaviors.

## [25.4.2] - 2026-07-22

### Added
- Added a default-disabled packaged Chrome Web Store release skill with trusted status, ZIP upload, and publish tools backed by the official v2 API in Chrome and Firefox.
- Added skill-scoped setup for user-owned Google OAuth credentials, publisher/item IDs, and an explicitly selected local release ZIP.

### Changed
- Added a Chrome Web Store dashboard adapter that routes enabled runs to the release skill instead of protected DOM controls.

### Fixed
- Added an always-on Chrome protected-page guard for the Chrome Web Store Developer Dashboard so DOM tools fail immediately and non-retryably instead of entering wait/read retry loops.

### Security
- Kept OAuth tokens and release ZIP bytes in extension-local storage and out of model prompts, tool arguments, traces, and tool results; upload and publish remain behind consequential-action permission and submission gates.

## [25.4.0] - 2026-07-21

### Added
- Added round-trip automatic progress policy to improve completion reliability across the full submit → completion → evidence loop.

### Changed
- Updated OpenAI model invocation to use `gpt-5.4-nano-2026-03-17` with `max_completion_tokens`.
- Preserved reviewed submit requirements across continuations to keep validation consistent when a run resumes.
- Hardened submit completion evidence requirements (including final-form completion evidence) to reduce false positives.
- Improved submit-state reconciliation by carrying submit verification across continuations and reconciling from screenshot URLs.
- Updated Chrome and Firefox builds to reflect the above completion/submit policy changes for parity.

### Fixed
- Prevented completion guard loops and stopped stale calls after completion-page blocks.
- Tightened completion success evidence to avoid accepting incomplete or uncertain outcomes.
- Improved handling of validation failures so they remain blocking for completion.
- Fixed CI/release robustness issues related to changelog prompt parsing and release-context substitution.

### Tests
- Added/expanded CI grading and E2E coverage to diagnose Gnippets HTTP failures and validate cloud E2E control requests.
- Added CI robustness improvements for unattended runs (disabling action prompts) and tightened grading inputs (e.g., accepting camelCase final URLs in CI grading).

## [25.3.0] - 2026-07-21

### Added
- Added initial release note scaffolding for WebBrain.

### Changed
- Updated OpenAI model usage to **gpt-5.4-nano-2026-03-17** and switched to `max_completion_tokens` for completion limits.
- Switched WebBrain Compass provider integration from **GitHub Models** to direct **OpenAI API** calls (using `OPENAI_SECRET` via curl), improving consistency across providers.
- Updated Chrome and Firefox builds to reflect the provider/model changes and associated configuration/UI updates.

### Fixed
- Resolved model-parameter compatibility issues by ensuring `max_completion_tokens` is used where required (avoids deprecated `max_tokens` errors).
- Corrected prior provider model ID handling during the transition away from GitHub Models.
- Improved release/changelog generation robustness by avoiding YAML parsing issues in the release prompt pipeline.

### Tests
- Added/expanded CI grading and E2E infrastructure coverage to better diagnose HTTP failures and validate cloud E2E control requests.
- Added CI robustness improvements for unattended runs (disabling action prompts) and tightened grading inputs (e.g., accepting camelCase final URLs).

## [25.2.0] - 2026-07-21

### Added

### Changed

### Fixed

### Tests
- Comprehensive test suite established for validating core functionality and browser compatibility.

## [25.0.0] - 2026-07-19

### Added
- Added runtime completion invariants in Chrome and Firefox that track consequential actions, require a fresh successful observation before accepting a success claim, and preserve verification obligations across batched calls, trusted continuations, restored runs, and scheduled tasks.
- Added localized permission education after repeated action prompts, with an onboarding note and a safe action that inserts `/dangerously-skip-permissions` for the specific pending prompt without overwriting an existing draft.
- Added a permanent, fully localized **Tweet about WebBrain** recommended action that opens X's visible composer, publishes reviewed language-specific copy without asking the model to write or translate it, then verifies and reports the post URL when available.

### Changed
- Action runs now reject plan-only, empty-step, promise-only, and premature terminal replies and continue into execution; explicitly requested plans and Markdown plus honest structured blockers remain valid results.
- Completion enforcement now distinguishes real dispatch from preflight failures, accepts only model-visible state observations, self-verifies successful scheduler writes, and preserves the intended Compact Dev and managed-cloud execution boundaries.

### Fixed
- Prevented stale tool calls from running after a rejected `done`, cleared rejected streamed plan text before recovery, preserved terminal obligation and session metadata, and rejected stale or same-batch completion evidence.
- Repaired high-confidence double-escaped assistant Markdown returned by OpenAI-compatible backends without rewriting legitimate code, paths, or escape-sequence examples.
- Hardened accessibility actions with document- and SPA-route-scoped refs, fresh-target and visibility checks, canonical accessible names, iframe dispatch tracking, and safer guarded-click progress detection, preventing stale clicks and false agent stops.
- Made `set_field` wait for controlled and rich-text editors to settle and require an exact normalized readback before submitting; failed sensitive-field readbacks no longer expose typed values.
- Corrected false completion blocks for denied, skipped, or pre-dispatch actions; pre-existing targets; input and CAPTCHA preflight failures; screenshots not visible to the model; observed non-success outcomes; and self-verified scheduled tasks.

### Tests
- Expanded mirrored Chrome and Firefox regression coverage for plan-to-execution handoffs, completion-invariant state and recovery, permission education and tab scoping, assistant-text repair, accessibility refs and field verification, and exact localized WebBrain post copy.

## [24.4.0] - 2026-07-18

### Changed
- Add guarded CDP click fallback + full screenshot bugfix

## [24.3.1] - 2026-07-18

### Changed
- Chrome `click_ax` stays synthetic-first and may issue one guarded CDP trusted-click fallback only after no observable progress on safe generic targets (visibility, hit-test, interactive-descendant, form/download/mutating/stateful exclusions).
- Trusted-click progress proof ignores whole-page text churn and blur-only focus loss; safety vetoes skip automatic retry without rewriting working clicks to failure.

### Fixed
- Removed invalid CDP `Input.enable` usage; trusted mouse events dispatch directly.
- Observation windows for fallback candidates poll progressively so slower SPA handlers can still prove progress before a second click.

### Tests
- Added unit and fixture coverage for eligibility gates, one-shot fallback accounting, network/beacon vetoes, and post-CDP target-state verification.

## [24.3.0] - 2026-07-17

### Changed
- Replaced the first-install fake toolbar walkthrough with a real **Open Side Panel** action in Chromium and **Open Sidebar** action in Firefox.
- Added an accessible Chromium first-open coachmark that points to the browser's actual side-panel pin, mirrors its arrow for left-side layouts such as Vivaldi, and clearly distinguishes that pin from the toolbar icon it adds.
- Kept Firefox guidance aligned with its native Extensions menu and refreshed the install flow across all 16 supported locales.
- Report the browser-resolved absolute path after WebBrain screenshots, recordings, transcripts, and run captures finish saving, including configured subfolders and uniquified filenames.

### Fixed
- Removed non-interactive toolbar and extension-menu illustrations that looked clickable but could not complete setup.
- Sequenced the Chromium pin coachmark before the existing model and safety onboarding so first-time setup has one clear action at a time.
- Kept keyboard focus inside the pin coachmark while it is open and added an explicit **Skip this step** exit so first-run setup cannot strand the user.
- Prevented early install-page clicks from disappearing, kept first-open tabs in the normal WebBrain panel group, and replaced premature success styling with browser-specific recovery guidance.

### Tests
- Added Chrome and Firefox coverage for real panel opening, first-install coachmark state, modal focus handling, explicit dismissal paths, left/right arrow layout, native Firefox wording, responsive behavior, reduced motion, and locale parity.

## [24.2.0] - 2026-07-17

### Changed
- Add Kimi provider support

## [24.1.0] - 2026-07-16

### Changed
- import/export configs

## [24.0.2] - 2026-07-16

### Added
- Added `/export --config` to download a portable JSON snapshot of settings and `/import <json>` or `/import --file` to restore one in Chrome and Firefox.
- Included provider, vision, transcription, and CAPTCHA API keys in configuration snapshots, with an explicit plaintext-secret warning before export and import.

### Changed
- Limited configuration snapshots to settings-backed state, excluding device-bound sync identifiers and tokens, conversations, traces, jobs, and usage counters.

### Tests
- Added mirrored coverage for configuration schema completeness, round trips, validation failures, file selection, slash-command routing, and background import/export handlers.

## [24.0.1] - 2026-07-16

### Added
- Added hidden trailing `/record [--save-as <filename>]` and `/screenshot [--save-as <filename>]` prompt suffixes. Recording now wraps a Chrome run and saves automatically; screenshot capture saves timestamped or custom-named before/after PNGs in Chrome and Firefox. The suffixes remain intentionally absent from `/help` and autocomplete.

### Fixed
- Kept agent-created reference tabs in the background so Chrome and Firefox runs remain visibly attached to their original tab.
- Detected Firefox-protected Mozilla domains before blocked DOM or network reads, used one active-tab screenshot fallback where possible, and stopped equivalent non-retryable attempts instead of looping.
- Treated Responses streams that end without `response.completed` as incomplete instead of persisting partial output as a successful turn.
- Preserved unsaved custom request-body JSON drafts across provider search, filtering, and card re-renders, including temporarily invalid JSON while editing.
- Re-activate the originating run tab before the after screenshot when a run opens another tab.
- Restored Mozilla Add-ons developer adapter matching after the hostname-hardening matcher rename.
- Rebuilt the Chrome, Edge, and Firefox 24.0.1 archives from the final source tree.

### Tests
- Added regression coverage for background tab ownership, Firefox restricted-domain handling, bounded read retries, premature Responses stream termination, and compatibility JSON draft persistence.
- Added mirrored parser, filename sanitization, lifecycle ordering, Downloads saving, Chrome recorder identity, and Firefox unsupported-recording coverage for hidden run capture.

## [24.0.0] - 2026-07-16

### Added
- First-class **GPT-5.6** support for official OpenAI: default model `gpt-5.6-terra`, UI suggestions for Terra / Sol / Luna, and a **1,050,000**-token context window for the `gpt-5.6*` family.
- Official OpenAI GPT-5.6 routes through the **Responses API** (`/v1/responses`) with encrypted reasoning replay (`response_items`), function-call conversion, streaming, and usage normalization. Older models and custom/proxy base URLs stay on Chat Completions.
- **Advanced model compatibility** settings on every provider card: preset (Auto / OpenAI / Qwen / DeepSeek / OpenRouter / Custom), reasoning effort, system vs developer role, max-token field, and safe custom request-body JSON.
- Shared `provider-compatibility.js` layer (Chrome + Firefox) that maps roles, token fields, reasoning knobs, and merges protected extra body fields for OpenAI-compatible, Azure OpenAI, and llama.cpp request builders.
- Documented the release in `WHATS_NEW_IN_V24.md` at the repository root.

### Changed
- OpenAI-compatible request building is centralized so compatibility presets apply consistently without mutating stored chat history.
- OpenAI default cost metadata migrates safely when upgrading from earlier shipped defaults.

### Tests
- Added / retained coverage for Responses routing, reasoning replay, streaming, provider-compatibility merges, GPT-5.6 context windows, and default-model migration.

## [23.3.6] - 2026-07-15

### Added
- Added a default-on **Help Improve WebBrain** control at the bottom of the visible Settings → General area in Chrome and Firefox. WebBrain Compass requests now send the current choice as `X-WebBrain-Help-Improve: 1` or `0`; local-model and bring-your-own API requests never receive that header.

### Changed
- Updated the public privacy policy and developer data-flow documentation to disclose selected WebBrain Compass interaction retention and model-improvement use, the future-interaction opt-out, a 12-month raw-data limit, and a five-year limit for de-identified datasets.
- Added opaque per-conversation WebBrain Compass session grouping across main, planner, compaction, intent, memory, and vision generations, with permanent opt-out tainting and no collection metadata on local or bring-your-own providers.
- Added encrypted, compressed, text-and-tool-only Cloud improvement storage with image omission, authenticated session browsing, de-identified JSONL export, 12-month pruning, and isolated OpenRouter logging/no-logging key routing.

### Tests
- Added mirrored coverage for the default-on UI, persistence and live provider reload, Cloud-only request headers, locale completeness, and privacy-policy retention language.

## [23.3.3] - 2026-07-15

### Changed
- Clarify timeout slider semantics: **0 = Instant** (always auto-select the first option), **1–1200s = wait then auto-select**, and **above 1200s (slider max / Off) = wait indefinitely**. Existing stored `0` (old Off) migrates once to Off.
- Instant clarify auto-selects use `source=auto` and tell the agent to continue (intentional unattended policy, e.g. headless); only waited `source=timeout` keeps the non-confirmation warning.

### Tests
- Updated Chrome and Firefox clarify-timeout coverage for Instant / Off slider endpoints, one-shot semantics migration, and Instant vs waited-timeout agent notes.

## [23.3.2] - 2026-07-15

### Added
- Added a configurable clarify auto-timeout (default 60s, 0–1200s under Settings → General → Advanced) for Chrome and Firefox. Unanswered `clarify` prompts auto-select the first option (or a timeout marker when options are empty); permission and form-submit confirmations stay untimed.

### Changed
- Documented that timeout auto-selects are not real user confirmations in the `clarify` tool schema and system prompts, and kept timeout answers out of user-memory extraction.

### Fixed
- Cleared scheduled-job `needs_user_input` / `pendingClarify` on clarify auto-timeout without replaying a start-of-run `running` event that could orphan the original assistant bubble.
- Restarted clarify countdown metadata after sidepanel restore/rebind so closed panels do not leave stale open cards.

### Tests
- Added Chrome and Firefox regression coverage for clarify timeout settings, schema/prompt guidance, scheduler wait-state cleanup, restore countdown metadata, and memory exclusion of timeout sources.

## [23.3.1] - 2026-07-15

### Changed
- Added bounded canonical semantic intents to the shared on-demand skill catalog so the planner and `load_skill` can route multilingual requests without literal keyword matching or an extra embedding call.
- Let approved Act plans activate validated skill IDs before execution, with Dev inheriting Act-compatible skills, Ask limited to explicitly compatible skills, and Compact remaining skill-free.
- Added recording and exporting WebBrain versions to new traces, conversation Markdown, trace Markdown, and Traces-page JSON while labeling legacy recording versions unavailable.

### Fixed
- Redirected single-media browser download attempts to an eligible inactive FreeSkillz skill, including exact-permalink discovery on feeds and profiles, while preserving browser fallback only after a real server failure or unavailable skill.
- Prevented the agent path from saving split or unverifiably muxed MSE audio/video buffers or presenting ffmpeg and login advice as a successful result.

### Tests
- Added Chrome and Firefox coverage for intent normalization and catalog isolation, planner activation and rejection, multilingual routing metadata, inactive-skill redirects, strict MSE refusal, and versioned current and legacy exports.

## [23.3.0] - 2026-07-15

### Changed
- Load browser skills on demand

## [23.2.2] - 2026-07-15

### Changed
- Made enabled skills available on demand: Mid/Full Ask, Act, and Dev runs receive a small eligible name/summary catalog, full instructions and compatible tools load only for the current relevant run, and Compact exposes no skill surface.
- Added optional prompt-stripped `webbrain-skill` metadata for capped summaries and explicit Ask/Act compatibility while preserving existing skill storage and `webbrain-tools` manifests.

### Fixed
- Replaced ambiguous Content-Disposition filename matching in Chrome and Firefox public-media downloads with a bounded single-pass parameter parser that preserves RFC 5987 precedence and fails closed on malformed quoted values.

### Tests
- Added mirrored coverage for skill catalog eligibility, activation isolation and reset, strict-secret ordering, recommended-action preactivation, and adversarial Content-Disposition filename parsing.

## [23.2.0] - 2026-07-14

### Added
- Added an opt-in packaged Litterbox temporary file-share skill for Chrome and Firefox, available from Settings with explicit `clarify` confirmation, public-link and absolute-expiry warnings, blocked-file preflight checks, browser-specific upload limits, and visible provider attribution. Uploads go through the Litterbox page with `upload_file`, so no `/allow-api` override is needed and file bytes never reach the LLM provider.
- Added opt-in Open-Meteo weather and Open Library book-search skills for Chrome and Firefox. The read-only, no-key integrations clarify ambiguous locations, keep metric and imperial weather units consistent, limit catalog responses, treat provider data as untrusted, and show visible source attribution.
- Added disabled-by-default Together AI and Fireworks OpenAI-compatible router providers for Chrome and Firefox, including Settings fields, suggested models, configurable endpoints, API-key links, and streaming-usage support.

### Changed
- Classified Together AI and Fireworks consistently as router providers and migrated older saved category values without dropping stored credentials.

### Fixed
- Prevented host-page capture listeners from intercepting keyboard input inside the selection shortcut by loading its containment handler at `document_start` and isolating keydown, keypress, and keyup events.
- Kept the selected text visibly highlighted while the selection menu is open, bounded the overlay to 200 visible rectangles, and cleared highlights when the menu closes or is dismissed.

### Tests
- Added packaged-skill catalog and Litterbox safety, privacy-disclosure, upload-flow, browser-limit, and expiry coverage.
- Added Chrome and Firefox coverage for Open-Meteo units and tool manifests, Open Library search and attribution, Together AI and Fireworks provider defaults and migrations, and selection-shortcut keyboard containment and bounded highlights.

## [23.1.2] - 2026-07-14

### Added
- Added universal `<command> --help` support for slash commands, returning the selected command's usage, description, and available options directly in chat.
- Published the WebMCP integration blog post.

### Fixed
- Made Enter accept highlighted slash-command flag completions such as `/schedule --list` without prematurely executing the parent `/schedule` command.
- Restored intentional localized formatting in trusted composer toasts while keeping dynamic error text escaped.

### Tests
- Added Chrome and Firefox regression coverage for command-specific help, flag autocomplete ordering and completion, invalid mixed help flags, and trusted toast rendering.

## [23.1.0] - 2026-07-14

### Added
- Added `/export --traces` in Chrome and Firefox to download the current conversation's recorded planner turns, assistant prose, and tool calls as privacy-scrubbed Markdown while keeping `/export` messages-only.
- Added safe syntax highlighting for fenced Markdown code blocks in both side panels across JavaScript, CSS, markup, JSON, Python, shell, SQL, YAML, and C-like languages.
- Published the NVIDIA GLM-5.2 planner benchmark blog and complete frozen, Full, Mid, and Compact 100-case result sets.

### Changed
- Consolidated overlapping slash commands around canonical commands and flags, including `/schedule --list`, `/scratchpad --append` / `--clear`, `/memory --add` / `--forget`, `/screenshot --full-page`, `/record --full-screen` / `--transcribe`, and `/export --traces`, with flag-aware help and autocomplete.
- Changed Mail.tm inbox waits to perform one immediate check and use scheduled resumes for later checks instead of polling inside an active run.

### Fixed
- Sequenced and coalesced managed Chrome cloud-run updates while applying size limits, image omission, and sensitive-key redaction to persisted and live text-delta data.
- Guided Chrome and Firefox Gmail draft replacement through one clearing `set_field` call followed by verification, avoiding fragile click-and-keyboard clearing flows.
- Brought non-English Chrome and Firefox slash-command help and permission copy to parity with the English command lists and keyboard shortcuts.
- Corrected the GLM-5.2 benchmark result links.

### Tests
- Expanded regression coverage for trace export privacy and ordering, canonical slash-command flags, Markdown highlighting, scheduled inbox waits, Gmail draft replacement, locale parity, and managed cloud update sequencing and scrubbing.

## [23.0.4] - 2026-07-13

### Added
- Added an opt-in packaged Mail.tm disposable email skill for Chrome and Firefox, available from Settings with explicit confirmation, honest session-retention guidance, automatic account cleanup, and visible provider attribution.
- Added nine Chrome Dev-mode tools for reversible CSS/DOM experiments and page diagnosis: `inject_css`, `remove_injected_css`, `patch_element`, `revert_patch`, CDP-backed `execute_js`, `read_console`, `inspect_network_requests`, `inspect_event_listeners`, and `highlight_element`.

### Fixed
- Stopped Chrome Dev diagnostic handlers, buffers, and their Runtime/Log/Network CDP domains when leaving Dev mode, and enabled the same capture lifecycle for streaming runs.
- Bounded Chrome `execute_js` evaluation to 15 seconds, made CSS undo handles unique and document-bound, and canonicalized structured element patch names before recording reversible state.
- Propagated Chrome CDP callback failures from `chrome.runtime.lastError`, so timed-out or rejected `execute_js` evaluations report failure instead of an empty successful result.
- Redacted common API, subscription, access, auth, and client key header-name variants before Dev network diagnostics enter the in-memory buffer.
- Blocked `javascript:` form actions in structured element patches and permission-gated event-listener inspection and element highlighting because both briefly mutate live DOM.
- Disabled diagnostics on every tracked Dev tab when leaving panel-wide Dev mode, cleaned up exact injected CSS across navigation races, and followed open-shadow hosts when inspecting ancestor event listeners.

### Tests
- Added packaged-skill catalog, opt-in Settings, and Mail.tm safety/API cleanup coverage.
- Added Dev-only exposure, bounded CDP execution, diagnostic lifecycle, sensitive-header redaction, document-safe CSS undo, canonical element patching, permission classification, and state-change coverage for the new Chrome Dev toolkit.

## [23.0.2] - 2026-07-13

### Added
- Added `upload_file` tool support for Firefox WebBrain extension, including sidepanel-based user file picker flow and `downloadId` re-fetch flow with 25MB file size limit.
- Added a selection shortcut for Chrome and Firefox with Summarize, Explain, Quiz me, Proofread, Translate, and custom WebBrain prompts.
- Expanded the native selection context menu with matching preset actions, translation languages, and direct side-panel access.
- Added a persistent setting to hide or restore the floating selection shortcut.
- Added the managed cloud-browser bridge for API-driven run, status, abort, active-tab control, and validated structured results.

### Changed
- Simplified the selection shortcut to a compact purple question-mark icon.
- Added direct Chrome, Firefox, and Edge store links to the English, French, and Chinese README introductions.

### Tests
- Added prompt-safety, browser-specific delivery, duplicate-submission, viewport, keyboard, persistence, translation, and screenshot-suppression coverage.

## [23.0.0] - 2026-07-12

### Added
- Added subscription resume action, including scheduled resume task detection, mode sync before resume, and render subscription actions for restored runs.

### Changed
- Injected trusted runtime clock into agent runs for reliable scheduling.
- Kept runtime context out of planner history and stripped runtime context from derived task state.
- Preserved mode for subscription error resumes.

## [22.4.0] - 2026-07-11

### Changed
- Open Local screenshot PII redaction before vision

## [22.3.0] - 2026-07-10

### Changed
- fast suggested actions

## [22.2.3] - 2026-07-10

### Added
- Added Azure OpenAI and AWS Bedrock (Converse) providers in Chrome and Firefox, including Settings fields, provider manager wiring, docs, and regression coverage.
- Added encrypted profile sync for providers, profile settings, memory, and auxiliary providers, with email auth, local password unlock, merge recovery, reset, and change-password controls.
- Added Hebrew app localization and refreshed localized app and website copy.
- Added GitHub funding metadata and refreshed the WebBrain logo, store listing, banner, favicon, social-card, and website image assets.

### Changed
- Updated local model setup guidance and provider context-window detection for llama.cpp, Ollama, and LM Studio so live runtime windows can replace defaults while respecting manual overrides.
- Updated release metadata, Settings subtitle versions, Chrome / Firefox manifests, architecture docs, and rebuilt Chrome, Edge, and Firefox release archives for 22.2.3.

### Fixed
- Fixed local model context-window detection, including stale detection writes and over-reported windows from loaded local backends.
- Hardened encrypted profile sync around disabled edits, vault KDF reuse, lock and logout flows, legacy sync migration, and remote apply conflicts.

### Tests
- Expanded regression coverage for Azure OpenAI, AWS Bedrock, encrypted profile sync, sync recovery and consent flows, local context-window detection, Hebrew localization, and refreshed logo assets.

## [22.1.2] - 2026-07-10

### Added
- Added search to the providers list.
- Added local user memory for Chrome and Firefox, including `/remember`, `/show-memory`, `/forget-memory`, Settings/Profile management, bounded prompt injection, JSON export/import, and opt-in post-turn auto-learning.

## [21.7.0] - 2026-07-08

### Changed
- remove claude subscription, add huggingface inferencing

## [21.6.0] - 2026-07-08

### Changed
- added history

## [21.5.0] - 2026-07-05

### Changed
- planner ux improved

## [21.4.0] - 2026-07-05

### Changed
- Gate form submissions behind fresh confirmation

## [21.3.0] - 2026-07-05

### Changed
- Add sidepanel slash output retry UX

## [21.2.0] - 2026-07-05

### Changed
- Add in-chat store review prompt (Chrome + Firefox)

## [21.1.0] - 2026-07-05

### Changed
- Suppress duplicate assistant prose during tool calls

## [21.0.0] - 2026-07-05

### Added
- Added Dev Mode.

## [20.7.0] - 2026-07-05

### Changed
- clear convo warning message added

## [20.6.0] - 2026-07-05

### Changed
- Guarded scheduled resumes with the progress ledger so resumed runs can preserve and surface task progress before continuing.

## [20.5.5] - 2026-07-04

### Changed
- UX refinements: shortened the Chrome and Firefox Act-mode warning banner across all app locales to focus on the risk notice.
- Removed the verbose tool-log button from the Chrome and Firefox sidepanel header to reduce clutter; verbose mode remains available from Settings and the `/verbose` slash command.
- Updated release metadata, Settings subtitle versions, Chrome / Firefox manifests, package versions, and browser architecture docs for 20.5.5.

## [20.5.2] - 2026-07-04

### Changed
- Reduced the Chrome and Firefox sidepanel composer plus and microphone button hit areas from 32px to 28px while keeping the icon size and send button unchanged.
- Updated release metadata, Settings subtitle versions, Chrome / Firefox manifests, package versions, and browser architecture docs for 20.5.2.

### Fixed
- Completed missing Chrome and Firefox UI locale strings for attachments, microphone controls, queued composer messages, progress-ledger output, recording copy, and voice-input settings.
- Completed localized website share and footer social labels for Mastodon and Bluesky across the generated locale pages.
- Synced localized busy-run slash-command notices so every app locale lists `/check-progress` as an immediate command alongside the other allowed commands.

### Tests
- Updated Chrome and Firefox regression coverage for the busy-run slash-command notice and verified the full test suite plus prompt-injection corpus.

## [20.5.0] - 2026-07-04

### Added
- Added `/check-progress` in Chrome and Firefox so users can show the current tab's progress ledger from the slash-command menu, including session details, row counts, and the ledger rows.

### Changed
- Raised JSON, TXT, and CSV text attachment uploads from 512 KB to 5 MB in Chrome and Firefox while keeping injected file text bounded to the active provider's remaining context.
- Budgeted text attachments against the pruned prompt and reserved overhead, splitting available context across multiple attachments and marking truncated files as partial content when only the beginning can fit.
- Updated release metadata, Settings subtitle versions, Chrome / Firefox manifests, package versions, and browser architecture docs for 20.5.0.

### Tests
- Updated Chrome and Firefox regression coverage for 5 MB text-attachment caps, provider-context truncation, late text uploads in long chats, and partial-content notices that omit over-budget tail text.

## [20.4.1] - 2026-07-04

### Changed
- Moved the sidepanel pills to the middle of the sidepanel.

## [20.4.0] - 2026-07-03

### Changed
- mastodon hardening, and  broader agent hardening around progress-ledger safety and malformed tool-call arguments

## [20.3.0] - 2026-07-03

### Changed
- new feature: accept text attachments in the sidepanel

## [20.2.0] - 2026-07-03

### Added
- Added `/dangerously-skip-permissions` in Chrome and Firefox so users can disable permission prompts directly from the side panel without opening Settings.
- Kept `/dangerously-skip-permissions` available during active runs and have it resolve any pending permission prompt for the initiating tab with a one-time allow so the blocked run can continue immediately.
- Added the Star History embed to the website so visitors can inspect WebBrain repository star growth from the homepage.

### Changed
- Updated slash-command help, autocomplete, busy-run notices, and localized warning copy for the new permission-skipping command.
- Updated release metadata, Settings subtitle versions, Chrome / Firefox manifests, package versions, and browser architecture docs for 20.2.0.

### Tests
- Added Chrome and Firefox regression coverage for the new slash command, out-of-band busy-run availability, storage-backed permission gate disabling, active permission prompt resolution, localized busy notices, and website Star History rendering.

## [20.1.0] - 2026-07-03

### Changed
- Raised the built-in WebBrain Compass provider context window to 1,000,000 tokens in Chrome and Firefox, while migrating stored legacy 256k configs forward without dropping saved API keys.
- Scaled the agent's soft context character and message budgets from the active provider token budget, so 1M-context providers no longer compact at the legacy 80k-character or 50-message limits.
- Updated release metadata, Settings subtitle versions, Chrome / Firefox manifests, package versions, and browser architecture docs for 20.1.0.

### Tests
- Added Chrome and Firefox regression coverage for the WebBrain Compass 1M default, legacy context-window migration, adaptive character/message context budgets, and large-window conversations avoiding premature compaction.

## [20.0.0] - 2026-07-03

### Added
- Added Chrome-only `/record-full-screen` as a slash-only screen/window recording flow that uses the offscreen recorder's `getDisplayMedia()` picker and records without the live WebBrain recording banner.
- Added double-Escape recording stop handling on Chrome WebBrain/browser surfaces, with hidden recordings covered by a background-owned 2-hour safety cap.
- Added `--transcribe` for `/record` and `/record-full-screen` so user-driven recordings can still save a Whisper transcript after stop.

### Changed
- Removed model-callable `record_tab` and `stop_recording`; recording is now user-driven through `/record`, `/record-full-screen`, optional `--transcribe`, browser stop controls, or double Escape.
- Reserved retired recording tool names in Chrome and Firefox so custom skills cannot reintroduce them, and updated agent prompts to point users to slash commands instead of tools.
- Changed Plan before Act to default unset storage to `try` while preserving explicit `off`.
- Updated release metadata, Settings subtitle versions, Chrome / Firefox manifests, package versions, and browser architecture docs for 20.0.0.

### Fixed
- Kept Firefox from advertising `/record-full-screen` while returning a clear unsupported message if the command is typed manually.

### Tests
- Added Chrome and Firefox regression coverage for recording tool removal, retired-name/custom-skill blocking, slash parser ordering, Chrome-only full-screen recording, hidden full-screen recording UI, double-Escape stop routing, and Plan-before-Act default `try`.

## [19.3.0] - 2026-07-02

### Added
- Added Chrome and Firefox side-panel microphone dictation controls with per-browser permission handling, interim transcript cleanup, and clear disabled states when speech recognition is unavailable or turned off.
- Added Chrome and Firefox side-panel file attachments for images, PDFs, JSON, and text files, including attachment preview chips, remove controls, tab-scoped pending attachments, and send-button gating while file reads are still in flight.

### Fixed
- Fixed attachment rejection handling so unsupported attachments are restored to the correct tab without scraping assistant text, while uploaded user attachments carry an explicit untrusted-content boundary before being sent to the model.
- Fixed Chrome microphone denial handling so the mic icon returns to its idle state and permission-denied state does not spam repeated system messages.
- Fixed Anthropic Claude Opus 4.8 requests by omitting unsupported non-default `temperature` parameters while keeping temperature for Claude Sonnet 4.6.

### Tests
- Added Chrome and Firefox regression coverage for tab-scoped attachment state, pending-read send gating, rejected-attachment restoration, text-attachment size limits, uploaded image/document boundaries, microphone icon reset, and Anthropic Opus 4.8 temperature handling.

## [19.2.0] - 2026-07-02

### Added
- Added a Chrome and Firefox side-panel message queue so normal composer messages sent while WebBrain is busy are kept per tab, shown above the composer, and can be edited or deleted before they run.

### Changed
- Kept `/help`, `/show-scratchpad`, `/list-schedules`, `/screenshot`, `/export`, and `/verbose` available as immediate slash commands during active runs while other slash commands show the queued-message busy notice.
- Updated release metadata, Settings subtitle versions, Chrome / Firefox manifests, package versions, and browser architecture docs for 19.2.0.

### Fixed
- Fixed queued-message editing so pressing ArrowUp in an empty composer pulls the latest queued message back into the composer before it runs.

### Tests
- Added Chrome and Firefox regression coverage for busy-run message queueing, queued-message edit/delete controls, per-tab queue draining, safe busy slash commands, and localized busy notices.

## [19.1.0] - 2026-07-02

### Added
- Added Ollama launch handoff integration for Chrome and Firefox so `webbrain.one/launch/ollama` links can configure the local Ollama provider, activate it, and carry over the selected model, loopback `/v1` base URL, and context window.

### Changed
- Updated release metadata, Settings subtitle versions, Chrome / Firefox manifests, package versions, and browser architecture docs for 19.1.0.

### Tests
- Added Chrome and Firefox regression coverage for Ollama launch handoff validation, loopback URL restrictions, provider activation, and launch-page content-script behavior.

## [19.0.11] - 2026-07-02

### Changed
- Updated release metadata, Settings subtitle versions, Chrome / Firefox manifests, package versions, and browser architecture docs for 19.0.11.

### Fixed
- Fixed Settings -> Providers -> Load Models for local providers so loaded models appear in a centered picker dialog without replacing an existing model value until the user chooses one.
- Replaced raw HTML 404 model-list errors with the concise local-server status when a local model server is not running.
- Guarded repeated model-load completions so an already-open loaded-model dialog is not reopened.

### Tests
- Added Chrome and Firefox regression coverage for loaded-model dialog rendering, localized dialog copy, stale option clearing, concise HTML 404 handling, centered dialog styling, and repeated dialog-open handling.

## [19.0.0] - 2026-07-01

### Added
- Added the new Skills infrastructure for Chrome and Firefox: Settings -> Skills can import trusted skill text or HTTPS skill URLs, store enabled skills in browser local storage, append enabled skill instructions to the agent system prompt, and show/remove declared skill tools.
- Added `webbrain-tools` manifest support so enabled skills can declare runtime tools without hard-coding them into the static tool table. Skills can expose read-only HTTPS GET/POST tools and Act-only `httpDownloadJob` tools with create, poll, file, and cleanup endpoints.
- Added a bundled FreeSkillz.xyz skill, enabled by default and removable from Settings -> Skills, with `read_youtube_transcript`, `resolve_public_media`, and `download_public_media` for public YouTube transcripts and public social/media URLs.
- Added skill-aware tool hydration before provider setup and scheduled runs so imported and packaged skill tools are available consistently in normal and resumed agent sessions.

### Changed
- Updated README, adding-a-tool, architecture, privacy/data-flow, prompt-injection, security-model, and browser architecture docs for custom skills, skill tool trust boundaries, bundled FreeSkillz behavior, and the removal of the stale root extension manifest.
- Updated release metadata, Settings subtitle versions, Chrome / Firefox manifests, package versions, and browser architecture docs for 19.0.0.
- Kept skill HTTP requests cookie-free with `credentials: "omit"`, nested provider payloads under untrusted result data, and documented that importing or keeping a skill enabled is the trust decision for its declared HTTPS endpoint.

### Fixed
- Hardened skill imports and skill tool calls against unsafe endpoints, oversized imports, opaque or cross-origin redirects, blocked local/internal destinations, and provider fields such as `done`, `_attachImage`, or `_attachDocument` escaping into internal tool-result control fields.
- Hardened download-job skill tools so they are Act-only by default, stay behind the normal Downloads permission gate, handle pending browser downloads without prematurely deleting provider jobs, clean up provider jobs on early failures, validate file/final URLs, reject file redirects and non-2xx file responses, and support GET-only file endpoints without requiring HEAD.
- Reworked skill media saving to avoid cookie-bearing browser downloads against provider domains by fetching files with omitted credentials, validating the response URL before saving, and capping cookie-free data-URL saves at 25 MiB so large media fails cleanly instead of buffering unbounded data in the service worker.
- Required explicit URLs for read-only public media resolution so broad social-media allowlists do not silently send the active tab URL to FreeSkillz from Ask mode.

### Tests
- Added Chrome and Firefox regression coverage for skill import/storage limits, packaged-skill seeding and refresh, Settings -> Skills UI behavior, scheduled-run skill hydration, runtime skill tool schemas, Ask/Act/Compact mode filtering, untrusted skill result wrapping, endpoint and redirect validation, and skill response trimming.
- Added FreeSkillz transcript/media coverage for supported URL allowlists, public media resolve requirements, download-job lifecycle, pending cleanup, unsafe final URLs, blocked redirects, failed file requests, GET-only file endpoints, cookie-free file fetches, and oversized media rejection.

## [18.3.0] - 2026-06-29

### Changed
- Deleted the stale root `manifest.json` and updated Chrome setup docs, version bumping, and release workflows to use `src/chrome/manifest.json` and `src/firefox/manifest.json` as the only extension manifests.

## [18.2.0] - 2026-06-28

### Changed
- edge store preparations

## [18.1.0] - 2026-06-28

### Changed
- Added: Tune context compaction thresholds

## [18.0.4] - 2026-06-27

### Fixed
- Prevented stale repeated `fetch_url` loop entries from hard-stopping the agent after it switches to a different tool, such as falling back from failed API calls to `click_ax`.
- Collapsed repeated failed mutating API calls in one assistant batch into a single failed API strategy for loop detection, while keeping `/allow-api` as the required opt-in for API mutations.
- Reasserted the active viewport glow after tab reloads during a running task so the visual run indicator comes back when the content script reloads.

### Tests
- Added Chrome and Firefox regression coverage for stale URL-tool loop pivots, failed API mutation batches, and active viewport glow reassertion after reload.

## [18.0.3] - 2026-06-27

### Changed
- Replaced the Plan before Act checkbox with Planner modes: Try planning by default, Strict planning for fail-closed approval, and Off.
- Made Try planning continue into Act mode without a pinned plan when the planner cannot produce valid structured JSON, so the default planner path no longer cancels the task on planner-format failure.
- Preserved legacy planner storage by mapping unset storage to Try planning, legacy `false` to Off, and legacy `true` to Strict planning.

### Tests
- Added Chrome and Firefox regression coverage for planner mode defaults, legacy migration behavior, try-mode fallback, and strict-mode fail-closed cancellation.

## [18.0.2] - 2026-06-27

### Added
- Added bulk API mutation pattern detection for Chrome and Firefox so repeated successful same-action clicks, such as following many GitHub stargazers, can surface matching background API request shapes before the agent spends one LLM turn per button.

### Changed
- Kept mutating `fetch_url` calls behind the `/allow-api` slash command, including a hard fail-closed path for POST, PUT, PATCH, and DELETE when API mutations have not been explicitly enabled for the conversation.

### Tests
- Added Chrome and Firefox regression coverage for bulk API mutation hints, `/allow-api` hint state, and blocking mutating `fetch_url` calls until `/allow-api` is enabled.

## [18.0.0] - 2026-06-27

### Added
- Added `go_back` and `go_forward` tools for Chrome and Firefox so Act mode can use browser history directly instead of relying on CSP-sensitive page JavaScript.
- Added Plan before Act as a default-on planning gate, including structured planner parsing, a side-panel plan review card, approved-plan scratchpad pinning, scheduled-run auto-approval, and planner trace/provider metadata.
- Added a background API request observer for Chrome and Firefox that detects repeated click-triggered XHR/fetch requests and suggests the matching `fetch_url` method when the UI loop is stuck.

### Changed
- Kept API shortcut detection method-aware for GET, POST, PUT, PATCH, DELETE, and other observed methods while leaving mutating replay decisions to the existing `/allow-api` and UI-vs-API policy.
- Updated README, architecture, adding-a-tool, privacy, prompt-injection, and security docs alongside release metadata, Settings subtitle versions, Chrome / Firefox manifests, and package versions for 18.0.0.

### Fixed
- Fixed Chrome history URL normalization so query-string and hash-only history transitions are treated as real back/forward navigation changes, matching Firefox.
- Prevented API shortcut detection from counting one captured request across multiple overlapping click windows.
- Removed unused planner helper/style code left behind during review cleanup.

### Tests
- Added regression coverage for history navigation tool exposure, permission mapping, URL normalization parity, planner parsing/review/scratchpad/scheduling/trace behavior, API shortcut matching, request-reuse prevention, and prompt-injection corpus parity.

## [17.8.0] - 2026-06-27

### Added
- Added completion confetti for successful Chrome and Firefox tasks, with a Settings toggle and localized labels so users can turn off the celebratory finish.

### Changed
- Updated release metadata, Settings subtitle versions, architecture docs, Chrome / Firefox manifests, and package versions for 17.8.0.

### Fixed
- Fixed side-panel tab race issues by queueing tab-switch updates during restore and preventing stale flushes from writing to the wrong tab conversation.
- Scoped accepted completion and success-confetti updates to the active tab so finished tasks do not trigger stale success UI in another tab.

### Tests
- Added regression coverage for completion confetti settings and rendering, accepted completion gating, and tab-switch restore / flush races.

## [17.7.0] - 2026-06-26

### Added
- Added `/clear-scratchpad` in the Chrome and Firefox side panels so users can clear the current conversation scratchpad from slash-command autocomplete and help.
- Added Cloudflare Workers AI to the provider list with the OpenAI-compatible Workers AI endpoint, default model `@cf/zai-org/glm-5.2`, and a 262k-token context window.

### Changed
- Translated the `/clear-scratchpad` label, help text, and cleared-state message across all supported locales.
- Classified OpenRouter, Cloudflare Workers AI, Nvidia NIM, and Groq under the Router provider bucket in Chrome and Firefox settings.
- Added a dedicated Cloudflare account ID field and URL validation so the Workers AI provider substitutes the account into the API base URL before testing or chatting.
- Updated release metadata, Settings subtitle versions, architecture docs, Chrome / Firefox manifests, and package versions for 17.7.0.

### Fixed
- Migrated saved OpenRouter, Cloudflare Workers AI, Nvidia NIM, and Groq provider categories to Router so upgraded installs do not keep older Cloud filter state.

### Tests
- Added regression coverage for the synchronous scratchpad clear path, locale coverage for `/clear-scratchpad`, Cloudflare defaults, context-window inference, and the Router provider bucket.

## [17.6.0] - 2026-06-26

### Added
- Added a copy button to `/show-scratchpad` output in the Chrome and Firefox side panels so users can copy just the scratchpad contents.
- Added WebBrain blog coverage and benchmark result files for raw LFM 2.5 230M and 350M on the frozen 100-case browser-agent planner harness.

### Changed
- Updated the tiny LFM benchmark conclusion and refreshed release metadata, Settings subtitle versions, architecture docs, Chrome / Firefox manifests, and package versions for 17.6.0.

## [17.5.0] - 2026-06-26

### Added
- Added async out-of-band slash-command handling in the Chrome and Firefox side panels, allowing `/help`, `/show-scratchpad`, `/list-schedules`, `/screenshot`, `/export`, and `/verbose` to run while WebBrain is busy.

### Changed
- Updated release metadata, Settings subtitle versions, architecture docs, Chrome / Firefox manifests, and package versions for 17.5.0.

### Fixed
- Preserved drafts and autocomplete/send-button state when users try slash commands during active runs, with a localized busy notice for commands that need to wait.

## [17.4.0] - 2026-06-25

### Added
- Added `/edit-scratchpad <text>` in the Chrome and Firefox side panels so users can append notes to the current conversation scratchpad from slash-command autocomplete and help.

### Changed
- Updated release metadata, Settings subtitle versions, architecture docs, Chrome / Firefox manifests, and package versions for 17.4.0.

## [17.3.0] - 2026-06-24

### Fixed
- Replaced the Firefox extension toolbar/sidebar icon PNGs with the Chrome brain artwork and refreshed the packaged Firefox archive so Firefox no longer shows the old purple round icon.

## [17.2.0] - 2026-06-24

### Added
- Added XML-style raw tool-call parsing for Chrome and Firefox so local/chat-template models that emit `<tool_call><function=...><parameter=...>` output can execute tools instead of returning raw markup.
- Added a WebBrain Compass billing panel in Chrome and Firefox settings with device-bound Stripe account links, localized account copy, and expanded WebBrain Compass provider notes for subscription, billing, and privacy links.
- Added Polish UI locale support for the Chrome and Firefox settings/payment flows.

### Changed
- Updated WebBrain Compass `/subscribe` URLs and 402 allowance messages to include the device GUID as Stripe `client_reference_id`, and made the subscribe page require a device-bound link before redirecting to checkout.
- Reworded the subscribe fallback page to tell users with outdated extension links to update the browser plugin.
- Documented the newer slash commands in the English, French, and Chinese README files.
- Updated release metadata, Settings subtitle versions, architecture docs, Chrome / Firefox manifests, and package versions for 17.2.0.

### Fixed
- Purged legacy `auth.webbrain.one` token, email, and default-model storage during settings startup now that WebBrain Compass billing is device-GUID based.
- Firefox side-panel message bubbles now expose copy buttons on user messages, with styling that remains legible on accent-colored bubbles.
- Suppressed streamed raw tool-call text before rendered tool steps, so fallback tool calls do not linger as assistant text.

### Tests
- Added regression coverage for XML-style tool-call parsing/execution and raw tool-call stream suppression in Chrome and Firefox.

## [17.1.0] - 2026-06-24

### Added
- Introduced a better payment UI for WebBrain Compass: the quota-exceeded error now surfaces a Subscribe button that links users directly to upgrade their plan, with the button persisting and rebinding across chat restores.

### Changed
- Translated the Subscribe button strings into all supported locales.

## [17.0.0] - 2026-06-23

### Changed
- Updated provider placeholder models in Chrome and Firefox settings to reflect newer model options.
- Marked conversation export as completed in the README roadmap and noted that conversation import is not planned.
- Updated release metadata, Settings subtitle versions, architecture docs, Chrome / Firefox manifests, and package versions for 17.0.0.

### Removed
- Removed Chrome `execute_js` tool dispatch support so Chrome only exposes and dispatches the advertised tool set.

### Fixed
- Hardened Chrome and Firefox side-panel tab state so async slash commands, suggested actions, scheduled actions, restored controls, tab-chat saves, and pending tab switches stay scoped to the initiating tab instead of updating stale panels.
- Made settings and side-panel provider activation/status updates handle async failures, stale checks, invalid stored provider IDs, unsupported stored providers, and persisted preference changes more reliably.
- Improved context-menu prompt persistence and retry handling so prompts survive storage races, pending tab switches, failed tab switches, abort timeouts, and concurrent deferred writes without replaying stale content.
- Stabilized trace rendering, trace export downloads, side-panel export downloads, Chrome offscreen proxy recovery, and Chrome tab-chat persistence after clears.
- Scoped allow-api state to tab conversations and cleared Firefox transient tab state on reset.

### Security
- Escaped dynamic system messages and trace-viewer attribute data, rendered verbose tool names as text, avoided selector interpolation in settings tabs, rejected unknown provider updates, and validated stored provider IDs before use.

### Tests
- Added regression coverage for side-panel tab scoping, settings/provider async status handling, context-menu prompt queuing and retries, scheduled action tab isolation, export/download stability, provider validation, trace rendering, and Chrome advertised-tool dispatch.

## [16.0.0] - 2026-06-23

### Added
- Added Chrome and Firefox context-menu integration: right-click selected page text and choose "Ask WebBrain about this" to open the WebBrain panel and submit the selection as untrusted page content.

### Changed
- Marked keyboard shortcuts and context menu integration as completed in the README roadmap.
- Updated release metadata, Settings subtitle versions, architecture docs, Chrome / Firefox manifests, and package versions for 16.0.0.

### Fixed
- Context-menu prompts now survive service-worker and panel timing races until the chat request is accepted, then clear only after the background receives the request so prompts are neither lost before submission nor replayed after panel reopen.
- Context-menu prompts are now queued while a run is processing or when they target another tab, drain after Continue finishes or the matching tab becomes active, and are discarded on navigation or tab close so stale selections are not submitted against the wrong page.

### Tests
- Added Chrome + Firefox side-panel regression coverage to ensure queued context-menu prompts drain after Continue clears the processing state.

## [15.6.0] - 2026-06-23

### Changed
- Filled 22 missing UI locale keys across all 13 supported non-English locales in both Chrome and Firefox.
- Updated release metadata, Settings subtitle versions, architecture docs, Chrome / Firefox manifests, and package versions for 15.6.0.

### Fixed
- Agent-created scheduled current-tab tasks on HTTP(S) pages now persist as URL targets, so scheduled runs can navigate back to the original page instead of failing after the tab changes.
- Legacy agent-created current-tab scheduled tasks now migrate to URL targets during alarm restoration while preserving their scheduled alarms.

### Tests
- Added Chrome + Firefox scheduler coverage for agent-created current-tab URL target normalization, legacy scheduled-task migration on restore, and navigated scheduled task completion.

## [15.5.0] - 2026-06-23

### Changed
- Updated release metadata, Settings subtitle versions, architecture docs, Chrome / Firefox manifests, and package versions for 15.5.0.

## [15.4.0] - 2026-06-23

### Added
- Chrome now registers `Alt+Shift+W` as the default extension keyboard shortcut for opening the WebBrain panel.

### Changed
- Updated release metadata, Settings subtitle versions, architecture docs, Chrome / Firefox manifests, and package versions for 15.4.0.

## [15.3.0] - 2026-06-23

### Changed
- Updated release metadata, Settings subtitle versions, architecture docs, Chrome / Firefox manifests, and package versions for 15.3.0.
- Scheduled-job busy retries now stagger same-target queued runs so simultaneous alarms do not keep retrying at the same instant.

### Fixed
- Scheduled resume and task creation now dedupes near-identical live jobs within a two-minute window, returning the existing job instead of creating duplicate alarms.
- Startup alarm restoration now coalesces stored near-duplicate scheduled jobs by keeping the earliest matching live job and cancelling later duplicates.

### Tests
- Added Chrome + Firefox scheduler coverage for duplicate resume/task creation, duplicate-window boundaries, staggered busy retries, and restore-time duplicate coalescing.

## [15.2.2] - 2026-06-23

### Fixed
- Scheduled recurring tasks can now start immediately when their first run is due now.

## [15.2.1] - 2026-06-23

### Changed
- Max Agent Steps settings copy now explains that the `∞` slider position means unlimited steps in every supported Chrome and Firefox locale.
- `/schedule` now accepts `0` minutes for standalone scheduled tasks, treating it as "start now" while keeping nonzero future delays at the existing one-minute minimum.

### Fixed
- Max Agent Steps now treats the Settings slider maximum (`200`) as the unlimited sentinel instead of a finite cap, migrates stale stored `200+` values to `maxAgentSteps: 0`, and keeps the continue bar from displaying unlimited (`0`) as the default step count.

### Tests
- Added regression coverage to ensure `0`, `200`, and values above `200` remain unlimited in both browser builds, and that all max-step locale descriptions mention the `∞` setting.
- Added scheduler coverage for zero-delay tasks and the `/schedule` composer accepting an immediate relative delay.

## [15.2.0] - 2026-06-22

### Added
- Jan, vLLM, and SGLang as built-in local providers (Chrome + Firefox). All three use OpenAI-compatible `/v1` endpoints (Jan on port 1337, vLLM on port 8000, SGLang on port 30000), support model listing via `/v1/models`, accept an optional API key for auth-enabled servers, and default to enabled with vision on and a 16 K context window.

### Changed
- Onboarding local-model detection copy now lists Jan, vLLM, and SGLang alongside LM Studio, Ollama, and llama.cpp.
- LLM request-timeout settings description and provider info panel updated to cover all six local backends.
- Updated documentation (README, architecture docs, providers guide) to reflect the expanded local-provider lineup.

### Tests
- Added coverage for `categoryFor` and `listProviderModels` with Jan, vLLM, and SGLang — including auth header forwarding and model-list deduplication — and for `_defaultConfigs` asserting all three new providers are present, enabled, local-categorized, and localhost-defaulted.

## [15.1.1] - 2026-06-22

### Changed
- Updated release metadata, Settings subtitle versions, architecture docs, Chrome / Firefox manifests, and package versions for 15.1.1.

## [15.1.0] - 2026-06-22

### Changed
- Updated release metadata, Settings subtitle versions, architecture docs, Chrome / Firefox manifests, and package versions for 15.1.0.
- Updated README and architecture docs to describe WebBrain Compass 1.0 as the default managed cloud option and document the scheduled-task system.
- Refreshed release artwork and regenerated packaged Chrome / Firefox submission archives.

### Fixed
- Firefox indexed click and typing actions now resolve against the same full interactive-element ordering shown to the agent, keeping click-by-index and type-by-index stable.
- Firefox indexed actions now handle shadow DOM controls, blocking modal/native dialogs, non-modal dialogs, inert or hidden background controls, stale editable focus, and disabled text inputs more reliably.
- Chrome and Firefox side panels now surface a clear error when the background script returns no response, and avoid dereferencing missing response content while rendering assistant messages.

### Tests
- Added regression coverage for Firefox shadow-DOM indexed clicks and typing, modal and non-modal dialog indexing, disabled/stale editable fallbacks, and missing side-panel background responses.

## [15.0.0] - 2026-06-22

### Added
- Added a Chrome `/record` slash command that starts current-tab recording directly from the side panel with video and microphone capture, plus matching Chrome autocomplete and `/help` text.

### Changed
- Updated release metadata, Settings subtitle versions, architecture docs, Chrome / Firefox manifests, and package versions for 15.0.0.

### Fixed
- Tightened `/record` slash parsing so longer words beginning with `/record` are not treated as recording commands, surfaced recording startup and microphone-capture failures in the Chrome side panel, and made manually typed `/record` in Firefox report that tab recording is unsupported without advertising it in Firefox slash autocomplete or help.

## [14.2.2] - 2026-06-22

### Changed
- Lowered the `schedule_resume` minimum delay from 60 seconds to 30 seconds in Chrome and Firefox, matching the packaged Chrome alarms floor while keeping standalone scheduled tasks at the existing 60-second minimum, and expanded the maximum scheduling window from 1 day to 7 days.
- Completed scheduled-job cards in the side panel now disappear after 15 seconds unless the user clicks the card to keep it visible.
- Updated release metadata, Settings subtitle versions, architecture docs, Chrome / Firefox manifests, and package versions for 14.2.2.

### Tests
- Updated scheduler and side-panel coverage for the shorter 30-second `schedule_resume` delay, seven-day maximum scheduling window, and completed-card auto-hide behavior.

## [14.2.0] - 2026-06-21

### Added
- Slash command autocomplete in the Chrome and Firefox side panels, with keyboard navigation, Tab / Enter completion, Escape dismissal, mouse selection, and accessible listbox metadata for all supported slash commands.

### Changed
- Updated release metadata, Settings subtitle versions, architecture docs, Chrome / Firefox manifests, and package versions for 14.2.0.
- Completed missing translations for all 13 supported languages (Arabic, Spanish, French, Indonesian, Japanese, Korean, Malay, Russian, Thai, Tagalog, Turkish, Ukrainian, Chinese Simplified) across Chrome and Firefox locale files, covering scheduled-task UI strings, scratchpad panel, schedule form, permission verb, tool labels, and settings toggles added in 14.1.0.

### Tests
- Added static Chrome + Firefox coverage to keep the slash command parser and autocomplete command list in sync.



## [14.1.0] - 2026-06-21

### Added
- Scheduled agent work for Chrome and Firefox: `schedule_resume` durably pauses a blocked run and resumes it later in the same tab / conversation, while `schedule_task` creates one-shot or recurring future tasks backed by browser alarms and persisted job state.
- Side panel schedule controls, including `/schedule`, `/list-schedules`, `/show-scratchpad`, an active scheduled-job strip, and Run now / Pause / Resume / Cancel / Delete actions for scheduled jobs.
- Settings toggles for enabling scheduled tasks and requiring confirmation before unattended scheduled runs perform consequential actions.

### Security
- Added a `schedule` permission-gate capability so scheduled future work is treated as a consequential action, with unattended scheduled runs defaulting to confirmation before clicks, typing, navigation, downloads, uploads, recording, or other gated actions.

### Changed
- Full and mid Act-mode prompts now describe the scheduling tools and when they may be used; compact Act mode still forbids scheduling and tells the agent to ask the user to re-invoke WebBrain for external waits.
- Updated release metadata, Settings subtitle versions, architecture docs, Chrome / Firefox manifests, and required `alarms` permissions for 14.1.0.

### Fixed
- Anchor clicks now correctly classify same-page anchors, anchors resolved through `<base href>`, and popup-style placeholder / hash anchors, preventing successful in-page jumps or popup triggers from being reported as failed or stale clicks.

### Tests
- Added Chrome + Firefox coverage for scheduler validation, busy-tab queuing, stale resume / task targets, recurring next-run calculation, scheduled clarifications, tool exposure by prompt tier, schedule slash commands, scratchpad reads, and schedule capability gating.

## [14.0.5] - 2026-06-20

### Changed
- Updated Anthropic defaults and context-window inference for `claude-opus-4-8`.
- Updated release metadata, Settings subtitle versions, architecture docs, and Chrome / Firefox submission archives for 14.0.5.

### Fixed
- Provider Settings numeric fields now preserve valid zero cost estimates while continuing to reject invalid or negative numeric values.

## [14.0.4] - 2026-06-19

### Added
- Suggested actions in the side panel can now be minimized and restored in both Chrome and Firefox. The collapsed preference is saved, so users can reclaim chat space once and keep it that way across panel reloads.

### Changed
- Tightened the Suggested actions panel spacing, chevron control, and action chips to reduce vertical space used above the chat input.
- Updated release metadata, Settings subtitle versions, architecture docs, and Chrome / Firefox manifests for 14.0.4.

## [14.0.0] - 2026-06-18

### Changed
- WebBrain Compass is now the default provider for new WebBrain configurations.
- Updated release metadata, Settings subtitle versions, architecture docs, and Chrome / Firefox manifests for 14.0.0.

### Fixed
- Context compaction now treats screenshots as a bounded vision-token cost and uses a short post-compaction cooldown, preventing screenshot-heavy Chrome and Firefox runs from compacting again on every step.
- Text clicks now ignore hidden ARIA option / menu / tree items and no longer treat editable input values as click labels, preventing collapsed or virtualized options and filter boxes from being selected as false matches.
- Firefox scroll-retry text clicks now reuse the same visibility and editable-value filtering as the primary matcher.

## [13.1.0] - 2026-06-17

### Changed
- Website header GitHub controls now use the star pill as the single repository link, removing the duplicate GitHub CTA across localized website pages.
- Updated release metadata, Settings subtitle versions, architecture docs, and Chrome / Firefox submission archives for 13.1.0.

## [13.0.1] - 2026-06-12

### Fixed
- Screenshot capture now mechanically detects near-blank frames and retries after 500ms, 1000ms, and 1500ms before handing the image to a vision model (Chrome + Firefox). This helps recover from compositor / lazy-load races on media-heavy pages such as Instagram, where the DOM already contains content but the first viewport capture can be all white or all black.

### Changed
- Screenshot probes now include image counts, and screenshot results/traces include `blankFrameRetry` metadata when a blank-frame retry path ran.

### Tests
- Added Chrome + Firefox unit coverage for blank-frame retry gating, successful recovery, and the no-content/no-retry case.

## [13.0.0] - 2026-06-10

### Added
- Downloads now auto-pin to the scratchpad (Chrome + Firefox): every `download_files`, `download_resource_from_page`, `stop_recording` (Chrome), and `download_social_media` success appends a durable `[auto] Downloaded … (downloadId N)` line to the pinned scratchpad, so the file's handle survives context compaction even when the model never calls `scratchpad_write` itself. This closes a failure mode where, on long runs, the saved path fell out of the verbatim context window after older tool results were summarized away and the model invented a wrong upload path (e.g. `/Users/Shared/…`). Pinning is centralized in the tool-execution loop so all download-producing tools are covered uniformly; `download_social_media`, which exposes no per-file id, degrades to a `list_downloads` pointer rather than an invented id.
- `download_files` now resolves and returns each file's local path and completion state in its own result (previously only `list_downloads` carried the path), so the handle is available the moment the download finishes.
- `upload_file` now accepts a `downloadId` as an alternative to `filePath` (Chrome): it resolves the real on-disk path internally, so the model can attach a previously downloaded file by its small integer id without recalling the path. `read_downloaded_file` already accepted a `downloadId`.
- Test coverage (in `test/run.js`) for auto-pin survival across a real context compaction, id-only pinning across the download tools, the `download_social_media` → `list_downloads` fallback, and the `download_files` summary-digest behavior.

### Security
- The auto-pin note is id-only by design: it records the `downloadId` (not attacker-controllable) and no page-derived filename at all, keeping the Content-Disposition-settable basename out of the durable, attended-to scratchpad. This is a prompt-injection boundary — a hostile filename such as `ignore previous instructions and …` must never be persisted as trusted text that outlives the untrusted-content wrapper; the human filename remains recoverable via `list_downloads`. The `download_files` summary digest likewise echoes only the integer `downloadId`s and never the filename, so a malicious `Content-Disposition` header cannot smuggle page text into the trusted trim summary.

### Changed
- Act-mode scratchpad guidance updated: download paths are pinned automatically and files are attached/read by `downloadId`, so the model no longer hand-pins paths or re-downloads to "get the path back".

## [12.0.0] - 2026-06-01

### Added
- "Use your subscription" OAuth (PKCE) sign-in for subscription-backed providers (Chrome + Firefox): OpenAI (ChatGPT) and Google Gemini. OpenAI borrows the Codex CLI's first-party `client_id` (same pattern as the existing Claude flow); Gemini stays honest, requiring the user to register and enter their own Google Cloud OAuth `client_id`. Clients send no headers that impersonate a vendor's first-party CLI, and the settings UI surfaces a disclaimer on every borrowed-client card noting it may be revoked by the vendor at any time.
- Context-aware recommended actions: the agent surfaces actionable recommendations tailored to the current page and runs them directly in Act mode.

### Changed
- Recording recommendation is now hidden on Firefox where it does not apply.

### Fixed
- Social media downloads now focus on the active media: extensionless media URLs get correct video filenames, visible-crop filename extensions are fixed, a visible-media crop fallback was added, main-mode videos are ordered before posters, and focused HTTP / blob video downloads are preferred and preserved.
- Recorder Stop reliably ends stuck or orphaned recordings, with cleared / already-stopped stop results handled and forced-clear stop failures surfaced in the side panel.
- Fixed 6 bugs across the Chrome and Firefox builds.

## [11.0.0] - 2026-05-31

### Added
- Cloud cost allowance controls: per-session spending limits for metered cloud providers. Set a maximum dollar allowance in Settings; spend is estimated from provider-reported token usage (falling back to token counts when usage metadata is absent) multiplied by per-model pricing. Anthropic and Gemini stream usage metadata is now forwarded for accurate accounting, reported zero-cost usage is honored, and local / IPv6 / "cloud-card" local endpoints are treated as unmetered.
- Token-aware automatic context compaction (Chrome + Firefox): the agent now summarizes older turns once the running input-token count crosses ~75% of the active model's context window — not just the legacy 50-message / 80k-char heuristics — and re-checks on every agent-loop iteration so long autonomous runs compact mid-flight. When it compacts, the side panel shows an inline "Context automatically compacted" separator. Providers expose an approximate `contextWindow` (category-aware default: 16k for local backends, 128k for cloud/router; overridable via `config.contextWindow`). Compaction preserves the pinned original user task and never splits an assistant/tool-call pair across the summary boundary; Firefox now digests tool results into the summary at parity with Chrome. Onboarding, README, and the website now recommend a ≥16k context window for local models (8k works with Compact mode).
- `click` progress snapshots now report the affected form control's state (checked / disabled / selected index / `aria-*`) alongside its label and position, so the model and recorded traces can verify the effect of an interaction.
- Test coverage (in `test/run.js`) for trace-driven agent interaction and for untrusted wrapping of `click` / `type_text` results.

### Security
- `click` and `type_text` tool results are now wrapped as untrusted content, so page-derived text returned by an interaction cannot be interpreted as model instructions.

### Changed
- Cloud cost totals are serialized to avoid update races, and stream-usage options are gated by provider support.

### Fixed
- Fixed trace-driven agent interaction issues in the session recorder/replay path (agent loop, tool dispatch, and recorder host).
- Next-prompt size is now projected from reported tokens plus observed conversation growth rather than the model maximum, improving compaction timing.

## [10.0.0] - 2026-05-30

### Added
- Deterministic capability-by-origin permission gate for consequential agent actions, with per-host Allow once / Always / Deny grants.
- Site Permissions settings tab for reviewing and revoking saved capability grants.
- Localized structured permission card across Chrome and Firefox, replacing the previous free-text permission parser.
- Act-mode risk banner that appears when the permission gate is disabled.
- Localized onboarding safety warnings and local-LLM setup flow, including auto-detection for local providers.
- Apple Store site adapter.
- Firefox support for compact Act prompts, including compact tool schema routing and provider opt-in.

### Security
- Wrapped page-derived tool results and model-visible context as untrusted data across page reads, screenshots/OCR, hover/list-download results, PDF passthrough, download-family results, `done` verification fields, and scratchpad-adjacent context.
- Added prompt-injection defense documentation and tests covering the permission gate, untrusted-content registry, and capability classification exhaustiveness.
- Gated outbound GET egress, screenshot-to-disk, `read_pdf({url})`, `record_tab`, resource downloads, iframe actions by frame host, and `set_field({submit})` as both type and click.
- Scoped one-time permission grants to the tab/run and made `/allow-api` waive only mutation egress, not GET-based exfiltration.
- Sanitized page title/URL and PDF title metadata before inserting them into trusted context notes.
- Failed closed when iframe or target hosts cannot be identified for permission checks.

### Changed
- Improved nested-pane scroll targeting, with pane fallback when window scrolling cannot move and editable fields skipped as scroll containers.
- Permission card choices now dismiss immediately, and the Settings permissions list live-refreshes after changes.
- Firefox cached system prompts now refresh on conversation reuse so provider compact/full prompt changes stay aligned with the active tool schema.
- Compact-mode tool allowlists are enforced for both text-parsed and structured tool calls in Firefox.
- Documentation now describes Firefox compact-prompt support and current security/privacy behavior accurately.

### Fixed
- Fixed mobile hero mockup overflow and narrow navbar sizing.
- Fixed Firefox download-card wrapping.
- Fixed permission-option click handling so exact options are checked before negation parsing.
- Fixed legacy scroll fallback guard and stale scroll-origin behavior.
- Fixed docs accuracy issues and updated the maintainer security contact.

## [8.8.0] - 2026-05-28

### Added
- Cream/coffee light theme for the marketing website with a sun/moon toggle in the nav (PR #84). Default follows `prefers-color-scheme`; the choice is persisted in `localStorage`.
- Cream/coffee light theme for the extension's side panel and Settings page in both Chrome and Firefox builds (PR #85). Default follows `prefers-color-scheme`; Settings → General → Appearance offers System / Light / Dark.
- New `src/<browser>/src/ui/theme.js` module owning theme state, with `localStorage` mirroring `(chrome|browser).storage.local` so the FOUC bootstrap can read synchronously and other extension pages stay in sync.
- Self-hosted MP4 of the demo video on the marketing site, replacing the previous external embed.

### Changed
- Demo section label and subtitle restored on the marketing site for consistency with the other sections.
- Theme toggle is hidden on narrow nav layouts (≤375px) to keep the header within its side padding; `prefers-color-scheme` still picks the right theme on mobile.

### Fixed
- Settings appearance picker now stays in sync when the theme is changed from another Settings tab or the side panel. The local `currentThemeMode` closure and the `<select>` value are updated from `storage.onChanged`, so a subsequent OS-theme flip no longer overrides an explicit user choice.
- Theme bootstrap moved out of an inline `<script>` and into `theme-bootstrap.js` (a parser-blocking classic script in `<head>`) so it actually runs under MV3's `script-src 'self'` CSP — the inline version was silently blocked and visitors saw a dark flash on first paint.

## [8.7.0] - 2026-05-28

### Added
- Settings tab "Display" renamed to "General" across all 14 locales to reflect its broader scope.
- Settings subtitle no longer says "display preferences" — translated to "preferences" in every locale.

### Documentation
- README provider table expanded from 4 to 14 entries with default models per provider.
- README "What's New" section replaced with a one-line pointer to CHANGELOG.md to prevent the drift that left it stuck at 6.1.0.
- CHANGELOG backfilled with entries for 8.2.1, 8.2.2, 8.3.0, 8.4.0, and 8.5.0.

## [8.6.0] - 2026-05-28

### Added
- Slash commands beyond `/allow-api`: `/help`, `/compact`, `/reset`, `/screenshot`, `/export`, `/profile`, `/vision` (PR #82). Type `/help` in the side panel to see the list.

### Fixed
- System messages now bypass `formatMarkdown` so HTML (e.g. the `<img>` from `/screenshot`, the `<strong>` in `/allow-api` confirmations) renders instead of showing as escaped text.

### Changed
- Ollama default model placeholder is now empty (matching llama.cpp and LM Studio) instead of hardcoding `llama3.1`.

## [8.5.0] - 2026-05-28

### Fixed
- Comprehensive bug audit covering 65+ fixes across Chrome and Firefox builds.
- Preserved run-guard state on conversation clear so an in-flight agent run can still be stopped cleanly.
- Extended PDF read timeout through the response body phase, not just the connection phase.

## [8.4.0] - 2026-05-27

### Changed
- Merged `download_file` into `download_files` so a single tool handles both single-URL and array cases (max 3 concurrent).
- Compact-mode tool allowlist is now scoped to Act mode only; Ask mode keeps the full tool surface even when compact prompts are enabled.

### Fixed
- Suppressed stale-click warnings on editable targets (e.g. contenteditable Medium editors) where the click is intentional.
- `downloadFiles` now passes the user-supplied filename through to the download instead of falling back to the URL slug.
- Compact-mode allowlist is now enforced on text-parsed tool calls too, not only structured tool calls.
- `solve_captcha` is now part of the compact tool set so it stays available in compact mode.

## [8.3.0] - 2026-05-27

### Changed
- Compact mode is now fully opt-in: it never auto-enables based on model size heuristics. Users must check the box per-provider in Settings.

### Documentation
- Clarified in README and settings copy that compact mode is opt-in only and not auto-enabled.

## [8.2.2] - 2026-05-26

### Fixed
- Restricted deasciifier loading to `lang: "tr-deasciify"` so the ~175KB pattern table isn't pulled in for non-Turkish typing.
- Loaded the deasciifier in the content-script isolated world to avoid leaking globals into page scripts.

## [8.2.1] - 2026-05-26

### Fixed
- Patch release for deasciification edge cases discovered shortly after 8.2.0.

## [8.2.0] - 2026-05-26

### Added
- Added Turkish deasciification support via `lang: "tr-deasciify"` parameter on `type_text`, `type_ax`, and `set_field` tools. Converts ASCII Turkish (e.g. "calisma") to proper characters ("çalışma") before typing. Pattern table (~175KB) lazy-loaded on first use.

### Removed
- Removed `execute_js` from Chrome MV3 tool schema. The tool was already blocked by MV3's CSP (`new Function()` always throws EvalError). The agent now uses fine-grained tools (`read_page`, `click`, `type_text`, `scroll`, etc.) directly. Firefox MV2 retains `execute_js`.

## [8.1.0] - 2026-05-26

### Added
- Added first-launch onboarding wizard: a 3-step walkthrough covering what WebBrain does, Act mode safety warnings, and LLM provider setup.
- Added MiniMax and Alibaba Cloud (Qwen) as new cloud providers.
- Added model suggestion dropdowns for all cloud providers with a "Custom..." option for free-form entry.

### Changed
- Settings page now opens on the Providers tab by default.
- Updated model suggestions and placeholders across all cloud providers to current models.
- Hidden the Claude Pro/Max subscription provider card until OAuth flow is fixed.

## [8.0.0] - 2026-05-25

### Added
- Added `hover`, `drag_drop`, and `wait_for_stable` agent tools.
- Added 27 new site adapters and the initial sheets-mode foundation.
- Added spreadsheet A1-reference handling improvements, including absolute references and quote-aware sheet/range parsing.
- Added a configurable LLM request timeout setting with a 10–600 second range.
- Added Multimodal settings updates, including a renamed Multimodal tab and a new Transcription section.
- Added auto-save behavior for SocialMediaDownloader / MSE captures.

### Changed
- Flipped local-provider defaults: vision is enabled by default and compact prompts are disabled by default.
- Increased the default LLM request timeout to 120 seconds.
- Updated non-English locale labels for compact prompt settings.
- Extracted and reused Firefox `fetchWithTimeout` handling for Anthropic and llama.cpp requests.

### Fixed
- Fixed stale-index failures by surfacing fresh element enumeration.
- Fixed `execute_js` regressions and retained Firefox MV2-compatible `unsafe-eval` CSP behavior.
- Fixed adapter ordering and a `drag_drop` scroll race.
- Fixed `wait_for_stable` MAIN-world network counting.
- Fixed A1 parsing edge cases, including row validation and reversed whole-column / whole-row ranges.

## [7.3.5] - 2026-05-24

### Added
- Added LLM comparison materials, benchmark blog content, and additional scenarios.
- Added project governance documentation.

### Changed
- Increased the default maximum agent steps from 60 to 130.

### Fixed
- Included post-7.3.3 bug fixes and content-index diagnostics.

## [7.3.4] - 2026-05-23

### Fixed
- Included maintenance bug fixes following `v7.3.3`.

## [7.3.3] - 2026-05-23

### Fixed
- Fixed Firefox clarify-flow behavior.

## [7.3.2] - 2026-05-21

### Added
- Added tab recording support: tab capture, microphone capture, Web Audio mixing, and WebM download.
- Added Whisper transcription and agent summarization handoff for recordings.
- Added prompt-driven recording start with screenshot save support.
- Documented tab recorder architecture.

### Changed
- Removed the recorder toolbar Stop button in favor of the existing page banner stop control.

### Fixed
- Fixed corrupted WebM output by stripping codecs from the data URL.
- Fixed OpenAI transcription HTTP 415 errors by tagging blobs as `audio/webm`.
- Added friendlier transcription errors when a picker targets a chat-only server.
- Fixed stuck clarify responses by routing through `sendToBackground`.

## [7.3.1] - 2026-05-21

### Added
- Added local model loading for LM Studio and llama.cpp.
- Added NVIDIA and Groq provider options.
- Regenerated store promotional assets around the brain icon and added marquee artwork.

### Changed
- Updated provider links, website copy, and store iconography.
- Scoped Chrome side panel behavior to opt-in tabs to prevent new-tab leakage.
- Scoped `agent_update` broadcasts to the originating tab.

### Fixed
- Fixed CAPTCHA URL-string sitekey fallback and added friendlier demo-rejection handling.
- Included web and extension bug fixes prior to the `v7.3.1` tag.

## [7.3.0] - 2026-05-20

### Added
- Added provider filters and collapsible provider cards.
- Added four additional cloud providers.
- Added opt-in CapSolver integration for CAPTCHA solving.
- Surfaced CAPTCHA solver and provider constellation updates on the website and localized pages.

### Changed
- Show configured models in collapsed provider headers.
- Preserve unsaved provider edits across filter and collapse re-renders.

### Fixed
- Tightened reCAPTCHA detection and cleaned CAPTCHA balance display strings.

## [7.2.1] - 2026-05-20

### Changed
- Stopped emitting the loose credential note to small models.

## [7.2.0] - 2026-05-20

### Added
- Added credential redaction support.
- Added a clarify tool.
- Added a WordPress site adapter.
- Added opt-in strict credential handling mode.

### Changed
- Made credential handling loose by default, while keeping stricter behavior available by opt-in.

## [7.1.0] - 2026-05-17

### Added
- Added SocialMediaDownloader v4.
- Added release-mode support to the version bump script with release-boundary tagging.
- Added 9 localization languages: Russian, Ukrainian, Arabic, Japanese, Korean, Indonesian, Thai, Malay, and Tagalog.
- Added RTL support and website language navigation updates.

### Fixed
- Fixed current page context handling in chat turns.
- Fixed tool behavior from GPT-4o trace review, including honest counts, gallery filtering, and article extraction.
- Improved scrolling in `overflow:hidden` panes when the document itself is unscrollable.

## [7.0.0] - 2026-05-12

### Added
- Added larger fetch limits, prompt nudges, trace conversation grouping, step-limit summaries, and cost surfacing.
- Added URL-family thrashing detection and empty-output recovery.
- Added multilingual FAQ content for dry-run roadmap status.
- Added an npm-runnable version bump tool.

### Changed
- Removed the mobile app from the main repository.
- Improved AX-tree fallback for composers.
- Rebuilt submission zips for v7.0.0.

### Fixed
- Fixed sidepanel XSS exposure.
- Hardened agent `fetch_url` behavior against SSRF.
- Clarified that the agent cannot schedule, sleep, or check back later.

## [6.1.0] - 2026-05-04

### Added
- Added native PDF reading with `read_pdf` and Claude PDF passthrough.
- Added Claude Pro/Max subscription provider support via OAuth.
- Added OpenAI OAuth subscription provider support.
- Added LM Studio web-fetching tools (`fetch_url` and `research_url`).
- Added LM Studio plugin publishing and related FAQ updates.
- Added mobile-app experiments, including Expo scaffolding, chat/browser tabs, agent loop, OpenAI provider, and AX-tree tools.
- Added blog and documentation updates for vision-model shootouts and PDF support.

### Changed
- Simplified website header navigation.
- Mentioned PDF support in website and README tool documentation.

### Fixed
- Hardened the LM Studio plugin against SSRF and added streaming response caps.
- Fixed PDF reader credentialed fetch and content-type-aware tab detection.
- Restored subscription-provider default merging and CORS opt-in behavior.
- Fixed Chrome side-panel action-click race by keeping the side panel always enabled.
- Preserved intermediate reasoning across steps in verbose mode.

## [6.0.1] - 2026-05-04

### Added
- Added Firefox parity for the agent visual indicator and tab grouping.
- Added cross-platform extension zip build tooling.

### Changed
- Scoped Chrome sidebar visibility to a per-window WebBrain tab group.
- Stopped adopting user-owned tab groups.
- Lowered Act mode temperature.
- Refreshed documentation for the 5.x release line.

### Fixed
- Added an on-page agent visual indicator with border and Stop button.

## [5.1.0] - 2026-04-29

### Added
- Added an Ollama model picker and guidance for 403 origin-block behavior.
- Added press release links and website sharing/footer updates.
- Added additional tests for model reasoning-suppression kwargs.
- Added blog content for vision-model comparisons.

### Changed
- Rebuilt extension zips for v5.1.0.
- Updated README and web assets.

### Fixed
- Fixed NVIDIA NIM integration issues.
- Fixed math visual bugs and improved pagination.
- Fixed web traces issues.

## [5.0.0] - 2026-04-24

### Added
- Added localized landing pages for Spanish, French, Turkish, and Chinese.
- Added language dropdowns across localized web pages.
- Added plugin internationalization.

### Changed
- Improved website presentation.
- Added token-conscious screenshot handling with resizing and iterative JPEG compression.

### Fixed
- Added test coverage for image budget math.

## [4.2.1] - 2026-04-21

### Added
- Added `.one` suffix branding to the web side-panel header.
- Added FAQ guidance for recommended vision models and vLLM configuration.

### Changed
- Updated demo video URLs and documentation around `/allow-api` and v4.2 behavior.

## [4.2.0] - 2026-04-20

### Added
- Added agent scratchpad tooling.
- Added preservation of tool-result digests in summaries.
- Added profile features.

### Fixed
- Fixed vision-model checkbox behavior and settings issues.

## [4.1.0] - 2026-04-20

### Changed
- Improved settings UI.

### Fixed
- Fixed tab grouping issues.
- Fixed screenshot-related bugs.

## [4.0.1] - 2026-04-19

### Fixed
- Fixed overlay-related issues and added tests.

## [4.0.0] - 2026-04-19

### Added
- Added optional dedicated vision model support for screenshot reads.
- Added vision model connection testing.
- Added tab grouping to keep WebBrain tabs near the current context.

### Changed
- Stripped chain-of-thought output from vision model responses.
- Preserved newlines in user bubbles.
- Updated architecture documentation.

## [3.6.8] - 2026-04-15

### Added
- Added test scenarios.
- Added math-related improvements.
- Added Firefox accessibility-tree support.

### Changed
- Improved browser install cards and Chrome Web Store linking.
- Updated Chrome and Firefox Act prompts for form verification and CAPTCHA handoff.
- Improved mobile demo video handling.

## [2.2.0] - 2026-04-12

### Added
- Added agent robustness guardrails.
- Added auto-scroll behavior.
- Added type validation and done verification.

### Fixed
- Fixed click loops.

## [2.0.0] - 2026-04-11

### Changed
- Rebuilt release zips with clean ZipInfo attributes.

## [1.9.2] - 2026-04-11

### Changed
- Made the agent more persistent.

### Fixed
- Fixed deep verbose trigger behavior.

## [1.9.1] - 2026-04-11

### Fixed
- Fixed fallback parsing for `call:toolName{}` format with quote tokens.

## [1.6.2] - 2026-04-08

### Added
- Added `/allow-api` per-conversation override and documentation.

## [1.6.1] - 2026-04-08

### Changed
- Clarified prompting so UI actions and `fetch_url` reading behavior are distinguished.

## [1.6.0] - 2026-04-08

### Added
- Added background fetch support.
- Added hidden-tab research tooling.
- Added download tools.

## [1.5.10] - 2026-04-08

### Added
- Added viewport-filtered interactive elements.
- Added index-instability warnings.

## [1.5.9] - 2026-04-08

### Added
- Added screenshot annotations.
- Added unintended-navigation detection.

## [1.5.8] - 2026-04-08

### Added
- Added click-by-visible-text support to avoid selector guessing for buttons.

## [1.5.7] - 2026-04-08

### Added
- Added `type_text` into the focused element without requiring a selector.

## [1.5.6] - 2026-04-08

### Added
- Added cross-origin iframe support so the agent can act in embedded flows such as Stripe.

## [1.5.5] - 2026-04-08

### Fixed
- Omitted temperature for GPT-5 and o-series models that only support the default value.

## [1.5.4] - 2026-04-08

### Fixed
- Added coordinate-click loop detection.
- Fixed OpenAI `max_completion_tokens` handling.

## [1.5.3] - 2026-04-08

### Added
- Added FAQ entry updates.

### Changed
- Improved header UI cleanup.

### Fixed
- Added active-tab guards.

## [1.5.2] - 2026-04-08

### Changed
- Reverted the Act mode toast back to a one-time-per-install `confirm()` dialog.

## [1.5.1] - 2026-04-08

### Fixed
- Fixed coordinate-click device-pixel-ratio mismatch.
- Preferred selectors where available.

## [1.5.0] - 2026-04-08

### Changed
- Included seven quality improvements.

### Fixed
- Fixed settings bugs.

## [1.4.0] - 2026-04-08

### Added
- Added site adapters.
- Added a non-blocking Act mode hint.

## [1.3.0] - 2026-04-08

### Added
- Added loop detection with a soft nudge followed by hard stop for stuck agents.

## [1.2.2] - 2026-04-08

### Changed
- Taught the agent that it operates inside the user's authenticated browser.

## [1.2.1] - 2026-04-08

### Changed
- Seeded the first prompt with URL and screenshot context.
- Improved Firefox parity.

### Fixed
- Fixed Continue button behavior.

## [1.2.0] - 2026-04-08

### Added
- Added SPA navigation detection.
- Added auto-screenshot mode.
- Added vision support.

## [1.1.6] - 2026-04-08

### Changed
- Increased the default agent maximum steps from 25 to 60.

## [1.1.5] - 2026-04-08

### Changed
- Routed click and type actions through CDP with selector-resolution retries.

## [1.1.4] - 2026-04-08

### Changed
- Updated the default OpenAI model to GPT-5.

## [1.1.3] - 2026-04-08

### Added
- Added LM Studio as a built-in local provider.

## [1.1.2] - 2026-04-08

### Fixed
- Fixed a manifest load error by restoring `side_panel.default_path`.

## [1.1.1] - 2026-04-08

### Fixed
- Persisted agent conversation state across service worker restarts.

## [1.1.0] - 2026-04-08

### Added
- Added robust CDP click/type behavior with shadow DOM support.
- Added per-tab sidebar behavior.
- Added persistent chats.

## [0.9.3] - 2026-04-06

### Changed
- Removed the old Firefox v0.9.0 zip artifact.

## [0.9.0] - 2026-04-06

### Changed
- Removed the website section from the README.

## [0.7.0] - 2026-04-06

### Added
- Added Firefox support documentation to the README.
