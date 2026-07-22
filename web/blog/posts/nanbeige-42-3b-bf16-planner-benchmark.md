---
title: >
  Nanbeige 4.2 3B punches above its size, but Qwen 3.5 9B still wins our frozen planner test
slug: nanbeige-42-3b-bf16-planner-benchmark
sortOrder: -110
date: 2026-07-22
readTime: 8 min read
description: >
  We tested Nanbeige4.2-3B in BF16 on an RTX 5090. Its official agent benchmarks beat Qwen 3.5 9B and Gemma 4 12B, but WebBrain's frozen browser-planner replay did not reproduce that lead.
excerpt: >
  Nanbeige 4.2 3B produced 90 parsed calls, reached 67% Sonnet alignment, and delivered a 1.49s single-request median. That is impressive for 4B total parameters, but below Qwen 3.5 9B and Gemma 4 E4B in our first-action test.
titleTag: >
  Nanbeige 4.2 3B BF16 WebBrain planner benchmark - WebBrain Blog
ogTitle: >
  Nanbeige 4.2 3B is strong for its size, but does not beat Qwen 3.5 9B here
ogDescription: >
  The new 4B-total / 3B-non-embedding model claims wins over Qwen 3.5 9B and Gemma 4 12B. Our frozen browser-agent test finds a smaller, still useful result.
twitterTitle: >
  Nanbeige 4.2 3B BF16 browser-planner benchmark
twitterDescription: >
  90 parsed calls, 67% Sonnet alignment, 11 exact actions, and a 1.49s c=1 median. Excellent size efficiency; no Qwen 3.5 9B upset in WebBrain.
keywords:
  - WebBrain
  - Nanbeige
  - Nanbeige 4.2 3B
  - Qwen 3.5 9B
  - Gemma 4 12B
  - Gemma 4 E4B
  - vLLM
  - BF16
  - local LLM
  - browser agent
  - tool calling
lede: >
  **Nanbeige4.2-3B** makes one of the boldest small-model claims we have seen recently. Its official card reports wins over Qwen 3.5 9B, Gemma 4 12B, and Gemma 4 E4B across a long list of agent and reasoning benchmarks. The naming is slightly confusing but defensible: it has about 4B total parameters and 3B non-embedding parameters. We loaded the full BF16 checkpoint on an RTX 5090 and ran WebBrain's frozen 100-case first-tool benchmark. It is genuinely capable for its size, highly parseable, and reasonably fast in single-request use. It did not reproduce the claimed ordering here: the clean c=1 run reached 67% Claude Sonnet 4.6 tool-name alignment, below Qwen 3.5 9B at 70% and Gemma 4 E4B at 68%, while strict exact and ideal-tool scores also trailed all three comparison models.
---

## Why the official numbers are exciting

