# Vendored Transformers.js WebGPU runtime

This directory packages the JavaScript and WASM runtime used by two local
WebGPU paths in Chrome and by offline RAG's CPU/WASM semantic reranker:

- **Apocalypse Mode / Settings -> local WebGPU chat** offers Compass VLD
  v6 2B (`webbrain-one/webbrain-compass-vld-v6-2b-onnx`, ~2.4 GB, the
  default), Compass VLD Tiny v5
  (`webbrain-one/webbrain-compass-vld-tiny-v5-onnx`, ~2.2 GB, the previous
  default), Compass Tiny v2.1 (`webbrain-one/webbrain-compass-tiny-v2.1`,
  ~1.87 GB) and Ternary Bonsai 2 2B / 4B in text and vision variants, used by
  the standalone-chat nuclear control and selectable as a normal chat provider. The underlying runtime also supports
  LFM2.5 and Nanbeige exports. An opt-in Bonsai 27B preset uses a separate
  vendored bitgpu worker, not this Transformers.js runtime; see
  `src/chrome/vendor/bitgpu/README.webbrain.md`.
- **Providers -> Vision -> LFM2.5-VL local fallback** runs
  `LiquidAI/LFM2.5-VL-450M-ONNX` as the dedicated screenshot sidecar.
- **Apocalypse Mode -> Offline RAG** runs the explicitly downloaded, pinned
  `Xenova/multilingual-e5-small` q8 model in a separate CPU/WASM worker. Model
  weights remain optional and are never bundled or downloaded by a question.

Model weights are not bundled. Explicit download controls fetch the selected
WebGPU model and store it in the browser cache; inference only uses cached
models. The default preset is Compass VLD v6 2B (~2.4 GB), with underlying runtime support for LFM2.5
(2.6B, 1.2B Instruct, 1.2B Thinking, VL 1.6B, VL 3B) and Nanbeige4.2-3B.
The selected preset is available through the nuclear control in standalone chat
and can also be configured, downloaded, and selected directly in Settings ->
Providers -> WebGPU. Reasoning presets supported by the runtime keep completed
thinking out of visible answers. Current LFM2.5-VL layouts use:

- `embed_tokens`: FP16
- `vision_encoder`: FP16
- `decoder_model_merged`: Q4

Ternary Bonsai 2 uses Q2/FP16 language graphs, the existing Qwen3.5 hybrid
attention runtime, and (for the Vision presets) an FP16 vision encoder. Its
reproducible export is in `scripts/models/bonsai/`. Danyalmalik's 2B/4B split ports
omit tokenizer and generation sidecars; the worker seeds the licensed, packaged
Qwen3.5 metadata from `vendor/bonsai2/` for those exact repositories. It also
corrects their external-data declarations, chat stop tokens, and Q2 cache
precision. The 4B text preset uses Mike0021's
single causal graph with its own complete metadata. The Vision presets use
`webbrain-one/Ternary-Bonsai-2-{2B,4B}-ONNX-WebGPU-Vision`, the Qwen processor's
text-first image API, and a bounded image resolution.

The Vision presets prefill long prompts in 512-token slices that carry the
recurrent, convolution and KV cache, then let `generate()` continue from that
cache. A single pass over a multi-thousand-token prompt can occupy a GPU shared
with the display (Apple silicon, a display-attached card) for seconds; slices
bound each pass at the cost of roughly one extra decoder run per slice. Greedy
answers match the single-pass path. `chrome.storage.local` key
`webgpuPrefillSliceTokens` overrides the slice size (64–8192 tokens; `0`
disables slicing).

Compass VLD v6 2B, a fine-tune of Liquid's LFM3-VL-2B, has no Transformers.js
model class or processor either. `src/chrome/src/offscreen/compass-vld-v6-runtime.js`
creates its two graphs (`vision_encoder` FP16 over pre-cut 16x16 patches, and a
Q8 `decoder` that embeds the tokens, writes the image features into the image
rows and keeps a conv state or a KV cache per layer) with the same
`ort.webgpu.mjs`, and ports Lfm3VlImageProcessor (smart resize to multiples of
32, the same Pillow-compatible bicubic resampling, the patch order). Its
decoder uses `GatherBlockQuantized` with the `bits` attribute, which this
ONNX Runtime Web build (1.27.0) loads. The chat template's `{% generation %}`
markers, unknown to Transformers.js's Jinja, are rewritten to an equivalent
always-true `if` before rendering.

