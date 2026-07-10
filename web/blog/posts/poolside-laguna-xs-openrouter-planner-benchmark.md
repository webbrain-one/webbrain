---
title: >
  Poolside Laguna XS is fast and free, but not a WebBrain planner win
slug: poolside-laguna-xs-openrouter-planner-benchmark
sortOrder: -70
date: 2026-07-10
readTime: 6 min read
description: >
  We ran poolside/laguna-xs-2.1:free through WebBrain's frozen 100-case browser-agent first-tool benchmark on OpenRouter. It is very fast and free to call, but 65% Sonnet alignment, only 6 exact first actions, and malformed tool names keep it out of the planner shortlist.
excerpt: >
  Laguna XS completed WebBrain's frozen planner suite with 92 parsed calls, 89 valid tool names, 65% Sonnet alignment, and a 1.30s median latency. The endpoint is quick; the planner quality is not competitive.
titleTag: >
  Poolside Laguna XS OpenRouter WebBrain planner benchmark - WebBrain Blog
ogTitle: >
  Poolside Laguna XS is fast and free, but not a planner win
ogDescription: >
  Laguna XS on OpenRouter is quick and free, but its WebBrain planner row lands at 65% Sonnet alignment with weak exact-match behavior and a few malformed tool names.
twitterTitle: >
  Poolside Laguna XS WebBrain planner benchmark
twitterDescription: >
  Laguna XS via OpenRouter: 92 parsed calls, 89 valid tool names, 6 exact first actions, 65% Sonnet alignment, and 1.30s median latency.
keywords:
  - WebBrain
  - Poolside
  - Laguna XS
  - OpenRouter
  - browser agent
  - planner benchmark
  - tool calling
  - free model
lede: >
  `poolside/laguna-xs-2.1:free` is a tempting OpenRouter target for WebBrain because it is free, fast, and exposes native tool calling through the OpenAI-compatible API. We ran it through the same frozen 100-case browser-agent first-tool benchmark used in the recent planner posts. The result is useful, but not flattering: Laguna XS is one of the faster hosted rows we have tested, yet it lands in the 65% Sonnet-alignment band and produces only six strict exact first-call matches.
---

## What we ran

We used OpenRouter's OpenAI-compatible endpoint:

```text
poolside/laguna-xs-2.1:free
```

The run used the same frozen May 23, 2026 WebBrain baseline used by the recent planner posts: Claude Sonnet 4.6's system prompt and 41-tool schema, system hash `5c4fac1387025050`.

```bash
OPENROUTER_API_KEY=... node test/llm/run-llamacpp.mjs \
  --base https://openrouter.ai/api/v1 \
  --model poolside/laguna-xs-2.1:free \
  --tag 2026-07-10-openrouter-laguna-xs \
  --concurrency 2 \
  --timeout 180000 \
  --no-save-request \
  --freeze test/llm/freeze/baseline-2026-05-23.json
```

This was a native OpenAI structured-tools run. No chat-template fallback was used, and request payloads were not saved.

One operational wrinkle: OpenRouter's free-model pool enforced a `free-models-per-min` limit of 16 requests per minute. The first full pass hit 429s after the early cases. We then resumed the failed cases one at a time with pauses. The final per-case result set below has 100 completed cases and zero remaining transport errors; wall-clock time is therefore not comparable with normal uninterrupted runs.

Result files:

```text
test/llm/results/2026-07-10-openrouter-laguna-xs_chrome_poolside_laguna-xs-2.1_free_frozen
```

## Headline result

| Metric | Poolside Laguna XS via OpenRouter |
| --- | ---: |
| Completed cases | 100/100 |
| Transport errors after paced retry | 0 |
| Parsed tool calls | 92/100 |
| Valid frozen-schema tool names | 89/100 |
| Malformed tool names | 3 |
| Strict exact first-call match | 6/100 |
| Ideal tool-name match | 27/100 |
| Sonnet match, all cases | 65.0% |
| Sonnet match, when Sonnet tooled | 65.2% |
| Sonnet no-tool decisions matched | 5/8 |
| Average latency | 1.62s |
| Median latency | 1.30s |
| p95 latency | 3.08s |
| Slowest case | 16.32s |
| OpenRouter reported cost | $0.00 |

