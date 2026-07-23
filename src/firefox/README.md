# WebBrain

Open-source AI browser agent for Chrome and Firefox. Chat with any web page, automate browser tasks, and run multi-step agent workflows — powered by your choice of LLM.

## Features

- **Page Reading** — Extracts text, links, forms, tables, and interactive elements from any page
- **Browser Actions** — Click, type, scroll, navigate, and interact with page elements
- **Ask / Act / Dev Modes** — Read-only by default, normal browser actions on request, and Mid/Full Dev tools for source/style/page debugging
- **Multi-Step Agent** — Autonomous task execution with tool-use loops (configurable, default 130 steps)
- **Continue from Limit** — When the agent hits the step limit, click Continue to keep going
- **Multi-Provider LLM** — WebBrain Cloud plus local llama.cpp/Ollama/LM Studio/Jan/vLLM/SGLang/LocalAI and major direct cloud providers
- **Side Panel UI** — Clean chat interface that lives alongside your browsing
- **Reading-first long replies** — Questions stay visible while answers grow, with controls to follow, jump to the latest content, or return to the question
- **Per-Tab Conversations** — Each tab has its own chat history
- **Ask streaming** — Eligible interactive Ask chats stream official OpenAI Responses text; tools/history wait for terminal completion and interrupted transports fall back safely
- **Smart Context** — Automatic context trimming, tool result limits, and emergency overflow recovery
- **Copy Support** — Copy buttons on code blocks and full messages
- **Page Inspection Banner** — Visual indicator when the agent is interacting with the page
- **Stop Button** — Abort the agent mid-execution at any time
- **Deterministic Action Modes** — Act and Dev use temperature `0.15` for browser-control decisions; Ask uses `0.3`, and dedicated vision screenshot descriptions use `0`

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
3. Navigate to `webbrain/src/firefox/` and select `manifest.json`

> **Note:** Temporary add-ons are removed when Firefox restarts. For permanent installation, the extension needs to be signed via [addons.mozilla.org](https://addons.mozilla.org).

### Start a local LLM (optional)

```bash
# Using llama.cpp
llama-server -m your-model.gguf --port 8080

# Or using Ollama (OpenAI-compatible)
ollama serve
# Then set base URL to http://localhost:11434/v1 in settings
# Or run: ollama launch webbrain --model <model>

# Or using Jan, vLLM, SGLang, or LocalAI (OpenAI-compatible)
# Jan: http://localhost:1337/v1
# vLLM: http://localhost:8000/v1
# SGLang: http://localhost:30000/v1
# LocalAI: http://localhost:8080/v1
```

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
- Max Agent Steps — Configurable step limit (5-195 or unlimited, default 130)
- Plan before Act — Try by default; optionally review a structured Act/Dev plan before browser tools run

**Providers:**

Base URLs are pre-filled in Settings. The complete, current provider/default
model table lives in the [root README](../../README.md#configuration); provider
internals are documented in
[providers-and-models.md](../../docs/providers-and-models.md).

## Architecture

```
src/chrome/                        src/firefox/
├── manifest.json (MV3)            ├── manifest.json (MV2)
├── src/                           ├── src/
│   ├── background.js              │   ├── background.js (+ background.html)
│   ├── run-ui-journal.js          │   ├── run-ui-journal.js
│   ├── agent/                     │   ├── agent/
│   │   ├── agent.js               │   │   ├── agent.js
│   │   └── tools.js               │   │   └── tools.js
│   ├── content/                   │   ├── content/
│   │   └── content.js             │   │   └── content.js
│   ├── providers/                 │   ├── providers/
│   │   ├── base.js                │   │   ├── base.js
│   │   ├── llamacpp.js            │   │   ├── llamacpp.js
│   │   ├── openai.js              │   │   ├── openai.js
│   │   ├── anthropic.js           │   │   ├── anthropic.js
│   │   └── manager.js             │   │   └── manager.js
│   └── ui/                        │   └── ui/
│       ├── sidepanel.html         │       ├── sidepanel.html
│       ├── sidepanel.js           │       ├── sidepanel.js
│       ├── settings.html          │       ├── settings.html
│       └── settings.js            │       └── settings.js
├── styles/                        ├── styles/
│   └── sidepanel.css              │   └── sidepanel.css
└── icons/                         └── icons/
```

Key difference: Chrome uses Manifest V3 (service worker, `chrome.scripting`, `sidePanel` API), Firefox uses Manifest V2 (background page, `browser.tabs.executeScript`, `sidebar_action`).

## Agent Tools

| Tool | Ask Mode | Act Mode | Description |
|------|----------|----------|-------------|
| `read_page` | Yes | Yes | Extract page text, links, forms |
| `screenshot` | Yes | Yes | Capture visible tab |
| `get_interactive_elements` | Yes | Yes | List all clickable/interactive elements |
| `scroll` | Yes | Yes | Scroll the page |
| `extract_data` | Yes | Yes | Extract tables, headings, images |
| `get_selection` | Yes | Yes | Get highlighted text |
| `click` | No | Yes | Click elements by selector, index, or coordinates |
| `type_text` | No | Yes | Type into input fields |
| `navigate` | No | Yes | Go to a URL |
| `wait_for_element` | No | Yes | Wait for a selector to appear |
| `execute_js` | No | Dev only | Run one JavaScript function body through the MV2 content-script evaluator |
| `new_tab` | No | Yes | Open a new tab |
| `done` | Yes | Yes | Signal task completion |

### Dev-mode difference

Firefox keeps Dev-only `execute_js`, but does not expose Chrome's eight CDP-backed reversible/diagnostic additions: `inject_css`, `remove_injected_css`, `patch_element`, `revert_patch`, `read_console`, `inspect_network_requests`, `inspect_event_listeners`, or `highlight_element`. `execute_js` is absent from Ask and normal Act in both builds.

## Known Issues

- **No Chrome DevTools Protocol (CDP)** — Firefox uses synthetic content-script interaction, visible-viewport screenshots, and open-shadow access only. It cannot provide Chrome's trusted events, closed-shadow traversal, full-page CDP screenshots, or CDP diagnostics.
- **File upload limits** — Firefox can re-fetch a prior `downloadId` or open WebBrain's own user file picker, but cannot silently attach an arbitrary local path.
- **Localhost CORS** — Firefox has no offscreen fetch proxy; local model servers must allow extension origins.
- **No tab/screen recording** — Slash-driven recording remains Chrome-only.
- **Firefox temporary add-on** — Firefox requires the extension to be loaded as a temporary add-on during development, which is removed on restart.

## Project Status

Downloads, `downloadId`/user-picker uploads, conversation/config export,
dynamic skill tools, keyboard shortcuts, screenshots/vision, and the official
Firefox Add-ons package are implemented. Use the
[changelog](../../CHANGELOG.md) for shipped changes and the repository issue
tracker for future work.

## Adding a New Provider

1. Create a new class extending `BaseLLMProvider` in `src/providers/`
2. Implement `chat()` and optionally `chatStream()`
3. Register it in `src/providers/manager.js`

All providers normalize to a common response format:
```js
{ content: string, toolCalls: Array|null, usage: Object|null }
```

## Website

The repository `web/` folder contains the landing page for [webbrain.one](https://webbrain.one), deployable to Vercel:

```bash
cd web
vercel dev    # local preview
vercel        # deploy
```

## License

MIT — built by [Emre Sokullu](https://emresokullu.com)
