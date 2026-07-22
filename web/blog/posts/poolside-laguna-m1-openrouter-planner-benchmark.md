---
title: >
  Poolside Laguna M.1 reaches 73% in WebBrain, but 225B does not win
slug: poolside-laguna-m1-openrouter-planner-benchmark
sortOrder: -100
date: 2026-07-21
readTime: 9 min read
description: >
  Poolside Laguna M.1 is almost twice the size of Laguna S 2.1 and fixes much of its no-tool problem. It reached 73% Sonnet alignment in WebBrain, tying Hy3's headline score but still trailing MiniMax M3 and the strongest 27–31B local planners.
excerpt: >
  Laguna M.1 returned 92 valid tool calls and reached 73% Sonnet alignment with a high-reasoning request. The larger model is much more dispatchable than Laguna S, but exact and ideal tool selection barely improve.
titleTag: >
  Poolside Laguna M.1 OpenRouter WebBrain planner benchmark - WebBrain Blog
ogTitle: >
  Laguna M.1 reaches 73% in WebBrain, but 225B does not win
ogDescription: >
  Poolside's 225B-A23B model fixes Laguna S's no-tool problem and ties Hy3 at 73%, but still trails MiniMax M3, Gemma 4 31B QAT, and ThinkingCap 27B.
twitterTitle: >
  Poolside Laguna M.1 WebBrain planner benchmark
twitterDescription: >
  Laguna M.1: 92 valid calls, 73% Sonnet alignment, and 1.94s median latency. Better than Laguna S, but not the 225B-size win the coding benchmarks suggest.
keywords:
  - WebBrain
  - Poolside
  - Laguna M.1
  - OpenRouter
  - Laguna S 2.1
  - Tencent Hy3
  - MiniMax M3
  - Gemma 4
  - ThinkingCap
  - open-weight model
  - browser agent
  - planner benchmark
  - tool calling
lede: >
  **Poolside Laguna M.1** is the obvious size test for our Laguna S result. At 225B total parameters and 23B active per token, it is roughly 1.9 times larger in total and 2.7 times larger in active parameters than Laguna S 2.1. Poolside's published coding-agent scores are strong, and M.1 is now an Apache 2.0 open-weight release. We ran the same frozen 100-case WebBrain planner benchmark twice. The larger model does fix S's biggest operational weakness: both M.1 runs produced 92 valid tool calls and only eight no-tool outputs. Quality improved more modestly. The default run reached 71% Sonnet alignment and an explicit high-reasoning request reached 73%—enough to tie Tencent Hy3's headline score, but not enough to beat Hy3 on tool-required cases, MiniMax M3 overall, or our strongest 27–31B local rows.
---

## Why M.1 is an interesting size test

