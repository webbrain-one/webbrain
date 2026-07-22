# Providers & Models

---

## Provider Interface (`providers/base.js`)

Every LLM provider implements the `BaseLLMProvider` interface:

```js
class BaseLLMProvider {
  async chat(messages, options)         // → { content, toolCalls, usage }
  async *chatStream(messages, options)  // → async generator yielding { type, content }
  get supportsTools()                   // → boolean
  get supportsVision()                  // → boolean
  get promptTier()                      // → 'compact' | 'mid' | 'full'
  async testConnection()                // → { ok, error?, model? }
}
```

### Options

```js
{
  tools: [...],            // tool schemas
  temperature: 0.3,
  maxTokens: 4096,
  stream: false,           // use chatStream instead of chat
  extraBody: {},           // extra fields passed through to the API
}
```

---

## Built-in Providers

| Provider ID | Type | Category | Default Model | Vision |
|---|---|---|---|---|
| `llamacpp` | `llamacpp` | local | (loaded model) | Yes (default on) |
| `ollama` | `openai` | local | (loaded model) | Yes (default on) |
| `lmstudio` | `openai` | local | (loaded model) | Yes (default on) |
| `jan` | `openai` | local | (loaded model) | Yes (default on) |
| `vllm` | `openai` | local | (loaded model) | Yes (default on) |
| `sglang` | `openai` | local | (loaded model) | Yes (default on) |
| `localai` | `openai` | local | (loaded model) | Yes (default on) |
| `azure_openai` | `azure_openai` | cloud | (deployment) | Manual toggle |
| `aws_bedrock` | `aws_bedrock` | cloud | (model id) | No |
| `openai` | `openai` | cloud | `gpt-5.6-terra` | Model-name regex |
| `anthropic` | `anthropic` | cloud | `claude-sonnet-4-6` | Model-name regex |
| `claude_subscription` | `anthropic_oauth` | cloud | `claude-sonnet-4-6` | Yes |
| `gemini` | `openai` | cloud | `gemini-3.1-flash` | Model-name regex |
| `mistral` | `openai` | cloud | `mistral-large-latest` | Model-name regex |
| `deepseek` | `openai` | cloud | `deepseek-v4-flash` | Model-name regex |
| `xai` (Grok) | `openai` | cloud | `grok-4.3` | Model-name regex |
| `nvidia` (NIM) | `openai` | cloud | `meta/llama-3.1-8b-instruct` | Model-name regex |
| `groq` | `openai` | cloud | `llama-3.3-70b-versatile` | Model-name regex |
| `minimax` | `openai` | cloud | `minimax-m2.7` | Model-name regex |
| `kimi` | `openai` | cloud | `kimi-k2.5` | Model-name regex |
| `alibaba` (Qwen) | `openai` | cloud | `qwen-max` | Model-name regex |
| `openrouter` | `openai` | router | `openrouter/free` | Model-name regex |

### Local Providers

Seven local providers are enabled by default with no API key needed unless the
local server was started with auth:

- **llama.cpp**: `http://localhost:8080` — runs `llama-server -m model.gguf`
- **Ollama**: `http://localhost:11434/v1` — `ollama serve`, or `ollama launch webbrain --model <model>`
- **LM Studio**: `http://localhost:1234/v1` — LM Studio's local inference server
- **Jan**: `http://localhost:1337/v1` — Jan's local OpenAI-compatible API server
- **vLLM**: `http://localhost:8000/v1` — vLLM's OpenAI-compatible server
- **SGLang**: `http://localhost:30000/v1` — SGLang's OpenAI-compatible server
- **LocalAI**: `http://localhost:8080/v1` — LocalAI's OpenAI-compatible server

All seven default `supportsVision: true` since most models loaded locally in 2026 are multimodal.

