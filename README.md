<p align="center">
  <img src="assets/logo-mark.png" alt="WebBrain logo" width="92">
</p>

<h1 align="center">WebBrain</h1>

<p align="center">
  Open-source AI browser agent for chatting with pages, automating tasks, and running multi-step workflows with your choice of LLM.
</p>

<p align="center">
  <a href="https://chromewebstore.google.com/detail/webbrain/ljhijonmfahplgbbacgcfnaihbjljhhb"><img src="https://img.shields.io/badge/Chrome-Install-4285F4?style=for-the-badge&amp;logo=googlechrome&amp;logoColor=white" alt="Install WebBrain from the Chrome Web Store"></a>
  <a href="https://addons.mozilla.org/en-US/firefox/addon/webbrain/"><img src="https://img.shields.io/badge/Firefox-Install-FF7139?style=for-the-badge&amp;logo=firefoxbrowser&amp;logoColor=white" alt="Install WebBrain from Firefox Browser Add-ons"></a>
  <a href="https://microsoftedge.microsoft.com/addons/detail/dfbioajafcijomhljabppcelecgdgfeo"><img src="https://img.shields.io/badge/Edge-Install-0A84FF?style=for-the-badge&amp;logo=microsoftedge&amp;logoColor=white" alt="Install WebBrain from Microsoft Edge Add-ons"></a>
</p>

<p align="center">
  <a href="README.md">English</a> ·
  <a href="README.zh-CN.md">中文</a> ·
  <a href="README.fr.md">Français</a> ·
  <a href="https://webbrain.one">Website</a> ·
  <a href="LICENSE">MIT License</a>
</p>

![Claude Chrome vs WebBrain](assets/webbrain-vs-claude-chrome.gif)

## Features

- **Page Reading** — Extracts text, links, forms, tables, and interactive elements from any page
- **Browser Actions** — Click, type, scroll, navigate, and interact with page elements
- **Ask / Act / Dev Modes** — Read-only by default, normal browser actions on request, and Dev add-ons for source/style/page-debugging work
- **Plan before Act** — Act and Dev modes can generate a structured plan, show it for approval, then pin the approved plan to the scratchpad before tools run
- **Multi-Step Agent** — Autonomous task execution with tool-use loops (configurable, default 130 steps)
- **Continue from Limit** — When the agent hits the step limit, click Continue to keep going
- **Multi-Provider LLM** — Supports local and cloud models:
  - **WebBrain Cloud 1.0** (cloud, default) — Built-in managed cloud option; no local setup required
  - **llama.cpp** (local) — No API key needed. Also **Ollama**, **LM Studio**, **Jan**, **vLLM**, **SGLang**, and **LocalAI**
  - **OpenAI** (GPT-5.5, etc.)
  - **Anthropic Claude** (native API)
  - **Google Gemini**, **Mistral AI**, **DeepSeek**, **xAI Grok**, **Groq**
  - **MiniMax**, **Alibaba Cloud (Qwen)**
  - **Cloudflare Workers AI**, **Nvidia NIM**
  - **OpenRouter** (default model: `openrouter/free`; access 100+ models)
