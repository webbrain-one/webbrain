# Providers & Models

---

## Provider Interface (`providers/base.js`)

Every LLM provider implements the `BaseLLMProvider` interface:

```js
class BaseLLMProvider {
  async chat(messages, options)         // → { content, toolCalls, usage }
  async *chatStream(messages, options)  // → async generator yielding { type, content }
  get supportsTools()                   // → boolean
  get supportsAskStreaming()            // → boolean
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
| `webbrain_cloud` | `openai` | cloud | `webbrain-cloud 1.0` | Yes |
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
| `gemini` | `openai` | cloud | `gemini-3.1-flash` | Model-name regex |
| `cloudflare` | `openai` | router | `@cf/zai-org/glm-5.2` | Model-name regex |
| `mistral` | `openai` | cloud | `mistral-large-latest` | Model-name regex |
| `deepseek` | `openai` | cloud | `deepseek-v4-flash` | Model-name regex |
| `xai` (Grok) | `openai` | cloud | `grok-4.3` | Model-name regex |
| `nvidia` (NIM) | `openai` | router | `meta/llama-3.1-8b-instruct` | Model-name regex |
| `groq` | `openai` | router | `llama-3.3-70b-versatile` | Model-name regex |
| `minimax` | `openai` | cloud | `minimax-m2.7` | Model-name regex |
| `kimi` | `openai` | cloud | `kimi-k2.5` | Model-name regex |
| `alibaba` (Qwen) | `openai` | cloud | `qwen-max` | Model-name regex |
| `together` | `openai` | router | `meta-llama/Llama-3.3-70B-Instruct-Turbo` | Model-name regex |
| `openrouter` | `openai` | router | `openrouter/free` | Model-name regex |
| `huggingface` | `openai` | router | `zai-org/GLM-5.2` | Model-name regex |
| `fireworks` | `openai` | router | `accounts/fireworks/models/llama-v3p3-70b-instruct` | Model-name regex |
| `z_ai` | `openai` | cloud | `glm-5.2` | Model-name regex |

### Extended provider catalog

WebBrain also ships 76 disabled-by-default provider cards sourced from the
OpenCode provider catalog snapshot at commit
`62e4641235d7847dadc60da37cca8a023dd54fc1`. Together with the 27 original
cards, Settings contains **103 built-in providers**.

| IDs |
|---|
| `302ai`, `abacus`, `aihubmix`, `alibaba-coding-plan`, `alibaba-coding-plan-cn`, `azure-cognitive-services`, `bailing`, `baseten`, `berget`, `cerebras`, `chutes`, `clarifai`, `cloudferro-sherlock`, `cohere`, `cortecs`, `deepinfra`, `digitalocean`, `dinference`, `drun`, `evroc`, `fastrouter`, `friendli` |
| `google-vertex`, `google-vertex-anthropic`, `helicone`, `iflowcn`, `inception`, `inference`, `io-net`, `jiekou`, `kilo`, `kimi-for-coding`, `kuae-cloud-coding-plan`, `llama`, `lucidquery`, `meganova`, `minimax-cn-coding-plan`, `minimax-coding-plan`, `moark`, `modelscope`, `morph` |
| `nano-gpt`, `nebius`, `nova`, `novita-ai`, `ollama-cloud`, `opencode`, `opencode-go`, `ovhcloud`, `perplexity`, `perplexity-agent`, `poe`, `privatemode-ai`, `qihang-ai`, `qiniu-ai`, `requesty`, `scaleway`, `siliconflow`, `siliconflow-cn`, `stackit` |
| `stepfun`, `submodel`, `synthetic`, `tencent-coding-plan`, `upstage`, `v0`, `venice`, `vercel`, `vivgrid`, `vultr`, `wandb`, `xiaomi`, `zai-coding-plan`, `zenmux`, `zhipuai`, `zhipuai-coding-plan` |

Most use the OpenAI-compatible Chat Completions contract and bearer API keys.
The exceptions are:

| Provider | Authentication / protocol |
|---|---|
| Azure AI Foundry | Resource name plus `api-key`; model is the deployed model name |
| Google Vertex AI | Project, location, and a Google authorization key sent as `x-goog-api-key`; `global` uses `aiplatform.googleapis.com` |
| Google Vertex AI (Anthropic) | Vertex `rawPredict` / `streamRawPredict` with the same authorization-key fields; `us` and `eu` use their multi-region hosts |
| Perplexity Agent | OpenAI Responses-compatible `/v1/responses` |
| Cloudflare | Existing card supports Workers AI plus an optional AI Gateway ID; blank IDs use Cloudflare's `default` gateway for `@cf/` models |

Morph and standard Perplexity Sonar are text-only integrations in the agent
and advertise `supportsTools: false`. New provider cards remain inactive until
the user saves their credentials and selects the provider.

### Ask response streaming

Providers with `supportsAskStreaming` stream visible text during interactive
Ask turns. Act, Dev, scheduled, managed-cloud, and Continue turns remain
non-streaming. Tool calls are withheld until a terminal protocol event arrives
(`[DONE]`, a terminal `finish_reason`, `message_stop`, or
`response.completed`). A network failure, HTTP failure before completion, or
premature EOF clears partial UI text and retries that turn once without
streaming; the rest of that run then stays non-streaming.

When a streaming provider returns token usage, WebBrain records it directly.
If the provider omits usage, WebBrain records a conservative character-based
estimate so streaming cannot bypass the configured cost allowance.

The setting still uses the stored key `openaiAskStreamingEnabled` for backward
compatibility, but it now controls all capable providers.

Official OpenAI GPT-5.6 and streaming-capable Responses-only GPT-5 Pro variants
use Responses streaming. Supported GPT-5.x, GPT-4.1, GPT-4o, GPT-4 Turbo, and
o-series variants retain Chat Completions streaming. GPT-5.5 Pro and other
official OpenAI models without documented streaming or function-calling
support stay non-streaming. Compatible built-ins opt in explicitly; custom
endpoints are not inferred from their model names.

Alibaba Cloud and both Alibaba Coding Plan cards remain non-streaming for
interactive Ask because
[DashScope does not allow `tools` with `stream=True`](https://www.alibabacloud.com/help/en/model-studio/compatibility-of-openai-with-dashscope),
and Ask always sends its read-only tool catalog.

Every parser waits for its protocol's terminal event (`response.completed`,
Anthropic `message_stop`, or SSE `[DONE]`). A network/read error, malformed
frame, or premature EOF clears partial output, displays a localized notice,
retries the current generation once through `chat()`, and disables streaming
for the rest of that run. HTTP failures, explicit in-stream provider/API
errors, and `content_filter` finish reasons are terminal and never trigger the
duplicate request.

### Deliberately unsupported provider entries

- `github-models`: GitHub is not being retired, but
  [GitHub Models will retire on July 30, 2026](https://github.blog/changelog/2026-07-01-github-models-is-being-fully-retired-on-july-30-2026/).
- `github-copilot`: requires GitHub subscription/OAuth and does not expose a
  suitable stable general provider API for this extension.
- `gitlab`: GitLab Duo uses custom authentication, discovery, and protocol
  behavior rather than a direct Chat Completions endpoint.
- `sap-ai-core`: requires service-key OAuth, deployment discovery, and custom
  service integration.

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

**Streaming.** Local streaming is primarily a runtime/server capability, not a
property of the GGUF or other model weights. Interactive Ask streaming is
enabled for llama.cpp, Ollama, LM Studio, Jan, vLLM, SGLang, and current LocalAI
through their OpenAI-compatible Chat Completions endpoints. Each parser requires
`[DONE]`; safe network/read, malformed-frame, and premature-EOF failures
silently retry once with non-streaming generation. Tool-call streaming
additionally depends on the model's tool-use training, the runtime's chat
template/parser, and a current runtime version (LocalAI added tool streaming in
3.10).

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

### Settings Search

The Settings search index includes provider IDs, labels, type/category, model,
base URL, field labels/placeholders, suggestions, and compatibility options.
Matching cards are ordered by exact provider name/ID, then name/ID prefix, then
name/ID substring, then field-only matches. Original provider order breaks
ties, and the selected provider remains visible across category filters.

### Config Persistence

Configs are stored in `chrome.storage.local` under the `providers` key, merged against defaults. Defaults provide the SHAPE (which provider keys exist); stored configs override per-key values. This allows upgrades that introduce new provider entries to work without users clearing storage.

Deprecated provider entries (`webbrain`, `openai_subscription`,
`claude_subscription`) are filtered out.

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

1. Add OpenAI-compatible metadata to `providers/provider-catalog.js`, including
   endpoint, model, auth mode, capabilities, and UI suggestions.
2. Create a provider class only when the wire protocol differs from the
   existing OpenAI, Anthropic, Azure, Bedrock, or Vertex adapters.
3. Add a factory case and import when a new class is required.
4. Add and attribute an SVG under `icons/providers/`.
5. Mirror code, icon, UI, and tests to Firefox.

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
  supportsAskStreaming: true,
  supportsStreamUsageOptions: false,
  apiKey: '',
  enabled: false,
},
```

Vision is auto-detected via model-name regex. If the provider has a known set of vision models, add them to the regex in `openai.js`. Set `supportsStreamUsageOptions: true` only for providers that accept OpenAI-style `stream_options.include_usage`; leave it false when a provider returns usage without accepting that request field.
