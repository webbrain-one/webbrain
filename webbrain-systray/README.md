# WebBrain Companion

A small tray app for Windows, macOS and Linux that serves your AI subscriptions
to [WebBrain](https://webbrain.one) on `127.0.0.1`, shows how much of each one
you have left, can run PrismML's Bonsai 2 27B on your own machine, and hosts
WebBrain's decision model (Compass VLD v6 2B, or d1) natively.

- **Subscriptions on localhost.** Sign in with Claude, ChatGPT (Codex), Google
  (Antigravity), Grok, Kimi, Meta Muse or Devin. They become one OpenAI-,
  Anthropic- and Gemini-compatible endpoint at `http://127.0.0.1:8327`. Apps on
  this computer need no API key; web pages are turned away; other devices can
  connect with a key if you allow it. This is
  [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) embedded in the
  app, with a much smaller UI than EasyCLIProxyAPI.
- **Quotas at a glance.** The tray menu shows each subscription's window
  closest to running out and when it resets; the panel shows every 5-hour,
  weekly and model-specific window. Refreshed every few minutes and when you
  open the panel.
- **Bonsai 2 27B locally.** The smallest packing (PTQ1_0, 5.95 GB) plus the Q8_0
  vision projector through PrismML's llama.cpp fork, or the MLX 2-bit pack on
  Apple Silicon. The companion sizes it to your machine and decides whether the
  vision projector runs on the GPU, on the CPU, or not at all.
- **Decision model.** Compass VLD v6 2B
  (`webbrain-one/webbrain-compass-vld-v6-2b-onnx`, the model the extension
  prefers for decisions) on ONNX Runtime, or the older d1
  (`webbrain-one/d1-browser-decision-fp32`). Both answer the same requests as
  WebBrain's in-browser adapters on Windows, Linux and Apple Silicon Macs. The
  Intel Mac build includes neither.

## Install

Download the package for your system and run it. The icon appears in the menu
bar (macOS), notification area (Windows) or status tray (Linux). Opening the
app by hand, also while it already runs, shows its panel; starting at login
does not.

The tray menu holds the status, the address (click to copy), one line per
subscription and *Open panel*. The panel is a single page with the address,
your subscriptions and the two local models; click a row for its details
(every usage window, model options), or **Settings** for start at login,
language, network access, the port, the log file and *Quit*.

The panel is the companion's own window: Microsoft Edge WebView2 (built into
Windows 10 and 11) on Windows, WebKit on macOS. It opens next to the
notification area (Windows) or under the menu bar at the right (macOS), sized
to fit the screen, with the companion's icon in the taskbar or Dock and a
light or dark title bar that follows the system. Opening it again brings the
same window to the front. On macOS the companion shows in the Dock and in
Command-Tab only while the panel is open. On Linux, and when the system web
view is missing, the panel opens as a Chrome, Edge or Brave app window, or in
the default browser.

| System | Package | First start |
|---|---|---|
| Windows 10/11 (x64, Arm64) | `WebBrain-Companion-*-windows-setup.exe` | One installer for both architectures. It installs for the current user (no administrator prompt) into `%LOCALAPPDATA%\Programs\WebBrain Companion`, adds a Start menu entry and an uninstaller in *Settings, Apps*. Until it is code-signed, SmartScreen says *Windows protected your PC*: *More info*, *Run anyway*. |
| macOS 12+ (Apple Silicon and Intel; the decision model requires Apple Silicon) | `WebBrain-Companion-*-macos-universal.zip` | Move *WebBrain Companion.app* to Applications first (run from Downloads, macOS uses a temporary copy and start at login cannot work). The build is ad-hoc signed, not notarized: allow it once in *System Settings, Privacy & Security* (*Open Anyway*); on macOS 14 and earlier Control-click it and choose *Open*. If the menu bar is full, macOS hides the icon; the panel says so, and opening the app again always brings the panel back. |
| Linux (x64, Arm64) | `WebBrain-Companion-*-linux-*.tar.gz` | Run `webbrain-companion`. The tray uses StatusNotifierItem (KDE, XFCE, GNOME with the AppIndicator extension). |

`--headless` runs the proxy and APIs without a tray icon, `--background` starts
without opening the panel (used at login), `--version` prints the version and
`--update` installs the newest version over this copy.

## Updates

From 0.1.3 on, the companion keeps itself current. Two minutes after it
starts, and every six hours, it asks GitHub for the newest published
`systray-v*` release of `webbrain-one/webbrain` (drafts and pre-releases are
skipped). It downloads the package for this system and installs it only when
the package's SHA-256 matches the release's `SHA256SUMS` file. Then it waits
until nothing has used it for ten minutes: no model or decision request (its
own usage refreshes do not count), no open panel, no model download, no
sign-in in progress. Waking the computer counts as use. It installs the
update, shuts down and starts the new version without opening the panel.

