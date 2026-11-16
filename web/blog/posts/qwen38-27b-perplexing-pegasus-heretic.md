---
title: >
  Qwen3.8-27B-Perplexing-Pegasus-Heretic: One 27B Model for Local Vision, Tool Calling, and Typed Decisions
slug: qwen38-27b-perplexing-pegasus-heretic
sortOrder: -480
date: 2026-11-16
readTime: 4 min read
description: >
  We released Qwen3.8-27B-Perplexing-Pegasus-Heretic (Apache-2.0): a unified 27B model combining multimodal vision, tool calling, pplx-decider typed decisions, MTP, and Heretic ARA abliteration for single-GPU local inference.
excerpt: >
  Instead of juggling separate vision, decision, and uncensored models on local hardware, Qwen3.8-27B-Perplexing-Pegasus-Heretic packs all three into one 27B checkpoint that fits on a 16GB or 24GB GPU.
cardTitle: >
  Qwen3.8-27B-Perplexing-Pegasus-Heretic
titleTag: >
  Qwen3.8-27B-Perplexing-Pegasus-Heretic: Unified Local Agent Model - WebBrain Blog
ogTitle: >
  Qwen3.8-27B-Perplexing-Pegasus-Heretic: Unified Local Vision + Decision Agent Model
ogDescription: >
  Apache-2.0 release across GGUF, AutoRound INT4, NVFP4/FP8, and BF16. Multimodal vision, tool calling, pplx-decider readout, MTP, and 0/8 refusal probes with 100% typed-decision agreement.
twitterTitle: >
  Qwen3.8-27B-Perplexing-Pegasus-Heretic: One 27B Model for Local Browser Agents
twitterDescription: >
  Multimodal vision, thinking, tool calling, pplx-decider typed decisions, MTP, and Heretic ARA abliteration in a single 27B checkpoint for 16GB–24GB GPUs, Intel Arc XPU, and Blackwell.
keywords:
  - Qwen3.8-27B-Perplexing-Pegasus-Heretic
  - Qwen3.8-27B
  - pplx-decider
  - Heretic ARA
  - Multi-Token Prediction
  - local LLM
  - browser agent
  - WebBrain
  - GGUF
  - AutoRound INT4
  - NVFP4
  - vLLM
  - llama.cpp
  - Intel Arc Pro B70
  - NVIDIA Blackwell
author: Emre Sokullu
authorUrl: https://emresokullu.com
---

Running autonomous browser agents locally just got a lot simpler.

When we build and test WebBrain on local LLMs, peak agent performance usually comes from pairing two or three separate models in parallel:

- A **vision-capable LLM** to see and reason over UI and browser state.
- A **fast Jev-style / typed-decision model** for structured routing and scoring.
- **Uncensored (abliterated) alignment** so real-world agent workflows don't stall on false-positive refusals.

On local hardware, juggling multiple 20B+ models at once is brutal on VRAM and latency.

So we built and released one unified model suite that replaces the multi-model stack on a single consumer GPU: **`Qwen3.8-27B-Perplexing-Pegasus-Heretic`**.

## What it packs into a single 27B checkpoint

- **Multimodal Vision + Chat + Thinking (`<think>`) + Tool Calling:** Built on **Qwen3.8-27B**, supporting screenshot understanding, reasoning traces, and native tool calls in one model.
- **Perplexity `pplx-decider` typed-decision readout:** Preserves the `decision/` head alongside an intact `lm_head` for structured routing and scoring.
- **Heretic ARA abliteration:** Achieves **0/8 benchmark refusal probes** while maintaining **100% (30/30) typed-decision agreement** against the original Pegasus model.
- **Multi-Token Prediction (MTP):** All 15 `mtp.*` tensors are preserved, with `blk.64` kept at `Q8_0` in IQ/3-bit GGUFs.
- **Single-GPU local fit:** Runs in **16GB VRAM** (`IQ3_XXS` / `Q3_K_M` + `mmproj`) or **24GB VRAM** (`Q4_K_M` + `mmproj`).

## Four hardware-ready Hugging Face repositories (Apache-2.0)

We published the full open-source release under **Apache-2.0** across four Hugging Face repositories under WebBrain:

| Format / Target | Runtime & Hardware | Repository |
| --- | --- | --- |
| **imatrix GGUF + mmproj F16** | `llama.cpp` / LM Studio (16GB–24GB GPUs) | [webbrain-one/Qwen3.8-27B-Perplexing-Pegasus-Heretic-GGUF](https://huggingface.co/webbrain-one/Qwen3.8-27B-Perplexing-Pegasus-Heretic-GGUF) |
| **AutoRound INT4** | `vLLM` (Intel Arc Pro B70 32GB XPU & NVIDIA CUDA) | [webbrain-one/Qwen3.8-27B-Perplexing-Pegasus-Heretic-AutoRound-INT4](https://huggingface.co/webbrain-one/Qwen3.8-27B-Perplexing-Pegasus-Heretic-AutoRound-INT4) |
| **NVFP4 + FP8** | `vLLM` (NVIDIA Blackwell `sm_100`/`sm_120` with MTP) | [webbrain-one/Qwen3.8-27B-Perplexing-Pegasus-Heretic-NVFP4](https://huggingface.co/webbrain-one/Qwen3.8-27B-Perplexing-Pegasus-Heretic-NVFP4) |
| **Base BF16 weights** | Full-precision reference & downstream quantization | [webbrain-one/Qwen3.8-27B-Perplexing-Pegasus-Heretic](https://huggingface.co/webbrain-one/Qwen3.8-27B-Perplexing-Pegasus-Heretic) |

## Acknowledgments

Big thanks to the **Alibaba Qwen team**, **Perplexity**, and **AveLabs (AvecdrA)** on Hugging Face for the foundational models this builds on.

If you're building WebBrain workflows or any local vision + decision agent stack, give it a spin and let us know what hardware you're running it on.

Tags: #OpenSourceAI #LocalLLM #AIAgents #WebBrain #vLLM #llamacpp #Qwen #ComputerUse #IntelArc #Blackwell
