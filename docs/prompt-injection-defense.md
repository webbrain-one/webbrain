# Prompt-injection defense — how it works & how not to break it

WebBrain's agent acts **inside the user's authenticated browser session**: it
can click, type, navigate, run JS, and submit forms *as the logged-in user*. So
any text it reads from a web page is **attacker-controllable** — a malicious
tweet, a shared doc, an email, an issue comment, a PDF. The whole point of the
defenses below is: **page content is DATA, never instructions, and consequential
actions need a human in the loop.**

If you add a tool, a new way to read the page, or a new place that feeds
page-derived bytes to the model, read this first. The unit tests can enforce
*membership* of the registries, but **not** whether you classified a thing
correctly — that's on you and the reviewer.

The code lives in **both builds** (`src/firefox/...` and `src/chrome/...`). Keep
them in sync — the test suite asserts the pure modules are byte-identical.

---

## The four layers

1. **Untrusted-content wrapping (Layer 1).** Tool results that carry page-derived
   bytes are wrapped in `<untrusted_page_content id="<nonce>">…</…>` markers,
   with any literal marker in the content stripped (breakout defense).
   - Code: `agent.js` → `_wrapUntrusted(name, content)`; the set
     `UNTRUSTED_CONTENT_TOOLS` in `permission-gate.js`.
2. **System-prompt contract (Layer 2).** The prompts tell the model that
   anything in those markers is data, never instructions, and that only the
   system prompt and the user's own chat/`clarify` messages are authoritative.
   - Code: `tools.js` -> `SYSTEM_PROMPT_ASK` (5-bullet block), `SYSTEM_PROMPT_ACT`
     (7-bullet block), `SYSTEM_PROMPT_ACT_COMPACT` (condensed opt-in compact
     prompt in both browser builds), plus `planner.js` -> `PLANNER_SYSTEM_PROMPT`
     for the Plan-before-Act pre-loop call.
3. **Capability × origin permission gate (Layer 3).** Before a consequential
   tool runs, the agent checks a `(capability, host)` grant and prompts the user
   (Allow once / Always / Deny) if there isn't one. No text inspection, no LLM —
   the human is the trust anchor.
   - Code: `permission-gate.js` (`capabilityFor`, `requiredHosts`,
     `PermissionManager`); the gate loop in `agent.js _executeToolBatch`.
   - User control: Settings → Permissions (review/revoke grants + the master
     switch "Ask before consequential actions").
4. **Output sanitizer (Layer 4).** Model output is HTML-escaped and only
   `[label](url)` markdown becomes an allowlisted (http/https/mailto) link — no
   auto-loading images, no bare-URL linkification.
   - Code: `ui/markdown-link.js`.

---

## What counts as "page-derived" (i.e. UNTRUSTED)

Treat **all** of the following as attacker-controllable:

- DOM text and HTML — including **hidden / off-screen** text, ARIA labels, `alt`,
  `title` attributes, HTML comments, and text styled invisible.
- **OCR / vision-model transcriptions** of a screenshot (`desc.text`).
- **Fetched / downloaded documents** — PDF extracted text, downloaded file
  contents, `fetch_url`/`research_url` bodies.
- **URLs and hosts the page controls** — `href`/`src`, an iframe's URL, a
  redirect target. (These drive *permission* decisions, see Layer 3.)
- **Tool results that embed page-derived verification/probe fields** — e.g. the
  `done` result includes `pageTitle` / `pageState` (dialog titles, live-region
  text). Non-obvious, easy to miss — `done` was mis-classified once for exactly
  this reason.

Model-authored text (a tool's own status string, the agent's `summary`) and the
**user's** messages (including `clarify` answers) are trusted.

---

## Rules for contributors

### Adding a tool that READS page content
Add its name to `UNTRUSTED_CONTENT_TOOLS` in `permission-gate.js` (both builds).
The exhaustiveness test will fail until every act-mode tool is classified.

For a dynamic skill tool, do not add the name to the static set. Declare
`"resultPolicy": "untrusted"` in the skill's `webbrain-tools` manifest instead;
`agent.js` consults the enabled-skill registry at runtime and applies the same
wrapper/digest behavior.

### Adding a tool that has a SIDE EFFECT (click/type/navigate/download/etc.)
Map it in `permission-gate.js`:
- add it to `TOOL_CAPABILITY` (or handle it in `capabilityFor` if the capability
  depends on args — see `set_field`/`press_keys`/`fetch_url`);
- make sure `hostForCapability` / `requiredHosts` resolves the **real target
  host** (destination URL for navigate/network/download; current page for
  click/type; the **frame** host for iframe tools; **every** host for a
  multi-URL tool like `download_files`);
- if the host can't be determined, return `''` / `[]` so the gate **fails
  closed** (see the iframe-without-`urlFilter` case).

