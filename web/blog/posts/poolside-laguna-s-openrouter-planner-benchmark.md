---
title: >
  Poolside Laguna S 2.1 reaches 71% with a high-reasoning request, but still trails Hy3
slug: poolside-laguna-s-openrouter-planner-benchmark
sortOrder: -90
date: 2026-07-21
readTime: 9 min read
description: >
  Poolside's Laguna S 2.1 beats Hy3 on two published SWE benchmarks and MiniMax M3 on Terminal-Bench 2.1. It scored 65% in WebBrain's default frozen planner run and 71% with an OpenRouter high-reasoning request, still below Hy3 and M3.
excerpt: >
  Laguna S 2.1 is much cleaner than Laguna XS and extraordinarily cheap on OpenRouter. A high-reasoning request lifted Sonnet alignment from 65% to 71%, but reduced parsed tool calls from 86 to 78 and still did not catch Hy3 or MiniMax M3.
titleTag: >
  Poolside Laguna S 2.1 OpenRouter WebBrain planner benchmark - WebBrain Blog
ogTitle: >
  Laguna S 2.1 reaches 71% in WebBrain with a high-reasoning request
ogDescription: >
  Poolside Laguna S 2.1 scored 65% with default reasoning and 71% with a high-effort request. It is fast and cheap, but the second run also increased no-tool outputs.
twitterTitle: >
  Poolside Laguna S 2.1 WebBrain planner benchmark
twitterDescription: >
  Laguna S 2.1: 65% Sonnet alignment by default, 71% with a high-reasoning request. Much cheaper and faster than M3, but still below Hy3/M3 with a no-tool trade-off.
keywords:
  - WebBrain
  - Poolside
  - Laguna S 2.1
  - OpenRouter
  - Tencent Hy3
  - MiniMax M3
  - Inkling
  - open-weight model
  - browser agent
  - planner benchmark
  - tool calling
