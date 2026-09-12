<p align="center">
  <img src="assets/logo-mark.png" alt="WebBrain logo" width="92">
</p>

<h1 align="center">WebBrain</h1>

<p align="center">
  Open-source AI browser agent for chatting with pages, automating tasks, and running multi-step workflows with your choice of LLM.
</p>

<p align="center">
  <a href="https://chromewebstore.google.com/detail/webbrain/ljhijonmfahplgbbacgcfnaihbjljhhb"><img src="https://img.shields.io/badge/Chrome-Install-4285F4?style=for-the-badge&amp;logo=googlechrome&amp;logoColor=white" alt="Install WebBrain from the Chrome Web Store"></a>
  <a href="https://addons.mozilla.org/firefox/addon/webbrain/"><img src="https://img.shields.io/badge/Firefox-Install-FF7139?style=for-the-badge&amp;logo=firefoxbrowser&amp;logoColor=white" alt="Install WebBrain from Firefox Browser Add-ons"></a>
  <a href="https://microsoftedge.microsoft.com/addons/detail/dfbioajafcijomhljabppcelecgdgfeo"><img src="https://img.shields.io/badge/Edge-Install-0A84FF?style=for-the-badge&amp;logo=microsoftedge&amp;logoColor=white" alt="Install WebBrain from Microsoft Edge Add-ons"></a>
</p>

<p align="center">
  <a href="README.md">English</a> ·
  <a href="README.zh-CN.md">中文</a> ·
  <a href="README.fr.md">Français</a> ·
  <a href="docs/">Docs</a> ·
  <a href="https://webbrain.one">Website</a> ·
  <a href="https://discord.gg/cgC325ssfw">Discord</a> ·
  <a href="LICENSE">GPL-3.0-or-later</a>
</p>

![WebBrain reading a page, filling in a form, and fetching a file](assets/webbrain-demo.gif)

WebBrain is a web browser extension that puts an AI agent in a side panel next to
your tabs. Ask it about the page you're on, or hand it a task and let it click,
type, and navigate its way through. It runs on the model you choose — a local
llama.cpp or Ollama server, a frontier cloud API, or the managed default that
needs no setup at all.

## Install

