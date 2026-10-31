---
title: >
  WebBrain Compass VLD v6 2B: State-of-the-Art Browser Vision and Agent Routing on Consumer Hardware
slug: webbrain-compass-vld-v6-2b
sortOrder: -460
date: 2026-10-31
readTime: 8 min read
description: >
  Comprehensive evaluation of WebBrain Compass VLD v6 2B across WebBrain's frozen 100-case browser viewport vision suite and compact agent tool routing benchmark locally on NVIDIA RTX 5060 Ti hardware.
excerpt: >
  WebBrain Compass VLD v6 2B sets a new all-time state-of-the-art on WebBrain's browser vision benchmark with 66/100 strict passes and a 90.2% rubric score, alongside #1 compact tool routing at 42.7% loose match with zero anti-patterns.
titleTag: >
  WebBrain Compass VLD v6 2B: Benchmark & Release - WebBrain Blog
ogTitle: >
  WebBrain Compass VLD v6 2B: SOTA Vision & Agent Routing
ogDescription: >
  WebBrain's new 2B browser specialist achieves 66/100 strict vision passes and 42.7% compact routing accuracy locally on NVIDIA RTX 5060 Ti.
twitterTitle: >
  WebBrain Compass VLD v6 2B: SOTA Browser Vision & Routing
twitterDescription: >
  A 2B specialist outperforming 4B models in browser comprehension: 66/100 strict vision passes and 90.2% mean rubric score on consumer GPUs.
keywords:
  - WebBrain Compass
  - LFM3-VLD
  - Liquid AI
  - browser vision
  - vision benchmark
  - tool routing
  - agent benchmark
  - NVIDIA RTX 5060 Ti
  - llama.cpp
  - WebBrain
  - multimodal
  - on-device AI
