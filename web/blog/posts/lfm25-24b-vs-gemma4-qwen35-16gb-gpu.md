---
title: >
  Only 2.45B active: LFM 2.5 24B vs Gemma 4, Qwen 3.5, and Ternary Bonsai 2 for a 16 GB GPU
slug: lfm25-24b-vs-gemma4-qwen35-16gb-gpu
sortOrder: -470
date: 2026-11-15
readTime: 9 min read
description: >
  We test LFM 2.5 24B, Gemma 4 26B, Qwen 3.5 9B, and Ternary Bonsai 2 27B on 100 frozen browser-planner cases, comparing tool choices, thinking, and vision.
excerpt: >
  Liquid's tiny active path gets close to the established planners, but Ternary Bonsai 2 changes our recommendation: 77% Sonnet agreement and 17 exact actions from a roughly 6 GB language model.
cardTitle: >
  16 GB GPU: LFM 2.5, Gemma, Qwen, and Bonsai 2
titleTag: >
  LFM 2.5 vs Gemma, Qwen and Bonsai 2: 16 GB GPU benchmark - WebBrain Blog
ogTitle: >
  LFM 2.5 24B vs Gemma, Qwen, and Ternary Bonsai 2 for a 16 GB GPU
ogDescription: >
  Identical frozen requests, 100 cases per model. Bonsai leads Sonnet agreement and exact actions; Qwen 3.5 leads expected-tool selection by one case. Thinking, vision, and memory considered separately.
twitterTitle: >
  LFM 2.5 vs Gemma, Qwen, and Ternary Bonsai 2 for a 16 GB GPU
twitterDescription: >
  We replay 100 frozen requests per model. Ternary Bonsai 2 reaches 77% Sonnet agreement and 17 exact actions, changing our 16 GB GPU recommendation.
keywords:
  - LFM 2.5 24B-A2B
  - Liquid AI
  - Gemma 4 26B-A4B
  - Qwen 3.5 9B
  - Ternary Bonsai 2 27B
  - Qwen 3.8 27B
  - Prism ML
  - OpenBonsai
  - ternary quantization
  - 16 GB GPU
  - RTX 4060 Ti 16 GB
  - RTX 5060 Ti 16 GB
  - local LLM
  - browser agent benchmark
  - tool calling
  - thinking mode
  - WebBrain
author: Emre Sokullu
authorUrl: https://emresokullu.com
---

Liquid AI keeps giving us interesting reasons to revisit local models. Its small LFM 3 models have shown impressive capabilities for their size: in our [launch-day comparison](/blog/lfm3-vl-2b-vs-webbrain-compass-vld), LFM3-VL-2B won six of nine general vision and text suites against our MiniCPM-based Compass model.

But what about Liquid's largest model, released a little earlier?

**LFM 2.5 24B-A2B stores 24 billion parameters while activating approximately 2.45 billion per token.** That makes it an interesting challenger for consumer hardware. We tested it against two established WebBrain candidates—**Gemma 4 26B-A4B and Qwen 3.5 9B**—using our original frozen browser-planner benchmark.

For someone with a 16 GB GPU, does the newest model deserve to replace those older favourites? Let's see how they fare.

We also added a fourth candidate: **Prism ML's Ternary Bonsai 2 27B**, a heavily quantized version of **Qwen3.8-27B**, one of the strongest open-weight models we have evaluated for browser work. Qwen3.8 already established a strong [local browser-vision reference](/blog/tiny-vision-models-qwen38-reference); Bonsai asks how much of that model's usefulness survives far more aggressive weight compression.

Ternary compression is also the subject of our [OpenBonsai work](/blog/openbonsai-open-source-ternary-quantization), which develops an open pipeline for compressing models and specialised fine-tunes. The checkpoint tested here is Prism ML's released Bonsai 2 model.

## Which 16 GB GPU?

This includes the **RTX 4060 Ti 16 GB** and **RTX 5060 Ti 16 GB**, alongside the **RTX 4070 Ti SUPER, RTX 4080, RTX 4080 SUPER, RTX 5070 Ti, and RTX 5080**.

