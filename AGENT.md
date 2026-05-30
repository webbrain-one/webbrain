# Agent Notes

WebBrain is an open-source AI browser agent for Chrome and Firefox. The goal is
reliable, user-visible browser automation with strong safety boundaries, good
local-model behavior, and practical Chrome/Firefox parity. Keep the extension
vanilla JS/CSS unless there is a very strong reason to add a framework.

## Goals

- Keep Ask mode read-only by default and Act mode explicit, reviewable, and
  interruptible.
- Prefer visible UI actions over hidden API mutations. The `/allow-api` override
  exists for deliberate exceptions, not as a default path.
- Preserve local-model usability: compact prompts, smaller tool surfaces, context
  trimming, and clear failure-mode reminders matter.
- Keep Chrome and Firefox behavior aligned where the platform allows it. When a
  difference is platform-real, document it near the implementation or in docs.
- Treat site adapters as high-leverage product work. Short, concrete adapter
  notes often fix more real tasks than broad refactors.

## Quality Rules

- Mirror agent, tool, provider, adapter, trace, and UI changes across
  `src/chrome/` and `src/firefox/` unless the browser API makes parity
  impossible.
- Keep public tool schemas narrow and stable. Changing tool names, arguments, or
  result shape can break prompts, traces, and downstream model behavior.
- Comments should explain why a browser quirk, prompt rule, permission gate, or
  context-management choice exists. Avoid comments that restate the code.
- Keep site adapter notes imperative, specific, and short. Name selectors,
  visible text, URL patterns, traps, and success indicators.
- Do not add broad dependencies, frameworks, or build steps without discussion.
  The extension is intentionally simple to load and inspect.

## Safety

- Read `docs/prompt-injection-defense.md` before changing page reads, tool
  results, message construction, or untrusted-content handling.
- Page content, fetched URLs, screenshots, PDFs, and downloaded files are
  untrusted. Preserve `_wrapUntrusted` boundaries and keep the untrusted-content
  registries exhaustive.
- Be conservative with capabilities that can spend money, submit forms, send
  messages, download files, record media, or mutate remote state.
- Do not weaken permission-gate behavior or host checks to make a task pass.
  Fix the routing, user prompt, or adapter instead.
- Avoid committing secrets, trace files with private page content, downloaded
  user files, or generated artifacts unless the task explicitly requires them.

## Docs To Read First

- `docs/architecture.md`: system overview and browser-extension boundaries.
- `docs/adding-a-tool.md`: required checklist for new or changed agent tools.
- `docs/accessibility-tree-and-refs.md`: AX refs, page reads, and interaction
  targeting.
- `docs/site-adapters.md`: adapter shape, prompt style, and testing guidance.
- `docs/providers-and-models.md`: provider configuration and model capability
  assumptions.
- `docs/localization.md`: UI locale workflow and mirroring expectations.
- `docs/privacy-and-data-flow.md` and `docs/security-model.md`: data handling,
  permissions, and user-risk model.
- `docs/prompt-injection-defense.md`: mandatory reading for any change that
  passes page-derived content into prompts or tool results.

## Layout

- `src/chrome/`: Chrome MV3 extension, service worker, CDP-backed actions,
  side-panel UI, offscreen helpers, Chrome-specific permissions.
- `src/firefox/`: Firefox MV2 extension, background page, sidebar UI, and
  Firefox API equivalents where available.
- `src/*/src/agent/`: agent loop, prompts/tools, adapters, page interaction,
  screenshot handling, loop detection, and completion verification.
- `src/*/src/providers/`: local and cloud LLM provider implementations and
  provider configuration.
- `src/*/src/ui/`: side-panel/sidebar UI, settings, onboarding, locales, and
  trace views.
- `docs/`: security model, prompt-injection defense, and design notes that
  should stay current with behavior.
- `test/`: browser-neutral regression tests and parity checks.
- `web/`: marketing site and blog content; run the web build after editing it.

## Testing

Use `npm test` for the main regression suite. For syntax-only JS checks, run
`node --check <file>` on touched agent/provider/UI files. Run
`npm run build:web` after changing `web/` content or web locales. Use
`npm run build:zip` when validating release packaging.

For behavior changes in the extension, test at least the touched browser path
manually. If the change affects shared agent behavior, test both Chrome and
Firefox or clearly document the untested side.
