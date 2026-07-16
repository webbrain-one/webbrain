---
title: >
  DiffusionGemma hits 0.35s median in the WebBrain local planner bench
slug: local-planner-q4-june-2026
sortOrder: 0
date: 2026-06-19
readTime: 9 min read
description: >
  DiffusionGemma, Gemma 4 12B Coder, Cohere North-Mini-Code, and VibeThinker-3B in WebBrain's frozen first-tool-call browser-agent harness.
excerpt: >
  Gemma 4 12B Coder, North Mini Code, and DiffusionGemma all completed the frozen legacy tool-call bench through different serving paths. DiffusionGemma was the speed surprise under vLLM and also handled the vision probe. VibeThinker confirmed its own model-card warning: it is not a browser-agent tool-calling model.
titleTag: >
  DiffusionGemma hits 0.35s median in the WebBrain local planner bench - WebBrain Blog
ogTitle: >
  DiffusionGemma hits 0.35s median in the WebBrain local planner bench
ogDescription: >
  Gemma 4 12B Coder, North Mini Code, and DiffusionGemma completed WebBrain's frozen local planner run; VibeThinker is not a tool-calling agent model.
twitterTitle: >
  DiffusionGemma hits 0.35s median in the WebBrain local planner bench
twitterDescription: >
  A practical local-serving pass over four new browser-agent planner candidates for WebBrain.
keywords:
  - WebBrain
  - local LLM
  - browser agent
  - tool calling
  - Gemma 4 12B Coder
  - North-Mini-Code
  - DiffusionGemma
  - VibeThinker-3B
  - llama.cpp
  - vLLM
html: true
lede: >
  We pulled four new local candidates into the WebBrain bench: **Gemma 4 12B Coder Fable5 Composer 2.5**, **Cohere North-Mini-Code 1.0**, **DiffusionGemma-26B-A4B-it**, and **VibeThinker-3B**. The practical result: Gemma and North both completed the frozen legacy first-tool-call run at Q4, DiffusionGemma could not use the normal llama.cpp server path but did complete the harness through vLLM at very high speed, and VibeThinker matched its own caveat: it is not trained for tool-calling or autonomous agents.
---

## What we ran

This was not a leaderboard run. It was a local-serving reality check: can these models sit behind WebBrain as a first-action browser planner?

For the comparable runs, we used the frozen first-tool-call harness:

```bash
node test/llm/run-llamacpp.mjs \
  --freeze test/llm/freeze/baseline-2026-05-23.json \
  --chat-template-compat alternating \
  --concurrency 1
```

That means:

- 100 single-turn browser-agent prompts.
- The May 23 Claude Sonnet 4.6 WebBrain system prompt and 41-tool schema, frozen.
- Legacy text-call compatibility: no native OpenAI `tools` field is sent.
- One active request at a time.
- `Q4_K_M` GGUFs where a GGUF path exists and can run.

The strict numbers below score only the first model action. **Exact** means tool name and args both match the expected first call. **Name** means the ideal tool name matches (including exact matches — so Name ≥ Exact). **Parsed calls** measures format reliability, not correctness.

## Results

| Model | Serving path | Parsed calls | Exact | Name | Median | p95 | Observed VRAM | Status |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| Gemma 4 12B Coder Fable5 Composer 2.5 | `Q4_K_M` GGUF, llama.cpp, 32k ctx | 94/100 | 9% | 26% | 1.9s | 2.8s | ~8.8-9.0 GB | Clean text run |
| Cohere North-Mini-Code 1.0 | `Q4_K_M` GGUF, llama.cpp b9714, 32k ctx | 93/100 | 9% | 24% | 3.2s | 4.0s | ~19.5 GB | Clean run with parser workaround |
| DiffusionGemma-26B-A4B-it | NVFP4, vLLM, 32k ctx | 79/100 | 10% | 26% | 0.35s | 0.65s | ~32.0 GB reserved | Very fast; vision probe works |
| VibeThinker-3B | BF16, vLLM, 64k ctx, 8 server seqs | 84/100 | 2% | 19% | 5.0s | 15.1s | ~26.8 GB reserved | Scored, but not recommended |

