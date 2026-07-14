---
title: >
  GLM-5.2 is not WebBrain's new planner reference yet
slug: glm52-nvidia-webbrain-planner-benchmark
sortOrder: -80
date: 2026-07-14
readTime: 6 min read
description: >
  We ran z-ai/glm-5.2 through WebBrain's frozen, full, mid, and compact browser-agent first-tool planner suites on NVIDIA. It should be a stronger frontier open-model candidate than the old Sonnet reference, but this narrow planner result is more cautious.
excerpt: >
  GLM-5.2 completed four 100-case WebBrain planner suites with zero transport errors after resumed runs. The frozen row lands at 69% Sonnet alignment, 21 exact first calls, and 36 ideal tool-name matches.
titleTag: >
  GLM-5.2 NVIDIA WebBrain planner benchmark - WebBrain Blog
ogTitle: >
  GLM-5.2 is not WebBrain's new planner reference yet
ogDescription: >
  z-ai/glm-5.2 completed WebBrain's frozen, full, mid, and compact planner suites on NVIDIA, but its first-tool results do not make it a new WebBrain reference point yet.
twitterTitle: >
  GLM-5.2 WebBrain planner benchmark
twitterDescription: >
  GLM-5.2 via NVIDIA: frozen/full/mid/compact WebBrain first-tool planner results, with 69% frozen Sonnet alignment and no serving-speed claims.
keywords:
  - WebBrain
  - GLM-5.2
  - z-ai
  - NVIDIA
  - browser agent
  - planner benchmark
  - tool calling
  - frontier model
lede: >
  `z-ai/glm-5.2` is the kind of open frontier-model candidate that should make WebBrain pay attention. We ran it through the frozen WebBrain planner set and the current Full, Mid, and Compact prompt tiers using NVIDIA's OpenAI-compatible chat-completions endpoint. The prior expectation was high: this class of model should be better than the older Sonnet reference in many general settings. In WebBrain's first-tool browser planner harness, though, the result is useful but not reference-setting.
---

## Why this run matters