The speed is genuinely good. Median latency was 1.30s, p95 was 3.08s, and the endpoint reported zero cost for this free run. For a hosted model behind OpenRouter, that is a pleasant operational profile.

The planner score is the problem. Laguna XS lands at the same 65% all-case Sonnet alignment as Nex-N2-mini and Nemotron 3 Ultra free, but with much weaker strict exact behavior than both. Six exact first-call matches is not enough for WebBrain's default planner slot.

## The protocol issue

Laguna XS emitted native OpenAI `tool_calls`, but three of those calls had malformed tool names. Instead of choosing one function from the 41-tool schema, it packed tool-like text into the function name itself:

| Case | Malformed tool name |
| --- | --- |
| 018 | `click(...)<tool_call>click(...)<tool_call>wait_for_element` |
| 060 | `click(...)<tool_call>click(...)<tool_call>type_text(...)<tool_call>press_keys(...)` |
| 071 | `get_accessibility_tree<filter: "visible"` |

That is an important distinction. The runner could parse 92 tool calls, but only 89 were valid frozen-schema tool names. A malformed tool name is worse than a wrong but valid tool call: the browser agent cannot dispatch it without repair logic.

This is the main reason I would be cautious with Laguna XS even though the raw parsed-call count looks decent.

## Against nearby free hosted rows

The nearest comparisons are Nex-N2-mini and Nemotron 3 Ultra free: both are OpenRouter-hosted rows that also landed at 65% all-case Sonnet alignment.

| Model | Parsed calls | Valid names | Exact | Ideal name | Sonnet all | Sonnet tooled | Median | p95 | Cost |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Nex-N2-mini | 93/100 | 93/100 | 16/100 | 28/100 | 65.0% | 66.3% | 2.23s | 4.34s | $0.045 |
| Laguna XS free | 92/100 | 89/100 | 6/100 | 27/100 | 65.0% | 65.2% | 1.30s | 3.08s | $0.00 |
| Nemotron 3 Ultra free | 81/100 | 81/100 | 17/100 | 33/100 | 65.0% | 64.1% | 5.89s | 40.6s | $0.00 |

Laguna XS is the fastest of this 65% band. It also emits more parsed calls than Nemotron and is much easier to wait for interactively.

But speed does not rescue the planner result. Nex-N2-mini has cleaner tool discipline and ten more exact first actions. Nemotron is slower and parses fewer tool calls, but still beats Laguna on exact and ideal-name counts. In this harness, Laguna XS is the quick one, not the precise one.

## Where it works

Laguna XS does have some clean slices:

| Category | Cases | Sonnet-name matches | Ideal-name matches |
| --- | ---: | ---: | ---: |
| Direct navigation | 10 | 10 | 9 |
| Forms / interactive | 8 | 8 | 0 |
| Email | 6 | 6 | 0 |
| Page reading / summarize | 8 | 5 | 4 |
| Downloads | 6 | 4 | 2 |
| Knowledge questions | 5 | 4 | 0 |
| Scrolling / inspection | 4 | 3 | 2 |
| Tab management | 4 | 3 | 1 |

Direct navigation is the best part of the run. It matched Sonnet on all ten direct-navigation cases and picked the ideal tool name nine times. That is the baseline sanity check a browser planner has to pass, and Laguna passes it.

It also behaved well on forms and email by Sonnet-name match, mostly by choosing `get_accessibility_tree`. That inspect-first habit is not crazy for a live browser agent. It is often exactly what a cautious planner should do before interacting with unknown UI.

## Where it loses

The weak slices are the ones that need decisive routing:

| Category | Cases | Sonnet-name matches | Pattern |
| --- | ---: | ---: | --- |
| Search queries | 10 | 6 | Mixed direct navigation, page inspection, and malformed multi-call tool names. |
| GitHub flows | 6 | 2 | Defaulted to page inspection where Sonnet often used a more direct first move. |
| Ambiguous / clarify | 8 | 1 | Only one Sonnet-name match despite five no-tool-compatible outputs overall. |
| Destructive / refusal-worthy | 6 | 2 | No strong improvement on the high-stakes band. |
| UI mutations | 4 | 1 | Too much generic inspection versus the expected first action. |
| Multi-page / listing | 3 | 2 | One no-tool miss in a small but useful slice. |

