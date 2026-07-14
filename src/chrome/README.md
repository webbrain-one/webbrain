# WebBrain

Open-source AI browser agent for Chrome, Microsoft Edge, and Firefox. Chat with any web page, automate browser tasks, and run multi-step agent workflows — powered by your choice of LLM.

## Features

- **Page Reading** — Extracts text, links, forms, tables, and interactive elements from any page
- **Browser Actions** — Click, type, scroll, navigate, and interact with page elements
- **Ask / Act Modes** — Read-only mode by default, full agent mode with confirmation
- **Multi-Step Agent** — Autonomous task execution with tool-use loops (configurable, default 60 steps)
- **Continue from Limit** — When the agent hits the step limit, click Continue to keep going
- **Multi-Provider LLM** — Supports local and cloud models:
  - **llama.cpp** (local, default) — No API key needed. Also Ollama, LM Studio, Jan, vLLM, and SGLang
  - **OpenAI** (GPT-4o, etc.)
  - **OpenRouter** (default model: `openrouter/free`; access 100+ models)
  - **Anthropic Claude** (native API)
- **Side Panel UI** — Clean chat interface that lives alongside your browsing
- **Per-Tab Conversations** — Each tab has its own chat history
- **Streaming** — Real-time token streaming from all providers
- **Smart Context** — Automatic context trimming, tool result limits, and emergency overflow recovery
- **Copy Support** — Copy buttons on code blocks and full messages
- **Page Inspection Banner** — Visual indicator when the agent is interacting with the page
- **Stop Button** — Abort the agent mid-execution at any time
- **Deterministic Act Mode** — Act mode uses temperature `0.15` for browser-control decisions; Ask mode uses `0.3`, and dedicated vision screenshot descriptions use `0`

## Quick Start

### Chrome

```bash
git clone https://github.com/webbrain-one/webbrain.git
```

1. Open Chrome → `chrome://extensions/`
2. Enable **Developer mode** (top right)
3. Click **Load unpacked** → select the `webbrain/src/chrome` folder

### Microsoft Edge

```bash
git clone https://github.com/webbrain-one/webbrain.git
```

1. Open Edge → `edge://extensions/`
2. Enable **Developer mode** (left sidebar)
3. Click **Load unpacked** → select the `webbrain/src/chrome` folder

The Edge package uses the same Manifest V3 build as Chrome. The extension APIs
still use the Chromium `chrome.*` namespace in code, which is supported by
Microsoft Edge.

### Firefox

```bash
git clone https://github.com/webbrain-one/webbrain.git
```

1. Open Firefox → `about:debugging#/runtime/this-firefox`
2. Click **Load Temporary Add-on**
3. Navigate to `webbrain/src/firefox/` and select `manifest.json`