- **macOS** swaps *WebBrain Companion.app* in its folder and **Linux** the
  `webbrain-companion` program; the new version then takes over the same
  process. The replaced copy stays hidden next to it until the new version
  has started, and is put back if the new version cannot start. A copy that
  macOS runs from a temporary location (not moved to Applications) cannot
  replace itself. If macOS refuses the swap, allow WebBrain Companion under
  *System Settings, Privacy & Security, App Management*, or download the new
  version by hand. On Linux the program's folder must be writable.
- **Windows** runs the new setup program silently (`/S /UPDATE=<pid>`). It
  waits for the companion to quit, installs over the registered installation,
  and starts the new version. If a file cannot be written, the setup stops and
  starts the copy that is in place. The installation folder must be writable
  without administrator rights.

An update that fails is shown under *Settings, Updates* and is not tried again
by itself; *Update now* tries again, and a newer release is installed as usual.

*Settings, Updates* turns automatic installs off. New versions are then only
reported, and *Update now* (also in the tray menu) installs them. With
`--headless` the companion only reports new versions; run
`webbrain-companion --update` and restart it. Development builds (a version
with a suffix, such as `0.1.0-dev`) never update. Releases before 0.1.3 have no
updater: download 0.1.3 or later once by hand.

## Connect WebBrain

In WebBrain's **Providers** page (*More…* in the side panel's model menu), pick
**WebBrain Companion**. Its default address is `http://127.0.0.1:8327/v1`;
use the address shown in the panel or tray menu if the port changed. No API key
is needed for the extension on this computer. Click **Load Models**, select a
model, **Save**, and run **Test Connection**. Turn vision on only
for a model that accepts images (the local `bonsai-2-27b` does when its
projector is on). Any OpenAI, Anthropic or Gemini client works the same way:

```bash
curl http://127.0.0.1:8327/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"claude-sonnet-5-5","messages":[{"role":"user","content":"Hi"}]}'
```

### Other devices

*Settings, Allow other devices on this network* makes the companion listen on
`0.0.0.0`. The panel then shows the network address (for example
`http://192.168.1.57:8327/v1`) and the API key; requests from other devices
must carry it (`Authorization: Bearer`, `x-api-key` or `x-goog-api-key`).
Your system may ask to allow incoming connections. Keep it off on public
Wi-Fi.

`GET /v1/models` lists every model your subscriptions (and the local model)
provide. The local model's id is `bonsai-2-27b`.

## Local model: Bonsai 2 27B

Click **Bonsai 2 27B** in the panel to see what will run before anything
downloads:

| Machine | Runtime chosen |
|---|---|
| Apple Silicon | PrismML llama.cpp, Metal (GGUF) or mlx-vlm (MLX) |
| NVIDIA GPU | PrismML llama.cpp CUDA 12.4 / 12.8 / 13.3 build matching the driver |
| AMD/other GPU with ≥ 6 GB | Vulkan build |
| Anything else | CPU build |

Context follows PrismML's RAM tiers (8K up to 128K tokens) and shrinks until
the weights, KV cache (64 KiB per token on the 27B) and compute buffers fit the
GPU budget. **The vision projector (mmproj Q8_0) is then decided from what is
left:** on the GPU when about 1 GB of GPU memory remains, on the CPU
(`--no-mmproj-offload`) when only system RAM has room, otherwise off. Options
let you force *GPU*, *CPU* or *Off*, pick a context size, or start the model
with the companion. The MLX pack carries its own vision tower, so it always
accepts images.

Downloads are pinned to exact Hugging Face revisions and checked against
SHA-256; interrupted downloads resume.

## Decision model

The native decision model is available on Windows and Linux (x64 and Arm64)
and on Apple Silicon Macs. The Intel Mac app runs the proxy, tray and local
Bonsai model, but cannot install a decision model because the pinned ONNX
Runtime release has no Intel macOS archive.

```bash
curl http://127.0.0.1:8327/companion/v1/decide \
  -H "Content-Type: application/json" \
  -d '{"state":"Order #1042 is confirmed.","questions":{"completion":{"type":"choice",
       "instructions":"Did the task finish?","criteria":{"completed":"Confirmed",
       "not_completed":"Failed or unfinished","unknown":"Not established"}}}}'
```

Requests and answers have d1's shape (`choice`, `noul` and `score` questions,
up to four inline PNG/JPEG/WebP screenshots, in `images` or as `image_url`
parts of the state); `model` and `provider` say which model answered.

