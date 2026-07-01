# Privacy & Data Flow

---

## What Leaves the Browser

### LLM Provider Requests

The user's message, the current page content (AX tree, screenshot, or extracted text), and the tool-call history are sent to the **configured LLM provider** on every turn.

| Data | Sent to provider? | Notes |
|---|---|---|
| User's chat message | Yes | This is the core feature — the user typed it |
| Page URL + title | Yes | Injected into the first user message for context |
| Page content (AX tree / extracted text) | Yes | The agent reads the page to act on it |
| Viewport screenshot | Yes | If the provider supports vision (or a dedicated vision model is configured) |
| Tool call history | Yes | Previous tool results are context for the next LLM call |
| User credentials (passwords, API keys) | Yes | If the user types them in chat or the agent fills them and they appear in tool results |
| Provider API key | Yes | Sent as an HTTP header (Bearer token) to the provider's API endpoint |

When **Plan before Act** is enabled, Act-mode turns make an additional planner
call to the same configured provider before any browser tools run. That call
contains the user's task, sanitized page URL/title, a short recent-conversation
digest, and the planner system prompt. Image blocks are dropped before the
planner call; any screenshot text description is treated as untrusted context.

**No other data is sent to the provider.** The extension does not inject tracking, telemetry, or analytics.

### Which provider receives the data?

The user chooses their provider in Settings. Options include:

- **Cloud providers**: OpenAI, Anthropic, Google Gemini, Mistral, DeepSeek, xAI, Groq, OpenRouter, etc. — data leaves the user's machine for these
- **Local providers**: llama.cpp, Ollama, LM Studio, Jan, vLLM, SGLang — data stays on the user's machine

The extension itself never receives or stores user data on any remote server.

---

## What Stays in the Browser

### Conversation History

Stored in `chrome.storage.session` (Chrome) or in-memory (Firefox). Used to restore conversation across service-worker restarts. Never transmitted.

### Trace Recorder

When enabled (Settings → Display → "Record traces"), every agent run is written to an IndexedDB database (`webbrain_traces`):

- **`runs` store**: model, provider, token totals, timestamps, user message, final content
- **`events` store**: per-step LLM requests/responses, tool calls with args and results
- **`shots` store**: screenshot blobs

The Traces page (`ui/traces.html`) reads from local IndexedDB only. Export produces a JSON blob saved to the user's Downloads folder. **No trace data ever leaves the browser.**

### Settings

Provider configs (API keys, base URLs, model selections) are stored in `chrome.storage.local`. API keys are in plaintext — this is a personal-computer tool and the storage is sandboxed by the browser. The extension has no mechanism to exfiltrate these keys.

### User Profile

If the user enables profile auto-fill, the profile text (name, email, throwaway password) is stored in `chrome.storage.local` in plaintext and sent to the LLM provider as part of the system prompt on every turn.

### API Shortcut Observer

The background script keeps a small in-memory buffer of same-tab XHR/fetch
metadata: URL, HTTP method, and timestamp for the last 40 observed requests per
tab. It is used only when loop detection sees repeated clicks, so the agent can
suggest the exact matching `fetch_url` call instead of clicking again. Request
bodies and response bodies are not captured. The buffer is deleted when the tab
closes, and no observer data leaves the browser unless a loop warning surfaces
the URL + method to the active LLM conversation.

---

## Telemetry / Analytics

**None.** The extension does not include any analytics SDK, telemetry, crash reporting, or usage tracking. There is no "phone home" endpoint.

The only outbound HTTP requests are:
1. **LLM provider API calls** (to URLs the user configured)
2. **CapSolver API calls** (if the user enables CAPTCHA solving)
3. **Content fetches** via `fetch_url` / `research_url` tools (to URLs the agent is asked to fetch)
4. **Skill tool calls** (to the HTTPS endpoint(s) declared by enabled skills — see "Bundled Skills" below for the one enabled by default)
5. **Tab recording** creates no outbound traffic (the .webm is saved to the Downloads folder via `chrome.downloads.download`)

The opt-in `webRequest` API shortcut observer is off by default and does not
create outbound requests; when enabled, it observes replay metadata for requests
the page already made so repeated UI mutations can be diagnosed.

### Bundled Skills

