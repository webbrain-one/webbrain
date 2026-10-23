---
license: mit
library_name: transformers
inference: false
pipeline_tag: image-text-to-text
tags:
- multimodal
- vision-language
- deepseek-v4
- moonvit
- nvfp4
- blackwell
base_model:
- nvidia/DeepSeek-V4-Flash-NVFP4
- moonshotai/Kimi-K2.6
---

# DeepSeek V4 Flash Vision (NVFP4)

![deepseek-v4-vision](deepseek-vision-improved.gif)

**DeepSeek V4 Flash with sight.** A vision-language development
checkpoint that connects DeepSeek's reasoning and agentic model to the MoonViT
vision encoder from
[Kimi-K2.6](https://huggingface.co/moonshotai/Kimi-K2.6) through a trained,
routing-aware PatchMerger projector.

The text backbone and vision tower remain frozen. The only newly trained
parameters are the **40,119,040-parameter projector** that merges each 2x2 group
of MoonViT patches and maps the resulting 4608-dimensional representation into
DeepSeek's 4096-dimensional token space. Original text routing IDs are preserved;
image positions receive deterministic routing IDs from a fixed 64-ID palette.

## Why vision at DIV

At [DIV](https://www.webbrain.one), we build browser agents that need to
understand the visual state of the web—not just extracted text. Screenshots,
charts, dashboards, rich editors, and the location and appearance of controls
are part of real browser work, so vision is a practical product requirement.

In our
[American–Chinese open-model frontier benchmark](https://www.webbrain.one/blog/american-chinese-open-model-frontier-gap-benchmark),
DeepSeek V4 Flash stood out as a very strong model and the cheapest to run in its class, but the upstream
checkpoint is text-only. This project adds a basic MoonViT vision bridge while
keeping both the language backbone and vision tower frozen.

> [!IMPORTANT]
> The pinned NVFP4 text backbone, frozen MoonViT tower, and trained
> 100K-example projector are complete and verified. Reference BF16 multimodal
> inference has passed end-to-end and KV-cache parity checks. The repository now
> includes a custom, commit-pinned SGLang processor, routing bridge, source patch,
> and B200 launch recipe. The pinned B200 runtime has passed full NVFP4 loading
> and server startup plus two live image-generation smoke tests. Broader text-only
> parity and production validation are still required.
> This is not a drop-in checkpoint for a stock text-only server.

| Component | Detail |
|---|---|
| Text backbone | DeepSeek V4 Flash, 284B total / 13B active MoE, 4096 hidden size — **frozen** |
| Packaged text weights | NVFP4 from [nvidia/DeepSeek-V4-Flash-NVFP4](https://huggingface.co/nvidia/DeepSeek-V4-Flash-NVFP4) — exact pinned copy |
| Vision tower | MoonViT-3d from [Kimi-K2.6](https://huggingface.co/moonshotai/Kimi-K2.6), 416,866,032 parameters, 1152-dimensional patch features — **frozen** |
| Projector | <code>LayerNorm -> 2x2 merge -> Linear(4608, 4608) -> GELU -> Linear(4608, 4096)</code> — **trained in BF16** |
| Projector size | 40,119,040 trainable parameters |
| Routing bridge | Text routing IDs preserved; image positions cycle through a deterministic 64-ID expert palette |
| Training envelope | Up to 512 merged image tokens inside 2,048-token training sequences |
| Backbone context | 1,048,576 tokens, inherited from DeepSeek V4 Flash |
| Target hardware | NVIDIA B200, 4-way tensor parallel for the verified smoke profile |

## Build status

- [x] Pin the upstream NVIDIA DeepSeek V4 Flash NVFP4 revision.
- [x] Copy and fingerprint-verify all 54 backbone files (168.30 GB).
- [x] Extract and validate the frozen MoonViT component.
- [x] Pass real BF16 H200 forward/backward, overfit, and production-mix calibration gates.
- [x] Materialize and cache the 100,000-example MoonViT training set.
- [x] Finish the 100,000-example MoonViT projector run.
- [x] Add and fingerprint-verify the frozen MoonViT tower and final projector checkpoint.
- [x] Pass reference BF16 image inference and KV-cache/full-prefix token parity.
- [x] Assemble multimodal configuration, processor, routing bridge, and serving integration.
- [x] Pass pinned B200 NVFP4 shard loading and server-startup gates.
- [x] Pass two live image-response smoke tests on the pinned B200 runtime.
- [ ] Complete text-only parity and broader production validation.

## Provenance

The packaged text backbone is copied from
[nvidia/DeepSeek-V4-Flash-NVFP4](https://huggingface.co/nvidia/DeepSeek-V4-Flash-NVFP4)
at immutable revision
[e3cd60e7de98e9867116860d522499a728de1cf9](https://huggingface.co/nvidia/DeepSeek-V4-Flash-NVFP4/commit/e3cd60e7de98e9867116860d522499a728de1cf9).
All 54 copied files were checked against their upstream Git blob or LFS SHA-256
fingerprints after upload.

Projector training uses a frozen BF16 reconstruction of DeepSeek V4 Flash because
the released inference quantization kernels do not provide the input-gradient
path needed to train through a frozen language model. MoonViT is pinned to
Kimi-K2.6 revision
[7eb5002f6aadc958aed6a9177b7ed26bb94011bb](https://huggingface.co/moonshotai/Kimi-K2.6/commit/7eb5002f6aadc958aed6a9177b7ed26bb94011bb).
This package pairs the trained projector with the verified NVIDIA NVFP4
backbone above. Reference BF16 parity and live B200 image generation have been
validated; broader text-only parity and production behavior are not claimed.

## Usage

Stock text-only engines do not know how to combine these artifacts. Use the
custom, version-pinned SGLang package and wrapper in
[`docs/SGLANG_DEPLOYMENT.md`](docs/SGLANG_DEPLOYMENT.md). The B200 startup
profile is selected explicitly and keeps the first correctness run conservative:

```bash
export DEEPSEEK_VISION_MODEL_PATH=/models/deepseek-v4-flash-vision
export DEEPSEEK_VISION_PYTHONPATH="$DEEPSEEK_VISION_MODEL_PATH/sglang_ext"
export DEEPSEEK_VISION_KERNEL_PROFILE=blackwell-native
export DEEPSEEK_VISION_TP=4
scripts/launch_sglang_moonvit.sh
```

The wrapper uses the native `flashinfer_trtllm` dense backend and
`flashinfer_trtllm_routed` MoE backend on the documented B200 image. Two live
image-response smoke tests passed on this profile; do not treat that bounded
smoke result as production validation.

## Method credit

The overall construction and model-card approach was inspired by
[Baseten's GLM-5.2-Vision-NVFP4](https://huggingface.co/baseten/GLM-5.2-Vision-NVFP4):
keep the text backbone and MoonViT tower frozen, train a compact PatchMerger
projector between them, and publish provenance and hardware constraints
explicitly. Credit to the Baseten team for demonstrating this practical recipe.

This project adds a DeepSeek-specific routing bridge so mixed text/image
embeddings preserve hash-routed text behavior. It does not reuse Baseten model
weights, benchmark results, or deployment artifacts.

## License

The redistributed DeepSeek V4 Flash NVFP4 backbone remains subject to the
included [MIT license](./LICENSE) and upstream notices. MoonViT assets added
later will remain subject to the Kimi-K2.6 Modified MIT terms. Newly trained
projector artifacts will be documented with their applicable terms when
uploaded.

## Acknowledgements

Built on
[DeepSeek AI's DeepSeek V4 Flash](https://huggingface.co/deepseek-ai/DeepSeek-V4-Flash),
[NVIDIA's NVFP4 checkpoint](https://huggingface.co/nvidia/DeepSeek-V4-Flash-NVFP4),
and [Moonshot AI's Kimi-K2.6](https://huggingface.co/moonshotai/Kimi-K2.6),
with the vision-attachment method inspired by
[Baseten's GLM-5.2-Vision-NVFP4](https://huggingface.co/baseten/GLM-5.2-Vision-NVFP4).
These teams were not involved in this experimental development checkpoint; please do
not direct issues with this repository to them.

## Want this model on your inference provider?

Ask your inference provider—such as OpenRouter or another OpenAI-compatible
managed service—to deploy this exact repository with its multimodal processor
and serving plugin. Deploying only the upstream text backbone will not enable
image input.

## Experimental status, roadmap, and get involved

> [!CAUTION]
> **Experimental vision adapter.** This is a working experimental adapter with
> basic end-to-end SGLang image generation verified on NVIDIA B200. That bounded
> smoke test is not a broad quality benchmark: fine-grained OCR, small-object or
> control identification, GUI grounding, and hallucination calibration remain
> limited. If community interest warrants further investment, the roadmap is
> larger and more diverse datasets, higher-resolution OCR/UI examples, and
> broader parameter-efficient tuning. Do not use this model as the sole decision
> source for safety-critical automation. Interested in contributing evaluation
> or training data, sponsoring compute, or working with us as a design partner?
> [Tell us here](https://forms.gle/bNoeJ6cvLYQ4VgKd7).
