---
title: >
  Inkling makes the American open-weight comeback genuinely multimodal
slug: thinking-machines-inkling-openrouter-planner-benchmark
sortOrder: -120
date: 2026-07-23
readTime: 10 min read
description: >
  We tested Thinking Machines Inkling through OpenRouter on WebBrain's frozen 100-case browser-planner benchmark, then checked its image and audio understanding.
excerpt: >
  Inkling produced 96 valid calls and chose the ideal tool 45 times, while reaching 73% Sonnet alignment. Maximum reasoning did not help—but working image and audio input make this 975B American open-weight release unusually complete.
titleTag: >
  Thinking Machines Inkling OpenRouter planner benchmark - WebBrain Blog
ogTitle: >
  Inkling makes the American open-weight comeback multimodal
ogDescription: >
  96 valid calls, 45 ideal tool choices, 73% Sonnet alignment, plus successful image and audio probes. Our independent OpenRouter test of Thinking Machines Inkling.
twitterTitle: >
  Thinking Machines Inkling: frozen planner, vision, and audio test
twitterDescription: >
  96 valid calls, 45 ideal tool choices, and 73% Sonnet alignment. Max reasoning did not improve the result, but Inkling's modality breadth is the real story.
keywords:
  - WebBrain
  - Thinking Machines
  - Inkling
  - OpenRouter
  - open-weight model
  - American AI
  - multimodal AI
  - audio model
  - browser agent
  - tool calling
  - Poolside Laguna
lede: >
  **Thinking Machines Inkling** is a different kind of American open-weight release: 975B total parameters, 41B active parameters, a permissive Apache 2.0 license, and native text, image, and audio input. At launch, it appears to be the largest US open-weight model by total parameter count, although that label depends on how "American" and "open" are defined. We ran the OpenRouter route through WebBrain's frozen 100-case first-action benchmark, repeated it with maximum reasoning, and added small image and audio probes. The result is not a new planner-score champion. It is something more interesting: a highly parseable, broad model that usually reaches the right tool family, handles all three advertised input modalities, and makes the recent US open-weight revival feel much less theoretical.
---

## What Thinking Machines released

