---
title: >
  Tencent Hy3 is a great OpenRouter planner, but text-only for now
slug: tencent-hy3-openrouter-planner-benchmark
sortOrder: 0
date: 2026-07-07
readTime: 6 min read
description: >
  We ran Tencent Hy3 through WebBrain's frozen 100-case browser-agent planner benchmark on OpenRouter. Hy3 lands in the serious hosted planner tier with 95 parsed tool calls, 20 exact first-action matches, and 73% Sonnet alignment, but the current model is still text-only.
excerpt: >
  Tencent Hy3 reached 95/100 parsed tool calls, 20/100 exact first-action matches, and 73% Sonnet alignment. It is a strong OpenRouter planner row, with multimodality as the missing piece.
titleTag: >
  Tencent Hy3 OpenRouter WebBrain planner benchmark - WebBrain Blog
ogTitle: >
  Tencent Hy3 is a strong OpenRouter planner in WebBrain's benchmark
ogDescription: >
  Hy3 via OpenRouter: 95 parsed calls, 20 exact first actions, 73% Sonnet alignment, and a clear text-only caveat for browser agents.
twitterTitle: >
  Tencent Hy3 WebBrain planner benchmark
twitterDescription: >
  Tencent Hy3 via OpenRouter is a strong text planner: 95 parsed calls, 20 exact matches, and 73% Sonnet alignment.
keywords:
  - WebBrain
  - Tencent Hy3
  - OpenRouter
  - MiniMax M3
  - MiniMax M2.7
  - Qwen 3.7 Plus
  - browser agent
  - planner benchmark
  - tool calling
lede: >
  We ran **tencent/hy3:free** through WebBrain's frozen 100-case browser-agent first-tool benchmark on OpenRouter. The short version: Hy3 is a very good hosted text planner. It does not beat the top MiniMax M2.7 / MiniMax M3 neighborhood on every headline number, but it absolutely belongs in that conversation. The practical caveat is just as important: Hy3 is text-only today, so it is not a full browser-agent model until Tencent adds image input.
---

## What we ran

The run used the same frozen May 23, 2026 WebBrain baseline used by the recent planner posts: Claude Sonnet 4.6's system prompt and 41-tool schema, system hash `5c4fac1387025050`.

```bash
node test/llm/run-llamacpp.mjs \
  --base https://openrouter.ai/api/v1 \
  --model tencent/hy3:free \
  --tag 2026-07-07-openrouter-tencent-hy3-free \
  --concurrency 3 \
  --timeout 180000 \
  --no-save-request \
  --freeze test/llm/freeze/baseline-2026-05-23.json
```

This was a native OpenAI structured-tools run. No chat-template fallback was used, and request payloads were not saved.

One operational wrinkle: OpenRouter's free-model bucket rate-limited the first pass after 28 good responses. The 72 rate-limited IDs were rerun in 12-case chunks at concurrency 1. The final saved row has 100 completed cases and zero transport errors, but wall-clock time is not comparable with the clean paid/local runs. The latency numbers below are per-case model latencies.

Result files:

```text
test/llm/results/2026-07-07-openrouter-tencent-hy3-free_chrome_tencent_hy3_free_frozen
```

## Headline result

| Metric | Tencent Hy3 via OpenRouter |
| --- | ---: |
| Completed cases | 100/100 |
| Transport errors | 0 |
| Parsed tool calls | 95/100 |
| Valid frozen-schema tool names | 95/95 |
| Strict exact first-call match | 20/100 |
| Ideal tool-name match | 38/100 |
| Sonnet match, all cases | 73.0% |
| Sonnet match, when Sonnet tooled | 75.0% |
| Average latency | 4.34s |
| Median latency | 3.68s |
| p95 latency | 9.16s |
| Slowest case | 14.11s |
| OpenRouter reported cost | $0.00 |

The clean read: this is a strong hosted tool-calling row. Hy3 completed the full suite after rate-limit recovery, produced parsed native tool calls on 95 of 100 cases, stayed entirely inside the frozen 41-tool schema, and scored a better strict exact-match count than every saved top-10 row except MiniMax M2.7.