Check the exact configuration: the regular RTX 4060 and RTX 5060 have 8 GB, and both Ti models also have 8 GB versions. [NVIDIA specifications](https://www.nvidia.com/en-us/geforce/graphics-cards/compare/)

Our comparison concerns model selection for that memory budget. We did not measure these models across all those cards.

## Four models, two routes to a smaller deployment

| Model | Architecture | Active parameters per token | Screenshot input |
| --- | --- | ---: | --- |
| Qwen 3.5 9B | **Dense** | Approximately 9B | Yes |
| Gemma 4 26B-A4B | MoE | Approximately 3.8B | Yes |
| LFM 2.5 24B-A2B | MoE | Approximately 2.45B | **No—text only** |
| Ternary Bonsai 2 27B | **Dense, ternary weights** | Approximately 27B | Yes, with the vision projector |

Qwen 3.5 9B and Bonsai 2 27B are **dense models**. Gemma and Liquid activate a subset of their stored parameters for each token. Their smaller active counts reduce computation, while the full weight footprint still matters for deployment. See the official [Qwen](https://huggingface.co/Qwen/Qwen3.5-9B), [Gemma](https://huggingface.co/google/gemma-4-26B-A4B-it), [Liquid](https://huggingface.co/LiquidAI/LFM2.5-24B-A2B), and [Bonsai](https://huggingface.co/prism-ml/Ternary-Bonsai-2-27B-gguf) model cards.

The two smaller active paths and Bonsai's aggressive compression address different costs. Bonsai still computes through a dense 27B-class language model; ternary weights reduce its stored footprint. Its **PTQ1_0 language-model file is approximately 5.95 GB**, with an optional **0.63 GB Q8 vision projector**. Those are component sizes, rather than total VRAM measurements. [Bonsai model and packing details](https://huggingface.co/prism-ml/Ternary-Bonsai-2-27B-gguf)

Qwen 3.5 and Gemma are the older reference points here. Liquid and Bonsai are the newer challengers, but release date alone tells us little about browser-tool reliability.

## The same frozen test

We reused Qwen and Gemma's archived May 23 results and ran Liquid and Bonsai through **the exact same 100 saved requests**:

- The same system prompt and **41 tool definitions**.
- The same per-case user messages and page context.
- Temperature **0.15** and a **4,096-token** output budget.
- Only the requested model changed.

We verified all 200 historical Qwen/Gemma request bodies against the archived reference before running the new candidates. Replaying those saved requests also avoids changes introduced by today's message builder.

Liquid ran locally through llama.cpp using **UD-Q4_K_XL**, with thinking enabled. All 100 requests succeeded. Every response contained reasoning evidence, and none reached the output limit.

Bonsai ran locally using **PTQ1_0**, with **32,768 context per slot** and its normal thinking mode enabled. We retained the first 22 successful cases when moving to **four concurrent requests** for the remaining 78. Two failed transport attempts—one interrupted by a server restart, one reaching the HTTP waiting limit—were archived and repeated with identical requests. The final scored set contains **100 successful responses**, all with reasoning evidence and none clipped by the output budget. The retries changed no prompt, tool definition, temperature, or token limit.

The historical models retain their original serving conditions. Backends, quantizations, templates, and hardware differ, and their thinking settings were not fully recorded. We therefore leave response times out of this comparison.

## The results

All counts below are out of 100.

| Model | Tool calls emitted | Agreement with Sonnet | Expected tool selected | Exact tool + arguments |
| --- | ---: | ---: | ---: | ---: |
| **Qwen 3.5 9B** | 90 | 70 | **35** | 15 |
| **Gemma 4 26B-A4B** | 87 | 71 | 30 | 13 |
| **LFM 2.5 24B-A2B** | 95 | 69 | 28 | 6 |
| **Ternary Bonsai 2 27B** | **96** | **77** | 34 | **17** |

Bonsai emits the most first calls: **96 native calls, all 96 schema-valid**. Liquid emits **95 native first calls**, of which **94 satisfy the advertised schemas**. Neither new model required content-parsing fallback.

Liquid's overall Sonnet agreement stays close to the established models: **69 versus 70 for Qwen and 71 for Gemma**. Bonsai reaches **77**, the highest in this four-model run. These are single runs, so small gaps should not be treated as a dependable general ranking.

There is an especially useful detail behind those scores. On the **92 cases where Sonnet actually called a tool**, Bonsai matches its tool choice **73 times**, compared with **65** for both Liquid and Gemma and **64** for Qwen. Bonsai's lead therefore also appears when shared no-tool answers are excluded. Gemma's two-point overall advantage over Liquid comes from additional shared no-tool responses.

**Liquid is competitive with the older references on broad tool choice.** Against the separately authored ideal actions, **Qwen leads expected-tool selection, 35 to Bonsai's 34**, while **Bonsai leads exact tool-and-argument matches, 17 to Qwen's 15**. No model wins every column.

These are opening-action measurements. No browser tools were executed, so the table does not measure completed tasks.

## Why six exact matches needs context

Liquid's **6/100 exact-action score** is its weakest result, but exact matching is deliberately literal.

For example, on the YouTube navigation case, Liquid returned:

```text
https://www.youtube.com
```

The reference expected:

```text
https://www.youtube.com/
```

That counts as a strict mismatch even though both addresses would ordinarily reach the same page.

Other differences are substantive. On the Firefox extensions-management case, Liquid generated **`https://about:addons`** instead of **`about:addons`**. Its one schema violation was `press_keys({key: "m"})`, outside the advertised key enum.

The exact score therefore combines harmless spelling differences with real argument defects. We retain both in the results rather than treating every mismatch as equally consequential.

Liquid also chose `get_accessibility_tree` **51 times**, exactly matching Gemma's count; Bonsai chose it **47 times** and Qwen **39 times**. That inspection-first preference helps explain why emitting more tool calls does not automatically produce more ideal-action matches.

## Bonsai changes the recommendation

The ternary checkpoint leads two useful measures at once: **77/100 Sonnet agreement and 17/100 exact actions**. Its **34 expected-tool matches** are also just one below Qwen 3.5 9B. Those results make it the strongest overall planner candidate in this four-model run, while the narrow exact-action gap still deserves care.

Some of its wins are concrete. On the Firefox extensions-management case, Bonsai selects the expected **`about:addons`**. On the coffee-shop search case, it constructs the expected Google search URL with the query already included; Qwen and Gemma first navigate to Google's homepage.

That is an encouraging result for a heavily quantized dense 27B model. Measuring the compression loss itself would require a separate, same-protocol uncompressed Qwen3.8-27B baseline. We exercised text planning here; retained screenshot quality would also need its own evaluation.

Runtime compatibility matters. Our **PTQ1_0** run uses the matching ternary-capable llama.cpp build. Follow Prism ML's [packing and runtime instructions](https://huggingface.co/prism-ml/Ternary-Bonsai-2-27B-gguf) when choosing a file and server.

## Thinking is compulsory—and WebBrain recommends it anyway

LFM 2.5 24B-A2B is a **reasoning-only model**. Its template starts generation with `<think>`; thinking is part of its normal operation. [Liquid model card](https://huggingface.co/LiquidAI/LFM2.5-24B-A2B)

A small active parameter count does not remove the work of generating reasoning tokens. MoE reduces computation per token, while thinking adds tokens before the final action.

WebBrain recommends thinking mode for browser automation anyway, so Liquid's behaviour fits our recommended usage. The distinction is that thinking is compulsory for this checkpoint.

In this run, the 4,096-token budget accommodated its reasoning and answers without clipping.

Bonsai also thinks by default, and all 100 of its scored responses contain reasoning evidence. Its answers fit the same output-token budget after the two transport failures were retried.

## The biggest disadvantage: Liquid cannot see

**LFM 2.5 24B-A2B is text only.**

It can use page text, accessibility trees, and browser-tool results. That covers a substantial amount of browser automation. But it cannot directly inspect a screenshot when the useful evidence is an unlabeled icon, a canvas, a chart, or a visual state missing from the accessibility tree.

Qwen and Gemma retain that capability. Bonsai also supports image input through its optional vision projector, although this frozen planner run contains no screenshots.

You can pair Liquid with a separate vision model, but that adds another component and another memory requirement. For someone who wants one local model to cover planning and screenshots, this is a substantial disadvantage.

## What we would run on a 16 GB card

**Ternary Bonsai 2 27B is now our first planner candidate when a compatible ternary runtime is available.** It leads Sonnet agreement and exact actions in this comparison, with a language-model file of approximately 5.95 GB. Its optional vision component also keeps a one-model setup possible, subject to evaluating that path on the chosen backend.

**Qwen 3.5 9B remains a useful conventional baseline.** It leads expected-tool selection by one case, supports screenshots, and comes close to Bonsai on exact actions. It is still a reasonable starting point if the specialised ternary serving path adds unwanted setup work.

**Gemma 4 26B-A4B remains a close alternative**, especially if it already works well with your chosen quantization and context. Check the complete memory requirement: some 4-bit packages plus the vision projector exceed the available budget before context allocations. [Gemma quantization files](https://huggingface.co/unsloth/gemma-4-26B-A4B-it-GGUF/tree/main)

**LFM 2.5 24B-A2B earns consideration for text-based browser workflows.** It matches Gemma's tool-name agreement on Sonnet's tooled cases and produces native calls consistently. Its extremely small active path is interesting, but weaker exact-action results and missing vision keep it from becoming our default replacement.

Liquid's largest LFM 2.5 gets close to the established players on broad tool selection. The addition that changes our shortlist most is Bonsai: a heavily quantized version of a strong open-weight model, with the best overall planner result here and a weight footprint suited to further testing on a 16 GB GPU.

Download the [four-model comparison data](/blog/lfm25-24b-vs-gemma4-qwen35-16gb-gpu/comparison.json). The [benchmark evidence directory](https://github.com/esokullu/webbrain/tree/main/test/llm/analysis/2026-11-15-16gb-frozen-comparison-bonsai2) contains the report, request hashes, archived rubric references, and reproduction commands.