**Context window.** Load local models with **at least a 16k-token context window** for reliable agent runs — that's the usable minimum. 8k can work with the Compact tier selected; 4k is too small to hold the system prompt + tool schemas. The agent reads the window from `provider.contextWindow` (`providers/base.js`) to drive auto-compaction; when a provider config doesn't set `contextWindow`, local providers default to a conservative **16k** (cloud/router default to 128k). **Test connection** / **Load models** auto-detect for **llama.cpp**, **Ollama**, and **LM Studio** when reported (llama.cpp `GET /props` `n_ctx`, Ollama `GET /api/ps` live context then `/api/show` `num_ctx`, LM Studio `/api/v0/models` `loaded_context_length`). Detection refreshes the 16k default; it shrinks a larger manual override only from live/runtime context (not from Ollama `/api/show` alone). Jan / vLLM / SGLang / LocalAI do not auto-detect yet. You can still set `config.contextWindow` explicitly, and the model server must actually be started with that much context (e.g. `llama-server -c 16384`).

### Prompt/tool tiers and modes

Provider tier and conversation mode are separate knobs:

- **Tier** (`compact | mid | full`) is a provider setting. It controls which Act-system prompt and normal browser-agent tool subset the model receives.
- **Mode** (`ask | act | dev`) is selected by the user per conversation/message. It controls whether the request is read-only, normal browser action, or developer/page-inspection work.

`provider.promptTier` resolves the active tier. Cloud providers are forced to Full. Local providers default to Mid. OpenRouter/router providers default to Full unless explicitly changed. Existing configs that still set the legacy `useCompactPrompt` boolean map to Compact.

| Tier | Intended model class | Normal tool surface |
|---|---|---|
| `compact` | very small/local models | Shortest prompt and a small normal Act tool set. No scheduling, iframe, download-resource, or advanced DOM/UI fallback tools. |
| `mid` | capable local models | Balanced prompt and common task tools: downloads, scheduling, iframe tools, form verification, and `download_resource_from_page`, while excluding Full-only advanced UI/DOM fallbacks. |
| `full` | frontier/cloud or large local models | Full normal Act prompt and advanced fallbacks such as hover, drag-drop, frames, and shadow DOM. |

Ask mode ignores provider tier and stays read-only. Act mode uses the selected tier's normal tools. Dev mode requires Mid or Full, uses the selected Act prompt, appends `SYSTEM_PROMPT_DEV_APPENDIX`, and adds Dev-only source/style tools plus Dev-extended shadow/frame inspection for Mid-tier debugging. Compact Dev is blocked before an LLM request is sent.

### Vision Detection

| Provider | Mechanism |
|---|---|
| OpenAI-compatible | Regex against model name (`gpt-4o`, `gpt-5`, `claude-3`, `claude-sonnet-4`, `gemini-2.0-flash`, etc.) |
| Anthropic | `claude-(3\|sonnet-4\|opus-4)` patterns |
| llama.cpp | Explicit `supportsVision` config toggle |
| Ollama / LM Studio / Jan / vLLM / SGLang / LocalAI | Explicit `supportsVision` config toggle (via OpenAI provider) |

### Anthropic Conversion

When the active provider is Anthropic, the agent converts OpenAI-format messages:

| OpenAI format | Anthropic format |
|---|---|
| `system` message | `system` field (top-level) |
| `assistant` + `tool_calls` | `assistant` + `tool_use` content blocks |
| `tool` role | `user` + `tool_result` content blocks |
| `image_url` (data URL) | `image` source block |

---

## ProviderManager (`providers/manager.js`)

Manages provider lifecycle:

```js
const pm = new ProviderManager();

await pm.load();                    // Load from chrome.storage.local
await pm.save();                    // Persist to chrome.storage.local
pm.getActive();                     // Get the active provider instance
await pm.setActive('openai');       // Switch active provider
await pm.updateProvider('openai', { model: 'gpt-5' }); // Update config
pm.getAll();                        // All provider configs (for Settings UI)
await pm.testProvider('openai');    // Test connection
```