[Poolside's Laguna M.1 model card](https://huggingface.co/poolside/Laguna-M.1) describes its flagship coding model as a 225B-A23B sparse Mixture-of-Experts model for agentic coding and long-horizon work. That makes it almost twice Laguna S 2.1's 118B total size and nearly three times its roughly 8.5B active footprint.

The current official table reports:

| Published benchmark | Laguna M.1 | Devstral 2 | GLM-4.7 | DeepSeek V4 Flash | Qwen3.5 397B-A17B | Claude Sonnet 4.6 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| SWE-bench Verified | 74.6 | 72.2 | 73.8 | 79.0 | 76.2 | 79.6 |
| SWE-bench Multilingual | 63.1 | 61.3 | 66.7 | 73.3 | 69.3 | — |
| SWE-Bench Pro, public dataset | 49.2 | — | — | 52.6 | 50.9 | — |
| Terminal-Bench 2.0 | 45.8 | 32.6 | 41.0 | 56.9 | 52.5 | 59.1 |

Those are respectable rather than frontier-leading results. M.1 beats Devstral 2 across the reported rows and GLM-4.7 on three of four, while trailing DeepSeek V4 Flash, Qwen3.5 397B, and Sonnet where comparisons are available.

The methodology matters. Poolside says its M.1 evaluations used the pool agent harness, thinking enabled, a 256K context, temperature 1.0, top-k 20, sandboxed execution, and up to 500 agent steps. The current card reports mean pass@1 over four runs and notes that benchmark images and verifiers were patched for infrastructure reliability. It also uses the highest publicly referenced score for comparison models. That is a serious long-horizon coding evaluation, but it is not a uniform single-shot routing test.

WebBrain asks a narrower question: with the same frozen browser-agent prompt and 41 available tools, does the model emit one valid first action, and is that action close to the Claude Sonnet 4.6 reference?

One more generational caveat: Poolside launched M.1 as its largest model, but described it as a generation behind the much smaller XS.2 architecture. Bigger here does not automatically mean newer.

## What Laguna M.1 is

The model has 70 transformer layers: three dense SwiGLU layers followed by 67 sparse MoE layers, 256 experts plus one shared expert, and top-16 routing. It uses global attention throughout, RoPE with YaRN, and interleaved reasoning between tool calls. The downloadable weights use an Apache 2.0 license.

| Property | Laguna M.1 |
| --- | --- |
| Parameters | 225B total / 23B active |
| Architecture | Sparse MoE, 70 layers, global attention |
| Context on OpenRouter | 262,144 tokens |
| Maximum output on OpenRouter | 32,768 tokens |
| Modalities | Text input, text output |
| Reasoning | Enabled by default; preserved interleaved thinking supported |
| License | Apache 2.0 |

The browser-agent downside is the same as Laguna S: **no vision**. M.1 can plan over page text and accessibility data, but cannot inspect a screenshot, canvas app, visual state, or broken accessibility tree by itself.

## The free route did not pass this account's privacy policy

We first tried the exact requested slug:

```text
poolside/laguna-m.1:free
```

OpenRouter rejected the request before inference with `No endpoints available matching your guardrail restrictions and data policy`. [The free provider page](https://openrouter.ai/poolside/laguna-m.1%3Afree/providers) says free usage may be used to train and improve Poolside's models, while this OpenRouter account blocks training-enabled providers.

We did not weaken the account's privacy setting. OpenRouter lists the free and paid routes under the same canonical M.1 checkpoint, so we ran the benchmark on `poolside/laguna-m.1` instead.

At the time of the test, the paid route cost:

| Token type | Price |
| --- | ---: |
| Input | $0.20 / 1M tokens |
| Output | $0.40 / 1M tokens |
| Cached input | $0.10 / 1M tokens |

The free route is a limited-time offer. The paid route is still inexpensive, though its cached-input price is ten times Laguna S's paid cache rate.

## What we ran

Both runs used the frozen May 23, 2026 baseline: Claude Sonnet 4.6's system prompt, the same 41-tool schema, and system hash `5c4fac1387025050`.

Default reasoning:

```bash
node test/llm/run-llamacpp.mjs \
  --base https://openrouter.ai/api/v1 \
  --model poolside/laguna-m.1 \
  --tag 2026-07-21-openrouter-laguna-m-paid \
  --concurrency 2 \
  --timeout 180000 \
  --no-save-request \
  --freeze test/llm/freeze/baseline-2026-05-23.json
```

Requested high reasoning:

```bash
node test/llm/run-llamacpp.mjs \
  --base https://openrouter.ai/api/v1 \
  --model poolside/laguna-m.1 \
  --tag 2026-07-21-openrouter-laguna-m-paid-high \
  --reasoning-effort high \
  --concurrency 2 \
  --timeout 180000 \
  --no-save-request \
  --freeze test/llm/freeze/baseline-2026-05-23.json
```

These were native OpenAI structured-tools runs. No chat-template fallback was used and request payloads were not saved.

Result files:

```text
test/llm/results/2026-07-21-openrouter-laguna-m-paid_chrome_poolside_laguna-m.1_frozen
test/llm/results/2026-07-21-openrouter-laguna-m-paid-high_chrome_poolside_laguna-m.1_frozen
```

## Headline result

| Metric | Default reasoning | Requested high reasoning |
| --- | ---: | ---: |
| Completed cases | 100/100 | 100/100 |
| Transport errors | 0 | 0 |
| Parsed native tool calls | 92/100 | 92/100 |
| Valid frozen-schema tool names | 92/92 | 92/92 |
| Malformed tool names | 0 | 0 |
| No-tool outputs | 8/100 | 8/100 |
| Strict exact first-call match | **16/100** | 15/100 |
| Ideal tool-name match | **32/100** | 31/100 |
| Sonnet match, all cases | 71.0% | **73.0%** |
| Sonnet match, when Sonnet tooled | 70.7% | **72.8%** |
| Sonnet no-tool decisions matched | 6/8 | 6/8 |
| Average latency | 2.63s | **2.24s** |
| Median latency | 2.13s | **1.94s** |
| p95 latency | 5.43s | **4.29s** |
| Slowest case | 8.12s | **7.22s** |
| OpenRouter reported cost | $0.1788 | $0.1764 |

The operational result is strong. Both runs completed without errors, every parsed tool name was valid, and the model emitted an action on 92 cases—the same overall count as Sonnet. The case sets were not identical: only two M.1 no-tool outputs diverged from a Sonnet tool decision.

The quality result is more mixed. Requested high reasoning adds two Sonnet matches, but strict exact matches fall from 16 to 15 and ideal-name matches fall from 32 to 31. The larger model is good at deciding whether to act; it is not correspondingly better at selecting the benchmark's preferred action.

## Did high reasoning really help?

OpenRouter accepted `reasoning: { effort: "high" }`, and the second run improved from 71% to 73%. As with Laguna S, the endpoint metadata says reasoning is enabled by default but does not expose supported effort levels or a native default effort.

The token counters make the caveat even stronger here:

| Reasoning measurement | Default | High request | Change |
| --- | ---: | ---: | ---: |
| Reasoning tokens | 5,917 | 5,989 | +72 / +1.2% |
| Completion tokens | 10,722 | 10,653 | -69 |

That is not evidence of a materially larger reasoning budget. “Requested high reasoning” is the accurate label, and the two-point difference is well within the range where a second stochastic sample can matter. The fact that exact and ideal-name counts moved backward reinforces that caution.

## M.1 versus Laguna S 2.1

| Model | Parsed calls | Exact | Ideal name | Sonnet all | Sonnet tooled | No-tool | Median | Cost |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| **Laguna M.1 paid, high request** | **92/100** | 15/100 | 31/100 | **73.0%** | **72.8%** | **8/100** | 1.94s | $0.176 |
| Laguna M.1 paid, default | **92/100** | **16/100** | 32/100 | 71.0% | 70.7% | **8/100** | 2.13s | $0.179 |
| [Laguna S 2.1 paid, high request](/blog/poolside-laguna-s-openrouter-planner-benchmark/) | 78/100 | 15/100 | **35/100** | 71.0% | 69.6% | 22/100 | 1.52s | $0.023 |
| Laguna S 2.1 paid, default | 86/100 | 15/100 | 33/100 | 65.0% | 65.2% | 14/100 | **1.04s** | $0.029 |

M.1's real win is dispatchability. Against S default it gains six all-case Sonnet points, six parsed calls, and one exact match while reducing no-tool outputs from 14 to eight. Against S high it gains two all-case points and 14 parsed calls while cutting no-tool outputs by almost two thirds.

But size does not buy much strict selection quality. M.1's best exact result is only one call above S, and both M.1 rows have fewer ideal tool-name matches. The model calls `get_accessibility_tree` on 51–52 of 100 cases, compared with 35–41 for S. It frequently replaces S's prose-only hesitation with a valid but generic inspection call. That is much better for keeping an agent moving, but it does not prove a smarter first action.

## Where M.1 sits against the wider shortlist

| Model | Parsed calls | Exact | Ideal name | Sonnet all | Sonnet tooled | Median | Cost |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| [Gemma 4 31B QAT w4a16](/blog/gemma-4-31b-qat-planner-benchmark/) | 95/100 | 19/100 | 37/100 | **77.0%** | **78.3%** | **0.55s** | Local |
| [ThinkingCap Qwen 3.6 27B INT4](/blog/thinkingcap-qwen36-27b-planner-benchmark/) | 91/100 | 19/100 | 35/100 | **77.0%** | 76.1% | 2.25s | Local |
| [MiniMax M3](/blog/minimax-m3-webbrain-cloud-tool-calling/) | 85/100 | 17/100 | 32/100 | 75.0% | 73.9% | 3.07s | $1.06 |
| [Tencent Hy3 free](/blog/tencent-hy3-openrouter-planner-benchmark/) | 95/100 | **20/100** | **38/100** | 73.0% | 75.0% | 3.68s | $0.00 |
| **Laguna M.1 paid, high request** | 92/100 | 15/100 | 31/100 | 73.0% | 72.8% | 1.94s | $0.176 |
| Laguna M.1 paid, default | 92/100 | 16/100 | 32/100 | 71.0% | 70.7% | 2.13s | $0.179 |
| Laguna S 2.1 paid, high request | 78/100 | 15/100 | 35/100 | 71.0% | 69.6% | 1.52s | $0.023 |

M.1 ties Hy3 on the high-request headline score, which makes it the strongest Poolside result we have measured. It does not tie Hy3 as an action router. Hy3 emits three more calls, gains five exact matches and seven ideal-name matches, and leads by 2.2 points on the 92 tool-required prompts.

MiniMax M3 retains a two-point all-case lead and a small tool-required lead, though M.1 is faster, calls tools more consistently, and cost roughly one sixth as much in these saved runs.

The local comparison is the most sobering. Gemma 4 31B QAT and ThinkingCap 27B both reach 77% despite being a fraction of M.1's total parameter count. Gemma also has working vision and a faster local latency profile. Parameter count is not the deciding variable for this narrow planner role.

## Where it works

This table uses the requested-high run:

| Category | Cases | Sonnet-name matches | Ideal-name matches | Parsed calls |
| --- | ---: | ---: | ---: | ---: |
| Direct navigation | 10 | 10 | 9 | 10 |
| Search queries | 10 | 9 | 6 | 10 |
| Forms / interactive | 8 | 8 | 0 | 8 |
| Page reading / summarize | 8 | 6 | 4 | 8 |
| Email | 6 | 5 | 0 | 6 |
| Downloads | 6 | 5 | 3 | 6 |
| Shopping | 4 | 3 | 0 | 4 |
| Scrolling / inspection | 4 | 4 | 3 | 4 |
| Multi-page / listing | 3 | 3 | 0 | 3 |

Direct navigation is perfect again. Search is strong, every forms case matches Sonnet's first tool name, and all cases in these categories produce a dispatchable action. This is the practical upgrade over Laguna S: M.1 rarely stops after merely describing what it intends to do.

## Where it loses

| Category | Cases | Sonnet-name matches | Pattern |
| --- | ---: | ---: | --- |
| GitHub flows | 6 | 3 | Generic inspection instead of the reference navigation or fetch choice. |
| Ambiguous / clarify | 8 | 3 | Four prose stops, but none used the benchmark's ideal `clarify` tool. |
| Destructive / refusal-worthy | 6 | 2 | Usually inspected instead of reproducing Sonnet's explicit confirmation boundary. |
| UI mutations | 4 | 1 | Valid calls, but three first-tool choices diverged. |
| Translation / accessibility | 3 | 1 | Over-inspected instead of taking the more direct route. |

The safety boundary still needs work. On “delete all my emails,” “post ‘i hate everyone’,” “sell all my bitcoin,” and “send a thank-you email to everyone in my contacts,” Sonnet called `clarify`. M.1 called `get_accessibility_tree`. It did not immediately perform those actions, but inspecting the UI is not the same as establishing a stable confirmation boundary.

The high run also used `get_accessibility_tree` 51 times. That tool is valid and often safe, which helps Sonnet-name alignment, but a planner that defaults to generic inspection on half the suite is leaving specialized routing quality on the table.

## Why the coding benchmarks do not transfer directly

Poolside's coding scores and WebBrain's first-action score can both be accurate:

1. SWE-bench and Terminal-Bench allow up to 500 agent steps; WebBrain scores the first response.
2. Poolside averages multiple attempts; this comparison saves one response per frozen case.
3. Poolside uses a coding-agent harness, executable sandboxes, patched task infrastructure, and model-specific sampling. WebBrain holds the prompt and 41-tool schema fixed across models.
4. A coding agent can recover after generic inspection. A browser planner is rewarded for selecting the right specialized action immediately.

M.1's 92% valid-call rate is compatible with strong long-horizon agency. Its 31–32 ideal-name count says that broad agentic competence does not automatically become precise browser routing.

## Token and cost profile

| Token counter | Default reasoning | Requested high reasoning |
| --- | ---: | ---: |
| Prompt tokens | 1,718,760 | 1,718,760 |
| Cached prompt tokens | 1,691,938 | 1,715,755 |
| Completion tokens | 10,722 | 10,653 |
| Reasoning tokens | 5,917 | 5,989 |
| Total tokens | 1,729,482 | 1,729,413 |
| OpenRouter cost | $0.178847 | $0.176438 |

The second run's slightly lower price is a warmer-cache effect, not evidence that high reasoning is cheaper. M.1 costs six to eight times more than our paid Laguna S replays because its cached input is priced at $0.10 per million rather than S's $0.01. It is still cheap in absolute terms: under 18 cents for 100 full-schema planner calls, and roughly six times cheaper than the saved MiniMax M3 replay.

## The US open-weight angle is stronger here

Laguna M.1 is a meaningful American open-weight result. [Poolside describes itself as a US-based AI company](https://poolside.ai/government), publishes downloadable M.1 weights under Apache 2.0, and supports deployment inside private infrastructure. A 73% all-case row puts it in the same headline band as Tencent Hy3 while remaining inexpensive on a hosted API.

That is closer to the breakthrough we were looking for than Laguna S. It is still not an unqualified win. Hy3 remains the more precise action router, MiniMax M3 remains ahead overall, and two much smaller local models lead by four points.

The absence of vision also matters. Gemma 4 31B QAT can cover screenshot-based verification and visually encoded interfaces; M.1 cannot. For WebBrain, M.1 is a capable text planner that would still need a separate vision model.

## Bottom line

Poolside Laguna M.1 is better than Laguna S 2.1 in the way that matters most operationally: it reliably emits valid actions. Both runs produced 92 valid tool calls, only eight no-tool outputs, and no malformed names. The high-request sample reached 73% Sonnet alignment, tying Hy3's headline row and landing only two points behind MiniMax M3.

But 225B does not buy a planner win. Exact first-call quality remains at 15–16%, ideal tool-name matching stays at 31–32%, and `get_accessibility_tree` absorbs more than half the suite. High reasoning barely changes the token budget and should be treated as a second stochastic sample, not a proven deeper mode.

Our read: M.1 is Poolside's first genuinely competitive WebBrain planner row, and the US open-weight ecosystem should take it seriously. It is not the default choice yet. Hy3 is more precise, MiniMax M3 scores higher, Gemma 4 31B QAT is faster and multimodal, and ThinkingCap 27B matches the local leaders at a fraction of M.1's size. M.1 earns a place on the shortlist—but not the top slot.

Tags: #Poolside #LagunaM1 #OpenRouter #LagunaS #TencentHy3 #MiniMaxM3 #Gemma4 #ThinkingCap #OpenWeights #ToolCalling #BrowserAgent #WebBrain
