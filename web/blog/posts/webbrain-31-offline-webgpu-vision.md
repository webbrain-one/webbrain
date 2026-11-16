---
title: >
  WebBrain 31 brings offline WebGPU vision to text-only models
slug: webbrain-31-offline-webgpu-vision
sortOrder: -170
date: 2026-08-14
readTime: 5 min read
description: >
  WebBrain 31.0.0 adds optional offline vision powered by WebGPU and Liquid AI's sub-1GB LFM2.5-VL-450M, giving strong text-only models a local visual layer.
excerpt: >
  WebBrain 31.0.0 can run a lightweight vision model locally through WebGPU, then pass its visual observations to the original text-only planner. That makes inexpensive models such as DeepSeek V4 Flash and Laguna S 2.1 more capable without turning them into larger multimodal checkpoints.
titleTag: >
  WebBrain 31 offline WebGPU vision for text-only models - WebBrain Blog
ogTitle: >
  WebBrain 31 brings offline WebGPU vision to text-only models
ogDescription: >
  Liquid AI's sub-1GB LFM2.5-VL-450M gives WebBrain an optional local visual layer while the user's original text model remains the planner.
twitterTitle: >
  WebBrain 31: offline WebGPU vision for text-only models
twitterDescription: >
  A lightweight local vision layer means inexpensive text-only planners can understand visual browser state without switching to a larger multimodal checkpoint.
keywords:
  - WebBrain 31
  - WebGPU
  - offline vision
  - Liquid AI
  - LFM2.5-VL-450M
  - DeepSeek V4 Flash
  - Laguna S 2.1
  - local AI
  - browser agent
  - text-only model
html: true
lede: >
  **WebBrain 31.0.0 adds optional offline vision powered by WebGPU.** It uses Liquid AI's [LFM2.5-VL-450M](https://huggingface.co/LiquidAI/LFM2.5-VL-450M), a 450M-parameter vision-language model whose weights are under one gigabyte. It is small enough to run as a local visual layer in the browser, yet capable enough for the screenshot understanding and visual grounding a browser agent needs.
---

## Vision from WebBrain, planning from your model

The important part of this design is that the local vision model does not replace your main model.

WebBrain uses LFM2.5-VL-450M to inspect visual browser state—screenshots, visible controls, layout relationships, selected elements, dialogs, charts, canvases, and other details that may not appear in page text or the accessibility tree. It then turns those observations into text for the main model to reason over.

That creates a clean division of labor:

1. **LFM2.5-VL-450M sees the page locally.** The vision step runs through WebGPU on the user's device.
2. **WebBrain converts the useful visual state into context.** The planner gets the information it needs without requiring native image input.
3. **The user's original model decides what to do.** Its checkpoint, serving setup, and text-only interface can remain unchanged.

In other words, WebBrain supplies the eyes while the model you chose remains the brain.

## What it looks like in WebBrain 31

In current versions, the setting is under **Settings → Models → Vision**. The tab was named Multimodal in WebBrain 31.0.0. Enable **LFM2.5-VL local fallback** to run the ONNX model on your GPU. The active provider continues to handle planning and tool calls; the in-browser fallback reads screenshots locally.

<figure>
  <img src="/assets/webbrain-31-lfm25-vl-local-fallback-settings.png" alt="WebBrain 31.0.0 Multimodal Vision settings with the LFM2.5-VL local fallback enabled" width="1586" height="1384" loading="lazy">
  <figcaption>WebBrain 31.0.0 with LFM2.5-VL local fallback enabled. Screenshots stay on the device, while the original active provider remains responsible for planning and tool calls.</figcaption>
</figure>

## Why such a small vision model is enough

LFM2.5-VL-450M uses a 350M language backbone with an 86M-parameter SigLIP2 vision encoder. Liquid AI's model card reports stronger real-world vision performance than the previous LFM2-VL-450M generation, along with improved instruction following, multilingual visual understanding, object detection, and bounding-box prediction.