### Adding a place that RE-INJECTS page-derived bytes into a message
Some page-derived text reaches the model **outside** the normal tool-result path
— it's interpolated into a `role:'user'` or `role:'tool'` message the agent
builds itself. Those must be wrapped **explicitly**:

```js
const wrapped = this._wrapUntrusted('screenshot', desc.text); // nonce + strip
messages.push({ role: 'user', content: `[…]\n${wrapped}` });
```

> ⚠️ **A prose "this is untrusted" label is NOT the boundary.** The boundary is
> the nonce-delimited `<untrusted_page_content>` markers that `_wrapUntrusted`
> produces (and the breakout-stripping it does). Always route page-derived text
> through `_wrapUntrusted`, not just a `[warning]` prefix.

Known non-tool ingestion points (keep this list current):
- auto-screenshot re-injection (vision description + interactive-elements list);
- the "Initial viewport description" in `_enrichUserMessageWithCurrentPage`;
- Plan before Act planner messages: sanitized page URL/title and recent-history
  digest are sent under the planner's untrusted-page framing; non-text image
  blocks are dropped before the planner call;
- PDF passthrough: the raw PDF `document` block can't be text-wrapped, so its
  accompanying note carries explicit untrusted framing **and** the attacker-
  controlled `docTitle` is sanitized before interpolation;
- the `done` tool-result push (special-cased before the normal wrap).

### Don't weaken the boundary for "trusted sites"
The master switch (Settings → Permissions) disables **Layer 3 only** (the
prompts). Layers 1, 2, and 4 stay on always — they cost nothing and are what
protect the user on the trusted sites where injected content actually lives
(a reputable domain is *anti-correlated* with safe content). Never gate Layers
1/2/4 behind a setting.

---

## Tests

- `node test/run.js` — pure-logic unit tests, including:
  - the **exhaustiveness guard**: every `getToolsForMode('act')` tool must be
    gated (`capabilityFor`), untrusted-read (`UNTRUSTED_CONTENT_TOOLS`), or on the
    `KNOWN_SAFE_TOOLS` allowlist (defined in `test/run.js`) — else CI fails.
  - capability mapping, host resolution, `requiredHosts`, `frameHostMatches`,
    grant storage / `hydrateFrom`, content-wrap breakout-stripping.
  - planner prompt parity / boundary checks in `test/security/injection-corpus.mjs`.
- `test/manual-permissions.md` — the in-browser checklist (the 3-option
  permission card and the Settings → Permissions tab) that the unit suite can't
  cover.

**The guard checks that tools are *listed*, not that they're listed
*correctly*.** If a tool's result carries page-derived bytes, it belongs in
`UNTRUSTED_CONTENT_TOOLS` even if it's "just a status tool" (see `done`). When in
doubt, wrap it — wrapping a trusted field is harmless; leaving a page-derived
field unwrapped is a hole.

---

## Known limitations (accepted)

These are conscious trade-offs, not oversights.

- **Generic interaction is charged to the top-level page host, not the frame
  it lands in.** `click({x,y})` (CDP coordinate clicks), `type_text`, and
  `press_keys` go to whatever pixel/element is targeted or focused — which
  *can* be inside a cross-origin iframe (e.g. an embedded Stripe/PayPal frame).
  The gate charges these to the page host, so a grant for `merchant.com` also
  covers a coordinate click that lands in an embedded `stripe.com` frame.
  - Why accepted: (1) selector/text clicks **can't** reach cross-origin frames
    (same-origin policy blocks `querySelector` from piercing them), so this is
    limited to coordinate clicks (Chrome/CDP only — Firefox clicks the
    `<iframe>` element, not into it) and focus-based typing; (2) for legitimate
    embedded flows the user grants the merchant page *expecting* checkout —
    including its payment iframe — to work, so prompting for the provider's
    host mid-flow is arguably worse UX than the residual risk. The **explicit**
    `iframe_click` / `iframe_type` tools DO gate on the frame host
    (`frameHostMatches`), because there the model deliberately names a frame.
  - If you want to close it: resolve the target frame for coordinate clicks
    (CDP hit-test) and the focused-frame for keystrokes, then gate on that
    frame host or fail closed when it's cross-origin. Non-trivial and
    Chrome/CDP-specific; needs real-browser testing.

- **`solve_captcha` is ungated** (on the `KNOWN_SAFE_TOOLS` allowlist). It
  spends CapSolver quota and injects a token (firing the widget's
  `data-callback`, which on some sites auto-submits). Accepted because the cost
  is bounded, the consequential submit is otherwise gated, and gating it adds a
  prompt to a precursor the user wants when blocked by a CAPTCHA. Revisit if
  quota abuse becomes a real concern.

- **`hover` is ungated** — synthetic hover reveals menus/tooltips and commits
  nothing.

- **An LLM is *not* used anywhere in the gate.** Intent is never inferred from
  page or prompt text (that approach was tried and removed — it was English-only
  and leaky). The gate is deterministic capability×origin with the human as the
  trust anchor.
