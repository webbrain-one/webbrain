# Third-party notices

WebBrain Companion is GPL-3.0-or-later (see `LICENSE`). It builds on the
following components, each under its own license.

## Compiled into the executable

| Component | License | Use |
|---|---|---|
| [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) v8.0.35 (Copyright Luis Pater, Router-For.ME) | MIT | Embedded proxy: subscription logins, OpenAI/Anthropic/Gemini compatible endpoints, management API |
| [fyne.io/systray](https://github.com/fyne-io/systray) | Apache-2.0 | Tray icon on Windows and Linux |
| [purego](https://github.com/ebitengine/purego) | Apache-2.0 | Cocoa status item on macOS and ONNX Runtime loading without cgo |
| [regexp2](https://github.com/dlclark/regexp2) | MIT | Tokenizer pre-split pattern |
| [golang.org/x/image](https://pkg.go.dev/golang.org/x/image), [golang.org/x/sys](https://pkg.go.dev/golang.org/x/sys) | BSD-3-Clause | WebP decoding, OS calls |
| [atotto/clipboard](https://github.com/atotto/clipboard) | BSD-3-Clause | Copy from the tray menu |
| [Bricolage Grotesque](https://github.com/ateliertriay/bricolage) | SIL OFL 1.1 | Panel typeface (`internal/panel/assets/fonts/OFL-BricolageGrotesque.txt`) |
| WebBrain d1 runtime adapter (`d1-runtime.js`, `d1-preprocess.js`) | GPL-3.0-or-later | Ported to Go in `internal/d1` |
| WebBrain Compass VLD v6 runtime (`compass-vld-v6-runtime.js`, `compass-vld-runtime.js`, `webgpu-decisions.js`, `compass-vld-decision-probe.js`) | GPL-3.0-or-later | Ported to Go in `internal/d1` (`compass*.go`) |

Go module licenses for the full dependency graph are listed by
`go-licenses report ./...`.

## Downloaded on demand (not redistributed)

| Component | License | Notes |
|---|---|---|
| [Ternary Bonsai 2 27B](https://huggingface.co/prism-ml/Ternary-Bonsai-2-27B-gguf) GGUF / [MLX](https://huggingface.co/prism-ml/Ternary-Bonsai-2-27B-mlx-2bit) (PrismML) | Apache-2.0 | Pinned revisions, SHA-256 verified |
| [PrismML llama.cpp fork](https://github.com/PrismML-Eng/llama.cpp) release `prism-b10787-73bfe6c` | MIT | Needed for PTQ1_0; stock llama.cpp rejects it |
| MLX, mlx-vlm, mlx-lm, transformers (PyPI, via [uv](https://github.com/astral-sh/uv)) | MIT / Apache-2.0 | Apple Silicon MLX path only |
| [webbrain-compass-vld-v6-2b-onnx](https://huggingface.co/webbrain-one/webbrain-compass-vld-v6-2b-onnx) | LFM Open License v1.0 (`lfm1.0`) | Fine-tune of LiquidAI LFM3-VL-2B; same terms as d1, including the US$10M revenue threshold for commercial use |
| [d1-browser-decision-fp32](https://huggingface.co/webbrain-one/d1-browser-decision-fp32) | LFM Open License v1.0 | Derived from LiquidAI d1-omni; commercial-use terms include a US$10M revenue threshold |
| [ONNX Runtime](https://github.com/microsoft/onnxruntime) 1.31.0 | MIT | CPU runtime for the decision models, SHA-256 verified |