Compass VLD Tiny v5, a fine-tune of MiniCPM-V-4.7-1B, has no Transformers.js
model class or processor. `src/chrome/src/offscreen/compass-vld-runtime.js`
creates its three graphs (`embed_tokens` Q8, `vision_encoder` FP16 and a
chunked-GatedDeltaNet `decoder_model_merged` Q8 that returns only last-position
logits and `decision_hidden`) with this bundle's `ort.webgpu.mjs`, the same
ONNX Runtime Web build Transformers.js uses, and ports the processor:
MiniCPM-V slicing, Pillow-compatible bicubic resampling, the image
placeholders and the canvas M-RoPE positions. Transformers.js supplies only the
tokenizer class and the chat-template renderer; the runtime builds the
tokenizer from the cached files itself, because `AutoTokenizer.from_pretrained`
first looks for `tokenizer_config.json` at revision `main`, which the pinned
download does not cache. Its files are fetched at a pinned revision, one at
a time, and each is checked against its pinned size and SHA-256 before it is
used. Its own sessions keep outputs and caches on the GPU
(`preferredOutputLocation: 'gpu-buffer'`) and read back only the last-position
logits; the advice below about that option is for the Transformers.js
generation path.

For the split Bonsai text and Vision models, the worker corrects Transformers.js
4.2's text-only rotary cache offset; image turns keep the native three-axis
positions. Independent screenshots are processed separately before concatenating
their patches and grids, because the bundled image processor treats an image
array as video frames. These adaptations are scoped to the named Bonsai models.

`Michionlion/Nanbeige4.2-3B-ONNX-WebGPU` needs no bundle patch, but it does
need two things from this runtime. It publishes one WebGPU-fused graph named
`onnx/model_webgpu_mlp_q4f16.onnx` instead of the default `model_q4f16.onnx`,
so the worker passes `model_file_name: 'model_webgpu_mlp'`; the two external
data shards are declared by the repository's own
`transformers.js_config.use_external_data_format`. Its graph also uses the
`com.microsoft::MatMulNBitsMlp` WebGPU kernel, which is compiled into the
vendored `ort-wasm-simd-threaded.asyncify.wasm`. Do not replace the ONNX
Runtime artifacts with a build that drops that kernel; a test asserts it is
present because its absence only shows up as an opaque session-creation
failure at runtime.

The dedicated 450M vision sidecar uses the same component layout and is
approximately 810 MB. The VL 1.6B chat export instead names its vision and
decoder components `embed_images` and `decoder`; the compatibility patch below
maps those files into the standard image-text session names.

## Packaged files

| File / directory | Source | Purpose |
| --- | --- | --- |
| `transformers.web.js` | `@huggingface/transformers` 4.2.0 | Browser ESM model/processor APIs |
| `ort.webgpu.mjs` | `onnxruntime-web` 1.27.0 | WebGPU execution provider |
| `onnxruntime-common/` | matching `onnxruntime-common` dependency | Tensor and session types |
| `ort-wasm-simd-threaded.asyncify.*` | `onnxruntime-web` 1.27.0 | The only WASM bridge; carries the WebGPU/JSEP runtime |
| `LICENSE.transformers.txt` | `@huggingface/transformers` 4.2.0 | Apache-2.0 license |
| `LICENSE.onnxruntime.txt` | ONNX Runtime 1.27.0 | MIT license |
| `ThirdPartyNotices.onnxruntime.txt` | ONNX Runtime 1.27.0 | Notices for incorporated third-party software |

The readable, unminified browser builds are committed so a fresh checkout is a
complete, Chrome Web Store-reviewable extension. Remote executable code is not
allowed by Manifest V3 CSP; only model/config/tokenizer data is fetched from
Hugging Face.

Only the asyncify variant is vendored. `ort.webgpu.mjs` resolves its WASM
filename from flags fixed at ONNX Runtime build time, and in this build the jsep
and jspi branches are compiled out, so `ort-wasm-simd-threaded.asyncify.*` is the
only bridge that can ever load. The WebGPU/JSEP execution provider lives inside
that artifact; it is not a separate download. Copying the `jsep` or `jspi` pair
adds tens of megabytes of unreachable binary to the reviewed package, so do not
restore them without first checking that filename branch.

