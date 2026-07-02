---
title: >
  Qwen 3.6 27B NVFP4 is much faster, but not a clean planner upgrade
slug: qwen36-27b-nvfp4-planner-benchmark
sortOrder: 0
date: 2026-07-02
readTime: 6 min read
description: >
  We tested nvidia/Qwen3.6-27B-NVFP4 against WebBrain's frozen browser-agent first-tool benchmark. It is far faster than the older Qwen 3.6 27B row and enters the top 10, but loses three all-case Sonnet-alignment points on boundary cases.
excerpt: >
  Qwen 3.6 27B NVFP4 gives WebBrain a big local latency win: 96/100 parsed calls, 1.8s median latency, and a top-10 Sonnet-reference result. The planner quality story is more mixed.
titleTag: >
  Qwen 3.6 27B NVFP4 WebBrain planner benchmark - WebBrain Blog
ogTitle: >
  Qwen 3.6 27B NVFP4 enters WebBrain's planner top 10
ogDescription: >
  The NVFP4 Qwen 3.6 27B variant is much faster than the older saved Qwen row, but the all-case Sonnet benchmark exposes a boundary-case tradeoff.
twitterTitle: >
  Qwen 3.6 27B NVFP4 WebBrain benchmark
twitterDescription: >
  Faster, more parseable, top-10 - but not a clean all-case quality upgrade over the older Qwen 3.6 27B row.
keywords:
  - WebBrain
  - Qwen 3.6
  - Qwen 3.6 27B
  - NVFP4
  - NVIDIA
  - vLLM
  - browser agent
  - planner benchmark
  - tool calling
lede: >
  We ran **nvidia/Qwen3.6-27B-NVFP4** through WebBrain's frozen 100-case browser-agent planner benchmark because the NVFP4 build is supposed to be the more performant Qwen 3.6 27B serving path. The performance claim holds: this run is dramatically faster than the older saved Qwen 3.6 27B row. The planner-quality claim is more nuanced: it enters the current Sonnet-reference top 10, but it does not beat old Qwen on all-case Sonnet alignment.
---

## What we ran

The local vLLM server at `http://localhost:8000` advertised:

```json
{
  "id": "qwen3.6-27b",
  "root": "nvidia/Qwen3.6-27B-NVFP4",
  "max_model_len": 65536
}
```

We used the same frozen May 23, 2026 WebBrain baseline used by the recent planner posts: Claude Sonnet 4.6's system prompt and 41-tool schema, system hash `5c4fac1387025050`.

```bash
node test/llm/run-llamacpp.mjs \
  --base http://localhost:8000 \
  --model qwen3.6-27b \
  --tag 2026-07-02-qwen36-27b-nvfp4-localhost8000 \
  --concurrency 3 \
  --timeout 180000 \
  --no-save-request \
  --freeze test/llm/freeze/baseline-2026-05-23.json
```

This run used native OpenAI-style structured tools (`--chat-template-compat off`). Concurrency was capped at 3 because the vLLM server was running with `num-seqs=3`.

Result files:

```text
test/llm/results/2026-07-02-qwen36-27b-nvfp4-localhost8000_chrome_qwen3.6-27b_frozen
```

## Headline result

| Metric | Qwen 3.6 27B NVFP4 |
| --- | ---: |
| Completed cases | 100/100 |
| Transport errors | 0 |
| Parsed tool calls | 96/100 |
| Valid frozen-schema tool names | 96/100 |
| Strict exact first-call match | 18/100 |
| Ideal tool-name match | 38/100 |
| Sonnet match, all cases | 74.0% |
| Sonnet match, when Sonnet tooled | 77.2% |
| Average latency | 2.19s |
| Median latency | 1.76s |
| p95 latency | 6.49s |
| Slowest case | 8.66s |
| Total wall time | 74s at concurrency 3 |

That is a useful row. It emits native tool calls cleanly, every emitted tool name is in the frozen schema, and median latency is low enough for an interactive browser loop.

But it is not a clean quality upgrade over the older Qwen 3.6 27B result.

## Against old Qwen 3.6 27B

The old row is still the main comparison point because it is the same model family and size in the saved WebBrain benchmark table.

| Model | Parsed calls | Exact | Ideal name | Sonnet all | Sonnet tooled | Median | p95 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Qwen 3.6 27B | 92/100 | 18/100 | 37/100 | 77.0% | 77.2% | 10.2s | 15.0s |
| Qwen 3.6 27B NVFP4 | 96/100 | 18/100 | 38/100 | 74.0% | 77.2% | 1.76s | 6.49s |

The speedup is the obvious win: 1.76s median versus 10.2s is about a 5.8x improvement in the saved rows. The p95 also drops from 15.0s to 6.49s.

The quality picture splits:

- NVFP4 parses more calls: 96 instead of 92.
- NVFP4 has one more ideal tool-name match: 38 instead of 37.
- Strict exact matches are tied at 18.
- Sonnet-tooled matches are tied at 71/92.
- All-case Sonnet alignment drops from 77/100 to 74/100.

That last line is the trick. The new run did not get worse at matching Sonnet on prompts where Sonnet actually used a tool. It tied the old Qwen row there. The three-point loss comes from prompts where Sonnet intentionally returned no tool.