- **Onboarding Wizard** — First-launch walkthrough covering Act mode safety and provider setup
- **Side Panel UI** — Clean chat interface that lives alongside your browsing
- **Per-Tab Conversations** — Each tab has its own chat history
- **User Memory** — Optional local memory for user-stated preferences, with explicit `/memory --add` commands and opt-in background auto-learning
- **Streaming** — Real-time token streaming from all providers
- **Smart Context** — Token-aware auto-compaction (summarizes older turns once the conversation nears the model's context window, with a visible "Context automatically compacted" notice), tool result limits, and emergency overflow recovery
- **Browser History Control** — Act mode can use native `go_back` / `go_forward` history tools instead of CSP-sensitive page JavaScript
- **API Shortcut Hints** — Repeated clicks that fire the same XHR/fetch request can surface a matching `fetch_url` suggestion while preserving the UI-first and `/allow-api` mutation policy
- **Custom Skills and Skill Tools** — Settings → Skills can import trusted skill text or URLs; skills may also expose HTTP or download-job tools through a `webbrain-tools` manifest. FreeSkillz.xyz is enabled by default for YouTube transcripts and public media downloads, and can be removed.
- **Copy Support** — Copy buttons on code blocks and full messages
- **Page Inspection Banner** — Visual indicator when the agent is interacting with the page
- **Stop Button** — Abort the agent mid-execution at any time
- **Deterministic Action Modes** — Act and Dev modes use temperature `0.15` for browser-control decisions; Ask mode uses `0.3`, and dedicated vision screenshot descriptions use `0`

## Quick Start

### Chrome

```bash
git clone https://github.com/webbrain-one/webbrain.git
```

1. Open Chrome → `chrome://extensions/`
2. Enable **Developer mode** (top right)
3. Click **Load unpacked** → select the `webbrain/src/chrome` folder

### Firefox

```bash
git clone https://github.com/webbrain-one/webbrain.git
```

1. Open Firefox → `about:debugging#/runtime/this-firefox`
2. Click **Load Temporary Add-on**
3. Navigate to `src/firefox/` and select `manifest.json`

> **Note:** Temporary add-ons are removed when Firefox restarts. For permanent installation, the extension needs to be signed via [addons.mozilla.org](https://addons.mozilla.org).

### Start a local LLM (default)

```bash
# Using llama.cpp
llama-server -m your-model.gguf --port 8080

# Or using Ollama (OpenAI-compatible)
ollama serve
# Then set base URL to http://localhost:11434/v1 in settings
# Or run: ollama launch webbrain --model <model>

# Or using Jan (OpenAI-compatible)
# Start Jan's local API server and use http://localhost:1337/v1

# Or using vLLM / SGLang (OpenAI-compatible)
vllm serve your-model --port 8000
python -m sglang.launch_server --model-path your-model --port 30000
```

### Ollama launch handoff (preview)

<p align="center">
  <img src="web/assets/webbrain-ollama-heart.png" alt="WebBrain loves Ollama launch handoff" width="720">
</p>

WebBrain supports Ollama today through the local OpenAI-compatible provider. A new `ollama launch webbrain --model <model>` handoff can also configure WebBrain automatically, but it is not integrated into upstream Ollama yet. For now, try it from the [`codex/ollama-webbrain-launch-handoff` branch of `esokullu/ollama`](https://github.com/esokullu/ollama/tree/codex/ollama-webbrain-launch-handoff); we hope Ollama will integrate it upstream.

```bash
git clone https://github.com/esokullu/ollama.git
cd ollama
git switch codex/ollama-webbrain-launch-handoff
cmake -S . -B build -G Ninja -DOLLAMA_MLX_BACKENDS=
cmake --build build --parallel 8

OLLAMA_ORIGINS="chrome-extension://*,moz-extension://*" ./ollama serve
./ollama launch webbrain --model <model>
```

> **Context window:** For reliable agent runs, load a local model with **at least a 16k-token context window** (the usable minimum). 8k can work with **Compact mode** enabled (Settings → per-provider Prompt tier); 4k is too small to hold the system prompt + tool schemas. WebBrain auto-compacts the conversation as it nears the window. Local providers default to 16k unless you set an explicit size in Settings. **Test connection** / **Load models** auto-detect the real window for **llama.cpp**, **Ollama**, and **LM Studio** when those backends report it (llama.cpp `/props`, Ollama `/api/ps` then `/api/show` `num_ctx`, LM Studio `/api/v0/models`). Detection refreshes the default 16k; it shrinks a larger manual override only from live/runtime context (llama.cpp `/props`, Ollama `/api/ps`, LM Studio loaded context). Other local backends (Jan, vLLM, SGLang, LocalAI) keep the manual/default value.

### Use it

Click the WebBrain icon → the side panel opens. Type a message like:

- "Summarize this page"
- "Find all links about pricing"
- "Fill in the search box with 'AI agents' and click Search"
- "Navigate to github.com and find trending repositories"

## Configuration

Click the gear icon or go to the extension's Options page to configure:

**Display Settings:**
- Verbose Mode — Show full tool call JSON (off by default)
- Auto-screenshot — Provide visual context when DOM/page reads are insufficient
- Max Agent Steps — Configurable step limit (5-200, default 60)
- Plan before Act — Optionally generate and review a structured Act-mode plan before browser tools run (try mode by default; explicit off is preserved)

**Profile and Memory:**
- Profile auto-fill and user memory are stored in plaintext browser local storage.
- User memory can be managed from Settings -> Profile or with `/memory`, `/memory --add <text>`, and `/memory --forget <id>`.
- When enabled, active memory records are sent to the configured LLM provider as part of the system prompt; optional auto-learning makes a best-effort provider call only after a turn completes.

**Skills:**
- FreeSkillz.xyz ships enabled by default and exposes `read_youtube_transcript`, `resolve_public_media`, and `download_public_media` through its skill manifest; remove it from Settings → Skills if you do not want those tools available.
- Imported skills are copied into browser local storage and appended to the agent's system prompt when enabled.
- A skill can expose read-only HTTP tools or short-lived download-job tools with a fenced `webbrain-tools` JSON manifest. Importing a skill is the trust boundary for its declared HTTPS endpoint; download-job skill tools still run in Act mode and use the normal Downloads permission gate before saving files.
- Tool results from third-party content should be marked `resultPolicy: "untrusted"` so they are wrapped as data, not instructions.

**Providers:**

| Provider | Base URL | API Key | Default Model |
|----------|----------|---------|---------------|
| llama.cpp | `http://localhost:8080` | Not needed | (your loaded model) |
| Ollama | `http://localhost:11434/v1` | Not needed | (your loaded model) |
| LM Studio | `http://localhost:1234/v1` | Not needed | (your loaded model) |
| Jan | `http://localhost:1337/v1` | Not needed | (your loaded model) |
| vLLM | `http://localhost:8000/v1` | Optional | (your served model) |
| SGLang | `http://localhost:30000/v1` | Optional | (your served model) |
| LocalAI | `http://localhost:8080/v1` | Optional | (your loaded model) |
| OpenAI | `https://api.openai.com/v1` | Required | gpt-5.5 |
| Anthropic Claude | `https://api.anthropic.com` | Required | claude-sonnet-4-6 |
| Google Gemini | `https://generativelanguage.googleapis.com/v1beta/openai` | Required | gemini-3.1-flash |
| Cloudflare Workers AI | `https://api.cloudflare.com/client/v4/accounts/{account_id}/ai/v1` | Required (plus Account ID) | @cf/zai-org/glm-5.2 |
| Mistral AI | `https://api.mistral.ai/v1` | Required | mistral-large-latest |
| DeepSeek | `https://api.deepseek.com/v1` | Required | deepseek-v4-flash |
| xAI Grok | `https://api.x.ai/v1` | Required | grok-4.3 |
| Nvidia NIM | `https://integrate.api.nvidia.com/v1` | Required | meta/llama-3.1-8b-instruct |
| Groq | `https://api.groq.com/openai/v1` | Required | llama-3.3-70b-versatile |
| MiniMax | `https://api.minimax.chat/v1` | Required | minimax-m2.7 |
| Alibaba Cloud (Qwen) | `https://dashscope.aliyuncs.com/compatible-mode/v1` | Required | qwen-max |
| OpenRouter | `https://openrouter.ai/api/v1` | Required | openrouter/free |

## Architecture

```
src/chrome/                        src/firefox/
├── manifest.json (MV3)            ├── manifest.json (MV2)
├── src/                           ├── src/
│   ├── background.js              │   ├── background.js (+ background.html)
│   ├── agent/                     │   ├── agent/
│   ├── content/                   │   ├── content/
│   ├── providers/                 │   ├── providers/
│   ├── network/                   │   ├── network/
│   ├── trace/                     │   ├── trace/
│   ├── ui/                        │   └── ui/
│   └── offscreen/                 ├── styles/
├── styles/                        ├── icons/
└── icons/                         └── LICENSE

web/
├── index.html
├── privacy.html
└── vercel.json
```

Key difference: Chrome uses Manifest V3 (service worker, `chrome.scripting`, `sidePanel` API), Firefox uses Manifest V2 (background page, `browser.tabs.executeScript`, `sidebar_action`).

Deeper docs live in [`docs/`](docs/): [architecture](docs/architecture.md), [site adapters](docs/site-adapters.md), [providers and models](docs/providers-and-models.md), [security model](docs/security-model.md), [prompt-injection defense](docs/prompt-injection-defense.md), [privacy and data flow](docs/privacy-and-data-flow.md), [accessibility tree and refs](docs/accessibility-tree-and-refs.md), [localization](docs/localization.md), [adding a tool](docs/adding-a-tool.md), and [test scenarios](docs/test-scenarios.md).

## Agent Tools

WebBrain separates model tier from conversation mode:

- **Tier** (`compact`, `mid`, `full`) controls how many normal browser-agent tools a model sees.
- **Mode** (`ask`, `act`, `dev`) controls what kind of task the user is allowing. Ask is read-only. Act exposes the selected tier's normal tools. Dev requires a Mid or Full provider and adds a small source/style/debug tool appendix, including deeper DOM/frame inspection for Mid-tier Dev runs.

| Tool | Ask | Compact Act | Mid Act | Full Act | Dev Add-on |
|---|---:|---:|---:|---:|---:|
| `get_accessibility_tree` | Yes | Yes | Yes | Yes | No |
| `read_page` | Yes | Yes | Yes | Yes | No |
| `read_pdf` | Yes | No | Yes | Yes | No |
| `read_page_source` | No | No | No | No | Yes |
| `get_window_info` | Yes | Yes | Yes | Yes | No |
| `get_interactive_elements` | Yes | No | Yes | Yes | No |
| `scroll` | Yes | Yes | Yes | Yes | No |
| `extract_data` | Yes | Yes | Yes | Yes | No |
| `inspect_element_styles` | No | No | No | No | Yes |
| `wait_for_stable` | Yes | No | Yes | Yes | No |
| `get_selection` | Yes | Yes | Yes | Yes | No |
| `done` | Yes | Yes | Yes | Yes | No |
| `clarify` | No | Yes | Yes | Yes | No |
| `fetch_url` | Yes | Yes | Yes | Yes | No |
| `research_url` | Yes | No | Yes | Yes | No |
| `list_downloads` | Yes | No | Yes | Yes | No |
| `click_ax` | No | Yes | Yes | Yes | No |
| `type_ax` | No | Yes | Yes | Yes | No |
| `set_field` | No | Yes | Yes | Yes | No |
| `resize_window` | No | No | No | Yes | No |
| `click` | No | Yes | Yes | Yes | No |
| `type_text` | No | Yes | Yes | Yes | No |
| `press_keys` | No | Yes | Yes | Yes | No |
| `navigate` | No | Yes | Yes | Yes | No |
| `wait_for_element` | No | Yes | Yes | Yes | No |
| `new_tab` | No | Yes | Yes | Yes | No |
| `scratchpad_write` | No | Yes | Yes | Yes | No |
| `progress_update` | No | Yes | Yes | Yes | No |
| `progress_read` | No | Yes | Yes | Yes | No |
| `download_social_media` | No | No | Yes | Yes | No |
| `solve_captcha` | No | No | Yes | Yes | No |
| `go_back` | No | No | Yes | Yes | No |
| `go_forward` | No | No | Yes | Yes | No |
| `schedule_resume` | No | No | Yes | Yes | No |
| `schedule_task` | No | No | Yes | Yes | No |
| `iframe_read` | No | No | Yes | Yes | No |
| `iframe_click` | No | No | Yes | Yes | No |
| `iframe_type` | No | No | Yes | Yes | No |
| `read_downloaded_file` | No | No | Yes | Yes | No |
| `download_files` | No | No | Yes | Yes | No |
| `download_resource_from_page` | No | No | Yes | Yes | No |
| `upload_file` | No | No | Chrome | Chrome | No |
| `verify_form` | No | No | Yes | Yes | No |
| `hover` | No | No | No | Yes | No |
| `drag_drop` | No | No | No | Yes | No |
| `get_shadow_dom` | No | No | No | Yes | Yes |
| `shadow_dom_query` | No | No | No | Chrome | Chrome |
| `get_frames` | No | No | No | Yes | Yes |
| `execute_js` | No | No | No | No | Firefox |

Enabled skills can append additional tool schemas at runtime. For example,
the bundled FreeSkillz.xyz skill exposes `read_youtube_transcript` for YouTube
transcripts plus `resolve_public_media` / `download_public_media` for public
media URLs. These skill tools are not hard-coded in the static table above:
if the skill is removed or renamed, the tool disappears or appears under the
manifest's declared name.

Dev Add-on tools are only exposed in Dev mode, and Dev mode is blocked for Compact-tier providers.

**Compact tier** is a reduced normal-tool set + shorter system prompt designed for smaller local models. **Mid tier** keeps common task tools, iframe support, downloads, scheduling, and form verification while avoiding advanced DOM/UI fallbacks. **Full tier** adds advanced browser-operation tools such as hover, drag-drop, frames, and shadow DOM. Enable the tier per provider in Settings.

> **Shadow DOM note:** The accessibility tree only traverses light DOM. On Web Component-heavy pages (Stripe, Salesforce, Shopify), use `get_interactive_elements` first; in Full Act or Dev mode, use `get_shadow_dom` / `shadow_dom_query` for targeted reads.

## LM Studio plugin

The `fetch_url` and `research_url` tools also ship as a standalone
[LM Studio](https://lmstudio.ai) plugin at
[`webbrain/web-tools`](https://lmstudio.ai/webbrain/web-tools), for
users who want web-fetching tool-use inside LM Studio chats without
running the full browser extension. Pure Node, no headless browser.

```bash
lms clone webbrain/web-tools
```

Source: [`lmstudio-plugin/`](./lmstudio-plugin/).

## Slash Commands

WebBrain accepts slash commands as the first thing on a line in the input box. Type `/help` to see complete usage signatures and flag descriptions inside the panel. Typing a canonical command followed by a space opens autocomplete for its available flags.

| Command | What it does |
|---------|--------------|
| `/help` | Show the list of available commands |
| `/schedule [prompt]` | Create a scheduled task, optionally prefilling its prompt |
| `/schedule --list` | Show scheduled tasks |
| `/progress` | Show the current progress ledger |
| `/scratchpad` | Show the current scratchpad |
| `/scratchpad --append <text>` | Append text to the current scratchpad |
| `/scratchpad --clear` | Clear the current scratchpad |
| `/memory` | Show saved user memory |
| `/memory --add <text>` | Save a user preference to memory |
| `/memory --forget <id>` | Forget a saved memory by ID |
| `/allow-api` | **Per-conversation API mutation override.** Lifts the UI-first restriction so the agent may use POST/PUT/PATCH/DELETE via `fetch_url` when UI is failing. Badge appears while active; clears on `/reset`. |
| `/dangerously-skip-permissions` | **Global permission-prompt bypass.** Turns off `Ask before consequential actions` without opening Settings. WebBrain will act without per-site prompts until you re-enable the setting. |
| `/compact` | Force context compaction for the current conversation |
| `/verbose` | Toggle verbose/compact tool display |
| `/reset` | Clear the conversation and all per-conversation flags |
| `/screenshot [--full-page]` | Capture the visible tab, or the full scrollable page with `--full-page` (Chrome only) |
| `/record [--full-screen] [--transcribe]` | Record the current tab, or a selected screen/window with `--full-screen` (Chrome only); add `--transcribe` to save a transcript after stop |
| `/export [--traces]` | Download the conversation as Markdown, or export the tool chain with `--traces` |
| `/profile` | Toggle profile auto-fill on/off without opening Settings |
| `/vision` | Toggle vision mode (screenshot understanding) on the active provider |
| `/ask` | Switch to Ask mode before sending |
| `/act` | Switch to Act mode before sending |
| `/dev` | Switch to Dev mode before sending |
| `/plan` | Switch to Ask mode with planning intent |

The default UI-first rule exists because API actions are invisible (you don't see what's being sent), often require separate auth tokens you may not have configured, and can have a much larger blast radius than a visible mis-click. Only use `/allow-api` when you've decided you want that tradeoff for a specific job.

## Keyboard Shortcuts

Chrome side panel shortcuts work when the WebBrain side panel has focus.

| Shortcut | What it does |
|----------|--------------|
| `Ctrl+/` or `Cmd+/` | Focus the input |
| `Ctrl+Shift+A` or `Cmd+Shift+A` | Switch to Ask mode |
| `Ctrl+Shift+X` or `Cmd+Shift+X` | Switch to Act mode |
| `Ctrl+Shift+D` or `Cmd+Shift+D` | Switch to Dev mode |
| `Escape` | Stop the active run, unless it is only dismissing slash-command autocomplete |
| `Escape` twice | Stop an active recording from WebBrain or browser pages |

## Known Issues

- **Firefox is meaningfully weaker than Chrome.** Firefox has no equivalent to Chrome DevTools Protocol via `chrome.debugger`, so several Chrome-only features are missing in the Firefox build:
  - Click/type goes through the content-script path (`document.querySelector` + `el.click()`) instead of CDP `Input.dispatchMouseEvent`. This means **no shadow-DOM piercing**, **no real trusted mouse events** (some React/Vue handlers won't fire), **no closed-shadow-root traversal**, and **no `resolveSelector` retry budget**.
  - **No SPA-navigation-aware retry extension.**
  - **No conversation persistence** across background restarts.
  - **No CDP screenshots.** Auto-screenshot uses `tabs.captureVisibleTab` instead, which works for active tabs only and at slightly lower quality.
  - **No closed shadow root support** for read/extract tools.
  - Site adapters, vision detection, loop detection, the auto-screenshot loop, and the opt-in compact prompt/tool set *are* mirrored to Firefox.
- **SPA navigation detection in Firefox.** Some single-page applications may not trigger content-script re-injection after client-side navigation.
- **Firefox temporary add-on** — Firefox requires the extension to be loaded as a temporary add-on during development, which is removed on restart.

## What's New

See [CHANGELOG.md](./CHANGELOG.md) for the full version history. Recent highlights include Plan before Act, native browser-history tools, repeated-click API shortcut hints, WebBrain Cloud 1.0, scheduled tasks, compact-mode improvements, and native PDF reading.

## Adding a New Provider

1. Create a new class extending `BaseLLMProvider` in `src/providers/`
2. Implement `chat()` and optionally `chatStream()`
3. Register it in `src/providers/manager.js`

All providers normalize to a common response format:
```js
{ content: string, toolCalls: Array|null, usage: Object|null }
```


## Star History

<a href="https://www.star-history.com/?repos=webbrain-one%2Fwebbrain&type=date&legend=top-left">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=webbrain-one/webbrain&type=date&theme=dark&legend=top-left&sealed_token=pEVOa2e14jxSLxQdCH2zPHJpjdCUYgWImET-_h_dgTuQYqEzR3f5pOzIyYGKN_gFHT-oZqKTM_yZfWHwwMtmM0Jb5YZvGgyuF6cF-w4vHVDdkJoUirCJjQ" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=webbrain-one/webbrain&type=date&legend=top-left&sealed_token=pEVOa2e14jxSLxQdCH2zPHJpjdCUYgWImET-_h_dgTuQYqEzR3f5pOzIyYGKN_gFHT-oZqKTM_yZfWHwwMtmM0Jb5YZvGgyuF6cF-w4vHVDdkJoUirCJjQ" />
   <img alt="Star History Chart" src="https://api.star-history.com/chart?repos=webbrain-one/webbrain&type=date&legend=top-left&sealed_token=pEVOa2e14jxSLxQdCH2zPHJpjdCUYgWImET-_h_dgTuQYqEzR3f5pOzIyYGKN_gFHT-oZqKTM_yZfWHwwMtmM0Jb5YZvGgyuF6cF-w4vHVDdkJoUirCJjQ" />
 </picture>
</a>

## Contributors

<a href="https://github.com/webbrain-one/webbrain/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=webbrain-one/webbrain" />
</a>

## License

MIT — built by [Emre Sokullu](https://emresokullu.com)