[NVIDIA's API reference lists `z-ai/glm-5.2`](https://docs.api.nvidia.com/nim/reference/z-ai-glm-5.2) as a Large Language Model available through its chat-completions API. That made it an easy target for a WebBrain planner check: same runner, same first-tool scoring lens, but a model that should belong closer to the frontier than the older Sonnet snapshot we have been using as a stable reference line.

That last sentence is important. We do **not** read "Sonnet match" as a universal intelligence score. In these posts, it means something narrower: did the model choose the same first tool name as the saved Claude Sonnet 4.6 row from May 23, 2026? That Sonnet row is useful because it gives us a fixed, real browser-agent behavior trace. It is not sacred.

The question here was simple: can GLM-5.2 become a better WebBrain planner reference point, or at least clearly displace the old Sonnet-shaped baseline?

Not from this run.

## What we ran

The frozen run used the same May 23, 2026 WebBrain baseline used by the recent planner posts: Claude Sonnet 4.6's system prompt and 41-tool schema, system hash `5c4fac1387025050`.

```bash
NVIDIA_API_KEY=... node test/llm/run-llamacpp.mjs \
  --base https://integrate.api.nvidia.com/v1 \
  --model z-ai/glm-5.2 \
  --tag 2026-07-13-nvidia-glm52 \
  --concurrency 1 \
  --timeout 240000 \
  --no-save-request \
  --freeze test/llm/freeze/baseline-2026-05-23.json
```

Then we ran the current WebBrain Act prompt tiers with the current tool schemas:

```bash
NVIDIA_API_KEY=... node test/llm/run-llamacpp.mjs \
  --base https://integrate.api.nvidia.com/v1 \
  --model z-ai/glm-5.2 \
  --tag 2026-07-13-nvidia-glm52-full \
  --concurrency 1 \
  --timeout 240000 \
  --no-save-request

NVIDIA_API_KEY=... node test/llm/run-llamacpp.mjs \
  --base https://integrate.api.nvidia.com/v1 \
  --model z-ai/glm-5.2 \
  --tag 2026-07-13-nvidia-glm52-mid \
  --tier mid \
  --concurrency 1 \
  --timeout 240000 \
  --no-save-request

NVIDIA_API_KEY=... node test/llm/run-llamacpp.mjs \
  --base https://integrate.api.nvidia.com/v1 \
  --model z-ai/glm-5.2 \
  --tag 2026-07-13-nvidia-glm52-compact \
  --tier compact \
  --concurrency 1 \
  --timeout 240000 \
  --no-save-request
```

This was a native OpenAI structured-tools run. No chat-template fallback was used, and request payloads were not saved.

One operational note: we used NVIDIA's free tier, so the complete set took a long time and needed resumed passes. I would not use this run to make a serving-performance claim.

Result files in the repo:

| Suite | Result directory |
| --- | --- |
| Frozen | [`2026-07-13-nvidia-glm52_chrome_z-ai_glm-5.2_frozen`](https://github.com/webbrain-one/webbrain/tree/main/test/llm/results/2026-07-13-nvidia-glm52_chrome_z-ai_glm-5.2_frozen) |
| Full | [`2026-07-13-nvidia-glm52-full_chrome_z-ai_glm-5.2`](https://github.com/webbrain-one/webbrain/tree/main/test/llm/results/2026-07-13-nvidia-glm52-full_chrome_z-ai_glm-5.2) |
| Mid | [`2026-07-13-nvidia-glm52-mid_chrome_z-ai_glm-5.2_mid`](https://github.com/webbrain-one/webbrain/tree/main/test/llm/results/2026-07-13-nvidia-glm52-mid_chrome_z-ai_glm-5.2_mid) |
| Compact | [`2026-07-13-nvidia-glm52-compact_chrome_z-ai_glm-5.2_compact`](https://github.com/webbrain-one/webbrain/tree/main/test/llm/results/2026-07-13-nvidia-glm52-compact_chrome_z-ai_glm-5.2_compact) |

## Results

| Suite | Cases | Parsed / valid | Exact first call | Ideal tool name | Sonnet match | Sonnet match when Sonnet tooled |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Frozen | 100/100 | 89/89 | 21/100 | 36/100 | 69/100 | 64/92 |
| Full | 100/100 | 87/87 | 20/100 | 35/100 | 66/100 | 61/92 |
| Mid | 100/100 | 83/83 | 23/100 | 36/100 | 68/100 | 61/92 |
| Compact | 100/100 | 85/85 | 20/100 | 33/100 | 64/100 | 59/92 |

The healthiest part of the result is reliability: all four included suites finished at 100/100 cases, and every parsed first tool call used a valid tool name for that suite's schema.

The planner-quality read is more mixed. The frozen row is the cleanest apple-to-apple comparison against the old Sonnet trace, and it lands at 69/100 Sonnet-name alignment. That is respectable, but not enough to make GLM-5.2 the new anchor for this benchmark. The current Full, Mid, and Compact tiers all stay in roughly the same band, which is useful because it suggests the result is not just a frozen-prompt artifact.

The exact and ideal-name scores are also cautious. GLM-5.2 can choose reasonable browser tools, but it does not consistently land on WebBrain's canonical first action in these frozen cases.

## Readout

My read is: GLM-5.2 remains an important model to keep in the WebBrain matrix, but this result does not replace the old Sonnet reference. It should be stronger than that older Sonnet snapshot in broader model capability terms; this harness is simply asking a different, narrower question.

The better next comparison is probably not another old Sonnet row. It is the next frontier batch: ChatGPT 5.6 Sol, Claude Fable 5, and other new top-tier systems as they become practical to run through the same suite. We may also rerun GLM-5.2 outside the free tier, where the operational constraints are cleaner.

For now, the conservative conclusion is:

> GLM-5.2 is a serious WebBrain planner candidate, but not WebBrain's new planner reference point yet.
