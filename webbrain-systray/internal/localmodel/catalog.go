// Package localmodel installs and runs PrismML's Ternary Bonsai 2.5 27B on the
// user's machine (GGUF through PrismML's llama.cpp fork, or MLX on Apple
// Silicon) and registers it with the proxy as an OpenAI-compatible model.
package localmodel

import (
	"fmt"
	"os"
)

// File is one pinned download.
type File struct {
	Name   string // path inside the repository
	Size   int64
	SHA256 string // empty for files we only size-check
}

func hfURL(repo, rev, name string) string {
	return fmt.Sprintf("https://huggingface.co/%s/resolve/%s/%s", repo, rev, name)
}

const (
	ModelID       = "bonsai-2.5-27b"
	legacyModelID = "bonsai-2-27b"
	ModelName     = "Bonsai 2.5 27B"
	ModelVendor   = "PrismML"
	ModelPageURL  = "https://huggingface.co/prism-ml/Ternary-Bonsai-2.5-27B-GGUF"
)

// GGUF: the smallest packing (PTQ1_0, dense trits) plus the Q8_0 vision projector.
var gguf = struct {
	Repo, Rev   string
	Model, Proj File
}{
	Repo:  "prism-ml/Ternary-Bonsai-2.5-27B-GGUF",
	Rev:   "28a7093cc25bc151cc2b284c5570f12ce343fdcf",
	Model: File{"Ternary-Bonsai-2.5-27B-PTQ1_0.gguf", 5993834848, "929560ec9d37cf3cadd4b00cc87b51c570082a628dd830b4692dc0b2ed18dbbe"},
	Proj:  File{"Ternary-Bonsai-2.5-27B-mmproj-Q8_0.gguf", 629246976, "6807ede61d570bb86ba34b756a0fa109edc33668604de867c6ea6d8f1d631903"},
}

// MLX: the 2-bit pack (vision tower included) served by native mlx-vlm.
var mlxPack = struct {
	Repo, Rev, Dir string
	Files          []File
}{
	Repo: "prism-ml/Ternary-Bonsai-2.5-27B-mlx-2bit",
	Rev:  "aa432fd0e17612f6684e728d4d3c42b6656bcabb",
	Dir:  "Ternary-Bonsai-2.5-27B-mlx-2bit",
	Files: []File{
		{"model.safetensors", 8595477990, "b7b1cbfa351fca7039d0c9d5ac20e5ba3d69ec03c8a0d236a16e0c7f45b7cdd1"},
		{"tokenizer.json", 19989343, "87a7830d63fcf43bf241c3c5242e96e62dd3fdc29224ca26fed8ea333db72de4"},
		{"config.json", 58145, "238de7c512cc56a733421e3fd011d88f8260739e3d00e32c5d65b7943cc9f837"},
		{"hadamard.json", 297903, "7132a3ec364f0bdac1f08f905f24f0ad2f14245060f592637a0396826d3b5fe6"},
		{"tokenizer_config.json", 17928, "b11349aafa7cdc6a320767cf7ceb29ed82f7eda5d65e8e0819e76f0ce947bf27"},
		{"chat_template.jinja", 8952, "c3cf9e34abf4f9e36c2d72165aa9c132d3e2a725b6c2586aaa3a8af9d7a81041"},
		{"generation_config.json", 178, "2a9c067fc2d6a652e174ffee36afede3a6c66261a88e4ac9baba476cee1d377e"},
		{"preprocessor_config.json", 390, "27225450ac9c6529872ee1924fcb0962ff5634834f817040f444118116f4e516"},
		{"video_preprocessor_config.json", 385, "7768af27c1fafa9cc9011c1dc20067e03f8915e03b63504550e11d5066986d13"},
		{"files.json", 2882, "bfb74cc3c15f1f58f134a9575c1f509bfa44186ecbf3dcb75c1c00af2db68067"},
		{"quickstart.py", 3882, "094ecaee12c0800cec2a68358c3370db7d31abe7757f95f7bf1edde4f4e48cbb"},
		{"runtime/artifact.py", 5726, "426ca170411832fa686777f61919432df377e46c7b04163b032ee1cd47f12a42"},
		{"runtime/codec.py", 2572, "7f7fd67637a7d9363eab8ebf7db59771830b690330ffef772379a0169ddb9608"},
		{"runtime/mtp_artifact.py", 2677, "6f2a05dcc92a80c2d0f2866dcb5911a5b286fc7759cc55d8b37eed10b77b10e9"},
		{"runtime/requirements.txt", 115, "358bc104a02ea598f1e6cde8e7eeed169b9ec34f69f3543b47b390706446a1e0"},
		{"runtime/runtime.py", 13729, "98180a782214c655cb49f4f96e6291828c943b39bc916ba57ebc032a88777690"},
		{"runtime/vision_artifact.py", 5809, "b059c11ca4600fe09b5bead882a5949ba031ec65422427353534c0ac3a4e72a7"},
	},
}