Each non-WebBrain provider config includes a persisted `configured` flag. An
explicit configuration update sets it to `true`; this is the UI's **Active**
state and is separate from `activeProvider`, which is the provider currently
**Selected** for chat. WebBrain Cloud is always selectable without being marked
configured. Connection tests report reachability but do not control the Active
flag.

### Config Persistence

Configs are stored in `chrome.storage.local` under the `providers` key, merged against defaults. Defaults provide the SHAPE (which provider keys exist); stored configs override per-key values. This allows upgrades that introduce new provider entries to work without users clearing storage.

Deprecated provider entries (`webbrain`, `openai_subscription`) are filtered out.

### Cost Allowances

Settings exposes session and total cloud cost allowances. The agent prefers a provider-reported `usage.cost`/`usage.cost_usd` value when present (OpenRouter reports this directly). For direct cloud providers that only return token counts, WebBrain estimates spend from the provider config fields:

- `inputCostPerMillionUsd`
- `cacheReadCostPerMillionUsd`
- `cacheWriteCostPerMillionUsd` (5-minute or unspecified cache writes)
- `cacheWrite1hCostPerMillionUsd`
- `outputCostPerMillionUsd`

OpenAI reports cache reads and writes inside the input-token total (`prompt_tokens_details.cached_tokens` / `cache_write_tokens`, or the Responses API `input_tokens_details` equivalents), so WebBrain subtracts both before applying the regular input rate and prices writes with `cacheWriteCostPerMillionUsd`. Anthropic and Bedrock report regular input, cache reads, and cache writes separately, so those counts are added as separate billing classes. Anthropic and Bedrock can also distinguish 5-minute and 1-hour cache writes.

Those rates are editable in the provider card so custom model pricing can be adjusted without code changes. If a cache-specific rate is absent, it falls back to the regular input rate; a missing 1-hour write rate falls back to the general cache-write rate. If a metered remote provider has token usage but no configured input/output rates, the agent uses conservative defaults (`$3` input / `$15` output per 1M tokens). Streaming providers contribute only their final cumulative usage snapshot for each request. Local providers are not counted.

### Dedicated Vision Provider

The user can configure a separate vision provider for screenshot description. The agent sub-calls this provider to get a text description of the viewport, then feeds only the description (not the raw image) to the main planning provider. This reduces token costs when the main provider is text-only:

```js
const vision = await providerManager.getVisionProvider();
// Returns an OpenAICompatibleProvider instance or null
```

### Transcription Provider

Used by Tab Recorder for Whisper transcription. Falls back through configured providers in priority order: OpenAI → Groq → LM Studio → llama.cpp. Blocklist excludes providers known not to host Whisper (Anthropic, Gemini, Mistral, DeepSeek, xAI, Nvidia).

---

## Adding a Provider

1. **Create the provider class** in `src/chrome/src/providers/<name>.js` implementing `BaseLLMProvider`
2. **Add the default config** to `_defaultConfigs()` in `manager.js`
3. **Add the factory case** in `_createProvider()`
4. **Register the import** in `manager.js`
5. **Add provider-specific handling** in the agent if needed (e.g., Anthropic's message format conversion)
6. **Mirror to Firefox** (`src/firefox/src/providers/`)

### For OpenAI-compatible providers

If the provider speaks the OpenAI `/v1/chat/completions` API format, you only need to add a default config entry — `OpenAICompatibleProvider` handles the rest:

```js
myprovider: {
  type: 'openai',
  category: 'cloud',
  label: 'My Provider',
  providerName: 'myprovider',
  baseUrl: 'https://api.myprovider.com/v1',
  model: 'my-model',
  supportsStreamUsageOptions: false,
  apiKey: '',
  enabled: false,
},
```

Vision is auto-detected via model-name regex. If the provider has a known set of vision models, add them to the regex in `openai.js`. Set `supportsStreamUsageOptions: true` only for providers that accept OpenAI-style `stream_options.include_usage`; leave it false when a provider returns usage without accepting that request field.
