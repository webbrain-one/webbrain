# Security tests — adversarial prompt-injection corpus

```bash
npm run test:security                       # human-readable
node test/security/injection-corpus.mjs --json   # machine-readable results
```

## What this covers

The highest-severity risk for an *act-mode* web agent is **prompt injection
through page content** — and specifically through text the user never sees:
ARIA labels, `alt` text, off-screen / `display:none` nodes, and crafted markup
that "reads as a command." A confused model that obeys it can click, type,
navigate, and submit as the logged-in user.

`injection-corpus.mjs` is a self-contained red-team harness (no LLM, no
browser, no network) that drives the deterministic trust boundary directly:

| Primitive | File | What it must guarantee |
|---|---|---|
| `Agent._wrapUntrusted` | `src/*/src/agent/agent.js` | Page-derived bytes are sealed in a per-call **nonce**-tagged box; attacker boundary tags are neutralized (no breakout). |
| `Agent._digestToolResult` | `src/*/src/agent/agent.js` | The turn-summarizer never **launders** injected text back into trusted context. |
| `UNTRUSTED_CONTENT_TOOLS` | `src/*/src/agent/permission-gate.js` | Every page/ARIA-reading tool is classified untrusted. |

## The corpus

27 payloads across six categories: classic instruction-override, role
spoofing (`<system>` / fake user turns), **boundary breakout** (literal close
tags, open-tag spoofing, case + attribute evasion, stacked tags),
**hidden-text / ARIA** (aria-label, alt-text, off-screen div, SVG
`<title>`/`<desc>`, `aria-describedby` indirection, `aria-roledescription`,
`title`/`placeholder` attributes, HTML comments, `<noscript>`, JSON-LD,
table headers), **unicode evasion** (RTL/bidi override, homoglyph boundary
spoof, invisible Unicode-tag smuggling, zero-width), and **data exfiltration**
(navigate-and-paste, markdown-link).

For every payload, against **both** the Chrome and Firefox builds, the harness
asserts:

1. the result is sealed by a genuine, matching, unguessable nonce boundary;
2. **no** attacker-supplied boundary tag survives inside the box;
3. the per-call nonce never appears in attacker-controlled bytes (no spoofing);
4. benign page data is preserved (the agent can still read the page); and
5. the digest does not leak the injected instruction text.

Plus a chrome/firefox parity check that both builds neutralize identically.

## Scope / what is NOT here

This file covers risk **(2)**, model confusion from page content. The other
risk — **abuse of extension capabilities** — is the capability gate, covered by
the `capabilityFor` / permission-gate tests in `test/run.js`.

These checks defend the *boundary* (data can never become an instruction).
They are deliberately model-independent. End-to-end behavioural evals against
real local/cloud models live under `test/llm/`.

## Adding a payload

Append to the `CORPUS` array. Include a `KEEP_*` marker (benign data that must
survive) and a `HIT_*` marker (the injected command that must never leak). The
five invariants are applied automatically.