author: Emre Sokullu
authorUrl: https://emresokullu.com
lede: >
  **A specialized 2B multimodal model can surpass general-purpose 4B architectures when fine-tuned on real browser environments.** In our comprehensive dual-benchmark evaluation, the newly trained [WebBrain Compass VLD v6 2B](https://huggingface.co/webbrain-one/webbrain-compass-vld-v6-2b) established a new state-of-the-art on WebBrain's frozen 100-case browser viewport vision suite with **66 strict passes out of 100** and a **90.2% mean rubric score** at 1.87-second latency on a single NVIDIA GeForce RTX 5060 Ti GPU. Simultaneously, in the multi-turn compact agent tool routing benchmark, it achieved an all-time high **38/89 (42.7%) loose tool-family match rate with zero anti-pattern regressions**.
---

## Why a dedicated browser vision-language decision model?

General-purpose vision-language models frequently falter when placed in autonomous browser automation loops. They either invent freeform formatting that breaks brittle agent contracts, hallucinate obscured form fields, or miss subtle validation states like red input borders and transient toast banners.

**WebBrain Compass VLD v6 2B** is designed specifically to resolve this mismatch. Built upon Liquid AI's LFM3 architecture and fine-tuned across **70,717 reviewed browser interaction trajectories**, Compass VLD v6 couples multimodal perception with structured decision-making:

1. **Strict 6-Section Screen Parsing**: Directly outputs standardized viewport analyses (`Page purpose`, `Visible text`, `Inputs`, `Interactive elements`, `Active modals`, and `Blockers`) matching WebBrain's production vision contract with 99.0% compliance.
2. **Native Tool Routing**: Emits verified browser tool calls (`navigate`, `get_accessibility_tree`, `read_page`, `inspect_viewport`, `click_ax`) without hallucinating invalid arguments.
3. **Hardened Adversarial Defense**: Trained on counter-polarity and prompt injection probes to reject untrusted DOM instructions without dropping valid user intents.

Below are the audited results across both WebBrain's 100-case browser vision suite and our frozen Compact agent routing benchmark.

---

## 1. Browser viewport vision suite (100 frozen cases)

We evaluated the native BF16 GGUF checkpoint (`webbrain-compass-vld-v6-2b-BF16.gguf` paired with `mmproj-webbrain-compass-vld-v6-2b-F16.gguf`) using `llama-server` on an NVIDIA GeForce RTX 5060 Ti GPU.

Every model in this comparison was tested on the identical frozen 100 browser screenshots—ranging from simple authentication forms to complex Kanban boards, non-Latin checkouts, and high-contrast occlusion cases—under WebBrain's production system prompt and deterministic regex rubric.

| Model | Parameter class | Artifact size / precision | Strict passes / 100 | Mean rubric | Latency | Execution platform |
| --- | ---: | --- | ---: | ---: | ---: | --- |
| **WebBrain Compass VLD v6 2B** | **2B** | **3.46 GB (BF16)** | **66 / 100** | **90.2%** | **1.87s** | **GGUF (RTX 5060 Ti)** |
| **[Qwen 3.5 4B](https://huggingface.co/Qwen/Qwen3.5-4B)** | 4B | 3.06 GB (Q4) | 55 / 100 | 83.4% | 25.92s | MLX 4-bit |
| **[WebBrain VL 2 450M](https://huggingface.co/webbrain-one/webbrain-vl-2-450M)** | 453M | 0.81 GB (INT8) | 44 / 100 | 76.2% | 2.00s | ONNX / WebGPU |
| **[Gemma 4 E4B IT](https://huggingface.co/google/gemma-4-E4B-it)** | E4B | 6.86 GB (Q4) | 41 / 100 | 81.3% | 5.96s | MLX 4-bit |
| **[Qwen 3.5 2B](https://huggingface.co/Qwen/Qwen3.5-2B)** | 2B | 1.75 GB (Q4) | 39 / 100 | 79.1% | 10.01s | MLX 4-bit |
| **[MiniCPM-V 4.7 1B](https://huggingface.co/openbmb/MiniCPM-V-4.7-1B-gguf)** *(semantic)* | 1B | 0.64 GB (Q4) | 37 / 100 | 68.2% | 1.30s | GGUF (RTX 5060 Ti) |
| **[WebBrain VL 3 450M](https://huggingface.co/webbrain-one/webbrain-vl-3-450M)** | 453M | 0.91 GB (BF16) | 26 / 100 | 69.3% | 3.58s | PyTorch |
| **[Qwen 3.5 0.8B](https://huggingface.co/Qwen/Qwen3.5-0.8B)** | 0.8B | 0.58 GB (Q4) | 20 / 100 | 41.6% | 7.35s | GGUF |
| **[LFM2.5-VL-1.6B](https://huggingface.co/LiquidAI/LFM2.5-VL-1.6B)** | 1.6B | 1.80 GB (Q4) | 12 / 100 | 44.4% | 0.81s | MLX |
| **[LFM3-VLD-2B](https://huggingface.co/webbrain-one/lfm3-vld-2b)** *(base)* | 2B | 1.25 GB (Q4) | 4 / 100 | 44.7% | 2.20s | GGUF (RTX 5060 Ti) |

### Performance analysis: a generational leap over the base model

Compass VLD v6 2B moves from **4 to 66 strict passes** (+62 passes) and from **44.7% to 90.2% mean rubric score** (+45.5 percentage points) compared to the unadapted LFM3-VLD baseline:

- **100% pass rates across critical UI patterns**: 
  - Kanban Board (5/5, 100.0% score)
  - Toast Notifications (5/5, 100.0% score)
  - Search Results (5/5, 98.3% score)
  - Data Tables (5/5, 94.3% score)
  - Consent Banners (5/5, 94.0% score)
- **High scores on dense layouts**:
  - Photo Understanding (4/5, 95.6% score)
  - Checkout & Payment Forms (4/5, 95.1% score)
  - Analytics Dashboards (4/5, 95.0% score)
  - Chart Reading (4/5, 95.0% score)
- **Difficulty tier breakdown**:
  - **Easy (001–020)**: 14/20 passes (70.0%), 90.7% mean score, 1.64s latency
  - **Basic (021–040)**: 16/20 passes (80.0%), 92.3% mean score, 1.83s latency
  - **Intermediate (041–060)**: 15/20 passes (75.0%), 94.2% mean score, 1.90s latency
  - **Advanced (061–080)**: 10/20 passes (50.0%), 84.2% mean score, 2.00s latency
  - **Challenging (081–100)**: 11/20 passes (55.0%), 89.7% mean score, 1.96s latency

Crucially, Compass VLD v6 achieved **0 errors** across all 100 screenshots while executing in **1.87 seconds** on average—over 13 times faster than Qwen 3.5 4B (25.92s) while scoring 11 more strict passes.

---

## 2. Compact tool routing benchmark (100 first-turn & 89 multi-turn scenarios)

In addition to visual perception, browser agents require precise action selection. We evaluated Compass VLD v6 on WebBrain's frozen Compact agent suite, comprising 100 first-turn queries and 100 multi-turn scenarios (89 scored compact cases with 11 dev scenarios excluded).

| Model | Parameters | First-turn structured calls (/100) | Strict exact action (/89) | Loose tool-family match (/89) | Loose match rate | Anti-patterns (/89) | Output truncations |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| **WebBrain Compass VLD v6 2B** | **2B** | **93** | **7** | **38** | **42.7%** | **0** | **0** |
| **webbrain-compass-vld-tiny-v5** | 1B | 97 | 7 | 32 | 36.0% | 8 | 0 |
| **lfm3-vld-2b** | 2B | 87 | 1 | 32 | 36.0% | 2 | 6 |
| **Spark-X2.6-4B** | 4B | 100 | 11 | 29 | 32.6% | 2 | 0 |
| **MiniCPM-V-4.7-1B** | 1B | 97 | 2 | 27 | 30.3% | 4 | 0 |
| **LFM3-1.7B** | 1.7B | 100 | 10 | 19 | 21.3% | 1 | 0 |

### Routing highlights

1. **Top Loose Routing Accuracy (42.7%)**: Compass VLD v6 matched the reference tool family in 38 out of 89 scenarios, surpassing previous leaders `tiny-v5` (32/89) and Spark-X2.6-4B (29/89).
2. **Zero Anti-Patterns**: Many compact models exhibit regressions such as looping on bad URLs, repeatedly fetching expired trees, or misrouting error pivots. Compass VLD v6 achieved **0 anti-patterns**, down from 8 in v5 and 2 in base LFM3-VLD.
3. **Hardened Prompt Injection Defense**:
   - Protected prompt injection scenarios: **6/8 ideal/ideal_name (75%)**
   - Injection control scenarios: **2/2 ideal (100%)**
   - Unprotected injection scenarios: **6/8 ideal/ideal_name (75%)**
   - Unprotected control: **2/2 ideal (100%)**
4. **First-Turn Tool Call Distribution**: Across the 100 first-turn prompts, the model made 41 `get_accessibility_tree`, 31 `navigate`, 9 `inspect_viewport`, 8 `read_page`, 2 `extract_data`, 1 `fetch_url`, 1 `get_window_info`, and 7 direct textual responses (for purely conversational inquiries).

---

## 3. Hardware footprint and efficiency on NVIDIA RTX 5060 Ti

Testing was performed on consumer-grade desktop hardware running native `llama-server` compiled with CUDA support:

- **Model format**: Unquantized BF16 weights (`webbrain-compass-vld-v6-2b-BF16.gguf`, 3.46 GB)
- **Projector format**: F16 multimodal vision projector (`mmproj-webbrain-compass-vld-v6-2b-F16.gguf`, 379 MB)
- **VRAM consumption**: ~3.8 GB VRAM with full 99-layer GPU offload
- **Inference speed**:
  - Prompt evaluation: **3,650 tokens/sec** (~0.27 ms/token)
  - Text generation: **99.85 – 128 tokens/sec** (~8–10 ms/token)
  - End-to-end screenshot observation: **1.87 seconds**
  - Tool routing latency: **863 ms** (first-turn) / **906 ms** (multi-turn scenarios)

Because the entire model and KV cache occupy under 4 GB of VRAM, WebBrain Compass VLD v6 2B can easily co-exist with a local embedding model, an in-memory browser tab, or background automation workers on an 8 GB or 16 GB consumer card.

---

## Availability and download links

WebBrain Compass VLD v6 2B is released openly under the Apache 2.0 license:

- **Merged PyTorch Model (BF16)**: [webbrain-one/webbrain-compass-vld-v6-2b](https://huggingface.co/webbrain-one/webbrain-compass-vld-v6-2b)
- **GGUF Quantizations (BF16, Q8_0, Q4_K_M, mmproj)**: [webbrain-one/webbrain-compass-vld-v6-2b-gguf](https://huggingface.co/webbrain-one/webbrain-compass-vld-v6-2b-gguf)
- **ONNX WebGPU Bundle & JS Probes**: [webbrain-one/webbrain-compass-vld-v6-2b-onnx](https://huggingface.co/webbrain-one/webbrain-compass-vld-v6-2b-onnx)
- **Model Collection**: [WebBrain Compass VLD v6 Collection](https://huggingface.co/collections/webbrain-one/webbrain-compass-vld-v6-2b-6ae5de0980732cb99b006957)

With 66/100 strict vision passes, 90.2% rubric adherence, and 42.7% compact routing accuracy at sub-2-second local latency, Compass VLD v6 2B represents our most capable and reliable on-device browser agent model to date.
