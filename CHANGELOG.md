# Changelog

All notable changes to WebBrain are documented in this file.

This changelog was generated from the repository Git history and release tags. Versions without a Git tag are inferred from version-bump commits and the current `package.json` / `manifest.json` version.

## [Unreleased]

## [14.1.2] - 2026-06-21

### Changed
- Completed missing translations for all 13 supported languages (Arabic, Spanish, French, Indonesian, Japanese, Korean, Malay, Russian, Thai, Tagalog, Turkish, Ukrainian, Chinese Simplified) across Chrome and Firefox locale files, covering scheduled-task UI strings, scratchpad panel, schedule form, permission verb, tool labels, and settings toggles added in 14.1.0.

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
- WebBrain Cloud is now the default provider for new WebBrain configurations.
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