Install from the [Chrome Web Store](https://chromewebstore.google.com/detail/webbrain/ljhijonmfahplgbbacgcfnaihbjljhhb),
[Firefox Add-ons](https://addons.mozilla.org/firefox/addon/webbrain/), or
[Edge Add-ons](https://microsoftedge.microsoft.com/addons/detail/dfbioajafcijomhljabppcelecgdgfeo).

<details>
<summary><b>Or load it from source</b></summary>

```bash
git clone https://github.com/webbrain-one/webbrain.git
```

**Chrome** — open `chrome://extensions/`, enable **Developer mode** (top
right), click **Load unpacked**, and select the `webbrain/src/chrome` folder.
For an isolated copy that won't pick up stray working-tree files, run
`npm run build:chrome` first and load `webbrain/build/chrome` instead.

**Firefox** — open `about:debugging#/runtime/this-firefox`, click **Load
Temporary Add-on**, and select `src/firefox/manifest.json` (or
`build/firefox/manifest.json` after `npm run build:firefox`). Temporary add-ons
are removed when Firefox restarts; permanent installation requires signing via
[addons.mozilla.org](https://addons.mozilla.org).

</details>

## Use it

Click the WebBrain icon to open the side panel, then type something like:

- "Summarize this page"
- "Find all links about pricing"
- "Fill in the search box with 'AI agents' and click Search"
- "Navigate to github.com and find trending repositories"

Three modes control what the agent is allowed to do:

| Mode    | What it can do                                                         |
| ------- | ---------------------------------------------------------------------- |
| **Ask** | Read-only. Reads the page, answers questions, fetches URLs.            |
| **Act** | Clicks, types, navigates, uploads, downloads, fills forms.             |
| **Dev** | Adds page source, styles, console, network, and reversible page edits. |

## Pick a model

**WebBrain Compass 1.0** is the default and needs no API key or local setup.

**Local models** need no API key either. Point WebBrain at any OpenAI-compatible
server:

```bash
llama-server -m your-model.gguf --port 8080          # llama.cpp
ollama serve                                          # Ollama  → :11434/v1
vllm serve your-model --port 8000                     # vLLM    → :8000/v1
python -m sglang.launch_server --model-path your-model --port 30000
```

LM Studio (`:1234/v1`), Jan (`:1337/v1`), LocalAI (`:8080/v1`), and GPT4All
(`:4891/v1`) work the same way. A generic **Local OpenAI-compatible Proxy** card
also supports authenticated loopback gateways such as CLIProxyAPI; see the
[secure subscription proxy setup](docs/providers-and-models.md#subscription-proxy-example-cliproxyapi).
**Unsloth Studio (Local)** uses the same OpenAI-compatible path with the Studio
port and `sk-unsloth-` API key configured by the user; see the
[Unsloth Studio setup](docs/providers-and-models.md#unsloth-studio).
Load a model with **at least a 16k-token context window** — 8k works only
with the Compact tier, and 4k is too small for the system prompt plus tool
schemas. WebBrain auto-detects the real window for llama.cpp, Ollama, and LM
Studio, and auto-compacts the conversation as it fills up. For Ollama,
llama.cpp, LM Studio, and LocalAI, it also reads native server metadata before
adding screenshots; Settings provides Auto, Force on, and Off overrides. When
the optional Model field is blank, the loaded-model capability is rechecked on
every user turn so a server-side hot swap takes effect. There is also a
preview `ollama launch webbrain --model <model>` handoff. Details:
[providers and models](docs/providers-and-models.md#local-providers).

**Cloud APIs** — OpenAI, Anthropic Claude, Google Gemini, Azure OpenAI, AWS
Bedrock, Mistral, DeepSeek, xAI Grok, MiniMax, Kimi, Qwen, z.ai GLM, Groq,
Together, Cloudflare, Nvidia NIM, Hugging Face, Fireworks, OpenRouter, and more.
Settings ships **106 built-in provider cards on Chromium** (105 on Firefox),
including an endpoint-free local WebGPU option with the tested LFM2.5 2.6B
preset and an experimental custom Hugging Face ONNX repository option —
see the [full catalog](docs/providers-and-models.md#extended-provider-catalog).

## Features

- **Reads any page** — text, links, forms, tables, PDFs, and interactive
  elements, via the accessibility tree rather than brittle selectors
- **Acts on it** — click, type, scroll, navigate, upload, download, and verify
  forms, with per-site permission prompts before consequential actions
- **Plan before Act** — Act and Dev can generate a structured plan, show it for
  approval, and pin the approved plan to the scratchpad before any tool runs
- **Multi-step agent** — autonomous tool-use loop, configurable up to 195 steps
  (default 130), with a Continue button when it hits the limit
- **Saved workflows** — turn a successful run into a reusable, value-free
  workflow you can re-run, export, and share
- **Scheduled tasks and watches** — `/schedule` for later, `/watch` to poll a
  page and act when a condition is met
- **Skills** — trusted instructions and tools that load only when relevant
- **Smart context** — token-aware auto-compaction, tool-result limits, and
  emergency overflow recovery
- **Per-tab conversations** — each tab keeps its own history; optional local
  user memory for stated preferences
- **Reading-first side panel** — streaming Ask replies, floating controls that
  keep your question in view as answers grow, copy buttons, a page-inspection
  banner, and a stop button that works mid-run
- **Deterministic by default** — temperature `0.15` for browser-control
  decisions, `0.3` for Ask, `0` for vision screenshot descriptions

## Agent tools

WebBrain separates **tier** from **mode**. Tier (`compact`, `mid`, `full`) is a
per-provider setting controlling how many tools a model sees — Compact suits
small local models, Full unlocks hover, drag-drop, frames, and shadow DOM. Mode
(`ask`, `act`, `dev`) controls what the user is allowing.

The full tool-by-tier matrix, WebMCP notes, and Dev-mode diagnostics are in
[agent tools](docs/agent-tools.md).

## Slash commands

Type `/help` in the panel for full signatures and flags. The most useful ones:

| Command                                                                                | What it does                                                                |
| -------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `/ask` · `/act` · `/dev` · `/plan`                                                     | Switch mode before sending                                                  |
| `/schedule [prompt]`                                                                   | Create a scheduled task                                                     |
| `/watch [--keep] [--secs <30-120>] [--long \| --short] <condition and action> [/beep]` | Poll the current page and act when a condition is met                       |
| `/workflow` · `/workflow --save <name>`                                                | Manage saved workflows or compile the last successful run                   |
| `/teach --start <name>` · `/teach --end`                                               | Learn a reusable workflow from your demonstrated actions                    |
| `/memory --add <text>`                                                                 | Save a user preference                                                      |
| `/screenshot [--full-page]`                                                            | Capture the tab, or the full scrollable page                                |
| `/record [--transcribe]`                                                               | Record the current tab, optionally saving a transcript                      |
| `/export [--traces \| --config]`                                                       | Download the conversation, tool chain, or a Settings snapshot               |
| `/compact` · `/reset` · `/verbose`                                                     | Compact context, clear the conversation, toggle tool detail                 |
| `/allow-api`                                                                           | Per-conversation override letting `fetch_url` mutate when the UI is failing |

`/watch` runs its first check immediately, then polls every 60 seconds
(`--secs` accepts 30–120). Relative conditions like "when a new commit appears"
establish a baseline on the first check; `--keep` keeps the watch running and
suppresses repeated alerts for the same stable event key.

Full reference, including `/dangerously-skip-permissions` and the run-capture
suffixes: [slash commands](docs/slash-commands.md).

## Keyboard Shortcuts

Chrome side panel shortcuts work when the WebBrain side panel has focus.

| Shortcut                        | What it does                                                                 |
| ------------------------------- | ---------------------------------------------------------------------------- |
| `Ctrl+/` or `Cmd+/`             | Focus the input                                                              |
| `Ctrl+Shift+A` or `Cmd+Shift+A` | Switch to Ask mode                                                           |
| `Ctrl+Shift+X` or `Cmd+Shift+X` | Switch to Act mode                                                           |
| `Ctrl+Shift+D` or `Cmd+Shift+D` | Switch to Dev mode                                                           |
| `Escape`                        | Stop the active run, unless it is only dismissing slash-command autocomplete |
| `Escape` twice                  | Stop an active recording from WebBrain or browser pages                      |

## Documentation

|                                                                                                                          |                                                          |
| ------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------- |
| [Architecture](docs/architecture.md)                                                                                     | System overview, turn flow, subsystems                   |
| [Agent tools](docs/agent-tools.md)                                                                                       | Tiers, modes, and the full tool matrix                   |
| [Slash commands](docs/slash-commands.md)                                                                                 | Every command and flag                                   |
| [Providers and models](docs/providers-and-models.md)                                                                     | All 105 provider cards, local setup, tiers               |
| [Skills](docs/skills.md)                                                                                                 | Bundled skills, importing, skill tools                   |
| [Security model](docs/security-model.md)                                                                                 | Permissions, credentials, trust boundaries               |
| [Prompt-injection defense](docs/prompt-injection-defense.md)                                                             | Defense layers and known gaps                            |
| [Privacy and data flow](docs/privacy-and-data-flow.md)                                                                   | What leaves the browser, and what doesn't                |
| [Accessibility tree and refs](docs/accessibility-tree-and-refs.md)                                                       | How pages are read and targeted                          |
| [Site adapters](docs/site-adapters.md)                                                                                   | Per-site guidance and versioned workflow contracts       |
| [Export and workflow formats](docs/export-and-workflow-formats.md)                                                       | `webbrain-config/1`, `webbrain-workflow/1`               |
| [Adding a tool](docs/adding-a-tool.md) · [Localization](docs/localization.md) · [Test scenarios](docs/test-scenarios.md) | Contributor guides                                       |
| [Community](docs/community.md)                                                                                           | Discord server guide: channels, roles, rules, escalation |

Also available in [中文](docs/zh-CN/) and [Français](docs/fr/).

## Community

Chat about everything WebBrain — help, local and cloud model setups, site
adapters, show-and-tell, and contributor coordination — on the
[WebBrain Discord](https://discord.gg/cgC325ssfw). See
[community](docs/community.md) for how the server is organized, and
[discord-setup](docs/discord-setup.md) for the channel, role, and welcome-screen
configuration. Bug reports and feature requests belong in
[GitHub issues](https://github.com/webbrain-one/webbrain/issues), not Discord.

## Repository layout

```
src/chrome/     Manifest V3 build — service worker, chrome.scripting, sidePanel
src/firefox/    Manifest V2 build — background page, executeScript, sidebar_action
docs/           Design and reference docs (en, zh-CN, fr)
mcp-server/     MCP server — delegate browser tasks from Claude Code, Codex, Cursor
lmstudio-plugin/  Web tools + browser delegation as a standalone LM Studio plugin
web/            Landing site and docs site
test/           Node test suite, LLM scenario benchmarks, security corpora
```

Nearly all agent code is shared between the two builds. See
[architecture](docs/architecture.md#chrome-vs-firefox-key-differences) for where
they diverge.

## Known issues

**Firefox is meaningfully weaker than Chrome.** Firefox has no equivalent to the
Chrome DevTools Protocol via `chrome.debugger`, so the Firefox build has no
shadow-DOM piercing, no real trusted mouse events (some React/Vue handlers won't
fire), no closed-shadow-root traversal, no `resolveSelector` retry budget, no
SPA-navigation-aware retry, and no CDP screenshots. It uses `tabs.captureTab`
for viewport screenshots, including inactive run tabs, but still cannot provide
Chrome's pixel-perfect or full-page CDP capture. Site adapters, vision
detection, loop detection, the auto-screenshot loop, and the Compact prompt/tool
set _are_ mirrored to Firefox. Some single-page apps may also fail to trigger
content-script re-injection after client-side navigation.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). To add a tool, follow the checklist in
[adding a tool](docs/adding-a-tool.md). To add a provider, subclass
`BaseLLMProvider`, implement `chat()` (and optionally `chatStream()`), and
register it in `providers/manager.js` — mirroring both changes to
`src/chrome/` and `src/firefox/`. All providers normalize to
`{ content, toolCalls, usage }`; details in
[providers and models](docs/providers-and-models.md#adding-a-provider).

Recent changes are in [CHANGELOG.md](CHANGELOG.md).

## MCP server

Let a coding agent use *your* browser. Claude Code, Codex, Cursor and OpenClaw
can delegate a task to WebBrain running in the session you are already signed
into — cookies present, SSO already passed. A headless framework starts logged
out and stalls at the first login wall; this does not.

```bash
claude mcp add --transport stdio webbrain -- npx -y @webbrain/mcp-server
```

Claude Code launches the server automatically when it starts an MCP session.
To launch it yourself instead, run the following command and leave that terminal
open (press `Ctrl+C` to stop it):

```bash
npx -y @webbrain/mcp-server
```

Once the server is running, open **WebBrain → Settings → General → Advanced →
MCP**, set the URL to `ws://127.0.0.1:17374/extension`, and enable it.
**Chromium only** — the control and bridge runtime use the extension's off-screen
document, which the Firefox build does not have.

If Settings reports **Connection error: WebSocket error**, nothing is normally
listening at the configured URL. Start the MCP server, confirm that the URL uses
port `17374`, and leave its process running. See the
[`mcp-server` troubleshooting guide](mcp-server/README.md#troubleshooting) for a
listener check and the other bridge ports.

```
webbrain_run(task: "open the Stripe dashboard and list last week's failed
             payments with amounts and customer emails", mode: "ask")
```

Use `webbrain_extract` with a JSON Schema when the caller needs predictable
structured output instead of a prose summary. The server exposes six task-level
tools: run, structured extraction, status, clarification response, abort, and
connection diagnostics.

`mode='ask'` is read-only. `mode='act'` can click and type, gated by the same
in-browser approval prompts a human gets. The server exposes task delegation
rather than the ~50 low-level browser primitives: WebBrain's permission gate
lives in the agent loop, so per-primitive access over a socket would sit below
the gate and bypass it. Details in [`mcp-server/`](mcp-server/).

The complete client setup, tool arguments, run lifecycle, structured-output
examples, safety boundaries, and troubleshooting guide live at
[`web/docs/mcp/`](web/docs/mcp/).

> The extension holds **one** bridge socket at a time — WebBrain Cloud (17373),
> the MCP server (17374), or the LM Studio plugin (17375). Switch by changing
> the URL under **Settings → General → Advanced → MCP**.

## LM Studio plugin

A standalone [LM Studio](https://lmstudio.ai) plugin at
[`webbrain/web-tools`](https://lmstudio.ai/webbrain/web-tools):

```bash
lms clone webbrain/web-tools
```

`fetch_url` and `research_url` are pure Node HTTP — no browser needed, but also
no cookies, no session and no JavaScript. With the extension installed on a
Chromium browser, `browser_task` adds delegation to your real signed-in browser,
reaching the authenticated and client-rendered pages plain HTTP cannot. It
degrades with an actionable message when no extension is attached, and the HTTP
tools keep working on Firefox.

Source: [`lmstudio-plugin/`](lmstudio-plugin/).


## Contributors

<a href="https://github.com/webbrain-one/webbrain/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=webbrain-one/webbrain" />
</a>

## Citation

```bibtex
@software{webbrain2026,
  author = {Sokullu, Emre},
  title = {WebBrain: Open-source AI browser agent for chatting with pages},
  year = {2026},
  publisher = {GitHub},
  url = {https://github.com/webbrain-one/webbrain}
}
```

## License

WebBrain 33.0.0 and later is licensed under
[GPL-3.0-or-later](LICENSE) because the distributed browser extension bundles
and integrates the GPL-licensed Xapian/libzim WebAssembly runtime. Releases
before 33.0.0 remain MIT-licensed under the license that applied when they were
published; that historical text is preserved in [LICENSES/MIT.txt](LICENSES/MIT.txt).

Built with ❤️ by [Emre Sokullu](https://emresokullu.com) and [open-source contributors](https://github.com/webbrain-one/webbrain/graphs/contributors).