// The tested native MLX dependency set from PrismML's Bonsai-demo
// (scripts/requirements-mlx-vlm.txt).
var mlxRequirements = []string{"mlx==0.32.3", "mlx-vlm==0.7.8", "mlx-lm==0.32.0", "transformers==5.19.0"}

const (
	mlxPython = "3.11"
	uvVersion = "0.13.3"
)

// PrismML's llama.cpp fork release pinned by Bonsai-demo; stock llama.cpp
// rejects PTQ1_0.
const llamaTag = "prism-b12178-03ec600"

func llamaURL(asset string) string {
	return fmt.Sprintf("https://github.com/PrismML-Eng/llama.cpp/releases/download/%s/%s", llamaTag, asset)
}

// Runtime archive sizes (bytes), for progress before headers arrive.
var llamaAssetSizes = map[string]int64{
	"llama-" + llamaTag + "-bin-macos-arm64.tar.gz":         13209869,
	"llama-" + llamaTag + "-bin-macos-x64.tar.gz":           12633960,
	"llama-" + llamaTag + "-bin-linux-cuda-12.4-x64.tar.gz": 357880121,
	"llama-" + llamaTag + "-bin-linux-cuda-12.8-x64.tar.gz": 225887048,
	"llama-" + llamaTag + "-bin-linux-cuda-13.3-x64.tar.gz": 222326030,
	"llama-" + llamaTag + "-bin-ubuntu-vulkan-x64.tar.gz":   34001867,
	"llama-" + llamaTag + "-bin-ubuntu-vulkan-arm64.tar.gz": 26229063,
	"llama-" + llamaTag + "-bin-ubuntu-x64.tar.gz":          19816260,
	"llama-" + llamaTag + "-bin-ubuntu-arm64.tar.gz":        15083693,
	"llama-" + llamaTag + "-bin-win-cuda-12.4-x64.zip":      341653677,
	"llama-" + llamaTag + "-bin-win-cuda-13.3-x64.zip":      216516289,
	"cudart-llama-bin-win-cuda-12.4-x64.zip":                391443627,
	"cudart-llama-bin-win-cuda-13.3-x64.zip":                390970417,
	"llama-" + llamaTag + "-bin-win-vulkan-x64.zip":         28889910,
	"llama-" + llamaTag + "-bin-win-cpu-x64.zip":            21687453,
	"llama-" + llamaTag + "-bin-win-cpu-arm64.zip":          13512145,
}

