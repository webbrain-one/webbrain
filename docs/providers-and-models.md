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
  get useCompactPrompt()                // → boolean (small models get shorter system prompt)
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
| `openai` | `openai` | cloud | `gpt-5.5` | Model-name regex |
| `anthropic` | `anthropic` | cloud | `claude-sonnet-4-6` | Model-name regex |
| `claude_subscription` | `anthropic_oauth` | cloud | `claude-sonnet-4-6` | Yes |
| `gemini` | `openai` | cloud | `gemini-3.1-flash` | Model-name regex |
| `mistral` | `openai` | cloud | `mistral-large-latest` | Model-name regex |
| `deepseek` | `openai` | cloud | `deepseek-chat` | Model-name regex |
| `xai` (Grok) | `openai` | cloud | `grok-4.3` | Model-name regex |
| `nvidia` (NIM) | `openai` | cloud | `meta/llama-3.1-8b-instruct` | Model-name regex |
| `groq` | `openai` | cloud | `llama-3.3-70b-versatile` | Model-name regex |
| `minimax` | `openai` | cloud | `minimax-m2.7` | Model-name regex |
| `alibaba` (Qwen) | `openai` | cloud | `qwen-max` | Model-name regex |
| `openrouter` | `openai` | router | `minimax/minimax-m2.7` | Model-name regex |

### Local Providers

Three local providers are enabled by default with no API key needed:

- **llama.cpp**: `http://localhost:8080` — runs `llama-server -m model.gguf`
- **Ollama**: `http://localhost:11434/v1` — `ollama serve`
- **LM Studio**: `http://localhost:1234/v1` — LM Studio's local inference server

All three default `supportsVision: true` since most models loaded locally in 2026 are multimodal.

Compact prompts are opt-in per provider in both Chrome and Firefox. When
`useCompactPrompt` is enabled, Act mode uses `SYSTEM_PROMPT_ACT_COMPACT` and
filters the exposed tools through `COMPACT_TOOL_NAMES`; Ask mode is unchanged.

### Vision Detection

| Provider | Mechanism |
|---|---|
| OpenAI-compatible | Regex against model name (`gpt-4o`, `gpt-5`, `claude-3`, `claude-sonnet-4`, `gemini-2.0-flash`, etc.) |
| Anthropic | `claude-(3\|sonnet-4\|opus-4)` patterns |
| llama.cpp | Explicit `supportsVision` config toggle |
| Ollama / LM Studio | Explicit `supportsVision` config toggle (via OpenAI provider) |

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

### Config Persistence

Configs are stored in `chrome.storage.local` under the `providers` key, merged against defaults. Defaults provide the SHAPE (which provider keys exist); stored configs override per-key values. This allows upgrades that introduce new provider entries to work without users clearing storage.

Deprecated provider entries (`webbrain`, `openai_subscription`) are filtered out.

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
  apiKey: '',
  enabled: false,
},
```

Vision is auto-detected via model-name regex. If the provider has a known set of vision models, add them to the regex in `openai.js`.
