# Tests

Three layers, each with a different scope, speed, and cost profile.

## Setup (once)

```bash
npm install
npx playwright install chromium
```

## 1. Unit — `npm test`

`test/run.js`. Pure-JS tests of loop detection + adapter routing. No browser, no network. Already green (32 passed as of v4.0.1).

## 2. Fixtures — `npm run test:fixtures`

`test/fixtures/`. Playwright loads local HTML files that reproduce the exact failure modes v4.0.1's overlay defenses fix:

- `modal-scoping.html` — dialog with "Create" over a background that also has "Create" + "Publish release". Verifies `_findTopmostModal()` scopes the text resolver, so `click({text:"Create"})` picks the dialog's button and `click({text:"Publish release"})` returns a scoped no-match.
- `occlusion.html` — target button covered by a transparent overlay with higher z-index. Verifies the post-click `elementFromPoint` hit-test refuses with `{occluded:true}`, and that coord clicks correctly bypass the check.
- `ambiguity-candidates.html` — two "Cancel" buttons in different landmarks. Verifies the ambiguity response carries `{cx, cy, ancestor}` with the containing form / section identified.

No LLM, no API keys, no network. Deterministic, ~5 seconds. Run on every PR.

## 3. Anonymous scenarios — `npm run test:anonymous`

`test/anonymous/`. Playwright launches Chromium with the Chrome extension loaded, opens each scenario's URL, fires a `chat` message at the background service worker, waits for the agent's final reply, and runs the scenario's `check`. Uses a persistent profile (`.test-profile/`, gitignored) so configuration sticks between runs.

### First run

No providers are configured yet. The runner opens the Settings page; add a provider + API key there, close the browser, re-run. Or run `npm run test:anonymous -- --setup` just to open Settings without trying to execute.

### Scenarios

Defined in `scenarios.json` — add more by following the shape. Supported `check` types:

- `{type:"contains", value:"...", field:"content"}` — substring match against the agent's final text answer (case-insensitive). Add `minLength` to require a non-trivial reply.
- `{type:"regex", value:"...", flags:"i"}` — full regex.

Only anonymous/public sites here. Signed-in scenarios (Gmail, GitHub issue filing, Stripe) need a baked session and can be driven via the same harness once you add auth handling — but don't try to automate those in CI; keep them local.

### Usage

```bash
npm run test:anonymous                              # all scenarios
npm run test:anonymous -- --scenario=arxiv-attention-title  # just one
npm run test:anonymous -- --setup                   # open settings only
```

Headed by default so you can watch runs and intervene. Budget ≈ 10–30 seconds per scenario + LLM tokens per the configured provider.

## 4. Vision probe — `node vision-probe.mjs <image>`

`vision-probe.mjs`. One-shot caption-quality check against any OpenAI-compatible vision endpoint (llama.cpp, Ollama, LM Studio, vLLM, LiteLLM, OpenRouter, …) using **the exact same system prompt, user text, and parameters** the extension's vision sub-call sends — `VISION_SYSTEM_PROMPT`, temperature 0, max_tokens 800, `chat_template_kwargs.enable_thinking: false`. If your vision model produces garbage here, it will produce garbage in the extension too.

### Usage

```bash
node vision-probe.mjs <image-path> [endpoint] [model]
```

- `<image-path>` — PNG/JPEG on disk. Typically a screenshot to check the model against.
- `endpoint` — defaults to `http://127.0.0.1:8080`. Given a bare host, `/v1/chat/completions` is appended.
- `model` — optional; if omitted, the server picks. Required for OpenRouter / multi-model servers.
- `VISION_PROBE_KEY` env var — bearer token, if the endpoint needs one.
- `VISION_PROBE_FOLD_SYSTEM=1` — fold the system prompt into the user message for chat templates that reject separate system messages. This is automatic when the model name contains `molmo`.

### Examples

```bash
# Local llama.cpp
node vision-probe.mjs ./shot.png

# Local llama.cpp with an explicit model label
node vision-probe.mjs ./shot.png http://127.0.0.1:8080 Gemma-4-E2B-It

# Ollama (note the /v1 suffix matters for OpenAI compat)
node vision-probe.mjs ./shot.png http://localhost:11434/v1 llava:13b

# LM Studio with Molmo
node vision-probe.mjs ./shot.png http://127.0.0.1:1234/v1 molmo2-8b

# OpenRouter with a key
VISION_PROBE_KEY=sk-or-v1-... node vision-probe.mjs ./shot.png \
  https://openrouter.ai/api/v1 openai/gpt-4o
```

### What to look for

The prompt asks the model for a 6-section structured caption (page purpose, exact visible text, inputs, state signals, blockers, unknowns). The planner depends on sections **2 (exact strings)** and **4 (state signals)** above all — those drive `click({text})` and error-state detection. When evaluating a candidate vision model:

- Does it quote button/link text **verbatim**, or does it paraphrase?
- Does it hallucinate strings that aren't on the screen?
- Does it surface red error borders, disabled buttons, CAPTCHAs, cookie banners?
- Does it correctly flag "unknown" when it can't read a number, not guess?

Keep the two constants at the top of `vision-probe.mjs` in sync with `src/chrome/src/agent/agent.js` (`VISION_SYSTEM_PROMPT` and the user-message text). If the real prompt changes, update the probe so results stay comparable.

## 5. Manual memory tutorial — `test/memory/`

Static HTML tutorial for the user-memory feature. Serve it locally and drive it
with the extension side panel:

```bash
python3 -m http.server 8765 -d test/memory
```

Then open `http://127.0.0.1:8765/`. The page walks through `/memory --add`,
form-derived learning, normal auto-learning, replaying saved memories into a
later form, and Profile auto-fill.