A built-in "FreeSkillz.xyz" skill (`skills/freeskillz-xyz.md`) is seeded into
Settings → Skills on first run, enabled by default, and can be removed there.
It declares `read_youtube_transcript`, `resolve_public_media`, and
`download_public_media` tools. When the model calls one of those tools,
WebBrain sends only the current or model-provided URL, plus declared options
such as transcript language, media kind, maximum height, or filename hint, to
the declared `https://freeskillz.xyz` endpoint over HTTPS — a first-party
service operated by the extension's developer, separate from the user's
configured LLM provider. The transcript tool is limited to YouTube/youtu.be
URLs, while the media tools are limited to public media hosts declared in the
skill manifest. The read-only transcript and resolver tools do not require
`/allow-api`; `download_public_media` is available only in Act mode and
requires download permission because it creates a short-lived provider job,
saves the completed file through the browser Downloads API, and then asks the
provider to delete the job. These calls do not send page content, chat history,
or browsing history beyond the URL and declared tool arguments. Users can
remove this skill, or any user-imported skill tool, from Settings → Skills to
stop this data flow entirely.

---

## Data Flow Diagrams

### Basic Chat Turn

```
User types message
  │
  ▼
Side panel → Background (chrome.runtime.sendMessage)
  │
  ▼
Agent enriches: URL + title + adapter notes + (optional) screenshot
  │
  ▼
Optional Plan before Act call: provider.chat(planner messages, no tools)
  │
  ▼
Agent calls provider.chat(messages, tools)
  ├─ Provider API key → HTTP header to provider endpoint
  ├─ Messages + page content → HTTP body to provider endpoint
  │
  ▼
Provider returns → agent executes tool calls → results appended
  │
  ▼
Loop until done → background sends final reply → side panel displays
```

### Trace Recording Flow (when enabled)

```
Agent turn
  │
  ├─ startRun()     → IndexedDB.runs   { runId, model, userMessage, ... }
  ├─ recordLLMRequest()  → IndexedDB.events  { runId, seq, kind:'llm_request', ... }
  ├─ recordLLMResponse() → IndexedDB.events  { runId, seq, kind:'llm_response', ... }
  ├─ recordToolCall()    → IndexedDB.events  { runId, seq, kind:'tool', ... }
  ├─ recordScreenshot()  → IndexedDB.shots   { runId, seq, blob } + events marker
  └─ endRun()       → IndexedDB.runs   (update duration, tokens, status)
```

All IndexedDB reads happen only when the user opens the Traces page.

### Screenshot Flow

```
CDP capture → JPEG/PNG data URL
  │
  ├─ If dedicated vision model configured → sub-call to describe → text description
  │   → only the description text is sent to the main provider
  │
  ├─ If main provider supports vision → image_url block attached to user message
  │   → the image is visible to the LLM
  │
  └─ If no vision → screenshot still captured for internal state, but image data is not sent to the model
```

---

## Security Boundaries

| Boundary | Data crossing it | Protected by |
|---|---|---|
| Browser ↔ LLM provider | Chat messages, page content, screenshot | HTTPS; user chose the provider |
| Browser ↔ CapSolver | CAPTCHA token requests | HTTPS; user opted in |
| Extension ↔ Offscreen document | Fetch proxy requests | Same extension, same origin |
| Service worker ↔ IndexedDB | Trace data | Browser sandbox; never transmitted |
| Service worker ↔ `chrome.storage.local` | API keys, settings | Browser sandbox (plaintext) |

---

## User Controls

| Setting | Effect |
|---|---|
| Provider selection | Choose which LLM receives the data, or run locally |
| Tracing toggle | Prevents any trace data from being stored |
| Screenshot fallback | Controls whether page images are sent to the LLM |
| Auto-screenshot mode | Controls how frequently viewport captures are sent |
| Strict secret handling | Prevents credentials from appearing in summaries |
| Profile auto-fill | Controls whether user profile text is sent to the LLM |
| Site adapters toggle | Controls whether site-specific guidance is prepended |
| `/allow-api` | Controls whether the agent can use API mutations |
| CapSolver toggle | Controls whether CAPTCHA data is sent to a third-party solver |

---

## Firefox Differences

Firefox has no offscreen document. The trace recorder and `unlimitedStorage`
are present and identical to Chrome (`src/firefox/src/trace/recorder.js`). All
data-flow patterns are otherwise the same, except:

- No dedicated vision sub-call (screenshots go directly to the main provider if vision is supported)
- No tab recording (`record_tab`)
- Conversation history is not persisted (lost when the sidebar closes)