[Nanbeige's official model card](https://huggingface.co/Nanbeige/Nanbeige4.2-3B) describes 4.2-3B as a compact agentic model built around a **Looped Transformer**. The architecture feeds hidden states through reused transformer layers, aiming to increase effective capacity without adding another conventional stack of parameters.

That is why both "3B" and "4B" appear around the same checkpoint:

| Size definition | Nanbeige 4.2 |
| --- | ---: |
| Total parameters | 4B |
| Non-embedding parameters | 3B |

The headline comparison is not subtle. In the team's table, Nanbeige 4.2 3B beats all three larger comparison models on most agent rows:

| Official benchmark | Nanbeige 4.2 3B | Qwen 3.5 9B | Gemma 4 12B | Gemma 4 E4B |
| --- | ---: | ---: | ---: | ---: |
| GDPval rubrics | 74.3 | 61.9 | 68.5 | 31.5 |
| Pinch-Bench V2 | 74.7 | 68.2 | 53.8 | 33.3 |
| Claw-Gym | 65.0 | 56.1 | 40.8 | 16.4 |
| MCP-Atlas | 57.8 | 47.4 | 30.5 | 15.0 |
| SWE-Bench Verified | 63.6 | 53.1 | 44.2 | 14.0 |
| Terminal-Bench 2.0 | 44.1 | 29.2 | 21.1 | 12.4 |

Those are exactly the results that motivated this test. A 4B-total local model beating 10B-total Qwen and 12B Gemma would be a significant efficiency result, especially for personal agents.

The methodology notes matter, however. Nanbeige says all of its evaluations use thinking mode with `preserve_thinking=true`. Several agent rows use the team's own scaffold; the quickstart recommends `temperature=1.0`, as many as 65,536 new tokens for tool tasks, preserved thinking in multi-turn agents, and `tool_call_format="xml"` for best tool-calling performance.

WebBrain's frozen replay asks a different and deliberately narrower question: given one browser instruction, the same system prompt, and the same 41 tools, what is the model's **first action**?

## What we ran

The local vLLM endpoint reported:

```text
model id: nanbeige4.2-3b
root: Nanbeige/Nanbeige4.2-3B
dtype: bfloat16
max model length: 32768
max sequences: 16
max batched tokens: 8192
tool parser: nanbeige
reasoning parser: nanbeige
GPU: NVIDIA GeForce RTX 5090, 32 GB
```

The server reserved roughly 30 GB of the 5090 because `gpu-memory-utilization` was set to 0.93. That is **not** the weight size. vLLM pre-allocates most available VRAM for weights, KV cache, and execution buffers even while GPU utilization is 0%.

We kept the historical frozen harness unchanged:

```bash
node test/llm/run-llamacpp.mjs \
  --base http://127.0.0.1:8000 \
  --model nanbeige4.2-3b \
  --tag 2026-07-22-nanbeige42-3b-bf16-c1 \
  --concurrency 1 \
  --timeout 180000 \
  --no-save-request \
  --freeze test/llm/freeze/baseline-2026-05-23.json
```

That pins the May 23 Claude Sonnet 4.6 WebBrain prompt, its 41-tool schema, and system hash `5c4fac1387025050`. It sends native OpenAI-style structured tools, uses Act mode's fixed temperature of 0.15, and allows 4,096 output tokens. We did not force Nanbeige's XML compatibility format or add `preserve_thinking=true` to the template.

This is the right configuration for our historical first-action comparison. It is not a reproduction of Nanbeige's own benchmark recipe.

## The clean single-request result

| Metric | Nanbeige 4.2 3B BF16, c=1 |
| --- | ---: |
| Completed cases | 100/100 |
| Transport errors | 0 |
| Parsed calls | 90/100 |
| Valid tool names | 89/100 |
| Exact first-call match | 11/100 |
| Ideal tool-name match | 30/100 |
| Sonnet match, all cases | 67/100 |
| Sonnet match when Sonnet tooled | 62/92 (67.4%) |
| Mean latency | 2.07s |
| Median latency | 1.49s |
| p95 latency | 5.38s |
| Slowest case | 11.11s |
| Benchmark wall time | 206.7s |

The operational result is respectable. Ninety calls parsed natively, and only one used a nonexistent tool name: `scratchpad_read`. The model also handled the no-tool knowledge cases fairly well, matching Sonnet on four of five.

The quality miss is action selection. Nanbeige chose `get_accessibility_tree` **49 times**. Qwen 3.5 9B did so 39 times, Gemma 4 12B QAT 43 times, and Gemma 4 E4B 42 times. Reading the page is often a safe first move, but WebBrain's direct commands frequently have a more specific action available.

Some category results were strong:

- direct navigation: 10/10 Sonnet matches;
- forms: 8/8;
- email: 5/6;
- shopping: 4/4;
- scroll and inspection: 4/4.

The weaker groups explain the overall gap:

- browser internals: 1/5 Sonnet matches;
- GitHub: 3/6;
- downloads: 2/6;
- destructive or refusal-sensitive prompts: 2/6;
- UI mutations: 1/4.

On ambiguous prompts, it usually wrote a clarification in prose rather than calling the available `clarify` tool. That can be semantically sensible, but it is not dispatchable as a structured browser action.

## The comparison: useful, but emphatically not apples to apples

| Model | Precision / serving path | Concurrency | Parsed | Exact | Ideal name | Sonnet all | Sonnet tooled | Median | p95 |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Qwen 3.5 9B | int4 AutoRound, vLLM | historical c=2 | 90 | 15% | 35% | 70% | 69.6% | 0.91s | 1.65s |
| Gemma 4 E4B | historical LM Studio endpoint | historical c=1 | 87 | 14% | 35% | 68% | 68.5% | 4.51s | 13.80s |
| **Nanbeige 4.2 3B** | **BF16, vLLM native tools** | **1** | **90** | **11%** | **30%** | **67%** | **67.4%** | **1.49s** | **5.38s** |
| Gemma 4 12B QAT | W4A16 QAT, vLLM text calls | 8 | 92 | 14% | 33% | 67% | 67.4% | 0.43s | 0.73s |

The quality columns use the same saved cases and scoring rules, so they are useful. The table is still **not a controlled precision or serving comparison**:

- Nanbeige is the full BF16 checkpoint; Qwen is int4 AutoRound and Gemma 12B is a W4A16 QAT checkpoint.
- The historical E4B result records an LM Studio endpoint but not enough checkpoint metadata to claim a controlled quantization comparison.
- Nanbeige and Qwen used native structured tools; the 12B QAT run used legacy text-call compatibility.
- Concurrency ranges from one to eight, and the serving stacks tokenize the same frozen prompt differently.
- Nanbeige's official recipe uses different temperature, thinking retention, output budget, tool-call format, and agent scaffolds.

For those reasons, the latency values should not be used as a pure architecture ranking. The first-action quality result is the more interesting signal: on this frozen browser-planner distribution, Nanbeige is close, but it does not beat Qwen 3.5 9B or Gemma 4 E4B. It ties Gemma 4 12B QAT on Sonnet alignment while trailing it by three exact matches and three ideal tool names.

## Parallel throughput is real, but 16 was not clean

The server advertised 16 concurrent sequences, so we also ran the full replay at concurrency 8 and stress-tested concurrency 16.

| Run | Completed without transport error | Wall time | Throughput | Median request latency | p95 request latency | Sonnet match |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| c=1 | 100/100 | 206.7s | 0.48 req/s | 1.49s | 5.38s | 67% |
| c=8 | 100/100 | 55.5s | 1.80 req/s | 2.90s | 11.32s | 63% |
| c=16 stress | 94/100 | 51.6s | not scored | not scored | not scored | not scored |

Eight-way batching increased completed throughput by about **3.7x**, although each individual request waited longer. The 16-way run improved wall time only slightly and produced six immediate `fetch failed` transport errors in the first batch. We excluded it from quality scoring rather than pretending those were model mistakes.

Quality also moved by four Sonnet points between the clean c=1 and c=8 runs. The frozen harness uses temperature 0.15 rather than zero, so some sampling variance is expected; batching may also change numerical execution. The c=1 result is our headline quality row, and the c=8 result is the capacity measurement.

## The practical downside: no vision

This checkpoint is a text model. Unlike the Qwen 3.5 9B and Gemma 4 checkpoints in this comparison, it cannot inspect a screenshot, read a canvas application, recover from a broken accessibility tree visually, or perform UI OCR by itself.

That matters for WebBrain. A compact text planner can still operate over accessibility trees and extracted page content, but it is not a complete replacement for a multimodal local model. Nanbeige's agent efficiency is impressive; its modality coverage is narrower.

## Verdict

Nanbeige 4.2 3B is not hype-free, but it is also not a disappointment. A 4B-total / 3B-non-embedding model producing 90 structured calls, matching Sonnet's first tool 67% of the time, and serving at a 1.49-second median is a strong small-model result.

The stronger claim did not transfer. In WebBrain's frozen browser-planner test, it did **not** beat Qwen 3.5 9B, and it did not beat Gemma 4 E4B. It tied the quantized Gemma 4 12B QAT run on Sonnet alignment while losing on strict ideal-action scores.

The fairest conclusion is scope, not contradiction. Nanbeige's published wins come from long-horizon agent, office, code, and reasoning evaluations under its recommended thinking-oriented scaffolds. Our test isolates one first browser action under a fixed historical prompt. The official results may be correct in their environments; they are not a guarantee that this smaller model will route WebBrain's first tool better.

For a text-only local assistant with long tasks and a Nanbeige-aware scaffold, this release deserves more testing. For WebBrain's current low-latency browser planner, **Qwen 3.5 9B remains the stronger small local default**, while Gemma's multimodality remains a practical advantage.

Saved results:

```text
test/llm/results/2026-07-22-nanbeige42-3b-bf16-c1_chrome_nanbeige4.2-3b_frozen
test/llm/results/2026-07-22-nanbeige42-3b-bf16-c8_chrome_nanbeige4.2-3b_frozen
test/llm/results/2026-07-22-nanbeige42-3b-bf16-c16_chrome_nanbeige4.2-3b_frozen
```