The ambiguous band is the clearest behavioral miss. Laguna matched only 1/8 Sonnet names there. It did return no tool on some ambiguous or knowledge-style prompts, but the planner loop needs a stable distinction between "ask the user", "answer without a tool", and "inspect the current page." Laguna blurs that line.

The malformed multi-call outputs also showed up in action-heavy prompts. That makes the model feel as if it learned the idea of browser workflows, but not the exact contract: first turn, one tool call, one valid function name.

## Token profile

OpenRouter reported a lot of cached prompt reuse in this run:

| Token counter | Total |
| --- | ---: |
| Prompt tokens | 1,706,344 |
| Cached prompt tokens | 1,390,176 |
| Completion tokens | 11,221 |
| Reasoning tokens | 6,694 |
| Total tokens | 1,717,565 |

The completion side is heavier than the best local rows. Laguna used 11,221 completion tokens, compared with 7,348 for the patched ThinkingCap run and 7,720 for the older Qwen 3.6 27B row. Some of that is visible in the malformed tool-name cases, where it tries to squeeze a mini-plan into one tool call.

## Updated context

Rows are ranked by all-case Sonnet match, then Sonnet-tooled match.

| # | Model | Parsed calls | Exact | Ideal name | Sonnet all | Sonnet tooled | Median |
| ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | Gemma 4 31B QAT w4a16 | 95/100 | 19/100 | 37/100 | 77.0% | 78.3% | 0.55s |
| 2 | Qwen 3.6 27B | 92/100 | 18/100 | 37/100 | 77.0% | 77.2% | 10.18s |
| 3 | MiniMax M2.7 | 88/100 | 23/100 | 36/100 | 77.0% | 76.1% | 3.05s |
| 4 | ThinkingCap 27B INT4 | 91/100 | 19/100 | 35/100 | 77.0% | 76.1% | 2.25s |
| 5 | Qwen 3.7 Plus | 95/100 | 19/100 | 41/100 | 75.0% | 77.2% | 3.74s |
| 6 | Agents-A1 AWQ INT4 | 88/100 | 15/100 | 33/100 | 75.0% | 75.0% | 1.66s |
| 7 | MiniMax M3 | 85/100 | 17/100 | 32/100 | 75.0% | 73.9% | 3.06s |
| 8 | Qwen 3.6 27B NVFP4 | 96/100 | 18/100 | 38/100 | 74.0% | 77.2% | 1.76s |
| 9 | Tencent Hy3 free | 95/100 | 20/100 | 38/100 | 73.0% | 75.0% | 3.68s |
| 10 | WebBrain Cloud 1.0 | 90/100 | 16/100 | 35/100 | 73.0% | 72.8% | 8.77s |
| 11 | Ornith-1.0-35B NVFP4 | 88/100 | 21/100 | 36/100 | 71.0% | 70.7% | 2.38s |
| 12 | Qwen 3.6 35B-A3B | 90/100 | 18/100 | 38/100 | 70.0% | 70.7% | 10.29s |
| 13 | Nex-N2-mini | 93/100 | 16/100 | 28/100 | 65.0% | 66.3% | 2.23s |
| 14 | Laguna XS free | 92/100 | 6/100 | 27/100 | 65.0% | 65.2% | 1.30s |
| 15 | Nemotron 3 Ultra free | 81/100 | 17/100 | 33/100 | 65.0% | 64.1% | 5.89s |

This is not a shortlist row. Laguna XS is fast enough to be pleasant, but it sits below the real planner candidates on exactness, ideal-name score, and tool-call contract discipline.

## Bottom line

Poolside Laguna XS is a good reminder that low latency and native tool calling are necessary, not sufficient.

For cheap experimentation, the endpoint is nice. It completed the frozen suite after paced retries, reported zero cost, returned quickly, and matched direct-navigation cases cleanly. If all you need is a free OpenRouter endpoint that can usually emit a tool call, it is usable.

For WebBrain's planner shortlist, I would not use this run as a reason to move it forward. The 65% Sonnet score is middle-to-low in the current table, and the `6/100` exact score is the real warning sign. A browser agent needs one valid, dispatchable first action. Laguna XS sometimes gives you that. Sometimes it gives you a tiny action script jammed into a function name. That is fun to read, but not something I want in the driver's seat.

Tags: #Poolside #LagunaXS #OpenRouter #ToolCalling #BrowserAgent #WebBrain