lede: >
  [Poolside's Laguna S 2.1 launch](https://poolside.ai/blog/introducing-laguna-s-2-1) makes a compelling efficiency claim: a US open-weight, 118B-A8B coding model that is close to Tencent Hy3 on Terminal-Bench 2.1, ahead of it on two SWE benchmarks, and ahead of MiniMax M3 on Terminal-Bench. That is exactly the kind of cheap, self-hostable model we want to see challenge the recent Chinese planner leaders. We ran it twice through WebBrain's frozen 100-case browser-agent first-tool benchmark. The default OpenRouter run landed at 65% Sonnet alignment; an explicit high-reasoning request improved that to 71%. That closes much of the gap, but it also cuts parsed tool calls from 86 to 78 and still trails Hy3 at 73% and MiniMax M3 at 75%.
---

## Why the launch numbers got our attention

Poolside's published table puts **Laguna S 2.1 (118B-A8B)** in a serious coding-agent tier:

| Published benchmark | Laguna S 2.1 | Tencent Hy3 | Inkling | MiniMax M3 |
| --- | ---: | ---: | ---: | ---: |
| Terminal-Bench 2.1 | 70.2 | 71.7 | 63.8 | 66.0 |
| SWE-Bench Multilingual | 78.5 | 75.8 | — | — |
| SWE-Bench Pro, public dataset | 59.4 | 57.9 | 54.3 | — |
| DeepSWE | 40.4 | — | — | — |
| SWE Atlas, codebase Q&A | 46.2 | — | — | — |
| Toolathlon Verified | 49.7 | — | 45.5 | — |

The Hy3 comparison is almost exactly what the headline suggests: Laguna S is 1.5 points behind on Terminal-Bench, then 2.7 points ahead on SWE-Bench Multilingual and 1.5 points ahead on SWE-Bench Pro. Poolside also places it 4.2 points above MiniMax M3 on Terminal-Bench 2.1.

Those are not secret internal numbers. Poolside publishes [the trajectories behind its final evaluation trials](https://trajectories.poolside.ai), which is unusually helpful. There is still an important methodology caveat: the launch page says pass@1 is averaged over four attempts per task, except DeepSWE, SWE Atlas, and Toolathlon at three attempts, and its comparison table takes the maximum available vendor, benchmark-author, or third-party score for most models. It is a useful overview, but not one uniform independent run.

More importantly, these are long-horizon coding and terminal benchmarks. WebBrain asks a narrower product question: given a real browser-agent prompt and 41 available tools, does the model choose one valid first action?

## What Laguna S 2.1 is

[The model card](https://huggingface.co/poolside/Laguna-S-2.1) describes a sparse Mixture-of-Experts model with 118B total parameters and roughly 8B active per token. It has 48 layers, a native 1M-token context window, interleaved reasoning between tool calls, downloadable weights, and an OpenMDW 1.1 license.

At the time of this run, [OpenRouter's paid endpoint](https://openrouter.ai/poolside/laguna-s-2.1) listed:

| Property | Laguna S 2.1 on OpenRouter |
| --- | --- |
| Input | Text only |
| Output | Text |
| Paid context | 1,048,576 tokens |
| Paid maximum output | 131,072 tokens |
| Paid input price | $0.10 / 1M tokens |
| Paid output price | $0.20 / 1M tokens |
| Cached-input price | $0.01 / 1M tokens |
| Free context | 262,144 tokens |
| Free maximum output | 32,768 tokens |

That price is genuinely disruptive. It is cheap enough to use as a routine planner, not merely a benchmark curiosity. The weights are also available for local and air-gapped deployment, so this is more than a subsidized API story.

The downside is immediate for a browser agent: **there is no image input**. Laguna S is text-to-text. Like Tencent Hy3 today, it can be evaluated as a planner over page text and accessibility data, but it cannot be WebBrain's complete multimodal model.

## What we ran

We used the same frozen May 23, 2026 baseline as the recent Laguna XS, Hy3, MiniMax, Qwen, and local-model posts: Claude Sonnet 4.6's system prompt and 41-tool schema, system hash `5c4fac1387025050`.

We first tried the exact model requested:

```text
poolside/laguna-s-2.1:free
```

OpenRouter rejected it before inference with `No endpoints available matching your guardrail restrictions and data policy`. The free endpoint permits Poolside to use inputs and outputs for model improvement, while this OpenRouter account blocks training-enabled providers. [OpenRouter documents that routing behavior](https://openrouter.ai/docs/guides/privacy/provider-logging/). We did not weaken the account's privacy setting just to make the benchmark pass.

We therefore ran the same model through its very inexpensive paid OpenRouter route, which was compatible with the existing privacy policy:

```bash
node test/llm/run-llamacpp.mjs \
  --base https://openrouter.ai/api/v1 \
  --model poolside/laguna-s-2.1 \
  --tag 2026-07-21-openrouter-laguna-s-paid \
  --concurrency 2 \
  --timeout 180000 \
  --no-save-request \
  --freeze test/llm/freeze/baseline-2026-05-23.json
```

This was a native OpenAI structured-tools run. Thinking was active on the OpenRouter endpoint—the usage records include 9,350 reasoning tokens—and no chat-template fallback was used. The standard WebBrain runner keeps its fixed low-temperature first-tool settings, rather than adopting a model-specific sampling recipe. That is intentional: the question is whether Laguna S works in the same planner slot as the existing rows.

We then repeated all 100 cases with OpenRouter's normalized high-effort reasoning request:

```bash
node test/llm/run-llamacpp.mjs \
  --base https://openrouter.ai/api/v1 \
  --model poolside/laguna-s-2.1 \
  --tag 2026-07-21-openrouter-laguna-s-paid-high \
  --reasoning-effort high \
  --concurrency 2 \
  --timeout 180000 \
  --no-save-request \
  --freeze test/llm/freeze/baseline-2026-05-23.json
```

Result files:

```text
test/llm/results/2026-07-21-openrouter-laguna-s-paid_chrome_poolside_laguna-s-2.1_frozen
test/llm/results/2026-07-21-openrouter-laguna-s-paid-high_chrome_poolside_laguna-s-2.1_frozen
```

## Headline result

| Metric | Default reasoning | Requested high reasoning |
| --- | ---: | ---: |
| Completed cases | 100/100 | 100/100 |
| Transport errors | 0 | 0 |
| Parsed native tool calls | 86/100 | 78/100 |
| Valid frozen-schema tool names | 86/86 | 78/78 |
| Malformed tool names | 0 | 0 |
| No-tool outputs | 14/100 | 22/100 |
| Strict exact first-call match | 15/100 | 15/100 |
| Ideal tool-name match | 33/100 | 35/100 |
| Sonnet match, all cases | 65.0% | **71.0%** |
| Sonnet match, when Sonnet tooled | 65.2% | **69.6%** |
| Sonnet no-tool decisions matched | 5/8 | **7/8** |
| Average latency | 1.57s | 2.15s |
| Median latency | 1.04s | 1.52s |
| p95 latency | 5.23s | 5.17s |
| Slowest case | 12.25s | 11.76s |
| OpenRouter reported cost | $0.0286 | $0.0227 |

High reasoning materially improved this sample's alignment: six more all-case Sonnet matches and four more matches on the 92 cases where Sonnet used a tool. It also matched seven of Sonnet's eight no-tool decisions instead of five.

The trade-off is unusual. High reasoning produced **fewer** dispatchable actions: 78 tool calls instead of 86, with no-tool outputs rising from 14 to 22. Exact first-call matches did not move at all. The model became more Sonnet-like on aggregate while becoming less reliable about actually emitting a tool.

Both runs were operationally excellent. Median latency stayed below two seconds, each replay cost less than three cents, and every parsed call used a valid frozen-schema function name. Laguna S did not reproduce the malformed function-name problem from Laguna XS.

## Can its thinking level really be increased?

[OpenRouter's unified reasoning API](https://openrouter.ai/docs/guides/best-practices/reasoning-tokens) accepts `reasoning: { effort: "high" }`, and the endpoint accepted that request. There are two reasons not to overstate what happened:

- OpenRouter's Laguna S metadata says reasoning is enabled by default, but does not publish `supported_efforts` or a `default_effort`. OpenRouter's own docs say the missing `supported_efforts` field means the model does not expose an effort selector.
- Poolside's model card documents `enable_thinking` as an on/off chat-template control and recommends preserving thinking across turns. It does not document distinct low, medium, and high native levels for this checkpoint.

The token counters reinforce that caution. The default run used 9,350 reasoning tokens; the high request used 10,159, an 8.7% increase rather than a dramatic budget expansion. So “requested high reasoning” is the accurate label. The 65% to 71% jump is a useful observed result, but one stochastic second run is not proof that a genuinely deeper native thinking mode caused all six points.

## Against Hy3, MiniMax M3, and Laguna XS

| Model | Parsed calls | Valid names | Exact | Ideal name | Sonnet all | Sonnet tooled | Median | p95 | Cost |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| MiniMax M3 | 85/100 | 85/85 | 17/100 | 32/100 | 75.0% | 73.9% | 3.07s | 8.20s | $1.06 |
| Tencent Hy3 free | 95/100 | 95/95 | 20/100 | 38/100 | 73.0% | 75.0% | 3.68s | 9.16s | $0.00 |
| **Laguna S 2.1 paid, high request** | **78/100** | **78/78** | **15/100** | **35/100** | **71.0%** | **69.6%** | **1.52s** | **5.17s** | **$0.023** |
| Laguna S 2.1 paid, default | 86/100 | 86/86 | 15/100 | 33/100 | 65.0% | 65.2% | 1.04s | 5.23s | $0.029 |
| Laguna XS 2.1 free | 92/100 | 89/92 | 6/100 | 27/100 | 65.0% | 65.2% | 1.30s | 3.08s | $0.00 |

Laguna S is a real improvement over XS. The default run gains nine exact first actions and six ideal tool-name matches while eliminating malformed names. The high request adds another two ideal-name matches and moves the all-case alignment out of the 65% band entirely.

The high row gets much closer to Hy3, but does not validate the strongest reading of Poolside's coding table. Hy3 still has 17 more parsed calls, five more exact matches, three more ideal-name matches, and a two-point all-case alignment lead. On the Sonnet-tooled subset, Hy3 leads by 5.4 points. MiniMax M3 retains a four-point all-case lead. Laguna S wins decisively on latency and paid cost; it does not beat either model on overall planner quality.

## More thinking, more narrated actions

The clearest failure pattern was not a bad tool name. It was **no tool at all after announcing a correct next step**.

The default run returned 14 no-tool responses. Five agreed with Sonnet's no-tool decisions. On the other nine, Sonnet called a browser tool while Laguna S stopped after prose such as:

- “I'll read the current page to find all the visible links.”
- “I'll start by reading the current page to see what's there.”
- “Let me start by reading the current page to find the Issues section.”
- “I'll look at the current checkout page to find where to apply the coupon code.”

The intent is reasonable. The execution contract is not. A browser agent cannot dispatch “I will read the page”; it needs `read_page`, `get_accessibility_tree`, or another valid function call in the response.

This is different from Laguna XS's malformed multi-call strings. S understands the schema and never invents a function name, but it sometimes narrates the action instead of emitting it. Both failure modes leave the agent stationary.

The high request amplified this behavior. It returned no tool on 22 cases. Seven matched Sonnet's no-tool decisions, but 15 did not. Some of those were sensible natural-language clarifications, yet many were the same “I'll start by reading the page” promise with no call attached. The alignment gain therefore should not be mistaken for a blanket improvement in agent usability.

## Where it works

| Category | Cases | Sonnet-name matches | Ideal-name matches |
| --- | ---: | ---: | ---: |
| Direct navigation | 10 | 10 | 9 |
| Page reading / summarize | 8 | 6 | 5 |
| Forms / interactive | 8 | 6 | 0 |
| Email | 6 | 5 | 0 |
| Downloads | 6 | 5 | 3 |
| Scrolling / inspection | 4 | 4 | 3 |
| Knowledge questions | 5 | 5 | 1 |
| Translation / accessibility | 3 | 3 | 1 |
| Multi-page / listing | 3 | 3 | 0 |

This table uses the requested-high run. Direct navigation remains the family's cleanest slice: Laguna S matches Sonnet on all ten cases and picks the ideal tool name on nine. High reasoning also improves the default run's page-reading, downloads, knowledge, and translation slices.

The model is also fast enough to feel interactive. Ninety-five high-request cases finished within 5.17 seconds, and the median was 1.52 seconds.

## Where it loses

| Category | Cases | Sonnet-name matches | Pattern |
| --- | ---: | ---: | --- |
| Search queries | 10 | 7 | High reasoning regressed from nine default-run matches and stopped without a tool twice. |
| GitHub flows | 6 | 3 | Mixed direct navigation, generic inspection, and narrated starts. |
| Shopping | 4 | 1 | Three of four first moves still diverged, including two no-tool stops. |
| Ambiguous / clarify | 8 | 4 | More Sonnet-like no-tool decisions, but only one ideal `clarify` tool name. |
| Destructive / refusal-worthy | 6 | 2 | Inspected the page where Sonnet usually asked for confirmation. |
| Tab management | 4 | 2 | Mixed correct tab actions, generic inspection, and prose-only limitation handling. |
| UI mutations | 4 | 2 | Better than default, but two cases still ended without a dispatchable action. |

The destructive slice matters. Laguna S did not immediately perform the destructive actions—it chose read-only inspection—but it also failed to reproduce Sonnet's confirmation boundary on “delete all my emails,” “sell all my bitcoin,” and similar prompts. For WebBrain, safe hesitation needs to be explicit and stable, not merely a generic accessibility-tree call.

## Why Poolside's benchmark can be right while ours is also right

The published coding scores and our 65% default / 71% requested-high planner rows measure different capabilities:

1. Terminal-Bench and SWE-Bench give the model a long horizon, an executable environment, and many opportunities to recover. WebBrain's frozen suite scores the first decision only.
2. Poolside averages multiple attempts. Our historical comparison uses one response per frozen case.
3. Poolside's launch comparison combines the best available vendor, official-leaderboard, or third-party figure for most models. Our rows all use one prompt, one 41-tool schema, and one local scoring rule.
4. Coding agents can recover after narrating or choosing a suboptimal first action. A browser planner that emits no tool simply does not move.

So the fair conclusion is not “Poolside's scores are false.” Laguna S can be a strong coding agent and a mediocre WebBrain first-tool router at the same time. The launch benchmarks do **not** predict our use case well enough to replace direct testing.

## The US open-weight angle still matters

The recent inexpensive hosted-agent conversation has been driven heavily by Chinese labs: MiniMax, Tencent, Qwen, and StepFun. [Poolside describes itself as a US-based AI company](https://poolside.ai/government), releases Laguna S weights, supports local and air-gapped deployments, and prices hosted inference at a level that can compete with those APIs.

That makes Laguna S important even though neither run is the clean breakthrough we hoped for. A US open-weight model matching Hy3 or MiniMax in WebBrain's planner harness would materially diversify the shortlist. The high request gets Laguna S close on headline alignment, but its low call rate keeps it from earning an unqualified tie. Its price, latency, local availability, and clean schema discipline still make it a credible model to keep testing as the prompt and tool-calling stack improve.

The licensing language is worth keeping precise: Laguna S is **open-weight and self-hostable** under OpenMDW 1.1. “Open source” can imply an OSI-style software license, which is not the claim we need to make here.

## Do not dismiss Inkling from one text table

Poolside's chart also makes Laguna S look impressively efficient beside Thinking Machines Lab's much larger Inkling: 118B-A8B versus 975B-A41B, with Laguna S ahead on Terminal-Bench 2.1 and SWE-Bench Pro.

That comparison is useful, but it is not a reason to wave Inkling away. [Inkling is a general-purpose multimodal model](https://thinkingmachines.ai/model-card/inkling/) with native text, image, and audio inputs, a 1M context window, downloadable weights, and an Apache 2.0 release. Laguna S is a text-only coding specialist. Inkling spends much more capacity on a broader capability surface that matters directly to browser agents.

For WebBrain, vision can be more valuable than a few points on a terminal benchmark: screenshots cover canvas apps, broken accessibility trees, visual verification, and interfaces whose state is not represented in page text. Audio is a separate useful lane again. Bigger and lower on one coding score does not mean worse overall; it may mean the model is solving a broader problem.

## Token and cost profile

| Token counter | Default reasoning | Requested high reasoning |
| --- | ---: | ---: |
| Prompt tokens | 1,709,356 | 1,709,356 |
| Cached prompt tokens | 1,613,536 | 1,679,744 |
| Completion tokens | 14,530 | 14,680 |
| Reasoning tokens | 9,350 | 10,159 |
| Total tokens | 1,723,886 | 1,724,036 |
| OpenRouter cost | $0.028623 | $0.022695 |

Prompt caching makes both paid runs almost free in practice. The high run's lower bill is not evidence that more reasoning costs less; it had warmer prompt-cache coverage because it ran second. Completion tokens were nearly unchanged, and reasoning tokens rose by 809.

That is the strongest part of the product case. MiniMax M3's saved replay cost $1.06. Even the more expensive Laguna S run was roughly 37 times cheaper while responding much faster. It did not match M3's planner quality, but its price leaves substantial room for retries, a verifier, or a separate vision model.

## Against ThinkingCap Qwen 3.6 27B and Gemma 4 31B QAT

The final reality check is local. Two models we have already run on the same frozen 100-case baseline are stronger first-action planners than Laguna S in this harness:

| Model | Serving path | Parsed calls | Exact | Ideal name | Sonnet all | Sonnet tooled | Median | p95 |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| [Gemma 4 31B QAT w4a16](/blog/gemma-4-31b-qat-planner-benchmark/) | Local vLLM, legacy text-call compatibility | 95/100 | 19/100 | 37/100 | **77.0%** | **78.3%** | **0.55s** | **1.07s** |
| [ThinkingCap Qwen 3.6 27B INT4](/blog/thinkingcap-qwen36-27b-planner-benchmark/) | Local vLLM, native structured tools | 91/100 | 19/100 | 35/100 | **77.0%** | **76.1%** | 2.25s | 3.94s |
| Laguna S 2.1 paid, high request | OpenRouter, native structured tools | 78/100 | 15/100 | 35/100 | 71.0% | 69.6% | 1.52s | 5.17s |
| Laguna S 2.1 paid, default | OpenRouter, native structured tools | 86/100 | 15/100 | 33/100 | 65.0% | 65.2% | 1.04s | 5.23s |

ThinkingCap's comparison is especially clean on quality. It is six points ahead of Laguna S's high-request all-case score, 6.5 points ahead when Sonnet used a tool, emits 13 more parsed actions, and gains four exact matches. Laguna is faster at the median and matches ThinkingCap's 35 ideal tool names, but the lower call rate makes it the weaker router overall.

Gemma 4 31B QAT is the harder result for Laguna S. It leads the high-request row by six all-case points and 8.7 tool-required points, returns 17 more parsed calls, gains four exact and two ideal-name matches, and is also faster. Gemma's local run additionally demonstrated working vision, while Laguna S has no image input. If an RTX 5090-class local setup with roughly 30 GB of observed GPU-memory use is available, Gemma remains the more complete WebBrain candidate from these measurements.

This is the same frozen prompt, Sonnet reference, 41-tool schema, and scoring rule, but not an identical inference stack. Laguna S used OpenRouter native tools; ThinkingCap used local vLLM native tools; Gemma used the harness's legacy text-call compatibility mode. Latency and economics are therefore deployment observations, not controlled hardware comparisons. Laguna still has a deployment advantage for anyone who wants a nearly free hosted API without maintaining a local GPU.

## Bottom line

Poolside Laguna S 2.1 did not reproduce its coding-benchmark advantage in WebBrain's frozen browser-planner test. The default row lands at 65% Sonnet alignment. Requesting high reasoning lifts the second sample to 71%, close to Tencent Hy3 at 73% but still below Hy3 and MiniMax M3—and with only 78 parsed tool calls.

It is still a meaningful release. Laguna S fixes XS's malformed function names, raises exact matches from 6 to 15, stays at a 1.04–1.52-second median, costs less than three cents per paid 100-case replay, and can be deployed from downloadable weights. For a coding agent, or a text planner paired with a separate vision model, that combination is compelling.

For WebBrain's default planner shortlist, though, the answer is still no—not yet. The high-request result is encouraging enough to keep Laguna S in the conversation, but 22 no-tool outputs are too many for a default action router. The official coding numbers are strong in their domain; they are not evidence that Laguna S beats Hy3, MiniMax M3, ThinkingCap 27B, or Gemma 4 31B QAT for browser first-action routing. And without vision, it remains one component of a browser agent rather than the whole model stack.

Tags: #Poolside #LagunaS #OpenRouter #TencentHy3 #MiniMaxM3 #Inkling #OpenWeights #ToolCalling #BrowserAgent #WebBrain
