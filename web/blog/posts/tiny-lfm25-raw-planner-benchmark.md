---
title: >
  Tiny raw LFM 2.5 checkpoints in WebBrain's frozen planner benchmark
slug: tiny-lfm25-raw-planner-benchmark
sortOrder: -20
date: 2026-06-26
readTime: 5 min read
description: >
  We ran two tiny raw Liquid LFM 2.5 checkpoints, 230M and 350M, through WebBrain's frozen 100-case browser-agent first-tool benchmark on a local OpenAI-compatible endpoint.
excerpt: >
  LFM 2.5 230M and 350M both completed the frozen WebBrain planner run without transport errors. The raw tiny checkpoints are not good browser planners yet, but their failure shape is useful fine-tuning data.
titleTag: >
  Tiny raw LFM 2.5 planner benchmark - WebBrain Blog
ogTitle: >
  Tiny raw LFM 2.5 checkpoints in WebBrain's planner benchmark
ogDescription: >
  LFM 2.5 230M and 350M on WebBrain's frozen browser-agent first-tool harness: clean API runs, weak planner routing, useful fine-tuning signal.
twitterTitle: >
  Tiny raw LFM 2.5 planner benchmark
twitterDescription: >
  Two raw tiny LFM 2.5 checkpoints completed WebBrain's frozen 100-case tool-calling run. The numbers are small, and that is mostly the point.
keywords:
  - WebBrain
  - LFM 2.5
  - Liquid AI
  - tiny language model
  - browser agent
  - tool calling
  - planner benchmark
  - Qwen 3.5
lede: >
  We ran two tiny raw Liquid LFM 2.5 checkpoints through WebBrain's frozen browser-agent first-tool benchmark: **lfm2.5-230m** and **lfm2.5-350m** served locally from `http://localhost:8000`. Both runs completed all 100 cases without transport errors. The quality numbers are low, but that is not a surprise: these are tiny raw checkpoints, not WebBrain-tuned browser planners. The useful result is the shape of the mistakes.
---

## What we ran

Both runs used the same frozen May 23, 2026 WebBrain baseline used by the published planner table: Claude Sonnet 4.6's system prompt and 41-tool schema, system hash `5c4fac1387025050`. The endpoint was a local OpenAI-compatible server at `http://localhost:8000`.

```bash
node test/llm/run-llamacpp.mjs \
  --base http://localhost:8000 \
  --model lfm2.5-230m \
  --tag 2026-06-26-lfm25-230m-localhost8000 \
  --concurrency 16 \
  --timeout 180000 \
  --no-save-request \
  --freeze test/llm/freeze/baseline-2026-05-23.json

node test/llm/run-llamacpp.mjs \
  --base http://localhost:8000 \
  --model lfm2.5-350m \
  --tag 2026-06-26-lfm25-350m-localhost8000 \
  --concurrency 16 \
  --timeout 180000 \
  --no-save-request \
  --freeze test/llm/freeze/baseline-2026-05-23.json
```

One naming note: the second local server advertised `lfm2.5-350m` with root `LiquidAI/LFM2.5-350M`, so that is the label used here.

Result files:

```text
test/llm/results/2026-06-26-lfm25-230m-localhost8000_chrome_lfm2.5-230m_frozen
test/llm/results/2026-06-26-lfm25-350m-localhost8000_chrome_lfm2.5-350m_frozen
```

## Headline results

| Metric | LFM 2.5 230M raw | LFM 2.5 350M raw |
| --- | ---: | ---: |
| Completed cases | 100/100 | 100/100 |
| Transport errors | 0 | 0 |
| Parsed tool calls | 100/100 | 86/100 |
| Valid frozen-schema tool names | 90/100 | 75/100 |
| Strict exact first-call match | 0/100 | 0/100 |
| Ideal tool-name match | 4/100 | 4/100 |
| Sonnet match, all cases | 19.0% | 25.0% |
| Sonnet match, when Sonnet tooled | 20.7% | 22.8% |
| Median latency | 1.0s | 1.1s |
| p95 latency | 65.5s | 5.3s |
| Total wall time at concurrency 16 | 71s | 12s |

The clean positive signal: both models were usable through the OpenAI-compatible API path. There were no request failures, and the 230M run emitted a parsed tool call on every case.

The planner signal is much weaker. Neither model produced an exact match against the benchmark's ideal first call. Both matched the ideal tool name only four times. Against the Sonnet 4.6 first-tool reference, the 350M checkpoint did better than the 230M checkpoint, but both are far below the small tuned and instruction-following models already in the table.

