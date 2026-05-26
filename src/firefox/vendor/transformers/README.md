# Vendored @huggingface/transformers (Firefox)

The Firefox WebGPU provider is currently a stub
(`src/providers/webgpu.js`) — Firefox's offscreen-equivalent and
extension-context WebGPU support aren't wired up yet, so this dir
exists purely for parity with `src/chrome/vendor/transformers/`.

When the Firefox WebGPU provider is implemented, follow the same
vendoring instructions as the chrome side. See
`../../chrome/vendor/transformers/README.md` for the full notes.
