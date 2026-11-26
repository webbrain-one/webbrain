---
title: I built openfal to run image and video models locally
slug: openfal-local-image-video-generation
date: 2026-11-26
readTime: 2 min read
description: >
  How a few WebBrain requests for video explanations led to openfal, a local inference server with a fal-style API, a job queue, and a browser Studio.
excerpt: >
  A few WebBrain requests for video explanations got me thinking about local generation. I built openfal to serve image and video models from my own machine.
keywords:
  - openfal
  - WebBrain
  - local inference
  - image generation
  - video generation
  - self-hosting
  - RTX 5090
---

A few shared WebBrain queries stuck with me. People were asking for things like “explain this concept in a video,” and the requests ended without a usable video. I wanted to see what it would take to handle that kind of request while keeping WebBrain’s goal of running locally and offline.

## Giving apps a local API for media generation

Hosted APIs like fal.ai make media generation easy to call from an app. I wanted that workflow on my own machine, with ready-to-run presets for common jobs. So I built **openfal**, a local inference server for images and video.

- A fal-style HTTP API and job queue
- A Python SDK and status updates through polling or server-sent events (SSE)
- A browser-based Studio for trying prompts and inspecting results
- Selected workflows for Qwen-Image-2.1, Wan 2.2, and MiniMax H3

Once you’ve downloaded the required model files, inference can run offline with local inputs. The server binds to localhost (`127.0.0.1`) by default.

## What fits on your hardware

I took some inspiration from the way Strata works within hardware limits. During inference, openfal can move model blocks between system RAM and the compute device as needed. The model and its settings determine how much RAM and VRAM you’ll need.

I ran openfal, ComfyUI, and vLLM-Omni on the same RTX 5090. The fastest engine varied by workload. The runs used different configurations and, for one video scenario, different output durations. The benchmark report includes the run settings, cold and warm timings, and peak VRAM.

## Try it on your machine

- [Source code and setup guide](https://github.com/webbrain-one/openfal)
- [RTX 5090 benchmark report](https://github.com/webbrain-one/openfal/blob/main/docs/benchmark-rtx-5090-2026-11-18.md)
- [openfal website](https://openfal.org/)

openfal is an independent project. The server code is MIT-licensed, and the model weights retain their upstream licenses.

I’d especially like to hear from people trying openfal on a smaller GPU. If you give it a go, share the GPU, how much VRAM it has, and which models and settings worked for you.
