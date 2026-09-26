# Compass Tiny XS v3 WebGPU integration validation

Validated on 2026-09-26 in the `webbrain-one` worktree. Tiny v2.1 remains the
default; XS is an opt-in private, noncommercial research preview in both
Settings → Providers → WebGPU and Apocalypse Mode → Text Model.

## Tested package and runtime

- Repository: `webbrain-one/webbrain-compass-tiny-xs-v3-onnx` (private).
- Revision: `67a2d019a1a713753b692826767269384e9e9b10`.
- Spark-X2.5-1.7B fine-tune; native FP16 storage / FP32 GEMM graph, not q4f16.
- Bundled ONNX Runtime Web 1.27.0 and Transformers.js 4.2.0 tokenizer; native
  Jinja template, thinking disabled, greedy decoding, no helper/cloud fallback.
- Windows, Chromium 147.0.7727.15, NVIDIA RTX 5090 / Blackwell with `shader-f16`.
  The harness explicitly selected GPU0; it did not load the model on GPU1/T400.
- Total context 4,096 tokens; output at most 2,048 tokens. All seven model data
  files have fixed byte lengths and SHA-256 hashes in `spark-runtime.js`.

## Reproduce

Run `npm run test:spark-webgpu` for the CPU unit checks. For the opt-in real GPU
smoke, point `SPARK_WEBGPU_TEST_BUNDLE` at the original verified ONNX bundle
containing tokenizer/template/ABI files and `onnx/model_fp16.onnx` plus its
external data file, then run `npm run test:spark-webgpu:browser`.

On multi-GPU Windows hosts, set `SPARK_WEBGPU_TEST_ADAPTER_LUID` to the intended
adapter's DXGI `high,low` pair before running. The current harness requires an
RTX 5090/Blackwell adapter and fails before model loading on another adapter.
It uses an isolated temporary Chromium extension profile and about 4 GB of
temporary disk cache, deletes only that profile afterward, and leaves user
browsers and model servers untouched.

The browser harness supplies local pinned bytes through the production
streaming size/hash verifier. It then runs real inference through the
background → offscreen worker → native WebGPU graph path without any token or
HF access. This is **not** an end-to-end live private-HF authentication test.
HTTP 401 handling, download-only credential forwarding, corruption and
truncation rejection are covered separately by unit tests.

## Results

- All 9 focused unit tests passed.
- Real extension cache verification, offline readiness and native graph loading
  passed. Synthetic greeting output: `Hello! How can I help?`.
- The original package's native `open_url` probe emitted the native Spark
  `<tool_call>` format and passed WebBrain's existing allowlisted parser with
  URL `https://example.com`. No actual browser action was dispatched.
- Settings stored XS with 4K context and a 2,048-token output cap. Apocalypse
  hydrated that selection and switched XS ↔ Tiny v2.1 without changing the
  active chat provider. Tiny v2.1 remained the install default.
- Stop/remove released the XS runtime and deleted its cache; an unrelated
  Tiny v2.1 cache sentinel remained intact. The temporary profile was removed.
- Provider-limit checks passed. Security checks passed (60/60); unpacked build
  checks passed (4/4).
- Main regression runner: 2,393 passed, 6 failed. The failures concern licensing
  metadata/FAQ consistency, chat-history whitespace, subscribe-error DOM
  clearing, streamed tool-text suppression, watch-alert audio, and terminal
  scheduled clarification rendering. Those source areas were not changed by
  this integration; the full suite is not green. The aggregate `npm test` also
  encountered a SystemOne Jev-trace fixture import failure on this Windows host.

## Limits retained, not repaired

A synthetic arithmetic fixture answered `7` as plain text rather than using
the requested `done` tool. The BF16 reference produced the same observed
plain-text answer. The output was retained without repair; a successful native
tool smoke does not imply universal instruction following or agent success.
This run does not establish support for other GPUs, long real-world tasks,
commercial use, or comparative model superiority. It does not replace the
separate package numerical-validation record or the published BF16 benchmark.
