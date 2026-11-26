---
title: Introducing openfal for local image and video generation
slug: openfal-local-image-video-generation
date: 2026-11-26
readTime: 2 min read
description: >
  openfal serves image and video models on local hardware through a fal-style API, with a request queue, a Python SDK, and a browser Studio.
excerpt: >
  A local inference server for Qwen-Image-2.1, Wan 2.2, and MiniMax H3 with an API and queue that apps can use.
keywords:
  - openfal
  - WebBrain
  - local inference
  - image generation
  - video generation
  - self-hosting
  - RTX 5090
---

**openfal** gives applications a local API for generating images and video. The project grew out of requests for video explanations in WebBrain. Handling those requests offline called for a way to run media generation on the same machine as the browser agent.

## From prompt to file

Apps can submit jobs through a fal-style HTTP API or the Python SDK. The server returns a request ID for each queued job. Clients can poll for status or subscribe to server-sent events, then fetch the finished image or video. The browser-based Studio lets developers try the same workflows interactively.

The API covers image generation and editing with Qwen-Image-2.1, video generation with Wan 2.2, and selected image and video workflows with MiniMax H3. The server listens on localhost by default. With the required model files and inputs on disk, generation can run offline.

## How openfal uses memory

Inspired in part by Strata’s approach to hardware limits, openfal can move model blocks between system RAM and the compute device during inference. This allows fewer model weights to occupy VRAM at once. Memory requirements vary by model and configuration.

## What the RTX 5090 tests measured

In the published tests on one RTX 5090, openfal averaged **3.98 seconds** per warm Qwen-Image-2.1 Turbo request at 1344 × 768 and eight steps. The benchmark compares latency and peak VRAM across four workloads with ComfyUI and vLLM-Omni. The fastest engine varied by workload. The report records differences in engine settings and video output lengths. [RTX 5090 benchmark report](https://github.com/webbrain-one/openfal/blob/main/docs/benchmark-rtx-5090-2026-11-18.md)

## Run openfal

- [Source code and setup guide](https://github.com/webbrain-one/openfal)
- [Project website and quickstart](https://openfal.org/)

openfal is an independent project. The server code is MIT-licensed, and the model weights retain their upstream licenses.

When sharing a run on a smaller GPU, include the GPU model, available VRAM, checkpoint, and generation settings.