[Inkling's model card](https://thinkingmachines.ai/model-card/inkling/) describes a 66-layer sparse mixture-of-experts model with **975B total parameters and 41B active parameters**. Each layer activates six of 256 routed experts plus two shared experts, with a hybrid of local and global attention.

| Inkling specification | Official value |
| --- | ---: |
| Total / active parameters | 975B / 41B |
| Training data | 45T tokens |
| Input modalities | Text, image, audio |
| Output modality | Text |
| Official context length | Up to 1M tokens |
| License | Apache 2.0 |
| BF16 deployment requirement | At least 2TB VRAM |
| NVFP4 deployment requirement | At least 600GB VRAM |

The 45T-token pretraining mixture also included video, although the released interface accepts text, images, and audio rather than video. On OpenRouter, the available route exposes **524,288 tokens** of context, not the full one-million-token headline.

This is an important distinction from many recent open releases. Inkling is not merely a text model with a vision adapter on a roadmap. [Thinking Machines' launch post](https://thinkingmachines.ai/news/introducing-inkling/) and the live API expose image and audio input today. Audio output is not supported; Inkling listens and answers in text.

## The official benchmark profile is broad

Thinking Machines explicitly says Inkling is **not the strongest model on every benchmark**. Its claim is breadth: reasoning, coding, computer use, tool use, vision, audio, and fine-tunability in one open-weight checkpoint.

Selected standalone results from the official model card:

| Official evaluation | Inkling |
| --- | ---: |
| Humanity's Last Exam, text | 29.7 |
| Humanity's Last Exam, tools | 46.0 |
| SWE-bench Verified | 77.6 |
| SWE-bench Pro Public | 54.3 |
| Terminal-Bench 2.1 | 63.8 |
| MCP Atlas | 74.1 |
| Toolathlon | 45.5 |
| IFBench | 79.8 |
| MMMU Pro | 73.5 |
| MMAU audio | 77.2 |
| VoiceBench | 91.4 |

Those numbers are strong enough to justify an independent agent test, but they should not be confused with our result. Thinking Machines evaluated with `effort=0.99` and `temperature=1.0`; coding trajectories could use up to 256K tokens. WebBrain freezes a much shorter and more deterministic first-action problem.

## What we tested

We used the exact OpenRouter model id:

```text
thinkingmachines/inkling
```

The route advertised text, image, and audio input, structured tools, reasoning controls, and a 524,288-token context window. At test time, [OpenRouter listed](https://openrouter.ai/thinkingmachines/inkling) one provider at:

```text
input:      $1.00 per million tokens
output:     $4.05 per million tokens
cache read: $0.17 per million tokens
```

The frozen WebBrain replay contains 100 browser instructions, 41 available tools, and the same system prompt used in our recent local-model tests. Every model must select its first action; it does not get a full browsing trajectory in which to recover from a weak opening.

We kept the harness defaults:

```text
temperature: 0.15
max output:  4,096 tokens
concurrency: 4
reference:   Claude Sonnet 4.6
freeze:      baseline-2026-05-23.json
system hash: 5c4fac1387025050
```

This is deliberately not a reproduction of Thinking Machines' official scaffold. It answers a narrower product question: **can the hosted model reliably dispatch WebBrain's first browser action?**

## Frozen result: valid and usually in the right tool family

| Metric | Default reasoning | Maximum reasoning |
| --- | ---: | ---: |
| Requests completed | 100 / 100 | 100 / 100 |
| API errors | 0 | 0 |
| Parsed calls | 96 | 95 |
| Schema-valid calls | 96 | 95 |
| Exact ideal action | 16 | 18 |
| Ideal tool name | **45** | 42 |
| Sonnet tool-name match, all cases | **73%** | 72% |
| Sonnet match, tool-using cases | **75.0%** | 72.8% |
| Median latency | 1.27s | **1.23s** |
| P95 latency | 3.78s | **2.85s** |
| Wall time, concurrency 4 | 38.68s | 38.50s |
| Observed account charge | $0.282 | $0.307 |

The default run is the better result. Maximum reasoning added two exact matches, but lost one parsed call, three ideal tool-name matches, one Sonnet match, and 2.2 percentage points on the tool-using subset. It also produced a 7.84-second worst-case outlier.

More revealingly, the reported reasoning usage barely moved: approximately 4.55K tokens across the default run and 4.57K with `reasoning_effort=max`. For these short dispatch tasks, OpenRouter's maximum-effort setting did not induce a meaningfully deeper pass—or Inkling simply did not need one. Either way, **turning thinking up is not an automatic upgrade here**.

## Why 45 ideal tools and only 16 exact actions?

Our strictest metric compares the entire first action, including its arguments. Inkling often selected the intended tool while choosing a different URL, query, or argument shape. That produces a useful tool-name hit without an exact-action hit.

The model's default distribution also shows a practical bias:

```text
get_accessibility_tree  40
navigate                22
clarify                 11
read_page                5
execute_javascript       5
no tool                  4
other tools             13
```

That is a sensible browser-agent prior. Inkling frequently inspects the accessibility tree before acting and uses the dedicated `clarify` tool when a request is underspecified.

The ambiguity cases expose why one headline score cannot tell the whole story. Inkling chose our ideal tool name in seven of eight ambiguous prompts, but matched the historical Sonnet tool name in only two. In several of those cases, explicitly asking the user for missing information is preferable product behavior even when it differs from the reference trace.

Our conclusion is therefore more favorable than the 73% headline alone: **Inkling is highly dispatchable**. Its remaining first-action errors are more often argument and policy disagreements than broken tool syntax.

## A deliberately narrow context check

The user asked us not to turn this into another broad model race. We therefore include only the two relevant local references: ThinkingCap, an INT4 Qwen 3.6 27B derivative, and Gemma 4 31B QAT.

| Frozen metric | Inkling via OpenRouter | ThinkingCap 27B INT4 | Gemma 4 31B QAT |
| --- | ---: | ---: | ---: |
| Parsed / valid | **96 / 96** | 91 / 91 | 95 / 95 |
| Exact ideal action | 16 | **19** | **19** |
| Ideal tool name | **45** | 35 | 37 |
| Sonnet match, all cases | 73% | **77%** | **77%** |
| Sonnet match, tool cases | 75.0% | 76.1% | **78.3%** |
| Median latency | 1.27s | 2.25s | **0.55s** |

This table is **not apples-to-apples**. Inkling was a remote, provider-managed OpenRouter route at concurrency four. ThinkingCap and Gemma ran locally in different quantizations, at different concurrency levels, through vLLM; Gemma's older run also used the legacy text-call path rather than native structured tools.

The useful takeaway is limited but clear. Inkling does not beat either local reference on Sonnet alignment or exact actions. It does lead both on valid-call count and ideal tool selection. Its advantage is not a clean benchmark sweep—it is reliable structured dispatch combined with a much wider modality and context envelope.

## Vision and audio work today

We added two small capability checks outside the frozen text-only suite. These are smoke tests, not substitute benchmarks.

### Image probe

We sent a screenshot of a password-entry page and asked Inkling to describe the page and identify the blocking state. It correctly extracted the account identifier, recognized the empty password field, read the validation error, identified the checkbox and navigation controls, and concluded that password validation was blocking progress.

The response began after 7.59 seconds and completed in 9.98 seconds. The route reported a cost of about **$0.0062** for the image request.

### Audio probe

We synthesized a short spoken nonce message containing an object and a four-digit code, sent the WAV directly to OpenRouter, and requested a rigid one-line answer. Inkling returned:

```text
OBJECT=lantern; CODE=7429
```

The exact code and object were correct. Total latency was 1.85 seconds, at a reported cost below **$0.0005**. This is only a clean transcription-and-instruction probe, but it verifies that the production route accepts and understands audio rather than merely advertising it.

Audio is a real differentiator here. Neither our frozen planner score nor parameter count captures the value of one open-weight model being able to inspect a page, listen to a clip, reason, and call tools without handing the task across several specialist models.

## The American open-weight picture has changed

For a long time, the best low-cost and locally useful open models in our tests came primarily from Chinese labs. Recent US releases are finally making that statement less absolute.

Poolside's coding-focused models were the first strong signal. Our [Laguna S 2.1 test](/blog/poolside-laguna-s-openrouter-planner-benchmark/) found an exceptionally inexpensive 118B-A8B route with credible planner behavior. [Laguna M.1](/blog/poolside-laguna-m1-openrouter-planner-benchmark/) scaled that formula to 225B total and 23B active parameters. Our earlier [Laguna XS test](/blog/poolside-laguna-xs-openrouter-planner-benchmark/) was much less impressive, so this is not a flag-waving exercise: the results still have to survive independent tests.

Inkling extends the trend in a different direction. Poolside is compact-at-runtime, coding-first, and text-only. Thinking Machines has released a vastly larger generalist with image and audio understanding. It is too large for ordinary workstation deployment, but it is also the most complete American open-weight model we have tested.

## Downsides that matter

Inkling's breadth does not make the tradeoffs disappear:

- **Local deployment is infrastructure-scale.** At least 2TB of VRAM for BF16 or 600GB for NVFP4 puts it far beyond a desktop, including an RTX 5090.
- **OpenRouter had only one provider route.** That reduces routing redundancy and makes the hosted experience depend on one backend.
- **Audio is input-only.** It can understand speech and sound, but it does not produce audio.
- **The official one-million-token limit is not the hosted limit.** OpenRouter exposed 524,288 tokens during our test.
- **Maximum reasoning did not improve the frozen result.** The default setting was slightly stronger and cheaper.
- **This is not the best first-action score in our archive.** Inkling's case rests on completeness and reliable tool dispatch, not a benchmark crown.

The pricing is attractive relative to frontier hosted models, but not in Poolside's ultra-cheap category. Heavy output use at $4.05 per million tokens can add up. Our frozen prompts benefited from substantial provider-side cache reads; the actual account-credit deltas were $0.282 for default and $0.307 for maximum reasoning.

## Verdict

Inkling passes the test that matters most for a model this ambitious: its breadth is real.

It completed every request without an API error, produced 96 valid structured calls, selected our ideal tool more often than the two narrow local references, understood a real UI screenshot, and correctly decoded a synthetic audio instruction. Increasing reasoning effort did not help, and its 73% Sonnet alignment does not make it the best WebBrain planner.

That is still a strong launch. The combination of Apache 2.0 weights, 41B active parameters, half-million-token hosted context, vision, audio, and solid tool use is unusual. After Poolside's stronger Laguna releases, Inkling is further evidence that American open-weight AI is no longer absent from the serious-model conversation.

Frozen result directories:

```text
test/llm/results/2026-07-23-inkling-openrouter-default_chrome_thinkingmachines_inkling_frozen
test/llm/results/2026-07-23-inkling-openrouter-max_chrome_thinkingmachines_inkling_frozen
```