// SHA-256 digests published with the pinned PrismML release assets.
var llamaAssetSHA = map[string]string{
	"llama-" + llamaTag + "-bin-macos-arm64.tar.gz":         "94d791a4ad9d6ea0c9884929830352397af8274ca107afab497b1de0147bf99b",
	"llama-" + llamaTag + "-bin-macos-x64.tar.gz":           "12cbfde8f97d092383ac4be05631d413002bc6e9a6deff82f78bbf34f27e30c6",
	"llama-" + llamaTag + "-bin-linux-cuda-12.4-x64.tar.gz": "626dc154204531df146a428d455b53c64534b8f022e98cb0760881b48a35557e",
	"llama-" + llamaTag + "-bin-linux-cuda-12.8-x64.tar.gz": "a50997fb29bb0684c00cdf21bb1382923c6bc70085a74c9c3d913dcf76af1899",
	"llama-" + llamaTag + "-bin-linux-cuda-13.3-x64.tar.gz": "f0dd07b2b93617a5d56e96431cb24608fb4d1b050518b7c8cc0a6b623695759d",
	"llama-" + llamaTag + "-bin-ubuntu-vulkan-x64.tar.gz":   "ae0c418260b2d651f04e380b83953f66d5be5fda7ebcbc8386673a65009684f5",
	"llama-" + llamaTag + "-bin-ubuntu-vulkan-arm64.tar.gz": "0a2ed1320966e334ee6fc64fbb4832b1e913bbfd2ef1704a187323f678d177fd",
	"llama-" + llamaTag + "-bin-ubuntu-x64.tar.gz":          "78d3796781c8f6c350c2b102aec9811939d377b10c9301f3a28576f5ba633fb4",
	"llama-" + llamaTag + "-bin-ubuntu-arm64.tar.gz":        "728a5c6beb25d4744daffb9fe31091cd7be4f55f23551a4559e282a3293656f8",
	"llama-" + llamaTag + "-bin-win-cuda-12.4-x64.zip":      "f1bef85254012f0e6f25502ee86696c7de6ccc76a922f05c3f23ab2e5719c531",
	"llama-" + llamaTag + "-bin-win-cuda-13.3-x64.zip":      "a34bdb817e797243f86c5e2dd1bdf118d17ea32b6eaa4e6f32c41533b13bc2d8",
	"cudart-llama-bin-win-cuda-12.4-x64.zip":                "8c79a9b226de4b3cacfd1f83d24f962d0773be79f1e7b75c6af4ded7e32ae1d6",
	"cudart-llama-bin-win-cuda-13.3-x64.zip":                "1462a050eb4c684921ba51dcc4cc488a036674c3e73e9945ee705b854808d03e",
	"llama-" + llamaTag + "-bin-win-vulkan-x64.zip":         "da2745ee0ed78ddeab2ed4ecf30e0589596217e21d974079968aab82f67051dc",
	"llama-" + llamaTag + "-bin-win-cpu-x64.zip":            "f88c2dcf9557e47403f7e5f30ee18236ebe7ea7f6ee6f2d9daa35226b5bcf420",
	"llama-" + llamaTag + "-bin-win-cpu-arm64.zip":          "dc90e4370a0ada8b7dfd82c87c05567651a3e2f603670e78aa26185243bd6c60",
}

var uvAssets = map[string]File{
	"uv-aarch64-apple-darwin.tar.gz": {Size: 14309841, SHA256: "bf1e4fb6f5f5079a2902ad3f3a9e2d337575b226a1378f2449d8404353650608"},
	"uv-x86_64-apple-darwin.tar.gz":  {Size: 17182824, SHA256: "5c35634957db7ebd9c2e4cc6c66b8979fb2c26a6b0dbd1d214d6acbac4033a89"},
}

func uvAsset(arch string) string {
	if arch == "arm64" {
		return "uv-aarch64-apple-darwin.tar.gz"
	}
	return "uv-x86_64-apple-darwin.tar.gz"
}

func uvURL(arch string) string {
	return fmt.Sprintf("https://github.com/astral-sh/uv/releases/download/%s/%s", uvVersion, uvAsset(arch))
}

const (
	gib = int64(1) << 30
	// FP16 KV cache per token on the 27B: 16 full-attention layers × K,V × 4
	// heads × 256 dims × 2 bytes. The 48 linear-attention layers keep a small
	// fixed recurrent state instead.
	kvBytesPerToken = 64 << 10
	// Compute buffers for batch prefill, measured loosely on llama.cpp.
	computeBytes = 900 << 20
	// The Q8_0 projector plus its working buffers when offloaded to the GPU
	// (Bonsai-demo: --no-mmproj-offload frees ~0.9 GiB of VRAM).
	visionGPUBytes = 960 << 20
	// The projector kept in system RAM (CPU image encoding).
	visionCPUBytes = 1300 << 20
	// Fixed recurrent state and runtime overhead.
	stateBytes = 300 << 20
)

// WBC_DEV_BONSAI_2B=1 swaps in the 2B GGUF pack (0.8 GB) so the install and
// serving pipeline can be exercised on small machines and in CI. It is not
// shown in the UI.
func init() {
	if os.Getenv("WBC_DEV_BONSAI_2B") == "" {
		return
	}
	gguf.Repo = "prism-ml/Ternary-Bonsai-2-2B-gguf"
	gguf.Rev = "683f7be2629342a50987627b40881e54761a2430"
	gguf.Model = File{"Ternary-Bonsai-2-2B-PTQ1_0.gguf", 429183456, "36061ad406df8a4903a6db005be350c50fabfaf717f9ef0acf4b76adcd9929fa"}
	gguf.Proj = File{"Ternary-Bonsai-2-2B-mmproj-Q8_0.gguf", 364664352, "ac9934e8d7966d0d62442c202ec8fdad99a045dea79366c1a4a246a46f5c0533"}
}
