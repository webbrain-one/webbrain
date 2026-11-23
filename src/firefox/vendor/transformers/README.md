# Vendored Transformers.js CPU/WASM runtime

This directory packages the reviewable JavaScript and CPU/WASM runtime used by
Apocalypse Mode's optional semantic reranker in Firefox. Model weights are not
bundled. The pinned `Xenova/multilingual-e5-small` q8 artifact set is downloaded
only after explicit confirmation in Emergency Box and is stored in the browser
cache for fully offline use.

## Packaged files

| File / directory | Source | Purpose |
| --- | --- | --- |
| `transformers.web.js` | `@huggingface/transformers` 4.2.0 | Browser feature-extraction APIs |
| `ort.webgpu.mjs` | `onnxruntime-web` 1.27.0 | Static dependency of the browser bundle; inference selects WASM |
| `onnxruntime-common/` | matching `onnxruntime-common` | Tensor and session types |
| `ort-wasm-simd-threaded.asyncify.*` | `onnxruntime-web` 1.27.0 | Single-threaded CPU/WASM execution bridge |
| `LICENSE.transformers.txt` | Transformers.js | Apache-2.0 license |
| `LICENSE.onnxruntime.txt` | ONNX Runtime | MIT license |
| `ThirdPartyNotices.onnxruntime.txt` | ONNX Runtime | Incorporated third-party notices |

The readable browser build is the same patched file used by Chrome: its bare
ONNX Runtime imports and default asyncify factory/WASM paths point at packaged
relative files. Its ImageTextToText session map accepts filename aliases for
Chrome's legacy LFM2.5-VL 1.6B export.
It can also opt into nested `processor_config.json` metadata and standalone
chat-template files used by current VL exports. Those hooks are dormant in
Firefox. The WebGPU JSEP binaries are intentionally omitted from Firefox
because this worker always selects `device: 'wasm'` and `dtype: 'q8'`.

The model is pinned to revision
`761b726dd34fb83930e26aab4e9ac3899aa1fa78`. Its selected seven-file artifact
set is 140,461,908 network bytes. The model runs in a dedicated module worker;
passage text and embeddings never leave the device.
