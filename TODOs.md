# WebBrain — Engineering TODOs

Living list of things we know we want to do but haven't done yet. Each item
should explain *why* it matters, not just *what* to change, so that future
contributors (or future-us) can decide whether the entry is still relevant
without re-deriving the analysis.

## 1. Resolve the compact-vs-full system prompt contradiction

**Status:** Partially resolved. Compact prompt routing is implemented in both
Chrome and Firefox as an explicit per-provider opt-in. The remaining question is
prompt quality and model-tier selection, not browser parity or dead code.

**Where the code lives:**
- Compact prompt bodies — [`src/chrome/src/agent/tools.js`](src/chrome/src/agent/tools.js) and [`src/firefox/src/agent/tools.js`](src/firefox/src/agent/tools.js) `SYSTEM_PROMPT_ACT_COMPACT`
- Full ACT prompt bodies — same files, `SYSTEM_PROMPT_ACT`
- Dispatch — [`src/chrome/src/agent/agent.js`](src/chrome/src/agent/agent.js) and [`src/firefox/src/agent/agent.js`](src/firefox/src/agent/agent.js) `_getActPrompt()` route Act mode to compact prompts when the active provider has `useCompactPrompt`.
- Provider opt-in — `BaseLLMProvider.useCompactPrompt` getter + per-provider config (`openai.js`, `llamacpp.js`, inherited by compatible OpenAI-style local providers).

**The actual contradiction:**

The compact prompt was introduced for small models (~7B–13B). Two stated reasons:
1. Small models have shorter effective attention windows — info from the front of a 30K prompt may not influence late-conversation decisions.
2. Their context windows are smaller (often 8K–32K) so a 7K prompt eats a lot.

But small models *also* need **more direction**, not less:
1. Their reasoning is shallower — they can't infer "I shouldn't re-download" from "scratchpad facts"; you have to literally tell them.
2. They pattern-match more than they reason — examples help more than abstract rules.
3. They need scaffolding (do A, then B, then C) where larger models can plan A→B→C themselves.

So "less prompt" pulls one way and "more explicit guidance" pulls the other.

**What the compact prompt actually cuts (and why this is the wrong cut):**
- All worked examples (e.g. UI-vs-API has 5 examples in full, 0 in compact).
- Whole sections judged "edge cases small models won't encounter": IFRAMES, the `/allow-api` override, extended FORMS reasoning.
- Replaces multi-paragraph rules with single-sentence imperatives.

The "drop examples to save tokens" choice is exactly backwards: examples are how small models get unstuck. Removing nuance and reasoning while keeping bare imperatives gives the small model orders without the gradient information needed to follow them.

**The 27B trace evidence:**

`webbrain-trace-qwen3.6-27b-run_1777441198379_v1rqkk.json` — qwen3.6-27b on llama.cpp. Asked to upload `dist/*.zip` to a v5.1.0 GitHub release. Re-downloaded the same files **three times** because each auto-screenshot pushed the original `download_files` result out of recent attention, and the model re-derived "I need to fetch the files" from current visual state. Pattern-matched on intent, not on prior tool history. This is the failure mode small-model compactness was meant to address — and yet the compact prompt would have made it worse by stripping the SCRATCHPAD section that says explicitly to pin download paths.

Per-step input tokens for that run: 21K -> 21K -> 28K -> 30K -> 40K (auto-screenshot growth, not summarization growth). The model paid the tax of the full prompt (~7.4K) AND lost track of state. The previous "everyone gets full prompt" decision was the right local fix.

**What an actual resolution would look like:**

Three tiers, not a binary:

| Tier | Models | Prompt shape | Approx size |
|------|--------|--------------|-------------|
| Frontier | Sonnet, Opus, GPT-4o, Gemini Pro | Trim worked examples, keep rules. Trust their planning. | ~3K tokens |
| Mid | Llama 70B, Qwen 35B, GPT-4o-mini | Full rules + 1-2 examples per rule. | ~5K tokens |
| Small | 7B–30B local (qwen3.6-27b, etc.) | Full rules + many examples + simpler imperative vocabulary, + extra failure-mode reminders. **Larger, not smaller, than current full prompt.** | ~6K-7K tokens |