- **Compass VLD v6 2B** (the default, 2.4 GB download, up to about 4 GB of
  memory while deciding with a screenshot; d1 takes 3.7 GB). The extension's decision protocol on its own model: the page
  state and screenshots are prefilled once, each option is asked as "Proposed
  answer: ... Is the proposed answer correct?", and the options are scored by
  their Yes-minus-No margins (the bundle's cost-sensitive probe). The Go port
  of `compass-vld-v6-runtime.js` (the LFM3-VL image processor with Pillow's
  bicubic resampling, the FP16 vision encoder, the Q8 decoder with its conv
  states and KV caches) was checked against the extension's JavaScript on the
  same graphs: identical prompts, tokens, image layouts, pixel values, image
  features, logits and probabilities. JPEG and WebP screenshots are decoded by
  Go's decoders, whose pixels differ slightly from Chrome's. The check is
  `scripts/models/compass-vld/` in the repository root (fixtures, the
  extension's runtime on onnxruntime-node, comparison) with
  `go run ./tools/d1check -engine compass -trace`.
- **d1** (1.9 GB). An installed d1 keeps answering until Compass is installed;
  the panel switches between them and deletes the other one's files. Text-only
  rows are capped at 4,096 tokens on the CPU runtime.

Both run on the CPU. A decision with a 1280x800 screenshot takes about 15
seconds on a fast desktop processor with either model; a text-only decision
takes 1.5 to 3 seconds on Compass and under half a second on d1. Two optional
settings in `companion.json` under `decision`: `threads` (ONNX Runtime threads;
on CPUs with efficiency cores the physical performance-core count is often
fastest) and `max_pixels` (Compass only: a smaller screenshot budget than the
extension's, for example `262144`, which makes a 1280x800 screenshot 240
image tokens instead of 1,000 and the decision about three times faster, at
some cost in detail). Both models are under the LFM Open License v1.0; check
its commercial terms before commercial use.

`GET /companion/v1/info` describes the running companion (endpoints, models,
decision status, whether network access is on) for the WebBrain extension. It
sends no CORS headers and only answers this computer, so web pages cannot read
it.

## Where things live

| | Windows | macOS | Linux |
|---|---|---|---|
| Settings, logins | `%APPDATA%\WebBrain Companion` | `~/Library/Application Support/WebBrain Companion` | `~/.config/webbrain-companion` |
| Models, runtimes, logs | `%LOCALAPPDATA%\WebBrain Companion` | same as above | `~/.local/share/webbrain-companion` |

## Security notes

- By default everything listens on `127.0.0.1` only, and apps on this computer
  need no API key. Browser requests are told apart by their `Origin` and
  `Sec-Fetch-Site` headers: extensions (WebBrain) and pages served from
  localhost pass; pages from other sites are refused, even when an extension
  rewrites their `Origin` to `127.0.0.1` (a common workaround for Ollama),
  because the browser still marks them cross-site. Non-loopback `Host` headers
  are refused (DNS rebinding).
- With network access on, the proxy listens on `0.0.0.0` and every request from
  another device needs the API key. The panel, its API and the discovery
  document stay reachable from this computer only; the panel also needs its
  own per-install key.
- OAuth tokens stay in the logins folder above and are only sent to their
  provider. Quotas are read through the proxy's own `api-call`, so tokens never
  pass through the panel.
- No analytics. Besides the providers you sign in to, the embedded proxy
  refreshes CLIProxyAPI's public model catalog every few hours, and installing a
  model downloads from Hugging Face, GitHub and (MLX only) PyPI. The update
  check reads GitHub's release list every six hours and downloads releases from
  GitHub.
- Updates are trusted as much as the GitHub release they come from: the
  checksum file is part of the same release, so it catches damaged downloads,
  not a release published by someone else. Packages are not signed with a
  separate update key.
- Using consumer subscriptions through a proxy may conflict with a provider's
  terms. Read WebBrain's
  [setup, security and account-risk guide](https://webbrain.one/docs/easy-cli-proxy/)
  before relying on it.

## Build from source

This directory is a standalone app, imported from
[`esokullu/webbrain-systray` main at `c68416b`](https://github.com/esokullu/webbrain-systray/commit/c68416bc7f0dcb767006f0c67aef017b93dc6e8a)
as a source snapshot. Its Go module and packages are independent of the WebBrain
extension.

Go 1.26+. Everything is pure Go (`CGO_ENABLED=0`), so every platform builds from
any host:

```bash
cd webbrain-systray                       # from the WebBrain repository root
VERSION=0.1.2 ./scripts/build.sh          # Windows installer, macOS (universal .app), Linux packages in dist/
go run . --headless                       # run locally without a tray
WBC_DEMO=1 go run . --headless            # panel with sample data (screenshots, UI work)
```

The Windows installer needs NSIS (`apt install nsis` or `brew install makensis`);
`SIGN_WINDOWS` in `scripts/build.sh` signs the executables and the installer
when a code-signing certificate is available.

The repository's `.github/workflows/systray-build.yml` tests and packages this
app separately. Push a `systray-v<version>` tag (for example `systray-v0.1.2`)
to draft a companion release in this repository; extension releases use their
own tags.

`go test ./...` covers the memory planner (which machines get the vision
projector where), the JavaScript-compatible JSON formatting of the d1 port,
the Compass image processor, prompts and answers against the extension's
values, which decision model is in use,
archive extraction and who may use the endpoints (keyless local apps,
extensions, refused web pages, DNS rebinding, network access with the key).

The product site lives in `web/` (the main website's 22 languages, built by
`python3 web/build.py`); see `web/README.md`.

The macOS menu-bar code is a small Cocoa binding on purego
(`internal/tray/tray_darwin.go`); Windows and Linux use fyne.io/systray. Icons
are generated from WebBrain's mark by `scripts/make_icons.py`.

## License

GPL-3.0-or-later, like WebBrain. See `LICENSE` and `THIRD_PARTY_NOTICES.md`.
