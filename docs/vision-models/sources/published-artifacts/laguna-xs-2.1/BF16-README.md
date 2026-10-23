---
license: other
license_name: openmdw-1.1-and-kimi-modified-mit
library_name: transformers
inference: false
pipeline_tag: image-text-to-text
tags:
- multimodal
- vision-language
- laguna-xs-2.1
- moonvit
- bf16
- blackwell
base_model:
- poolside/Laguna-XS-2.1
- moonshotai/Kimi-K2.6
---

# Laguna XS 2.1 Vision (BF16)

![Laguna Vision](laguna-vision.gif)

**Laguna XS 2.1 with sight.** A vision-language development checkpoint
that connects Poolside's agentic coding model to the MoonViT vision encoder from
[Kimi-K2.6](https://huggingface.co/moonshotai/Kimi-K2.6) through a trained
PatchMerger projector.

The text backbone and vision tower remain frozen. The only newly trained
parameters are the **30,679,808-parameter projector** that merges each 2x2 group
of MoonViT patches and maps the resulting 4608-dimensional representation into
Laguna's 2048-dimensional token space.


## Why vision at DIV

At [DIV](https://www.webbrain.one), we build browser agents that need to
understand the visual state of the web—not just extracted text. Screenshots,
charts, dashboards, rich editors, and the location and appearance of controls
are part of real browser work, so vision is a practical product requirement.

In our
[American–Chinese open-model frontier benchmark](https://www.webbrain.one/blog/american-chinese-open-model-frontier-gap-benchmark),
Laguna XS 2.1 stood out as a strong model in its size class, but the upstream
checkpoint is text-only. This project adds a basic MoonViT vision bridge while
keeping both the language backbone and vision tower frozen.

> [!IMPORTANT]
> The pinned BF16 text backbone, frozen MoonViT tower, and final 100K-example
> projector are complete, packaged, and fingerprint-verified. Multimodal model
> code, processor/serving integration, and final image-inference validation are
> still pending, so this is not yet a stock ready-to-serve checkpoint.

| Component | Detail |
|---|---|
| Text backbone | Laguna XS 2.1, 33B total / 3B active MoE, 2048 hidden size — **frozen** |
| Packaged text weights | BF16 from [`poolside/Laguna-XS-2.1`](https://huggingface.co/poolside/Laguna-XS-2.1) — exact pinned copy |
| Vision tower | MoonViT-3d from [Kimi-K2.6](https://huggingface.co/moonshotai/Kimi-K2.6), 27 layers, 1152-dimensional patch features — **frozen** |
| Projector | `LayerNorm -> 2x2 merge -> Linear(4608, 4608) -> GELU -> Linear(4608, 2048)` — **trained in BF16** |
| Projector size | 30,679,808 trainable parameters |
| Training envelope | Up to 512 merged image tokens inside 2,048-token training sequences |
| Backbone context | 262,144 tokens, inherited from Laguna XS 2.1 |
| Target hardware | Blackwell; final single-RTX PRO 6000 96 GB serving recipe pending validation |

## Build status

- [x] Pin the upstream Laguna XS 2.1 BF16 revision.
- [x] Copy and fingerprint-verify all 29 backbone files (66.90 GB).
- [x] Pass backward and 2,048-token memory gates before the full run.
- [x] Cache 100,000 MoonViT training examples.
- [x] Finish the 100,000-example projector run.
- [x] Add and fingerprint-verify the frozen MoonViT tower and final projector.
- [ ] Assemble multimodal configuration, processor, and serving integration.
- [ ] Pass final single-GPU loading, image inference, and regression gates.

## Included vision artifacts

| File | Contents | Size | SHA-256 |
|---|---|---:|---|
| `vision_tower.safetensors` | Frozen MoonViT-3d tower, 329 tensors, all BF16 | 833,765,768 bytes | `befe801bd7dfe8bf5630fef56a7f53c2235065599ca9eea4d995040e2e6fd183` |
| `mm_projector.safetensors` | Final step-782 PatchMerger projector, 6 tensors, all BF16 | 61,360,104 bytes | `7837384f18be69a4f875ca44a8ed69ec186501d70896daf4b305fa77547974de` |

Machine-readable provenance is in
[`VISION_ADAPTER_MANIFEST.json`](VISION_ADAPTER_MANIFEST.json).

## Provenance

The packaged text backbone is copied from
[`poolside/Laguna-XS-2.1`](https://huggingface.co/poolside/Laguna-XS-2.1) at immutable revision
[`e9df9a59996d790b94b70f3fef343fe1d9e34bdf`](https://huggingface.co/poolside/Laguna-XS-2.1/commit/e9df9a59996d790b94b70f3fef343fe1d9e34bdf).
Every copied file was checked against its upstream Git blob or LFS SHA-256
fingerprint, then independently rechecked after upload.

Projector training used the frozen BF16 Laguna XS 2.1 backbone and frozen
MoonViT-3d features. This repository now pairs the final trained projector and
frozen tower with the verified BF16 backbone above. End-to-end behavior will be
validated after the remaining multimodal integration is assembled.

## Usage

A serving command is intentionally not published yet. The current repository
contains the complete text backbone, frozen vision tower, and final projector,
but not the multimodal processor and serving assembly that connects them. A
tested quickstart will be added after integration passes the final gates.

## Method credit

The overall construction and model-card approach was inspired by
[Baseten's GLM-5.2-Vision-NVFP4](https://huggingface.co/baseten/GLM-5.2-Vision-NVFP4):
keep the text backbone and MoonViT tower frozen, train a compact PatchMerger
projector between them, and publish the provenance and hardware constraints
explicitly. Credit to the Baseten team for demonstrating this practical recipe.
This repository does not reuse Baseten model weights, benchmark results, or
deployment artifacts.

## License

The redistributed Laguna XS 2.1 BF16 backbone remains subject to the included
[OpenMDW-1.1 license](./LICENSE.md) and Poolside's source notices. The included
MoonViT tower remains subject to the included
[Kimi-K2.6 Modified MIT terms](./LICENSE_KIMI_K2.6). The newly trained projector
is documented in the manifest above. Downstream users remain responsible for
complying with both upstream licenses.

## Acknowledgements

Built on [Poolside's Laguna XS 2.1 BF16](https://huggingface.co/poolside/Laguna-XS-2.1)
and [Moonshot AI's Kimi-K2.6](https://huggingface.co/moonshotai/Kimi-K2.6), with
the vision-attachment method inspired by
[Baseten's GLM-5.2-Vision-NVFP4](https://huggingface.co/baseten/GLM-5.2-Vision-NVFP4).
These teams were not involved in this development checkpoint; please do
not direct issues with this repository to them.

## Want this model on your inference provider?

Ask your inference provider—such as OpenRouter or another OpenAI-compatible
managed service—to deploy this exact repository with its multimodal processor
and serving plugin. Deploying only the upstream text backbone will not enable
image input.

## Experimental status, roadmap, and get involved

> [!WARNING]
> **Experimental vision package.** The MoonViT adapter and its serving package
> are experimental. Live end-to-end validation of the **NVFP4** package on an
> RTX 5090 is still provisioning: the pinned SGLang container image is being
> fetched, so neither the text nor image smoke test has passed yet. Fine-grained
> OCR, small-object and control identification, GUI grounding, and hallucination
> calibration remain limited. The roadmap is to expand and diversify the
> training data, add more high-resolution OCR and UI examples, and pursue
> broader parameter-efficient tuning if community interest warrants the
> investment. To contribute evaluation or training data, sponsor compute,
> or explore a design partnership, use the [community interest
> form](https://forms.gle/bNoeJ6cvLYQ4VgKd7). Do not use this package as
> the sole decision source for safety-critical automation.