Per-model-class prompt selection wired through `_getActPrompt()`. Tier inferred from provider config (`useCompactPrompt` is the wrong axis; it should be `tier: 'frontier' | 'mid' | 'small'`).

**Why this is on the TODO list and not in flight:**
- Requires picking the tier per model rather than per-provider, which means a model→tier mapping (or a heuristic).
- Examples need to be written deliberately, not extracted from the existing full prompt.
- Full-prompt defaults work for frontier-skewed users (the dominant cohort), so the urgency is on the small-model end which is also where local-host iteration is hardest to test.

**Concrete next steps when picking this up:**
1. Define the tier enum and a `getTier()` method on each provider class. Default frontend models to `frontier`, OpenAI/Anthropic configs with non-flagship model names to `mid`, llama.cpp / lmstudio / ollama to `small`.
2. Author `SYSTEM_PROMPT_ACT_FRONTIER` (trimmed) and `SYSTEM_PROMPT_ACT_SMALL` (expanded). Keep `SYSTEM_PROMPT_ACT` as the mid-tier default.
3. Replace the current compact/full dispatch in `_getActPrompt()` with tier-based routing.
4. Re-run the qwen3.6-27b trace scenario and verify the small-tier prompt prevents the re-download loop.
5. Token-budget the prompt against each model's context window so prompt + first turn fits.

---

## 2. Other small Firefox parity gaps

The Firefox build is meaningfully weaker than Chrome (already noted in the README's "Known Issues"). Some gaps are platform-real (no CDP, no Manifest V3 service worker), but several are just unported features. Worth ticking off one at a time:

- **`upload_file`** — not yet in Firefox. The dispatcher path exists for downloads but not for uploads. Likely a few hours of work; webextensions has the same `<input type="file">` mechanics.
- **`full_page_screenshot`** — Chrome uses CDP `captureBeyondViewport`; Firefox would need `tabs.captureFullPage` or a scroll-and-stitch fallback. Lower priority.
- **`shadow_dom_query`** — CDP-dependent. Hardest port; may not be worth it until a concrete user case emerges.

Recently closed Firefox parity items:
- Firefox now has `downloads` permission and `download_files`; the old singular `download_file` TODO is obsolete because the tool surface was consolidated on plural `download_files`.
- Firefox Ask mode can access the accessibility tree again (10.0.2).

---

## 3. Trace recorder: tool events missing step number — RESOLVED

`kind: "tool"` events previously stored `data.step === null` even though the
surrounding `llm_request` / `llm_response` events carried the right step. Fixed
by threading the loop's `steps` counter through `_executeToolBatch` (new `step`
parameter) to the `trace.recordToolCall` call in both the Chrome and Firefox
agent loops. Tool rows in the Traces Compare view now carry their step number.

---

## 4. Notes from the qwen3.6-27b sahibinden run (separate from the upload run)

That trace (`webbrain-trace-gpt-4o-run_1777328860857_tb4voc.json` — model labeled `gpt-4o` but provider was `lmstudio`, so a local model in disguise) showed two re-occurring patterns the LISTINGS & PAGINATION prompt addition (commit landed already) directly targets:

- Re-fetched `?sd=2` three times in a row via three different tools (research_url ×2, fetch_url ×1) without ever extracting an item from any of them.
- Hit `get_accessibility_tree({filter:"all"})` overflow twice with different `maxChars` values, never switching to a different tool.

The prompt rules now name these failures explicitly. Worth re-running the same prompt on a fresh trace once a small-tier prompt exists to see whether the rules alone fix it or whether the model still ignores them at small parameter counts.

---

## 5. Fix the install and packaging story

The root manifest (`manifest.json`) is not equivalent to the actual Chrome
extension manifest under `src/chrome/manifest.json`. The root manifest points
at `src/background.js` and injects only `src/content/content.js`, while the real
Chrome code lives under `src/chrome/src/` and also needs
`accessibility-tree.js`, CDP helpers, offscreen fetch, and the fuller permission
set.

This makes the "Load unpacked" path easy to get wrong. The root README currently
needs to be unambiguous about whether developers should load `src/chrome/` or a
generated release directory.

