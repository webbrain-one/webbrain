# Vendored @huggingface/transformers

The WebGPU provider (`src/providers/webgpu.js`) loads the in-browser ONNX
runtime via `@huggingface/transformers`. The relevant build files are
committed in this directory so the extension works straight from a
fresh `git clone` — no per-developer vendoring step.

## What's here

| File | Source | Purpose |
| --- | --- | --- |
| `transformers.web.min.js` | `node_modules/@huggingface/transformers/dist/` | Browser ESM bundle of the library |
| `ort-wasm-simd-threaded.jsep.mjs` | `node_modules/@huggingface/transformers/dist/` | JS loader for the WebGPU WASM blob |
| `ort-wasm-simd-threaded.jsep.wasm` | `node_modules/onnxruntime-web/dist/` | The actual WebGPU-enabled ONNX runtime (~25MB) |

The `.web.min.js` build is the browser ESM variant — not
`transformers.min.js` (dual ESM/CJS), not `transformers.node.*`. The
import path in `src/offscreen/offscreen.js` is hard-coded to
`transformers.web.min.js`; if you change which build is vendored, update
that import.

## Current vendored version

| webbrain | @huggingface/transformers | onnxruntime-web |
| --- | --- | --- |
| 7.4.0+ | 4.2.0 | (matched, transitive dep of transformers) |

## Updating

```bash
npm install @huggingface/transformers@latest
cp node_modules/@huggingface/transformers/dist/transformers.web.min.js \
   src/chrome/vendor/transformers/
cp node_modules/@huggingface/transformers/dist/ort-wasm-simd-threaded.jsep.mjs \
   src/chrome/vendor/transformers/
cp node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.jsep.wasm \
   src/chrome/vendor/transformers/
```

Then bump the version row in the table above, commit, and re-run the
extension to verify Qwen 3 still loads.

## Why vendored and not loaded from a CDN?

Manifest V3 extensions' CSP is `script-src 'self' 'wasm-unsafe-eval'`.
Remote scripts (`<script src="https://cdn...">` or dynamic-imported
remote URLs) are blocked. The Chrome Web Store will also reject a
manifest that loosens this to allow remote scripts. Vendoring is the
only path.

## Runtime configuration

`offscreen.js` configures the library to:

- Fetch model weights from the HuggingFace CDN (`allowRemoteModels = true`).
- Cache them in IndexedDB (the library's default — first-run downloads
  big, subsequent runs are instant).
- Pin `env.backends.onnx.wasm.wasmPaths` to this directory's
  `chrome-extension://` URL so the runtime finds the `.wasm` file
  reliably regardless of how the library is bundled.

If a future library version changes the `env.backends.onnx.wasm` shape,
the `wasmPaths` setter is wrapped in a try/catch — failure falls back
to the library's own resolution heuristics.

## Files NOT vendored (and why)

- `transformers.js` / `transformers.min.js` (dual builds, ~1.3MB each) —
  redundant with the `.web.min.js` we use; the dual variants embed Node-
  only code paths we never reach.
- `transformers.node.*` — Node runtime, unused.
- `ort-wasm-simd-threaded.asyncify.wasm` / `.jspi.wasm` / `.wasm` — CPU
  fallback variants. Adding them would let the provider fall back to
  WASM-CPU when WebGPU is absent, but for now we surface a clear
  "WebGPU not available" error instead. Add these later if we want
  CPU fallback for systems without WebGPU.