It is not supposed to replace a frontier planner, and that is exactly why it fits this architecture. WebBrain needs the local model to extract useful visual evidence: what text is visible, which control looks selected, where a dialog is blocking the page, whether an error state appeared, or what a chart and canvas are showing. The larger text model can handle the longer-horizon planning, tool selection, and reasoning.

The ONNX package WebBrain uses downloads about 770 MB from Hugging Face on first use, then caches locally. The download runs in the background, so you can switch tabs or close Settings while it continues—just keep Chrome open. Once cached, it provides vision without sending screenshots to a remote vision API. If the main planner is local too, the complete WebBrain workflow can remain on the device.

## This makes strong text-only models much more useful

Our recent benchmarks keep pointing to the same opportunity: some of the best price-performance results come from models whose main limitation is not planning quality, but the lack of image input.

In our [latest thirteen-model planner benchmark](/blog/american-chinese-open-model-frontier-gap-benchmark), **DeepSeek V4 Flash ranked first by exact-action peer consensus**. The full 100-case replay cost about five cents. It was fast, inexpensive, and highly competitive—but text-only.

**[Poolside Laguna S 2.1 showed a similar trade-off in its class.](/blog/poolside-laguna-s-openrouter-planner-benchmark)** It reached 71% Sonnet alignment in our requested-high-reasoning planner run, returned at a 1.52-second median, and the 100-case replay cost less than three cents. MiniMax M3 scored four points higher in that frozen test, but its saved replay cost $1.06. Laguna's OpenRouter route was also text-only.

These are different benchmark views, so the percentages should not be combined into one ranking. The consistent product signal is what matters: DeepSeek V4 Flash and Laguna S 2.1 both performed well for their respective class and price, while costing dramatically less than strong peers. For both, vision was the conspicuous missing capability.

That lack of vision mattered. A browser agent can often act from URLs, page text, the DOM, and accessibility data, but some decisive information exists only visually: a canvas-rendered interface, a broken accessibility tree, a selected tab, a disabled button, a drag target, a chart, or the final state after an action.

WebBrain 31 changes the model-selection equation. Instead of moving from a strong, inexpensive text model to a larger or more expensive multimodal variant, users can keep the original DeepSeek V4 Flash, Laguna S 2.1, or another text-only model and let WebBrain provide the missing visual context locally.

## Cheaper, more private, and more flexible

Separating vision from planning has three practical advantages:

- **Lower cost.** Visual understanding does not require a paid image call on every screenshot, and users can keep an inexpensive text-only route for the main agent loop.
- **More privacy.** When offline vision is enabled, screenshots are processed on the device instead of being uploaded to a vision provider. If the planner is remote, its normal text context still follows that provider's data path; the image itself does not need to.
- **More choice.** Users do not have to wait for a special vision fine-tune or switch away from a model that already performs well for their tasks. The original, unmodified text checkpoint can stay in place.

This is also a more sustainable way to improve WebBrain. A lightweight visual layer can serve many different planners, so every strong text-only release becomes a more complete browser-agent option without requiring a new multimodal graft for each model.

## Available now in WebBrain 31.0.0

Offline WebGPU vision is optional in WebBrain 31.0.0. Users with compatible browser and device support can enable the local model under **Settings → Models → Vision**, while existing local and hosted vision configurations remain available for people who prefer them or need a different capability profile.

We will continue sharing compatibility notes and real WebBrain vision results as more people use the local fallback.

Most of all, thank you to **Liquid AI** for making LFM2.5-VL-450M open source and openly available. A capable vision model below one gigabyte is what makes this split architecture practical, and releasing it under the LFM Open License gives projects like WebBrain a foundation to build on.

Tags: #WebBrain #WebGPU #OfflineAI #LiquidAI #LFM25VL #LocalAI #BrowserAgent
