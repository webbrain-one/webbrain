---
title: >
  Four vision models, one screenshot: which one is actually worth running locally for a browser agent?
slug: vision-model-shootout
sortOrder: 80
date: 2026-04-21
readTime: 7 min read
description: >
  We benchmarked Gemma 4-E2B, Gemma 4-31B, Qwen3.5-27B, and Qwen3.6-35B-A3B on the same browser screenshot using WebBrain's exact vision-sub-call prompt. Here's what the numbers look like and why one model changed our default recommendation.
excerpt: >
  We fed the same Google sign-in page through Gemma 4-E2B, Gemma 4-31B, Qwen3.5-27B, and Qwen3.6-35B-A3B using the exact system prompt WebBrain's vision sub-call ships with. The spread on OCR accuracy, latency, and token cost is wider than you'd expect — and one model quietly changed our mind about which architecture to reach for.
titleTag: >
  Four vision models, one screenshot — WebBrain Blog
ogTitle: >
  Four vision models, one screenshot — WebBrain benchmark
ogDescription: >
  Gemma 4-E2B vs Gemma 4-31B vs Qwen3.5-27B vs Qwen3.6-35B-A3B on the same browser screenshot, same prompt. OCR, latency, and token cost — what actually matters for a browser agent.
twitterTitle: >
  Four vision models, one screenshot — WebBrain benchmark
twitterDescription: >
  Gemma 4 vs Qwen3.5 vs Qwen3.6-A3B on a browser agent's vision prompt.
keywords:
  - vision model benchmark
  - open source browser agent
  - Qwen3.6
  - Gemma 4
  - llama.cpp vision
  - local vision model
  - Qwen3.5 27B
  - browser automation OCR
html: true
lede: >
  We fed the same Google sign-in page through four open-weight vision models using the exact system prompt WebBrain's vision sub-call ships with. The spread on OCR accuracy, latency, and token cost is wider than you'd expect — and one model quietly changed our mind about which architecture to reach for.
---

## Why this matters (and what we're actually measuring)

WebBrain runs entirely inside your browser and supports a *split-provider* vision setup: your fast planner (GPT-4o-mini, Sonnet, a local Qwen, whatever) handles tool calls, and a separate vision model reads screenshots into terse structured text that gets threaded back into the planner's context. That's cheaper, lower-latency, and — importantly — lets you run vision locally on your own hardware while keeping the planner on a smarter cloud model.

But it only works if the vision model can actually *see* the page. For a browser agent, that means three things, in order of importance:

1. **Verbatim OCR** — can it quote button/link text exactly? Because `click({text: "Next"})` only fires if the caption said "Next", not "next step" or "continue button".
2. **State signals** — can it spot red borders, disabled buttons, error text, modals, CAPTCHAs?
3. **Calibrated uncertainty** — if it can't read something clearly, does it say so, or does it hallucinate?

Our vision sub-call's system prompt asks for a 6-section structured caption covering exactly these concerns. We built a tiny CLI probe (`test/vision-probe.mjs` in the repo) that sends the same prompt + same image + same parameters the extension uses, so you can compare models apples-to-apples on your own screenshots.

<div class="callout">
<strong>The test image.</strong> Google's password-entry screen for a real Gmail account, with the password field left empty — so the page shows the red error border, an icon, the message <em>"Enter a password"</em>, and the "Try another way" link. It's a realistic, information-dense screen: 12 distinct visible strings, a focused input, a checkbox, an error state, and a small email chip with a dropdown affordance. Easy to produce a caption for, hard to produce one that doesn't skip or hallucinate.
</div>

## The four contenders

- **Gemma 4-E2B-It** — Google's 2B-effective-parameter model, the smallest plausible vision option.
- **Gemma 4-31B-It** — same family, dense 31B parameters, high-throughput quant.
- **Qwen3.5-27B** — Alibaba's dense 27B multimodal.
- **Qwen3.6-35B-A3B** — Mixture-of-Experts: 35B total, ~3B activated per token.

All four served locally via llama.cpp, same endpoint, same quantization family. Exact same prompt, same temperature (0), same max_tokens (800), same `chat_template_kwargs.enable_thinking: false`.

## Results

|  | Gemma 4-E2B | Gemma 4-31B | Qwen3.5-27B | Qwen3.6-35B-A3B |
| --- | --- | --- | --- | --- |
| Latency | 1.5s | 4.6s | 7.9s | <span class="win">5.3s</span> |
| Completion tokens | 187 | 183 | 262 | 311 |
| Prompt tokens (image) | <span class="win">574</span> | <span class="win">574</span> | 4374 | 4374 |
| Email chip OCR | <span class="lose"><code>emreillu@…</code></span> | <span class="lose"><code>esokullullu@…</code></span> | <span class="win">correct</span> | <span class="win">correct</span> |
| All 12 visible strings | <span class="lose">5 of 12</span> | <span class="win">12 of 12</span> | <span class="win">12 of 12</span> | <span class="win">12 of 12</span> |
| Red error state surfaced | <span class="lose">no</span> | text only | text + icon | <span class="win">border + icon + text</span> |
| Inferred a semantic blocker | no | no | yes (1) | <span class="win">yes (2)</span> |
| Honest Unknowns section | no | no | no | <span class="win">yes</span> |

## What the numbers mean

### Gemma 4-E2B is not a vision model for this job