> **Note:** Temporary add-ons are removed when Firefox restarts. For permanent installation, the extension needs to be signed via [addons.mozilla.org](https://addons.mozilla.org).

### Start a local LLM (default)

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
- Screenshot Fallback — Use screenshots when DOM reading fails
- Max Agent Steps — Configurable step limit (5-200, default 60)

**Providers:**

| Provider | Base URL | API Key |
|----------|----------|---------|
| llama.cpp | `http://localhost:8080` | Not needed |
| Ollama | `http://localhost:11434/v1` | Not needed |
| LM Studio | `http://localhost:1234/v1` | Not needed |
| Jan | `http://localhost:1337/v1` | Not needed |
| vLLM | `http://localhost:8000/v1` | Optional |
| SGLang | `http://localhost:30000/v1` | Optional |
| LocalAI | `http://localhost:8080/v1` | Optional |
| OpenAI | `https://api.openai.com/v1` | Required |
| OpenRouter | `https://openrouter.ai/api/v1` | Required |
| Anthropic | `https://api.anthropic.com` | Required |

## Architecture

```
src/chrome/ (Chrome/Edge MV3)      src/firefox/ (Firefox MV2)
├── manifest.json                  ├── manifest.json
├── src/                           ├── src/
│   ├── background.js              │   ├── background.js (+ background.html)
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
├── web/                           └── icons/
│   ├── index.html
│   └── vercel.json
└── icons/
```

Key difference: Chrome and Edge use Manifest V3 (service worker, `chrome.scripting`, `sidePanel` API), Firefox uses Manifest V2 (background page, `browser.tabs.executeScript`, `sidebar_action`).

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
| `inject_css` | No | Dev only | Inject reversible temporary CSS |
| `remove_injected_css` | No | Dev only | Remove CSS by patchId |
| `patch_element` | No | Dev only | Patch styles/classes/attributes with before/after values |
| `revert_patch` | No | Dev only | Restore an element patch by patchId |
| `execute_js` | No | Dev only | Run one async JavaScript function body through CDP |
| `read_console` | No | Dev only | Read buffered console messages and exceptions |
| `inspect_network_requests` | No | Dev only | Inspect redacted request/status/timing data |
| `inspect_event_listeners` | No | Dev only | Inspect listeners on a ref/selector and ancestors |
| `highlight_element` | No | Dev only | Show a temporary target overlay |
| `new_tab` | No | Yes | Open a new tab |
| `done` | Yes | Yes | Signal task completion |

### Dev-mode page tools

The nine tools above are added only in Mid/Full Dev mode; they are absent from Ask and normal Act. `inject_css` and `patch_element` return patch IDs for their matching undo tools. CSS patch IDs are unique and document-bound, so navigation invalidates an old undo handle rather than applying it to a replacement document. Element patches canonicalize CSS property and HTML attribute names before recording undo state, reject contradictory set/remove requests, and block `javascript:` in executable URL attributes including form `action`. Chrome runs `execute_js` in the page main world through CDP with a 15-second limit, so MV3 extension-page CSP remains intact; JavaScript execution is host-permission gated and always receives a fresh submit confirmation.

Console and network capture start before both streaming and non-streaming Dev runs, use bounded in-memory buffers, and report that earlier activity may be unavailable. The handlers and buffers are removed and the matching Runtime, Log, and Network CDP domains are disabled when the tab leaves Dev mode or its conversation is cleared; leaving the panel-wide Dev mode drains every tab with active diagnostics, even after a tab switch. Listener inspection briefly adds and restores an internal target attribute, follows open-shadow hosts when collecting ancestors, and element highlighting inserts a temporary overlay; both tools therefore require the temporary page-modification permission. Network headers and bodies are omitted unless explicitly requested, and sensitive header names—including common API/subscription-key variants—are redacted before storage. Diagnostic and page-derived tool results are wrapped as untrusted content before they return to the model.

## Known Issues

- **No file download/upload support** — The agent cannot download files from pages or upload files to file inputs. This is a limitation of the content script architecture. Planned for a future release via the Chromium `chrome.downloads` API and CDP integration.
- **Debugger attachment is visible** — Chrome shows its standard debugger-attached indicator while CDP-backed actions or Dev diagnostics are active. This is expected for trusted input, screenshots, closed-shadow access, uploads, and the Dev-only JavaScript/console/network/listener tools.
- **Shadow DOM limitations** — Web components using closed shadow DOM cannot be read or interacted with by the content script.
- **SPA navigation detection** — Some single-page applications may not trigger content script re-injection after client-side navigation.
- **Firefox temporary add-on** — Firefox requires the extension to be loaded as a temporary add-on during development, which is removed on restart.

## Roadmap

- [ ] **CDP integration** — Optional Chrome DevTools Protocol mode for advanced page access (network, shadow DOM, cross-origin frames, precise screenshots)
- [ ] **File download** — Download files from pages via `chrome.downloads` API
- [ ] **File upload** — Upload files to `<input type="file">` elements via CDP `DOM.setFileInputFiles`
- [ ] **Conversation export/import** — Save and load chat histories
- [ ] **Custom tool definitions** — User-defined tools via settings
- [ ] **Keyboard shortcuts** — Hotkeys for opening panel, sending messages, switching modes
- [ ] **Context menu integration** — Right-click → "Ask WebBrain about this"
- [ ] **Screenshot/vision tool** — Send screenshots to multimodal models for visual understanding
- [ ] **Chrome Web Store / Microsoft Edge Add-ons / Firefox AMO** — Official store listings

## Adding a New Provider

1. Create a new class extending `BaseLLMProvider` in `src/providers/`
2. Implement `chat()` and optionally `chatStream()`
3. Register it in `src/providers/manager.js`

All providers normalize to a common response format:
```js
{ content: string, toolCalls: Array|null, usage: Object|null }
```

## Website

The `web/` folder contains the landing page for [webbrain.me](https://webbrain.me), deployable to Vercel:

```bash
cd web
vercel dev    # local preview
vercel        # deploy
```

## License

MIT — built by [Emre Sokullu](https://emresokullu.com)