The all-case Sonnet score is lower than the MiniMax rows, but the tool discipline is real. Hy3 is not just "free and decent"; it is good enough that the right comparison is MiniMax, not the middle of the table.

## Against MiniMax

This is the comparison that matters. Hy3 sits in the same hosted-agent lane as MiniMax M2.7 and MiniMax M3.

| Model | Parsed calls | Exact | Ideal name | Sonnet all | Sonnet tooled | Median | p95 | Cost |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| MiniMax M2.7 | 88/100 | 23/100 | 36/100 | 77.0% | 76.1% | 3.05s | 6.81s | $0.16 |
| MiniMax M3 | 85/100 | 17/100 | 32/100 | 75.0% | 73.9% | 3.07s | 8.20s | $1.06 |
| Tencent Hy3 | 95/100 | 20/100 | 38/100 | 73.0% | 75.0% | 3.68s | 9.16s | $0.00 |

Against **MiniMax M3**, Hy3 is the more disciplined structured-tools model in this run: +10 parsed calls, +3 exact matches, +6 ideal-name matches, and a better Sonnet-tooled score. M3 still wins the all-case Sonnet metric by two cases, mostly because Hy3 diverges on boundary prompts where Sonnet returns no tool or asks for confirmation.

Against **MiniMax M2.7**, the result is more mixed. M2.7 still has the better all-case Sonnet score and exact-action score. Hy3 beats it on parsed calls and ideal tool-name count, and it is very close on the Sonnet-tooled subset. If I were picking purely from this frozen first-turn harness, M2.7 still stays ahead. If I were choosing a cheap hosted text planner to watch, Hy3 is the new obvious candidate.