Partially fixed already: `npm run build:zip` now creates deterministic Chrome
and Firefox submission zips from `HEAD:src/<browser>` into `dist/`, so release
zips no longer depend on ad hoc PowerShell/archive behavior. The remaining work
is the development install story and the misleading root manifest.

**Concrete next steps:**
1. Decide whether root `manifest.json` should be deleted, generated, or made a
   thin redirect-free copy of the Chrome manifest.
2. Consider adding `build:chrome`, `build:firefox`, and `build:all` scripts that
   produce unpacked development directories in addition to the existing zips.
3. Update the README quick-start instructions to point at the canonical
   load-unpacked directory.

---

## 6. Audit and stage extension permissions

Chrome currently requests broad permissions up front: `debugger`, `downloads`,
`unlimitedStorage`, `offscreen`, `privateNetworkAccess`, broad host permissions,
and `connect-src *`. Most of these map to real features, but the initial install
surface is large.

Store review and user trust would improve if sensitive capabilities are grouped
by feature and requested/explained at the moment they are needed where the
browser APIs permit it.

Partially fixed already: `docs/security-model.md` now includes a permission risk
table and `SECURITY.md` points to the detailed security model. The remaining
work is staging/optionality and in-product explanations.

**Concrete next steps:**
1. Keep the permission-to-feature table current for Chrome and Firefox.
2. Identify which permissions can be optional or triggered by an explicit
   enablement path.
3. Add UI copy for high-risk capabilities: debugger control, downloads,
   all-site access, local/private-network LLM access.

---

## 7. Lock down the WebBrain Cloud auth handoff

`src/chrome/src/ui/settings.js` accepts `WB_AUTH_TOKEN` from `window.message`
and writes the token into extension storage, then auto-configures the WebBrain
Cloud provider. The handler should validate the sender before trusting the
payload.

**Concrete next steps:**
1. Require `event.origin === 'https://auth.webbrain.one'`.
2. Track the auth popup/tab/window that was opened and require
   `event.source` to match when the platform makes that reliable.
3. Validate payload shape before storing: token non-empty string, email string,
   default model string or absent.
4. Consider a one-time nonce/state value so an unrelated page cannot spoof the
   completion message.

---

## 8. Reduce Chrome/Firefox source drift

The Chrome and Firefox source trees are mostly mirrored but not shared. Many
files differ across `agent`, `tools`, `providers`, `network`, `trace`, and `ui`.
Some differences are platform-real, but the current layout makes accidental
parity regressions likely.

**Concrete next steps:**
1. Extract browser-neutral code into a shared module tree, e.g. provider logic,
   prompt/tool definitions, adapters, trace formatting, and pure helpers.
2. Keep browser-specific APIs behind small platform adapters
   (`chrome.scripting` vs `browser.tabs.executeScript`, CDP vs non-CDP, side
   panel vs sidebar).
3. Add a parity check that fails when shared files are changed in one browser
   tree but not the other, until the common module extraction exists.

---

## 9. Test the real shared logic instead of copied shims

`test/run.js` duplicates pieces of `Agent` logic in `LoopDetectorShim` because
`agent.js` imports browser-only modules. That means tests can pass while the real
agent implementation drifts.

**Concrete next steps:**
1. Move loop detection, coordinate-click bucketing, image budget sizing, and
   other pure logic into browser-free modules.
2. Import those modules directly from both `agent.js` and `test/run.js`.
3. Add regression tests for the text tool-call parser and context trimming,
   since both are high-impact agent reliability code.

---

## 10. Keep streaming and non-streaming provider behavior in sync

The original gap — `OpenAICompatibleProvider.chat()` applying `options.extraBody`
while `chatStream()` did not — is **already resolved**: both methods now apply
`extraBody` in `src/chrome/src/providers/openai.js` and the Firefox copy. The
remaining (lower-priority) work is breadth:

**Concrete next steps:**
1. Add provider-level tests or small request-shape probes for OpenAI-compatible,
   llama.cpp, and Anthropic providers.
2. Document which provider-specific request fields are intentionally supported.

---