It's fast — 1.5 seconds — and cheap — 574 prompt tokens per image — but it hallucinates the email (`emreillu@gmail.com` instead of `esokullu@gmail.com`), invents a non-existent "I agree" button, misses most of the visible text, and calls the full-page login a "modal dialog". Those are not OCR shortfalls; those are planner-poisoning failures. A browser agent fed this caption would reason about a screen that doesn't exist.

### Gemma 4-31B is usable but has a narrow weakness

All 12 strings enumerated, field and error correctly identified, no fabricated labels. But it keeps misreading the email chip — once as `ecookullu@gmail.com`, once as `esokullullu@gmail.com`. Different mistakes, same structural issue: the chip's small font plus the adjacent avatar bubble plus the dropdown arrow seems to confuse the OCR pass, and the model doesn't flag the uncertainty in section 6. For most action tasks (clicking buttons, typing in fields) this is fine, because DOM-based `verify_form` is the ground truth anyway. But if the planner ever reads that caption back to you (*"I've signed you in as ecookullu@gmail.com"*) or uses it to cross-check a field it just typed, you have a silent corruption problem. Price of entry: just 574 image tokens and under 5 seconds.

### Qwen3.5-27B is solid but gets dominated by its own successor

Correct email, 12 of 12 strings, correct error breakdown, even inferred that the *Next* button would likely fail submission. The tradeoff: 4374 image tokens (7.6× Gemma's rate because of the Qwen vision encoder's tile resolution) and 7.9 seconds of latency. Good quality, but we'll see in a second why you probably want the A3B instead.

### Qwen3.6-35B-A3B is the quiet winner

This is the model that changed our mind. The MoE architecture (35B total parameters, ~3B activated per token) delivers:

- **Faster than the dense 27B** — 5.3s vs 7.9s — because the forward pass only touches active experts.
- **Better caption quality than the dense 27B**, not worse. It's the *only* model in this shootout that: noticed the dropdown-arrow affordance on the email chip, described the red border's ambiguity between "field is focused" and "field is in error" instead of committing to one reading, actually used section 6 (*Unknowns*) the way our prompt asks — to flag things it can't verify from pixels alone — rather than confabulating and claiming "None".
- **Same prompt-token cost as the dense 27B** (4374 image tokens), because vision encoding happens before the language stack.

That third point matters more than it sounds. "Honest uncertainty" is the bullet in our vision prompt that's been least respected across every model we've tested. Getting a caption that says *"Whether the password field is currently focused (visually indicated by red border, but not confirmed via DOM)"* is exactly what the planner wants — it can now decide to re-read the DOM instead of acting on a misperception. Every other model either ignored section 6 or wrote "None" even when it had visible reasons to be unsure.

## The MoE lesson for local vision

If you've been picking vision models by dense parameter count — "27B is smaller than 35B, so it'll be cheaper to run" — this shootout is a reminder that MoE upends that heuristic. For roughly the same VRAM (same-family 4-bit quants land in the 18–22 GB range for both), the A3B variant outperforms the dense 27B on *every* axis: latency, caption quality, and calibrated uncertainty. You pay for 35B of parameters at load time and get ~3B-worth of latency per token at inference.

Browser-agent screenshots fire frequently — once after every state-changing tool call in WebBrain's `state_change` mode — so per-image latency compounds fast. Five seconds per auto-screenshot vs eight is a meaningful UX difference over a 10-step task.

## What this changes in WebBrain

Nothing in the code, but something in the recommended configuration. If you're setting up the dedicated vision model in **Settings → Models → Vision**:

- **If you have the VRAM (~20 GB for a decent quant):** Qwen3.6-35B-A3B is the new default recommendation.
- **If you're VRAM-constrained or latency-sensitive:** Gemma 4-31B at 574 prompt tokens per image is attractive, but you probably want to tighten the prompt's section 6 wording — escalating it from *"say so"* to an explicit "if any text is a username, email, dollar amount, date, or ID and you are even slightly unsure of a single character, list it in Unknowns verbatim and leave it out of section 2" — so its identifier-OCR failure mode flags itself instead of confabulating.
- **Don't use Qwen3.5-27B unless you can't run the A3B.** Same cost, worse quality, slower.
- **Gemma 4-E2B is not a serious option** for this job. Use it for speculative decoding, not for page understanding.

## Reproducing this

The probe is `test/vision-probe.mjs` in the repo. It sends the same system prompt, user text, and parameters the extension uses, against any OpenAI-compatible endpoint:

```
node test/vision-probe.mjs ./shot.png
node test/vision-probe.mjs ./shot.png http://127.0.0.1:8080 Qwen3.6-35B-A3B
node test/vision-probe.mjs ./shot.png http://localhost:11434/v1 llava:13b
VISION_PROBE_KEY=sk-... node test/vision-probe.mjs ./shot.png https://api.openai.com/v1 gpt-4o
```

Point it at your own screenshots. If the caption paraphrases button text, invents labels, or writes "Unknowns: None" for an image full of small typography, you've just reproduced exactly what the planner would be working with. That's the test.

<div class="callout">
<strong>Caveat.</strong> One screenshot is one data point. The email-OCR weakness in Gemma might be reading-glyph-specific (the chip has small italic-ish type and an avatar bubble crowding it). Other weaknesses will surface on other screens. The methodology — same prompt, same params, same image — is what transfers. Run it against the pages <em>you</em> actually want the agent to handle before committing to a model.
</div>