The ONNX Runtime files are intentionally newer than the version pinned by
Transformers.js 4.2.0. Stable 1.27.0 contains WebGPU buffer-pool and
Qwen3/QMoE correctness fixes needed by Ling while retaining the same public
JavaScript session API used by this Transformers.js release.

## Browser bundle patches

The upstream browser bundle contains two bare module specifiers that an
unbundled extension cannot resolve. After copying a new release, rewrite them:

```bash
sed -i 's|"onnxruntime-web/webgpu"|"./ort.webgpu.mjs"|' \
  src/chrome/vendor/transformers/transformers.web.js
sed -i 's|"onnxruntime-common"|"./onnxruntime-common/index.js"|' \
  src/chrome/vendor/transformers/transformers.web.js
```

Verify that no executable bare imports remain:

```bash
grep -E '(import|export)[^"]*from\s+"[a-zA-Z@]' \
  src/chrome/vendor/transformers/transformers.web.js \
  | grep -v '^\s*//' | grep -v '^\s*\*'
```

The LFM2.5-VL ONNX repositories need two compatibility hooks. The 1.6B export
predates the standard ImageTextToText component filenames, so keep the small
`session_file_names` alias hook in
`MODEL_SESSION_CONFIG[MODEL_TYPES.ImageTextToText]`; the worker supplies aliases
through `config["transformers.js_config"]`. Keep the corresponding `getSession`
logic resolving device and dtype by logical `session_name`, while using the
aliased filename only to fetch the physical ONNX graph. Both current VL exports
also use the Transformers v5 processor layout: image metadata is nested in
`processor_config.json`, and the chat template lives in `chat_template.jinja`.
Keep `loadImageProcessorConfig`, `image_processor_config_file`, and
`chat_template_file` support so the worker can opt into that layout without
changing older models. Reapply these patches after replacing
`transformers.web.js`, and mirror the resulting browser bundle into Firefox so
the packaged vendor files remain byte-identical.

## Updating

Use a temporary dependency install; WebBrain does not need a runtime npm
dependency because the reviewed browser assets are committed directly:

```bash
npm install --no-save @huggingface/transformers@latest
cp node_modules/@huggingface/transformers/dist/transformers.web.js \
  src/chrome/vendor/transformers/
cp node_modules/onnxruntime-web/dist/ort.webgpu.mjs \
  src/chrome/vendor/transformers/
cp node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.asyncify.{mjs,wasm} \
  src/chrome/vendor/transformers/
rm -rf src/chrome/vendor/transformers/onnxruntime-common
mkdir src/chrome/vendor/transformers/onnxruntime-common
cp node_modules/onnxruntime-common/dist/esm/*.js \
  src/chrome/vendor/transformers/onnxruntime-common/
```

Copy the Transformers.js license and the ONNX Runtime license plus
`ThirdPartyNotices.txt` into this directory whenever the runtime is updated.
Reapply the specifier and ImageTextToText session-alias patches, update the
version table above, then verify:

1. `node --check` passes for the provider, host, and worker.
2. **Use local fallback** enables the option without downloading weights.
3. **Test Connection** reads `WB7` from the packaged vision probe image.
4. The second test reuses browser-cached model files.

## Runtime architecture

```text
ProviderManager._createProvider('webgpu') / getVisionProvider()
  -> WebGPUProvider.chat() / WebGPUVisionProvider.chat()
  -> MV3 offscreen document
  -> dedicated module Worker
  -> text-generation pipeline / AutoProcessor + AutoModelForImageTextToText
  -> selected preset (Compass VLD v6 2B or Tiny v5 through their own ONNX Runtime sessions,
     Compass Tiny v2.1 or a custom ONNX repo) / local vision sidecar over WebGPU
```

Keep inference in the Worker. The MV3 service worker has no WebGPU, while the
offscreen document's main thread has shown tighter WASM allocation limits for
large ONNX runs. Do not set `preferredOutputLocation: 'gpu-buffer'` on this
generation path: Transformers.js decodes the generated tensor on the CPU and
must be allowed to download that output normally.

LFM2.5-VL expects the image placeholder before the user's text in its chat
template. The Worker normalizes incoming OpenAI-style multimodal messages to
that order. For the connection test, it replaces the packaged generic OCR image
with three large, unlabeled color panels. This proves the local model received
pixels without relying on fine OCR, which is brittle for a 450M model. Normal
screenshots are never replaced by this probe-only path.