Two VRAM caveats:

- The llama.cpp numbers are observed desktop readings on an RTX 5090, not isolated lab measurements. They include 32k context, full GPU offload, flash attention where available, q4 KV, and one slot.
- The vLLM numbers are not minimum model memory needs. The DiffusionGemma endpoint reserved almost the whole RTX 5090, and the VibeThinker server was configured with 64k context and 8 concurrent sequences.

## Gemma 4 12B Coder

Model: [yuxinlu1/gemma-4-12B-coder-fable5-composer2.5-v1-GGUF](https://huggingface.co/yuxinlu1/gemma-4-12B-coder-fable5-composer2.5-v1-GGUF)

Local file:

```text
G:\llama\models\gemma4-12b-coder\gemma4-coding-Q4_K_M.gguf
```

Gemma was the cleanest llama.cpp run in this batch.

| Metric | Value |
| --- | ---: |
| Completed cases | 100/100 |
| Transport errors | 0 |
| Parsed calls | 94/100 |
| Exact first-call match | 9/100 |
| Tool-name match | 26/100 |
| Average latency | 2.34s |
| Median latency | 1.91s |
| p95 latency | 2.81s |
| Slowest case | 40.5s |
| Observed VRAM | ~8.8-9.0 GB |

The good part is format reliability. Under the frozen legacy path, Gemma emitted parseable calls in 94 cases without transport errors. It was also quick: most requests landed around two seconds.

The weakness is first-action selection. It called `get_accessibility_tree` 57 times out of 100. That is often safe behavior in a real browser session, but this benchmark asks for the expected first action. When the user explicitly asks to go somewhere, search something, or open a known page, "inspect the current blank tab" is usually too conservative.

We also ran `test/vision-probe.mjs` against the same server. The probe failed with:

```text
image input is not supported - hint: if this is unexpected, you may need to provide the mmproj
```

So this particular GGUF is a text planner candidate only in the current setup.

## North Mini Code

Model: [CohereLabs/North-Mini-Code-1.0](https://huggingface.co/CohereLabs/North-Mini-Code-1.0), Q4 GGUF from [bartowski/North-Mini-Code-1.0-GGUF](https://huggingface.co/bartowski/North-Mini-Code-1.0-GGUF)

Local file:

```text
G:\llama\models\north-mini-code-1.0\North-Mini-Code-1.0-Q4_K_M.gguf
```

North loaded successfully in the staged current llama.cpp build:

```text
G:\llama\llama-b9714-cuda13\llama-server.exe
```

But the first smoke test hit a serving-layer problem. With the native template, North generated a sensible action:

```json
[
  {
    "tool_call_id": "0",
    "tool_name": "navigate",
    "parameters": {
      "url": "about:addons"
    }
  }
]
```

llama.cpp's OpenAI endpoint rejected it before returning a normal response:

```text
The model produced output that does not match the expected peg-native format
```

For the comparable run, we restarted the server with `--skip-chat-parsing` and added a narrow raw-action extractor for North/Cohere-style JSON in the runner. The prompt remained the same frozen legacy prompt, and no structured OpenAI tools were sent.

| Metric | Value |
| --- | ---: |
| Completed cases | 100/100 |
| Transport errors | 0 |
| Parsed calls | 93/100 |
| Exact first-call match | 9/100 |
| Tool-name match | 24/100 |
| Average latency | 3.30s |
| Median latency | 3.19s |
| p95 latency | 4.02s |
| Slowest case | 5.16s |
| Observed VRAM | ~19.5 GB |

North was slower and much heavier than Gemma, but more stable than the first template failure suggested. Like Gemma, it strongly preferred `get_accessibility_tree`: 59 of its 93 parsed calls used that tool. It had 7 no-tool answers.

The vision probe failed the same way as Gemma:

```text
image input is not supported - hint: if this is unexpected, you may need to provide the mmproj
```

So North is also text-only in this local run.

## DiffusionGemma

Model: [google/diffusiongemma-26B-A4B-it](https://huggingface.co/google/diffusiongemma-26B-A4B-it), vLLM endpoint rooted at `nvidia/diffusiongemma-26B-A4B-it-NVFP4`. We also tested the Q4 GGUF from [unsloth/diffusiongemma-26B-A4B-it-GGUF](https://huggingface.co/unsloth/diffusiongemma-26B-A4B-it-GGUF) for local llama.cpp compatibility.

Local file:

```text
G:\llama\models\diffusiongemma-26b-a4b-it\diffusiongemma-26B-A4B-it-Q4_K_M.gguf
```

DiffusionGemma was the headline surprise.

The expectation going in was simple: if the model can preserve roughly the same action quality as Gemma 4 26B-A4B while running much faster, it changes the local-agent tradeoff. That is mostly what happened. It did not beat the old Gemma 26B run on strict action quality, but it got close enough to be interesting and was dramatically faster once the vLLM server was warm.

| Metric | Value |
| --- | ---: |
| Completed cases | 100/100 |
| Transport errors | 0 |
| Parsed calls | 79/100 |
| Exact first-call match | 10/100 |
| Tool-name match | 26/100 |
| Average latency | 0.38s |
| Median latency | 0.35s |
| p95 latency | 0.65s |
| Slowest case | 0.88s |
| Observed VRAM | ~32.0 GB reserved by vLLM |

The first one-case smoke took 8.8s and picked `about:extensions` instead of Firefox's expected `about:addons`. After that warmup, the full 100-case run finished in 37.8s wall time, with most cases between 200ms and 650ms. That is the flashy part: it behaves like a large local model, but the warmed vLLM path felt closer to a lightweight router.

Quality was more mixed. Compared with the earlier Gemma 4 26B-A4B saved run, DiffusionGemma had:

- better exact score by a small amount than Gemma 4 12B Coder and North Mini Code,
- the same 26% tool-name score as Gemma 4 12B Coder,
- lower parseability than Gemma 26B, with 21 no-tool answers,
- much better latency than every other large-class local run in this table.

The other surprise is vision. Unlike the Gemma 4 12B Coder and North Q4 GGUFs, the vLLM DiffusionGemma endpoint accepted the `vision-probe.mjs` screenshot and produced a useful structured caption of the Google password-error page. It correctly identified the page purpose, the visible text, the focused password input, and the "Enter a password" error state. That makes it more than a text planner curiosity.

There is still a serving split to be aware of. Standard `llama-server` and `llama-cli` did not load the Q4 GGUF in three builds we checked:

- the existing April-era `G:\llama` build,
- `G:\llama-b9286`,
- the staged official Windows CUDA `b9714` build.

All failed with the same architecture error:

```text
unknown model architecture: 'diffusion-gemma'
```

That is expected right now. DiffusionGemma is not a normal autoregressive model, and the GGUF notes point to the DiffusionGemma llama.cpp PR and the dedicated `llama-diffusion-cli` runner. The Hugging Face discussion for the Unsloth GGUF also notes that this path is CLI-only for now, with no `llama-server` support yet.

So we built the PR branch locally:

```text
G:\llama-diffusiongemma\build\bin\llama-diffusion-cli.exe
```

Smoke command:

```bash
llama-diffusion-cli.exe \
  -m G:\llama\models\diffusiongemma-26b-a4b-it\diffusiongemma-26B-A4B-it-Q4_K_M.gguf \
  -p "Explain promises in JavaScript in one sentence." \
  -n 64 \
  -ngl 99 \
  --diffusion-steps 24
```

That worked. It produced a coherent one-sentence answer and peaked around 21.3 GB total 5090 memory in the smoke run. The CLI reported about 1.3s total generation time for the 256-token canvas, using entropy-bound early stopping.

But the WebBrain score above comes from vLLM, not from the GGUF CLI path. For local llama.cpp users, this is still not drop-in. For vLLM users with enough VRAM, it is suddenly one of the most interesting candidates in the batch.

## VibeThinker

Model: [WeiboAI/VibeThinker-3B](https://huggingface.co/WeiboAI/VibeThinker-3B)

We tried VibeThinker two ways.

First, we pulled a `Q4_K_M` GGUF and ran it through llama.cpp. Those numbers are discarded. The Q4 run showed repetitive answers, never-ending responses, high latency, and weak tool-call behavior. For a 3B model, this quantization may simply be too lossy for this use case.

Then we reran the BF16 model through vLLM on port 8000. That gave a cleaner data point:

| Metric | Value |
| --- | ---: |
| Completed cases | 100/100 |
| Transport errors | 0 |
| Parsed calls | 84/100 |
| Exact first-call match | 2/100 |
| Tool-name match | 19/100 |
| Average latency | 6.20s |
| Median latency | 4.97s |
| p95 latency | 15.13s |
| Slowest case | 24.4s |
| Observed VRAM | ~26.8 GB reserved by vLLM |

This cleaner run still supports the upstream warning. The VibeThinker model card says it was not trained on tool-calling or agent-based programming data and does not recommend it for function calling, API orchestration, or autonomous coding agents. It recommends competitive-programming-style tasks instead.

That showed up here. VibeThinker emitted calls most of the time, but the first-action routing was weak, no-tool answers were common, and the model often selected generic reading/inspection behavior where the harness expected a concrete browser action.

So the fair interpretation is narrow: VibeThinker may still be interesting for reasoning or competitive-programming prompts, but these WebBrain planner results should not be used as evidence for or against its intended use case.

## What I would keep testing

The practical local candidates from this batch are DiffusionGemma on vLLM, Gemma 4 12B Coder, and North Mini Code.

Gemma is lighter and faster in the llama.cpp lane. North is heavier, slightly slower, and needed a parser workaround, but once raw actions were allowed through it completed the full run cleanly. Both have the same exact-match score, and both overuse `get_accessibility_tree`.

That suggests the next useful experiment is prompt-side, not model-side:

- make direct-navigation instructions stronger,
- discourage inspection when the current tab is obviously irrelevant,
- keep the frozen legacy parser path for apples-to-apples comparison,
- rerun Gemma and North after the prompt change.

DiffusionGemma is the speed track. It is the most unusual model in the batch, and the vLLM run showed why people are excited about it: large-model behavior with sub-second warmed routing latency. The remaining question is whether prompt changes can reduce its no-tool rate without losing that speed.

VibeThinker should stay out of the browser-agent planner table unless a tool-trained variant appears.

## Comparison with earlier planner runs

For context, here is the same strict first-tool comparison across the saved runs we have tested before. This is not the same scoring lens as the May benchmark post, which compared models against consensus and Sonnet. This table replays each saved result against the current `expected/NNN.json` ideal first call with the same definitions as above: **Exact** = name plus args; **Name** = ideal tool name matches (including exact).

| Model | Parsed calls | Exact | Name | Median latency |
| --- | ---: | ---: | ---: | ---: |
| MiniMax M2.7 | 88/100 | 23% | 36% | 3.0s |
| Claude Sonnet 4.6 | 92/100 | 19% | 41% | 2.8s |
| Qwen 3.6 35B-A3B | 90/100 | 18% | 38% | 10.3s |
| Qwen 3.6 27B | 92/100 | 18% | 37% | 10.2s |
| Nemotron Omni 30B | 93/100 | 16% | 36% | 2.5s |
| Qwen 3.5 9B | 90/100 | 15% | 35% | 0.91s |
| Gemma 4 E4B | 87/100 | 14% | 35% | 4.5s |
| Intel Gemma 4 31B int4 | 88/100 | 14% | 34% | 0.63s |
| Gemma 4 26B-A4B | 87/100 | 13% | 30% | 1.4s |
| Browser-Use Qwen 30B-A3B Q4 | 93/100 | 12% | 35% | 0.47s |
| Qwen 3.5 4B | 82/100 | 12% | 33% | 5.4s |
| Gemma 4 E2B | 76/100 | 12% | 31% | 3.8s |
| DiffusionGemma 26B-A4B vLLM | 79/100 | 10% | 26% | 0.35s |
| Gemma 4 12B Coder Q4 | 94/100 | 9% | 26% | 1.9s |
| North Mini Code Q4 | 93/100 | 9% | 24% | 3.2s |
| Qwen 3.5 0.8B | 90/100 | 7% | 15% | 0.44s |
| LFM 2.5 | 83/100 | 4% | 23% | 5.9s |
| Qwen 3.5 2B | 89/100 | 4% | 7% | 0.78s |
| VibeThinker 3B BF16 | 84/100 | 2% | 19% | 5.0s |

The more useful comparison is by class.

### Mid dense: Gemma 4 12B Coder vs Qwen 3.5 9B

Gemma 4 12B Coder is closest to Qwen 3.5 9B in spirit: mid-sized dense-ish local planners that should fit comfortably below the huge-model tier.

| Model | Parsed calls | Exact | Name | Median latency |
| --- | ---: | ---: | ---: | ---: |
| Qwen 3.5 9B | 90/100 | 15% | 35% | 0.91s |
| Gemma 4 12B Coder Q4 | 94/100 | 9% | 26% | 1.9s |

Gemma wins on parseability, but Qwen 3.5 9B is still the better first-action router in this saved strict replay. Gemma's weakness is not format. It is action choice: too many safe-but-generic `get_accessibility_tree` calls where Qwen more often picks the expected tool directly.

### Mini class: VibeThinker 3B vs Gemma 4 E4B vs Qwen 3.5 4B

The small-model comparison is where VibeThinker has to prove it can transfer reasoning into browser-agent tool use. Against the earlier mini-class runs, it does not.

| Model | Parsed calls | Exact | Name | Median latency |
| --- | ---: | ---: | ---: | ---: |
| Gemma 4 E4B | 87/100 | 14% | 35% | 4.5s |
| Qwen 3.5 4B | 82/100 | 12% | 33% | 5.4s |
| VibeThinker 3B BF16 | 84/100 | 2% | 19% | 5.0s |

This makes the VibeThinker conclusion clearer. Even with BF16/vLLM instead of the bad Q4 GGUF run, it trails both Gemma 4 E4B and Qwen 3.5 4B by a wide margin on exact and name-only matching. That lines up with the model-card warning: VibeThinker may be a competitive-programming/reasoning model, but it is not a browser-agent planner model.

### Large MoE class: North vs Qwen 3.6 35B-A3B vs Gemma 4 26B

North belongs in the large local tier, where the question is whether a heavier model gives better routing than the older large MoE candidates.

| Model | Parsed calls | Exact | Name | Median latency |
| --- | ---: | ---: | ---: | ---: |
| Qwen 3.6 35B-A3B | 90/100 | 18% | 38% | 10.3s |
| Gemma 4 26B-A4B | 87/100 | 13% | 30% | 1.4s |
| DiffusionGemma 26B-A4B vLLM | 79/100 | 10% | 26% | 0.35s |
| North Mini Code Q4 | 93/100 | 9% | 24% | 3.2s |

North is operationally promising because it loaded, fit, and produced parseable actions after the `--skip-chat-parsing` workaround. But it does not beat the older large local models on first-action quality. Qwen 3.6 35B-A3B remains the large-tier action-selection reference. Gemma 4 26B-A4B still has better strict routing quality than DiffusionGemma in this saved replay, but DiffusionGemma is the speed outlier: 0.35s median versus 1.4s for Gemma 26B and 10.3s for Qwen 35B.

The new models did not beat the earlier leaders on strict first-action accuracy. Their stronger signal is operational: DiffusionGemma is genuinely fast through vLLM and vision-capable, Gemma 4 12B Coder is light and parseable, and North Mini Code is heavy but also parseable once its native action format is allowed through. All three need prompt work before they can challenge the older Qwen, MiniMax, Sonnet, or Nemotron runs on action selection.
