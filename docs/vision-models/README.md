# DeepSeek V4 Flash Vision and Laguna XS 2.1 Vision

This directory is the reproducibility record for two DIV experiments that add a
frozen MoonViT image tower and a trained patch-merger projector to frozen mixture-of-experts
language models.

The record was assembled on 2026-08-04. It distinguishes observed results from planned
experiments and pins every published model repository to the commit that was inspected.
It is a technical report, not a peer-reviewed paper or a claim of benchmark parity with an
upstream multimodal model.

## Document map

- [Research report](research-paper.md): motivation, method, measured results, comparative
  analysis, limitations, and conclusions.
- [Reproducibility runbook](reproducibility.md): exact revisions, commands, checkpoint
  policy, verification gates, publication layout, and recovery notes.
- [Source appendix](sources/README.md): a curated code snapshot, archived run metadata,
  published model cards/manifests, and checksum instructions. No model weights or dataset
  images are duplicated in this Git repository.

## Final model repositories

| Model package | Role | Inspected revision |
|---|---|---|
| [DeepSeek V4 Flash Vision NVFP4](https://huggingface.co/webbrain-one/DeepSeek-V4-Flash-Vision-NVFP4) | Complete pinned NVFP4 text package plus MoonViT tower, projector, and custom SGLang source | [`12b653e63329ac3c20395f9aeeb1bb8264d2db8b`](https://huggingface.co/webbrain-one/DeepSeek-V4-Flash-Vision-NVFP4/commit/12b653e63329ac3c20395f9aeeb1bb8264d2db8b) |
| [DeepSeek V4 Flash Vision BF16](https://huggingface.co/webbrain-one/DeepSeek-V4-Flash-Vision-BF16) | BF16 vision source overlay; deliberately not a full 291B BF16 text checkpoint | [`60c441aa1c7386387c89ddaff703136395ad8d8b`](https://huggingface.co/webbrain-one/DeepSeek-V4-Flash-Vision-BF16/commit/60c441aa1c7386387c89ddaff703136395ad8d8b) |
| [DeepSeek V4 Flash Vision Training Archive](https://huggingface.co/webbrain-one/DeepSeek-V4-Flash-Vision-Training-Archive) | Private bring-up, calibration, recovery, and code archive; it predates the completed 100K run | Private, mutable access-controlled repository |
| [Laguna XS 2.1 Vision NVFP4](https://huggingface.co/webbrain-one/Laguna-XS-2.1-Vision-NVFP4) | Complete pinned NVFP4 text package plus MoonViT tower and projector | [`ce108f0f3764a18a1f5f7d14ecefa90485ea6e52`](https://huggingface.co/webbrain-one/Laguna-XS-2.1-Vision-NVFP4/commit/ce108f0f3764a18a1f5f7d14ecefa90485ea6e52) |
| [Laguna XS 2.1 Vision BF16](https://huggingface.co/webbrain-one/Laguna-XS-2.1-Vision-BF16) | Complete pinned BF16 text package plus MoonViT tower and projector | [`b06063d00b73f7713ef1c28f8247eed488c73faf`](https://huggingface.co/webbrain-one/Laguna-XS-2.1-Vision-BF16/commit/b06063d00b73f7713ef1c28f8247eed488c73faf) |
| [Laguna XS 2.1 Vision Projector 100K](https://huggingface.co/webbrain-one/Laguna-XS-2.1-Vision-Projector-100K) | Private full projector/optimizer checkpoint history and run evidence | [`4f5d6359867fa55315a2bec4b568901bfdeca5e5`](https://huggingface.co/webbrain-one/Laguna-XS-2.1-Vision-Projector-100K/commit/4f5d6359867fa55315a2bec4b568901bfdeca5e5) |

## What is complete

- Both final projectors were trained on 100,000 examples for one epoch and published with
  their frozen BF16 MoonViT towers.
- The DeepSeek adapter preserves the discrete token IDs required by DeepSeek V4's
  hash-routed experts while separately injecting projected image embeddings.
- DeepSeek's pinned SGLang/Blackwell profile passed full NVFP4 loading and two consecutive
  end-to-end image requests on NVIDIA B200 with four-way tensor parallelism.
- The Laguna private archive retains the full 782-step projector and optimizer checkpoint
  history, its training log, final state, hashes, and two code snapshots.
- Public NVFP4 and BF16 package layouts, source model revisions, component sizes, and
  component SHA-256 values are recorded in the runbook and artifact manifest.

## What remains incomplete

- No controlled MoonViT-versus-Qwen tower A/B result was completed. The Qwen arm in the
  source tree is an experimental plan, not a reported result.
- No standard vision benchmark suite is archived for either final package, so this report
  does not make quality claims beyond finite training, loss behavior, component integrity,
  and the explicitly listed inference gates.
- Laguna's main BF16 and NVFP4 revisions are not end-to-end image endpoints. An unvalidated
  integration candidate exists only on the NVFP4 `sglang-integration` branch at
  `740a6ccc05441a7ea0426c1d2536d5cd031adb86`; no loader or image smoke result is recorded.
- DeepSeek's custom SGLang package still requires its pinned source patch and is not
  stock-SGLang compatible. The B200 result is a bounded functional smoke test, not
  text-only parity, a broad quality benchmark, or production validation.
- The DeepSeek private archive does not contain a complete final 100K checkpoint history;
  the public final projector is reproducible as an artifact, but the full run telemetry is
  not as complete as Laguna's.

## Reproduction rule

Use commit-pinned URLs and verify hashes before loading any component. A mutable model page
URL is included for convenience, but the commit URL and SHA-256 are the reproducibility
identity. Never infer serving readiness from the presence of model weights alone.