One cost caveat: this run used [OpenRouter's free Hy3 variant](https://openrouter.ai/tencent/hy3%3Afree), and OpenRouter marks that free variant as temporary. Treat the $0.00 row as a free-tier result, not a permanent pricing promise.

## Current top 10

Rows are ranked by all-case Sonnet match, then Sonnet-tooled match.

| # | Model | Parsed calls | Exact | Ideal name | Sonnet all | Sonnet tooled | Median |
| ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | Gemma 4 31B QAT w4a16 | 95/100 | 19/100 | 37/100 | 77.0% | 78.3% | 0.55s |
| 2 | Qwen 3.6 27B | 92/100 | 18/100 | 37/100 | 77.0% | 77.2% | 10.18s |
| 3 | MiniMax M2.7 | 88/100 | 23/100 | 36/100 | 77.0% | 76.1% | 3.05s |
| 4 | Qwen 3.7 Plus | 95/100 | 19/100 | 41/100 | 75.0% | 77.2% | 3.74s |
| 5 | MiniMax M3 | 85/100 | 17/100 | 32/100 | 75.0% | 73.9% | 3.07s |
| 6 | Qwen 3.6 27B NVFP4 | 96/100 | 18/100 | 38/100 | 74.0% | 77.2% | 1.76s |
| 7 | Intel Gemma 4 31B int4 AutoRound | 88/100 | 14/100 | 34/100 | 74.0% | 72.8% | 0.63s |
| 8 | **Tencent Hy3** | **95/100** | **20/100** | **38/100** | **73.0%** | **75.0%** | **3.68s** |
| 9 | WebBrain Cloud 1.0 | 90/100 | 16/100 | 35/100 | 73.0% | 72.8% | 8.77s |
| 10 | Qwen 3.5 4B | 82/100 | 12/100 | 33/100 | 73.0% | 71.7% | 5.44s |

This is a good debut. Hy3 does not enter above the top hosted rows, but it does enter the top 10 and wins the 73% tie-breaker against WebBrain Cloud 1.0 and Qwen 3.5 4B. It also has the second-best exact-match count in the table.

## Where it is strong

The tool distribution is healthy:

| Tool or output | First calls |
| --- | ---: |
| `get_accessibility_tree` | 43 |
| `navigate` | 22 |
| `execute_js` | 6 |
| `clarify` | 5 |
| no tool call | 5 |
| `read_page` | 4 |
| `download_file` | 3 |
| `new_tab` | 3 |
| `extract_data` | 2 |
| `list_downloads` | 2 |
| `download_social_media` | 1 |
| `get_interactive_elements` | 1 |
| `get_selection` | 1 |
| `screenshot` | 1 |
| `scroll` | 1 |

The strongest category bands were the practical browser-agent ones:

| Category | Sonnet matches |
| --- | ---: |
| Direct navigation | 10/10 |
| Search | 10/10 |
| Forms / interactive | 8/8 |
| Page reading / summarize | 6/8 |
| Email | 5/6 |
| GitHub flows | 4/6 |
| Knowledge questions | 4/5 |
| Multi-page / listing | 3/3 |

That is why I like this row. Hy3 can route ordinary browser work. It navigates cleanly, starts forms with the accessibility tree, and does not fall out of the structured `tools` interface.

## Where it loses points

The weak spots are mostly boundary decisions:

| Category | Sonnet matches | Pattern |
| --- | ---: | --- |
| Ambiguous / clarify | 1/8 | Split across page inspection, no-tool answers, `clarify`, and one `execute_js` call. |
| Destructive / refusal-worthy | 3/6 | Often inspected the page instead of asking for explicit confirmation first. |
| Browser internals | 2/5 | Mixed `navigate`, `execute_js`, `screenshot`, and page inspection choices. |
| Downloads | 4/6 | Picked plausible download tools, but differed from Sonnet on YouTube thumbnail and README cases. |
| UI mutations | 2/4 | Mixed navigation, page inspection, and `execute_js` on browser-control tasks. |

This explains the gap between Hy3's strong exact/ideal scores and its lower all-case Sonnet score. It is good when a browser tool should be used. It is less Sonnet-like when the correct first move is to pause, refuse, answer directly, or handle a browser-internal edge.

## The multimodal gap

For WebBrain, the obvious missing piece is vision. [OpenRouter's Hy3 model page](https://openrouter.ai/tencent/hy3%3Afree) and public model metadata currently expose Hy3 as `text->text`: text input, text output, no image input. That makes this benchmark a planner result, not a full browser-agent result.

That distinction matters because WebBrain often needs screenshots: visual confirmation, OCR-ish page states, canvas-heavy apps, broken accessibility trees, and UI affordances that text extraction misses. A text-only planner can choose tools well, but it cannot replace a multimodal browser model.

I still expect this gap to close. Tencent is clearly positioning Hy3 for agentic workflows, long-horizon tasks, tool-calling, coding, document processing, financial analysis, game development, and frontend design. In the broader Chinese frontier-model lane, text-first releases have been moving toward visual capabilities quickly; [DeepSeek's V4 release](https://api-docs.deepseek.com/news/news260424) is text/agent/1M-context focused in the public docs, while the surrounding DeepSeek ecosystem has been pushing vision-token and OCR-style work. Hy3 feels like the same kind of model family: strong text first, multimodal pressure next.

So the fair wording is: Hy3 is not multimodal yet, but I would be surprised if Tencent leaves it text-only for long. If image input arrives in the coming months and the tool-calling behavior holds, this becomes much more interesting for WebBrain than the current row already is.

## Bottom line

Tencent Hy3 is a great hosted text planner in this frozen WebBrain benchmark. It is not the new overall winner, and MiniMax M2.7 still has the stronger all-case Sonnet row. But Hy3 is cleaner than MiniMax M3 on parsed tool calls, exact matches, ideal-name matches, and Sonnet-tooled alignment, while matching the practical latency band and costing nothing in this temporary free run.

The caveat is simple: it is text-only today. For WebBrain, that keeps it in the planner bucket rather than the full agent bucket. Add vision, keep this tool discipline, and Hy3 becomes a serious default-candidate conversation instead of just a very good OpenRouter benchmark row.

Tags: #TencentHy3 #OpenRouter #MiniMaxM3 #MiniMaxM27 #ToolCalling #BrowserAgent #WebBrain
