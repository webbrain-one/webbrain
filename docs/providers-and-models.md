# Providers & Models

---

## Main provider and assistive models

**Settings → Providers** selects the main model for conversation, planning and
final replies. **Settings → Assistive Models** groups Vision (including screenshot
limits and redaction), Speech to text, Generative Media (powering the
`generate_image` agent tool), Decision models, and SafeSocial. Configuring an assistive
model does not replace the active provider. Decision models share one provider/model
selection with separate completion, watch, scheduled-check, classification and browser
decision switches. See [the settings guide](https://webbrain.one/docs/settings/#multimodal)
and [data flow](privacy-and-data-flow.md#decision-models-and-completion-verification)
for setup and disclosure details. Existing `#multimodal` settings links still work.

Browser chat includes the configured main provider and text-model labels in its
trusted per-turn context, so identity answers can use the current selection
instead of guessing. Assistive model labels stay separate. Automatic routes such
as `openrouter/free` identify the configured route; they do not establish which
upstream model the router selected. Endpoint URLs, credentials, local model paths
and private inference-profile ARNs are omitted from this identity context.

### Gemini 4 Argon and new Muse models

Settings suggests `gemini-4-argon` on Google Gemini and
`google/gemini-4-argon`, `meta/muse-wonder`, and `meta/muse-spark-open` on
OpenRouter. These models support native tools and screenshot input. WebBrain
infers their 1,048,576-token context unless a user or local runtime overrides it.

Argon uses the existing Google OpenAI-compatible or OpenRouter Chat Completions
route. Its synchronous output ceiling is 65,536 tokens; background long decode
is not implemented. WebBrain reserves at least 32,768 tokens including thinking,
omits ignored sampling controls, and maps unsupported thinking-off requests to
low reasoning. Muse Wonder and Spark Open also require reasoning: short text
and classifier calls receive at least 2,048 tokens and use the lowest supported
effort when disabling reasoning was requested. The Meta-hosted Muse Wonder route
requires automatic tool choice, like Spark 1.3 Contributor: named choices narrow
the offered tools, and disabling tools removes them from the request. Spark Open
retains native tool choices.
Streamed Google tool-call signatures and OpenRouter reasoning details are
retained for subsequent tool turns. OpenRouter's opaque replay blocks are
scoped to the same endpoint, model, and tool-call IDs.

Release/API references: [Google Argon guide](https://ai.google.dev/gemini-api/docs/latest-model),
[Muse Wonder](https://research.meta.ai/blog/muse-wonder),
[Muse Spark Open](https://research.meta.ai/blog/muse-spark-open), and the
[OpenRouter live catalog](https://openrouter.ai/api/v1/models).

Run `npm run test:frontier:live` with `OPENROUTER_API_KEY` and/or
`GEMINI_API_KEY` in the environment to make paid API probes through the production
provider. It checks visible text, streaming, native and streamed tool round trips, an
image-only code, and short classifier output. Add `-- --browser firefox` for the
Firefox provider. Tool results in this smoke check are supplied fixtures; it
does not verify real browser task completion. Without a key it exits before
making any inference calls. Local regression tests use mocked responses and
cannot establish live account access or upstream availability.

### Decision models

Select OpenRouter (the default), TypeSafe directly, or a local/custom System One
endpoint. OpenRouter's model list comes from its decision-model catalog and includes
all publishers. The new default is `perplexity/pplx-decider-v1-27b`; existing
TypeSafe keys, enabled features and scheduler thresholds stay on their original
provider until changed. Provider keys are stored separately.

Local [Kev](https://github.com/jaredpalmer/kev) defaults to
`http://127.0.0.1:8009`, model `kev-latest`, using `/v1/systemone`. A key is optional
and loopback requests work offline. Custom remote endpoints require HTTPS.
Image support follows available model capabilities or the custom override. Test
Connection checks typed answers and, when enabled, two independent image-only
facts. A successful HTTP response alone does not establish image support.

**D1 FP32 WebGPU (experimental)** is a separate, optional on-device decision
provider. It does not replace the conversational/planning model and does not
generate tokens. It supports named choice, noul (P(yes)) and ordinal score
questions over bounded text/JSON state and inline screenshots. Selecting it
does not download anything. Explicit consent and **Download and load** fetch
about 1.9 GB of pinned FP32 model data and tokenizer/configuration files from
the [Hugging Face model repository](https://huggingface.co/webbrain-one/d1-browser-decision-fp32)
into OPFS. The repository name is not a production-readiness claim; this provider
remains experimental. Executable JS/WASM is packaged in the extension, not
downloaded from the model repository. **Load cached model** verifies the files
again; inference cannot trigger a model download.

This experimental path needs hardware WebGPU, OPFS and substantial GPU/host
memory. Software adapters are rejected. Chrome uses the shared MV3 offscreen
document with a dedicated decision Worker; Firefox uses its background-page
Worker when the corresponding browser capabilities are available. Mirrored
code is not evidence that every browser/GPU is supported. CPU/WASM control and
shape operators are permitted and explicitly disclosed; it is not a pure-GPU
claim. Unload or disabling outsourcing releases the Worker/GPU resources and
retains the cache; **Remove cached model** requires the model to be unloaded.
Page state and screenshots remain untrusted evidence, never instructions.
No inference input goes to Hugging Face. Existing optional provider/research
sharing settings and existing privacy boundaries are not bypassed.

The adapter retains Python-style JSON spacing and fractional exponent
formatting. JavaScript cannot distinguish an integer `1` from a Python float
`1.0` after JSON parsing, and cannot preserve integers outside its exact Number
range. For byte-exact externally prepared state text, pass the original state
as a string. Question instructions are strings; score levels can be structured
JSON and are serialized into the original string legend.

D1 completion outsourcing defaults off on selection. Even when explicitly
enabled, a positive D1 result cannot be the sole completion authority: it
continues to the independent active-LLM verifier or the existing completion
checks. Deterministic recipient, payment, authorization, download and workflow
requirements remain unchanged. Unavailable, malformed or timed-out D1 requests
use the existing fallback chain; no synthetic answer is substituted.

Verify completion (`done`) defaults on when outsourcing is configured, with a
90% acceptance threshold separate from the scheduled-check threshold. Compass
uses its managed `/v1/decisions` route by default. An explicitly enabled and
consented experimental D1 selection overrides only that decision route, not
the main Compass provider. The fallback chain is decision model, active LLM, then existing
completion checks. These outsourcing toggles control the decision model only;
with outsourcing disabled or unconfigured, completion still uses a dedicated
call to the active LLM, subject to its normal cost allowance, followed by the
existing checks. Strict Secret Mode disables these additional calls.

| Active provider | First completion verifier | Fallback |
| --- | --- | --- |
| WebBrain Compass (default) | Managed decision model | Active LLM, then existing checks |
| Explicitly enabled and consented D1, including with Compass | Experimental local D1; no sole success authority | Active LLM, then existing checks |
| Other provider, completion outsourcing enabled | Selected decision model | Active LLM, then existing checks |
| Other provider, outsourcing disabled or unconfigured | Active LLM | Existing checks |

Each judge prefers a fresh screenshot and tries AX if images
are unavailable or inconclusive. The decision model decides when it is sure.
When it answers but is not sure, the active LLM's second look has eight seconds
in all, and a look that could not finish in the time left is not started, so a
slow model cannot hold a finished task; when the decision model is off or
unavailable, or a D1 success needs confirmation, the active LLM keeps its full
checks. At completion the active LLM's reading of the page's status texts, when
the decision model is not sure of them, is bounded to six seconds; a text it did
not read proves nothing either way. Confident pending/failed results require
recovery. Accepted fresh proof can establish generic publication evidence;
explicit recipient, payment, download, authorization and workflow contracts
remain required. Future votes and moderation outcomes are not certified.
Freshness checks re-capture pixels or re-read the bounded AX observation used
by the judge, with document/run identity checked separately. Text outside that
observation does not invalidate an AX verdict; changed observed evidence does.
Action history includes tool names without typed values or other arguments.

Rollout is additive: deploy Cloud `/v1/decisions` before releasing the extension.
An older Cloud deployment falls through to the active LLM and existing checks.

### Generative Media

Configure **Settings → Assistive Models → Generative Media** for the
`generate_image` agent tool. Select one provider and save its settings:

| Provider | Required settings | Generation |
| --- | --- | --- |
| fal.ai | API key, model ID (for example `fal-ai/flux/schnell`) | fal.ai queue API; existing saved fal.ai settings remain compatible |
| OpenRouter | API key, image model ID | [Dedicated Image API](https://openrouter.ai/docs/guides/overview/multimodal/image-generation); inline images appear in chat with a save link |
| Comfy Router | Comfy API key, `provider/model` ID (for example `bfl/flux-2-pro`) | [Queued requests](https://docs.comfy.org/development/comfy-router/queued-delivery); hosted or inline media |
| ComfyUI (localhost) | Local server URL (default `http://127.0.0.1:8188`), workflow JSON in API format | Local `/prompt`, `/history/{prompt_id}`, and `/view` endpoints; no API key |

For Comfy Router models with native inputs other than `prompt`, paste their input
JSON in **Model input JSON** and place `{{prompt}}` in the text field(s). Other
values, such as duration or resolution, are preserved. Without a placeholder,
WebBrain supplies the tool prompt as `prompt`. Refer to the model's
[input schema](https://docs.comfy.org/development/comfy-router/schemas).

For local ComfyUI, start the server, export a working workflow **in API format**,
and replace its positive prompt text with `{{prompt}}`. Keep the model names,
connections, and other inputs from the working export. Include a Save Image or
other media output node. Only loopback URLs (`localhost`, `127.0.0.1`, or `[::1]`)
are accepted. A connection test checks the server, not workflow execution.

**Test Connection** makes only free, read-only authentication/model/server probes;
it does not generate media. OpenRouter also checks that the selected model appears
in the image generation catalog. **Save / Clear** apply to the selected media
configuration. Unsaved drafts survive provider switches while settings remain open;
only the saved selection is used by the agent.

The tool is a full-tier Act-mode tool and is unavailable in Ask mode or on the
compact/mid tool surface. Permission checks use the selected provider's host.
Cloud keys are sent only to fixed API origins, and authenticated requests reject
redirects. Generations have a ten-minute client deadline. Stop cancels queued
fal.ai/Comfy Router jobs when possible; local Stop deletes only this prompt from
the queue. A local workflow that has already started can continue, and Comfy Router
can charge for a partner generation already in flight. Inline media is limited to
20 MB; choose hosted output for larger files. Inline outputs are stored locally
as media assets, so their previews and save links survive panel reopening without
putting base64 bytes in the run journal or model context.

The Act system prompt and planner direct the model to call `generate_image` when
the user asks to generate media. Provider results are treated as untrusted content.
Inline bytes are shown in chat and excluded from model context.

### SafeSocial image classifier (experimental)

**Settings → Assistive Models → SafeSocial** optionally filters Instagram images
and video posters using the local, multilabel
[EfficientNet-Lite0 classifier](https://huggingface.co/webbrain-one/safesocial-trigger-classifier-efficientnet-lite0).
It is off by default and does not replace the chat or screenshot vision model.
Choose categories, an absolute score threshold (default 95%), and blur, hide,
dim, or warning. Every filtered image has a reveal button. Videos without a
poster and video frames are not classified in this first integration.

Enabling downloads approximately 13.6 MB of model data from Hugging Face. Files
are pinned to revision `d39182d06486b237ba33bc675b9302a206182460`, verified with
SHA-256 and cached in this browser. JavaScript/WASM uses the existing packaged
ONNX runtime; no remote executable code or bundled model weights are added.
Inference runs in a dedicated CPU/WASM worker on both Chrome and Firefox.
Images are fetched from Instagram's image CDNs without cookies and processed
locally; they are not uploaded to Hugging Face or an inference service.

Turning SafeSocial off cancels pending work, unloads the worker and restores
filtered media. Cached weights remain until **Remove downloaded model** is
clicked while disabled. A failed download or inference leaves media unchanged
and displays an error; there is no mock/keyword fallback. This is an experimental
social-comparison classifier, not a general content-safety or NSFW detector.
Scores can be wrong. English and Turkish copy is provided, with English fallback
for other interface languages.

Validation: `npm run test:safesocial` covers configuration, URL/caller gates,
cancellation and Chrome/Firefox parity. `npm run test:safesocial:ui` exercises
responsive settings and media lifecycle in both browsers. Set
`SAFESOCIAL_MODEL_DIR` to a directory containing the pinned bundle under
`webbrain-safesocial-model.onnx` and `webbrain-safesocial-model.json` to also run
real ONNX/WASM inference in that browser test without live network downloads.
With the same bundle, `npm run test:safesocial:extension` checks the complete
Chrome MV3 settings/background/offscreen path in an isolated browser profile,
including cached reactivation and model removal.

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

| Provider ID          | Type           | Category | Default Model                                                      | Vision                          |
| -------------------- | -------------- | -------- | ------------------------------------------------------------------ | ------------------------------- |
| `webbrain_cloud`     | `openai`       | cloud    | `webbrain-cloud 1.0`                                               | Yes                             |
| `llamacpp`           | `llamacpp`     | local    | (loaded model)                                                     | Auto metadata / override        |
| `ollama`             | `openai`       | local    | (loaded model)                                                     | Auto via `/api/show` / override |
| `lmstudio`           | `openai`       | local    | (loaded model)                                                     | Auto metadata / override        |
| `osaurus`            | `openai`       | local    | (required)                                                         | Off / manual toggle             |
| `jan`                | `openai`       | local    | (loaded model)                                                     | Yes (default on)                |
| `vllm`               | `openai`       | local    | (loaded model)                                                     | Yes (default on)                |
| `sglang`             | `openai`       | local    | (loaded model)                                                     | Yes (default on)                |
| `localai`            | `openai`       | local    | (loaded model)                                                     | Auto metadata / override        |
| `gpt4all`            | `openai`       | local    | (loaded model)                                                     | Yes (default on)                |
| `local_openai_proxy` | `openai`       | local    | (required)                                                         | Off / manual toggle             |
| `unsloth`            | `openai`       | local    | (required)                                                         | Off / manual toggle             |
| `webgpu` (Chromium)  | `webgpu`       | local    | Compass Tiny v2.1 (only preset); experimental custom HF ONNX repos | No                              |
| `azure_openai`       | `azure_openai` | cloud    | (deployment)                                                       | Manual toggle                   |
| `aws_bedrock`        | `aws_bedrock`  | cloud    | (model id)                                                         | No                              |
| `openai`             | `openai`       | cloud    | `gpt-5.6-terra`                                                    | Model-name regex                |
| `anthropic`          | `anthropic`    | cloud    | `claude-sonnet-4-6`                                                | Model-name regex                |
| `gemini`             | `openai`       | cloud    | `gemini-3.1-flash`                                                 | Model-name regex                |
| `cloudflare`         | `openai`       | router   | `@cf/zai-org/glm-5.2`                                              | Model-name regex                |
| `mistral`            | `openai`       | cloud    | `mistral-large-latest`                                             | Model-name regex                |
| `deepseek`           | `openai`       | cloud    | `deepseek-flash`                                                   | Model-name regex                |
| `xai` (Grok)         | `openai`       | cloud    | `grok-4.3`                                                         | Model-name regex                |
| `nvidia` (NIM)       | `openai`       | router   | `meta/llama-3.1-8b-instruct`                                       | Model-name regex                |
| `groq`               | `openai`       | router   | `llama-3.3-70b-versatile`                                          | Model-name regex                |
| `minimax`            | `openai`       | cloud    | `minimax-m2.7`                                                     | Model-name regex                |
| `kimi`               | `openai`       | cloud    | `kimi-k2.5`                                                        | Model-name regex                |
| `alibaba` (Qwen)     | `openai`       | cloud    | `qwen-max`                                                         | Model-name regex                |
| `together`           | `openai`       | router   | `meta-llama/Llama-3.3-70B-Instruct-Turbo`                          | Model-name regex                |
| `openrouter`         | `openai`       | router   | `openrouter/free`                                                  | Model-name regex                |
| `huggingface`        | `openai`       | router   | `zai-org/GLM-5.2`                                                  | Model-name regex                |
| `fireworks`          | `openai`       | router   | `accounts/fireworks/models/llama-v3p3-70b-instruct`                | Model-name regex                |
| `z_ai`               | `openai`       | cloud    | `glm-5.2`                                                          | Model-name regex                |

The sidepanel also exposes `webbrain_cloud_max` as **WebBrain Compass XL**.
It is a managed, sidepanel-only runtime profile rather than a second Settings
provider card. It uses the same endpoint and sends `model: max`; the hosted
backend returns `WebBrain Compass XL 1.0` and consumes usage credits at five
times the standard rate.

### Extended provider catalog

WebBrain also ships 80 disabled-by-default provider cards. Most are sourced
from the OpenCode provider catalog snapshot at commit
`62e4641235d7847dadc60da37cca8a023dd54fc1`; provider-specific additions use
their official API documentation. Together with the original cards, Settings
contains **113 built-in providers on Chromium** and **112 on Firefox**; the
difference is the Chromium-only in-browser WebGPU runtime.

| IDs                                                                                                                                                                                                                                                                                                                        |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `302ai`, `abacus`, `aihubmix`, `alibaba-coding-plan`, `alibaba-coding-plan-cn`, `azure-cognitive-services`, `bailing`, `baseten`, `berget`, `cerebras`, `chutes`, `clarifai`, `cloudferro-sherlock`, `cohere`, `cortecs`, `deepinfra`, `digitalocean`, `dinference`, `drun`, `evroc`, `fastrouter`, `friendli` |
| `freebuff2api`, `google-vertex`, `google-vertex-anthropic`, `helicone`, `iflowcn`, `inception`, `inference`, `io-net`, `jiekou`, `kilo`, `kimi-for-coding`, `kuae-cloud-coding-plan`, `llama`, `lucidquery`, `meganova`, `minimax-cn-coding-plan`, `minimax-coding-plan`, `moark`, `modelscope`, `morph`                       |
| `nano-gpt`, `nearai`, `nebius`, `nova`, `novita-ai`, `ollama-cloud`, `opencode`, `opencode-go`, `orcarouter`, `ovhcloud`, `perplexity`, `perplexity-agent`, `poe`, `pollinations`, `privatemode-ai`, `qihang-ai`, `qiniu-ai`, `requesty`, `scaleway`, `siliconflow`, `siliconflow-cn`, `stackit`                               |
| `stepfun`, `submodel`, `synthetic`, `tencent-coding-plan`, `upstage`, `v0`, `venice`, `vercel`, `vivgrid`, `vultr`, `wandb`, `xiaomi`, `zai-coding-plan`, `zenmux`, `zhipuai`, `zhipuai-coding-plan`                                                                                                                       |

Most use the OpenAI-compatible Chat Completions contract and bearer API keys.
The exceptions are:

| Provider                     | Authentication / protocol                                                                                                        |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Azure AI Foundry             | Resource name plus `api-key`; model is the deployed model name                                                                   |
| Google Vertex AI             | Project, location, and a Google authorization key sent as `x-goog-api-key`; `global` uses `aiplatform.googleapis.com`            |
| Google Vertex AI (Anthropic) | Vertex `rawPredict` / `streamRawPredict` with the same authorization-key fields; `us` and `eu` use their multi-region hosts      |
| Perplexity Agent             | OpenAI Responses-compatible `/v1/responses`                                                                                      |
| Cloudflare                   | Existing card supports Workers AI plus an optional AI Gateway ID; blank IDs use Cloudflare's `default` gateway for `@cf/` models |

Morph and standard Perplexity Sonar are text-only integrations in the agent
and advertise `supportsTools: false`. New provider cards remain inactive until
the user saves their credentials and selects the provider.

#### Freebuff2API

[Freebuff2API](https://github.com/Quorinex/Freebuff2API) is a self-hosted,
OpenAI-compatible proxy. Start the server, then configure the **Freebuff2API
(Local)** card with its URL (the default is `http://127.0.0.1:8080/v1`) and
select a model with **Load Models**. Enter a proxy API key only when its
`API_KEYS` access control is enabled; Freebuff authentication tokens remain on
the proxy server and are never entered into WebBrain.

#### IO.NET and Synthetic

[IO.NET](https://io.net/docs/guides/intelligence/io-intelligence) and
[Synthetic](https://synthetic.new/) are built-in OpenAI-compatible cloud
providers. Add each service's bearer API key in its Settings card, choose a
model, save, and select the provider.

#### NEAR AI Cloud

[NEAR AI Cloud](https://cloud.near.ai/) exposes an OpenAI-compatible API at
`https://cloud-api.near.ai/v1`. TEE-hosted models (such as `z-ai/glm-5.3-flash`)
run inside Trusted Execution Environments so prompts and outputs stay private
and verifiable; third-party models proxied through the same gateway use the
same API and billing but do not inherit the TEE privacy guarantees. See the
[quickstart](https://docs.near.ai/cloud/quickstart),
[models](https://docs.near.ai/cloud/models), and
[OpenAI compatibility](https://docs.near.ai/cloud/guides/openai-compatibility)
guides.

In WebBrain, open **Settings -> Providers -> NEAR AI Cloud**. Generate an API
key from the [NEAR AI Cloud dashboard](https://cloud.near.ai/), paste it into
the card, keep the default `z-ai/glm-5.3-flash` model, then click **Test
Connection**. If selecting a model with a smaller context window, such as
`Qwen/Qwen3.8-27B` (262144 tokens), set **Context window** to its documented
limit. Interactive Ask streaming, tool calls, and vision work through the
existing OpenAI-compatible path.

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

On Chromium, **WebGPU (In-browser)** is an endpoint-free local provider. Its
Apocalypse text picker offers a single shipped preset:

- [`webbrain-one/webbrain-compass-tiny-v2.1`](https://huggingface.co/webbrain-one/webbrain-compass-tiny-v2.1)
  (`q4f16`, about 1.87 GB across two external-data shards), WebBrain's Compass
  Tiny v2.1 fine-tune of MiniCPM5-2B for Compact tool routing. It runs greedy
  with thinking disabled through the packaged Transformers.js 4.2 / ONNX
  Runtime Web GPU worker, and emits MiniCPM5 XML-style tool calls
  (`<function name="..."><param name="...">...</param></function>`, CDATA-wrapped
  when values contain `<`, `&`, or newlines), which the local fallback parser
  accepts. Enabling Apocalypse Mode starts this download automatically.

Custom Hugging Face repositories have not been tested and are likely not to
work. They must be compatible with Transformers.js text generation, provide a
`q4f16` ONNX variant, and use a chat template that accepts `tools`; WebBrain
validates the template after loading and rejects incompatible repositories.

The provider is text-only and defaults to the Compact prompt tier with a
32k context window. Budget roughly 4 GB of GPU headroom (about 1.87 GB of
weights plus KV cache that grows with context length); on constrained GPUs,
lower the context window on the WebGPU card in Settings → Providers (16384 is
a safe fallback) and retry with a short prompt. Each repository is cached
separately in Chrome.
After downloading Compass in Apocalypse Mode, the WebGPU card in
**Settings -> Providers** can be configured, tested, and selected as the normal
chat provider. The nuclear standalone-chat control remains available as a
per-run override that does not change the global selection. Once its files are
cached, Compass works without Apocalypse Mode enabled.
**Test Connection** checks only the packaged runtime and hardware WebGPU
adapter, so it does not trigger a model download. There is no API key, base
URL, localhost server, or OpenAI-compatible endpoint. Firefox does not expose
the card because its build does not package the Chromium MV3 offscreen/WebGPU
runtime.

Twelve local endpoint providers are enabled by default. The model runtimes need no
API key unless the server was started with auth; Unsloth Studio and the generic
proxy card require their configured client keys:

- **llama.cpp**: `http://localhost:8080` — runs `llama-server -m model.gguf`
- **Ollama**: `http://localhost:11434/v1` — `ollama serve`, or `ollama launch webbrain --model <model>`
- **ODS**: `http://localhost:11434/v1` — Osmantic ODS's local llama-server; set the URL to the port in ODS's `.env` (often `8080` on macOS)
- **LM Studio**: `http://localhost:1234/v1` — LM Studio's local inference server
- **Osaurus**: `http://127.0.0.1:1337/v1` — `osaurus serve --port 1337` on macOS
- **Jan**: `http://localhost:1337/v1` — Jan's local OpenAI-compatible API server
- **vLLM**: `http://localhost:8000/v1` — vLLM's OpenAI-compatible server
- **SGLang**: `http://localhost:30000/v1` — SGLang's OpenAI-compatible server
- **LocalAI**: `http://localhost:8080/v1` — LocalAI's OpenAI-compatible server
- **GPT4All**: `http://localhost:4891/v1` — GPT4All's local API server
- **Local OpenAI-compatible Proxy**: `http://127.0.0.1:8317/v1` — a generic,
  authenticated local gateway; the model and proxy client API key are required
- **Unsloth Studio**: `http://127.0.0.1:8888/v1` by default, with a configurable
  port — Studio's API URL, loaded model, and generated API key are required

#### ODS

Open **Settings → Providers → ODS (Local)**, set the server URL to the local
inference port in ODS's `.env`, click **Load Models**, select the running model,
and click **Test Connection**. ODS exposes OpenAI-compatible `/v1/models` and
`/v1/chat/completions`; WebBrain reads `/props` for the live context window and
vision support when the installed backend exposes it. Add an API key only if
you configured ODS to require one. When ODS switches models, select the new
model in WebBrain unless your ODS installation exposes a stable alias. See the
[ODS quickstart](https://github.com/Osmantic/ODS/blob/main/ods/QUICKSTART.md).

#### Osaurus

Start the Osaurus server on your Mac, then open **Settings → Providers →
Osaurus (Local)**. Keep `http://127.0.0.1:1337/v1` as the server URL, click
**Load Models**, select a model, and click **Test Connection**. A model ID is
required; discovery uses Osaurus's OpenAI-compatible `/v1/models` endpoint.
Chat, tool calls, and interactive Ask streaming use `/v1/chat/completions`.
See the [official API guide](https://github.com/osaurus-ai/osaurus/blob/main/docs/OpenAI_API_GUIDE.md).

Local-only loopback access needs no API key. If Osaurus requires authentication
(including network exposure or relay access), enter its access key under the
card's **Advanced → API key** section. Osaurus and Jan both default to port
1337; use different ports if running both and update the corresponding server
URL. Set **Context window** to the selected model's actual runtime limit.
Vision starts off; enable **Supports vision** only for a model that accepts
images. Osaurus can also route to cloud providers, in which case that upstream
provider receives the request.

#### Unsloth Studio

Install or open [Unsloth Studio](https://unsloth.ai/docs/get-started/install),
then start Studio and load a chat model. In Studio, open the avatar menu,
choose **Settings → API Access**, and create an API key. Keys currently use the
`sk-unsloth-` prefix; keep the full value private.

In WebBrain, open **Settings → Providers → Unsloth Studio (Local)**. Enter the
Studio API address as `http://127.0.0.1:8888/v1`, replacing `8888` when the
running Studio instance shows a different port. Enter the generated API key,
click **Load Models**, select the loaded model, then click **Test Connection**.
WebBrain normalizes a
base URL entered without the terminal `/v1` after a successful request.

Unsloth model discovery, chat, interactive Ask streaming, and tool calls use
the existing OpenAI-compatible endpoints. Vision starts off: enable the manual
vision checkbox only when the model loaded in Studio accepts image input.

#### Subscription proxy guide (EasyCLIProxyAPI / CLIProxyAPI)

The generic **Local OpenAI-compatible Proxy** card can connect WebBrain to a
separately managed [EasyCLIProxyAPI](https://github.com/router-for-me/EasyCLIProxyAPI)
or [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) instance. WebBrain
uses only the local OpenAI-compatible endpoint and its client key; it does not
bundle, launch, update, audit, or manage the proxy or its upstream OAuth tokens.

For the current desktop walkthrough, supported upstream sign-in labels,
loopback hardening, provider-terms warnings, video, and troubleshooting, use the
canonical [EasyCLIProxyAPI subscription proxy guide](https://webbrain.one/docs/easy-cli-proxy/).
Keep the listener on `127.0.0.1`, require a strong random client key, and never
publish the endpoint to a LAN or the internet. Official provider API keys remain
the stable default.

Ollama, llama.cpp, ODS, LM Studio, and LocalAI default to `visionMode: auto`. WebBrain asks
the selected server for model capability metadata before enrichment and sends
screenshots only when the response explicitly reports image input. A failed or
malformed metadata request is text-only for that turn and is retried later;
Settings can override Auto with Force on or Off. For providers whose Model
field may be blank, WebBrain coalesces concurrent checks but rechecks once per
user turn, so changing the model loaded by the server cannot reuse a stale
answer. Other local providers retain
their existing explicit `supportsVision` setting.

#### Ollama launch handoff (preview)

<p align="center">
  <img src="../web/assets/webbrain-ollama-heart.png" alt="WebBrain loves Ollama launch handoff" width="720">
</p>

WebBrain supports Ollama today through the local OpenAI-compatible provider. A
new `ollama launch webbrain --model <model>` handoff can also configure WebBrain
automatically, but it is not integrated into upstream Ollama yet. For now, try
it from the [`codex/ollama-webbrain-launch-handoff` branch of
`esokullu/ollama`](https://github.com/esokullu/ollama/tree/codex/ollama-webbrain-launch-handoff);
we hope Ollama will integrate it upstream.

```bash
git clone https://github.com/esokullu/ollama.git
cd ollama
git switch codex/ollama-webbrain-launch-handoff
cmake -S . -B build -G Ninja -DOLLAMA_MLX_BACKENDS=
cmake --build build --parallel 8

OLLAMA_ORIGINS="chrome-extension://*,moz-extension://*" ./ollama serve
./ollama launch webbrain --model <model>
```

**Streaming.** Local streaming is primarily a runtime/server capability, not a
property of the GGUF or other model weights. Interactive Ask streaming is
enabled for llama.cpp, Ollama, LM Studio, Osaurus, Jan, vLLM, SGLang, current LocalAI,
and Unsloth Studio
through their OpenAI-compatible Chat Completions endpoints. Each parser requires
`[DONE]`; safe network/read, malformed-frame, and premature-EOF failures
silently retry once with non-streaming generation. Tool-call streaming
additionally depends on the model's tool-use training, the runtime's chat
template/parser, and a current runtime version (LocalAI added tool streaming in
3.10).

**Context window.** Size the loaded context for the selected prompt tier, its tool schemas, the live page/history and the requested output. **16k is a local configuration fallback, not a reliable minimum for every tier.** Current Mid and Full agent prompts can exceed that window before useful history accumulates. Use a larger loaded window for these tiers; the quality audit verified a Full-tier 64K run with real compaction and restarts. A smaller Compact setup needs its own sizing check and offers fewer tools, including no native long-chat tool set. Automatically summarizing old history cannot shrink the fixed prompt or schemas, and the character-based estimate is not an exact model tokenizer.

The agent reads `provider.contextWindow` (`providers/base.js`) to drive auto-compaction. When no value is configured, local providers default to **16k**; cloud/router defaults depend on the known model, with a category fallback of 128k. **Test connection** / **Load models** auto-detect for **llama.cpp**, **ODS**, **Ollama**, and **LM Studio** when reported (llama.cpp / ODS `GET /props` `n_ctx`, Ollama `GET /api/ps` live context then `/api/show` `num_ctx`, LM Studio `/api/v0/models` `loaded_context_length`). Detection refreshes the local fallback; it shrinks a larger manual override only from live/runtime context (not from Ollama `/api/show` alone). Jan / vLLM / SGLang / LocalAI / Unsloth Studio do not auto-detect yet. Set `config.contextWindow` to match the server's actual loaded window; increasing the setting alone does not enlarge the model server's context.

### Prompt/tool tiers and modes

Provider tier and conversation mode are separate knobs:

- **Tier** (`compact | mid | full`) is a provider setting. It controls which Act-system prompt and normal browser-agent tool subset the model receives.
- **Mode** (`ask | act | dev`) is selected by the user per conversation/message. It controls whether the request is read-only, normal browser action, or developer/page-inspection work.

`provider.promptTier` resolves the active tier. Cloud providers are forced to Full. Local providers default to Mid. OpenRouter/router providers default to Full unless explicitly changed. Existing configs that still set the legacy `useCompactPrompt` boolean map to Compact.

| Tier      | Intended model class                 | Normal tool surface                                                                                                                                                                    |
| --------- | ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `compact` | very small/local models              | Shortest prompt and a small normal Act tool set. No scheduling, iframe, download-resource, or advanced DOM/UI fallback tools.                                                          |
| `mid`     | capable local models                 | Balanced prompt and common task tools: downloads, scheduling, iframe tools, form verification, and `download_resource_from_page`, while excluding Full-only advanced UI/DOM fallbacks. |
| `full`    | frontier/cloud or large local models | Full normal Act prompt and advanced fallbacks such as hover, drag-drop, frames, and shadow DOM.                                                                                        |

Ask mode ignores provider tier and stays read-only. Act mode uses the selected tier's normal tools. Dev mode requires Mid or Full, uses the selected Act prompt, appends `SYSTEM_PROMPT_DEV_APPENDIX`, and adds Dev-only source/style tools plus Dev-extended shadow/frame inspection for Mid-tier debugging. Compact Dev is blocked before an LLM request is sent.

### Vision Detection

| Provider            | Mechanism                                                                                                                                         |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| OpenAI-compatible   | Regex against model name (`gpt-4o`, `gpt-5`, `claude-3`, `claude-sonnet-4`, `gemini-2.0-flash`, etc.)                                             |
| DeepSeek            | The `deepseek-flash` family (including the retired `deepseek-v4-flash` aliases) is multimodal; `deepseek-v4-pro` and the V3-era ids are text-only |
| Anthropic           | `claude-(3\|sonnet-4\|opus-4)` patterns                                                                                                           |
| Ollama              | `POST /api/show` `capabilities`, with legacy projector / `.vision.` metadata fallbacks; Auto / Force on / Off                                     |
| llama.cpp           | `GET /props` → `modalities.vision`, with Auto / Force on / Off                                                                                    |
| LM Studio           | `GET /api/v1/models` → `capabilities.vision`; legacy `/api/v0/models` `type`, with overrides                                                      |
| LocalAI             | `GET /v1/models/capabilities` → `input_modalities` / `capabilities`, with overrides                                                               |
| Jan / vLLM / SGLang | Explicit `supportsVision` config toggle (via OpenAI provider)                                                                                     |

Auto results are keyed by provider, exact selected model, and canonical base
URL. Concurrent checks share one request, and a late response from an older
configuration cannot change the current provider. A separately configured
dedicated vision provider continues to use the existing split-provider path.

### Anthropic Conversion

When the active provider is Anthropic, the agent converts OpenAI-format messages:

| OpenAI format              | Anthropic format                        |
| -------------------------- | --------------------------------------- |
| `system` message           | `system` field (top-level)              |
| `assistant` + `tool_calls` | `assistant` + `tool_use` content blocks |
| `tool` role                | `user` + `tool_result` content blocks   |
| `image_url` (data URL)     | `image` source block                    |

### DeepSeek

`deepseek-flash` (DeepSeek-V4.1-Flash) is the shipped model. The retired
`deepseek-v4-flash` and `deepseek-v4-flash-vision-exp` ids still serve the same
model and are billed as Flash, so they keep full support (1M context, 384K
output, image input). Every other DeepSeek id — including the retired
`deepseek-v4-pro` — stays on a conservative profile (64K context, 8K output,
text-only) rather than inheriting capacities it may not have.

| Aspect             | Behaviour                                                                                                                                                                                                              |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Wire format        | Chat Completions by default (`apiFormat: 'auto'`); the Responses API is an opt-in from the Advanced panel                                                                                                              |
| Thinking           | Top-level `thinking` object plus `reasoning_effort`; disabling thinking omits `reasoning_effort` entirely. The shared UI ladder maps `minimal`→`low` and `medium`/`xhigh`→`high`                                       |
| Reasoning replay   | `reasoning_content` is replayed across turns because DeepSeek returns 400 when a tool-carrying follow-up drops it                                                                                                      |
| Streaming          | `stream_options.include_usage` on every request; the parser ignores DeepSeek's SSE `: keep-alive` comments                                                                                                             |
| Structured output  | Chat Completions uses JSON Object mode; the Responses API uses `text.format` JSON Schema for the planner                                                                                                               |
| Images             | `deepseek-flash` accepts `image_url` data URLs and public URLs in `user` messages                                                                                                                                      |
| Cost               | Off-peak list price converted at 1 USD = 7.1 CNY (1 input, 0.02 cached input, 4 output; peak 2 / 0.04 / 8). Cache hits arrive as the top-level `prompt_cache_hit_tokens` counter and are priced at the cache-read rate |
| Anthropic endpoint | `https://api.deepseek.com/anthropic` works with the built-in `anthropic` card by overriding its base URL                                                                                                               |

The contract lives in `providers/deepseek-config.js` (pure helpers and
constants) and `providers/deepseek.js` (`DeepSeekProvider`). The shared
`openai.js` and `provider-compatibility.js` modules carry no DeepSeek
knowledge, and `ProviderManager#_createProvider()` dispatches the `deepseek`
card — or any card pointed at `api.deepseek.com`, or one that explicitly selects
the `deepseek` compatibility preset — to the dedicated class.

---

## ProviderManager (`providers/manager.js`)

Manages provider lifecycle:

```js
const pm = new ProviderManager();

await pm.load(); // Load from chrome.storage.local
await pm.save(); // Persist to chrome.storage.local
pm.getActive(); // Get the active provider instance
await pm.setActive("openai"); // Switch active provider
await pm.updateProvider("openai", { model: "gpt-5" }); // Update config
await pm.duplicateProvider("openai"); // Create openai__duplicate
await pm.removeDuplicateProvider("openai__duplicate"); // Remove it
pm.getAll(); // All provider configs (for Settings UI)
await pm.testProvider("openai"); // Test connection
```

Each non-WebBrain provider config includes a persisted `configured` flag. An
explicit configuration update sets it to `true`; this is the UI's **Active**
state and is separate from `activeProvider`, which is the provider currently
**Selected** for chat. WebBrain Compass is always selectable without being marked
configured. Connection tests report reachability but do not control the Active
flag.

Settings can rename configurable providers using **Provider title** and Save.
The persisted `label` appears in Settings and the chat provider picker without
changing the provider's ID, implementation, or model.

Settings can create any number of independent duplicates of each configurable
endpoint provider, including from a saved duplicate. The first duplicate keeps
the existing ID `<source>__duplicate`; subsequent instances use
`<source>__duplicate_2`, `<source>__duplicate_3`, and so on. Each stores a
`duplicateOf` reference to the original source definition,
so credentials, models, endpoint URLs, compatibility options, export/import,
and active-provider selection continue to use the existing provider schema.
New instances start with blank credentials, endpoint, model, and overrides,
and must be saved before selection or further duplication. Duplicates stay
grouped after their source; deleting one leaves the other instances intact.
The manager rejects nested, orphaned, type-mismatched, and malformed duplicate
entries when loading storage. WebBrain Compass and the
Chromium-only WebGPU runtime are not duplicable because they do not represent
independent user-managed API credentials or endpoints; their cards keep the
Duplicate affordance disabled with an explanatory tooltip.

### Settings Search

The Settings search index includes provider IDs, labels, type/category, model,
base URL, field labels/placeholders, suggestions, and compatibility options.
Matching cards are ordered by exact provider name/ID, then name/ID prefix, then
name/ID substring, then field-only matches. Original provider order breaks
ties, and the selected provider remains visible across category filters.

### Config Persistence

Configs are stored in `chrome.storage.local` under the `providers` key, merged against defaults. Defaults provide the SHAPE (which provider keys exist); stored configs override per-key values. This allows upgrades that introduce new provider entries to work without users clearing storage. Duplicate entries share this same persistence path and therefore remain portable through Settings config export/import.

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

| Aspect                           | Separate vision model + text planner                                                                                                                   | Single multimodal planner                                                                                                                |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Processing flow                  | The vision model describes the screenshot, then the text planner reasons over that description and chooses tools.                                      | One model sees the screenshot, reasons about the task, and chooses tools in the same call.                                               |
| Access to raw pixels             | Only the vision model sees the image; the planner receives text.                                                                                       | The planner retains direct access to the image while deciding what to do.                                                                |
| Visual information loss          | The description is a lossy handoff and may omit small text, spatial relationships, colors, icons, or state cues.                                       | No intermediate description is required, so the model can revisit visual details during reasoning.                                       |
| Planning and tool calls          | The vision model is observation-only; the text planner owns all action and tool decisions.                                                             | The same model performs visual interpretation and tool planning.                                                                         |
| Specialist-model advantage       | Perception and planning can use models selected independently for their strongest capability.                                                          | One model must be strong at both multimodal perception and browser-tool use.                                                             |
| Visual grounding and coordinates | Text descriptions can weaken the relationship between an element and its exact visual position; accessibility-tree `ref_id` targets remain preferable. | Image and coordinate context stay together, although semantic `ref_id` targets are still safer than coordinate clicks.                   |
| Latency                          | Usually requires two sequential inference calls.                                                                                                       | Usually requires one inference call.                                                                                                     |
| Cost                             | Pays for the vision call plus the planner call, but can keep expensive image tokens away from the planner.                                             | Pays for one multimodal call, whose image-token cost depends on the provider and image detail.                                           |
| Prompt-injection boundary        | The observation model receives no agent tools, creating a stronger separation between screenshot content and actions.                                  | The model that sees screenshot content can also choose tools, so multimodal prompt-injection defenses carry more responsibility.         |
| Failure characteristics          | Adds a sidecar timeout or transcription-failure point; a text-only planner may have to continue without visual enrichment.                             | Removes the handoff failure, but the entire turn depends on one multimodal endpoint and its combined capabilities.                       |
| Best fit                         | Strong text/tool planner paired with a specialist vision model, especially when most actions use DOM or accessibility evidence.                        | A model that is already strong at both vision and tool use, especially for tasks requiring fine visual detail or tight visual reasoning. |

```js
const vision = await providerManager.getVisionProvider();
// Returns the explicit dedicated OpenAI-compatible vision provider, or null.
// Screenshot callers use resolveVisionRoute(activeProvider) to consider raw
// active-provider vision and the explicitly enabled, ready local fallback.
```

On Chromium, **Settings -> Assistive Models -> Vision** also offers a one-click
in-browser fallback. It runs `webbrain-one/webbrain-vl-2-450M-onnx` through WebGPU in a
dedicated Worker with FP16 embeddings/vision encoder and a Q4 decoder. The
model is not present in the general provider catalog and never receives agent
tools or planning turns. Local vision is disabled by default and neither
Apocalypse Mode nor a screenshot operation can enable it or start its download.
The dedicated control probes WebGPU, records versioned consent, and then downloads
approximately 810 MB of model data from Hugging Face into the browser cache. The download runs in Chrome's
offscreen extension worker, so the user may switch tabs or close Settings while
it continues, but must keep Chrome running. Screenshots stay on-device and
only the generated description is passed to the active provider. The local
selection is stored as a Chrome-only preference, separately from the synced
OpenAI-compatible vision endpoint, so it can be disabled without losing that
endpoint or its credentials. Disabling it releases the loaded model and GPU
resources while retaining the browser-cached download. Firefox does not expose
this option because its build has no MV3 offscreen document.

Screenshot routing is deterministic: an explicit dedicated vision endpoint,
then a vision-capable active provider receiving raw pixels, then an explicitly
enabled and already-ready local fallback. If none is ready, inspection returns a
recoverable availability result; automatic screenshots skip enrichment and let
the task continue. Screenshot tools never wait for a model download. Dedicated
and local description calls have a 90-second total deadline, worker startup has
a 15-second deadline, and a local timeout cancels generation before recreating a
worker that does not settle within five seconds.

### Transcription Provider

Used by Tab Recorder for Whisper transcription. Falls back through configured providers in priority order: OpenAI → Groq → LM Studio → llama.cpp. Blocklist excludes providers known not to host Whisper (Anthropic, Gemini, Mistral, DeepSeek, xAI, Nvidia, Kimi), including duplicates of those providers.

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

Vision is auto-detected via model-name regex. If the provider has a known set of vision models, extend `_modelNameSniffedVision()` in `openai.js`, or add a vendor subclass the way `providers/deepseek.js` does. Set `supportsStreamUsageOptions: true` only for providers that accept OpenAI-style `stream_options.include_usage`; leave it false when a provider returns usage without accepting that request field.