## How they failed

The 230M checkpoint is syntactically eager and strategically narrow. It calls tools constantly, but it collapses toward inspection:

| Tool | LFM 2.5 230M calls |
| --- | ---: |
| `get_accessibility_tree` | 61 |
| `read_page` | 21 |
| `search_url` | 4 |
| `click` | 2 |
| all other first tools | 12 |

That is why it has 100 parsed tool calls but only 19% Sonnet first-tool alignment. It often knows that a browser agent should use a tool, but it does not yet know which first action matches the user's intent. Direct navigation prompts, browser-internal pages, and search tasks frequently became generic page inspection.

The 350M checkpoint is more varied and closer to Sonnet, but less schema-disciplined:

| Tool or output | LFM 2.5 350M calls |
| --- | ---: |
| `get_accessibility_tree` | 43 |
| `read_page` | 15 |
| no tool call | 14 |
| `read_pdf` | 4 |
| `search_url` | 3 |
| `stop_recording` | 3 |
| all other first tools | 18 |

That variety helps it reach 25% Sonnet first-tool alignment, but it also produces more invalid or non-frozen tool names: `open_link`, `open_chat`, `stop_recording`, `close_popup`, `compose`, `solve_captcha`, and `delete_all_emails` are not part of the frozen 41-tool schema. For a browser-agent planner, that is a fine-tuning problem before it is a reasoning problem.

## Context against the older LFM and tiny Qwen rows

The most useful comparison is not with the top of the leaderboard. It is with other small or efficiency-oriented models.

| Model | Parsed calls | Valid names | Ideal name | Sonnet all | Sonnet tooled | Median |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| LFM 2.5-8B-A1B | 83/100 | 83/100 | 23/100 | 40.0% | 38.0% | 5.9s |
| Qwen 3.5 0.8B | 90/100 | 90/100 | 15/100 | 37.0% | 34.8% | 0.44s |
| Qwen 3.5 2B | 89/100 | 89/100 | 7/100 | 36.0% | 34.8% | 0.78s |
| LFM 2.5 350M raw | 86/100 | 75/100 | 4/100 | 25.0% | 22.8% | 1.1s |
| LFM 2.5 230M raw | 100/100 | 90/100 | 4/100 | 19.0% | 20.7% | 1.0s |

The earlier LFM 2.5-8B-A1B run is still the better Liquid comparison point for actual planner use. It matched Sonnet on 40% of all cases and had 23 ideal tool-name matches. The tiny raw checkpoints do not reach that tier.

Qwen 3.5 0.8B is the sharper tiny baseline. Even with fewer than one billion parameters, it keeps higher valid-tool discipline and materially better Sonnet alignment than either raw tiny LFM run. That does not make the tiny LFMs uninteresting. It does show that raw scale at 230M or 350M is not enough for browser planning without task-specific post-training.

## What this means

These runs should not be read as "LFM is bad at tools." They are closer to a pre-fine-tuning diagnostic. WebBrain's benchmark asks a very specific first-turn planning question: given a browser state, a user instruction, and 41 available tools, choose the first tool and arguments. Tiny raw models are not expected to have that policy baked in.

What they do show is encouraging in a narrower way:

- The local serving path works cleanly with WebBrain's OpenAI-compatible runner.
- The 230M model strongly learned the "emit a tool call" behavior, even if it overuses inspection.
- The 350M model has a broader action vocabulary and better Sonnet alignment, but needs schema control.
- Both runs are small enough that fine-tuning experiments should be cheap and fast.

For WebBrain, the next interesting experiment is not to keep benchmarking these raw checkpoints as-is. It is to tune them on browser-planner traces and rerun the same frozen harness. If a 230M or 350M model can be trained out of the `get_accessibility_tree` default and into reliable schema-following, it becomes a much more interesting on-device planner candidate.

The bottom line: raw tiny LFMs are not ready browser planners. That is fine. They are the kind of models you fine-tune into a planner, and this run gives us a compact before-picture. Liquid's new [LFM2.5-230M](https://www.liquid.ai/blog/lfm2-5-230m) strengthens that case: if a 230M model can perform as well as the 350M checkpoint while being roughly 33% smaller, it should become the default tiny LFM target for fine-tuning experiments. For no-fine-tuning, raw tiny-model use, though, Qwen 3.5 0.8B remains the de facto standard to beat.

Tags: #LFM25 #LiquidAI #TinyLanguageModels #ToolCalling #BrowserAgent #WebBrain