Sonnet returned no tool on eight frozen cases. The old Qwen row matched six of those no-tool decisions. NVFP4 matched three. In the other five, it emitted tools like `screenshot`, `scratchpad_write`, `done`, or `clarify`. That is not a schema failure. It is a boundary-discipline issue: the model is more eager to do something.

## Current Sonnet-reference top 10

Rows are ranked by all-case Sonnet match, then by Sonnet-tooled match as the first tiebreaker. Claude Sonnet 4.6 is the reference, not included as a ranked row.

| # | Model | Parsed calls | Exact | Ideal name | Sonnet all | Sonnet tooled | Median |
| ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | Gemma 4 31B QAT w4a16 | 95/100 | 19/100 | 37/100 | 77.0% | 78.3% | 0.55s |
| 2 | Qwen 3.6 27B | 92/100 | 18/100 | 37/100 | 77.0% | 77.2% | 10.2s |
| 3 | MiniMax M2.7 | 88/100 | 23/100 | 36/100 | 77.0% | 76.1% | 3.1s |
| 4 | MiniMax M3 | 85/100 | 17/100 | 32/100 | 75.0% | 73.9% | 3.1s |
| 5 | **Qwen 3.6 27B NVFP4** | **96/100** | **18/100** | **38/100** | **74.0%** | **77.2%** | **1.76s** |
| 6 | Intel Gemma 4 31B int4 AutoRound | 88/100 | 14/100 | 34/100 | 74.0% | 72.8% | 0.63s |
| 7 | WebBrain Cloud 1.0 | 90/100 | 16/100 | 35/100 | 73.0% | 72.8% | 8.8s |
| 8 | Qwen 3.5 4B | 82/100 | 12/100 | 33/100 | 73.0% | 71.7% | 5.5s |
| 9 | Ornith-1.0-35B NVFP4 | 88/100 | 21/100 | 36/100 | 71.0% | 70.7% | 2.4s |
| 10 | Gemma 4 26B-A4B | 87/100 | 13/100 | 30/100 | 71.0% | 70.7% | 1.4s |

This is the fair positive interpretation: NVFP4 enters the top 10 and has the highest parsed-call count in that table. It also has the best ideal-name score in the top 10, tied with Qwen 3.6 35B just below the cut. If you only look at cases where Sonnet picked a tool, it is tied with old Qwen 3.6 27B.

The fair negative interpretation is also real: the old Qwen 3.6 27B row is still better on the all-case metric because it declines or answers directly more often in the same places Sonnet does.

## Where it is strong

The tool distribution looks healthy:

| Tool or output | First calls |
| --- | ---: |
| `get_accessibility_tree` | 39 |
| `navigate` | 21 |
| `execute_js` | 8 |
| `read_page` | 6 |
| no tool call | 4 |
| `screenshot` | 4 |
| `clarify` | 3 |
| `new_tab` | 3 |
| `extract_data` | 2 |
| `list_downloads` | 2 |
| `verify_form` | 2 |

The cleanest category wins are the normal browser-agent routing cases:

| Category | Sonnet matches |
| --- | ---: |
| Direct navigation | 10/10 |
| Search | 10/10 |
| Page reading | 7/8 |
| Forms / interactive | 7/8 |
| Tab management | 4/4 |
| UI mutations | 4/4 |
| Translation / accessibility | 3/3 |
| Multi-page / listing | 3/3 |

For ordinary "go here", "search this", "read this", "change this UI setting" first moves, the model is right in the top local tier. That is the part of the result that feels like a real deployable planner.

## Where it loses points

The weaker bands are the boundaries and special-purpose shortcuts:

| Category | Sonnet matches | What happened |
| --- | ---: | --- |
| Ambiguous / clarify | 0/8 | Over-tooled or picked the wrong terminal shape on no-tool and clarify-style cases. |
| Destructive / refusal-worthy | 2/6 | Often inspected or verified instead of matching Sonnet's confirmation boundary. |
| Downloads | 3/6 | Missed some `download_file`, `download_social_media`, and `fetch_url` shortcut choices. |
| GitHub flows | 3/6 | Preferred page inspection for some flows where Sonnet navigated or fetched directly. |
| Knowledge questions | 3/5 | Correctly no-tooled three short-answer cases, but used tools on two others. |

The ambiguous band is the entire reason the all-case score falls below old Qwen. Case 075 is a good example: "finish what we were doing" is intentionally under-specified. Sonnet returned no tool. Old Qwen returned no tool. NVFP4 wrote to the scratchpad. That is a valid WebBrain tool name, but it is the wrong kind of eagerness for this benchmark.

## Bottom line

Qwen 3.6 27B NVFP4 is a strong local serving result. It is far faster than the older saved Qwen 3.6 27B row, produces more parsed native tool calls, stays inside the frozen schema, and enters the current Sonnet-reference top 10.

It is not a clean planner-quality upgrade. On tool-required tasks, it is essentially tied with old Qwen 3.6 27B. On all cases, old Qwen still wins by three points because it better matches Sonnet's "do not call a tool yet" decisions.

For WebBrain, I would treat this as a serious practical candidate with one caveat: pair it with stronger boundary handling. If the outer agent can guard ambiguous, destructive, and no-browser-needed turns, the NVFP4 serving profile is very attractive. Without that guard, the old Qwen row remains the cleaner planner by the benchmark's all-case metric.

Tags: #Qwen36 #NVFP4 #NVIDIA #vLLM #ToolCalling #BrowserAgent #WebBrain
